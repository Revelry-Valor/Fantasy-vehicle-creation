import { analyze, type Analysis } from '../core/analysis';
import { getDef } from '../core/catalog';
import { G, WATER_DENSITY, airDensityAt, getFluid, type FluidDef } from '../core/fluids';
import { aabbContains, localToWorld, partVolume, worldAABB, type AABB } from '../core/geometry';
import { buildContactGraph, buildFluidNetworks, type ContactGraph, type FluidNetwork } from '../core/networks';
import type { Design, PartInstance, Vec3 } from '../core/types';

export interface Atmosphere {
  temperature: number;
  /** 0..1 poison concentration. */
  toxicity: number;
  /** Oxygen fraction (0.21 normal). */
  oxygen: number;
  /** Flammable gas fraction (hydrogen explodes above ~4 %). */
  flammable: number;
  /** Fraction of the compartment filled with liquid. */
  flood: number;
  exploded?: boolean;
}

export interface Leak {
  partId: string;
  fluid: string;
  /** m³/s at ambient pressure (gas) or m³/s liquid. */
  rate: number;
  compartmentId: string | null;
}

export interface SimState {
  time: number;
  health: Record<string, number>;
  fill: Record<string, number>;
  atmos: Record<string, Atmosphere>;
  leaks: Leak[];
  log: { t: number; msg: string; level: 'info' | 'warn' | 'error' }[];
  flags: Set<string>;
  /** Vertical offset of the whole craft relative to the design position. */
  altitude: number;
  verticalSpeed: number;
  analysis: Analysis | null;
}

export const AMBIENT: Atmosphere = { temperature: 15, toxicity: 0, oxygen: 0.21, flammable: 0, flood: 0 };

export function createSimState(design: Design): SimState {
  const fill: Record<string, number> = {};
  const atmos: Record<string, Atmosphere> = {};
  for (const p of design.parts) {
    const def = getDef(p.type);
    if (def.container) fill[p.id] = typeof p.props.fill === 'number' ? p.props.fill : 1;
    if (def.compartment) atmos[p.id] = { ...AMBIENT };
  }
  return {
    time: 0, health: {}, fill, atmos, leaks: [], log: [], flags: new Set(),
    altitude: 0, verticalSpeed: 0, analysis: null,
  };
}

/** The runtime world for one simulation session; the design is frozen while it runs. */
export class Simulation {
  state: SimState;
  private graph: ContactGraph;
  private byId: Map<string, PartInstance>;
  private compartments: { part: PartInstance; box: AABB; volume: number }[];

  constructor(public design: Design) {
    this.state = createSimState(design);
    this.graph = buildContactGraph(design.parts);
    this.byId = new Map(design.parts.map((p) => [p.id, p]));
    this.compartments = design.parts
      .filter((p) => getDef(p.type).compartment)
      .map((p) => ({ part: p, box: worldAABB(p), volume: Math.max(0.1, partVolume(p)) }))
      .sort((a, b) => a.volume - b.volume);
    this.state.analysis = analyze(design, { graph: this.graph });
    // Sky craft start the run hanging in the air so you can watch them rise or fall.
    if (design.settings.environment === 'air') this.state.altitude = 25;
  }

  health(id: string): number {
    return this.state.health[id] ?? 1;
  }

  log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.state.log.push({ t: this.state.time, msg, level });
    if (this.state.log.length > 200) this.state.log.shift();
  }

  once(flag: string, msg: string, level: 'info' | 'warn' | 'error' = 'warn') {
    if (this.state.flags.has(flag)) return;
    this.state.flags.add(flag);
    this.log(msg, level);
  }

  compartmentAt(point: Vec3): string | null {
    for (const c of this.compartments) if (aabbContains(c.box, point)) return c.part.id;
    return null;
  }

  label(p: PartInstance): string {
    return p.name || String(p.props.label ?? '') || getDef(p.type).name;
  }

  damage(id: string, amount: number) {
    const p = this.byId.get(id);
    if (!p) return;
    const before = this.health(id);
    const after = Math.max(0, before - amount);
    this.state.health[id] = after;
    if (after < before) this.log(`${this.label(p)} ${after === 0 ? 'destroyed' : `damaged (${Math.round(after * 100)}%)`}.`, after === 0 ? 'error' : 'warn');
  }

  repair(id: string) {
    const p = this.byId.get(id);
    if (!p) return;
    delete this.state.health[id];
    this.log(`${this.label(p)} repaired.`, 'info');
  }

  toggleValve(id: string) {
    const p = this.byId.get(id);
    if (!p || p.type !== 'valve') return;
    p.props.open = p.props.open === false;
    this.log(`Valve ${p.props.open ? 'opened' : 'closed'}.`);
  }

  /** Contents available in a container, m³ at ambient pressure. */
  private contentVolume(p: PartInstance): number {
    const fluid = getFluid(String(p.props.fluid ?? ''));
    const pressure = fluid?.state === 'gas' && typeof p.props.pressure === 'number' ? p.props.pressure : 1;
    return partVolume(p) * (this.state.fill[p.id] ?? 0) * pressure;
  }

  private drain(p: PartInstance, volume: number) {
    const fluid = getFluid(String(p.props.fluid ?? ''));
    const pressure = fluid?.state === 'gas' && typeof p.props.pressure === 'number' ? p.props.pressure : 1;
    const cap = partVolume(p) * pressure;
    if (cap <= 0) return;
    this.state.fill[p.id] = Math.max(0, (this.state.fill[p.id] ?? 0) - volume / cap);
  }

  step(dt: number) {
    const s = this.state;
    s.time += dt;
    const nets = buildFluidNetworks(this.design.parts, this.graph);
    s.leaks = [];

    // 1. Leaks from damaged pipes drain every container on their network.
    const handled = new Set<string>();
    for (const net of nets) this.leakNetwork(net, dt, handled);

    // 2. Damaged containers leak on their own.
    for (const p of this.design.parts) {
      const def = getDef(p.type);
      if (!def.container || handled.has(p.id)) continue;
      const h = this.health(p.id);
      if (h >= 1) continue;
      const fluid = getFluid(String(p.props.fluid ?? ''));
      if (!fluid) continue;
      this.release(p, [p], p.position, fluid, 1 - h, dt);
    }

    // 3. Heat sources and ventilation.
    this.ventilate(dt);

    // 4. Crew wellbeing & ignition.
    this.checkHazards();

    // 5. Forces & vertical motion.
    const a = analyze(this.design, { graph: this.graph, fill: s.fill, health: s.health, forcesOnly: true });
    s.analysis = a;
    const env = this.design.settings.environment;
    if ((env === 'air' || env === 'underwater') && a.totalMass > 0 && a.bounds) {
      const rho = env === 'air' ? airDensityAt(this.design.settings.altitude + s.altitude) : WATER_DENSITY;
      const area = Math.max(1, a.dims[0] * a.dims[2]);
      const drag = 0.5 * rho * 1.0 * area * s.verticalSpeed * Math.abs(s.verticalSpeed);
      // Treat the craft as resting on the ground: it can't push down through it.
      const onGround = env === 'air' && a.bounds.min[1] + s.altitude <= 0.001;
      let net = a.netVerticalN - drag;
      if (onGround && net < 0) { net = 0; s.verticalSpeed = 0; }
      const acc = net / a.totalMass;
      s.verticalSpeed += acc * dt;
      s.altitude += s.verticalSpeed * dt;
      if (env === 'air' && a.bounds.min[1] + s.altitude < 0) {
        if (s.verticalSpeed < -4) this.once(`crash-${Math.floor(s.time)}`, `Hit the ground at ${(-s.verticalSpeed).toFixed(1)} m/s!`, 'error');
        s.altitude = -a.bounds.min[1];
        s.verticalSpeed = 0;
      }
      if (a.netVerticalN < 0 && env === 'air') this.once('losing-lift', `Losing altitude — short ${Math.round(-a.netVerticalN / G)} kg of lift.`, 'error');
    }
  }

  private leakNetwork(net: FluidNetwork, dt: number, handled: Set<string>) {
    const fluid = getFluid(net.fluid);
    if (!fluid) return;
    const containers = net.containers.map((id) => this.byId.get(id)!);
    const holes: PartInstance[] = [];
    for (const id of [...net.conduits, ...net.containers]) {
      if (this.health(id) < 1) holes.push(this.byId.get(id)!);
    }
    for (const c of containers) handled.add(c.id);
    for (const hole of holes) {
      this.release(hole, containers, hole.position, fluid, 1 - this.health(hole.id), dt);
    }
  }

  /** Vent `fluid` out of `sources` through a hole of the given severity at `point`. */
  private release(hole: PartInstance, sources: PartInstance[], point: Vec3, fluid: FluidDef, severity: number, dt: number) {
    const total = sources.reduce((acc, p) => acc + this.contentVolume(p), 0);
    if (total <= 1e-6) return;
    // A fraction of what's left escapes each second, plus a floor so small
    // tanks empty completely. Tuned so a holed gasbag goes limp over a few
    // minutes rather than instantly (real low-pressure envelopes leak slowly).
    const k = fluid.state === 'gas' ? 0.004 : 0.008;
    const floor = fluid.state === 'gas' ? 1.0 : 0.02;
    const volume = Math.min(total, (total * k + floor) * severity * dt);
    for (const p of sources) this.drain(p, volume * (this.contentVolume(p) / total));
    const compId = this.compartmentAt(point);
    this.state.leaks.push({ partId: hole.id, fluid: fluid.id, rate: volume / dt, compartmentId: compId });
    const where = compId ? this.label(this.byId.get(compId)!) : 'open air';
    this.once(`leak-${hole.id}`, `${fluid.name} leaking from ${this.label(hole)} into ${where}.`, 'warn');
    for (const p of sources) {
      if (getDef(p.type).envelope && (this.state.fill[p.id] ?? 0) < 0.5) this.once(`deflate-${p.id}`, `${this.label(p)} is below half pressure!`, 'error');
      if ((this.state.fill[p.id] ?? 0) <= 0.001) this.once(`empty-${p.id}`, `${this.label(p)} is empty.`, 'error');
    }
    if (!compId) return;
    const comp = this.compartments.find((c) => c.part.id === compId)!;
    const at = this.state.atmos[compId];
    if (fluid.state === 'liquid') {
      at.flood = Math.min(1, at.flood + volume / comp.volume);
      // Volatile liquids give off vapour.
      const vapour = Math.min(1, (volume * 40) / comp.volume);
      at.toxicity = Math.min(1, at.toxicity + vapour * fluid.toxicity);
      at.flammable = Math.min(1, at.flammable + vapour * fluid.flammability * 0.2);
      at.temperature += vapour * (fluid.temperature - at.temperature) * 0.2;
      return;
    }
    const r = Math.min(1, volume / comp.volume);
    const o2 = fluid.id === 'air' || fluid.id === 'hotair' ? 0.21 : 0;
    at.temperature += r * (fluid.temperature - at.temperature);
    at.toxicity = Math.min(1, at.toxicity * (1 - r) + r * fluid.toxicity);
    at.flammable = Math.min(1, at.flammable * (1 - r) + r * fluid.flammability);
    at.oxygen = at.oxygen * (1 - r) + r * o2;
  }

  private ventilate(dt: number) {
    for (const c of this.compartments) {
      const at = this.state.atmos[c.part.id];
      let rate = 0.004;
      let heat = 0;
      for (const p of this.design.parts) {
        const def = getDef(p.type);
        const center = p.position;
        const inside = aabbContains(c.box, center);
        const onBoundary = !inside && aabbContains(inflate(c.box, 0.3), center);
        if ((p.type === 'door' || p.type === 'hatch' || p.type === 'ramp' || p.type === 'bayDoors') && (inside || onBoundary) && Number(p.props.state ?? 0) > 0.5) rate += 0.06;
        if (p.type === 'porthole' && (inside || onBoundary)) rate += 0.004;
        if (inside && this.health(p.id) > 0.3) {
          if (p.type === 'stove') heat += 3000;
          if (p.type === 'boiler' || def.powerSupply) heat += 12000;
        }
      }
      if (c.part.props.sealed === true) rate *= 0.1;
      const f = 1 - Math.exp(-rate * dt);
      at.temperature += (AMBIENT.temperature - at.temperature) * f + (heat * dt) / (c.volume * 1200) * (1 - f);
      at.toxicity += (0 - at.toxicity) * f;
      at.flammable += (0 - at.flammable) * f;
      at.oxygen += (0.21 - at.oxygen) * f;
    }
  }

  private checkHazards() {
    for (const c of this.compartments) {
      const at = this.state.atmos[c.part.id];
      const name = this.label(c.part);
      if (at.flammable > 0.04 && !at.exploded) {
        const igniter = this.design.parts.find((p) =>
          aabbContains(c.box, p.position) && this.health(p.id) > 0.3 &&
          (p.type === 'stove' || p.type === 'lamp' || p.type === 'boiler' || getDef(p.type).powerSupply || p.type === 'cannon'));
        if (igniter) {
          at.exploded = true;
          this.log(`💥 ${name}: flammable gas ignited by the ${getDef(igniter.type).name.toLowerCase()}!`, 'error');
          at.temperature = 900;
          at.toxicity = Math.max(at.toxicity, 0.8);
          at.oxygen = 0.08;
          at.flammable = 0;
          for (const p of this.design.parts) {
            if (aabbContains(inflate(c.box, 0.5), p.position) && !getDef(p.type).compartment) {
              this.state.health[p.id] = Math.max(0, this.health(p.id) - 0.6);
            }
          }
        } else {
          this.once(`flam-${c.part.id}`, `${name}: explosive atmosphere (${(at.flammable * 100).toFixed(0)}% flammable gas). Keep flames away!`, 'error');
        }
      }
      if (at.temperature > 60) this.once(`hot-${c.part.id}`, `${name} is scalding: ${at.temperature.toFixed(0)} °C.`, 'error');
      if (at.toxicity > 0.2) this.once(`tox-${c.part.id}`, `${name}: toxic air.`, 'error');
      if (at.oxygen < 0.16) this.once(`o2-${c.part.id}`, `${name}: oxygen at ${(at.oxygen * 100).toFixed(0)}% — crew suffocating.`, 'error');
      if (at.flood > 0.3) this.once(`flood-${c.part.id}`, `${name} is flooding.`, 'error');
    }
  }

  crewStatus(p: PartInstance): { status: string; level: 'ok' | 'warn' | 'error' } {
    if (this.health(p.id) <= 0) return { status: 'incapacitated', level: 'error' };
    const head = localToWorld(p, [0, p.size[1] * 0.4, 0]);
    const compId = this.compartmentAt(head) ?? this.compartmentAt(p.position);
    if (!compId) return { status: 'outside', level: 'ok' };
    const at = this.state.atmos[compId];
    const problems: string[] = [];
    if (at.temperature > 60) problems.push('burning');
    else if (at.temperature > 40) problems.push('overheating');
    if (at.toxicity > 0.2) problems.push('poisoned');
    if (at.oxygen < 0.16) problems.push('suffocating');
    if (at.flood > 0.6) problems.push('drowning');
    if (!problems.length) return { status: 'fine', level: 'ok' };
    const bad = at.temperature > 60 || at.toxicity > 0.4 || at.oxygen < 0.12 || at.flood > 0.8;
    return { status: problems.join(', '), level: bad ? 'error' : 'warn' };
  }
}

function inflate(b: AABB, d: number): AABB {
  return { min: [b.min[0] - d, b.min[1] - d, b.min[2] - d], max: [b.max[0] + d, b.max[1] + d, b.max[2] + d] };
}

import { getDef, type Category } from './catalog';
import { G, WATER_DENSITY, airDensityAt, getFluid } from './fluids';
import { sheetArea, partArea, partVolume, shapeVolume, unionAABB, worldAABB, type AABB } from './geometry';
import { getMaterial } from './materials';
import { buildContactGraph, buildFluidNetworks, solvePower, type ContactGraph } from './networks';
import type { Design, PartInstance, Vec3 } from './types';

export interface Issue {
  level: 'error' | 'warn' | 'info' | 'ok';
  message: string;
  partIds?: string[];
}

export interface RuntimeOverrides {
  /** Fill fraction per container id (from the simulation). */
  fill?: Record<string, number>;
  /** 0..1 health per part id. */
  health?: Record<string, number>;
  graph?: ContactGraph;
  /** Skip the structural and systems checks (fast path for the sim loop). */
  forcesOnly?: boolean;
}

export interface Analysis {
  partCount: number;
  totalMass: number;
  partMass: Record<string, number>;
  massByCategory: Partial<Record<Category, number>>;
  cog: Vec3;
  bounds: AABB | null;
  dims: Vec3;
  weightN: number;

  gasLiftN: number;
  wingLiftN: number;
  magicLiftN: number;
  waterBuoyancyN: number;
  /** Water buoyancy available if fully submerged (surface craft reserve). */
  displacementCapacityN: number;
  totalLiftN: number;
  netVerticalN: number;
  centerOfLift: Vec3 | null;

  thrustN: number;
  accel: number;
  mechSupplyKW: number;
  mechDemandKW: number;
  elecSupplyW: number;
  elecDemandW: number;
  powered: Set<string>;

  contactAreaM2: number;
  groundPressureKPa: number | null;
  rolloverDeg: number | null;

  crushDepth: number | null;
  pressureAtDepthBar: number;
  metacentricHeight: number | null;
  draft: number | null;
  deltaV: number | null;

  crew: number;
  seats: number;
  beds: number;
  weapons: number;
  controlStations: number;

  unsupported: string[];
  /** Load / capacity for each structural member (1 = at limit). */
  utilization: Record<string, number>;

  issues: Issue[];
  verdict: Issue;
}

const fmtKg = (kg: number) => (kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 10000 ? 1 : 2)} t` : `${Math.round(kg)} kg`);

/** Mass of just the fluid in a container, kg. */
export function contentsMass(p: PartInstance, fill: number): number {
  const def = getDef(p.type);
  if (!def.container) return 0;
  const fluid = getFluid(String(p.props.fluid ?? ''));
  if (!fluid) return 0;
  const pressure = fluid.state === 'gas' && typeof p.props.pressure === 'number' ? p.props.pressure : 1;
  return partVolume(p) * fill * fluid.density * pressure;
}

/** Dry (structural) mass of a part, kg. */
/** A framing section is a thin sheet (planking or metal plate) plus any plating on its faces. */
function frameMass(p: PartInstance): number {
  const [span, t, len] = p.size;
  // A reshaped sheet weighs what its outline covers.
  const area = p.points || p.holes ? sheetArea(p) : span * len;
  let m = area * t * getMaterial(p.material).density;
  const skinT = Number(p.props.skinThickness ?? 0.03);
  for (const k of ['skinOuter', 'skinInner']) {
    const skin = String(p.props[k] ?? 'none');
    if (skin !== 'none') m += area * skinT * getMaterial(skin).density;
  }
  return m;
}

export function isSealedShell(p: PartInstance): boolean {
  return (p.type === 'hullShell' || p.type === 'hullSides') && p.props.sealed !== false;
}

export function dryMass(p: PartInstance): number {
  const def = getDef(p.type);
  const mat = getMaterial(p.material);
  let m: number;
  if (p.type === 'frame') {
    m = frameMass(p);
  } else if (def.massMode === 'solid') {
    m = partVolume(p) * (def.fill ?? 1) * mat.density;
  } else if (def.massMode === 'shell') {
    const t = typeof p.props.thickness === 'number' ? p.props.thickness : 0.01;
    m = partArea(p) * t * mat.density;
  } else {
    const v0 = shapeVolume(def.shape, def.defaultSize);
    const v = shapeVolume(def.shape, p.size);
    m = (def.mass ?? 0) * (v0 > 0 ? v / v0 : 1);
  }
  if (typeof p.props.cargo === 'number') m += p.props.cargo;
  return m;
}

export function fillOf(p: PartInstance, o?: RuntimeOverrides): number {
  const f = o?.fill?.[p.id];
  if (typeof f === 'number') return f;
  return typeof p.props.fill === 'number' ? p.props.fill : 1;
}

/** Bending capacity (N) of a structural member under a central point load. */
export function memberCapacity(p: PartInstance): number {
  const def = getDef(p.type);
  const sigma = getMaterial(p.material).strength * 1e6;
  const d = [...p.size].sort((a, b) => a - b);
  if (p.type === 'frame') {
    // A sheet held along its long edges bends across the short direction
    // under a spread-out load (M = wL²/8), so capacity = 8σS/L.
    const [span, t, len] = p.size;
    const skinT = ['skinOuter', 'skinInner'].some((k) => String(p.props[k] ?? 'none') !== 'none') ? Number(p.props.skinThickness ?? 0.03) : 0;
    const depth = t + skinT;
    const short = Math.min(span, len), long = Math.max(span, len);
    return (8 * sigma * ((long * depth * depth) / 6)) / Math.max(short, 0.1);
  }
  if (def.massMode === 'shell') {
    const t = typeof p.props.thickness === 'number' ? p.props.thickness : 0.02;
    return sigma * t * d[1] * 0.2;
  }
  let S: number;
  let L = d[2];
  if (def.shape === 'rib') {
    const t = p.size[2];
    S = (t * t * t) / 6;
    L = p.size[0] * 1.5;
  } else if (d[1] / d[0] > 4) {
    // Plates and floors: supported along the long edges, spanning the short way.
    return (8 * sigma * ((d[2] * d[0] * d[0]) / 6)) / Math.max(d[1], 0.1);
  } else {
    S = ((d[0] * d[1] * d[1]) / 6) * Math.sqrt(def.fill ?? 1);
  }
  return (4 * sigma * S) / Math.max(L, 0.1);
}

export function analyze(design: Design, o: RuntimeOverrides = {}): Analysis {
  const { parts, settings } = design;
  const env = settings.environment;
  const health = (id: string) => o.health?.[id] ?? 1;
  const rhoAir = env === 'space' ? 0 : airDensityAt(settings.altitude);

  const partMass: Record<string, number> = {};
  const massByCategory: Partial<Record<Category, number>> = {};
  let totalMass = 0;
  const cogAcc: Vec3 = [0, 0, 0];
  let crew = 0, seats = 0, beds = 0, weapons = 0, controlStations = 0;
  for (const p of parts) {
    const def = getDef(p.type);
    const m = dryMass(p) + contentsMass(p, fillOf(p, o));
    partMass[p.id] = m;
    totalMass += m;
    massByCategory[def.category] = (massByCategory[def.category] ?? 0) + m;
    for (let i = 0; i < 3; i++) cogAcc[i] += p.position[i] * m;
    if (def.crew) crew++;
    seats += def.seats ?? 0;
    beds += def.beds ?? 0;
    if (def.weapon) weapons++;
    if (def.controlStation) controlStations++;
  }
  const cog: Vec3 = totalMass > 0 ? [cogAcc[0] / totalMass, cogAcc[1] / totalMass, cogAcc[2] / totalMass] : [0, 0, 0];
  const bounds = unionAABB(parts.filter((p) => !getDef(p.type).compartment).map(worldAABB));
  const dims: Vec3 = bounds ? [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] : [0, 0, 0];
  const weightN = totalMass * G;

  // ── Power ────────────────────────────────────────────────────────────────
  let mechSupplyKW = 0, mechDemandKW = 0;
  for (const p of parts) {
    const d = getDef(p.type);
    mechSupplyKW += (d.powerSupply ?? 0) * health(p.id);
    if (d.powerDemand && (!d.thrustEnv || d.thrustEnv.includes(env))) mechDemandKW += d.powerDemand;
  }
  const powerRatio = mechDemandKW > 0 ? Math.min(1, mechSupplyKW / mechDemandKW) : 1;

  const graph = o.graph ?? buildContactGraph(parts);
  const power = solvePower(parts, graph, health);

  // ── Lift & thrust ────────────────────────────────────────────────────────
  let gasLiftN = 0, wingLiftN = 0, magicLiftN = 0, thrustN = 0;
  let displacementVol = 0;
  const liftMoment: Vec3 = [0, 0, 0];
  const addLift = (p: PartInstance, n: number) => {
    for (let i = 0; i < 3; i++) liftMoment[i] += p.position[i] * n;
  };
  let propellantMass = 0;
  let ispAcc = 0, ispThrust = 0;
  for (const p of parts) {
    const d = getDef(p.type);
    const h = health(p.id);
    if (d.envelope && env !== 'space' && env !== 'underwater') {
      const n = rhoAir * partVolume(p) * fillOf(p, o) * G;
      gasLiftN += n;
      addLift(p, n);
    }
    if (d.wing && (env === 'air' || env === 'land')) {
      const cl = typeof p.props.liftCoefficient === 'number' ? p.props.liftCoefficient : 0.8;
      const n = 0.5 * rhoAir * settings.cruiseSpeed ** 2 * p.size[0] * p.size[2] * cl * h;
      wingLiftN += n;
      addLift(p, n);
    }
    if (d.magicLift && env !== 'space') {
      const hasPower = power.powered.has(p.id) || !d.electricDemand;
      const n = hasPower ? d.magicLift * h * (partVolume(p) / shapeVolume(d.shape, d.defaultSize)) : 0;
      magicLiftN += n;
      addLift(p, n);
    }
    if (d.displacement) displacementVol += partVolume(p) * d.displacement * (h > 0.2 ? 1 : 0);
    if (isSealedShell(p)) displacementVol += partVolume(p) * 0.9 * (h > 0.2 ? 1 : 0);
    if (d.thrust && d.thrustEnv?.includes(env)) {
      let scale: number;
      if (d.shape === 'nozzle') scale = (p.size[0] * p.size[1]) / (d.defaultSize[0] * d.defaultSize[1]);
      else scale = ((p.size[0] + p.size[1]) / (d.defaultSize[0] + d.defaultSize[1])) ** 2;
      const pr = d.powerDemand ? powerRatio : 1;
      const t = d.thrust * scale * h * pr;
      thrustN += t;
      if (d.isp) { ispAcc += d.isp * t; ispThrust += t; }
    }
    if (d.sail && (env === 'air' || env === 'water')) {
      const rho = rhoAir;
      thrustN += 0.5 * rho * settings.windSpeed ** 2 * p.size[1] * p.size[2] * 0.8 * 1.2 * h;
    }
    if (d.container && p.props.fluid === 'propellant') propellantMass += contentsMass(p, fillOf(p, o));
  }

  let waterBuoyancyN = 0;
  const displacementCapacityN = displacementVol * WATER_DENSITY * G;
  let draft: number | null = null;
  let metacentricHeight: number | null = null;
  const hulls = parts.filter((p) => getDef(p.type).displacement || isSealedShell(p));
  const mainHull = hulls.sort((a, b) => partVolume(b) - partVolume(a))[0];
  if (env === 'water') {
    waterBuoyancyN = Math.min(weightN, displacementCapacityN);
    if (mainHull && displacementCapacityN > 0) {
      const hb = worldAABB(mainHull);
      const hullH = hb.max[1] - hb.min[1];
      const frac = Math.min(1, weightN / displacementCapacityN);
      draft = frac * hullH;
      // GM = KB + BM − KG with a box-ish waterplane.
      const beam = hb.max[0] - hb.min[0];
      const len = hb.max[2] - hb.min[2];
      const displaced = weightN / (WATER_DENSITY * G);
      const I = (0.7 * len * beam ** 3) / 12;
      const KB = draft / 2;
      const BM = displaced > 0 ? I / displaced : 0;
      const KG = cog[1] - hb.min[1];
      metacentricHeight = KB + BM - KG;
    }
  } else if (env === 'underwater') {
    waterBuoyancyN = displacementCapacityN;
  }
  if (waterBuoyancyN > 0 && mainHull) addLift(mainHull, waterBuoyancyN);

  const totalLiftN = gasLiftN + wingLiftN + magicLiftN + waterBuoyancyN;
  const netVerticalN = totalLiftN - weightN;
  const centerOfLift: Vec3 | null = totalLiftN > 0
    ? [liftMoment[0] / totalLiftN, liftMoment[1] / totalLiftN, liftMoment[2] / totalLiftN]
    : null;
  const accel = totalMass > 0 ? thrustN / totalMass : 0;

  let deltaV: number | null = null;
  if (ispThrust > 0 && propellantMass > 0 && totalMass > propellantMass) {
    deltaV = (ispAcc / ispThrust) * G * Math.log(totalMass / (totalMass - propellantMass));
  }

  // ── Ground contact ───────────────────────────────────────────────────────
  let contactAreaM2 = 0;
  const footprint: AABB[] = [];
  for (const p of parts) {
    const d = getDef(p.type);
    if (!d.contact) continue;
    const s = p.size;
    if (d.contact === 'wheel') contactAreaM2 += s[0] * Math.max(s[1], s[2]) * (p.material === 'rubber' ? 0.15 : 0.05);
    if (d.contact === 'track') contactAreaM2 += s[0] * s[2] * 0.75;
    if (d.contact === 'leg') contactAreaM2 += s[0] * s[2] * 0.5;
    footprint.push(worldAABB(p));
  }
  const groundPressureKPa = contactAreaM2 > 0 ? weightN / contactAreaM2 / 1000 : null;
  let rolloverDeg: number | null = null;
  const fp = unionAABB(footprint);
  if (fp) {
    const halfTrack = Math.min(cog[0] - fp.min[0], fp.max[0] - cog[0]);
    const height = cog[1] - fp.min[1];
    rolloverDeg = halfTrack <= 0 ? 0 : (Math.atan2(halfTrack, Math.max(height, 0.01)) * 180) / Math.PI;
  }

  // ── Pressure ─────────────────────────────────────────────────────────────
  const pressureAtDepthBar = 1.013 + (WATER_DENSITY * G * Math.max(0, settings.depth)) / 1e5;
  let crushDepth: number | null = null;
  for (const p of hulls) {
    const t = typeof p.props.thickness === 'number' ? p.props.thickness : 0.02;
    const r = Math.max(p.size[0], p.size[1]) / 2;
    const pMax = (getMaterial(p.material).strength * 1e6 * t) / r * 0.5 * health(p.id);
    const depth = pMax / (WATER_DENSITY * G);
    crushDepth = crushDepth === null ? depth : Math.min(crushDepth, depth);
  }

  const issues: Issue[] = [];
  let unsupported: string[] = [];
  const utilization: Record<string, number> = {};

  if (!o.forcesOnly) {
    structuralChecks(parts, graph, partMass, env, rhoAir, health, unsupported, utilization, issues);
    unsupported = [...new Set(unsupported)];
    systemsChecks(parts, graph, issues);
  }

  // ── Environment verdicts ─────────────────────────────────────────────────
  const surplusKg = netVerticalN / G;
  let verdict: Issue = { level: 'info', message: 'Add some parts to get started.' };
  if (parts.length) {
    switch (env) {
      case 'air': {
        const lift = totalLiftN;
        if (lift <= 0) verdict = { level: 'error', message: 'No lift at all — add envelopes, wings or levitators.' };
        else if (netVerticalN >= 0) verdict = { level: 'ok', message: `Airborne — ${fmtKg(surplusKg)} of spare lift (${Math.round((lift / weightN - 1) * 100)}% surplus).` };
        else verdict = { level: 'error', message: `Too heavy to fly — short ${fmtKg(-surplusKg)} of lift.` };
        if (centerOfLift && totalLiftN > 0) {
          if (gasLiftN > wingLiftN && centerOfLift[1] < cog[1]) {
            issues.push({ level: 'warn', message: 'Centre of lift is below the centre of gravity — the ship wants to flip over. Hang the gondola lower or move lift up.' });
          }
          const len = Math.max(dims[2], 1);
          const off = centerOfLift[2] - cog[2];
          if (Math.abs(off) > 0.05 * len) {
            issues.push({ level: 'warn', message: `Out of trim: centre of lift is ${Math.abs(off).toFixed(1)} m ${off > 0 ? 'forward of' : 'behind'} the CoG — the ship will pitch ${off > 0 ? 'nose-up' : 'nose-down'}.` });
          }
          const offX = centerOfLift[0] - cog[0];
          if (Math.abs(offX) > 0.05 * Math.max(dims[0], 1)) {
            issues.push({ level: 'warn', message: `Listing: lift is ${Math.abs(offX).toFixed(1)} m to ${offX > 0 ? 'starboard' : 'port'} of the CoG.` });
          }
        }
        if (wingLiftN > 0 && thrustN === 0) issues.push({ level: 'warn', message: 'Wings need airspeed but nothing provides thrust.' });
        break;
      }
      case 'land': {
        if (!contactAreaM2) verdict = { level: 'error', message: 'No wheels, tracks or legs — it will just sit there.' };
        else {
          const gp = groundPressureKPa!;
          const terrain = gp < 50 ? 'crosses mud and snow' : gp < 150 ? 'fine on firm ground' : gp < 350 ? 'roads only — bogs down in soft ground' : 'sinks into anything but paving';
          verdict = { level: gp < 350 ? 'ok' : 'warn', message: `Ground pressure ${gp.toFixed(0)} kPa — ${terrain}.` };
          const pw = totalMass > 0 ? mechSupplyKW / (totalMass / 1000) : 0;
          issues.push({ level: pw < 5 ? 'warn' : 'info', message: `Power-to-weight ${pw.toFixed(1)} kW/t${pw < 5 ? ' — sluggish; add engine power' : ''}.` });
          if (rolloverDeg !== null) {
            issues.push({ level: rolloverDeg < 25 ? 'warn' : 'info', message: `Tips over on a ${rolloverDeg.toFixed(0)}° side slope${rolloverDeg < 25 ? ' — top-heavy, widen the track or lower weight' : ''}.` });
          }
          if (fp && (cog[2] < fp.min[2] || cog[2] > fp.max[2])) {
            issues.push({ level: 'error', message: 'Centre of gravity is outside the wheelbase — it will tip onto its nose or tail.' });
          }
        }
        break;
      }
      case 'water': {
        if (!displacementCapacityN) verdict = { level: 'error', message: 'Nothing to float on — add a boat hull, pontoons or a sealed hull shell.' };
        else if (displacementCapacityN < weightN) verdict = { level: 'error', message: `Sinks — needs ${fmtKg((weightN - displacementCapacityN) / G)} more buoyancy.` };
        else {
          const reserve = (displacementCapacityN / weightN - 1) * 100;
          verdict = { level: reserve < 15 ? 'warn' : 'ok', message: `Floats — draft ≈ ${draft?.toFixed(2)} m, ${reserve.toFixed(0)}% reserve buoyancy.` };
          if (metacentricHeight !== null) {
            if (metacentricHeight < 0) issues.push({ level: 'error', message: `Capsizes: metacentric height is ${metacentricHeight.toFixed(2)} m. Lower heavy items or widen the hull.` });
            else issues.push({ level: metacentricHeight < 0.3 ? 'warn' : 'info', message: `Metacentric height GM = ${metacentricHeight.toFixed(2)} m${metacentricHeight < 0.3 ? ' — tender, rolls easily' : ' — stable'}.` });
          }
        }
        break;
      }
      case 'underwater': {
        const trimKg = surplusKg;
        if (!displacementCapacityN) verdict = { level: 'error', message: 'No sealed hull — add a pressure hull.' };
        else if (Math.abs(trimKg) < totalMass * 0.02) verdict = { level: 'ok', message: `Neutrally buoyant (±${fmtKg(Math.abs(trimKg))}). Hovers at depth.` };
        else if (trimKg > 0) verdict = { level: 'warn', message: `Positively buoyant — rises. Flood ${fmtKg(trimKg)} of ballast to dive.` };
        else verdict = { level: 'warn', message: `Negatively buoyant — sinks. Blow ${fmtKg(-trimKg)} of ballast to hover.` };
        if (crushDepth !== null) {
          const ok = crushDepth > settings.depth;
          issues.push({ level: ok ? 'info' : 'error', message: `Crush depth ≈ ${crushDepth.toFixed(0)} m; ${pressureAtDepthBar.toFixed(1)} bar at ${settings.depth} m${ok ? '' : ' — THE HULL WILL IMPLODE'}.` });
        }
        break;
      }
      case 'space': {
        if (thrustN === 0) verdict = { level: 'error', message: 'No reaction thrusters — propellers and sails do nothing in vacuum.' };
        else verdict = { level: 'ok', message: `Acceleration ${(accel / G).toFixed(2)} g${deltaV ? `, Δv ${Math.round(deltaV)} m/s` : ''}.` };
        if (crew > 0 && !parts.some((p) => p.type === 'pressureHull' || isSealedShell(p))) {
          issues.push({ level: 'error', message: 'Crew aboard but no pressurised hull — they will not survive vacuum.' });
        }
        if (!propellantMass && thrustN > 0) issues.push({ level: 'warn', message: 'Thrusters but no propellant tank.' });
        break;
      }
    }
  }

  // ── Crew & power ─────────────────────────────────────────────────────────
  if (parts.length && !o.forcesOnly) {
    if (!controlStations) issues.push({ level: 'warn', message: 'No helm or control station.' });
    if (crew > beds && crew > 0) issues.push({ level: 'info', message: `${crew} crew but only ${beds} berths — fine for short trips.` });
    if (mechDemandKW > mechSupplyKW) issues.push({ level: 'warn', message: `Engines supply ${mechSupplyKW.toFixed(0)} kW but drives need ${mechDemandKW.toFixed(0)} kW — thrust reduced to ${Math.round(powerRatio * 100)}%.` });
    if (power.demandW > 0 && power.supplyW < power.demandW) issues.push({ level: 'warn', message: `Electrical demand ${(power.demandW / 1000).toFixed(1)} kW exceeds connected supply ${(power.supplyW / 1000).toFixed(1)} kW.` });
    const unpowered = parts.filter((p) => getDef(p.type).electricDemand && !power.powered.has(p.id));
    if (unpowered.length) issues.push({ level: 'warn', message: `${unpowered.length} electrical item(s) not wired to a generator or battery.`, partIds: unpowered.map((p) => p.id) });
  }

  return {
    partCount: parts.length,
    totalMass, partMass, massByCategory, cog, bounds, dims, weightN,
    gasLiftN, wingLiftN, magicLiftN, waterBuoyancyN, displacementCapacityN, totalLiftN, netVerticalN, centerOfLift,
    thrustN, accel, mechSupplyKW, mechDemandKW, elecSupplyW: power.supplyW, elecDemandW: power.demandW, powered: power.powered,
    contactAreaM2, groundPressureKPa, rolloverDeg,
    crushDepth, pressureAtDepthBar, metacentricHeight, draft, deltaV,
    crew, seats, beds, weapons, controlStations,
    unsupported, utilization, issues, verdict,
  };
}

function structuralChecks(
  parts: PartInstance[],
  graph: ContactGraph,
  partMass: Record<string, number>,
  env: string,
  rhoAir: number,
  health: (id: string) => number,
  unsupported: string[],
  utilization: Record<string, number>,
  issues: Issue[],
) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const isStructural = (id: string) => !!getDef(byId.get(id)!.type).structural;
  const solid = parts.filter((p) => !getDef(p.type).compartment);
  const structural = solid.filter((p) => getDef(p.type).structural);
  if (!solid.length) return;
  if (!structural.length) {
    if (solid.length > 1) issues.push({ level: 'error', message: 'No structural frame — add a keel, beams or a hull to hold things together.' });
    return;
  }

  // Components of the structural skeleton; the heaviest one is the main frame.
  const comp = new Map<string, number>();
  const compMass: number[] = [];
  for (const s of structural) {
    if (comp.has(s.id)) continue;
    const idx = compMass.length;
    compMass.push(0);
    const stack = [s.id];
    comp.set(s.id, idx);
    while (stack.length) {
      const id = stack.pop()!;
      compMass[idx] += partMass[id] ?? 0;
      for (const n of graph.get(id) ?? []) {
        if (!comp.has(n) && isStructural(n)) { comp.set(n, idx); stack.push(n); }
      }
    }
  }
  const main = compMass.indexOf(Math.max(...compMass));

  // Everything reachable from the main frame is supported.
  const supported = new Set<string>();
  const stack: string[] = [];
  for (const [id, c] of comp) if (c === main) { supported.add(id); stack.push(id); }
  while (stack.length) {
    const id = stack.pop()!;
    for (const n of graph.get(id) ?? []) if (!supported.has(n)) { supported.add(n); stack.push(n); }
  }
  for (const p of solid) if (!supported.has(p.id)) unsupported.push(p.id);
  if (unsupported.length) {
    issues.push({ level: 'error', message: `${unsupported.length} part(s) are floating free — not attached to the main frame.`, partIds: [...unsupported] });
  }

  // Load path: each non-structural part hangs its weight on the nearest members.
  const load: Record<string, number> = {};
  for (const s of structural) load[s.id] = partMass[s.id] * 9.81 * 0.5;
  const nearestMembers = (start: string): string[] => {
    const seen = new Set([start]);
    let frontier = [start];
    while (frontier.length) {
      const hits = new Set<string>();
      const next: string[] = [];
      for (const id of frontier) for (const n of graph.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (isStructural(n)) hits.add(n);
        else next.push(n);
      }
      if (hits.size) return [...hits];
      frontier = next;
    }
    return [];
  };
  for (const p of solid) {
    const def = getDef(p.type);
    if (def.structural || def.contact || !supported.has(p.id)) continue;
    let f = partMass[p.id] * 9.81;
    if (def.envelope && env !== 'space' && env !== 'underwater') {
      // A lifting envelope pulls up on its attachment points with its net lift.
      f = Math.abs(rhoAir * partVolume(p) * 9.81 - f);
    }
    const members = nearestMembers(p.id);
    for (const m of members) load[m] = (load[m] ?? 0) + f / members.length;
  }
  const over: string[] = [];
  const strained: string[] = [];
  for (const s of structural) {
    const u = load[s.id] / Math.max(1, memberCapacity(s) * health(s.id));
    utilization[s.id] = u;
    if (u > 1) over.push(s.id);
    else if (u > 0.7) strained.push(s.id);
  }
  if (over.length) issues.push({ level: 'error', message: `${over.length} structural member(s) overloaded — they will fail. Use stronger material or add supports.`, partIds: over });
  if (strained.length) issues.push({ level: 'warn', message: `${strained.length} member(s) above 70% of capacity.`, partIds: strained });
}

function systemsChecks(parts: PartInstance[], graph: ContactGraph, issues: Issue[]) {
  const nets = buildFluidNetworks(parts, graph);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const fedBy = (id: string, fluids: string[]) =>
    nets.some((n) => n.fixtures.includes(id) && n.fluid && fluids.includes(n.fluid));
  for (const p of parts) {
    if (p.type === 'steamEngine' && !fedBy(p.id, ['steam'])) issues.push({ level: 'warn', message: 'Steam engine has no steam pipe from a boiler.', partIds: [p.id] });
    if (p.type === 'combustionEngine' && !fedBy(p.id, ['fuel'])) issues.push({ level: 'warn', message: 'Combustion engine is not piped to a fuel tank.', partIds: [p.id] });
  }
  for (const n of nets) {
    const fluids = new Set(n.containers.map((id) => String(byId.get(id)!.props.fluid ?? '')));
    if (fluids.size > 1) issues.push({ level: 'warn', message: `A pipe network mixes ${[...fluids].map((f) => getFluid(f)?.name ?? f).join(' + ')}.`, partIds: n.conduits });
  }
}


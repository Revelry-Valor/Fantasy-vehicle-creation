import { analyze } from './analysis';
import { getDef } from './catalog';
import { G } from './fluids';
import { mirrorTransform, partVolume } from './geometry';
import { wrapHull } from './hullwrap';
import { newDesign, newId, type Design, type Environment, type PartInstance, type PropValue, type Vec3 } from './types';

/** Tiny builder DSL for authoring sample vessels in code. */
class Builder {
  parts: PartInstance[] = [];

  add(type: string, position: Vec3, opts: { size?: Vec3; rot?: Vec3; mat?: string; props?: Record<string, PropValue>; name?: string } = {}): PartInstance {
    const def = getDef(type);
    const p: PartInstance = {
      id: newId(),
      type,
      position,
      rotation: opts.rot ?? [0, 0, 0],
      size: opts.size ?? ([...def.defaultSize] as Vec3),
      material: opts.mat ?? def.defaultMaterial,
      props: { ...(def.defaultProps ?? {}), ...(opts.props ?? {}) },
    };
    if (opts.name) p.name = opts.name;
    this.parts.push(p);
    return p;
  }

  /** Add a part and its mirror twin across X = 0. */
  pair(type: string, position: Vec3, opts: Parameters<Builder['add']>[2] = {}): [PartInstance, PartInstance] {
    const a = this.add(type, position, opts);
    const m = mirrorTransform(a.position, a.rotation);
    const b = this.add(type, m.position, { ...opts, rot: m.rotation });
    a.mirrorOf = b.id;
    b.mirrorOf = a.id;
    return [a, b];
  }

  design(name: string, env: Environment, extra: Partial<Design['settings']> = {}): Design {
    const d = newDesign(name);
    d.settings = { ...d.settings, environment: env, ...extra };
    d.parts = this.parts;
    return d;
  }
}

const VERT: Vec3 = [Math.PI / 2, 0, 0]; // tube/strut along Y
const ACROSS: Vec3 = [0, Math.PI / 2, 0]; // tube/strut along X

export function skyGalleon(): Design {
  const b = new Builder();
  // Gondola
  b.add('keel', [0, 0.2, 0], { size: [0.3, 0.4, 16], mat: 'skywood' });
  b.add('boatHull', [0, 1.5, 0], { size: [5, 3, 16], mat: 'skywood', props: { thickness: 0.04 } });
  b.add('deck', [0, 2.6, 0], { size: [4.4, 0.06, 14], mat: 'skywood', name: 'Main Deck' });
  b.add('deck', [0, 0.425, -0.5], { size: [3.6, 0.05, 12], mat: 'skywood', name: 'Hold Floor' });
  b.add('fin', [0, 2.2, -8.6], { size: [0.15, 2.6, 2.4], mat: 'skywood', name: 'Rudder' });
  b.pair('railing', [2.15, 3.13, 0], { size: [0.06, 1, 14], mat: 'skywood' });

  // Rigging: struts up to two cross-trusses that carry the envelopes.
  for (const z of [-6, 6]) {
    b.pair('strut', [2, 3.615, z], { size: [0.2, 0.2, 1.97], rot: VERT, mat: 'bamboo' });
    b.add('truss', [0, 5, z], { size: [0.8, 0.8, 17], rot: ACROSS, mat: 'bamboo', name: 'Envelope Truss' });
  }
  const [envS, envP] = b.pair('envelope', [8, 12.9, 0], { size: [15, 15, 48], props: { fluid: 'hydrogen', fill: 1 } });
  envS.name = 'Starboard Gasbag';
  envP.name = 'Port Gasbag';

  // Hydrogen manifold: both gasbags are plumbed down into the hold to a
  // reservoir, through valves you can shut if a pipe is hit.
  b.pair('pipe', [1, 3.95, -3], { size: [0.1, 0.1, 3.3], rot: VERT, name: 'Gas Riser' });
  b.pair('valve', [1, 2.15, -3], { size: [0.3, 0.3, 0.3], rot: VERT });
  b.pair('pipe', [1, 1.9, -3], { size: [0.1, 0.1, 0.2], rot: VERT });
  b.add('pipe', [0, 1.8, -3], { size: [0.1, 0.1, 2.1], rot: ACROSS, name: 'Gas Manifold' });
  b.add('pipe', [0, 1.4, -3], { size: [0.1, 0.1, 0.8], rot: VERT, name: 'Reservoir Feed' });
  b.add('gasTank', [0, 0.75, -3], { size: [0.6, 0.6, 2.4], rot: ACROSS, name: 'Hydrogen Reservoir' });

  // Hold (aft) and cargo bay (forward)
  b.add('compartment', [0, 1.525, -3.75], { size: [3.8, 2.15, 6.5], props: { label: 'Crew Hold' } });
  b.add('compartment', [0, 1.525, 3.5], { size: [3.8, 2.15, 6], props: { label: 'Cargo Bay' } });
  b.pair('bunk', [1.3, 1.35, -5.6], { size: [1, 1.8, 2.1] });
  b.add('crew', [-0.4, 1.35, -1.6], { name: 'Deckhand Mira' });
  b.add('table', [0.9, 0.825, -1.2]);
  b.add('lavatory', [-1.4, 0.85, -1.4]);
  b.add('lamp', [0, 2.42, -1.5], { name: 'Hold Lamp' });
  b.add('battery', [1.2, 0.75, -2.2]);
  b.add('wire', [1.2, 1.675, -2.2], { size: [0.04, 0.04, 1.25], rot: VERT });
  b.add('wire', [0.6, 2.3, -2.2], { size: [0.04, 0.04, 1.24], rot: ACROSS });
  b.add('wire', [0, 2.3, -1.85], { size: [0.04, 0.04, 0.7] });

  b.add('crate', [-0.8, 1.05, 4.8], { props: { cargo: 400 } });
  b.add('winch', [0, 2.17, 2.5], { props: { chainLength: 18 } });
  b.add('bayDoors', [0, 0.05, 2.5], { size: [1.6, 0.08, 2.2], name: 'Belly Doors' });

  // Deck: helm, crew, guns
  b.add('helm', [0, 3.33, 5.4], { size: [1, 1.4, 0.5] });
  b.add('crew', [0, 3.53, 4.8], { name: 'Captain Aldous' });
  b.add('crew', [1.2, 3.53, -2], { name: 'Engineer Tobin' });
  b.pair('gunMount', [1.6, 3.18, 6.4]);
  b.pair('gun', [1.6, 3.9, 6.4]);

  // Engines aft on deck, fed from one fuel tank, driving pusher props.
  b.pair('combustionEngine', [1.5, 3.13, -6]);
  b.pair('propeller', [1.5, 3.63, -6.9], { size: [2.2, 2.2, 0.35] });
  b.add('fuelTank', [0, 3.03, -6], { size: [0.8, 0.8, 1.6], props: { fill: 0.9 } });
  b.pair('pipe', [0.7, 3.03, -6], { size: [0.08, 0.08, 0.62], rot: ACROSS, name: 'Fuel Line' });

  return b.design('Sky Galleon "Wayfarer"', 'air', { altitude: 300, cruiseSpeed: 12 });
}

export function trackedCrawler(): Design {
  const b = new Builder();
  // Chassis
  b.pair('ibeam', [1.1, 1.0, 0], { size: [0.2, 0.3, 6.2] });
  for (const z of [-2.4, 0, 2.4]) b.add('beam', [0, 0.9, z], { size: [4.1, 0.15, 0.15], mat: 'steel', name: 'Axle Beam' });
  b.add('deck', [0, 1.16, 0], { size: [2.6, 0.02, 6.2], mat: 'steel', name: 'Floor Plate' });
  b.pair('track', [1.75, 0.6, 0], { size: [0.6, 1.2, 6.4] });
  // Upper frame
  for (const z of [-3, 3]) b.pair('beam', [1.2, 2.1, z], { size: [0.12, 1.8, 0.12], mat: 'steel' });
  b.pair('beam', [1.2, 3.06, 0], { size: [0.12, 0.12, 6.12], mat: 'steel' });
  for (const z of [-3, 0, 3]) b.add('beam', [0, 3.06, z], { size: [2.28, 0.12, 0.12], mat: 'steel', name: 'Roof Beam' });
  // Crew compartment & fittings
  b.add('compartment', [0, 2.15, 0.6], { size: [2.2, 1.85, 4.6], props: { label: 'Crew Cabin' } });
  b.add('seat', [-0.5, 1.71, 2.2], { name: 'Driver Seat' });
  b.add('helm', [-0.5, 1.91, 2.8], { size: [0.7, 1.4, 0.4] });
  b.add('seat', [0.5, 1.71, 2.2]);
  b.add('crew', [-0.5, 2.11, 2.3], { name: 'Driver' });
  b.add('bench', [0, 1.66, -0.9], { rot: [0, Math.PI, 0] });
  b.add('lamp', [0, 2.85, 0.8]);
  // Engine bay
  b.add('combustionEngine', [0.4, 1.71, -2.3]);
  b.add('fuelTank', [-0.8, 1.61, -2.3], { size: [0.8, 0.8, 1.4] });
  b.add('pipe', [-0.2, 1.61, -2.3], { size: [0.08, 0.08, 0.4], rot: ACROSS });
  b.add('generator', [0.4, 1.66, -1.2], { size: [0.6, 0.9, 0.9] });
  b.add('wire', [0.4, 2.13, -0.2], { size: [0.04, 0.04, 2.1] });
  b.add('wire', [0.4, 2.49, 0.8], { size: [0.04, 0.04, 0.72], rot: VERT });
  b.add('wire', [0.27, 2.85, 0.8], { size: [0.04, 0.04, 0.3], rot: ACROSS });
  // Armor skin wrapped over the frame, then a turret on the roof
  const frame = b.parts.filter((p) => getDef(p.type).structural && p.type !== 'track');
  const shell = wrapHull(frame, { material: 'steel', thickness: 0.008, offset: 0.08 })!;
  shell.name = 'Armor Shell';
  b.parts.push(shell);
  b.add('turret', [0, 3.82, 0.3], { size: [1.8, 1.4, 1.8] });
  b.add('ramp', [0, 2.0, -3.2], { size: [1.6, 1.8, 0.1], name: 'Rear Hatch' });
  return b.design('Crawler "Ironhide"', 'land');
}

export function submersible(): Design {
  const b = new Builder();
  b.add('pressureHull', [0, 2.5, 0], { size: [3.4, 3.4, 13], props: { thickness: 0.05 } });
  b.add('deck', [0, 1.6, 0], { size: [2.6, 0.05, 10], mat: 'steel', name: 'Lower Deck' });
  b.pair('ballastTank', [2.6, 1.6, 0], { size: [1.8, 1.8, 9] });
  b.pair('beam', [1.7, 1.6, 2.5], { size: [0.4, 0.2, 0.2], mat: 'steel' });
  b.pair('beam', [1.7, 1.6, -2.5], { size: [0.4, 0.2, 0.2], mat: 'steel' });
  b.add('screw', [0, 2.5, -6.75], { size: [1.6, 1.6, 0.5] });
  b.add('fin', [0, 4.0, -6], { size: [0.12, 1.4, 1.6], mat: 'steel' });
  b.pair('fin', [1.6, 2.5, -6], { size: [1.4, 0.12, 1.6], mat: 'steel' });
  b.add('compartment', [0, 2.7, 0], { size: [2.4, 2.1, 9], props: { label: 'Control Room', sealed: true } });
  b.add('helm', [0, 2.33, 3.8], { size: [0.9, 1.4, 0.5] });
  b.add('seat', [0, 2.13, 3.2]);
  b.add('crew', [0, 2.53, 3.3], { name: 'Pilot' });
  b.add('crew', [0.6, 2.53, 0], { name: 'Navigator' });
  b.pair('bed', [0.8, 1.9, -3], { size: [0.8, 0.55, 2] });
  b.add('battery', [-0.8, 1.93, 1]);
  b.add('battery', [-0.8, 1.93, 0]);
  b.add('generator', [0, 2.13, -4.5], { size: [0.8, 1, 1.1], name: 'Main Motor' });
  b.add('wire', [-0.8, 2.25, 0.5], { size: [0.04, 0.04, 1.4] });
  b.add('wire', [-0.4, 2.25, 1.2], { size: [0.04, 0.04, 0.8], rot: ACROSS });
  b.add('wire', [0, 2.525, 1.2], { size: [0.04, 0.04, 0.55], rot: VERT });
  b.add('lamp', [0, 2.95, 1.2]);
  b.add('porthole', [0, 2.6, 6.45], { size: [0.7, 0.7, 0.12] });
  b.add('waterTank', [0.8, 2.43, 1.5], { size: [0.7, 1.6, 0.7] });
  b.add('combustionEngine', [0, 2.1, -2.6], { size: [0.8, 0.9, 1.1], name: 'Diesel (surface running)' });
  b.add('fuelTank', [0.9, 2.05, -2.6], { size: [0.6, 0.6, 1.2] });
  b.add('pipe', [0.5, 2.05, -2.6], { size: [0.06, 0.06, 0.25], rot: ACROSS });
  const d = b.design('Submersible "Nautilus Minor"', 'underwater', { depth: 80 });
  trimBallast(d);
  return d;
}

/** Set ballast tanks so the craft is neutrally buoyant. */
export function trimBallast(d: Design) {
  const tanks = d.parts.filter((p) => p.type === 'ballastTank');
  if (!tanks.length) return;
  for (const t of tanks) t.props.fill = 0;
  const a = analyze(d, { forcesOnly: true });
  const needKg = a.netVerticalN / G;
  const capKg = tanks.reduce((s, t) => s + partVolume(t) * 1000, 0);
  const fill = Math.max(0, Math.min(1, needKg / capKg));
  for (const t of tanks) t.props.fill = +fill.toFixed(4);
}

export const TEMPLATES: { id: string; name: string; description: string; make: () => Design }[] = [
  { id: 'galleon', name: 'Sky Galleon', description: 'Twin hydrogen gasbags over a skywood gondola. Try shooting the gas riser in the hold.', make: skyGalleon },
  { id: 'crawler', name: 'Tracked Crawler', description: 'Armored tracked vehicle with a wrapped hull and a turret.', make: trackedCrawler },
  { id: 'sub', name: 'Submersible', description: 'Steel pressure hull trimmed to neutral buoyancy with ballast tanks.', make: submersible },
];

import type { Material, ParamDef, PartDef, Vehicle } from './types';

// ── Materials ───────────────────────────────────────────────────────────────

export const MATERIALS: Material[] = [
  { id: 'steel', name: 'Steel', color: '#8d939a', finish: 'metal', density: 7850 },
  { id: 'darksteel', name: 'Dark steel', color: '#4a4f56', finish: 'metal', density: 7850 },
  { id: 'gunmetal', name: 'Gunmetal', color: '#2f3338', finish: 'metal', density: 7850 },
  { id: 'aluminium', name: 'Aluminium', color: '#c3c8cd', finish: 'metal', density: 2700 },
  { id: 'brass', name: 'Brass', color: '#c39b45', finish: 'metal', density: 8500 },
  { id: 'copper', name: 'Copper', color: '#b56d3e', finish: 'metal', density: 8960 },
  { id: 'hullwhite', name: 'Hull white', color: '#e4e4df', finish: 'matte', density: 2700 },
  { id: 'hullgrey', name: 'Hull grey', color: '#9da2a6', finish: 'matte', density: 2700 },
  { id: 'navygrey', name: 'Navy grey', color: '#6b7680', finish: 'matte', density: 7850 },
  { id: 'olive', name: 'Olive drab', color: '#5d6238', finish: 'matte', density: 7850 },
  { id: 'tan', name: 'Desert tan', color: '#b8a27a', finish: 'matte', density: 7850 },
  { id: 'red', name: 'Signal red', color: '#a8322b', finish: 'matte', density: 2700 },
  { id: 'rubber', name: 'Rubber', color: '#1d1e20', finish: 'matte', density: 1100 },
  { id: 'wood', name: 'Wood', color: '#8a5f3a', finish: 'matte', density: 650 },
  { id: 'carbon', name: 'Carbon', color: '#26282c', finish: 'matte', density: 1600 },
  { id: 'glass', name: 'Glass', color: '#9fd4ea', finish: 'glass', density: 2500 },
  { id: 'glowcyan', name: 'Glow cyan', color: '#5fe3ff', finish: 'emissive', density: 1000 },
  { id: 'glowamber', name: 'Glow amber', color: '#ffb24a', finish: 'emissive', density: 1000 },
];

// ── Parts ───────────────────────────────────────────────────────────────────

const m = (key: string, label: string, def: number, min = 0.05, max = 100): ParamDef => ({ key, label, unit: 'm', min, max, default: def });
const deg = (key: string, label: string, def: number, min = 5, max = 360): ParamDef => ({ key, label, unit: 'deg', min, max, default: def, step: 5 });

/**
 * The starter set. Local frames:
 *  - beams are swept along their path; w × h is the cross-section
 *  - plates, wedges, cylinders, cones and hull panels run along local Z
 *  - joints move their +Y half; hinges turn about X, rings about Y, pistons push along Y
 */
export const PART_DEFS: PartDef[] = [
  // Beams
  { id: 'beam.square', name: 'Square beam', category: 'Beams', kind: 'beam', shape: 'beam', section: 'square', layer: 'frame', material: 'steel', behavior: 'none',
    description: 'Box-section beam. Click grid points to run it; it can bend between them.', params: [m('w', 'Width', 0.2, 0.02, 5), m('h', 'Height', 0.2, 0.02, 5)] },
  { id: 'beam.round', name: 'Round beam', category: 'Beams', kind: 'beam', shape: 'beam', section: 'round', layer: 'frame', material: 'steel', behavior: 'none',
    description: 'Tube. Good for struts, rails and pipework.', params: [m('w', 'Diameter', 0.15, 0.02, 5)] },
  { id: 'beam.ibeam', name: 'I-beam', category: 'Beams', kind: 'beam', shape: 'beam', section: 'ibeam', layer: 'frame', material: 'steel', behavior: 'none',
    description: 'Flanged girder for keels, decks and main frames.', params: [m('w', 'Flange', 0.2, 0.02, 5), m('h', 'Depth', 0.3, 0.02, 5)] },
  { id: 'beam.channel', name: 'Channel', category: 'Beams', kind: 'beam', shape: 'beam', section: 'channel', layer: 'frame', material: 'steel', behavior: 'none',
    description: 'C-section rail for ribs and stringers.', params: [m('w', 'Width', 0.15, 0.02, 5), m('h', 'Depth', 0.2, 0.02, 5)] },

  // Plates & shapes
  { id: 'plate', name: 'Plate', category: 'Plates & shapes', kind: 'shape', shape: 'plate', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Flat plate. Width along X, length along Z, thickness up.', params: [m('w', 'Width', 1), m('l', 'Length', 1), m('t', 'Thickness', 0.05, 0.005, 2)] },
  { id: 'wedge', name: 'Wedge', category: 'Plates & shapes', kind: 'shape', shape: 'wedge', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Sloped block: full height at the back, a sharp edge at the front.', params: [m('w', 'Width', 1), m('h', 'Height', 0.5), m('l', 'Length', 1)] },
  { id: 'cylinder', name: 'Cylinder', category: 'Plates & shapes', kind: 'shape', shape: 'cylinder', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Solid cylinder along Z: tanks, nacelles, barrels.', params: [m('r', 'Radius', 0.5), m('l', 'Length', 2)] },
  { id: 'cone', name: 'Cone', category: 'Plates & shapes', kind: 'shape', shape: 'cone', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Tapered cylinder along Z: nose cones, exhausts, transitions.', params: [m('r1', 'Back radius', 0.5, 0), m('r2', 'Front radius', 0.1, 0), m('l', 'Length', 1.5)] },
  { id: 'hullPanel', name: 'Hull panel', category: 'Plates & shapes', kind: 'shape', shape: 'hullPanel', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Curved plate: a slice of a cylinder wall. Its origin is the curve\'s centre, so panels with the same origin form one hull.',
    params: [m('r', 'Radius', 2), deg('a', 'Arc', 60), m('l', 'Length', 2), m('t', 'Thickness', 0.05, 0.005, 2)] },
  { id: 'skin', name: 'Skin plate', category: 'Plates & shapes', kind: 'skin', shape: 'skin', layer: 'plating', material: 'hullgrey', behavior: 'none',
    description: 'Plate generated between 3 or 4 beams. Select the beams, then use Skin.', params: [m('t', 'Thickness', 0.04, 0.005, 2)] },

  // Joints
  { id: 'hinge', name: 'Hinge', category: 'Joints', kind: 'joint', shape: 'hinge', layer: 'functional', material: 'darksteel', behavior: 'joint',
    joint: { type: 'hinge', min: -90, max: 90, rest: 0 },
    description: 'Turns on its X axis. Whatever is attached on the far side moves with it.', params: [m('s', 'Size', 0.5, 0.05, 10)] },
  { id: 'turret', name: 'Turret ring', category: 'Joints', kind: 'joint', shape: 'turret', layer: 'functional', material: 'darksteel', behavior: 'joint',
    joint: { type: 'turret', min: -180, max: 180, rest: 0, continuous: true },
    description: 'Rotates its top on the vertical axis, all the way round.', params: [m('r', 'Radius', 0.75, 0.05, 20), m('h', 'Height', 0.25, 0.02, 5)] },
  { id: 'ball', name: 'Ball joint', category: 'Joints', kind: 'joint', shape: 'ball', layer: 'functional', material: 'darksteel', behavior: 'joint',
    joint: { type: 'ball', min: -45, max: 45, rest: 0 },
    description: 'Rotates on every axis within a cone: hips, shoulders, sensor heads.', params: [m('r', 'Radius', 0.25, 0.03, 5)] },
  { id: 'piston', name: 'Piston', category: 'Joints', kind: 'joint', shape: 'piston', layer: 'functional', material: 'steel', behavior: 'joint',
    joint: { type: 'piston', min: 0, max: 0.75, rest: 0 },
    description: 'Pushes its top end out along Y: rams, landing struts, sliders.', params: [m('l', 'Length', 1, 0.1, 20), m('r', 'Radius', 0.1, 0.02, 2)] },
  { id: 'wheel', name: 'Wheel', category: 'Joints', kind: 'joint', shape: 'wheel', layer: 'functional', material: 'rubber', behavior: 'wheel',
    joint: { type: 'wheel', min: -35, max: 35, rest: 0, continuous: true },
    description: 'Spins on its X axis and can steer about Y.', params: [m('r', 'Radius', 0.5, 0.05, 10), m('w', 'Width', 0.35, 0.02, 5)] },
  { id: 'door', name: 'Sliding door', category: 'Joints', kind: 'joint', shape: 'door', layer: 'functional', material: 'hullgrey', behavior: 'joint',
    joint: { type: 'piston', min: 0, max: 1, rest: 0 },
    description: 'A panel in a frame that slides open along X.', params: [m('w', 'Width', 1), m('h', 'Height', 2), m('t', 'Thickness', 0.08, 0.01, 1)] },

  // Functional
  { id: 'thruster', name: 'Thruster', category: 'Functional', kind: 'shape', shape: 'thruster', layer: 'functional', material: 'darksteel', behavior: 'thruster',
    description: 'Engine bell firing toward −Z. Shows exhaust during playback.', params: [m('r', 'Radius', 0.4), m('l', 'Length', 1)] },
  { id: 'light', name: 'Light', category: 'Functional', kind: 'shape', shape: 'light', layer: 'functional', material: 'glowamber', behavior: 'light',
    description: 'A glowing lamp or running light.', params: [m('r', 'Radius', 0.12, 0.02, 3)] },
  { id: 'canopy', name: 'Canopy', category: 'Functional', kind: 'shape', shape: 'canopy', layer: 'functional', material: 'glass', behavior: 'none',
    description: 'Glazed cockpit bubble, long along Z.', params: [m('w', 'Width', 1.2), m('h', 'Height', 0.7), m('l', 'Length', 2)], stats: { crew: 1 } },

  // Details
  { id: 'greeble', name: 'Greeble block', category: 'Details', kind: 'shape', shape: 'greeble', layer: 'details', material: 'darksteel', behavior: 'none',
    description: 'Detail box with vents and panel lines.', params: [m('w', 'Width', 0.5), m('h', 'Height', 0.25), m('l', 'Length', 0.5)] },
  { id: 'bolt', name: 'Bolt head', category: 'Details', kind: 'shape', shape: 'bolt', layer: 'details', material: 'steel', behavior: 'none',
    description: 'Cosmetic bolt or rivet. Holds nothing together.', params: [m('r', 'Radius', 0.04, 0.005, 1)] },
  { id: 'figure', name: 'Scale figure', category: 'Details', kind: 'shape', shape: 'figure', layer: 'details', material: 'red', behavior: 'none',
    description: 'A person for judging scale. Stands on its feet at the grid point.', params: [m('h', 'Height', 1.8, 0.3, 4)] },
];

const byId = new Map(PART_DEFS.map((d) => [d.id, d]));
const matById = new Map(MATERIALS.map((d) => [d.id, d]));

export function getDef(id: string, v?: Vehicle): PartDef {
  return byId.get(id) ?? v?.partDefs.find((d) => d.id === id) ?? byId.get('plate')!;
}

export function hasDef(id: string, v?: Vehicle): boolean {
  return byId.has(id) || !!v?.partDefs.some((d) => d.id === id);
}

export function allDefs(v?: Vehicle): PartDef[] {
  return [...PART_DEFS, ...(v?.partDefs ?? [])];
}

export function getMaterial(id: string, v?: Vehicle): Material {
  return matById.get(id) ?? v?.materials.find((x) => x.id === id) ?? MATERIALS[0];
}

export function allMaterials(v?: Vehicle): Material[] {
  return [...MATERIALS, ...(v?.materials ?? [])];
}

export function defaultParams(def: PartDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

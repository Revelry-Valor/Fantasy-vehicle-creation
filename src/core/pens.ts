import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { getDef } from './catalog';
import { localToWorld, mirrorShapeData, mirrorTransform, outlineAreaXZ, rotationMatrix } from './geometry';
import { newId, type Design, type PartInstance, type Vec3 } from './types';

/**
 * Blueprint drawing. The 2D editor works in a plane:
 *   side view: u = Z (bow to the right), v = Y (up); out-of-plane axis is X
 *   top view:  u = Z (bow to the right), v = X (starboard down); out-of-plane axis is Y
 * Pens turn strokes in that plane into ordinary parts, so everything drawn is
 * also a normal 3D part with mass, strength and so on.
 */

export type PlaneView = 'side' | 'top';
export type PenKind = 'floor' | 'room' | 'support' | 'frame' | 'ramp' | 'ladder' | 'cutout';
export type SupportType = 'beam' | 'ibeam' | 'strut' | 'truss';

export interface P2 { u: number; v: number }

export type ArmorSide = 'outside' | 'inside' | 'both';

/** Armor props for a framing sheet given a material and the face(s) to cover. */
export function armorProps(material: string, side: ArmorSide): { skinOuter: string; skinInner: string } {
  const on = material !== 'none';
  return {
    skinOuter: on && side !== 'inside' ? material : 'none',
    skinInner: on && side !== 'outside' ? material : 'none',
  };
}

/** Which face(s) of a framing sheet carry armor, and in what. */
export function armorOf(p: PartInstance): { material: string; side: ArmorSide } {
  const o = String(p.props.skinOuter ?? 'none'), i = String(p.props.skinInner ?? 'none');
  if (o !== 'none' && i !== 'none') return { material: o, side: 'both' };
  if (i !== 'none') return { material: i, side: 'inside' };
  return { material: o, side: 'outside' };
}

/**
 * What a stroke connected to when it started on an existing part: the
 * out-of-plane position of that point (side view: how far off the centre
 * line; top view: height) and, for floors and framing, their width.
 */
export interface Anchor {
  out?: number;
  width?: number;
}

export interface FloorType { id: string; name: string; material: string; thickness: number }

export const FLOOR_TYPES: FloorType[] = [
  { id: 'pine', name: 'Pine planks', material: 'pine', thickness: 0.05 },
  { id: 'oak', name: 'Oak deck', material: 'oak', thickness: 0.06 },
  { id: 'skywood', name: 'Skywood planks', material: 'skywood', thickness: 0.05 },
  { id: 'bamboo', name: 'Bamboo slats', material: 'bamboo', thickness: 0.04 },
  { id: 'iron', name: 'Iron plate', material: 'iron', thickness: 0.012 },
  { id: 'steel', name: 'Steel deck plate', material: 'steel', thickness: 0.01 },
  { id: 'aluminum', name: 'Aluminium plate', material: 'aluminum', thickness: 0.01 },
  { id: 'stone', name: 'Stone slabs', material: 'stone', thickness: 0.1 },
];

/** Framing is thin sheet: planking or metal plate. */
export const FRAME_TYPES: FloorType[] = [
  { id: 'pine', name: 'Pine planking', material: 'pine', thickness: 0.04 },
  { id: 'oak', name: 'Oak planking', material: 'oak', thickness: 0.05 },
  { id: 'skywood', name: 'Skywood planking', material: 'skywood', thickness: 0.04 },
  { id: 'bamboo', name: 'Bamboo lath', material: 'bamboo', thickness: 0.03 },
  { id: 'iron', name: 'Iron sheet', material: 'iron', thickness: 0.006 },
  { id: 'steel', name: 'Steel sheet', material: 'steel', thickness: 0.005 },
  { id: 'aluminum', name: 'Aluminium sheet', material: 'aluminum', thickness: 0.004 },
  { id: 'bronze', name: 'Bronze sheet', material: 'bronze', thickness: 0.005 },
  { id: 'copper', name: 'Copper sheet', material: 'copper', thickness: 0.004 },
  { id: 'mythril', name: 'Mythril sheet ✦', material: 'mythril', thickness: 0.003 },
];

export const SUPPORT_TYPES: { id: SupportType; name: string; part: string }[] = [
  { id: 'beam', name: 'Square beam', part: 'beam' },
  { id: 'ibeam', name: 'I-beam', part: 'ibeam' },
  { id: 'strut', name: 'Round pillar / strut', part: 'strut' },
  { id: 'truss', name: 'Truss girder', part: 'truss' },
];

export interface PenOptions {
  floorType: string;
  /** Side-to-side width of floors, rooms and framing drawn in the side view, m. */
  width: number;
  /** Floor-to-ceiling height for rooms and for walls drawn in the top view, m. */
  ceilingHeight: number;
  supportType: SupportType;
  supportMaterial: string;
  /** Cross-section of a support, m. */
  supportSize: number;
  /** Side view: put supports against both side walls (mirrored) or on the centre line. */
  supportPlacement: 'sides' | 'centre';
  /** Framing sheet: material and thickness (see FRAME_TYPES). */
  frameMaterial: string;
  frameDepth: number;
  /** Armor plating on framing: material ('none' for bare sheet) and which face it goes on. */
  armorMaterial: string;
  armorSide: ArmorSide;
  skinThickness: number;
  /** Top plan floors: drag a rectangle, or click out any shape corner by corner. */
  floorShape: 'rect' | 'free';
  /** Framing: outline sections that span the width, or flat panels drawn in the view's own plane. */
  frameMode: 'profile' | 'panel';
  /** Side-profile panels: against both side walls (mirrored) or on the centre line. */
  panelPlacement: 'sides' | 'centre';
  /** Ramp pen: a smooth sloped floor or a flight of stairs. */
  rampStyle: 'ramp' | 'stairs';
  /** Top plan: how far a ramp or ladder climbs, m. */
  rampRise: number;
  /** Cut-out pen: leave the hole open or fit a glazed window. */
  cutoutStyle: 'open' | 'window';
  windowFrame: string;
}

export const DEFAULT_PEN_OPTIONS: PenOptions = {
  floorType: 'pine',
  width: 4,
  ceilingHeight: 2.4,
  floorShape: 'rect',
  frameMode: 'profile',
  panelPlacement: 'sides',
  rampStyle: 'ramp',
  rampRise: 2.4,
  cutoutStyle: 'window',
  windowFrame: 'brass',
  supportType: 'beam',
  supportMaterial: 'oak',
  supportSize: 0.2,
  supportPlacement: 'sides',
  frameMaterial: 'pine',
  frameDepth: 0.04,
  armorMaterial: 'none',
  armorSide: 'outside',
  skinThickness: 0.03,
};

export function toWorld(view: PlaneView, p: P2, out = 0): Vec3 {
  return view === 'side' ? [out, p.v, p.u] : [p.v, out, p.u];
}

export function toPlane(view: PlaneView, w: Vec3): P2 {
  return view === 'side' ? { u: w[2], v: w[1] } : { u: w[2], v: w[0] };
}

export function outOfPlane(view: PlaneView, w: Vec3): number {
  return view === 'side' ? w[0] : w[1];
}

function part(type: string, position: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0], material?: string): PartInstance {
  const def = getDef(type);
  return {
    id: newId(),
    type,
    position: position.map(round) as Vec3,
    rotation,
    size: size.map(round) as Vec3,
    material: material ?? def.defaultMaterial,
    props: { ...(def.defaultProps ?? {}), pen: true },
  };
}

function round(v: number) {
  return Math.round(v * 10000) / 10000;
}

/** Transform for a part whose local Z runs from a to b in the plane. */
export function segmentTransform(view: PlaneView, a: P2, b: P2, out = 0, wall = false): { position: Vec3; rotation: Vec3; length: number } {
  const du = b.u - a.u, dv = b.v - a.v;
  const length = Math.hypot(du, dv);
  const mid = { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
  const angle = Math.atan2(dv, du);
  const rotation: Vec3 = view === 'side' ? [-angle, 0, 0] : [0, angle, wall ? Math.PI / 2 : 0];
  return { position: toWorld(view, mid, out), rotation, length };
}

/** Link two parts as mirror twins (the second is created from the first). */
export function mirrorPair(p: PartInstance): [PartInstance, PartInstance] {
  const t: PartInstance = { ...p, id: newId(), props: { ...p.props }, size: [...p.size] as Vec3 };
  const m = mirrorTransform(p.position, p.rotation);
  t.position = m.position;
  t.rotation = m.rotation;
  Object.assign(t, mirrorShapeData(p));
  p.mirrorOf = t.id;
  t.mirrorOf = p.id;
  return [p, t];
}

export function floorTypeOf(opts: PenOptions): FloorType {
  return FLOOR_TYPES.find((f) => f.id === opts.floorType) ?? FLOOR_TYPES[0];
}

/**
 * Floor pen. Side view: a horizontal line through the middle of the floor,
 * `width` wide (the editor lifts it onto a surface it starts on). Top view: a
 * rectangle whose top sits at the active layer's elevation.
 */
export function drawFloor(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, anchor: Anchor = {}): PartInstance[] {
  const ft = floorTypeOf(opts);
  const t = ft.thickness;
  if (view === 'side') {
    const y = a.v;
    const len = Math.abs(b.u - a.u);
    if (len < 0.05) return [];
    return [named(part('deck', [0, y, (a.u + b.u) / 2], [anchor.width ?? opts.width, t, len], [0, 0, 0], ft.material), 'Floor')];
  }
  const len = Math.abs(b.u - a.u), wid = Math.abs(b.v - a.v);
  if (len < 0.05 || wid < 0.05) return [];
  return [named(part('deck', [(a.v + b.v) / 2, layerY - t / 2, (a.u + b.u) / 2], [wid, t, len], [0, 0, 0], ft.material), 'Floor')];
}

/** A floor of any shape, clicked out corner by corner in the top plan; its top sits at `layerY`. */
export function drawFloorPolygon(points: P2[], opts: PenOptions, layerY = 0): PartInstance | null {
  if (points.length < 3) return null;
  const ft = floorTypeOf(opts);
  const temp = part('deck', [0, layerY - ft.thickness / 2, 0], [1, ft.thickness, 1], [0, 0, 0], ft.material);
  // Top plan: u = Z, v = X, and a flat floor's local X/Z are the world's.
  const shaped = withDeckOutline(temp, points.map((q) => [q.v, q.u] as [number, number]));
  const f: PartInstance = { ...temp, ...shaped };
  if (outlineAreaXZ(f.points!) < 0.01) return null;
  f.name = 'Floor';
  return f;
}

/**
 * A flat framing panel drawn in the view's own plane: side panels in the side
 * profile (against both side walls, or wherever the first point was), or
 * horizontal sheets in the top plan.
 */
export function drawPanel(view: PlaneView, points: P2[], opts: PenOptions, out: number, mirrored: boolean): PartInstance[] {
  if (points.length < 3) return [];
  const world = points.map((q) => toWorld(view, q, out));
  const n = world.length;
  const avg = world.reduce((acc, w) => [acc[0] + w[0] / n, acc[1] + w[1] / n, acc[2] + w[2] / n], [0, 0, 0]);
  // Outside faces away from the centre line (side panels) or upward (top-plan sheets).
  const centre: Vec3 = view === 'side' ? [0, avg[1], avg[2]] : [avg[0], avg[1] - 1, avg[2]];
  const p = framePolygon3D(world, opts, centre);
  if (!p) return [];
  p.name = view === 'side' ? 'Side panel' : 'Panel';
  return mirrored && Math.abs(out) > 0.02 ? mirrorPair(p) : [p];
}

/** Floor + ceiling + the air volume between them. */
export function drawRoom(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, anchor: Anchor = {}): PartInstance[] {
  const floor = drawFloor(view, a, b, opts, layerY, anchor);
  if (!floor.length) return [];
  const f = floor[0];
  const t = f.size[1];
  const top = f.position[1] + t / 2;
  const H = opts.ceilingHeight;
  const ceiling = named(part('deck', [f.position[0], top + H + t / 2, f.position[2]], [...f.size] as Vec3, [0, 0, 0], f.material), 'Ceiling');
  const room = part('compartment', [f.position[0], top + H / 2, f.position[2]], [f.size[0], H, f.size[2]]);
  room.props.label = 'Room';
  return [f, ceiling, room];
}

function supportSize(opts: PenOptions, length: number): Vec3 {
  const s = opts.supportSize;
  switch (opts.supportType) {
    case 'ibeam': return [s, s * 1.5, length];
    case 'truss': return [s * 3, s * 3, length];
    default: return [s, s, length];
  }
}

/**
 * Supports. Side view: any line (the editor snaps it to horizontal/vertical),
 * standing against both side walls (a mirrored pair) or on the centre line —
 * or, when started from another support, at that support's offset.
 * Top view: drag a line for a horizontal beam (under the active floor, or at
 * the height of the support it starts from); a single click stands a pillar.
 */
export function drawSupport(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, floorThickness = 0.05, anchor: Anchor = {}): PartInstance[] {
  const type = SUPPORT_TYPES.find((s) => s.id === opts.supportType)!.part;
  const { length } = segmentTransform(view, a, b);
  if (view === 'top' && length < 0.05) {
    const H = opts.ceilingHeight;
    const base = anchor.out ?? layerY;
    return [named(part(type, [a.v, base + H / 2, a.u], supportSize(opts, H), [-Math.PI / 2, 0, 0], opts.supportMaterial), 'Pillar')];
  }
  if (length < 0.05) return [];
  const size = supportSize(opts, length);
  if (view === 'top') {
    const tr = segmentTransform(view, a, b, anchor.out ?? layerY - floorThickness - size[1] / 2);
    return [named(part(type, tr.position, size, tr.rotation, opts.supportMaterial), 'Beam')];
  }
  const width = anchor.width ?? opts.width;
  const x = anchor.out !== undefined ? Math.abs(anchor.out) : opts.supportPlacement === 'sides' ? Math.max(0, width / 2 - size[0] / 2) : 0;
  const tr = segmentTransform(view, a, b, x);
  const p = named(part(type, tr.position, size, tr.rotation, opts.supportMaterial), 'Support');
  return x > 0.02 ? mirrorPair(p) : [p];
}

/** A floor slab running up a slope from a to b (3D points), `width` wide. */
function slopedDeck(a: Vec3, b: Vec3, width: number, opts: PenOptions): PartInstance | null {
  const A = new Vector3(...a), B = new Vector3(...b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  if (len < 0.05) return null;
  const z = dir.normalize();
  let x = new Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-6) x = new Vector3(1, 0, 0);
  x.normalize();
  const y = z.clone().cross(x).normalize();
  const ft = floorTypeOf(opts);
  const mid = A.clone().add(B).multiplyScalar(0.5);
  return named(part('deck', [mid.x, mid.y, mid.z], [width, ft.thickness, len], basisRotation(x, y, z), ft.material), 'Ramp');
}

/** Stairs climbing from a to b (3D points): the flight rises along its local +Z. */
function stairsBetween(a: Vec3, b: Vec3, width: number, opts: PenOptions): PartInstance | null {
  const low = a[1] <= b[1] ? a : b, high = a[1] <= b[1] ? b : a;
  const dx = high[0] - low[0], dz = high[2] - low[2];
  const run = Math.hypot(dx, dz), rise = high[1] - low[1];
  if (run < 0.1 || rise < 0.1) return null;
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return named(part('stairs', mid, [width, rise, run], [0, Math.atan2(dx, dz), 0], floorTypeOf(opts).material), 'Stairs');
}

/**
 * Ramp pen: a sloped floor (or stairs) joining two levels. Side view: draw
 * from one floor edge to the other. Top plan: draw the run; it climbs
 * `rampRise` from the active layer.
 */
export function drawRamp(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, anchor: Anchor = {}): PartInstance[] {
  let A: Vec3, B: Vec3, width: number;
  if (view === 'side') {
    A = [0, a.v, a.u]; B = [0, b.v, b.u];
    width = Math.min(anchor.width ?? opts.width, opts.width);
  } else {
    A = [a.v, layerY, a.u]; B = [b.v, layerY + opts.rampRise, b.u];
    width = Math.max(0.6, opts.width / 3);
  }
  const p = opts.rampStyle === 'stairs' ? stairsBetween(A, B, width, opts) : slopedDeck(A, B, width, opts);
  return p ? [p] : [];
}

/**
 * Ladder pen. Side view: a ladder along the drawn line (usually straight up).
 * Top plan: click where it stands; it climbs `rampRise` from the active layer.
 */
export function drawLadder(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, crewHeight = 1.8): PartInstance[] {
  const w = +(0.5 * crewHeight / 1.8).toFixed(3);
  if (view === 'top') {
    const H = opts.rampRise;
    return [named(part('ladder', [a.v, layerY + H / 2, a.u], [w, H, 0.1], [0, 0, 0]), 'Ladder')];
  }
  const du = b.u - a.u, dv = b.v - a.v;
  const len = Math.hypot(du, dv);
  if (len < 0.2) return [];
  // The ladder's rails run along its local Y: tip that onto the drawn line.
  return [named(part('ladder', [0, (a.v + b.v) / 2, (a.u + b.u) / 2], [w, len, 0.1], [Math.atan2(du, dv), 0, 0]), 'Ladder')];
}

/** A cut-out rectangle in a sheet's own 2D coordinates, or null if the sheet can't take it here. */
export function sheetHole(p: PartInstance, view: PlaneView, a: P2, b: P2): number[] | null {
  const corners: P2[] = [{ u: a.u, v: a.v }, { u: b.u, v: a.v }, { u: b.u, v: b.v }, { u: a.u, v: b.v }];
  if (p.type === 'hullSides') {
    if (view !== 'side') return null;
    return corners.flatMap((q) => [round(q.u - p.position[2]), round(q.v - p.position[1])]);
  }
  if (!isSheet(p) || !facesView(p, view)) return null;
  return corners.flatMap((q) => planeToSheetLocal(p, view, q).map(round));
}

/** Does a hole (sheet 2D coordinates) overlap the sheet's face at all? */
export function holeHitsSheet(p: PartInstance, hole: number[]): boolean {
  const xs = hole.filter((_, i) => i % 2 === 0), zs = hole.filter((_, i) => i % 2 === 1);
  if (p.type === 'hullSides') {
    return Math.min(...xs) < p.size[2] / 2 && Math.max(...xs) > -p.size[2] / 2 && Math.min(...zs) < p.size[1] / 2 && Math.max(...zs) > -p.size[1] / 2;
  }
  const o = deckOutline(p);
  const ox = o.map((q) => q[0]), oz = o.map((q) => q[1]);
  return Math.min(...xs) < Math.max(...ox) && Math.max(...xs) > Math.min(...ox) && Math.min(...zs) < Math.max(...oz) && Math.max(...zs) > Math.min(...oz);
}

/** A window frame fitted into a hole in a floor or framing sheet. */
export function windowFor(p: PartInstance, hole: number[], opts: PenOptions): PartInstance {
  const xs = hole.filter((_, i) => i % 2 === 0), zs = hole.filter((_, i) => i % 2 === 1);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...zs) - Math.min(...zs);
  if (p.type === 'hullSides') {
    // Side walls stand at ±width/2 and face ±X; the window sits in the starboard wall (the mirror twin covers port).
    const win = part('window', [p.size[0] / 2 + 0.01, p.position[1] + cz, p.position[2] + cx], [h, 0.06, w], [0, 0, Math.PI / 2], opts.windowFrame);
    win.props.glazed = opts.cutoutStyle === 'window';
    return named(win, 'Window');
  }
  const win = part('window', localToWorld(p, [cx, 0, cz]), [w, p.size[1] + 0.02, h], [...p.rotation] as Vec3, opts.windowFrame);
  win.props.glazed = opts.cutoutStyle === 'window';
  return named(win, 'Window');
}

/** How far a support/sheet reaches either side of its drawn centre line, within the drawing plane. */
export function halfDepth(view: PlaneView, pen: PenKind, opts: PenOptions): number {
  if (pen === 'frame') return opts.frameDepth / 2;
  const s = supportSize(opts, 1);
  return (view === 'side' ? s[1] : s[0]) / 2;
}

function named(p: PartInstance, name: string): PartInstance {
  p.name = name;
  return p;
}

/**
 * Framing: a chain of segments giving the craft its shape. Side view segments
 * span the full width (roof, belly, bow and stern plating); top-view segments
 * are walls standing on the active layer. Each segment's "outside" faces away
 * from the middle of the chain it belongs to.
 */
export function drawFraming(view: PlaneView, chain: P2[], opts: PenOptions, layerY = 0, anchor: Anchor = {}): PartInstance[] {
  const parts: PartInstance[] = [];
  const centroid = chain.reduce((acc, p) => ({ u: acc.u + p.u / chain.length, v: acc.v + p.v / chain.length }), { u: 0, v: 0 });
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    const wall = view === 'top';
    const H = opts.ceilingHeight;
    const tr = segmentTransform(view, a, b, wall ? layerY + H / 2 : 0, wall);
    if (tr.length < 0.05) continue;
    const span = wall ? H : anchor.width ?? opts.width;
    const p = named(part('frame', tr.position, [span, opts.frameDepth, tr.length], tr.rotation, opts.frameMaterial), wall ? 'Wall frame' : 'Frame');
    Object.assign(p.props, armorProps(opts.armorMaterial, opts.armorSide));
    p.props.skinThickness = opts.skinThickness;
    p.props.outSign = outwardSign(view, p, { u: (a.u + b.u) / 2 - centroid.u, v: (a.v + b.v) / 2 - centroid.v });
    parts.push(p);
  }
  return parts;
}

/** +1 if the part's local +Y face points along `away` in the plane, else −1. */
export function outwardSign(view: PlaneView, p: PartInstance, away: P2): number {
  const m = rotationMatrix(p.rotation);
  const n: Vec3 = [m[1], m[4], m[7]];
  const np = toPlane(view, n);
  const d = np.u * away.u + np.v * away.v;
  if (Math.abs(d) < 1e-6) return np.v >= 0 ? 1 : -1;
  return d > 0 ? 1 : -1;
}

/** Side walls closing a loop of side-view framing into a sealed hull. */
export function drawHullSides(loop: P2[], opts: PenOptions): PartInstance | null {
  const pts = loop.slice();
  if (pts.length > 1 && Math.hypot(pts[0].u - pts[pts.length - 1].u, pts[0].v - pts[pts.length - 1].v) < 1e-6) pts.pop();
  if (pts.length < 3) return null;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.u * b.v - b.u * a.v;
  }
  area = Math.abs(area) / 2;
  if (area < 0.01) return null;
  const us = pts.map((p) => p.u), vs = pts.map((p) => p.v);
  const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  const skin = opts.frameMaterial;
  const p = part('hullSides', [0, cv, cu], [opts.width, Math.max(...vs) - Math.min(...vs), Math.max(...us) - Math.min(...us)], [0, 0, 0], skin);
  p.name = 'Hull sides';
  p.points = pts.flatMap((q) => [0, round(q.v - cv), round(q.u - cu)]);
  p.props.thickness = opts.frameDepth;
  p.props.area = round(area);
  p.props.volume = round(area * opts.width);
  return p;
}

// ── Drawing in 3D ───────────────────────────────────────────────────────────

function basisRotation(x: Vector3, y: Vector3, z: Vector3): Vec3 {
  const m = new Matrix4().makeBasis(x, y, z);
  const e = new Euler().setFromRotationMatrix(m, 'XYZ');
  return [e.x, e.y, e.z];
}

/** A support running between two points anywhere in space. */
export function support3D(a: Vec3, b: Vec3, opts: PenOptions): PartInstance | null {
  const A = new Vector3(...a), B = new Vector3(...b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  if (len < 0.05) return null;
  const z = dir.normalize();
  // Keep the beam's width horizontal where possible.
  let x = new Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-6) x = new Vector3(1, 0, 0);
  x.normalize();
  const y = z.clone().cross(x).normalize();
  const type = SUPPORT_TYPES.find((s) => s.id === opts.supportType)!.part;
  const mid = A.clone().add(B).multiplyScalar(0.5);
  return named(part(type, [mid.x, mid.y, mid.z], supportSize(opts, len), basisRotation(x, y, z), opts.supportMaterial), 'Support');
}

/**
 * A framing sheet through three or more clicked corners. The corners are
 * flattened onto their best-fit plane; `centre` (the rest of the craft) decides
 * which face is the outside.
 */
export function framePolygon3D(points: Vec3[], opts: PenOptions, centre?: Vec3): PartInstance | null {
  if (points.length < 3) return null;
  const P = points.map((p) => new Vector3(...p));
  // Newell's method: robust normal for any (even slightly bent) polygon.
  const n = new Vector3();
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-9) return null;
  n.normalize();
  const origin = P.reduce((acc, p) => acc.add(p), new Vector3()).multiplyScalar(1 / P.length);
  let z = P[1].clone().sub(P[0]);
  z.sub(n.clone().multiplyScalar(z.dot(n)));
  if (z.lengthSq() < 1e-9) return null;
  z = z.normalize();
  const x = n.clone().cross(z).normalize();
  const temp = part('frame', [origin.x, origin.y, origin.z], [1, opts.frameDepth, 1], basisRotation(x, n, z), opts.frameMaterial);
  const outline: [number, number][] = P.map((p) => {
    const d = p.clone().sub(origin);
    return [d.dot(x), d.dot(z)];
  });
  const shaped = withDeckOutline(temp, outline);
  const f: PartInstance = { ...temp, ...shaped };
  f.name = 'Frame';
  Object.assign(f.props, armorProps(opts.armorMaterial, opts.armorSide));
  f.props.skinThickness = opts.skinThickness;
  if (centre) {
    const away = origin.clone().sub(new Vector3(...centre));
    f.props.outSign = away.dot(n) >= 0 ? 1 : -1;
  }
  return f;
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** A part with a clear length axis whose two ends can be grabbed. */
export function isSegmentLike(p: PartInstance): boolean {
  const def = getDef(p.type);
  if (def.compartment || p.type === 'hullSides' || p.type === 'hullShell') return false;
  if (isSheet(p) && p.points) return false;
  if (p.props.pen || def.conduit || p.type === 'frame' || p.type === 'deck') return true;
  return !!def.structural && p.size[2] >= Math.max(p.size[0], p.size[1]);
}

export function endpoints(p: PartInstance): [Vec3, Vec3] {
  const h = p.size[2] / 2;
  return [localToWorld(p, [0, 0, -h]), localToWorld(p, [0, 0, h])];
}

/**
 * Move one end of a part to `to` (world space) while the other end stays put.
 * Returns the new transform and size; the part's roll is preserved.
 */
export function moveEndpoint(p: PartInstance, end: 0 | 1, to: Vec3): Pick<PartInstance, 'position' | 'rotation' | 'size'> | null {
  const [e0, e1] = endpoints(p);
  const fixed = end === 0 ? e1 : e0;
  const moving = end === 0 ? e0 : e1;
  const oldDir = new Vector3(...moving).sub(new Vector3(...fixed));
  const newDir = new Vector3(...to).sub(new Vector3(...fixed));
  const len = newDir.length();
  if (len < 0.02 || oldDir.length() < 1e-6) return null;
  const q = new Quaternion().setFromUnitVectors(oldDir.normalize(), newDir.clone().normalize());
  const rot = q.multiply(new Quaternion().setFromEuler(new Euler(...p.rotation, 'XYZ')));
  const e = new Euler().setFromQuaternion(rot, 'XYZ');
  const mid = new Vector3(...fixed).add(new Vector3(...to)).multiplyScalar(0.5);
  return {
    position: [round(mid.x), round(mid.y), round(mid.z)],
    rotation: [e.x, e.y, e.z],
    size: [p.size[0], p.size[1], round(len)],
  };
}

// ── Sheet outlines (floors and framing) ─────────────────────────────────────

/** Floors and framing are flat sheets whose outline can be reshaped corner by corner. */
export function isSheet(p: PartInstance): boolean {
  return p.type === 'deck' || p.type === 'frame';
}

/** A sheet's face normal (its local +Y) in world space. */
export function sheetNormal(p: PartInstance): Vec3 {
  const m = rotationMatrix(p.rotation);
  return [m[1], m[4], m[7]];
}

/** True when the view looks roughly straight at the sheet, so its outline can be edited there. */
export function facesView(p: PartInstance, view: PlaneView): boolean {
  const n = sheetNormal(p);
  return Math.abs(view === 'top' ? n[1] : n[0]) > 0.35;
}

/**
 * The point on a sheet's middle plane that sits under/behind a point in the
 * view (found along the view's out-of-plane axis), in the sheet's local X/Z.
 */
export function planeToSheetLocal(p: PartInstance, view: PlaneView, q: P2): [number, number] {
  const n = sheetNormal(p);
  const c = p.position;
  let w: Vec3;
  if (view === 'top') {
    // (u, v) = (z, x); solve for y on the plane.
    const y = c[1] - (n[0] * (q.v - c[0]) + n[2] * (q.u - c[2])) / n[1];
    w = [q.v, y, q.u];
  } else {
    // (u, v) = (z, y); solve for x on the plane.
    const x = c[0] - (n[1] * (q.v - c[1]) + n[2] * (q.u - c[2])) / n[0];
    w = [x, q.v, q.u];
  }
  const l = worldToLocal(p, w);
  return [l[0], l[2]];
}

/** A floor's outline in its own X/Z plane, corner by corner. Plain floors are rectangles. */
export function deckOutline(p: PartInstance): [number, number][] {
  if (p.points && p.points.length >= 9) {
    const out: [number, number][] = [];
    for (let i = 0; i + 2 < p.points.length; i += 3) out.push([p.points[i], p.points[i + 2]]);
    return out;
  }
  const hx = p.size[0] / 2, hz = p.size[2] / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
}

export function worldToLocal(p: PartInstance, w: Vec3): Vec3 {
  const m = rotationMatrix(p.rotation);
  const d: Vec3 = [w[0] - p.position[0], w[1] - p.position[1], w[2] - p.position[2]];
  // Inverse of a rotation matrix is its transpose.
  return [m[0] * d[0] + m[3] * d[1] + m[6] * d[2], m[1] * d[0] + m[4] * d[1] + m[7] * d[2], m[2] * d[0] + m[5] * d[1] + m[8] * d[2]];
}

/** Rebuild a floor from a new outline, re-centred so its bounding box stays tight. */
export function withDeckOutline(p: PartInstance, outline: [number, number][]): Pick<PartInstance, 'position' | 'size' | 'points'> {
  const xs = outline.map((q) => q[0]), zs = outline.map((q) => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
  return {
    position: localToWorld(p, [mx, 0, mz]).map(round) as Vec3,
    size: [round(Math.max(0.01, maxX - minX)), p.size[1], round(Math.max(0.01, maxZ - minZ))],
    points: outline.flatMap((q) => [round(q[0] - mx), 0, round(q[1] - mz)]),
  };
}

/** Sheet corners in world space (top face of a floor, middle of a framing sheet). */
export function deckCorners(p: PartInstance): Vec3[] {
  const y = p.type === 'deck' ? p.size[1] / 2 : 0;
  return deckOutline(p).map(([x, z]) => localToWorld(p, [x, y, z]));
}

// ── Layers ──────────────────────────────────────────────────────────────────

export interface ResolvedLayer { id: string; name: string; visible: boolean; y: number; floorId: string }

/** Layers sorted bottom to top, with the elevation of their floor's top surface. */
export function resolveLayers(d: Design): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  for (const l of d.layers ?? []) {
    const f = d.parts.find((p) => p.id === l.floorId);
    if (!f) continue;
    out.push({ ...l, y: f.position[1] + f.size[1] / 2 });
  }
  return out.sort((a, b) => a.y - b.y);
}

/** Which layer a part belongs to: the highest layer whose floor is at or below it. */
export function layerOf(p: PartInstance, layers: ResolvedLayer[]): ResolvedLayer | null {
  if (layers.some((l) => l.floorId === p.id)) return layers.find((l) => l.floorId === p.id)!;
  let best: ResolvedLayer | null = null;
  const y = p.position[1];
  for (const l of layers) if (y >= l.y - 0.3) best = l;
  return best;
}

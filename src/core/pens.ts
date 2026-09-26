import { Euler, Quaternion, Vector3 } from 'three';
import { getDef } from './catalog';
import { localToWorld, mirrorTransform, rotationMatrix } from './geometry';
import { newId, type Design, type PartInstance, type Vec3 } from './types';

/**
 * Blueprint drawing. The 2D editor works in a plane:
 *   side view: u = Z (bow to the right), v = Y (up); out-of-plane axis is X
 *   top view:  u = Z (bow to the right), v = X (starboard down); out-of-plane axis is Y
 * Pens turn strokes in that plane into ordinary parts, so everything drawn is
 * also a normal 3D part with mass, strength and so on.
 */

export type PlaneView = 'side' | 'top';
export type PenKind = 'floor' | 'room' | 'support' | 'frame';
export type SupportType = 'beam' | 'ibeam' | 'strut' | 'truss';

export interface P2 { u: number; v: number }

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
  /** Top view: draw horizontal beams or stand vertical pillars. */
  supportOrientation: 'beam' | 'pillar';
  frameMaterial: string;
  frameDepth: number;
  skinOuter: string;
  skinInner: string;
  skinThickness: number;
}

export const DEFAULT_PEN_OPTIONS: PenOptions = {
  floorType: 'pine',
  width: 4,
  ceilingHeight: 2.4,
  supportType: 'beam',
  supportMaterial: 'oak',
  supportSize: 0.2,
  supportPlacement: 'sides',
  supportOrientation: 'pillar',
  frameMaterial: 'oak',
  frameDepth: 0.2,
  skinOuter: 'oak',
  skinInner: 'none',
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
  p.mirrorOf = t.id;
  t.mirrorOf = p.id;
  return [p, t];
}

export function floorTypeOf(opts: PenOptions): FloorType {
  return FLOOR_TYPES.find((f) => f.id === opts.floorType) ?? FLOOR_TYPES[0];
}

/**
 * Floor pen. Side view: a horizontal line marking the walking surface, `width`
 * wide. Top view: a rectangle at the active layer's elevation.
 */
export function drawFloor(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0): PartInstance[] {
  const ft = floorTypeOf(opts);
  const t = ft.thickness;
  if (view === 'side') {
    const y = a.v;
    const len = Math.abs(b.u - a.u);
    if (len < 0.05) return [];
    return [named(part('deck', [0, y - t / 2, (a.u + b.u) / 2], [opts.width, t, len], [0, 0, 0], ft.material), 'Floor')];
  }
  const len = Math.abs(b.u - a.u), wid = Math.abs(b.v - a.v);
  if (len < 0.05 || wid < 0.05) return [];
  return [named(part('deck', [(a.v + b.v) / 2, layerY - t / 2, (a.u + b.u) / 2], [wid, t, len], [0, 0, 0], ft.material), 'Floor')];
}

/** Floor + ceiling + the air volume between them. */
export function drawRoom(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0): PartInstance[] {
  const floor = drawFloor(view, a, b, opts, layerY);
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
 * standing against both side walls (a mirrored pair) or on the centre line.
 * Top view: a horizontal beam under the active floor, or a pillar standing on
 * it; the editor's mirror setting decides whether those get a twin.
 */
export function drawSupport(view: PlaneView, a: P2, b: P2, opts: PenOptions, layerY = 0, floorThickness = 0.05): PartInstance[] {
  const type = SUPPORT_TYPES.find((s) => s.id === opts.supportType)!.part;
  if (view === 'top' && opts.supportOrientation === 'pillar') {
    const H = opts.ceilingHeight;
    const size = supportSize(opts, H);
    return [named(part(type, [a.v, layerY + H / 2, a.u], size, [-Math.PI / 2, 0, 0], opts.supportMaterial), 'Pillar')];
  }
  const { length } = segmentTransform(view, a, b);
  if (length < 0.05) return [];
  const size = supportSize(opts, length);
  if (view === 'top') {
    const tr = segmentTransform(view, a, b, layerY - floorThickness - size[1] / 2);
    return [named(part(type, tr.position, size, tr.rotation, opts.supportMaterial), 'Beam')];
  }
  const x = opts.supportPlacement === 'sides' ? Math.max(0, opts.width / 2 - size[0] / 2) : 0;
  const tr = segmentTransform(view, a, b, x);
  const p = named(part(type, tr.position, size, tr.rotation, opts.supportMaterial), 'Support');
  return x > 0 ? mirrorPair(p) : [p];
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
export function drawFraming(view: PlaneView, chain: P2[], opts: PenOptions, layerY = 0): PartInstance[] {
  const parts: PartInstance[] = [];
  const centroid = chain.reduce((acc, p) => ({ u: acc.u + p.u / chain.length, v: acc.v + p.v / chain.length }), { u: 0, v: 0 });
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    const wall = view === 'top';
    const H = opts.ceilingHeight;
    const tr = segmentTransform(view, a, b, wall ? layerY + H / 2 : 0, wall);
    if (tr.length < 0.05) continue;
    const span = wall ? H : opts.width;
    const p = named(part('frame', tr.position, [span, opts.frameDepth, tr.length], tr.rotation, opts.frameMaterial), wall ? 'Wall frame' : 'Frame');
    p.props.skinOuter = opts.skinOuter;
    p.props.skinInner = opts.skinInner;
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
  const skin = opts.skinOuter !== 'none' ? opts.skinOuter : opts.frameMaterial;
  const p = part('hullSides', [0, cv, cu], [opts.width, Math.max(...vs) - Math.min(...vs), Math.max(...us) - Math.min(...us)], [0, 0, 0], skin);
  p.name = 'Hull sides';
  p.points = pts.flatMap((q) => [0, round(q.v - cv), round(q.u - cu)]);
  p.props.thickness = opts.skinThickness;
  p.props.area = round(area);
  p.props.volume = round(area * opts.width);
  return p;
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** A part with a clear length axis whose two ends can be grabbed. */
export function isSegmentLike(p: PartInstance): boolean {
  const def = getDef(p.type);
  if (def.compartment || p.type === 'hullSides' || p.type === 'hullShell') return false;
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

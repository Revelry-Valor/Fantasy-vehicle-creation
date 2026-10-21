import { Matrix4 } from 'three';
import { getDef } from './catalog';
import { mapPath } from './curves';
import { partAABB } from './geometry';
import { DEG, eq, eulerDeg } from './math';
import { Euler } from 'three';
import { clone, newId, type MirrorAxis, type Part, type Vec3, type Vehicle } from './types';

/**
 * Mirroring. A twin is the source reflected across one or more planes through
 * the mirror origin. Reflections are stored exactly: position and path points
 * are reflected, rotation becomes S·R·S, and the reflection itself goes into
 * the part's `flip`, so even lopsided shapes come out as true mirror images.
 * Joints need nothing extra: a flipped frame makes the twin turn the other way.
 */

export const AXES: MirrorAxis[] = ['x', 'y', 'z'];

export function axesString(set: Iterable<MirrorAxis>): string {
  const s = new Set(set);
  return AXES.filter((a) => s.has(a)).join('');
}

/** Combine two reflections (reflecting twice across a plane cancels). */
export function xorAxes(a: string, b: string): string {
  return AXES.filter((x) => a.includes(x) !== b.includes(x)).join('');
}

function signs(axes: string): Vec3 {
  return [axes.includes('x') ? -1 : 1, axes.includes('y') ? -1 : 1, axes.includes('z') ? -1 : 1];
}

export function reflectPoint(p: Vec3, axes: string, origin: Vec3): Vec3 {
  const s = signs(axes);
  return [origin[0] + s[0] * (p[0] - origin[0]), origin[1] + s[1] * (p[1] - origin[1]), origin[2] + s[2] * (p[2] - origin[2])];
}

function reflectRotation(rot: Vec3, axes: string): Vec3 {
  const s = signs(axes);
  const S = new Matrix4().makeScale(s[0], s[1], s[2]);
  const R = new Matrix4().makeRotationFromEuler(new Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ'));
  return eulerDeg(S.clone().multiply(R).multiply(S));
}

/** The source of a part's mirror family (itself if it has no link). */
export function sourceOf(v: Vehicle, id: string): string {
  const p = v.parts.find((x) => x.id === id);
  return p?.mirror?.source ?? id;
}

export function family(v: Vehicle, id: string): Part[] {
  const src = sourceOf(v, id);
  return v.parts.filter((p) => p.id === src || p.mirror?.source === src);
}

/** Axes of a part relative to its family source. */
function relAxes(v: Vehicle, id: string): string {
  return v.parts.find((x) => x.id === id)?.mirror?.axes ?? '';
}

/** The member of `id`'s family reflected by `axes` relative to it, if there is one. */
export function counterpart(v: Vehicle, id: string, axes: string): string | null {
  if (!axes) return id;
  const want = xorAxes(relAxes(v, id), axes);
  const src = sourceOf(v, id);
  const m = v.parts.find((p) => (want ? p.mirror?.source === src && p.mirror.axes === want : p.id === src));
  return m?.id ?? null;
}

/** Geometry of `p` reflected by `axes` (ids, names and links are left to the caller). */
export function reflectPart(v: Vehicle, p: Part, axes: string): Part {
  const o = v.mirror.origin;
  const q = clone(p);
  const s = signs(axes);
  q.position = reflectPoint(p.position, axes, o);
  q.rotation = reflectRotation(p.rotation, axes);
  const f = p.flip ?? [1, 1, 1];
  const nf: Vec3 = [f[0] * s[0], f[1] * s[1], f[2] * s[2]];
  q.flip = nf[0] === 1 && nf[1] === 1 && nf[2] === 1 ? undefined : nf;
  if (p.path) q.path = mapPath(p.path, (x) => reflectPoint(x, axes, o));
  if (p.surface) {
    q.surface = { ...p.surface, edges: p.surface.edges.map((e) => ({ ...e, part: counterpart(v, e.part, axes) ?? e.part })) };
  }
  if (p.derived) q.derived = { ...p.derived, ribs: p.derived.ribs.map((r) => counterpart(v, r, axes) ?? r) };
  return q;
}

function sameShape(v: Vehicle, a: Part, b: Part): boolean {
  if (a.surface && b.surface) {
    const ea = a.surface.edges.map((e) => e.part).sort().join(), eb = b.surface.edges.map((e) => e.part).sort().join();
    return ea === eb;
  }
  const A = partAABB(a, v), B = partAABB(b, v);
  if (!A || !B) return false;
  return eq(A.min, B.min, 1e-4) && eq(A.max, B.max, 1e-4) && a.def === b.def;
}

/** Every combination of the enabled axes: x, y, xy, z, xz, yz, xyz. */
export function combos(enabled: MirrorAxis[]): string[] {
  const out: string[] = [];
  const n = enabled.length;
  for (let mask = 1; mask < 1 << n; mask++) out.push(axesString(enabled.filter((_, i) => mask & (1 << i))));
  return out;
}

export function enabledAxes(v: Vehicle): MirrorAxis[] {
  return AXES.filter((a) => v.mirror[a]);
}

/**
 * Add live twins for a newly placed part. Twins that would land exactly on
 * the original (a part sitting on the mirror plane) are skipped.
 */
export function addTwins(v: Vehicle, p: Part, axes = enabledAxes(v)): Part[] {
  const made: Part[] = [];
  const existing: Part[] = [p];
  for (const ax of combos(axes)) {
    const t = reflectPart(v, p, ax);
    t.id = newId();
    t.mirror = { source: p.id, axes: ax };
    if (existing.some((e) => sameShape(v, e, t))) continue;
    existing.push(t);
    v.parts.push(t);
    made.push(t);
  }
  return made;
}

/**
 * After a family member changed, bring the rest of the family in line.
 * Edits on a twin carry back to the source first.
 */
export function syncFamily(v: Vehicle, editedId: string) {
  const edited = v.parts.find((x) => x.id === editedId);
  if (!edited) return;
  let src = edited;
  if (edited.mirror) {
    const s = v.parts.find((x) => x.id === edited.mirror!.source);
    if (!s) { delete edited.mirror; return; }
    const r = reflectPart(v, edited, edited.mirror.axes);
    copyShape(s, r);
    src = s;
  }
  for (const t of v.parts) {
    if (t.mirror?.source !== src.id || t.id === editedId) continue;
    copyShape(t, reflectPart(v, src, t.mirror.axes));
  }
}

const SHAPE_KEYS: (keyof Part)[] = ['def', 'params', 'position', 'rotation', 'flip', 'material', 'layer', 'path', 'section', 'surface', 'derived', 'joint'];

function copyShape(target: Part, from: Part) {
  for (const k of SHAPE_KEYS) {
    if (from[k] === undefined) delete (target as unknown as Record<string, unknown>)[k];
    else (target as unknown as Record<string, unknown>)[k] = clone(from[k]);
  }
}

/** Make a twin independent: it stops following its source. */
export function breakSymmetry(v: Vehicle, id: string) {
  const p = v.parts.find((x) => x.id === id);
  if (!p) return;
  if (p.mirror) { delete p.mirror; return; }
  // Breaking the source: promote its first twin to lead the rest.
  const twins = v.parts.filter((x) => x.mirror?.source === id);
  if (!twins.length) return;
  const lead = twins[0];
  const leadAxes = lead.mirror!.axes;
  delete lead.mirror;
  for (const t of twins.slice(1)) t.mirror = { source: lead.id, axes: xorAxes(t.mirror!.axes, leadAxes) };
}

/** One-off copies of parts reflected across `axes`; they are not linked. */
export function mirrorCopies(v: Vehicle, ids: string[], axes: string): Part[] {
  const idMap = new Map<string, string>();
  for (const id of ids) idMap.set(id, newId());
  const out: Part[] = [];
  for (const id of ids) {
    const p = v.parts.find((x) => x.id === id);
    if (!p) continue;
    const q = reflectPart(v, p, axes);
    q.id = idMap.get(id)!;
    delete q.mirror;
    // References inside the copied set point at the copies.
    if (q.surface) q.surface.edges = p.surface!.edges.map((e) => ({ ...e, part: idMap.get(e.part) ?? e.part }));
    if (q.derived) q.derived.ribs = p.derived!.ribs.map((r) => idMap.get(r) ?? r);
    out.push(q);
  }
  v.parts.push(...out);
  return out;
}

export function isMirrorable(v: Vehicle, p: Part): boolean {
  return getDef(p.def, v).kind !== 'vehicle';
}

import { Matrix4, Quaternion, Vector3 } from 'three';
import { getDef } from './catalog';
import type { ConnectionSolver, Graph, Warning } from './connections';
import { tolerance } from './connections';
import { obbAABB, obbPenetration, type OBB } from './geometry';
import { DEG, partMatrix } from './math';
import type { Animation, JointSpec, Part, Vec3, Vehicle } from './types';

/**
 * Joints split the vehicle into rigid groups. Starting from the main body,
 * each joint's far side becomes a child group that moves with the joint, so a
 * gun on a turret turns with the ring and also elevates on its own hinge.
 */

export interface RigGroup {
  id: number;
  parts: string[];
  /** Joint halves riding in this group: [joint part id, 'base' | 'head']. */
  halves: [string, 'base' | 'head'][];
  joint?: string;
  parent?: number;
}

export interface RigJoint {
  part: string;
  parent: number;
  child: number;
  /** Which half of the joint moves relative to the main body. */
  moving: 'head' | 'base';
  locked: boolean;
}

export interface Rig {
  groups: RigGroup[];
  joints: Map<string, RigJoint>;
  groupOf: Map<string, number>;
  /** Joint ids parent-first. */
  order: string[];
}

export function jointSpec(v: Vehicle, p: Part): JointSpec | null {
  const def = getDef(p.def, v);
  if (def.kind !== 'joint') return null;
  return p.joint ?? def.joint ?? null;
}

export function dofCount(spec: JointSpec): number {
  return spec.type === 'ball' ? 3 : spec.type === 'wheel' ? 2 : 1;
}

export function buildRig(v: Vehicle, g: Graph): Rig {
  // Union-find over parts and joint halves.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const isJoint = new Set(v.parts.filter((p) => jointSpec(v, p)).map((p) => p.id));
  for (const p of v.parts) {
    if (isJoint.has(p.id)) { parent.set(`${p.id}:base`, `${p.id}:base`); parent.set(`${p.id}:head`, `${p.id}:head`); }
    else parent.set(p.id, p.id);
  }
  const nodeFor = (id: string, viaJoint?: string) => {
    if (!isJoint.has(id)) return id;
    const side = g.jointSide.get(id)?.get(viaJoint ?? '') ?? 'base';
    return `${id}:${side}`;
  };
  for (const p of v.parts) {
    for (const n of g.adj.get(p.id) ?? []) {
      if (isJoint.has(p.id) && isJoint.has(n)) {
        // Joint on joint: each attaches by its own side.
        union(nodeFor(p.id, n), nodeFor(n, p.id));
      } else if (isJoint.has(p.id)) union(nodeFor(p.id, n), n);
      else if (isJoint.has(n)) union(p.id, nodeFor(n, p.id));
      else union(p.id, n);
    }
  }
  // Collect groups.
  const byRoot = new Map<string, RigGroup>();
  const groups: RigGroup[] = [];
  const groupOfNode = new Map<string, number>();
  const nodes = [...parent.keys()];
  for (const node of nodes) {
    const r = find(node);
    let grp = byRoot.get(r);
    if (!grp) { grp = { id: groups.length, parts: [], halves: [] }; groups.push(grp); byRoot.set(r, grp); }
    groupOfNode.set(node, grp.id);
    const m = node.match(/^(.*):(base|head)$/);
    if (m && isJoint.has(m[1])) grp.halves.push([m[1], m[2] as 'base' | 'head']);
    else grp.parts.push(node);
  }
  // Root: the biggest group.
  let root = 0;
  for (const grp of groups) if (grp.parts.length > groups[root].parts.length) root = grp.id;
  const joints = new Map<string, RigJoint>();
  const order: string[] = [];
  const visited = new Set<number>([root]);
  const queue = [root];
  const pending = new Set(isJoint);
  while (queue.length) {
    const gid = queue.shift()!;
    for (const j of [...pending]) {
      const gb = groupOfNode.get(`${j}:base`)!, gh = groupOfNode.get(`${j}:head`)!;
      const bIn = gb === gid, hIn = gh === gid;
      if (!bIn && !hIn) continue;
      pending.delete(j);
      if (gb === gh) { joints.set(j, { part: j, parent: gb, child: gh, moving: 'head', locked: true }); continue; }
      const other = bIn ? gh : gb;
      if (visited.has(other)) { joints.set(j, { part: j, parent: gid, child: other, moving: bIn ? 'head' : 'base', locked: true }); continue; }
      visited.add(other);
      groups[other].joint = j;
      groups[other].parent = gid;
      joints.set(j, { part: j, parent: gid, child: other, moving: bIn ? 'head' : 'base', locked: false });
      order.push(j);
      queue.push(other);
    }
    // Detached groups (floating) hang off nothing; their joints still work locally.
    if (!queue.length) {
      const next = groups.find((x) => !visited.has(x.id) && (x.parts.length || x.halves.length));
      if (next) { visited.add(next.id); queue.push(next.id); }
    }
  }
  const groupOf = new Map<string, number>();
  for (const grp of groups) for (const id of grp.parts) groupOf.set(id, grp.id);
  return { groups, joints, groupOf, order };
}

export function clampValue(spec: JointSpec, dof: number, x: number): number {
  if (spec.type === 'wheel' && dof === 0) return x; // spin is free
  if (spec.continuous && spec.type === 'turret') {
    let a = ((x + 180) % 360 + 360) % 360 - 180;
    if (spec.min > -180 || spec.max < 180) a = Math.max(spec.min, Math.min(spec.max, a));
    return a;
  }
  return Math.max(spec.min, Math.min(spec.max, x));
}

export function jointValues(v: Vehicle, p: Part): number[] {
  const spec = jointSpec(v, p);
  if (!spec) return [];
  const n = dofCount(spec);
  const cur = v.jointValues[p.id] ?? [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(cur[i] ?? (spec.type === 'wheel' && i === 0 ? 0 : spec.rest));
  return out;
}

/** Motion of a joint's head relative to its base, in world space at rest. */
export function jointMotion(v: Vehicle, p: Part, values: number[]): Matrix4 {
  const spec = jointSpec(v, p)!;
  const m = partMatrix(p);
  const pivot = new Vector3().setFromMatrixPosition(m);
  const f = p.flip ?? [1, 1, 1];
  const det = f[0] * f[1] * f[2];
  const axis = (i: number) => new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).transformDirection(m).normalize();
  const rot = (i: number, degs: number) => new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(axis(i), degs * DEG * det));
  const about = (r: Matrix4) => new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(r).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  switch (spec.type) {
    case 'hinge': return about(rot(0, values[0]));
    case 'turret': return about(rot(1, values[0]));
    case 'ball': return about(rot(0, values[0]).multiply(rot(1, values[1])).multiply(rot(2, values[2])));
    case 'wheel': return about(rot(1, values[1] ?? 0).multiply(rot(0, values[0])));
    case 'piston': {
      const a = axis(getDef(p.def, v).shape === 'door' ? 0 : 1).multiplyScalar(values[0]);
      return new Matrix4().makeTranslation(a.x, a.y, a.z);
    }
  }
}

/** World matrix of every rigid group for the given joint values (rest = identity). */
export function poseGroups(v: Vehicle, rig: Rig, values: Record<string, number[]> = v.jointValues): Matrix4[] {
  const out = rig.groups.map(() => new Matrix4());
  for (const jid of rig.order) {
    const j = rig.joints.get(jid)!;
    if (j.locked) continue;
    const p = v.parts.find((x) => x.id === jid);
    if (!p) continue;
    const vals = values[jid] ?? jointValues(v, p);
    let mm = jointMotion(v, p, vals.length ? vals : jointValues(v, p));
    if (j.moving === 'base') mm = mm.clone().invert();
    out[j.child] = out[j.parent].clone().multiply(mm);
  }
  return out;
}

// ── Controls, aim and animation ─────────────────────────────────────────────

export function applyControl(v: Vehicle, controlId: string, value: number) {
  const c = v.controls.find((x) => x.id === controlId);
  if (!c) return;
  c.value = Math.max(c.min, Math.min(c.max, value));
  for (const l of c.links) {
    const p = v.parts.find((x) => x.id === l.joint);
    const spec = p && jointSpec(v, p);
    if (!p || !spec) continue;
    const vals = jointValues(v, p);
    const d = l.dof ?? 0;
    vals[d] = clampValue(spec, d, l.offset + l.ratio * c.value);
    v.jointValues[p.id] = vals;
  }
}

/**
 * Turn every joint linked to an aim control toward a world point, parent
 * joints first, each within its limits. Rings and hinges aim their local +Z.
 */
export function aimAt(v: Vehicle, rig: Rig, target: Vec3, controlId?: string): string[] {
  const linked = new Set<string>();
  for (const c of v.controls) if (c.aim && (!controlId || c.id === controlId)) for (const l of c.links) linked.add(l.joint);
  const moved: string[] = [];
  const T = new Vector3(...target);
  for (const jid of rig.order) {
    if (!linked.has(jid)) continue;
    const j = rig.joints.get(jid)!;
    const p = v.parts.find((x) => x.id === jid)!;
    const spec = jointSpec(v, p)!;
    if (spec.type !== 'turret' && spec.type !== 'hinge') continue;
    // Measure with this joint at zero so the result is an absolute angle.
    const saved = v.jointValues[jid];
    v.jointValues[jid] = [0];
    const groups = poseGroups(v, rig);
    if (saved) v.jointValues[jid] = saved; else delete v.jointValues[jid];
    const parentM = groups[j.parent];
    const m = parentM.clone().multiply(partMatrix(p));
    const pivot = new Vector3().setFromMatrixPosition(m);
    const ai = spec.type === 'turret' ? 1 : 0;
    const axis = new Vector3(ai === 0 ? 1 : 0, ai === 1 ? 1 : 0, 0).transformDirection(m).normalize();
    // Aim the longest beam riding on this joint (the barrel); fall back to the joint's +Z.
    let fwd = new Vector3(0, 0, 1).transformDirection(m).normalize();
    let longest = 0;
    for (const gid of descendants(rig, j.child)) for (const id of rig.groups[gid].parts) {
      const q = v.parts.find((x) => x.id === id);
      const pts = q?.path?.points;
      if (!pts || pts.length < 2) continue;
      const a = new Vector3(...pts[0]).applyMatrix4(groups[gid]), b = new Vector3(...pts[pts.length - 1]).applyMatrix4(groups[gid]);
      const L = a.distanceTo(b);
      if (L <= longest) continue;
      longest = L;
      fwd = (a.distanceTo(pivot) < b.distanceTo(pivot) ? b.sub(a) : a.sub(b)).normalize();
    }
    const to = T.clone().sub(pivot);
    const proj = (x: Vector3) => x.clone().sub(axis.clone().multiplyScalar(x.dot(axis)));
    const f = proj(fwd), t = proj(to);
    if (f.lengthSq() < 1e-9 || t.lengthSq() < 1e-9) continue;
    let ang = Math.atan2(f.clone().cross(t).dot(axis), f.dot(t)) / DEG;
    const fl = p.flip ?? [1, 1, 1];
    ang *= fl[0] * fl[1] * fl[2];
    if (j.moving === 'base') ang = -ang;
    v.jointValues[jid] = [clampValue(spec, 0, ang)];
    moved.push(jid);
  }
  return moved;
}

function ease(t: number) {
  return t * t * (3 - 2 * t);
}

/** Joint values at a time in an animation, blending between its poses. */
export function sampleAnimation(v: Vehicle, anim: Animation, time: number): Record<string, number[]> | null {
  const keys = anim.keys.filter((k) => v.poses.some((p) => p.id === k.pose)).sort((a, b) => a.time - b.time);
  if (!keys.length) return null;
  let t = time;
  if (anim.loop && anim.duration > 0) t = ((t % anim.duration) + anim.duration) % anim.duration;
  const poseOf = (id: string) => v.poses.find((p) => p.id === id)!.values;
  let a = keys[0], b = keys[0], f = 0;
  if (t <= keys[0].time) {
    if (anim.loop && keys.length > 1) {
      // Wrap from the last key back to the first.
      a = keys[keys.length - 1]; b = keys[0];
      const span = anim.duration - a.time + b.time;
      f = span > 0 ? (t + anim.duration - a.time) / span : 0;
    }
  } else if (t >= keys[keys.length - 1].time) {
    a = keys[keys.length - 1]; b = anim.loop ? keys[0] : a;
    const span = anim.duration - a.time + (anim.loop ? b.time : 0);
    f = anim.loop && span > 0 ? (t - a.time) / span : 0;
  } else {
    for (let i = 0; i + 1 < keys.length; i++) if (t >= keys[i].time && t <= keys[i + 1].time) {
      a = keys[i]; b = keys[i + 1];
      f = (t - a.time) / Math.max(1e-9, b.time - a.time);
      break;
    }
  }
  f = Math.max(0, Math.min(1, f));
  if (anim.smooth) f = ease(f);
  const pa = poseOf(a.pose), pb = poseOf(b.pose);
  const out: Record<string, number[]> = {};
  for (const id of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const p = v.parts.find((x) => x.id === id);
    if (!p) continue;
    const base = jointValues(v, p);
    const x = pa[id] ?? base, y = pb[id] ?? base;
    out[id] = x.map((q, i) => q + ((y[i] ?? q) - q) * f);
  }
  return out;
}

// ── Motion checks ───────────────────────────────────────────────────────────

function moveOBB(o: OBB, m: Matrix4): OBB {
  const c = new Vector3(...o.c).applyMatrix4(m);
  const ax = o.ax.map((a) => { const x = new Vector3(...a).transformDirection(m); return [x.x, x.y, x.z] as Vec3; }) as [Vec3, Vec3, Vec3];
  return { c: [c.x, c.y, c.z], ax, h: o.h };
}

/** Everything carried by a group and all groups below it. */
export function descendants(rig: Rig, gid: number): Set<number> {
  const out = new Set([gid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of rig.groups) if (g.parent !== undefined && out.has(g.parent) && !out.has(g.id)) { out.add(g.id); grew = true; }
  }
  return out;
}

/**
 * Parts in different rigid groups that pass through each other in a pose,
 * ignoring pairs that already touch at rest (they're attached).
 */
export function poseCollisions(v: Vehicle, rig: Rig, g: Graph, solver: ConnectionSolver, values: Record<string, number[]> = v.jointValues): [string, string][] {
  const mats = poseGroups(v, rig, values);
  const tol = tolerance(v) * 2;
  const items: { id: string; gid: number; proxies: OBB[]; box: { min: Vec3; max: Vec3 } }[] = [];
  for (const p of v.parts) {
    const c = solver.proxiesOf(v, p);
    if (!c.proxies.length) continue;
    const isJ = !!jointSpec(v, p);
    // A joint's halves ride in two groups; use the moving half's group for its head boxes.
    for (const half of isJ ? (['base', 'head'] as const) : ([undefined] as const)) {
      const gid = half ? rig.groups.findIndex((gr) => gr.halves.some(([j, h]) => j === p.id && h === half)) : rig.groupOf.get(p.id);
      if (gid === undefined || gid < 0) continue;
      const m = mats[gid];
      const prox = c.proxies.filter((x) => !half || x.half === half).map((x) => moveOBB(x.obb, m));
      if (!prox.length) continue;
      const boxes = prox.map(obbAABB);
      const box = { min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))) as Vec3, max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))) as Vec3 };
      items.push({ id: p.id, gid, proxies: prox, box });
    }
  }
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.gid === b.gid || a.id === b.id) continue;
    if (g.adj.get(a.id)?.has(b.id)) continue;
    if (a.box.min[0] > b.box.max[0] + tol || b.box.min[0] > a.box.max[0] + tol || a.box.min[1] > b.box.max[1] + tol || b.box.min[1] > a.box.max[1] + tol || a.box.min[2] > b.box.max[2] + tol || b.box.min[2] > a.box.max[2] + tol) continue;
    let hit = false;
    for (const x of a.proxies) { for (const y of b.proxies) if (obbPenetration(x, y) > tol) { hit = true; break; } if (hit) break; }
    if (!hit) continue;
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([a.id, b.id]);
  }
  return out;
}

/** Sweep every joint through its range and report what it would hit. */
export function motionWarnings(v: Vehicle, rig: Rig, g: Graph, solver: ConnectionSolver, steps = 8): Warning[] {
  const out: Warning[] = [];
  const name = (id: string) => { const p = v.parts.find((x) => x.id === id); return p ? p.name || getDef(p.def, v).name : id; };
  const rest = poseCollisions(v, rig, g, solver);
  const restKeys = new Set(rest.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (const [jid, j] of rig.joints) {
    const p = v.parts.find((x) => x.id === jid);
    if (!p) continue;
    if (j.locked) {
      out.push({ kind: 'locked', message: `${name(jid)} can't move: both of its sides are joined to the same structure.`, parts: [jid] });
      continue;
    }
    const spec = jointSpec(v, p)!;
    if (spec.type === 'wheel') continue;
    const hits = new Map<string, number>();
    const dofs = dofCount(spec);
    for (let d = 0; d < dofs; d++) for (let s = 0; s <= steps; s++) {
      const x = spec.min + ((spec.max - spec.min) * s) / steps;
      const vals = { ...v.jointValues };
      const cur = jointValues(v, p).slice();
      cur[d] = x;
      vals[jid] = cur;
      const moving = descendants(rig, j.child);
      for (const [a, b] of poseCollisions(v, rig, g, solver, vals)) {
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (restKeys.has(k)) continue;
        const ga = rig.groupOf.get(a), gb = rig.groupOf.get(b);
        if (!(ga !== undefined && moving.has(ga)) && !(gb !== undefined && moving.has(gb)) && a !== jid && b !== jid) continue;
        if (!hits.has(k)) hits.set(k, x);
      }
    }
    for (const [k, x] of hits) {
      const [a, b] = k.split('|');
      const unit = spec.type === 'piston' ? ' m' : '°';
      out.push({ kind: 'motion', message: `Moving ${name(jid)} to ${+x.toFixed(2)}${unit}: ${name(a)} hits ${name(b)}.`, parts: [jid, a, b] });
    }
  }
  for (const [a, b] of rest) out.push({ kind: 'motion', message: `In this pose ${name(a)} passes through ${name(b)}.`, parts: [a, b] });
  return out;
}

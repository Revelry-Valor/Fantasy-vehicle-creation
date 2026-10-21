import type { Matrix4 } from 'three';
import { getDef } from './catalog';
import { frames, paramAtFraction, pointAt, samplePath, segmentCount, type PathSample } from './curves';
import { add, applyDir, applyM, cross, dist, dot, len, lerp, norm, partMatrix, scale, sub } from './math';
import type { Part, Section, Vec3, Vehicle } from './types';

export type P2 = [number, number];

/** An oriented box in world space. */
export interface OBB { c: Vec3; ax: [Vec3, Vec3, Vec3]; h: Vec3 }

/** A collision proxy; joints tag which half moves. */
export interface Proxy { obb: OBB; half?: 'base' | 'head' }

// ── Beam sections ───────────────────────────────────────────────────────────

/** Section outline in the beam's (normal, binormal) plane, counter-clockwise. */
export function sectionProfile(section: Section, w: number, h: number): P2[] {
  const hw = w / 2, hh = h / 2;
  switch (section) {
    case 'round': {
      const n = 20;
      const out: P2[] = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([Math.cos(a) * hw, Math.sin(a) * hw]); }
      return out;
    }
    case 'ibeam': {
      const tf = h * 0.14, tw = Math.max(w * 0.14, 0.004);
      return [[-hw, -hh], [hw, -hh], [hw, -hh + tf], [tw / 2, -hh + tf], [tw / 2, hh - tf], [hw, hh - tf], [hw, hh], [-hw, hh], [-hw, hh - tf], [-tw / 2, hh - tf], [-tw / 2, -hh + tf], [-hw, -hh + tf]];
    }
    case 'channel': {
      const tf = h * 0.16, tw = Math.max(w * 0.18, 0.004);
      return [[-hw, -hh], [hw, -hh], [hw, -hh + tf], [-hw + tw, -hh + tf], [-hw + tw, hh - tf], [hw, hh - tf], [hw, hh], [-hw, hh]];
    }
    default:
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  }
}

export function polyArea(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return Math.abs(a) / 2;
}

export function beamSize(p: Part): { w: number; h: number; section: Section } {
  const def = getDef(p.def);
  const section = p.section ?? def.section ?? 'square';
  const w = p.params.w ?? 0.2;
  const h = section === 'round' ? w : (p.params.h ?? w);
  return { w, h, section };
}

// ── Shape extents (local) ───────────────────────────────────────────────────

/** Local bounding box centre and half sizes of a placed shape. */
export function localBox(p: Part): { c: Vec3; h: Vec3 } {
  const def = getDef(p.def);
  const P = p.params;
  switch (def.shape) {
    case 'plate': return { c: [0, 0, 0], h: [P.w / 2, P.t / 2, P.l / 2] };
    case 'wedge': return { c: [0, 0, 0], h: [P.w / 2, P.h / 2, P.l / 2] };
    case 'cylinder': return { c: [0, 0, 0], h: [P.r, P.r, P.l / 2] };
    case 'cone': { const r = Math.max(P.r1, P.r2); return { c: [0, 0, 0], h: [r, r, P.l / 2] }; }
    case 'hullPanel': {
      const a = Math.min(359, P.a) * (Math.PI / 360);
      const ro = P.r + P.t / 2, ri = Math.max(0, P.r - P.t / 2);
      const x = a >= Math.PI / 2 ? ro : ro * Math.sin(a);
      const y0 = a >= Math.PI / 2 ? ro * Math.cos(a) : ri * Math.cos(a);
      return { c: [0, (ro + y0) / 2, 0], h: [x, (ro - y0) / 2, P.l / 2] };
    }
    case 'hinge': return { c: [0, 0, 0], h: [P.s / 2, P.s * 0.3, P.s * 0.2] };
    case 'turret': return { c: [0, 0, 0], h: [P.r, P.h / 2, P.r] };
    case 'ball': return { c: [0, 0, 0], h: [P.r * 1.1, P.r * 1.4, P.r * 1.1] };
    case 'piston': return { c: [0, 0, 0], h: [P.r, P.l / 2, P.r] };
    case 'wheel': return { c: [0, 0, 0], h: [P.w / 2, P.r, P.r] };
    case 'door': return { c: [0, 0, 0], h: [P.w / 2, P.h / 2, P.t / 2] };
    case 'thruster': return { c: [0, 0, 0], h: [P.r, P.r, P.l / 2] };
    case 'light': return { c: [0, 0, 0], h: [P.r, P.r, P.r] };
    case 'canopy': return { c: [0, 0, 0], h: [P.w / 2, P.h / 2, P.l / 2] };
    case 'greeble': return { c: [0, 0, 0], h: [P.w / 2, P.h / 2, P.l / 2] };
    case 'bolt': return { c: [0, 0, 0], h: [P.r, P.r * 0.5, P.r] };
    case 'figure': return { c: [0, P.h / 2, 0], h: [P.h * 0.14, P.h / 2, P.h * 0.08] };
    default: return { c: [0, 0, 0], h: [0.5, 0.5, 0.5] };
  }
}

function obbFrom(m: Matrix4, c: Vec3, h: Vec3): OBB {
  const ax = [applyDir(m, [1, 0, 0]), applyDir(m, [0, 1, 0]), applyDir(m, [0, 0, 1])] as [Vec3, Vec3, Vec3];
  return { c: applyM(m, c), ax, h: [...h] as Vec3 };
}

/** Local boxes for the two halves of a joint (base stays, head moves). */
function jointHalves(p: Part): { base: { c: Vec3; h: Vec3 }; head: { c: Vec3; h: Vec3 } } | null {
  const def = getDef(p.def);
  const P = p.params;
  switch (def.shape) {
    case 'hinge': return { base: { c: [0, -P.s * 0.15, 0], h: [P.s / 2, P.s * 0.15, P.s * 0.2] }, head: { c: [0, P.s * 0.15, 0], h: [P.s * 0.45, P.s * 0.15, P.s * 0.2] } };
    case 'turret': return { base: { c: [0, -P.h / 4, 0], h: [P.r, P.h / 4, P.r] }, head: { c: [0, P.h / 4, 0], h: [P.r * 0.94, P.h / 4, P.r * 0.94] } };
    case 'ball': return { base: { c: [0, -P.r * 0.85, 0], h: [P.r * 1.1, P.r * 0.55, P.r * 1.1] }, head: { c: [0, P.r * 0.4, 0], h: [P.r, P.r, P.r] } };
    case 'piston': return { base: { c: [0, -P.l * 0.2, 0], h: [P.r, P.l * 0.3, P.r] }, head: { c: [0, P.l * 0.15, 0], h: [P.r * 0.55, P.l * 0.35, P.r * 0.55] } };
    case 'wheel': return { base: { c: [0, 0, 0], h: [P.w * 0.1, P.r * 0.15, P.r * 0.15] }, head: { c: [0, 0, 0], h: [P.w / 2, P.r, P.r] } };
    case 'door': return { base: { c: [0, 0, 0], h: [P.w * 0.02, P.h / 2, P.t / 2] }, head: { c: [0, 0, 0], h: [P.w / 2, P.h / 2, P.t / 2] } };
    default: return null;
  }
}

/** Joints whose moving half is the part itself (nothing rides on a wheel or a door by default). */
export function jointMovesSelf(p: Part): boolean {
  const s = getDef(p.def).shape;
  return s === 'wheel' || s === 'door';
}

// ── Proxies ─────────────────────────────────────────────────────────────────

export function beamSamples(p: Part, per = 12): PathSample[] {
  return p.path ? samplePath(p.path, per) : [];
}

/**
 * World-space boxes approximating a part, for connection and overlap tests.
 * Beams get one box per straight run or curve piece; skins have none (they
 * follow their beams by construction).
 */
export function partProxies(p: Part, v?: Vehicle): Proxy[] {
  const def = getDef(p.def, v);
  if (def.kind === 'skin') return v ? skinProxies(v, p) : [];
  if (def.kind === 'beam') {
    if (!p.path || p.path.points.length < 2) return [];
    const { w, h } = beamSize(p);
    const s = beamSamples(p, 8);
    const fr = frames(s);
    const out: Proxy[] = [];
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1], b = fr[i];
      const d = sub(b.p, a.p);
      const L = len(d);
      if (L < 1e-6) continue;
      const t = scale(d, 1 / L);
      let n = norm(sub(a.n, scale(t, dot(a.n, t))));
      if (len(n) < 0.5) n = norm(cross(t, [0, 1, 0]));
      const bb = cross(t, n);
      out.push({ obb: { c: lerp(a.p, b.p, 0.5), ax: [n, bb, t], h: [h / 2, w / 2, L / 2] } });
    }
    return out;
  }
  const m = partMatrix(p);
  if (def.kind === 'joint') {
    const j = jointHalves(p);
    if (j) return [{ obb: obbFrom(m, j.base.c, j.base.h), half: 'base' }, { obb: obbFrom(m, j.head.c, j.head.h), half: 'head' }];
  }
  if (def.shape === 'hullPanel') {
    // A curved panel is a run of small flat boxes around the arc.
    const P = p.params;
    const a = Math.min(359, P.a) * (Math.PI / 180);
    const k = Math.max(2, Math.ceil(P.a / 15));
    const out: Proxy[] = [];
    for (let i = 0; i < k; i++) {
      const a0 = -a / 2 + (a * i) / k, a1 = a0 + a / k, am = (a0 + a1) / 2;
      const chord = 2 * P.r * Math.sin((a1 - a0) / 2);
      const c: Vec3 = [P.r * Math.sin(am), P.r * Math.cos(am), 0];
      const ax: [Vec3, Vec3, Vec3] = [[Math.cos(am), -Math.sin(am), 0], [Math.sin(am), Math.cos(am), 0], [0, 0, 1]];
      out.push({ obb: { c: applyM(m, c), ax: ax.map((x) => applyDir(m, x)) as [Vec3, Vec3, Vec3], h: [chord / 2, P.t / 2, P.l / 2] } });
    }
    return out;
  }
  const b = localBox(p);
  return [{ obb: obbFrom(m, b.c, b.h) }];
}

export function obbCorners(o: OBB): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(add(add(add(o.c, scale(o.ax[0], sx * o.h[0])), scale(o.ax[1], sy * o.h[1])), scale(o.ax[2], sz * o.h[2])));
  }
  return out;
}

export interface AABB { min: Vec3; max: Vec3 }

export function obbAABB(o: OBB): AABB {
  const e: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) e[i] = Math.abs(o.ax[0][i]) * o.h[0] + Math.abs(o.ax[1][i]) * o.h[1] + Math.abs(o.ax[2][i]) * o.h[2];
  return { min: sub(o.c, e), max: add(o.c, e) };
}

export function unionAABB(list: AABB[]): AABB | null {
  if (!list.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  return { min, max };
}

export function partAABB(p: Part, v?: Vehicle): AABB | null {
  const def = getDef(p.def, v);
  if (def.kind === 'skin' && v) {
    const s = skinPatch(v, p);
    if (!s) return null;
    const pts = [...s.outer.flat(), ...s.inner.flat()];
    return unionAABB(pts.map((q) => ({ min: q, max: q })));
  }
  return unionAABB(partProxies(p, v).map((x) => obbAABB(x.obb)));
}

/**
 * Separating-axis test between two boxes. Returns how far they overlap along
 * the axis of least overlap (negative = the gap between them).
 */
export function obbPenetration(a: OBB, b: OBB): number {
  const axes: Vec3[] = [...a.ax, ...b.ax];
  for (const x of a.ax) for (const y of b.ax) {
    const c = cross(x, y);
    if (len(c) > 1e-6) axes.push(norm(c));
  }
  const d = sub(b.c, a.c);
  let best = Infinity;
  for (const L of axes) {
    const ra = Math.abs(dot(a.ax[0], L)) * a.h[0] + Math.abs(dot(a.ax[1], L)) * a.h[1] + Math.abs(dot(a.ax[2], L)) * a.h[2];
    const rb = Math.abs(dot(b.ax[0], L)) * b.h[0] + Math.abs(dot(b.ax[1], L)) * b.h[1] + Math.abs(dot(b.ax[2], L)) * b.h[2];
    const o = ra + rb - Math.abs(dot(d, L));
    if (o < best) best = o;
    if (best < -1e3) break;
  }
  return best;
}

export function pointInOBB(p: Vec3, o: OBB, tol = 0): boolean {
  const d = sub(p, o.c);
  for (let i = 0; i < 3; i++) if (Math.abs(dot(d, o.ax[i])) > o.h[i] + tol) return false;
  return true;
}

// ── Snap points ─────────────────────────────────────────────────────────────

/**
 * Points other parts connect to and snap onto: a beam's grid points (every
 * sub-grid step along it), a shape's centre, face centres, edge midpoints and
 * corners.
 */
export function snapPoints(p: Part, v: Vehicle, opts: { along?: boolean } = {}): Vec3[] {
  const def = getDef(p.def, v);
  if (def.kind === 'beam') {
    if (!p.path) return [];
    const pts = [...p.path.points];
    if (opts.along !== false && p.path.points.length > 1) {
      const step = v.grid.minor;
      const n = segmentCount(p.path);
      for (let i = 0; i < n; i++) {
        const a = pointAt(p.path, i), b = pointAt(p.path, i + 1);
        const k = Math.round(dist(a, b) / step);
        const onGrid = (q: Vec3) => q.every((x) => Math.abs(x / step - Math.round(x / step)) < 1e-6);
        for (let j = 1; j < k; j++) {
          const q = pointAt(p.path, i + j / k);
          if (onGrid(q)) pts.push(q);
        }
      }
    }
    return pts;
  }
  if (def.kind === 'skin') {
    const s = skinPatch(v, p);
    if (!s) return [];
    const g = s.outer, r = g.length - 1, c = g[0].length - 1;
    return [g[0][0], g[0][c], g[r][0], g[r][c]];
  }
  const m = partMatrix(p);
  const b = localBox(p);
  const out: Vec3[] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    out.push(applyM(m, [b.c[0] + x * b.h[0], b.c[1] + y * b.h[1], b.c[2] + z * b.h[2]]));
  }
  return out;
}

// ── Mass ────────────────────────────────────────────────────────────────────

/** Solid volume in m³, for the mass readout. */
export function partVolume(p: Part, v: Vehicle): number {
  const def = getDef(p.def, v);
  const P = p.params;
  if (def.kind === 'beam') {
    if (!p.path) return 0;
    const { w, h, section } = beamSize(p);
    const s = samplePath(p.path, 16);
    let L = 0;
    for (let i = 1; i < s.length; i++) L += dist(s[i].p, s[i - 1].p);
    let area = polyArea(sectionProfile(section, w, h));
    if (section === 'square') area -= Math.max(0, (w - 0.2 * Math.min(w, h)) * (h - 0.2 * Math.min(w, h))); // hollow box
    return area * L;
  }
  if (def.kind === 'skin') {
    const s = skinPatch(v, p);
    return s ? s.area * (p.surface?.thickness ?? P.t ?? 0.04) : 0;
  }
  switch (def.shape) {
    case 'plate': return P.w * P.l * P.t;
    case 'wedge': return (P.w * P.h * P.l) / 2;
    case 'cylinder': return Math.PI * P.r * P.r * P.l;
    case 'cone': return (Math.PI * P.l * (P.r1 * P.r1 + P.r1 * P.r2 + P.r2 * P.r2)) / 3;
    case 'hullPanel': return Math.min(359, P.a) * (Math.PI / 180) * P.r * P.t * P.l;
    case 'figure': return 0.075;
    default: {
      const b = localBox(p);
      return 8 * b.h[0] * b.h[1] * b.h[2] * 0.45;
    }
  }
}

// ── Conforming plates ───────────────────────────────────────────────────────

export interface SkinPatch {
  /** Rows (v) × columns (u) of points on the outer and inner faces. */
  outer: Vec3[][];
  inner: Vec3[][];
  area: number;
}

function resample(points: Vec3[], n: number): Vec3[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i], points[i - 1]));
  const L = cum[cum.length - 1];
  const out: Vec3[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n;
    while (j < points.length - 1 && cum[j] < s) j++;
    const f = (s - cum[j - 1]) / Math.max(1e-12, cum[j] - cum[j - 1]);
    out.push(lerp(points[j - 1], points[j], Math.max(0, Math.min(1, f))));
  }
  return out;
}

/** The edges of a skin as point lists, chained head to tail into a loop. */
export function skinLoop(v: Vehicle, p: Part): { curves: Vec3[][]; curved: boolean[]; offset: number } | null {
  const s = p.surface;
  if (!s || s.edges.length < 3 || s.edges.length > 4) return null;
  const raw: Vec3[][] = [];
  let offset = 0;
  for (const e of s.edges) {
    const b = v.parts.find((x) => x.id === e.part);
    if (!b?.path) return null;
    const t0 = e.frac ? paramAtFraction(b.path, e.t0) : e.t0, t1 = e.frac ? paramAtFraction(b.path, e.t1) : e.t1;
    const pts = samplePath(b.path, 16, t0, t1).map((x) => x.p);
    if (pts.length < 2) return null;
    raw.push(pts);
    const { w, h } = beamSize(b);
    offset = Math.max(offset, Math.max(w, h) / 2);
  }
  const tol = Math.max(1e-3, v.grid.minor * 0.3);
  const end = (c: Vec3[]) => c[c.length - 1];
  for (const flipFirst of [false, true]) {
    const left = raw.slice(1).map((c) => c.slice());
    const chain: Vec3[][] = [flipFirst ? [...raw[0]].reverse() : raw[0].slice()];
    let ok = true;
    while (left.length) {
      const e = end(chain[chain.length - 1]);
      let best = -1, rev = false, bd = Infinity;
      left.forEach((c, j) => {
        const a = dist(c[0], e), b = dist(end(c), e);
        if (a < bd) { bd = a; best = j; rev = false; }
        if (b < bd) { bd = b; best = j; rev = true; }
      });
      if (bd > tol) { ok = false; break; }
      const [c] = left.splice(best, 1);
      chain.push(rev ? c.reverse() : c);
    }
    if (ok && dist(end(chain[chain.length - 1]), chain[0][0]) <= tol) {
      return { curves: chain, curved: chain.map((c) => c.length > 2), offset };
    }
  }
  return null;
}

/** Centre of the vehicle's beam frame: skins face away from it unless flipped. */
function frameCentre(v: Vehicle): Vec3 {
  let c: Vec3 = [0, 0, 0], n = 0;
  for (const q of v.parts) for (const x of q.path?.points ?? []) { c = add(c, x); n++; }
  return n ? scale(c, 1 / n) : [0, 0, 0];
}

/** A Coons patch through the skin's edges, thickened along its normal. */
export function skinPatch(v: Vehicle, p: Part): SkinPatch | null {
  const loop = skinLoop(v, p);
  if (!loop) return null;
  const { curves, curved, offset } = loop;
  const tri = curves.length === 3;
  const nu = curved[0] || curved[2] ? 16 : tri ? 8 : 1;
  const nv = curved[1] || (tri ? curved[2] : curved[3]) ? 16 : tri ? 8 : 1;
  const bottom = resample(curves[0], nu);
  const right = resample(curves[1], nv);
  const top = tri ? new Array(nu + 1).fill(curves[1][curves[1].length - 1]) as Vec3[] : resample([...curves[2]].reverse(), nu);
  const left = resample([...(tri ? curves[2] : curves[3])].reverse(), nv);
  const P00 = bottom[0], P10 = bottom[nu], P01 = top[0], P11 = top[nu];
  const mid: Vec3[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: Vec3[] = [];
    const vv = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const ruled = add(add(scale(bottom[i], 1 - vv), scale(top[i], vv)), add(scale(left[j], 1 - u), scale(right[j], u)));
      const bil = add(add(scale(P00, (1 - u) * (1 - vv)), scale(P10, u * (1 - vv))), add(scale(P01, (1 - u) * vv), scale(P11, u * vv)));
      row.push(sub(ruled, bil));
    }
    mid.push(row);
  }
  const t = p.surface!.thickness;
  // Face away from the frame's centre; "side" flips that.
  const cj = Math.floor(nv / 2), ci = Math.floor(nu / 2);
  const cdu = sub(mid[cj][Math.min(nu, ci + 1)], mid[cj][Math.max(0, ci - 1)]);
  const cdv = sub(mid[Math.min(nv, cj + 1)][ci], mid[Math.max(0, cj - 1)][ci]);
  const outward = dot(cross(cdu, cdv), sub(mid[cj][ci], frameCentre(v))) >= 0 ? 1 : -1;
  const side = p.surface!.side * outward;
  // Normals from neighbouring points; flip so they point away from the frame's centre if side is +1.
  const normalAt = (j: number, i: number): Vec3 => {
    const du = sub(mid[j][Math.min(nu, i + 1)], mid[j][Math.max(0, i - 1)]);
    const dv = sub(mid[Math.min(nv, j + 1)][i], mid[Math.max(0, j - 1)][i]);
    let n = cross(du, dv);
    if (len(n) < 1e-12) {
      // Degenerate corner of a three-sided patch: borrow a neighbour's normal.
      const jj = j > 0 ? j - 1 : j + 1;
      const du2 = sub(mid[jj][Math.min(nu, i + 1)], mid[jj][Math.max(0, i - 1)]);
      const dv2 = sub(mid[Math.min(nv, jj + 1)][i], mid[Math.max(0, jj - 1)][i]);
      n = cross(du2, dv2);
    }
    return norm(n);
  };
  const outer: Vec3[][] = [], inner: Vec3[][] = [];
  let area = 0;
  for (let j = 0; j <= nv; j++) {
    const ro: Vec3[] = [], ri: Vec3[] = [];
    for (let i = 0; i <= nu; i++) {
      const n = scale(normalAt(j, i), side);
      ri.push(add(mid[j][i], scale(n, offset)));
      ro.push(add(mid[j][i], scale(n, offset + t)));
    }
    outer.push(ro);
    inner.push(ri);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = mid[j][i], b = mid[j][i + 1], c = mid[j + 1][i + 1], d = mid[j + 1][i];
    area += len(cross(sub(b, a), sub(d, a))) / 2 + len(cross(sub(b, c), sub(d, c))) / 2;
  }
  return { outer, inner, area };
}

/** A skin as a few thin boxes, one per patch cell (coarsened). */
function skinProxies(v: Vehicle, p: Part): Proxy[] {
  const s = skinPatch(v, p);
  if (!s) return [];
  const rows = s.outer.length - 1, cols = s.outer[0].length - 1;
  const sr = Math.max(1, Math.ceil(rows / 4)), sc = Math.max(1, Math.ceil(cols / 4));
  const out: Proxy[] = [];
  for (let j = 0; j < rows; j += sr) for (let i = 0; i < cols; i += sc) {
    const j1 = Math.min(rows, j + sr), i1 = Math.min(cols, i + sc);
    const pts = [s.outer[j][i], s.outer[j][i1], s.outer[j1][i1], s.outer[j1][i], s.inner[j][i], s.inner[j][i1], s.inner[j1][i1], s.inner[j1][i]];
    const c = scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / 8);
    let u = sub(add(s.outer[j][i1], s.outer[j1][i1]), add(s.outer[j][i], s.outer[j1][i]));
    let w = sub(add(s.outer[j1][i], s.outer[j1][i1]), add(s.outer[j][i], s.outer[j][i1]));
    if (len(u) < 1e-9) u = sub(s.outer[j1][i1], s.outer[j1][i]);
    if (len(w) < 1e-9) w = sub(s.outer[j1][i], s.outer[j][i]);
    u = norm(u);
    let n = norm(cross(u, w));
    if (len(n) < 0.5) n = norm(sub(s.outer[j][i], s.inner[j][i]));
    const b = cross(n, u);
    const ax: [Vec3, Vec3, Vec3] = [u, n, b];
    const hh: Vec3 = [0, 0, 0];
    for (const q of pts) for (let k = 0; k < 3; k++) hh[k] = Math.max(hh[k], Math.abs(dot(sub(q, c), ax[k])));
    out.push({ obb: { c, ax, h: hh } });
  }
  return out;
}

/** Parameter on a rib where a stringer at fraction s crosses it. */
export function ribParam(rib: Part, s: number): number {
  return rib.path ? paramAtFraction(rib.path, s) : 0;
}

export { samplePath };

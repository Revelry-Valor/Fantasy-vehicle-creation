import { add, cross, dot, len, lerp, norm, scale, sub } from './math';
import type { CurvePath, Vec3 } from './types';

/**
 * Beam paths. Every segment is a cubic Bézier between two grid points. Its
 * handles are stored when the beam has been bent by hand; otherwise they come
 * from the neighbouring points (a smooth Catmull-Rom flow) or make it straight.
 */

export function segmentCount(path: CurvePath): number {
  const n = path.points.length;
  return path.closed ? n : Math.max(0, n - 1);
}

function pt(path: CurvePath, i: number): Vec3 {
  const n = path.points.length;
  if (path.closed) return path.points[((i % n) + n) % n];
  return path.points[Math.max(0, Math.min(n - 1, i))];
}

/** The four Bézier control points of segment i. */
export function segmentControls(path: CurvePath, i: number): [Vec3, Vec3, Vec3, Vec3] {
  const p0 = pt(path, i), p3 = pt(path, i + 1);
  const h = path.handles?.[i];
  if (h && h.length === 2) return [p0, h[0], h[1], p3];
  const n = path.points.length;
  if (path.smooth && n > 2) {
    // Catmull-Rom tangents; open ends reflect the neighbouring point so the curve leaves straight.
    const prev = path.closed || i > 0 ? pt(path, i - 1) : sub(scale(p0, 2), p3);
    const next = path.closed || i + 2 < n ? pt(path, i + 2) : sub(scale(p3, 2), p0);
    const c1 = add(p0, scale(sub(p3, prev), 1 / 6));
    const c2 = sub(p3, scale(sub(next, p0), 1 / 6));
    return [p0, c1, c2, p3];
  }
  return [p0, lerp(p0, p3, 1 / 3), lerp(p0, p3, 2 / 3), p3];
}

export function isStraight(path: CurvePath, i: number): boolean {
  const [a, b, c, d] = segmentControls(path, i);
  const ad = sub(d, a);
  const L = len(ad);
  if (L < 1e-9) return true;
  const u = scale(ad, 1 / L);
  const off = (p: Vec3) => len(sub(sub(p, a), scale(u, dot(sub(p, a), u))));
  return off(b) < 1e-5 * Math.max(1, L) && off(c) < 1e-5 * Math.max(1, L);
}

function bez(c: [Vec3, Vec3, Vec3, Vec3], u: number): Vec3 {
  const v = 1 - u;
  const a = v * v * v, b = 3 * v * v * u, d = 3 * v * u * u, e = u * u * u;
  return [
    a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
    a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
    a * c[0][2] + b * c[1][2] + d * c[2][2] + e * c[3][2],
  ];
}

function bezTangent(c: [Vec3, Vec3, Vec3, Vec3], u: number): Vec3 {
  const v = 1 - u;
  const t = add(add(scale(sub(c[1], c[0]), 3 * v * v), scale(sub(c[2], c[1]), 6 * v * u)), scale(sub(c[3], c[2]), 3 * u * u));
  if (len(t) < 1e-9) return norm(sub(c[3], c[0]));
  return norm(t);
}

/** Point at path parameter t (0…segmentCount). */
export function pointAt(path: CurvePath, t: number): Vec3 {
  const n = segmentCount(path);
  if (n === 0) return path.points[0] ?? [0, 0, 0];
  const tt = Math.max(0, Math.min(n, t));
  const i = Math.min(n - 1, Math.floor(tt));
  return bez(segmentControls(path, i), tt - i);
}

export function tangentAt(path: CurvePath, t: number): Vec3 {
  const n = segmentCount(path);
  if (n === 0) return [0, 0, 1];
  const tt = Math.max(0, Math.min(n, t));
  const i = Math.min(n - 1, Math.floor(tt));
  return bezTangent(segmentControls(path, i), tt - i);
}

export interface PathSample { p: Vec3; t: number; tangent: Vec3 }

/** Points along the path, `per` samples on each curved segment and just the ends on straight ones. */
export function samplePath(path: CurvePath, per = 16, t0 = 0, t1 = segmentCount(path)): PathSample[] {
  const out: PathSample[] = [];
  const n = segmentCount(path);
  if (n === 0) return out;
  const a = Math.max(0, Math.min(t0, t1)), b = Math.min(n, Math.max(t0, t1));
  const push = (t: number) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - t) < 1e-9) return;
    out.push({ p: pointAt(path, t), t, tangent: tangentAt(path, t) });
  };
  push(a);
  for (let i = Math.floor(a); i < Math.ceil(b); i++) {
    const s0 = Math.max(a, i), s1 = Math.min(b, i + 1);
    if (s1 - s0 < 1e-9) continue;
    const k = isStraight(path, i) ? 1 : Math.max(2, Math.ceil(per * (s1 - s0)));
    for (let j = 1; j <= k; j++) push(s0 + ((s1 - s0) * j) / k);
  }
  if (t1 < t0) out.reverse();
  return out;
}

export function pathLength(path: CurvePath): number {
  const s = samplePath(path, 32);
  let L = 0;
  for (let i = 1; i < s.length; i++) L += len(sub(s[i].p, s[i - 1].p));
  return L;
}

/** Path parameter at a fraction (0…1) of the length. */
export function paramAtFraction(path: CurvePath, f: number): number {
  const s = samplePath(path, 48);
  if (s.length < 2) return 0;
  const cum = [0];
  for (let i = 1; i < s.length; i++) cum.push(cum[i - 1] + len(sub(s[i].p, s[i - 1].p)));
  const target = Math.max(0, Math.min(1, f)) * cum[cum.length - 1];
  for (let i = 1; i < s.length; i++) {
    if (cum[i] >= target) {
      const k = (target - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
      return s[i - 1].t + (s[i].t - s[i - 1].t) * k;
    }
  }
  return s[s.length - 1].t;
}

export interface Frame { p: Vec3; t: Vec3; n: Vec3; b: Vec3 }

/**
 * Rotation-minimising frames along the samples (double reflection), starting
 * from "up" so a horizontal beam's section sits level.
 */
export function frames(samples: PathSample[], up: Vec3 = [0, 1, 0]): Frame[] {
  const out: Frame[] = [];
  if (!samples.length) return out;
  const t0 = samples[0].tangent;
  let ref = up;
  if (Math.abs(dot(norm(ref), t0)) > 0.95) ref = Math.abs(t0[2]) < 0.95 ? [0, 0, 1] : [1, 0, 0];
  let n = norm(sub(ref, scale(t0, dot(ref, t0))));
  let b = cross(t0, n);
  out.push({ p: samples[0].p, t: t0, n, b });
  for (let i = 1; i < samples.length; i++) {
    const x0 = samples[i - 1].p, x1 = samples[i].p;
    const v1 = sub(x1, x0);
    const c1 = dot(v1, v1);
    const ti = out[i - 1].t;
    let rL = n, tL = ti;
    if (c1 > 1e-18) {
      rL = sub(n, scale(v1, (2 / c1) * dot(v1, n)));
      tL = sub(ti, scale(v1, (2 / c1) * dot(v1, ti)));
    }
    const t = samples[i].tangent;
    const v2 = sub(t, tL);
    const c2 = dot(v2, v2);
    n = c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL;
    n = norm(sub(n, scale(t, dot(n, t))));
    b = cross(t, n);
    out.push({ p: x1, t, n, b });
  }
  return out;
}

/**
 * Bend a single straight segment so its middle passes through `through`.
 * Handles are placed so the cubic's midpoint lands exactly there.
 */
export function bendSegment(path: CurvePath, i: number, through: Vec3): CurvePath {
  const [p0, , , p3] = segmentControls({ ...path, handles: undefined, smooth: false }, i);
  const mid = lerp(p0, p3, 0.5);
  const off = scale(sub(through, mid), 4 / 3);
  const h = (path.handles ?? []).slice();
  while (h.length < segmentCount(path)) h.push(null);
  h[i] = [add(lerp(p0, p3, 1 / 3), off), add(lerp(p0, p3, 2 / 3), off)];
  return { ...path, handles: h };
}

/** A circular arc of the given angle (degrees) between a segment's ends, bulging toward `side`. */
export function arcSegment(path: CurvePath, i: number, angleDeg: number, side: Vec3): CurvePath {
  const p0 = pt(path, i), p3 = pt(path, i + 1);
  const chord = sub(p3, p0);
  const c = len(chord);
  if (c < 1e-9) return path;
  const th = Math.max(1, Math.min(179, angleDeg)) * (Math.PI / 180);
  const r = c / (2 * Math.sin(th / 2));
  const u = scale(chord, 1 / c);
  let s = sub(side, scale(u, dot(side, u)));
  if (len(s) < 1e-9) s = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  s = norm(sub(s, scale(u, dot(s, u))));
  // End tangents tilt toward the bulge by half the arc angle.
  const k = (4 / 3) * Math.tan(th / 4) * r;
  const tA = norm(add(scale(u, Math.cos(th / 2)), scale(s, Math.sin(th / 2))));
  const tB = norm(sub(scale(u, Math.cos(th / 2)), scale(s, Math.sin(th / 2))));
  const h = (path.handles ?? []).slice();
  while (h.length < segmentCount(path)) h.push(null);
  h[i] = [add(p0, scale(tA, k)), sub(p3, scale(tB, k))];
  return { ...path, handles: h };
}

/** An S-curve: leaves and arrives parallel to the main direction of travel. */
export function sCurveSegment(path: CurvePath, i: number): CurvePath {
  const p0 = pt(path, i), p3 = pt(path, i + 1);
  const d = sub(p3, p0);
  const ax = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const k = ax.indexOf(Math.max(...ax));
  const along: Vec3 = [0, 0, 0];
  along[k] = d[k] / 2;
  const h = (path.handles ?? []).slice();
  while (h.length < segmentCount(path)) h.push(null);
  h[i] = [add(p0, along), sub(p3, along)];
  return { ...path, handles: h };
}

export function straightenSegment(path: CurvePath, i: number): CurvePath {
  const h = (path.handles ?? []).slice();
  if (i < h.length) h[i] = null;
  return { ...path, handles: h.some(Boolean) ? h : undefined };
}

/** Move every point and handle of a path. */
export function mapPath(path: CurvePath, f: (v: Vec3) => Vec3): CurvePath {
  return {
    ...path,
    points: path.points.map(f),
    handles: path.handles?.map((h) => (h ? h.map(f) : null)),
  };
}

export function pathCentroid(path: CurvePath): Vec3 {
  const s = samplePath(path, 8);
  let c: Vec3 = [0, 0, 0];
  for (const x of s) c = add(c, x.p);
  return s.length ? scale(c, 1 / s.length) : [0, 0, 0];
}

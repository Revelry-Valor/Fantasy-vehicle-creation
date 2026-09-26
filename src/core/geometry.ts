import { getDef, type Shape } from './catalog';
import type { PartInstance, Vec3 } from './types';

export interface AABB {
  min: Vec3;
  max: Vec3;
}

/** Rotation matrix (row-major 3×3) for Euler XYZ — matches three.js Euler 'XYZ'. */
export function rotationMatrix([x, y, z]: Vec3): number[] {
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c,
  ];
}

export function applyMatrix(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function localToWorld(p: PartInstance, local: Vec3): Vec3 {
  const r = applyMatrix(rotationMatrix(p.rotation), local);
  return [r[0] + p.position[0], r[1] + p.position[1], r[2] + p.position[2]];
}

export function worldAABB(p: PartInstance): AABB {
  const m = rotationMatrix(p.rotation);
  const [hx, hy, hz] = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const w = applyMatrix(m, [sx * hx, sy * hy, sz * hz]);
    for (let i = 0; i < 3; i++) {
      const v = w[i] + p.position[i];
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  return { min, max };
}

export function aabbOverlap(a: AABB, b: AABB, tol = 0): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.max[i] + tol < b.min[i] || b.max[i] + tol < a.min[i]) return false;
  }
  return true;
}

export function aabbContains(a: AABB, p: Vec3): boolean {
  for (let i = 0; i < 3; i++) if (p[i] < a.min[i] || p[i] > a.max[i]) return false;
  return true;
}

export function unionAABB(boxes: AABB[]): AABB | null {
  if (!boxes.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], b.min[i]);
    max[i] = Math.max(max[i], b.max[i]);
  }
  return { min, max };
}

/**
 * Oriented-box contact test. AABBs of rotated parts are too generous (a
 * diagonal beam's AABB covers a huge empty volume), so for connectivity we use
 * the separating-axis theorem on the two oriented boxes, inflated by `tol`.
 */
export function partsTouch(a: PartInstance, b: PartInstance, tol = 0.03): boolean {
  if (!aabbOverlap(worldAABB(a), worldAABB(b), tol)) return false;
  const ma = rotationMatrix(a.rotation);
  const mb = rotationMatrix(b.rotation);
  const axesA: Vec3[] = [0, 1, 2].map((i) => [ma[i], ma[3 + i], ma[6 + i]] as Vec3);
  const axesB: Vec3[] = [0, 1, 2].map((i) => [mb[i], mb[3 + i], mb[6 + i]] as Vec3);
  const ha = a.size.map((s) => s / 2 + tol);
  const hb = b.size.map((s) => s / 2 + tol);
  const t: Vec3 = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
  const test: Vec3[] = [...axesA, ...axesB];
  for (const u of axesA) for (const v of axesB) {
    const c = cross(u, v);
    if (dot(c, c) > 1e-8) test.push(c);
  }
  for (const L of test) {
    const ra = ha[0] * Math.abs(dot(axesA[0], L)) + ha[1] * Math.abs(dot(axesA[1], L)) + ha[2] * Math.abs(dot(axesA[2], L));
    const rb = hb[0] * Math.abs(dot(axesB[0], L)) + hb[1] * Math.abs(dot(axesB[1], L)) + hb[2] * Math.abs(dot(axesB[2], L));
    if (Math.abs(dot(t, L)) > ra + rb) return false;
  }
  return true;
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Interior volume of a shape with the given bounding size, m³. */
export function shapeVolume(shape: Shape, [a, b, c]: Vec3): number {
  switch (shape) {
    case 'box':
    case 'compartment':
      return a * b * c;
    case 'tube':
      return (Math.PI / 4) * a * b * c;
    case 'cylinderY':
    case 'boiler':
    case 'barrel':
      return (Math.PI / 4) * a * c * b;
    case 'ellipsoid':
      return (Math.PI / 6) * a * b * c;
    case 'capsule': {
      const d = Math.min(a, b, c);
      return (Math.PI / 4) * a * b * Math.max(0, c - d) + (Math.PI / 6) * a * b * Math.min(d, c);
    }
    case 'boatHull':
      return 0.6 * a * b * c;
    default:
      return a * b * c;
  }
}

/** Approximate outer surface area, m². */
export function shapeArea(shape: Shape, [a, b, c]: Vec3): number {
  switch (shape) {
    case 'tube': {
      const d = (a + b) / 2;
      return Math.PI * d * c + (Math.PI / 2) * d * d;
    }
    case 'cylinderY':
    case 'boiler':
    case 'barrel': {
      const d = (a + c) / 2;
      return Math.PI * d * b + (Math.PI / 2) * d * d;
    }
    case 'ellipsoid': {
      const p = 1.6075;
      const [x, y, z] = [a / 2, b / 2, c / 2];
      return 4 * Math.PI * Math.pow((Math.pow(x * y, p) + Math.pow(x * z, p) + Math.pow(y * z, p)) / 3, 1 / p);
    }
    case 'capsule': {
      const d = (a + b) / 2;
      return Math.PI * d * Math.max(0, c - d) + Math.PI * d * d;
    }
    case 'boatHull':
      return 2 * 0.85 * b * c + 0.75 * a * c + 0.5 * a * b;
    default:
      return 2 * (a * b + b * c + a * c);
  }
}

/** Area of a flat outline given as a flat [x, y, z, …] list, measured in the XZ plane. */
export function outlineAreaXZ(points: number[]): number {
  let a = 0;
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += points[i * 3] * points[j * 3 + 2] - points[j * 3] * points[i * 3 + 2];
  }
  return Math.abs(a) / 2;
}

/** Area of a flat 2D polygon given as [a0, b0, a1, b1, …]. */
export function polyArea2(flat: number[]): number {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Total area of a sheet's cut-outs, m². */
export function holesArea(p: PartInstance): number {
  return (p.holes ?? []).reduce((s, h) => s + polyArea2(h), 0);
}

/** Face area of a flat sheet: its outline minus its cut-outs. */
export function sheetArea(p: PartInstance): number {
  const outline = p.points && p.points.length >= 9 ? outlineAreaXZ(p.points) : p.size[0] * p.size[2];
  return Math.max(0, outline - holesArea(p));
}

export function partVolume(p: PartInstance): number {
  // A floor with a drawn outline: outline area × thickness.
  if ((p.type === 'deck' || p.type === 'frame') && ((p.points && p.points.length >= 9) || p.holes?.length)) return sheetArea(p) * p.size[1];
  if ((p.type === 'hullShell' || p.type === 'hullSides') && typeof p.props.volume === 'number') return p.props.volume;
  return shapeVolume(getDef(p.type).shape, p.size);
}

export function partArea(p: PartInstance): number {
  if (p.type === 'hullShell' && typeof p.props.area === 'number') return p.props.area;
  // Both side walls of a drawn hull.
  if (p.type === 'hullSides' && typeof p.props.area === 'number') return Math.max(0, p.props.area - holesArea(p)) * 2;
  return shapeArea(getDef(p.type).shape, p.size);
}

/**
 * Mirror a part's own shape data to go with a mirrored transform: outlines
 * and cut-outs are stored in local coordinates whose X flips too (hull side
 * walls store theirs in the Z/Y plane, which doesn't).
 */
export function mirrorShapeData(p: PartInstance): Pick<PartInstance, 'points' | 'holes'> {
  const flipX = p.type !== 'hullSides' && p.type !== 'hullShell';
  return {
    points: p.points?.map((v, i) => (i % 3 === 0 && p.type !== 'hullSides' ? -v : v)),
    holes: p.holes?.map((h) => h.map((v, i) => (i % 2 === 0 && flipX ? -v : v))),
  };
}

/** Mirror a transform across the X = 0 plane. */
export function mirrorTransform(position: Vec3, rotation: Vec3): { position: Vec3; rotation: Vec3 } {
  // Reflection across YZ-plane: x → −x. For a rotation R, the mirrored
  // orientation is S·R·S (S = diag(−1,1,1)), which for Euler XYZ is (x, −y, −z).
  return { position: [-position[0], position[1], position[2]], rotation: [rotation[0], -rotation[1], -rotation[2]] };
}

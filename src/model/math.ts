import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Part, Vec3 } from './types';

export const DEG = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function round(v: number, step: number): number {
  if (!step) return v;
  return +(Math.round(v / step) * step).toFixed(6);
}

export function snapVec(v: Vec3, step: number): Vec3 {
  return [round(v[0], step), round(v[1], step), round(v[2], step)];
}

export function eq(a: Vec3, b: Vec3, eps = 1e-6) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
}

/** A part's local-to-world matrix at rest (position, rotation, and any mirror flips). */
export function partMatrix(p: Part): Matrix4 {
  const q = new Quaternion().setFromEuler(new Euler(p.rotation[0] * DEG, p.rotation[1] * DEG, p.rotation[2] * DEG, 'XYZ'));
  const f = p.flip ?? [1, 1, 1];
  return new Matrix4().compose(new Vector3(...p.position), q, new Vector3(f[0], f[1], f[2]));
}

export function applyM(m: Matrix4, v: Vec3): Vec3 {
  const x = new Vector3(...v).applyMatrix4(m);
  return [x.x, x.y, x.z];
}

export function applyDir(m: Matrix4, v: Vec3): Vec3 {
  const x = new Vector3(...v).transformDirection(m);
  return [x.x, x.y, x.z];
}

/** Euler degrees from a rotation matrix, cleaned up so 15° steps stay exact. */
export function eulerDeg(m: Matrix4): Vec3 {
  const e = new Euler().setFromRotationMatrix(m, 'XYZ');
  const c = (r: number) => {
    let d = r / DEG;
    const s = Math.round(d / 15) * 15;
    if (Math.abs(d - s) < 1e-4) d = s;
    d = +d.toFixed(4);
    return d === 0 ? 0 : d;
  };
  return [c(e.x), c(e.y), c(e.z)];
}

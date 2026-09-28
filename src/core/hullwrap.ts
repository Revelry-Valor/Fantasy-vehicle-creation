import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { getDef } from './catalog';
import { localToWorld } from './geometry';
import { newId, type PartInstance, type Vec3 } from './types';

/**
 * Skin a set of framing members: take the corners of every member, build the
 * convex hull around them, push it out by `offset` so the plating sits on the
 * outside of the frame, and return a `hullShell` part. Area and volume are
 * baked into props so mass and displacement are exact.
 */
export function wrapHull(frame: PartInstance[], opts: { material?: string; thickness?: number; offset?: number } = {}): PartInstance | null {
  const offset = opts.offset ?? 0.05;
  const pts: Vec3[] = [];
  for (const p of frame) {
    const def = getDef(p.type);
    if (def.compartment || p.type === 'hullShell') continue;
    const [hx, hy, hz] = p.size.map((s) => s / 2);
    if (def.shape === 'rib') {
      // Sample the U-curve instead of the bounding box so the skin follows it.
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI + (i / 12) * Math.PI;
        for (const z of [-hz, hz]) pts.push(localToWorld(p, [hx * Math.cos(a), hy + 2 * hy * Math.sin(a), z]));
      }
      continue;
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(localToWorld(p, [sx * hx, sy * hy, sz * hz]));
  }
  if (pts.length < 4) return null;

  const hull = new ConvexHull().setFromPoints(pts.map((p) => new Vector3(...p)));
  const verts: Vector3[] = [];
  for (const v of hull.vertices) verts.push(v.point.clone());
  const center = new Vector3();
  for (const v of verts) center.add(v);
  center.divideScalar(verts.length);
  for (const v of verts) {
    const d = v.clone().sub(center);
    const len = d.length();
    if (len > 1e-6) v.add(d.multiplyScalar(offset / len));
  }

  // Area & volume from the (re-hulled) offset points.
  const outer = new ConvexHull().setFromPoints(verts);
  let area = 0, volume = 0;
  for (const face of outer.faces) {
    let edge = face.edge;
    const a = edge.head().point;
    edge = edge.next;
    do {
      const b = edge.tail().point, c = edge.head().point;
      const ab = b.clone().sub(a), ac = c.clone().sub(a);
      area += ab.clone().cross(ac).length() / 2;
      volume += a.clone().sub(center).dot(b.clone().sub(center).cross(c.clone().sub(center))) / 6;
      edge = edge.next;
    } while (edge !== face.edge);
  }

  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const local: number[] = [];
  for (const v of verts) {
    min.min(v); max.max(v);
  }
  const mid = min.clone().add(max).multiplyScalar(0.5);
  for (const v of verts) local.push(+(v.x - mid.x).toFixed(4), +(v.y - mid.y).toFixed(4), +(v.z - mid.z).toFixed(4));
  const size = max.clone().sub(min);
  return {
    id: newId(),
    type: 'hullShell',
    name: 'Hull Shell',
    position: [+mid.x.toFixed(4), +mid.y.toFixed(4), +mid.z.toFixed(4)],
    rotation: [0, 0, 0],
    size: [size.x, size.y, size.z],
    material: opts.material ?? 'oak',
    props: { thickness: opts.thickness ?? 0.03, sealed: true, area: +area.toFixed(3), volume: +Math.abs(volume).toFixed(3) },
    points: local,
  };
}

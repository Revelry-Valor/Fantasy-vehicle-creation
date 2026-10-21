import { getDef, getMaterial } from './catalog';
import { partAABB, partVolume, unionAABB, type AABB } from './geometry';
import { jointSpec } from './rig';
import type { Vec3, Vehicle } from './types';

export interface Report {
  bounds: AABB | null;
  dims: Vec3;
  parts: number;
  byType: [string, number][];
  byMaterial: [string, number, number][];
  mass: number;
  cog: Vec3 | null;
  joints: { id: string; name: string; type: string; min: number; max: number }[];
  stats: { key: string; label: string; unit?: string; total: number }[];
}

/** The vehicle report: sizes, counts, mass (information only) and custom stat totals. */
export function vehicleReport(v: Vehicle): Report {
  const boxes = v.parts.map((p) => partAABB(p, v)).filter((b): b is AABB => !!b);
  const bounds = unionAABB(boxes);
  const dims: Vec3 = bounds ? [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]) as Vec3 : [0, 0, 0];
  const byType = new Map<string, number>();
  const byMat = new Map<string, [number, number]>();
  let mass = 0;
  const c: Vec3 = [0, 0, 0];
  v.parts.forEach((p) => {
    const def = getDef(p.def, v);
    byType.set(def.name, (byType.get(def.name) ?? 0) + 1);
    const mat = getMaterial(p.material, v);
    const m = partVolume(p, v) * mat.density;
    const e = byMat.get(mat.name) ?? [0, 0];
    byMat.set(mat.name, [e[0] + 1, e[1] + m]);
    mass += m;
    const b = partAABB(p, v);
    if (b) for (let i = 0; i < 3; i++) c[i] += ((b.min[i] + b.max[i]) / 2) * m;
  });
  const joints = v.parts.filter((p) => jointSpec(v, p)).map((p) => {
    const s = jointSpec(v, p)!;
    return { id: p.id, name: p.name || getDef(p.def, v).name, type: s.type, min: s.min, max: s.max };
  });
  const stats = v.statDefs.map((d) => {
    let total = v.stats[d.key] ?? 0;
    for (const p of v.parts) total += p.stats?.[d.key] ?? getDef(p.def, v).stats?.[d.key] ?? 0;
    return { key: d.key, label: d.label, unit: d.unit, total };
  });
  return {
    bounds, dims, parts: v.parts.length,
    byType: [...byType].sort((a, b) => b[1] - a[1]),
    byMaterial: [...byMat].map(([k, [n, m]]) => [k, n, m] as [string, number, number]).sort((a, b) => b[2] - a[2]),
    mass, cog: mass > 0 ? c.map((x) => x / mass) as Vec3 : null, joints, stats,
  };
}

export function fmtMass(kg: number) {
  return kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 1e5 ? 0 : 1)} t` : `${Math.round(kg)} kg`;
}

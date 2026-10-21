import { defaultParams, getDef } from './catalog';
import { paramAtFraction, pointAt } from './curves';
import { add, scale, snapVec } from './math';
import { newId, type Part, type Vec3, type Vehicle } from './types';

/**
 * Hulls the way real ships are framed: ribs across the hull at a few
 * stations, stringers laid lengthwise through every rib, and plates filling
 * each cell. Stringers are derived: reshape a rib and they follow.
 */

export function makeBeam(v: Vehicle, def: string, points: Vec3[], opts: Partial<Part> = {}): Part {
  const d = getDef(def, v);
  return {
    id: newId(),
    def,
    params: defaultParams(d),
    position: [...points[0]] as Vec3,
    rotation: [0, 0, 0],
    material: d.material,
    layer: d.layer,
    path: { points: points.map((p) => [...p] as Vec3), smooth: points.length > 2 },
    ...opts,
  };
}

/** Recompute every stringer from its ribs. Returns ids whose path changed. */
export function refreshDerived(v: Vehicle): string[] {
  const changed: string[] = [];
  for (const p of v.parts) {
    if (p.derived?.kind !== 'stringer') continue;
    const ribs = p.derived.ribs.map((id) => v.parts.find((x) => x.id === id)).filter((r): r is Part => !!r?.path);
    if (ribs.length < 2) continue;
    const pts = ribs.map((r) => pointAt(r.path!, paramAtFraction(r.path!, p.derived!.s)));
    const before = JSON.stringify(p.path?.points);
    p.path = { points: pts, smooth: true };
    p.position = [...pts[0]] as Vec3;
    if (JSON.stringify(pts) !== before) changed.push(p.id);
  }
  return changed;
}

/** Sort ribs along the hull's long axis (the axis they're spread furthest along). */
export function orderRibs(v: Vehicle, ribIds: string[]): string[] {
  const ribs = ribIds.map((id) => v.parts.find((x) => x.id === id)).filter((r): r is Part => !!r?.path);
  const centre = (r: Part): Vec3 => scale(r.path!.points.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / r.path!.points.length);
  const cs = ribs.map(centre);
  const spread = [0, 1, 2].map((i) => Math.max(...cs.map((c) => c[i])) - Math.min(...cs.map((c) => c[i])));
  const ax = spread.indexOf(Math.max(...spread));
  return ribs.map((r, i) => ({ r, k: cs[i][ax] })).sort((a, b) => a.k - b.k).map((x) => x.r.id);
}

/** Lay `count` stringers through the ribs, evenly spaced around each rib. */
export function layStringers(v: Vehicle, ribIds: string[], count: number, def = 'beam.channel'): Part[] {
  const ribs = orderRibs(v, ribIds);
  if (ribs.length < 2 || count < 1) return [];
  const closed = !!v.parts.find((x) => x.id === ribs[0])?.path?.closed;
  const out: Part[] = [];
  for (let j = 0; j < count; j++) {
    const s = count === 1 ? 0.5 : closed ? j / count : j / (count - 1);
    const p = makeBeam(v, def, [[0, 0, 0], [0, 0, 1]], { name: `Stringer ${j + 1}` });
    p.derived = { kind: 'stringer', ribs, s };
    out.push(p);
  }
  v.parts.push(...out);
  refreshDerived(v);
  return out;
}

/** Stringers sharing a rib set, in order around the ribs. */
export function stringerSet(v: Vehicle, anyId: string): Part[] {
  const p = v.parts.find((x) => x.id === anyId);
  let ribs: string[] | null = p?.derived?.ribs ?? null;
  if (!ribs) {
    const s = v.parts.find((x) => x.derived?.ribs.includes(anyId));
    ribs = s?.derived?.ribs ?? null;
  }
  if (!ribs) return [];
  const key = ribs.join();
  return v.parts.filter((x) => x.derived?.ribs.join() === key).sort((a, b) => a.derived!.s - b.derived!.s);
}

/** A plate for every cell between neighbouring ribs and stringers. */
export function skinHull(v: Vehicle, anyId: string, thickness = 0.04, material?: string): Part[] {
  const st = stringerSet(v, anyId);
  if (st.length < 2) return [];
  const ribs = st[0].derived!.ribs;
  const closed = !!v.parts.find((x) => x.id === ribs[0])?.path?.closed;
  const skinDef = getDef('skin', v);
  const have = new Set(v.parts.filter((p) => p.surface).map((p) => p.surface!.edges.map((e) => e.part).sort().join()));
  const out: Part[] = [];
  const pairs: [number, number][] = [];
  for (let j = 0; j + 1 < st.length; j++) pairs.push([j, j + 1]);
  if (closed && st.length > 2) pairs.push([st.length - 1, 0]);
  for (let k = 0; k + 1 < ribs.length; k++) {
    for (const [j0, j1] of pairs) {
      const a = st[j0], b = st[j1];
      let s0 = a.derived!.s, s1 = b.derived!.s;
      if (s1 < s0) s1 += 1;
      const edges = [
        { part: a.id, t0: k, t1: k + 1 },
        { part: ribs[k + 1], t0: s0, t1: Math.min(1, s1), frac: true },
        { part: b.id, t0: k + 1, t1: k },
        { part: ribs[k], t0: Math.min(1, s1), t1: s0, frac: true },
      ];
      const key = edges.map((e) => e.part).sort().join();
      if (have.has(key)) continue;
      out.push({
        id: newId(), def: 'skin', params: defaultParams(skinDef), position: [0, 0, 0], rotation: [0, 0, 0],
        material: material ?? 'hullgrey', layer: 'plating',
        surface: { edges, thickness, side: 1 },
      });
    }
  }
  v.parts.push(...out);
  return out;
}

/** Skin between 3 or 4 whole beams forming a loop. */
export function skinBetween(v: Vehicle, beamIds: string[], thickness = 0.04, material = 'hullgrey'): Part | null {
  if (beamIds.length < 3 || beamIds.length > 4) return null;
  const edges = beamIds.map((id) => {
    const b = v.parts.find((x) => x.id === id);
    const n = b?.path ? (b.path.closed ? b.path.points.length : b.path.points.length - 1) : 1;
    return { part: id, t0: 0, t1: n };
  });
  const skinDef = getDef('skin', v);
  const p: Part = { id: newId(), def: 'skin', params: defaultParams(skinDef), position: [0, 0, 0], rotation: [0, 0, 0], material, layer: 'plating', surface: { edges, thickness, side: 1 } };
  v.parts.push(p);
  return p;
}

// ── Frame generators ────────────────────────────────────────────────────────

/** Twelve beams around a box, centred at `c`. */
export function boxFrame(v: Vehicle, c: Vec3, size: Vec3, def = 'beam.square'): Part[] {
  const [hx, hy, hz] = size.map((s) => s / 2);
  const P = (x: number, y: number, z: number): Vec3 => snapVec(add(c, [x * hx, y * hy, z * hz]), v.grid.minor);
  const edges: [Vec3, Vec3][] = [];
  for (const y of [-1, 1]) for (const z of [-1, 1]) edges.push([P(-1, y, z), P(1, y, z)]);
  for (const x of [-1, 1]) for (const z of [-1, 1]) edges.push([P(x, -1, z), P(x, 1, z)]);
  for (const x of [-1, 1]) for (const y of [-1, 1]) edges.push([P(x, y, -1), P(x, y, 1)]);
  const out = edges.map(([a, b]) => makeBeam(v, def, [a, b]));
  v.parts.push(...out);
  return out;
}

/** A wedge: full-height box at the back tapering to a keel line at the front. */
export function wedgeFrame(v: Vehicle, c: Vec3, size: Vec3, def = 'beam.square'): Part[] {
  const [hx, hy, hz] = size.map((s) => s / 2);
  const P = (x: number, y: number, z: number): Vec3 => snapVec(add(c, [x * hx, y * hy, z * hz]), v.grid.minor);
  const back = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)];
  const front = [P(-1, -1, 1), P(1, -1, 1)];
  const pairs: [Vec3, Vec3][] = [[back[0], back[1]], [back[1], back[2]], [back[2], back[3]], [back[3], back[0]], [front[0], front[1]],
    [back[0], front[0]], [back[1], front[1]], [back[3], front[0]], [back[2], front[1]]];
  const out = pairs.map(([a, b]) => makeBeam(v, def, [a, b]));
  v.parts.push(...out);
  return out;
}

/**
 * A cylinder frame along Z: closed ring ribs at each station plus stringers
 * through them, ready for Skin hull.
 */
export function cylinderFrame(v: Vehicle, c: Vec3, radius: number, length: number, stations = 3, stringers = 8, def = 'beam.channel'): Part[] {
  const ribs: Part[] = [];
  const n = 8;
  for (let k = 0; k < stations; k++) {
    const z = c[2] - length / 2 + (length * k) / Math.max(1, stations - 1);
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(snapVec([c[0] + Math.sin(a) * radius, c[1] + Math.cos(a) * radius, z], v.grid.minor));
    }
    const r = makeBeam(v, def, pts, { name: `Rib ${k + 1}` });
    r.path = { points: pts, smooth: true, closed: true };
    ribs.push(r);
  }
  v.parts.push(...ribs);
  const st = layStringers(v, ribs.map((r) => r.id), stringers, def);
  return [...ribs, ...st];
}

/** Centre of a set of points (for placing generators at the cursor). */
export function centreOf(points: Vec3[]): Vec3 {
  if (!points.length) return [0, 0, 0];
  return scale(points.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / points.length);
}


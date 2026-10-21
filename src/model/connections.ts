import { getDef } from './catalog';
import { jointMovesSelf, obbAABB, obbPenetration, partProxies, pointInOBB, snapPoints, type AABB, type Proxy } from './geometry';
import { applyDir, dot, partMatrix, sub } from './math';
import type { Part, Vec3, Vehicle } from './types';

/**
 * Automatic connections. Two parts are connected when they touch (share a
 * face or edge) or when a snap point of one sits inside the other (a beam end
 * on another beam, a plate corner on a frame). Parts passing through each
 * other with no shared snap point are an overlap.
 *
 * Results are cached per pair against each part's shape signature, so after
 * an edit only the pairs involving changed parts are tested again.
 */

export type PairResult = 'touch' | 'overlap';

interface PartCache {
  sig: string;
  proxies: Proxy[];
  box: AABB | null;
  snaps: Vec3[];
}

export interface Graph {
  /** Neighbours of every part. */
  adj: Map<string, Set<string>>;
  overlaps: [string, string][];
  /** For joints: which half each neighbour is attached to. */
  jointSide: Map<string, Map<string, 'base' | 'head'>>;
}

export function partSignature(p: Part): string {
  return JSON.stringify([p.def, p.params, p.position, p.rotation, p.flip, p.path, p.section, p.surface, p.derived]);
}

export class ConnectionSolver {
  private parts = new Map<string, PartCache>();
  private pairs = new Map<string, { a: string; b: string; result: PairResult | null }>();
  tested = 0;

  private cacheFor(v: Vehicle, p: Part): PartCache {
    let sig = partSignature(p);
    if (p.surface) for (const e of p.surface.edges) { const b = v.parts.find((x) => x.id === e.part); if (b) sig += partSignature(b); }
    const c = this.parts.get(p.id);
    if (c && c.sig === sig) return c;
    const proxies = partProxies(p, v);
    const boxes = proxies.map((x) => obbAABB(x.obb));
    let box: AABB | null = null;
    if (boxes.length) {
      box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const b of boxes) for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], b.min[i]); box.max[i] = Math.max(box.max[i], b.max[i]); }
    }
    const n: PartCache = { sig, proxies, box, snaps: snapPoints(p, v) };
    this.parts.set(p.id, n);
    return n;
  }

  /** Recompute the connection graph. Only pairs with a changed part are re-tested. */
  solve(v: Vehicle): Graph {
    const tol = tolerance(v);
    this.tested = 0;
    const live = new Set(v.parts.map((p) => p.id));
    for (const id of [...this.parts.keys()]) if (!live.has(id)) this.parts.delete(id);
    const entries = v.parts.map((p) => ({ p, c: this.cacheFor(v, p) })).filter((e) => e.c.box);
    // Sweep along X to find candidate pairs.
    entries.sort((a, b) => a.c.box!.min[0] - b.c.box!.min[0]);
    const results = new Map<string, { a: string; b: string; result: PairResult | null }>();
    for (let i = 0; i < entries.length; i++) {
      const A = entries[i];
      const ab = A.c.box!;
      for (let j = i + 1; j < entries.length; j++) {
        const B = entries[j];
        const bb = B.c.box!;
        if (bb.min[0] > ab.max[0] + tol) break;
        if (bb.min[1] > ab.max[1] + tol || bb.max[1] < ab.min[1] - tol || bb.min[2] > ab.max[2] + tol || bb.max[2] < ab.min[2] - tol) continue;
        const [x, y] = A.p.id < B.p.id ? [A, B] : [B, A];
        const key = `${x.p.id}|${y.p.id}|${x.c.sig.length}:${hash(x.c.sig)}|${y.c.sig.length}:${hash(y.c.sig)}`;
        let r = this.pairs.get(key);
        if (!r) {
          this.tested++;
          let result = testPair(x.c, y.c, tol);
          // Plates follow curves only approximately: anything they meet is attached to them.
          if (result === 'overlap' && (x.p.surface || y.p.surface)) result = 'touch';
          r = { a: x.p.id, b: y.p.id, result };
        }
        results.set(key, r);
      }
    }
    this.pairs = results;

    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    };
    for (const p of v.parts) if (!adj.has(p.id)) adj.set(p.id, new Set());
    const overlaps: [string, string][] = [];
    const broken = new Set(v.connections.filter((c) => c.mode === 'broken').map((c) => pairKey(c.a, c.b)));
    for (const r of results.values()) {
      if (!r.result) continue;
      if (broken.has(pairKey(r.a, r.b))) continue;
      if (r.result === 'touch') link(r.a, r.b);
      else overlaps.push([r.a, r.b]);
    }
    // Skins are attached to the beams they follow.
    for (const p of v.parts) for (const e of p.surface?.edges ?? []) if (live.has(e.part)) link(p.id, e.part);
    for (const c of v.connections) if (c.mode === 'forced' && live.has(c.a) && live.has(c.b)) link(c.a, c.b);
    return { adj, overlaps, jointSide: this.jointSides(v, adj) };
  }

  /** Split each joint's neighbours into the half they hang off. */
  private jointSides(v: Vehicle, adj: Map<string, Set<string>>) {
    const out = new Map<string, Map<string, 'base' | 'head'>>();
    const tol = tolerance(v);
    for (const p of v.parts) {
      if (getDef(p.def, v).kind !== 'joint') continue;
      const m = new Map<string, 'base' | 'head'>();
      out.set(p.id, m);
      const jc = this.cacheFor(v, p);
      const up = applyDir(partMatrix(p), [0, 1, 0]);
      for (const nId of adj.get(p.id) ?? []) {
        if (jointMovesSelf(p)) { m.set(nId, 'base'); continue; }
        const n = v.parts.find((x) => x.id === nId);
        if (!n) continue;
        const nc = this.cacheFor(v, n);
        let base = 0, head = 0;
        for (const jp of jc.proxies) for (const np of nc.proxies) {
          const d = obbPenetration(jp.obb, np.obb);
          if (d < -tol) continue;
          if (jp.half === 'head') head = Math.max(head, d + 1);
          else base = Math.max(base, d + 1);
        }
        if (head && !base) m.set(nId, 'head');
        else if (base && !head) m.set(nId, 'base');
        else {
          // Touching both halves (or a skin): decide by which side of the joint it lies on.
          const c = nc.box ? [(nc.box.min[0] + nc.box.max[0]) / 2, (nc.box.min[1] + nc.box.max[1]) / 2, (nc.box.min[2] + nc.box.max[2]) / 2] as Vec3 : n.position;
          m.set(nId, dot(sub(c, p.position), up) > 0 ? 'head' : 'base');
        }
      }
    }
    return out;
  }

  /** Parts a not-yet-placed part would pass through (for the red ghost). */
  wouldOverlap(v: Vehicle, p: Part): string[] {
    const tol = tolerance(v);
    const proxies = partProxies(p, v);
    if (!proxies.length) return [];
    const mine: PartCache = { sig: '', proxies, box: null, snaps: snapPoints(p, v) };
    const boxes = proxies.map((x) => obbAABB(x.obb));
    const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))), max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i])));
    const out: string[] = [];
    for (const q of v.parts) {
      const c = this.cacheFor(v, q);
      if (!c.box) continue;
      if ([0, 1, 2].some((i) => c.box!.min[i] > max[i] + tol || c.box!.max[i] < min[i] - tol)) continue;
      if (testPair(mine, c, tol) === 'overlap') out.push(q.id);
    }
    return out;
  }

  /** Overlap test against arbitrary moved proxies (used for motion checks). */
  proxiesOf(v: Vehicle, p: Part): PartCache {
    return this.cacheFor(v, p);
  }
}

export function tolerance(v: Vehicle) {
  return Math.max(0.002, v.grid.minor * 0.04);
}

export function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function testPair(a: PartCache, b: PartCache, tol: number): PairResult | null {
  let pen = -Infinity;
  for (const x of a.proxies) for (const y of b.proxies) pen = Math.max(pen, obbPenetration(x.obb, y.obb));
  if (pen < -tol) return null;
  if (pen <= tol) return 'touch';
  // Deeper than a touch: fine if they meet at a snap point (a joint between members).
  const inside = (pts: Vec3[], prox: Proxy[]) => pts.some((q) => prox.some((pr) => pointInOBB(q, pr.obb, tol)));
  if (inside(a.snaps, b.proxies) || inside(b.snaps, a.proxies)) return 'touch';
  return 'overlap';
}

// ── Checks ──────────────────────────────────────────────────────────────────

export interface Warning {
  kind: 'floating' | 'overlap' | 'motion' | 'locked' | 'skin';
  message: string;
  parts: string[];
}

/** Connected groups of parts, largest first. */
export function components(v: Vehicle, g: Graph): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const p of v.parts) {
    if (seen.has(p.id)) continue;
    const comp: string[] = [];
    const stack = [p.id];
    seen.add(p.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const n of g.adj.get(id) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    out.push(comp);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function structuralWarnings(v: Vehicle, g: Graph): Warning[] {
  const out: Warning[] = [];
  const name = (id: string) => {
    const p = v.parts.find((x) => x.id === id);
    return p ? p.name || getDef(p.def, v).name : id;
  };
  const isFigure = (id: string) => { const p = v.parts.find((x) => x.id === id); return !!p && getDef(p.def, v).shape === 'figure'; };
  const comps = components(v, g).filter((c) => !c.every(isFigure));
  for (const c of comps.slice(1)) {
    out.push({
      kind: 'floating',
      message: c.length === 1 ? `${name(c[0])} isn't connected to the main body.` : `${c.length} parts (${name(c[0])}…) aren't connected to the main body.`,
      parts: c,
    });
  }
  for (const [a, b] of g.overlaps) out.push({ kind: 'overlap', message: `${name(a)} passes through ${name(b)}.`, parts: [a, b] });
  return out;
}

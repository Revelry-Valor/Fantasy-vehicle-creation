import * as THREE from 'three';
import { dryMass, type Analysis } from '../core/analysis';
import { getDef } from '../core/catalog';
import { worldAABB, type AABB } from '../core/geometry';
import { getMaterial } from '../core/materials';
import { deckOutline } from '../core/pens';
import { DEFAULT_SHEET, type Design, type PartInstance, type SheetSettings, type Vec3 } from '../core/types';
import { buildPartObject } from './meshes';

/**
 * The drafting sheet: an engineer's general-arrangement drawing of the craft
 * on an A3 sheet, all views at one scale, with a title block, a table of
 * particulars and numbered callouts.
 *
 * Each view is drawn with three.js into offscreen buffers and inked on the CPU:
 *  - a colour pass (paper-white or grey-shaded fills, hatched cut sections),
 *  - an ID pass (every part a flat colour) whose boundaries become outlines,
 *  - a line pass (crease edges, plate seams, planking, flanges and rivets).
 * The side view is a cutaway on the centre line: structure is sliced at X = 0
 * and the cut faces are capped and hatched, the way a section is drawn.
 */

export const PAPER_W = 420;
export const PAPER_H = 297;
const SCALES = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000];
const FONT = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

type ViewKey = 'side' | 'plan' | 'front';
type Role = 'structure' | 'shell' | 'equipment' | 'skip';
type Pass = 'color' | 'id' | 'edge';

interface ViewSpec { key: ViewKey; right: THREE.Vector3; up: THREE.Vector3; toward: THREE.Vector3; cut: boolean }
const VIEWS: Record<ViewKey, ViewSpec> = {
  // Looking from port toward starboard, bow to the right, cut on the centre line.
  side: { key: 'side', right: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), toward: new THREE.Vector3(-1, 0, 0), cut: true },
  // From above, bow to the right, starboard up the page.
  plan: { key: 'plan', right: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(1, 0, 0), toward: new THREE.Vector3(0, 1, 0), cut: false },
  // From ahead, starboard to the right.
  front: { key: 'front', right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), toward: new THREE.Vector3(0, 0, 1), cut: false },
};

interface Palette {
  paper: string; ink: string; decor: string; text: string; faint: string;
  capFill: number; capInk: number; desk: string;
}
const PALETTES: Record<SheetSettings['style'], Palette> = {
  line: { paper: '#fbfaf6', ink: '#16181b', decor: '#454a52', text: '#16181b', faint: '#8a8f96', capFill: 0xfbfaf6, capInk: 0x16181b, desk: '#2a2f36' },
  shaded: { paper: '#8f9398', ink: '#1b1e22', decor: '#3b4047', text: '#121417', faint: '#5b6067', capFill: 0x5f646a, capInk: 0x24272b, desk: '#24282d' },
};

const SHELLS = new Set(['hullShell', 'boatHull', 'pressureHull', 'pontoon', 'hullSides']);
const STRUCTURE = new Set(['beam', 'ibeam', 'strut', 'keel', 'rib', 'truss', 'frame', 'deck', 'bulkhead', 'plate', 'armor', 'window']);
const WOODS = new Set(['oak', 'pine', 'bamboo', 'ironwood', 'skywood']);

export function sheetSettings(d: Design): SheetSettings {
  const s = d.sheet ?? {};
  return { ...DEFAULT_SHEET, ...s, views: { ...DEFAULT_SHEET.views, ...(s.views ?? {}) } };
}

function roleOf(p: PartInstance): Role {
  const def = getDef(p.type);
  if (def.compartment) return 'skip';
  if (SHELLS.has(p.type)) return 'shell';
  if (STRUCTURE.has(p.type)) return 'structure';
  return 'equipment';
}

function matKind(id: string): 'metal' | 'wood' | 'other' {
  if (WOODS.has(id)) return 'wood';
  return getMaterial(id).metalness >= 0.5 ? 'metal' : 'other';
}

/** Colour whose stored (linear) value is exactly these sRGB bytes, so render-target pixels come back unchanged. */
function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);
}

function hexOf(css: string) {
  return parseInt(css.slice(1), 16);
}

// ── Layout ──────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }
interface Box2 { u0: number; u1: number; v0: number; v1: number }

function projectBox(box: AABB, v: ViewSpec): Box2 {
  const out: Box2 = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const p = new THREE.Vector3(x, y, z);
    const u = p.dot(v.right), w = p.dot(v.up);
    out.u0 = Math.min(out.u0, u); out.u1 = Math.max(out.u1, u);
    out.v0 = Math.min(out.v0, w); out.v1 = Math.max(out.v1, w);
  }
  return out;
}

interface Layout {
  N: number;
  frame: Rect;
  views: Partial<Record<ViewKey, { rect: Rect; box: Box2 }>>;
  key: Rect | null;
  specs: Rect | null;
  title: Rect;
  labelRows: { top: Rect; bottom: Rect } | null;
}

function computeLayout(bounds: AABB, s: SheetSettings, keyCount: number): Layout {
  const frame = { x: 10, y: 10, w: PAPER_W - 20, h: PAPER_H - 20 };
  const rightX = frame.x + frame.w - 106;
  const title = { x: rightX, y: frame.y + frame.h - 44, w: 106, h: 44 };
  const specsH = 66;
  const specs = s.specs ? { x: rightX, y: title.y - specsH - 3, w: 106, h: specsH } : null;
  const frontBottom = (specs ? specs.y : title.y) - 4;
  const left = { x: frame.x + 4, y: frame.y + 4, w: rightX - frame.x - 8, h: frame.h - 8 };
  const callouts = s.callouts && keyCount > 0;
  const keyCols = 3;
  const keyH = callouts && s.style === 'line' ? 7 + Math.ceil(keyCount / keyCols) * 4.2 : 0;
  const key = keyH ? { x: left.x, y: left.y + left.h - keyH, w: left.w, h: keyH } : null;

  const side = projectBox(bounds, VIEWS.side), plan = projectBox(bounds, VIEWS.plan), front = projectBox(bounds, VIEWS.front);
  const L = side.u1 - side.u0, H = side.v1 - side.v0, B = plan.v1 - plan.v0;
  const rowH = callouts ? 13 : 0;
  const sideH = s.views.side ? rowH * 2 + 11 : 0;
  const planH = s.views.plan ? 9 + 8 : 0;
  const availH = left.h - keyH - sideH - planH - (s.views.side && s.views.plan ? 6 : 0) - 4;
  const availW = left.w - 14;
  const frontW = 106 - 4, frontH = frontBottom - (frame.y + 4) - 9 - 8;
  const fits = (N: number) => {
    const k = 1000 / N;
    if ((s.views.side || s.views.plan) && L * k > availW) return false;
    if ((s.views.side ? H : 0) * k + (s.views.plan ? B : 0) * k > availH) return false;
    if (s.views.front && (B * k > frontW || H * k > frontH)) return false;
    return true;
  };
  let N = s.scale > 0 ? s.scale : SCALES.find(fits) ?? 0;
  if (!N) {
    const k = Math.min(availW / Math.max(L, 1e-3), availH / Math.max((s.views.side ? H : 0) + (s.views.plan ? B : 0), 1e-3), frontW / Math.max(B, 1e-3));
    N = Math.ceil(1000 / k / 100) * 100;
  }
  const k = 1000 / N;
  const views: Layout['views'] = {};
  const cx = left.x + 12 + availW / 2;
  // Centre the side and plan stack in the space above the key.
  const usedH = (s.views.side ? H * k + sideH : 0) + (s.views.plan ? B * k + planH : 0) + (s.views.side && s.views.plan ? 6 : 0);
  let y = left.y + Math.max(0, (left.h - keyH - usedH) / 2);
  let labelRows: Layout['labelRows'] = null;
  if (s.views.side) {
    const rect = { x: cx - (L * k) / 2, y: y + rowH, w: L * k, h: H * k };
    views.side = { rect, box: side };
    if (callouts) labelRows = { top: { x: left.x, y, w: left.w, h: rowH }, bottom: { x: left.x, y: rect.y + rect.h, w: left.w, h: rowH } };
    y += sideH + H * k + 6;
  }
  if (s.views.plan) {
    views.plan = { rect: { x: cx - (L * k) / 2, y, w: L * k, h: B * k }, box: plan };
  }
  if (s.views.front) {
    const fw = (front.u1 - front.u0) * k, fh = (front.v1 - front.v0) * k;
    const top = frame.y + 4, avail = frontBottom - top - 17;
    views.front = { rect: { x: rightX + 2 + (frontW - fw) / 2, y: top + Math.max(0, (avail - fh) / 2), w: fw, h: fh }, box: front };
  }
  return { N, frame, views, key, specs, title, labelRows };
}

// ── Decoration: seams, planking, flanges and rivets ────────────────────────

interface Decor { lines: number[]; dots: number[] }
interface DecorScale { mPerMm: number }

type P2 = [number, number];

/** Parts of segment a→b inside a polygon with holes (even-odd), as [t0, t1] intervals. */
function clipSegment(a: P2, b: P2, polys: P2[][]): [number, number][] {
  const ts: number[] = [0, 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ex = q[0] - p[0], ey = q[1] - p[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
      const s = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && s >= 0 && s <= 1) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-6) continue;
    const m = (t0 + t1) / 2;
    if (insidePolys([a[0] + dx * m, a[1] + dy * m], polys)) out.push([t0, t1]);
  }
  return out;
}

function insidePolys(p: P2, polys: P2[][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function insetPoly(poly: P2[], d: number): P2[] {
  // Shrink a polygon toward its centroid-ish by offsetting each edge (good enough for rivet rows).
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const s = area >= 0 ? 1 : -1;
  const n = poly.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i + n - 1) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const e1 = norm2([p1[0] - p0[0], p1[1] - p0[1]]), e2 = norm2([p2[0] - p1[0], p2[1] - p1[1]]);
    const n1: P2 = [-e1[1] * s, e1[0] * s], n2: P2 = [-e2[1] * s, e2[0] * s];
    const bis = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.35, bis[0] * n1[0] + bis[1] * n1[1]);
    out.push([p1[0] + (bis[0] * d) / cos, p1[1] + (bis[1] * d) / cos]);
  }
  return out;
}

function norm2(v: P2): P2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/**
 * Plating or planking drawn on one face of a flat sheet. The outline is in
 * the sheet's own 2D coordinates; `to3` lifts a 2D point onto the face.
 */
function decorateFace(out: Decor, outline: P2[], holes: P2[][], to3: (a: number, b: number) => Vec3, material: string, k: DecorScale) {
  if (outline.length < 3) return;
  const polys = [outline, ...holes];
  const xs = outline.map((q) => q[0]), ys = outline.map((q) => q[1]);
  const a0 = Math.min(...xs), a1 = Math.max(...xs), b0 = Math.min(...ys), b1 = Math.max(...ys);
  const longA = a1 - a0 >= b1 - b0;
  const seg = (p: P2, q: P2) => {
    for (const [t0, t1] of clipSegment(p, q, polys)) {
      const s0 = to3(p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0);
      const s1 = to3(p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1);
      out.lines.push(...s0, ...s1);
    }
  };
  const rivets = (p: P2, q: P2, pitch: number) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (const [t0, t1] of clipSegment(p, q, polys)) {
      const l = (t1 - t0) * len;
      const n = Math.floor(l / pitch);
      if (n < 1) continue;
      const off = (l - n * pitch) / 2;
      for (let i = 0; i <= n; i++) {
        const t = t0 + (off + i * pitch) / len;
        out.dots.push(...to3(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t));
      }
    }
  };
  // Lines along (true) or across the long direction at a given offset.
  const line = (along: boolean, c: number): [P2, P2] => (along === longA ? [[a0 - 1, c], [a1 + 1, c]] : [[c, b0 - 1], [c, b1 + 1]]);
  const kind = matKind(material);
  const mm = k.mPerMm;
  const [lo0, lo1] = longA ? [a0, a1] : [b0, b1];
  const [cr0, cr1] = longA ? [b0, b1] : [a0, a1];
  if (kind === 'wood') {
    // Planks run the long way, with butt joints staggered from row to row.
    const plank = Math.max(0.2, 1.6 * mm);
    const butt = Math.max(3, 18 * mm);
    let row = 0;
    for (let c = cr0 + plank; c < cr1 - plank * 0.3; c += plank) { const [p, q] = line(true, c); seg(p, q); }
    for (let c = cr0; c < cr1; c += plank, row++) {
      const c2 = Math.min(cr1, c + plank);
      for (let x = lo0 + ((row % 3) + 1) * (butt / 3); x < lo1 - 0.1; x += butt) {
        const p: P2 = longA ? [x, c] : [c, x], q: P2 = longA ? [x, c2] : [c2, x];
        seg(p, q);
        if (plank > 3 * mm) for (const cc of [c + plank * 0.3, c + plank * 0.7]) out.dots.push(...to3(...((longA ? [x - 0.05, cc] : [cc, x - 0.05]) as P2)), ...to3(...((longA ? [x + 0.05, cc] : [cc, x + 0.05]) as P2)));
      }
    }
    return;
  }
  if (kind !== 'metal') return;
  // Metal plating: plates 2.4 m long and 1.2 m wide, riveted along every seam and round the edge.
  const plateL = Math.max(2.4, 30 * mm), plateW = Math.max(1.2, 15 * mm);
  const pitch = Math.max(0.12, 2.2 * mm);
  const inset = Math.max(0.04, 0.9 * mm);
  const long: [P2, P2][] = [], cross: [P2, P2][] = [];
  for (let c = cr0 + plateW; c < cr1 - plateW * 0.25; c += plateW) long.push(line(true, c));
  for (let x = lo0 + plateL; x < lo1 - plateL * 0.25; x += plateL) cross.push(line(false, x));
  for (const [p, q] of [...long, ...cross]) { seg(p, q); rivets(p, q, pitch); }
  const ring = insetPoly(outline, inset);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.floor(len / pitch);
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const pt: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (insidePolys(pt, polys)) out.dots.push(...to3(...pt));
    }
  }
  for (const h of holes) {
    const ringH = insetPoly(h, -inset);
    for (let i = 0; i < ringH.length; i++) {
      const p = ringH[i], q = ringH[(i + 1) % ringH.length];
      const n = Math.floor(Math.hypot(q[0] - p[0], q[1] - p[1]) / pitch);
      for (let j = 0; j < n; j++) { const t = j / n; out.dots.push(...to3(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)); }
    }
  }
}

function pairsOf(flat: number[]): P2[] {
  const out: P2[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** Structural detail for one part, in its local coordinates. */
function decorate(p: PartInstance, k: DecorScale): Decor {
  const out: Decor = { lines: [], dots: [] };
  const [W, H, D] = p.size;
  const eps = Math.max(0.003, 0.02 * k.mPerMm);
  const mm = k.mPerMm;
  const tiny = (...d: number[]) => Math.max(...d) < 1.2 * mm;
  switch (p.type) {
    case 'deck':
    case 'frame': {
      const outline = deckOutline(p) as P2[];
      const holes = (p.holes ?? []).map(pairsOf);
      const t = Number(p.props.skinThickness ?? 0.02);
      const s = Number(p.props.outSign ?? 1) >= 0 ? 1 : -1;
      for (const side of [1, -1]) {
        let y = H / 2, mat = p.material;
        if (p.type === 'frame') {
          const skin = String(p.props[side === s ? 'skinOuter' : 'skinInner'] ?? 'none');
          if (skin !== 'none') { y += t; mat = skin; }
        }
        const yy = side * (y + eps);
        decorateFace(out, outline, holes, (a, b) => [a, yy, b], mat, k);
      }
      break;
    }
    case 'bulkhead':
    case 'plate':
    case 'armor': {
      const kAx = p.size.indexOf(Math.min(...p.size));
      const [i, j] = [0, 1, 2].filter((x) => x !== kAx);
      const hi = p.size[i] / 2, hj = p.size[j] / 2;
      const rect: P2[] = [[-hi, -hj], [hi, -hj], [hi, hj], [-hi, hj]];
      for (const side of [1, -1]) {
        const off = side * (p.size[kAx] / 2 + eps);
        decorateFace(out, rect, [], (a, b) => { const v: Vec3 = [0, 0, 0]; v[i] = a; v[j] = b; v[kAx] = off; return v; }, p.material, k);
      }
      break;
    }
    case 'hullSides': {
      const pts = p.points ?? [];
      const outline: P2[] = [];
      for (let i = 0; i + 2 < pts.length; i += 3) outline.push([pts[i + 2], pts[i + 1]]);
      const holes = (p.holes ?? []).map(pairsOf);
      const t = Number(p.props.thickness ?? 0.02);
      for (const x of [W / 2 - eps, W / 2 + t + eps, -W / 2 + eps, -W / 2 - t - eps]) {
        decorateFace(out, outline, holes, (a, b) => [x, b, a], p.material, k);
      }
      break;
    }
    case 'beam':
    case 'keel': {
      if (tiny(W, H)) break;
      // A built-up girder: riveted angle along each edge of every face, stiffeners across the web.
      const pitch = Math.max(0.1, 2.2 * mm);
      const n = Math.floor((D - 0.1) / pitch);
      const z0 = -((n * pitch) / 2);
      const rows: [number, number, number][] = []; // [axis offset x, y] on faces
      const ix = Math.min(W * 0.25, Math.max(0.03, 0.8 * mm)), iy = Math.min(H * 0.25, Math.max(0.03, 0.8 * mm));
      for (const sx of [-1, 1]) for (const y of [H / 2 - iy, -H / 2 + iy]) rows.push([sx * (W / 2 + eps), y, 0]);
      for (const sy of [-1, 1]) for (const x of [W / 2 - ix, -W / 2 + ix]) rows.push([x, sy * (H / 2 + eps), 0]);
      if (matKind(p.material) === 'metal') {
        for (const [x, y] of rows) for (let i = 0; i <= n; i++) out.dots.push(x, y, z0 + i * pitch);
        if (H > 4 * mm && p.type === 'beam') {
          const step = Math.max(H * 1.2, 0.6);
          for (let z = -D / 2 + step; z < D / 2 - step * 0.4; z += step) for (const sx of [-1, 1]) {
            const x = sx * (W / 2 + eps);
            out.lines.push(x, -H / 2 + iy, z, x, H / 2 - iy, z);
          }
        }
      } else if (matKind(p.material) === 'wood' && H > 3 * mm) {
        // Timber: a grain line down each face and bolt heads at the ends.
        for (const sx of [-1, 1]) {
          const x = sx * (W / 2 + eps);
          out.lines.push(x, H * 0.12, -D / 2 + 0.05, x, H * 0.12, D / 2 - 0.05);
          for (const z of [-D / 2 + Math.max(0.08, H * 0.4), D / 2 - Math.max(0.08, H * 0.4)]) out.dots.push(x, 0, z);
        }
      }
      break;
    }
    case 'ibeam': {
      if (tiny(W, H)) break;
      const f = 0.16 * H, web = 0.1 * W;
      // Lightening holes down the web, and rivets along the flanges.
      const r = (H - 2 * f) * 0.3;
      if (r > 1.2 * mm) {
        const step = Math.max(H * 1.6, r * 3);
        const n = Math.floor((D - step * 0.6) / step);
        for (let i = 0; i < n; i++) {
          const z = -((n - 1) * step) / 2 + i * step;
          for (const sx of [-1, 1]) circle(out.lines, [sx * (web + eps), 0, z], r, 'x');
        }
      }
      const pitch = Math.max(0.1, 2.2 * mm);
      const n = Math.floor((D - 0.1) / pitch);
      if (W > 2.5 * mm && matKind(p.material) === 'metal') for (const sy of [-1, 1]) for (const x of [W * 0.32, -W * 0.32]) {
        for (let i = 0; i <= n; i++) out.dots.push(x, sy * (H / 2 + eps), -((n * pitch) / 2) + i * pitch);
      }
      break;
    }
    case 'strut': {
      if (tiny(W, H)) break;
      // End collars.
      for (const z of [-D / 2 + Math.min(0.08, D * 0.1), D / 2 - Math.min(0.08, D * 0.1)]) circle(out.lines, [0, 0, z], W / 2 + eps, 'z');
      break;
    }
    case 'rib': {
      if (tiny(D, Math.min(D, 0.3))) break;
      const t = Math.min(D, 0.3);
      const pitch = Math.max(0.12, 2.2 * mm);
      const curve: [number, number][] = [];
      const nseg = 48;
      for (let i = 0; i <= nseg; i++) {
        const a = Math.PI + (i / nseg) * Math.PI;
        curve.push([(W / 2 - t / 2) * Math.cos(a), H / 2 + (H - t / 2) * Math.sin(a)]);
      }
      let acc = 0;
      for (let i = 1; i < curve.length; i++) {
        const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
        acc += Math.hypot(x1 - x0, y1 - y0);
        if (acc >= pitch) { acc = 0; for (const z of [D / 2 + eps, -D / 2 - eps]) out.dots.push(x1, y1, z); }
      }
      break;
    }
  }
  return out;
}

function circle(lines: number[], c: Vec3, r: number, axis: 'x' | 'z') {
  const n = 20;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number): Vec3 => (axis === 'x' ? [c[0], c[1] + r * Math.sin(a), c[2] + r * Math.cos(a)] : [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]]);
    lines.push(...p(a0), ...p(a1));
  }
}

// ── The drafting scene ──────────────────────────────────────────────────────

interface Swap { mesh: THREE.Mesh; color: THREE.Material; id: THREE.Material; depth: THREE.Material }
interface Entry {
  part: PartInstance;
  role: Role;
  root: THREE.Group;
  fills: Swap[];
  caps: Swap[];
  stencil: THREE.Mesh[];
  lines: THREE.Object3D[];
}

const HATCH_VERT = /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HATCH_FRAG = /* glsl */ `
uniform vec3 ink; uniform vec3 fill; uniform float spacing; uniform float width; uniform int pattern;
void main() {
  vec2 p = gl_FragCoord.xy;
  bool line = true;
  if (pattern == 1) line = mod(p.x + p.y, spacing) < width;
  else if (pattern == 2) line = mod(p.x + p.y, spacing) < width || mod(p.x - p.y, spacing) < width;
  else if (pattern == 3) line = mod(p.x - p.y, spacing * 1.7) < width || mod(p.y + 0.35 * p.x, spacing * 4.0) < width * 0.8;
  gl_FragColor = vec4(line ? ink : fill, 1.0);
}`;

function capStencil(m: THREE.Material) {
  m.stencilWrite = true;
  m.stencilRef = 0;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilFail = THREE.ReplaceStencilOp;
  m.stencilZFail = THREE.ReplaceStencilOp;
  m.stencilZPass = THREE.ReplaceStencilOp;
}

class DraftScene {
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera();
  entries: Entry[] = [];
  private clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  private clipMats: THREE.Material[] = [];
  private dotMats: THREE.PointsMaterial[] = [];
  private hatchMats: THREE.ShaderMaterial[] = [];
  private disposables: { dispose(): void }[] = [];
  private light = new THREE.DirectionalLight(0xffffff, 1.6);

  constructor(design: Design, private style: SheetSettings['style'], N: number) {
    const k: DecorScale = { mPerMm: N / 1000 };
    const pal = PALETTES[style];
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.05), this.camera);
    this.camera.add(this.light);
    this.light.position.set(-0.6, 0.8, 1);
    this.light.target.position.set(0, 0, 0);
    this.camera.add(this.light.target);

    const dotTex = this.track(dotTexture());
    const mk = <T extends THREE.Material>(m: T, clip: boolean): T => { if (clip) this.clipMats.push(m); this.track(m); return m; };
    const lineMats = (clip: boolean) => ({
      crease: mk(new THREE.LineBasicMaterial({ color: rawColor(0xff0000) }), clip),
      decor: mk(new THREE.LineBasicMaterial({ color: rawColor(0x00ff00) }), clip),
      dots: (() => {
        const m = mk(new THREE.PointsMaterial({ color: rawColor(0x0000ff), size: 3, sizeAttenuation: false, map: dotTex, alphaTest: 0.5, transparent: false }), clip);
        this.dotMats.push(m);
        return m;
      })(),
    });
    const clipped = lineMats(true), free = lineMats(false);
    const stBase = () => {
      const m = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, colorWrite: false });
      m.stencilWrite = true;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.clippingPlanes = [this.clipPlane];
      return this.track(m);
    };
    const stBack = stBase();
    stBack.side = THREE.BackSide;
    stBack.stencilFail = stBack.stencilZFail = stBack.stencilZPass = THREE.IncrementWrapStencilOp;
    const stFront = stBase();
    stFront.side = THREE.FrontSide;
    stFront.stencilFail = stFront.stencilZFail = stFront.stencilZPass = THREE.DecrementWrapStencilOp;
    const capGeo = this.track(new THREE.PlaneGeometry(1, 1));

    let nextId = 1;
    let order = 1;
    for (const p of design.parts) {
      const role = roleOf(p);
      if (role === 'skip') continue;
      const clip = role !== 'equipment';
      const obj = buildPartObject(p);
      const root = obj.root;
      root.updateMatrixWorld(true);
      const entry: Entry = { part: p, role, root, fills: [], caps: [], stencil: [], lines: [] };
      const idHex = nextId++;
      const meshes: THREE.Mesh[] = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
        else if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints) o.visible = false;
      });
      const L = clipped;
      const lm = clip ? L : free;
      for (const mesh of meshes) {
        const orig = mesh.material as THREE.MeshStandardMaterial;
        if (!orig.visible) continue;
        this.track(mesh.geometry);
        const side = role === 'shell' ? THREE.DoubleSide : orig.side;
        let color: THREE.Material;
        if (style === 'line') {
          color = new THREE.MeshBasicMaterial({ color: rawColor(hexOf(pal.paper)), side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        } else {
          const c = orig.color ?? new THREE.Color(0x999999);
          const lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
          const g = Math.min(0.92, (orig.transparent ? 0.86 : 0.5 + 0.42 * Math.sqrt(lum)));
          color = new THREE.MeshLambertMaterial({ color: new THREE.Color(g, g, g * 1.01), side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        }
        const id = new THREE.MeshBasicMaterial({ color: rawColor(idHex), side });
        const depth = new THREE.MeshBasicMaterial({ colorWrite: false, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        for (const m of [color, id, depth]) mk(m, clip);
        entry.fills.push({ mesh, color, id, depth });
        const edges = new THREE.LineSegments(this.track(new THREE.EdgesGeometry(mesh.geometry, 30)), lm.crease);
        edges.renderOrder = 1e6;
        mesh.add(edges);
        entry.lines.push(edges);
      }
      // Cut-section caps for solid structure (shell hulls are thin skins: no cap).
      if (role === 'structure') {
        const groups = new Map<string, THREE.Mesh[]>();
        for (const s of entry.fills) {
          const key = (s.mesh.material as THREE.Material).userData?.skin ? 'skin' : 'core';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(s.mesh);
        }
        for (const [key, ms] of groups) {
          const box = new THREE.Box3();
          for (const m of ms) box.expandByObject(m);
          if (!(box.min.x < -1e-4 && box.max.x > 1e-4)) continue;
          for (const m of ms) {
            const b = new THREE.Mesh(m.geometry, stBack), f = new THREE.Mesh(m.geometry, stFront);
            b.renderOrder = f.renderOrder = order;
            m.add(b, f);
            entry.stencil.push(b, f);
          }
          const sz = box.getSize(new THREE.Vector3());
          const mat = key === 'skin' ? String(p.props.skinOuter !== 'none' ? p.props.skinOuter : p.props.skinInner) : p.material;
          const thinnest = Math.min(...p.size);
          const pattern = thinnest / k.mPerMm < 0.9 ? 0 : key === 'skin' ? 2 : matKind(mat) === 'wood' ? 3 : 1;
          const hatch = this.track(new THREE.ShaderMaterial({
            vertexShader: HATCH_VERT, fragmentShader: HATCH_FRAG, side: THREE.DoubleSide,
            uniforms: { ink: { value: rawColor(pal.capInk) }, fill: { value: rawColor(pal.capFill) }, spacing: { value: 6 }, width: { value: 1 }, pattern: { value: pattern } },
          }));
          this.hatchMats.push(hatch);
          const id = this.track(new THREE.MeshBasicMaterial({ color: rawColor(nextId++), side: THREE.DoubleSide }));
          const depth = this.track(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
          for (const m of [hatch, id, depth]) capStencil(m);
          const cap = new THREE.Mesh(capGeo, hatch);
          cap.rotation.y = -Math.PI / 2;
          cap.position.set(0, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
          cap.scale.set(sz.z + 0.2, sz.y + 0.2, 1);
          cap.renderOrder = order + 0.5;
          order++;
          this.scene.add(cap);
          entry.caps.push({ mesh: cap, color: hatch, id, depth });
        }
      }
      // Drawn structure: seams, planking, rivets, flanges.
      if (role !== 'equipment') {
        const d = decorate(p, k);
        if (d.lines.length) {
          const g = this.track(new THREE.BufferGeometry());
          g.setAttribute('position', new THREE.Float32BufferAttribute(d.lines, 3));
          const ls = new THREE.LineSegments(g, lm.decor);
          ls.renderOrder = 1e6;
          root.add(ls);
          entry.lines.push(ls);
        }
        if (d.dots.length) {
          const g = this.track(new THREE.BufferGeometry());
          g.setAttribute('position', new THREE.Float32BufferAttribute(d.dots, 3));
          const pts = new THREE.Points(g, lm.dots);
          pts.renderOrder = 1e6;
          root.add(pts);
          entry.lines.push(pts);
        }
      }
      this.scene.add(root);
      this.entries.push(entry);
    }
  }

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  setView(v: ViewSpec, box: Box2, depth: [number, number], pxPerMm: number) {
    const cut = v.cut;
    for (const m of this.clipMats) {
      const want = cut ? 1 : 0;
      if ((m.clippingPlanes?.length ?? 0) !== want) { m.clippingPlanes = cut ? [this.clipPlane] : null; m.needsUpdate = true; }
    }
    for (const e of this.entries) {
      let show = true;
      if (cut && e.role === 'equipment') {
        const b = worldAABB(e.part);
        show = b.max[0] > 0.02 && !(e.part.mirrorOf && e.part.position[0] < 0);
      }
      e.root.visible = show;
      for (const c of e.caps) c.mesh.visible = cut;
      for (const s of e.stencil) s.visible = cut;
    }
    for (const m of this.dotMats) m.size = Math.max(2, 0.5 * pxPerMm);
    for (const m of this.hatchMats) { m.uniforms.spacing.value = Math.max(3, 1.2 * pxPerMm); m.uniforms.width.value = Math.max(1, 0.16 * pxPerMm); }
    const uc = (box.u0 + box.u1) / 2, vc = (box.v0 + box.v1) / 2;
    const dist = depth[1] + 10;
    const c = new THREE.Vector3().addScaledVector(v.right, uc).addScaledVector(v.up, vc);
    const cam = this.camera;
    cam.position.copy(c).addScaledVector(v.toward, dist);
    cam.up.copy(v.up);
    cam.lookAt(c);
    const hu = (box.u1 - box.u0) / 2, hv = (box.v1 - box.v0) / 2;
    cam.left = -hu; cam.right = hu; cam.top = hv; cam.bottom = -hv;
    cam.near = 0.01;
    cam.far = dist - depth[0] + 10;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  setPass(pass: Pass) {
    for (const e of this.entries) {
      for (const f of e.fills) f.mesh.material = f[pass === 'edge' ? 'depth' : pass];
      for (const c of e.caps) c.mesh.material = c[pass === 'edge' ? 'depth' : pass];
      for (const l of e.lines) l.visible = pass === 'edge';
    }
    this.light.visible = this.style === 'shaded';
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ── Inking: turn the three passes into a drawn view ─────────────────────────

let sharedRenderer: THREE.WebGLRenderer | null = null;
function renderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, stencil: true, preserveDrawingBuffer: false });
    sharedRenderer.localClippingEnabled = true;
    sharedRenderer.setClearColor(0x000000, 0);
  }
  return sharedRenderer;
}

function diskOffsets(r: number): [number, number][] {
  const out: [number, number][] = [];
  const R = Math.ceil(r);
  const lim = (r + 0.35) * (r + 0.35);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= lim) out.push([x, y]);
  return out;
}

function renderView(scene: DraftScene, v: ViewSpec, box: Box2, depth: [number, number], w: number, h: number, pxPerMm: number, pal: Palette): HTMLCanvasElement {
  const r = renderer();
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: true });
  scene.setView(v, box, depth, pxPerMm);
  const read = (pass: Pass) => {
    scene.setPass(pass);
    r.setRenderTarget(rt);
    r.clear(true, true, true);
    r.render(scene.scene, scene.camera);
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return buf;
  };
  const col = read('color'), ids = read('id'), edge = read('edge');
  r.setRenderTarget(null);
  rt.dispose();

  const idAt = (i: number) => (ids[i * 4] << 16) | (ids[i * 4 + 1] << 8) | ids[i * 4 + 2];
  // 1 = boundary between parts, 2 = silhouette against the paper.
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const a = idAt(i);
    for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0) continue;
      const b = idAt(j);
      if (a === b) continue;
      if (a === 0) mark[j] = 2;
      else if (b === 0) mark[i] = 2;
      else if (!mark[a > b ? i : j]) mark[a > b ? i : j] = 1;
    }
    if (a !== 0 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) mark[i] = 2;
  }
  // 1 ink, 2 decor
  const ink = new Uint8Array(w * h);
  const stamp = (i: number, offs: [number, number][], val: number) => {
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of offs) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!ink[j] || val < ink[j]) ink[j] = val;
    }
  };
  const rad = (mm: number) => Math.max(0, (mm * pxPerMm - 1) / 2);
  const silhouette = diskOffsets(rad(0.5)), inner = diskOffsets(rad(0.3)), crease = diskOffsets(rad(0.2)), decor = diskOffsets(rad(0.12));
  for (let i = 0; i < w * h; i++) {
    if (mark[i] === 2) stamp(i, silhouette, 1);
    else if (mark[i] === 1) stamp(i, inner, 1);
    const er = edge[i * 4], eg = edge[i * 4 + 1], eb = edge[i * 4 + 2], ea = edge[i * 4 + 3];
    if (ea < 128) continue;
    if (er > 128 && eg < 128) stamp(i, crease, 1);
    else if (eg > 128) stamp(i, decor, 2);
    else if (eb > 128) ink[i] = ink[i] || 1;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  const inkC = hexOf(pal.ink), decC = hexOf(pal.decor);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const o = ((h - 1 - y) * w + x) * 4;
    const k = ink[i];
    if (k) {
      const cc = k === 1 ? inkC : decC;
      img.data[o] = cc >> 16; img.data[o + 1] = (cc >> 8) & 255; img.data[o + 2] = cc & 255; img.data[o + 3] = 255;
    } else if (idAt(i) !== 0) {
      img.data[o] = col[i * 4]; img.data[o + 1] = col[i * 4 + 1]; img.data[o + 2] = col[i * 4 + 2]; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ── Callouts and particulars ────────────────────────────────────────────────

interface Callout { n: number; name: string; count: number; anchor: Vec3; z: number }

function collectCallouts(d: Design): Callout[] {
  const groups = new Map<string, { name: string; parts: PartInstance[] }>();
  for (const p of d.parts) {
    const def = getDef(p.type);
    if (def.conduit || roleOf(p) !== 'equipment' && !def.compartment) continue;
    if (p.type === 'crew') continue;
    const name = p.name?.trim() || def.name;
    const key = `${def.compartment ? 'c' : 'e'}|${name}`;
    if (!groups.has(key)) groups.set(key, { name, parts: [] });
    groups.get(key)!.parts.push(p);
  }
  const out: Callout[] = [];
  for (const g of groups.values()) {
    // Point at the starboard (visible) one in the cutaway.
    const rep = g.parts.reduce((a, b) => (b.position[0] > a.position[0] + 1e-3 ? b : a));
    out.push({ n: 0, name: g.name, count: g.parts.length, anchor: rep.position, z: rep.position[2] });
  }
  out.sort((a, b) => a.z - b.z);
  out.forEach((c, i) => (c.n = i + 1));
  return out;
}

function fmtMass(kg: number) {
  return kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 100000 ? 0 : 1)} t` : `${Math.round(kg)} kg`;
}

function fmtForce(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)} MN` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kN` : `${Math.round(n)} N`;
}

const ROLE: Record<string, string> = { air: 'Aerial craft', land: 'Land vehicle', water: 'Surface vessel', underwater: 'Submersible', space: 'Spacecraft' };

function particulars(d: Design, a: Analysis | null): [string, string][] {
  if (!a) return [];
  const rows: [string, string][] = [];
  const env = d.settings.environment;
  rows.push(['Role', ROLE[env] ?? env]);
  rows.push(['Length', `${a.dims[2].toFixed(2)} m`], ['Beam', `${a.dims[0].toFixed(2)} m`], ['Height', `${a.dims[1].toFixed(2)} m`]);
  const empty = d.parts.reduce((s, p) => s + dryMass(p), 0);
  rows.push(['Mass (loaded)', fmtMass(a.totalMass)], ['Mass (empty)', fmtMass(empty)]);
  rows.push(['Crew / seats / berths', `${a.crew} / ${a.seats} / ${a.beds}`]);
  if (env === 'air') rows.push(['Lift', `${fmtForce(a.totalLiftN)} (${(a.totalLiftN / Math.max(1, a.weightN) * 100).toFixed(0)}% of weight)`]);
  else if (env === 'water') rows.push(['Displacement', a.draft != null ? `${fmtForce(a.displacementCapacityN)} · draft ${a.draft.toFixed(2)} m` : fmtForce(a.displacementCapacityN)]);
  else if (env === 'underwater') rows.push(['Crush depth', a.crushDepth != null ? `${a.crushDepth.toFixed(0)} m` : '—']);
  else if (env === 'land') rows.push(['Ground pressure', a.groundPressureKPa != null ? `${a.groundPressureKPa.toFixed(0)} kPa` : '—']);
  else if (env === 'space') rows.push(['Δv', a.deltaV != null ? `${a.deltaV.toFixed(0)} m/s` : '—']);
  rows.push(['Thrust', a.thrustN ? fmtForce(a.thrustN) : '—']);
  rows.push(['Power', a.mechSupplyKW ? `${a.mechSupplyKW.toFixed(0)} kW` : '—']);
  // Armour: the thickest plating on the craft.
  let armT = 0, armM = '';
  for (const p of d.parts) {
    if (p.type === 'armor') { const t = Math.min(...p.size); if (t > armT) { armT = t; armM = p.material; } }
    if (p.type === 'frame') for (const k of ['skinOuter', 'skinInner']) {
      const m = String(p.props[k] ?? 'none');
      const t = Number(p.props.skinThickness ?? 0.02);
      if (m !== 'none' && t > armT) { armT = t; armM = m; }
    }
  }
  rows.push(['Armour', armT ? `${(armT * 1000).toFixed(0)} mm ${getMaterial(armM).name.toLowerCase()}` : 'none']);
  const guns = new Map<string, number>();
  for (const p of d.parts) if (getDef(p.type).weapon) { const n = p.name?.trim() || getDef(p.type).name; guns.set(n, (guns.get(n) ?? 0) + 1); }
  rows.push(['Armament', guns.size ? [...guns].map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ') : 'none']);
  return rows;
}

// ── The sheet ───────────────────────────────────────────────────────────────

export interface SheetResult { canvas: HTMLCanvasElement; layout: Layout | null }

/** Draw the whole sheet at `pxPerMm` pixels per paper millimetre. */
export function renderSheet(design: Design, analysis: Analysis | null, pxPerMm: number): SheetResult {
  const s = sheetSettings(design);
  const pal = PALETTES[s.style];
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAPER_W * pxPerMm);
  canvas.height = Math.round(PAPER_H * pxPerMm);
  const g = canvas.getContext('2d')!;
  g.scale(pxPerMm, pxPerMm);
  g.fillStyle = pal.paper;
  g.fillRect(0, 0, PAPER_W, PAPER_H);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const drawn = design.parts.filter((p) => roleOf(p) !== 'skip');
  const callouts = s.callouts ? collectCallouts(design) : [];
  const boxes = drawn.map(worldAABB);
  let layout: Layout | null = null;
  if (boxes.length) {
    const bounds: AABB = {
      min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))) as Vec3,
      max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))) as Vec3,
    };
    layout = computeLayout(bounds, s, callouts.length);
    const N = layout.N;
    const scene = new DraftScene(design, s.style, N);
    try {
      for (const key of ['side', 'plan', 'front'] as ViewKey[]) {
        const vw = layout.views[key];
        if (!vw) continue;
        const v = VIEWS[key];
        // Pad a little so outlines at the very edge aren't cut off.
        const padM = (1.2 * N) / 1000;
        const box = { u0: vw.box.u0 - padM, u1: vw.box.u1 + padM, v0: vw.box.v0 - padM, v1: vw.box.v1 + padM };
        const dz = projectDepth(bounds, v);
        const w = Math.max(2, Math.round(((box.u1 - box.u0) * 1000) / N * pxPerMm));
        const h = Math.max(2, Math.round(((box.v1 - box.v0) * 1000) / N * pxPerMm));
        const img = renderView(scene, v, box, dz, w, h, pxPerMm, pal);
        const padMm = 1.2;
        g.drawImage(img, vw.rect.x - padMm, vw.rect.y - padMm, vw.rect.w + 2 * padMm, vw.rect.h + 2 * padMm);
      }
    } finally {
      scene.dispose();
    }
    drawAnnotations(g, design, analysis, s, layout, bounds, callouts, pal);
  } else {
    g.fillStyle = pal.faint;
    g.font = `600 7px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('NOTHING DRAWN YET', 150, 140);
    g.font = `4px ${FONT}`;
    g.fillText('Build the craft in the 2D Blueprint or 3D modes; its drawings appear here.', 150, 148);
  }
  drawFrame(g, design, analysis, s, layout, pal);
  return { canvas, layout };
}

function projectDepth(box: AABB, v: ViewSpec): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const d = new THREE.Vector3(x, y, z).dot(v.toward);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return [lo, hi];
}

function toPaper(layout: Layout, key: ViewKey, w: Vec3): [number, number] {
  const vw = layout.views[key]!;
  const v = VIEWS[key];
  const p = new THREE.Vector3(...w);
  const k = 1000 / layout.N;
  return [vw.rect.x + (p.dot(v.right) - vw.box.u0) * k, vw.rect.y + (vw.box.v1 - p.dot(v.up)) * k];
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, opts: { weight?: number; align?: CanvasTextAlign; color?: string; base?: CanvasTextBaseline } = {}) {
  g.font = `${opts.weight ?? 400} ${size}px ${FONT}`;
  g.textAlign = opts.align ?? 'left';
  g.textBaseline = opts.base ?? 'alphabetic';
  if (opts.color) g.fillStyle = opts.color;
  g.fillText(s, x, y);
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, size = 1.8) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - ux * size - uy * size * 0.32, y - uy * size + ux * size * 0.32);
  g.lineTo(x - ux * size + uy * size * 0.32, y - uy * size - ux * size * 0.32);
  g.closePath();
  g.fill();
}

/** A dimension line between two paper points, offset to one side, with extension lines. */
function dimension(g: CanvasRenderingContext2D, a: [number, number], b: [number, number], off: number, label: string, pal: Palette) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  const A: [number, number] = [a[0] + nx * off, a[1] + ny * off], B: [number, number] = [b[0] + nx * off, b[1] + ny * off];
  g.strokeStyle = pal.ink;
  g.fillStyle = pal.ink;
  g.lineWidth = 0.13;
  g.beginPath();
  const s = Math.sign(off);
  g.moveTo(a[0] + nx * s * 1, a[1] + ny * s * 1); g.lineTo(A[0] + nx * s * 1.5, A[1] + ny * s * 1.5);
  g.moveTo(b[0] + nx * s * 1, b[1] + ny * s * 1); g.lineTo(B[0] + nx * s * 1.5, B[1] + ny * s * 1.5);
  g.moveTo(...A); g.lineTo(...B);
  g.stroke();
  arrow(g, A[0], A[1], -dx, -dy);
  arrow(g, B[0], B[1], dx, dy);
  g.save();
  g.translate((A[0] + B[0]) / 2, (A[1] + B[1]) / 2);
  let ang = Math.atan2(dy, dx);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  g.rotate(ang);
  g.font = `400 2.6px ${FONT}`;
  const tw = g.measureText(label).width + 1.6;
  g.fillStyle = pal.paper;
  g.fillRect(-tw / 2, -1.7, tw, 3.2);
  text(g, label, 0, 0.9, 2.6, { align: 'center', color: pal.text });
  g.restore();
}

function drawAnnotations(g: CanvasRenderingContext2D, d: Design, a: Analysis | null, s: SheetSettings, L: Layout, b: AABB, callouts: Callout[], pal: Palette) {
  const { side, plan, front } = L.views;
  const fmt = (m: number) => (m >= 10 ? `${m.toFixed(1)} m` : `${m.toFixed(2)} m`);
  g.lineWidth = 0.13;
  const caption = (r: Rect, title: string, sub: string, dy = 6) => {
    const y = r.y + r.h + dy;
    text(g, title.toUpperCase(), r.x + r.w / 2, y, 3.2, { weight: 700, align: 'center', color: pal.text });
    g.font = `700 3.2px ${FONT}`;
    const tw = g.measureText(title.toUpperCase()).width;
    g.strokeStyle = pal.text;
    g.lineWidth = 0.25;
    g.beginPath(); g.moveTo(r.x + r.w / 2 - tw / 2, y + 0.8); g.lineTo(r.x + r.w / 2 + tw / 2, y + 0.8); g.stroke();
    if (sub) text(g, sub, r.x + r.w / 2, y + 3.8, 2.4, { align: 'center', color: pal.faint });
  };
  const centreLine = (p: [number, number], q: [number, number]) => {
    g.save();
    g.strokeStyle = pal.faint;
    g.lineWidth = 0.13;
    g.setLineDash([4, 0.8, 0.6, 0.8]);
    g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke();
    g.restore();
  };
  // Ground and water lines.
  const env = d.settings.environment;
  const groundAt = (key: ViewKey) => {
    const r = L.views[key]!.rect;
    if (env === 'land') {
      const y = toPaper(L, key, [0, b.min[1], 0])[1];
      g.strokeStyle = pal.ink; g.lineWidth = 0.35;
      g.beginPath(); g.moveTo(r.x - 6, y); g.lineTo(r.x + r.w + 6, y); g.stroke();
      g.lineWidth = 0.13;
      g.beginPath();
      for (let x = r.x - 6; x < r.x + r.w + 6; x += 1.6) { g.moveTo(x, y); g.lineTo(x - 1.2, y + 1.2); }
      g.stroke();
    } else if ((env === 'water') && a?.draft != null) {
      const y = toPaper(L, key, [0, b.min[1] + a.draft, 0])[1];
      g.save(); g.strokeStyle = pal.ink; g.lineWidth = 0.2; g.setLineDash([3, 1, 0.6, 1]);
      g.beginPath(); g.moveTo(r.x - 8, y); g.lineTo(r.x + r.w + 8, y); g.stroke(); g.restore();
      text(g, 'WL', r.x - 8, y - 0.8, 2.4, { weight: 700, color: pal.text });
    }
  };
  if (side) {
    const r = side.rect;
    groundAt('side');
    dimension(g, [r.x, r.y + r.h], [r.x, r.y], -6, fmt(b.max[1] - b.min[1]), pal);
    caption(r, 'Side elevation · section A–A', 'Cut on the centre line, looking to starboard', L.labelRows ? 13 + 5 : 7);
  }
  if (plan) {
    const r = plan.rect;
    const k = 1000 / L.N;
    const cy = toPaper(L, 'plan', [0, 0, 0])[1];
    centreLine([r.x - 4, cy], [r.x + r.w + 4, cy]);
    // Section marks: the cut runs along the centre line, viewed toward starboard (up the page).
    g.fillStyle = pal.ink; g.strokeStyle = pal.ink; g.lineWidth = 0.5;
    for (const x of [r.x - 4, r.x + r.w + 4]) {
      g.beginPath(); g.moveTo(x, cy); g.lineTo(x, cy - 4); g.stroke();
      arrow(g, x, cy - 5.5, 0, -1, 2);
      text(g, 'A', x + (x < r.x ? -1.5 : 1.5), cy + 3.2, 3, { weight: 700, align: 'center', color: pal.text });
    }
    dimension(g, [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], 5, fmt(b.max[2] - b.min[2]), pal);
    dimension(g, [r.x, r.y + r.h], [r.x, r.y], -6, fmt(b.max[0] - b.min[0]), pal);
    void k;
    caption(r, 'Plan', 'From above, bow to the right', 12);
  }
  if (front) {
    const r = front.rect;
    const cx = toPaper(L, 'front', [0, 0, 0])[0];
    centreLine([cx, r.y - 3], [cx, r.y + r.h + 3]);
    groundAt('front');
    dimension(g, [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], 4, fmt(b.max[0] - b.min[0]), pal);
    caption(r, 'Front elevation', 'From ahead', 10);
  }
  // Callouts on the side view.
  if (side && L.labelRows && callouts.length) {
    const r = side.rect;
    const mid = r.y + r.h / 2;
    const items = callouts.map((c) => {
      const [x, y] = toPaper(L, 'side', c.anchor);
      const label = s.style === 'line' ? String(c.n) : `${c.name}${c.count > 1 ? ` ×${c.count}` : ''}`;
      g.font = `600 2.6px ${FONT}`;
      const w = s.style === 'line' ? 4.4 : g.measureText(label).width + 2;
      return { c, x, y, label, w, top: y < mid, px: x };
    });
    for (const top of [true, false]) {
      const row = items.filter((i) => i.top === top).sort((p, q) => p.x - q.x);
      const lo = L.labelRows.top.x + 2, hi = L.labelRows.top.x + L.labelRows.top.w - 2;
      for (let i = 0; i < row.length; i++) row[i].px = Math.max(row[i].x, i ? row[i - 1].px + row[i - 1].w / 2 + row[i].w / 2 + 0.8 : lo + row[i].w / 2);
      for (let i = row.length - 1; i >= 0; i--) row[i].px = Math.min(row[i].px, i < row.length - 1 ? row[i + 1].px - row[i + 1].w / 2 - row[i].w / 2 - 0.8 : hi - row[i].w / 2);
      // Stagger crowded rows on two lines.
      const rowR = top ? L.labelRows.top : L.labelRows.bottom;
      row.forEach((it, i) => {
        const lane = row.length > 14 && i % 2 ? 1 : 0;
        const ly = top ? rowR.y + rowR.h - 4.5 - lane * 5 : rowR.y + 4.5 + lane * 5;
        g.strokeStyle = pal.ink; g.fillStyle = pal.ink; g.lineWidth = 0.13;
        g.beginPath();
        g.moveTo(it.px, ly + (top ? 2.3 : -2.3));
        g.lineTo(it.x, it.y);
        g.stroke();
        g.beginPath(); g.arc(it.x, it.y, 0.45, 0, Math.PI * 2); g.fill();
        if (s.style === 'line') {
          g.fillStyle = pal.paper;
          g.beginPath(); g.arc(it.px, ly, 2.2, 0, Math.PI * 2); g.fill(); g.stroke();
          text(g, it.label, it.px, ly + 0.95, 2.6, { weight: 700, align: 'center', color: pal.text });
        } else {
          text(g, it.label, it.px, ly + (top ? 0.4 : 1.6), 2.6, { weight: 700, align: 'center', color: pal.text });
        }
      });
    }
  }
  // Key list.
  if (L.key && callouts.length) {
    const k = L.key;
    g.strokeStyle = pal.ink; g.lineWidth = 0.25;
    g.beginPath(); g.moveTo(k.x, k.y); g.lineTo(k.x + k.w, k.y); g.stroke();
    text(g, 'KEY', k.x, k.y + 4.6, 3, { weight: 700, color: pal.text });
    const cols = 3, colW = k.w / cols;
    const perCol = Math.ceil(callouts.length / cols);
    callouts.forEach((c, i) => {
      const col = Math.floor(i / perCol), row = i % perCol;
      const x = k.x + col * colW, y = k.y + 8.5 + row * 4.2;
      text(g, `${c.n}.`, x + 5, y, 2.7, { weight: 700, align: 'right', color: pal.text });
      text(g, `${c.name}${c.count > 1 ? `  ×${c.count}` : ''}`, x + 6.5, y, 2.7, { color: pal.text });
    });
  }
  void plan;
}

function drawFrame(g: CanvasRenderingContext2D, d: Design, a: Analysis | null, s: SheetSettings, L: Layout | null, pal: Palette) {
  g.strokeStyle = pal.ink;
  g.lineWidth = 0.7;
  g.strokeRect(10, 10, PAPER_W - 20, PAPER_H - 20);
  g.lineWidth = 0.18;
  g.strokeRect(7, 7, PAPER_W - 14, PAPER_H - 14);
  // Grid reference marks along the border.
  g.lineWidth = 0.18;
  for (let i = 1; i < 8; i++) {
    const x = 10 + ((PAPER_W - 20) * i) / 8;
    g.beginPath(); g.moveTo(x, 7); g.lineTo(x, 10); g.moveTo(x, PAPER_H - 10); g.lineTo(x, PAPER_H - 7); g.stroke();
  }
  for (let i = 1; i < 6; i++) {
    const y = 10 + ((PAPER_H - 20) * i) / 6;
    g.beginPath(); g.moveTo(7, y); g.lineTo(10, y); g.moveTo(PAPER_W - 10, y); g.lineTo(PAPER_W - 7, y); g.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const x = 10 + ((PAPER_W - 20) * (i + 0.5)) / 8;
    text(g, String(i + 1), x, 9.4, 2.2, { align: 'center', color: pal.faint });
  }
  for (let i = 0; i < 6; i++) {
    const y = 10 + ((PAPER_H - 20) * (i + 0.5)) / 6;
    text(g, 'ABCDEF'[i], 8.5, y + 0.8, 2.2, { align: 'center', color: pal.faint });
  }

  // Title block.
  const t = L?.title ?? { x: PAPER_W - 116, y: PAPER_H - 54, w: 106, h: 44 };
  g.fillStyle = pal.paper;
  g.fillRect(t.x, t.y, t.w, t.h);
  g.lineWidth = 0.5;
  g.strokeRect(t.x, t.y, t.w, t.h);
  g.lineWidth = 0.18;
  const rows = [t.y + 15, t.y + 22, t.y + 29.5, t.y + 37];
  g.beginPath();
  for (const y of rows) { g.moveTo(t.x, y); g.lineTo(t.x + t.w, y); }
  g.moveTo(t.x + t.w / 2, rows[1]); g.lineTo(t.x + t.w / 2, t.y + t.h);
  g.stroke();
  const fit = (s: string, size: number, maxW: number, weight = 700) => {
    g.font = `${weight} ${size}px ${FONT}`;
    const w = g.measureText(s).width;
    return w > maxW ? size * (maxW / w) : size;
  };
  const name = d.name.toUpperCase();
  text(g, name, t.x + t.w / 2, t.y + 10.5, fit(name, 8, t.w - 6), { weight: 700, align: 'center', color: pal.text });
  text(g, s.subtitle.toUpperCase(), t.x + t.w / 2, t.y + 20, fit(s.subtitle.toUpperCase(), 3.6, t.w - 6, 600), { weight: 600, align: 'center', color: pal.text });
  const cell = (label: string, value: string, x: number, y0: number, y1: number) => {
    text(g, label, x + 1.5, y0 + 2.6, 1.9, { color: pal.faint });
    text(g, value, x + 1.5, y1 - 1.6, fit(value, 3, t.w / 2 - 3, 600), { weight: 600, color: pal.text });
  };
  const today = new Date();
  const date = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth() + 1).toString().padStart(2, '0')}.${today.getFullYear()}`;
  cell('PATTERN / CLASS', (s.pattern || ROLE[d.settings.environment] || '').toUpperCase(), t.x, rows[1], rows[2]);
  cell('SCALE', L ? `1 : ${L.N}` : '—', t.x + t.w / 2, rows[1], rows[2]);
  cell('DRAWN BY', (s.drawnBy || '—').toUpperCase(), t.x, rows[2], rows[3]);
  cell('DATE', date, t.x + t.w / 2, rows[2], rows[3]);
  cell('UNITS', 'METRES · KILOGRAMS', t.x, rows[3], t.y + t.h);
  cell('SHEET', '1 OF 1 · A3', t.x + t.w / 2, rows[3], t.y + t.h);
  if (L) {
    // Graphic scale bar in metres, just above the title block.
    const k = 1000 / L.N;
    const target = 40 / k;
    const nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500].find((v) => v >= target / 4) ?? 1000;
    const seg = nice * k;
    const x0 = t.x + 2, y0 = t.y - 6;
    if (!L.specs) {
      g.lineWidth = 0.18;
      for (let i = 0; i < 4; i++) {
        g.fillStyle = i % 2 ? pal.paper : pal.ink;
        g.fillRect(x0 + i * seg, y0, seg, 1.2);
        g.strokeRect(x0 + i * seg, y0, seg, 1.2);
        text(g, `${+(i * nice).toFixed(2)}`, x0 + i * seg, y0 - 0.8, 2, { align: 'center', color: pal.text });
      }
      text(g, `${+(4 * nice).toFixed(2)} m`, x0 + 4 * seg, y0 - 0.8, 2, { align: 'center', color: pal.text });
    }
  }

  // Particulars.
  if (L?.specs) {
    const r = L.specs;
    const rowsP = particulars(d, a);
    g.fillStyle = pal.paper;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.lineWidth = 0.5;
    g.strokeStyle = pal.ink;
    g.strokeRect(r.x, r.y, r.w, r.h);
    text(g, 'PRINCIPAL PARTICULARS', r.x + 2, r.y + 4.6, 3, { weight: 700, color: pal.text });
    g.lineWidth = 0.18;
    g.beginPath(); g.moveTo(r.x, r.y + 6.5); g.lineTo(r.x + r.w, r.y + 6.5); g.stroke();
    const rh = Math.min(4.2, (r.h - 8) / Math.max(1, rowsP.length));
    rowsP.forEach(([k, v], i) => {
      const y = r.y + 6.5 + (i + 1) * rh - 1.1;
      text(g, k.toUpperCase(), r.x + 2, y, 2.3, { color: pal.faint });
      text(g, v, r.x + 36, y, fit(v, 2.6, r.w - 38, 600), { weight: 600, color: pal.text });
    });
  }
}

export const PALETTES_DESK: Record<SheetSettings['style'], string> = { line: PALETTES.line.desk, shaded: PALETTES.shaded.desk };

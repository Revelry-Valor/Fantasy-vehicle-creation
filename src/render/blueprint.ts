import { getDef } from '../core/catalog';
import { localToWorld } from '../core/geometry';
import { getMaterial } from '../core/materials';
import {
  DEFAULT_PEN_OPTIONS, drawFloor, drawFraming, drawHullSides, drawRoom, drawSupport, endpoints, floorTypeOf,
  isSegmentLike, layerOf, moveEndpoint, outwardSign, outOfPlane, resolveLayers, toPlane, toWorld,
  type P2, type PenKind, type PenOptions, type PlaneView, type ResolvedLayer,
} from '../core/pens';
import type { Store } from '../core/store';
import type { PartInstance, Vec3 } from '../core/types';

export type BlueprintTool = 'select' | 'pen' | 'place' | 'layer';

interface Shape2D {
  part: PartInstance;
  poly: P2[];
  min: P2;
  max: P2;
  depth: number;
  ends: [P2, P2] | null;
  dim: boolean;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; u: number; v: number }
  | { kind: 'body'; start: P2; orig: Map<string, Vec3>; moved: boolean; anchor: P2[] }
  | { kind: 'end'; targets: { id: string; end: 0 | 1 }[]; moved: boolean }
  | { kind: 'width'; id: string; moved: boolean }
  | { kind: 'marquee'; start: P2; now: P2; additive: boolean };

interface Snap {
  p: P2;
  kind: 'point' | 'edge' | 'grid' | 'free';
  guides: { u?: number; v?: number }[];
}

const SNAP_PX = 11;
const EDGE_PX = 8;
const ALIGN_PX = 6;

/**
 * The 2D blueprint editor: a side profile (length × height) and a top plan
 * (length × width) drawn on a canvas. Pens create real parts; the select tool
 * moves whole parts or just one end of one part.
 */
export class Blueprint {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  view: PlaneView = 'side';
  tool: BlueprintTool = 'pen';
  pen: PenKind = 'floor';
  opts: PenOptions = { ...DEFAULT_PEN_OPTIONS };
  placeType: string | null = null;
  snapStep = 0.25;
  activeLayerId: string | null = null;
  /** Top view: show every part, or only the layers ticked visible. */
  showAllLayers = true;

  onStatus: (msg: string) => void = () => {};
  onToolChange: () => void = () => {};

  private cam = { u: 0, v: 2, scale: 40 };
  private dirty = true;
  private shapes: Shape2D[] = [];
  private shapesRev = -1;
  private shapesKey = '';
  private chain: P2[] = [];
  private chainParts: string[] = [];
  private hover: Snap | null = null;
  private hoverPart: string | null = null;
  private hoverHandle: { id: string; end: 0 | 1 } | null = null;
  private drag: Drag | null = null;
  private spaceDown = false;
  private shiftDown = false;
  visible = true;

  constructor(private container: HTMLElement, private store: Store) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'blueprint';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.bind();
    this.resize();
    const loop = () => {
      if (this.dirty && this.visible) this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() {
    this.dirty = true;
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.canvas.hidden = !v;
    if (v) { this.resize(); this.invalidate(); }
  }

  setView(v: PlaneView) {
    this.cancelChain();
    this.view = v;
    this.cam.v = v === 'side' ? Math.max(2, this.cam.v) : 0;
    this.fit();
    this.invalidate();
  }

  setTool(t: BlueprintTool, extra?: { pen?: PenKind; placeType?: string | null }) {
    this.cancelChain();
    this.tool = t;
    if (extra?.pen) this.pen = extra.pen;
    this.placeType = t === 'place' ? extra?.placeType ?? this.placeType : null;
    this.hover = null;
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.status();
    this.onToolChange();
    this.invalidate();
  }

  layers(): ResolvedLayer[] {
    return resolveLayers(this.store.design);
  }

  activeLayer(): ResolvedLayer | null {
    const ls = this.layers();
    return ls.find((l) => l.id === this.activeLayerId) ?? ls[0] ?? null;
  }

  private layerY(): number {
    return this.activeLayer()?.y ?? 0;
  }

  // ── Coordinates ───────────────────────────────────────────────────────────
  private get W() { return this.canvas.clientWidth; }
  private get H() { return this.canvas.clientHeight; }

  toScreen(p: P2): { x: number; y: number } {
    return { x: this.W / 2 + (p.u - this.cam.u) * this.cam.scale, y: this.H / 2 - (p.v - this.cam.v) * this.cam.scale };
  }

  toPlaneXY(x: number, y: number): P2 {
    return { u: this.cam.u + (x - this.W / 2) / this.cam.scale, v: this.cam.v - (y - this.H / 2) / this.cam.scale };
  }

  private eventPoint(e: MouseEvent): P2 {
    const r = this.canvas.getBoundingClientRect();
    return this.toPlaneXY(e.clientX - r.left, e.clientY - r.top);
  }

  fit() {
    const shapes = this.getShapes().filter((s) => !s.dim);
    if (!shapes.length) {
      this.cam = { u: 0, v: this.view === 'side' ? 2 : 0, scale: 40 };
      this.invalidate();
      return;
    }
    const min = { u: Infinity, v: Infinity }, max = { u: -Infinity, v: -Infinity };
    for (const s of shapes) {
      min.u = Math.min(min.u, s.min.u); min.v = Math.min(min.v, s.min.v);
      max.u = Math.max(max.u, s.max.u); max.v = Math.max(max.v, s.max.v);
    }
    this.cam.u = (min.u + max.u) / 2;
    this.cam.v = (min.v + max.v) / 2;
    const w = Math.max(2, max.u - min.u), h = Math.max(2, max.v - min.v);
    this.cam.scale = Math.max(4, Math.min(400, Math.min((this.W - 120) / w, (this.H - 120) / h)));
    this.invalidate();
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  // ── Shapes ────────────────────────────────────────────────────────────────
  private getShapes(): Shape2D[] {
    const key = `${this.view}|${this.showAllLayers}|${this.activeLayerId}|${JSON.stringify(this.store.design.layers ?? [])}`;
    if (this.shapesRev === this.store.revision && this.shapesKey === key) return this.shapes;
    this.shapesRev = this.store.revision;
    this.shapesKey = key;
    const layers = this.layers();
    const active = this.activeLayer();
    const filterTop = this.view === 'top' && layers.length > 0;
    const out: Shape2D[] = [];
    for (const p of this.store.design.parts) {
      let dim = false;
      if (filterTop) {
        const l = layerOf(p, layers);
        const shown = l ? l.visible : false;
        if (!shown && !this.showAllLayers) continue;
        dim = !shown || (!!active && l?.id !== active.id);
      }
      const poly = this.project(p);
      const min = { u: Math.min(...poly.map((q) => q.u)), v: Math.min(...poly.map((q) => q.v)) };
      const max = { u: Math.max(...poly.map((q) => q.u)), v: Math.max(...poly.map((q) => q.v)) };
      const ends = isSegmentLike(p) ? (endpoints(p).map((w) => toPlane(this.view, w)) as [P2, P2]) : null;
      // Draw far things first. Side view looks from −X; top view from above.
      const depth = this.view === 'side' ? -p.position[0] : p.position[1];
      out.push({ part: p, poly, min, max, ends, depth, dim });
    }
    out.sort((a, b) => {
      const ca = getDef(a.part.type).compartment ? -1e9 : 0, cb = getDef(b.part.type).compartment ? -1e9 : 0;
      return ca - cb || Number(b.dim) - Number(a.dim) || a.depth - b.depth;
    });
    this.shapes = out;
    return out;
  }

  private project(p: PartInstance): P2[] {
    if (p.type === 'hullSides' && this.view === 'side' && p.points) {
      const out: P2[] = [];
      for (let i = 0; i + 2 < p.points.length; i += 3) out.push({ u: p.position[2] + p.points[i + 2], v: p.position[1] + p.points[i + 1] });
      return out;
    }
    const [hx, hy, hz] = p.size.map((s) => s / 2);
    const pts: P2[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(toPlane(this.view, localToWorld(p, [sx * hx, sy * hy, sz * hz])));
    }
    return convexHull(pts);
  }

  // ── Connection points & snapping ──────────────────────────────────────────
  private connectionPoints(exclude: Set<string>): P2[] {
    const pts: P2[] = [];
    for (const s of this.getShapes()) {
      if (exclude.has(s.part.id) || s.dim) continue;
      if (s.ends) pts.push(...s.ends);
      else if (!getDef(s.part.type).compartment && s.part.type !== 'hullSides') pts.push(...s.poly);
    }
    for (const c of this.chain) pts.push(c);
    return pts;
  }

  private snap(raw: P2, opts: { exclude?: Set<string>; from?: P2; angle?: 'hv' | 'deg15' | null } = {}): Snap {
    const exclude = opts.exclude ?? new Set<string>();
    const k = this.cam.scale;
    const guides: Snap['guides'] = [];
    let p = { ...raw };
    let constrained = false;
    if (opts.from && opts.angle) {
      const du = raw.u - opts.from.u, dv = raw.v - opts.from.v;
      const len = Math.hypot(du, dv);
      if (len > 1e-6) {
        const step = opts.angle === 'hv' ? Math.PI / 2 : Math.PI / 12;
        const a = Math.round(Math.atan2(dv, du) / step) * step;
        let l = len;
        if (this.snapStep) l = Math.max(this.snapStep, Math.round(l / this.snapStep) * this.snapStep);
        p = { u: opts.from.u + Math.cos(a) * l, v: opts.from.v + Math.sin(a) * l };
        constrained = true;
      }
    }
    // 1. Connection points win outright.
    const cps = this.connectionPoints(exclude);
    let best: P2 | null = null, bestD = SNAP_PX / k;
    for (const c of cps) {
      const d = Math.hypot(c.u - raw.u, c.v - raw.v);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) return { p: { ...best }, kind: 'point', guides };
    if (constrained) {
      // Stretch a constrained line to meet a nearby surface along its own axis.
      const e = this.nearestEdge(p, exclude, opts.from);
      if (e) return { p: e, kind: 'edge', guides };
      return { p, kind: 'grid', guides };
    }
    // 2. Surfaces of other parts.
    const edge = this.nearestEdge(raw, exclude);
    if (edge) return { p: edge, kind: 'edge', guides };
    // 3. Line up with existing points, then 4. the grid.
    let alignedU = false, alignedV = false;
    for (const c of cps) {
      if (!alignedU && Math.abs(c.u - raw.u) * k < ALIGN_PX) { p.u = c.u; alignedU = true; guides.push({ u: c.u }); }
      if (!alignedV && Math.abs(c.v - raw.v) * k < ALIGN_PX) { p.v = c.v; alignedV = true; guides.push({ v: c.v }); }
    }
    if (this.snapStep) {
      if (!alignedU) p.u = Math.round(p.u / this.snapStep) * this.snapStep;
      if (!alignedV) p.v = Math.round(p.v / this.snapStep) * this.snapStep;
    }
    return { p, kind: guides.length ? 'point' : this.snapStep ? 'grid' : 'free', guides };
  }

  /** Nearest point on the outline of a visible part, if within reach. */
  private nearestEdge(raw: P2, exclude: Set<string>, along?: P2): P2 | null {
    const k = this.cam.scale;
    let best: P2 | null = null, bestD = EDGE_PX / k;
    for (const s of this.getShapes()) {
      if (exclude.has(s.part.id) || s.dim || getDef(s.part.type).compartment) continue;
      const n = s.poly.length;
      for (let i = 0; i < n; i++) {
        const a = s.poly[i], b = s.poly[(i + 1) % n];
        const q = along ? intersectRayWithSegment(along, raw, a, b) : closestOnSegment(raw, a, b);
        if (!q) continue;
        const d = Math.hypot(q.u - raw.u, q.v - raw.v);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    return best;
  }

  // ── Picking ───────────────────────────────────────────────────────────────
  /** The smallest part under the point; rooms and hull walls only as a last resort. */
  private partAt(p: P2): string | null {
    const tol = 5 / this.cam.scale;
    let best: string | null = null, bestScore = Infinity;
    for (const s of this.getShapes()) {
      if (s.dim) continue;
      const near = distToPolygon(p, s.poly);
      if (!pointInPolygon(p, s.poly) && near >= tol) continue;
      const background = getDef(s.part.type).compartment || s.part.type === 'hullSides' || this.isAboveCut(s.part);
      // Hitting a part's outline counts as much as clicking inside a small one.
      const score = (near < tol ? 0 : polygonArea(s.poly)) + (background ? 1e6 : 0);
      if (score < bestScore) { bestScore = score; best = s.part.id; }
    }
    return best;
  }

  /**
   * The top plan is cut like an architect's floor plan, at chest height above
   * the active deck. Anything entirely above the cut is drawn as an outline.
   */
  private cutHeight(): number {
    const l = this.activeLayer();
    if (l) return l.y + 1.2;
    const floors = this.store.design.parts.filter((q) => q.type === 'deck');
    const lowest = floors.length ? Math.min(...floors.map((f) => f.position[1] + f.size[1] / 2)) : 0;
    return lowest + 1.2;
  }

  private isAboveCut(p: PartInstance): boolean {
    if (this.view !== 'top') return false;
    const [hx, hy, hz] = p.size.map((s) => s / 2);
    let minY = Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) minY = Math.min(minY, localToWorld(p, [sx * hx, sy * hy, sz * hz])[1]);
    return minY > this.cutHeight();
  }

  private handleAt(p: P2): { id: string; end: 0 | 1 } | null {
    const r = (SNAP_PX - 2) / this.cam.scale;
    const sel = new Set(this.store.selection);
    let best: { id: string; end: 0 | 1 } | null = null, bestD = r, bestSel = false;
    for (const s of this.getShapes()) {
      if (!s.ends || s.dim) continue;
      for (const end of [0, 1] as const) {
        const d = Math.hypot(s.ends[end].u - p.u, s.ends[end].v - p.v);
        const isSel = sel.has(s.part.id);
        // Prefer a selected part's handle when several parts meet at a point.
        if (d < r && ((isSel && !bestSel) || (isSel === bestSel && d < bestD))) {
          best = { id: s.part.id, end }; bestD = d; bestSel = isSel;
        }
      }
    }
    return best;
  }

  private widthHandleAt(p: P2): string | null {
    if (this.view !== 'top') return null;
    const r = (SNAP_PX - 2) / this.cam.scale;
    for (const id of this.store.selection) {
      const part = this.store.get(id);
      if (!part || part.type !== 'deck') continue;
      for (const w of this.widthHandles(part)) if (Math.hypot(w.u - p.u, w.v - p.v) < r) return id;
    }
    return null;
  }

  private widthHandles(p: PartInstance): P2[] {
    return [toPlane(this.view, localToWorld(p, [p.size[0] / 2, 0, 0])), toPlane(this.view, localToWorld(p, [-p.size[0] / 2, 0, 0]))];
  }

  // ── Events ────────────────────────────────────────────────────────────────
  private bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const before = this.toPlaneXY(x, y);
      const f = Math.exp(-e.deltaY * 0.0015);
      this.cam.scale = Math.max(2, Math.min(800, this.cam.scale * f));
      const after = this.toPlaneXY(x, y);
      this.cam.u += before.u - after.u;
      this.cam.v += before.v - after.v;
      this.invalidate();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('dblclick', () => { if (this.tool === 'pen' && this.pen === 'frame') this.finishChain(); });
    c.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' && this.visible && !isTyping(e)) { this.spaceDown = true; this.canvas.style.cursor = 'grab'; e.preventDefault(); }
      if (e.key === 'Shift') { this.shiftDown = true; this.invalidate(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') { this.spaceDown = false; this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair'; }
      if (e.key === 'Shift') { this.shiftDown = false; this.invalidate(); }
    });
  }

  /** Keyboard shortcuts while the blueprint is showing. Returns true if handled. */
  handleKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (this.chain.length) { this.finishChain(); return true; }
      if (this.tool !== 'select') { this.setTool('select'); return true; }
      return false;
    }
    if (k === 'enter' && this.chain.length) { this.finishChain(); return true; }
    if (k === 'f') { this.fit(); return true; }
    if (k === 'v') { this.setTool('select'); return true; }
    if (k === 'tab') { e.preventDefault(); this.setView(this.view === 'side' ? 'top' : 'side'); this.onToolChange(); return true; }
    const pens: Record<string, PenKind> = { '1': 'floor', '2': 'room', '3': 'support', '4': 'frame' };
    if (pens[k]) { this.setTool('pen', { pen: pens[k] }); return true; }
    return false;
  }

  private onDown(e: PointerEvent) {
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.eventPoint(e);
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      if (e.button === 2 && this.chain.length) { this.finishChain(); return; }
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, u: this.cam.u, v: this.cam.v };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    if (this.tool === 'pen') return this.penClick(e);
    if (this.tool === 'place') return this.placeClick();
    if (this.tool === 'layer') {
      const id = this.partAt(p);
      const part = id ? this.store.get(id) : null;
      if (part?.type === 'deck') {
        const l = this.store.makeLayer(part.id);
        if (l) { this.activeLayerId = l.id; this.onStatus(`"${l.name}" is now a layer at ${(part.position[1] + part.size[1] / 2).toFixed(2)} m. Rename it in the Layers list.`); }
        this.onToolChange();
      } else this.onStatus('Click a floor to turn it into a layer.');
      return;
    }
    // Select tool
    const w = this.widthHandleAt(p);
    if (w) {
      this.store.snapshot();
      this.drag = { kind: 'width', id: w, moved: false };
      return;
    }
    const h = this.handleAt(p);
    if (h) {
      this.store.snapshot();
      let targets = [h];
      if (e.shiftKey) {
        // Shift: move every end that meets at this joint.
        const part = this.store.get(h.id)!;
        const at = endpoints(part)[h.end];
        targets = [];
        for (const s of this.getShapes()) {
          if (!s.ends || s.dim) continue;
          const ends = endpoints(s.part);
          for (const end of [0, 1] as const) if (dist3(ends[end], at) < 0.03) targets.push({ id: s.part.id, end });
        }
      }
      if (!this.store.selection.includes(h.id)) this.store.select([h.id]);
      this.drag = { kind: 'end', targets, moved: false };
      return;
    }
    const id = this.partAt(p);
    if (!id) {
      this.drag = { kind: 'marquee', start: p, now: p, additive: e.shiftKey };
      if (!e.shiftKey) this.store.select([]);
      return;
    }
    if (e.shiftKey) this.store.toggleSelect(id);
    else if (!this.store.selection.includes(id)) this.store.select([id]);
    const orig = new Map<string, Vec3>();
    const anchor: P2[] = [];
    for (const sid of this.store.selection) {
      const part = this.store.get(sid);
      if (!part) continue;
      orig.set(sid, [...part.position] as Vec3);
      if (isSegmentLike(part)) anchor.push(...endpoints(part).map((w) => toPlane(this.view, w)));
      else anchor.push(toPlane(this.view, part.position));
    }
    this.store.snapshot();
    this.drag = { kind: 'body', start: p, orig, moved: false, anchor };
  }

  private onMove(e: PointerEvent) {
    const raw = this.eventPoint(e);
    const d = this.drag;
    if (d?.kind === 'pan') {
      this.cam.u = d.u - (e.clientX - d.sx) / this.cam.scale;
      this.cam.v = d.v + (e.clientY - d.sy) / this.cam.scale;
      this.invalidate();
      return;
    }
    if (d?.kind === 'marquee') { d.now = raw; this.invalidate(); return; }
    if (d?.kind === 'body') return this.dragBody(d, raw);
    if (d?.kind === 'end') return this.dragEnd(d, raw, e.altKey);
    if (d?.kind === 'width') return this.dragWidth(d, raw);

    if (this.tool === 'pen') {
      this.hover = this.penSnap(raw, e.shiftKey);
      this.status();
    } else if (this.tool === 'place') {
      this.hover = this.snap(raw);
    } else {
      this.hover = null;
      const h = this.handleAt(raw);
      const w = this.widthHandleAt(raw);
      this.hoverHandle = h;
      const id = h ? h.id : this.partAt(raw);
      this.hoverPart = id;
      this.canvas.style.cursor = this.spaceDown ? 'grab' : h || w ? 'move' : id ? 'pointer' : 'default';
      if (h) this.onStatus('Drag to move this end only · Shift-drag moves every end joined here');
      else if (id) {
        const p = this.store.get(id)!;
        this.onStatus(`${p.name || getDef(p.type).name} — drag to move · Shift-click to add to selection`);
      } else this.onStatus('');
    }
    this.invalidate();
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
    if (!d) return;
    if (d.kind === 'pan') { this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair'; return; }
    if (d.kind === 'marquee') {
      const a = d.start, b = d.now;
      const min = { u: Math.min(a.u, b.u), v: Math.min(a.v, b.v) }, max = { u: Math.max(a.u, b.u), v: Math.max(a.v, b.v) };
      if ((max.u - min.u) * this.cam.scale > 4 || (max.v - min.v) * this.cam.scale > 4) {
        const ids = this.getShapes().filter((s) => !s.dim && s.min.u >= min.u && s.max.u <= max.u && s.min.v >= min.v && s.max.v <= max.v).map((s) => s.part.id);
        this.store.select(ids, d.additive);
      }
      this.invalidate();
      return;
    }
    if (d.moved) this.store.emit('change');
    this.invalidate();
  }

  // ── Dragging ──────────────────────────────────────────────────────────────
  private dragBody(d: Extract<Drag, { kind: 'body' }>, raw: P2) {
    let du = raw.u - d.start.u, dv = raw.v - d.start.v;
    if (!d.moved && Math.hypot(du, dv) * this.cam.scale < 3) return;
    d.moved = true;
    // Magnet: pull one of the dragged part's ends onto a nearby connection point.
    const exclude = new Set(d.orig.keys());
    const cps = this.connectionPoints(exclude);
    let best: { du: number; dv: number } | null = null, bestD = SNAP_PX / this.cam.scale;
    for (const a of d.anchor) {
      const moved = { u: a.u + du, v: a.v + dv };
      for (const c of cps) {
        const dd = Math.hypot(c.u - moved.u, c.v - moved.v);
        if (dd < bestD) { bestD = dd; best = { du: c.u - a.u, dv: c.v - a.v }; }
      }
    }
    if (best) { du = best.du; dv = best.dv; }
    else if (this.snapStep) { du = Math.round(du / this.snapStep) * this.snapStep; dv = Math.round(dv / this.snapStep) * this.snapStep; }
    const handled = new Set<string>();
    for (const [id, pos] of d.orig) {
      if (handled.has(id)) continue;
      const part = this.store.get(id);
      if (part?.mirrorOf) handled.add(part.mirrorOf);
      const w = toPlane(this.view, pos);
      const np = toWorld(this.view, { u: w.u + du, v: w.v + dv }, outOfPlane(this.view, pos));
      this.store.updatePart(id, { position: np }, false);
    }
  }

  private dragEnd(d: Extract<Drag, { kind: 'end' }>, raw: P2, free: boolean) {
    const exclude = new Set(d.targets.map((t) => t.id));
    // Keep the grabbed end's partner fixed and snap the moving end.
    const first = this.store.get(d.targets[0].id);
    if (!first) return;
    const other = toPlane(this.view, endpoints(first)[d.targets[0].end === 0 ? 1 : 0]);
    const s = this.snap(raw, { exclude, from: this.shiftDown && d.targets.length === 1 ? other : undefined, angle: this.shiftDown && d.targets.length === 1 ? 'deg15' : null });
    const to = free ? raw : s.p;
    this.hover = s;
    d.moved = true;
    for (const t of d.targets) {
      const part = this.store.get(t.id);
      if (!part) continue;
      const w = endpoints(part)[t.end];
      const next = moveEndpoint(part, t.end, toWorld(this.view, to, outOfPlane(this.view, w)));
      if (next) this.store.updatePart(t.id, next, false);
    }
    const len = first.size[2];
    this.onStatus(`Length ${len.toFixed(2)} m · Shift = 15° steps · Alt = no snapping`);
  }

  private dragWidth(d: Extract<Drag, { kind: 'width' }>, raw: P2) {
    const part = this.store.get(d.id);
    if (!part) return;
    const c = toPlane(this.view, part.position);
    let half = Math.abs(raw.v - c.v);
    if (this.snapStep) half = Math.max(this.snapStep / 2, Math.round((half * 2) / this.snapStep) * this.snapStep / 2);
    d.moved = true;
    this.store.updatePart(d.id, { size: [half * 2, part.size[1], part.size[2]] }, false);
    this.onStatus(`Width ${(half * 2).toFixed(2)} m`);
  }

  // ── Pens ──────────────────────────────────────────────────────────────────
  private penSnap(raw: P2, shift: boolean): Snap {
    const from = this.chain[this.chain.length - 1];
    if (!from) return this.snap(raw);
    const horizontalOnly = (this.pen === 'floor' || this.pen === 'room') && this.view === 'side';
    if (horizontalOnly) {
      const s = this.snap({ u: raw.u, v: from.v }, { from, angle: 'hv' });
      return { ...s, p: { u: s.p.u, v: from.v } };
    }
    if (this.pen === 'support') return this.snap(raw, { from, angle: shift ? 'deg15' : 'hv' });
    if (this.pen === 'frame') return this.snap(raw, { from, angle: shift ? 'deg15' : null });
    return this.snap(raw, { from });
  }

  private penClick(e: PointerEvent) {
    const s = this.hover ?? this.penSnap(this.eventPoint(e), e.shiftKey);
    const p = s.p;
    const layerY = this.layerY();
    const floorT = floorTypeOf(this.opts).thickness;
    const add = (parts: PartInstance[]) => {
      if (!parts.length) return;
      // Pens that span the width sit on the centre line; anything already
      // paired is left alone, other off-centre parts follow the mirror switch.
      this.store.addParts(parts, false);
    };
    if (this.pen === 'support' && this.view === 'top' && this.opts.supportOrientation === 'pillar') {
      add(drawSupport('top', p, p, this.opts, layerY, floorT));
      this.onStatus('Pillar placed. Click to place another.');
      return;
    }
    if (!this.chain.length) {
      this.chain = [p];
      this.chainParts = [];
      this.status();
      this.invalidate();
      return;
    }
    const a = this.chain[this.chain.length - 1];
    if (Math.hypot(p.u - a.u, p.v - a.v) < 0.02) return;
    switch (this.pen) {
      case 'floor': add(drawFloor(this.view, a, p, this.opts, layerY)); this.chain = []; break;
      case 'room': add(drawRoom(this.view, a, p, this.opts, layerY)); this.chain = []; break;
      case 'support': add(drawSupport(this.view, a, p, this.opts, layerY, floorT)); this.chain = []; break;
      case 'frame': {
        const closes = this.chain.length >= 3 && Math.hypot(p.u - this.chain[0].u, p.v - this.chain[0].v) < 1e-6;
        const parts = drawFraming(this.view, [a, p], this.opts, layerY);
        add(parts);
        this.chainParts.push(...parts.map((q) => q.id));
        this.chain.push(p);
        if (closes) {
          this.finishChain(true);
          return;
        }
        break;
      }
    }
    this.status();
    this.invalidate();
  }

  /** End the current framing chain: fix which side is "outside", close the hull. */
  finishChain(closed = false) {
    const chain = this.chain;
    const ids = this.chainParts;
    this.chain = [];
    this.chainParts = [];
    if (this.pen === 'frame' && chain.length >= 2 && ids.length) {
      const c = chain.reduce((acc, q) => ({ u: acc.u + q.u / chain.length, v: acc.v + q.v / chain.length }), { u: 0, v: 0 });
      for (const id of ids) {
        const part = this.store.get(id);
        if (!part) continue;
        const mid = toPlane(this.view, part.position);
        this.store.updatePart(id, { props: { outSign: outwardSign(this.view, part, { u: mid.u - c.u, v: mid.v - c.v }) } }, false);
      }
      if (closed && this.view === 'side') {
        const sides = drawHullSides(chain, this.opts);
        if (sides) {
          this.store.addParts([sides], false);
          this.onStatus(`Hull closed: ${(sides.props.area as number).toFixed(1)} m² profile × ${this.opts.width} m wide = ${(sides.props.volume as number).toFixed(1)} m³ enclosed.`);
        }
      }
      this.store.emit('change');
    }
    this.invalidate();
  }

  private cancelChain() {
    if (this.chain.length) this.finishChain();
  }

  private placeClick() {
    if (!this.placeType || !this.hover) return;
    const part = this.store.makePart(this.placeType, [0, 0, 0]);
    const p = this.hover.p;
    if (this.view === 'side') {
      part.position = [0, p.v + part.size[1] / 2, p.u];
    } else {
      part.position = [p.v, this.layerY() + part.size[1] / 2, p.u];
    }
    this.store.addParts([part], false);
  }

  private status() {
    if (this.tool === 'select') return this.onStatus('Click to select · drag to move · drag an end dot to move just that end · drag empty space to box-select · right-drag or Space-drag to pan');
    if (this.tool === 'layer') return this.onStatus('Click a floor to make it a layer.');
    if (this.tool === 'place') return this.onStatus(`Click to place ${this.placeType ? getDef(this.placeType).name : 'part'}${this.view === 'top' ? ' on the active layer' : ''}. Esc to stop.`);
    const names: Record<PenKind, string> = { floor: 'Floor', room: 'Floor + ceiling', support: 'Supports', frame: 'Framing' };
    const started = this.chain.length > 0;
    let hint = '';
    if (this.pen === 'frame') hint = started ? 'Click to add the next point · click the first point to close the hull · Enter/Esc/double-click to finish · Shift = 15° steps' : 'Click to start drawing the outline';
    else if (this.pen === 'support' && this.view === 'top' && this.opts.supportOrientation === 'pillar') hint = 'Click to stand a pillar on the active layer';
    else if (this.view === 'top' && (this.pen === 'floor' || this.pen === 'room')) hint = started ? 'Click the opposite corner' : 'Click the first corner';
    else hint = started ? 'Click to finish' + (this.pen === 'support' ? ' · Shift = any angle' : '') : 'Click to start';
    const len = started && this.hover ? ` · ${Math.hypot(this.hover.p.u - this.chain[this.chain.length - 1].u, this.hover.p.v - this.chain[this.chain.length - 1].v).toFixed(2)} m` : '';
    this.onStatus(`${names[this.pen]}: ${hint}${len}`);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  private render() {
    this.dirty = false;
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const css = getComputedStyle(document.documentElement);
    const col = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
    ctx.fillStyle = col('--bp-bg', '#10263d');
    ctx.fillRect(0, 0, W, H);
    this.drawGrid();
    this.drawLayerLines();
    const shapes = this.getShapes();
    const sel = new Set(this.store.selection);
    for (const s of shapes) this.drawShape(s, sel.has(s.part.id), this.hoverPart === s.part.id);
    // Connection points
    if (this.tool !== 'place') {
      for (const s of shapes) {
        if (!s.ends || s.dim) continue;
        const isSel = sel.has(s.part.id);
        for (const end of [0, 1] as const) {
          const q = this.toScreen(s.ends[end]);
          const hot = this.hoverHandle && this.hoverHandle.id === s.part.id && this.hoverHandle.end === end;
          ctx.beginPath();
          ctx.arc(q.x, q.y, hot ? 6 : isSel ? 5 : 3, 0, Math.PI * 2);
          ctx.fillStyle = hot ? '#ffd35a' : isSel ? '#5fb4ff' : 'rgba(210,230,255,0.55)';
          ctx.fill();
          if (isSel || hot) { ctx.strokeStyle = '#0b1a2a'; ctx.lineWidth = 1.5; ctx.stroke(); }
        }
      }
      for (const id of this.store.selection) {
        const part = this.store.get(id);
        if (part?.type === 'deck' && this.view === 'top') {
          for (const w of this.widthHandles(part)) {
            const q = this.toScreen(w);
            ctx.fillStyle = '#5fb4ff';
            ctx.fillRect(q.x - 5, q.y - 5, 10, 10);
          }
        }
      }
    }
    this.drawPenPreview();
    this.drawMarquee();
    this.drawScale();
    this.drawCompass();
  }

  private drawGrid() {
    const ctx = this.ctx;
    const k = this.cam.scale;
    const tl = this.toPlaneXY(0, 0), br = this.toPlaneXY(this.W, this.H);
    const lines = (step: number, style: string, width: number) => {
      if (step * k < 5) return;
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let u = Math.floor(tl.u / step) * step; u <= br.u; u += step) { const x = this.toScreen({ u, v: 0 }).x; ctx.moveTo(x, 0); ctx.lineTo(x, this.H); }
      for (let v = Math.floor(br.v / step) * step; v <= tl.v; v += step) { const y = this.toScreen({ u: 0, v }).y; ctx.moveTo(0, y); ctx.lineTo(this.W, y); }
      ctx.stroke();
    };
    if (this.snapStep && this.snapStep < 1) lines(this.snapStep, 'rgba(120,170,220,0.10)', 1);
    lines(1, 'rgba(120,170,220,0.20)', 1);
    lines(5, 'rgba(140,190,240,0.32)', 1);
    // Datum lines: ground (side) / centre line (top), and midships.
    const o = this.toScreen({ u: 0, v: 0 });
    ctx.strokeStyle = 'rgba(160,210,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, o.y); ctx.lineTo(this.W, o.y);
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.H);
    ctx.stroke();
    ctx.fillStyle = 'rgba(180,215,250,0.7)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(this.view === 'side' ? 'ground' : 'centre line', 8, o.y - 5);
    // Ruler labels
    const step = niceStep(80 / k);
    ctx.fillStyle = 'rgba(180,215,250,0.6)';
    for (let u = Math.ceil(tl.u / step) * step; u <= br.u; u += step) ctx.fillText(`${+u.toFixed(2)}`, this.toScreen({ u, v: 0 }).x + 3, this.H - 6);
    for (let v = Math.ceil(br.v / step) * step; v <= tl.v; v += step) ctx.fillText(`${+v.toFixed(2)}`, 4, this.toScreen({ u: 0, v }).y - 3);
  }

  private drawLayerLines() {
    if (this.view !== 'side') return;
    const ctx = this.ctx;
    const active = this.activeLayer();
    for (const l of this.layers()) {
      const y = this.toScreen({ u: 0, v: l.y }).y;
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = l.id === active?.id ? 'rgba(255,211,90,0.8)' : 'rgba(255,211,90,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,211,90,0.9)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(`${l.name}  ${l.y.toFixed(2)} m`, 8, y - 4);
    }
  }

  private drawShape(s: Shape2D, selected: boolean, hovered: boolean) {
    const ctx = this.ctx;
    const def = getDef(s.part.type);
    const pts = s.poly.map((q) => this.toScreen(q));
    if (pts.length < 2) return;
    ctx.globalAlpha = s.dim ? 0.25 : 1;
    const path = () => {
      ctx.beginPath();
      if (def.shape === 'ellipsoid' && this.view && pts.length > 2) {
        const a = this.toScreen(s.min), b = this.toScreen(s.max);
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        return;
      }
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
    };
    const mat = getMaterial(s.part.material);
    const hex = `#${mat.color.toString(16).padStart(6, '0')}`;
    if (def.compartment) {
      path();
      ctx.fillStyle = 'rgba(74,163,255,0.08)';
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = selected ? '#5fb4ff' : 'rgba(110,180,255,0.6)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(150,200,255,0.8)';
      ctx.font = '11px system-ui, sans-serif';
      const c = this.toScreen({ u: (s.min.u + s.max.u) / 2, v: s.max.v });
      ctx.fillText(String(s.part.props.label || 'Room'), c.x - 14, c.y + 13);
      ctx.globalAlpha = 1;
      return;
    }
    path();
    const above = this.isAboveCut(s.part);
    const outlineOnly = above || (this.view === 'top' && s.part.type === 'hullSides');
    const fillAlpha = outlineOnly ? 0.04 : def.envelope ? 0.25 : s.part.type === 'hullSides' ? 0.18 : 0.85;
    ctx.fillStyle = withAlpha(hex, fillAlpha);
    ctx.fill();
    if (above) ctx.setLineDash([6, 4]);
    ctx.strokeStyle = selected ? '#5fb4ff' : hovered ? '#d6ecff' : above ? withAlpha(hex, 0.8) : shade(hex, -0.45);
    ctx.lineWidth = selected ? 2.5 : hovered ? 2 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    if (above) { ctx.globalAlpha = 1; return; }
    // Framing skins: a bold line on the plated face(s).
    if (s.part.type === 'frame' && s.ends) {
      const sign = Number(s.part.props.outSign ?? 1) >= 0 ? 1 : -1;
      for (const [key, side] of [['skinOuter', sign], ['skinInner', -sign]] as const) {
        const m = String(s.part.props[key] ?? 'none');
        if (m === 'none') continue;
        const off = side * (s.part.size[1] / 2 + Number(s.part.props.skinThickness ?? 0.03) / 2);
        const a = toPlane(this.view, localToWorld(s.part, [0, off, -s.part.size[2] / 2]));
        const b = toPlane(this.view, localToWorld(s.part, [0, off, s.part.size[2] / 2]));
        const A = this.toScreen(a), B = this.toScreen(b);
        ctx.strokeStyle = `#${getMaterial(m).color.toString(16).padStart(6, '0')}`;
        ctx.lineWidth = Math.max(3, Number(s.part.props.skinThickness ?? 0.03) * this.cam.scale);
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
    }
    // Small parts get a label so the plan stays readable.
    if (!def.structural && !def.conduit && def.layer !== 'hull' && (s.max.u - s.min.u) * this.cam.scale > 34) {
      ctx.fillStyle = 'rgba(235,245,255,0.9)';
      ctx.font = '10px system-ui, sans-serif';
      const c = this.toScreen({ u: (s.min.u + s.max.u) / 2, v: (s.min.v + s.max.v) / 2 });
      const label = s.part.name || def.name;
      ctx.fillText(label, c.x - ctx.measureText(label).width / 2, c.y + 3);
    }
    ctx.globalAlpha = 1;
  }

  private drawPenPreview() {
    const ctx = this.ctx;
    const h = this.hover;
    if (h) {
      for (const g of h.guides) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,211,90,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.u !== undefined) { const x = this.toScreen({ u: g.u, v: 0 }).x; ctx.moveTo(x, 0); ctx.lineTo(x, this.H); }
        if (g.v !== undefined) { const y = this.toScreen({ u: 0, v: g.v }).y; ctx.moveTo(0, y); ctx.lineTo(this.W, y); }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.tool === 'place' && h && this.placeType) {
      const part = this.store.makePart(this.placeType, [0, 0, 0]);
      part.position = this.view === 'side' ? [0, h.p.v + part.size[1] / 2, h.p.u] : [h.p.v, this.layerY() + part.size[1] / 2, h.p.u];
      const poly = this.project(part).map((q) => this.toScreen(q));
      ctx.beginPath();
      poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(95,180,255,0.3)';
      ctx.fill();
      ctx.strokeStyle = '#5fb4ff';
      ctx.stroke();
    }
    if (this.tool !== 'pen' || !h) return;
    const p = this.toScreen(h.p);
    // Snap marker
    ctx.strokeStyle = h.kind === 'point' ? '#ffd35a' : h.kind === 'edge' ? '#7dffb0' : '#9fd0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (h.kind === 'point') ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    else if (h.kind === 'edge') { ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x, p.y - 7); ctx.lineTo(p.x + 7, p.y); ctx.lineTo(p.x, p.y + 7); ctx.closePath(); }
    else { ctx.moveTo(p.x - 6, p.y); ctx.lineTo(p.x + 6, p.y); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x, p.y + 6); }
    ctx.stroke();
    if (!this.chain.length) return;
    const a = this.chain[this.chain.length - 1];
    const A = this.toScreen(a);
    const rect = this.view === 'top' && (this.pen === 'floor' || this.pen === 'room');
    ctx.strokeStyle = '#ffd35a';
    ctx.fillStyle = 'rgba(255,211,90,0.15)';
    ctx.lineWidth = 2;
    if (this.pen === 'frame') {
      ctx.beginPath();
      this.chain.forEach((q, i) => { const s = this.toScreen(q); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      const s0 = this.toScreen(this.chain[0]);
      ctx.beginPath(); ctx.arc(s0.x, s0.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    if (rect) {
      ctx.rect(Math.min(A.x, p.x), Math.min(A.y, p.y), Math.abs(p.x - A.x), Math.abs(p.y - A.y));
      ctx.fill();
    } else if (this.pen === 'room' && this.view === 'side') {
      const hPx = this.opts.ceilingHeight * this.cam.scale;
      ctx.rect(Math.min(A.x, p.x), A.y - hPx, Math.abs(p.x - A.x), hPx);
      ctx.fill();
    } else {
      ctx.moveTo(A.x, A.y); ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    const du = h.p.u - a.u, dv = h.p.v - a.v;
    const len = Math.hypot(du, dv);
    const label = rect ? `${Math.abs(du).toFixed(2)} × ${Math.abs(dv).toFixed(2)} m` : `${len.toFixed(2)} m  ${(((Math.atan2(dv, du) * 180) / Math.PI + 360) % 360).toFixed(0)}°`;
    ctx.font = '600 12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,25,40,0.85)';
    ctx.fillRect(p.x + 12, p.y + 10, tw + 10, 20);
    ctx.fillStyle = '#ffd35a';
    ctx.fillText(label, p.x + 17, p.y + 24);
  }

  private drawMarquee() {
    const d = this.drag;
    if (d?.kind !== 'marquee') return;
    const a = this.toScreen(d.start), b = this.toScreen(d.now);
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(95,180,255,0.12)';
    ctx.strokeStyle = '#5fb4ff';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }

  /** Scale bar with a crew member drawn to scale, bottom-left. */
  private drawScale() {
    const ctx = this.ctx;
    const k = this.cam.scale;
    const step = niceStep(100 / k);
    const x0 = 20, y0 = this.H - 30;
    ctx.strokeStyle = '#d6ecff';
    ctx.fillStyle = '#d6ecff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + step * k, y0); ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 5); ctx.moveTo(x0 + step * k, y0 - 5); ctx.lineTo(x0 + step * k, y0 + 5); ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${step} m`, x0 + step * k / 2 - 10, y0 - 8);
    if (this.view !== 'side') return;
    // Crew silhouette
    const hgt = this.store.design.settings.crewHeight * k;
    if (hgt < 12) return;
    const cx = x0 + step * k + 30, base = y0 + 5;
    ctx.fillStyle = 'rgba(214,236,255,0.75)';
    const headR = hgt * 0.07;
    ctx.beginPath(); ctx.arc(cx, base - hgt + headR, headR, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(cx - hgt * 0.1, base - hgt + headR * 2.2, hgt * 0.2, hgt * 0.4);
    ctx.fillRect(cx - hgt * 0.09, base - hgt * 0.47, hgt * 0.07, hgt * 0.47);
    ctx.fillRect(cx + hgt * 0.02, base - hgt * 0.47, hgt * 0.07, hgt * 0.47);
    ctx.fillText(`${this.store.design.settings.crewHeight} m crew`, cx + hgt * 0.18, base - 4);
  }

  private drawCompass() {
    const ctx = this.ctx;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(180,215,250,0.8)';
    const lines = [this.view === 'side' ? 'SIDE PROFILE  ·  stern ◂  ▸ bow' : 'TOP PLAN  ·  stern ◂  ▸ bow'];
    if (this.view === 'top') {
      const l = this.activeLayer();
      lines.push(this.layers().length ? `Drawing on ${l?.name ?? '—'} (${(l?.y ?? 0).toFixed(2)} m)` : 'No layers yet: drawing at ground level. Make a floor into a layer to draw on it.');
      lines.push(`Cut at ${this.cutHeight().toFixed(2)} m · dashed = above the cut`);
    }
    lines.forEach((t, i) => ctx.fillText(t, this.W - ctx.measureText(t).width - 12, this.H - 30 - (lines.length - 1 - i) * 16));
  }
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
function convexHull(points: P2[]): P2[] {
  const pts = points.map((p) => ({ u: Math.round(p.u * 1e5) / 1e5, v: Math.round(p.v * 1e5) / 1e5 }))
    .sort((a, b) => a.u - b.u || a.v - b.v);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  const hull = lower.concat(upper);
  return hull.length ? hull : pts;
}

function closestOnSegment(p: P2, a: P2, b: P2): P2 {
  const du = b.u - a.u, dv = b.v - a.v;
  const l2 = du * du + dv * dv;
  const t = l2 ? Math.max(0, Math.min(1, ((p.u - a.u) * du + (p.v - a.v) * dv) / l2)) : 0;
  return { u: a.u + du * t, v: a.v + dv * t };
}

/** Where the ray from `o` through `p` crosses segment ab, if near p. */
function intersectRayWithSegment(o: P2, p: P2, a: P2, b: P2): P2 | null {
  const r = { u: p.u - o.u, v: p.v - o.v };
  const s = { u: b.u - a.u, v: b.v - a.v };
  const den = r.u * s.v - r.v * s.u;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.u - o.u) * s.v - (a.v - o.v) * s.u) / den;
  const w = ((a.u - o.u) * r.v - (a.v - o.v) * r.u) / den;
  if (w < 0 || w > 1 || t <= 0) return null;
  return { u: o.u + r.u * t, v: o.v + r.v * t };
}

function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.v > p.v) !== (b.v > p.v) && p.u < ((b.u - a.u) * (p.v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.u * q.v - q.u * p.v;
  }
  return Math.abs(a) / 2;
}

function distToPolygon(p: P2, poly: P2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    d = Math.min(d, Math.hypot(q.u - p.u, q.v - p.v));
  }
  return d;
}

function dist3(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.max(0, Math.min(255, Math.round(x + (f < 0 ? x * f : (255 - x) * f)))));
  return `rgb(${c.join(',')})`;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
}

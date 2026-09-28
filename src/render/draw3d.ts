import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { getDef } from '../core/catalog';
import { localToWorld } from '../core/geometry';
import { deckCorners, endpoints, framePolygon3D, isSegmentLike, isSheet, support3D, type PenOptions } from '../core/pens';
import type { Store } from '../core/store';
import type { Vec3 } from '../core/types';

export type Pen3D = 'support' | 'frame';

interface Hover {
  p: THREE.Vector3;
  kind: 'point' | 'surface' | 'plane' | 'axis' | 'line';
  /** For 'line' snaps: the edge or middle line being followed (highlighted). */
  line?: [THREE.Vector3, THREE.Vector3];
  /** For 'axis' snaps: which straight line through the last point (0 = X, 1 = Y/vertical, 2 = Z). */
  axis?: number;
  /** The part being snapped to, outlined so you can see it. */
  target?: string;
}

/** What the 3D drawing tool needs from the viewport. */
export interface Draw3DHost {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  /** Parts are drawn inside this group (it moves during a simulation). */
  vehicle: THREE.Group;
  snap: number;
  rayFrom(e: MouseEvent): THREE.Ray;
  pickPoint(e: MouseEvent): THREE.Vector3 | null;
  pickId(e: MouseEvent): string | null;
  onStatus(msg: string): void;
}

const SNAP_PX = 12;
/** How close (px) the pointer must be to an attach line (edge, face middle, centre line). */
const LINE_PX = 9;
/** Free points within this many px of lining up with the last point in some direction are lined up exactly. */
const PLANE_PX = 7;

interface SnapLine { a: THREE.Vector3; b: THREE.Vector3; id: string }/** How close (px) the pointer must be to a straight line through the last point to ride on it. */
const AXIS_PX = 10;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const AXIS_COLORS = [0xff5a5a, 0x5aff7a, 0x5aa8ff];
const AXIS_NAMES = ['level, across the ship', 'vertical', 'level, fore and aft'];

/**
 * Drawing supports and framing directly in 3D. Points snap to the ends and
 * corners of existing parts, then to part surfaces, then to a working plane
 * at the level of the previous point (Shift: a vertical plane, to go up).
 */
export class Draw3D {
  pen: Pen3D | null = null;
  points: THREE.Vector3[] = [];
  private hover: Hover | null = null;
  private preview = new THREE.Group();
  private line: THREE.Line;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;
  private targetBox: THREE.LineSegments;
  private label: CSS2DObject;
  private hl: THREE.Line;

  constructor(private host: Draw3DHost, private store: Store, private opts: () => PenOptions) {
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd35a, depthTest: false }));
    this.line.renderOrder = 20;
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffd35a, depthTest: false });
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), this.markerMat);
    this.marker.renderOrder = 21;
    // Red centre line: the mirror line down the middle of the craft.
    const centre = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.01, -500), new THREE.Vector3(0, 0.01, 500)]),
      new THREE.LineBasicMaterial({ color: 0xff4040 }),
    );
    this.targetBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x7dffb0, depthTest: false }));
    this.targetBox.renderOrder = 19;
    this.targetBox.visible = false;
    this.hl = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7dffb0, depthTest: false }));
    this.hl.renderOrder = 22;
    this.hl.visible = false;
    this.preview.add(this.hl);
    this.label = new CSS2DObject(document.createElement('div'));
    this.label.visible = false;
    this.preview.add(this.line, this.marker, centre, this.targetBox, this.label);
    this.preview.visible = false;
    host.vehicle.add(this.preview);
  }

  start(pen: Pen3D) {
    this.pen = pen;
    this.points = [];
    this.preview.visible = true;
    this.host.dom.style.cursor = 'crosshair';
    this.status();
  }

  stop() {
    this.pen = null;
    this.points = [];
    this.hover = null;
    this.preview.visible = false;
  }

  move(e: MouseEvent) {
    if (!this.pen) return;
    this.hover = this.snapAt(e);
    this.redraw();
    this.status();
  }

  click(e: MouseEvent) {
    if (!this.pen) return;
    const h = this.hover ?? this.snapAt(e);
    if (!h) return;
    const p = h.p.clone();
    if (this.pen === 'support') {
      const last = this.points[this.points.length - 1];
      if (last && last.distanceTo(p) > 0.05) {
        let a = last.clone(), b = p.clone();
        // Straight out from the centre line with mirroring on: one beam across both sides.
        const acrossOnly = Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.z - b.z) < 1e-3;
        if (this.store.mirror && acrossOnly) {
          if (Math.abs(a.x) < 1e-3 && Math.abs(b.x) > 0.02) a = new THREE.Vector3(-b.x, b.y, b.z);
          else if (Math.abs(b.x) < 1e-3 && Math.abs(a.x) > 0.02) b = new THREE.Vector3(-a.x, a.y, a.z);
        }
        const part = support3D(a.toArray() as Vec3, b.toArray() as Vec3, this.opts());
        if (part) this.store.addParts([part], false);
      }
      // Keep going from here, so trusses and frames can be chained.
      this.points = [p];
    } else {
      const first = this.points[0];
      if (first && this.points.length >= 3 && first.distanceTo(p) < 1e-4) {
        this.finish();
        return;
      }
      this.points.push(p);
    }
    this.redraw();
    this.status();
  }

  /** Enter / right-click: complete a framing sheet, or stop a run of supports. */
  finish() {
    if (this.pen === 'frame' && this.points.length >= 3) {
      const parts = this.store.design.parts.filter((q) => !getDef(q.type).compartment);
      const centre: Vec3 | undefined = parts.length
        ? (parts.reduce((acc, q) => [acc[0] + q.position[0], acc[1] + q.position[1], acc[2] + q.position[2]], [0, 0, 0]).map((v) => v / parts.length) as Vec3)
        : undefined;
      const sheet = framePolygon3D(this.points.map((q) => q.toArray() as Vec3), this.opts(), centre);
      if (sheet) {
        this.store.addParts([sheet], false);
        this.host.onStatus(`Framing sheet added (${this.points.length} corners). Flip its armor in the inspector if it went on the wrong face.`);
      }
    }
    this.points = [];
    this.redraw();
  }

  cancel() {
    this.points = [];
    this.redraw();
  }

  // ── Snapping ───────────────────────────────────────────────────────────────
  private linesRev = -1;
  private linesCache: SnapLine[] = [];

  /**
   * Lines you can attach along: every support's centre line, the middle line
   * of each side face and its four long edges; the outline edges of floors
   * and framing sheets.
   */
  private snapLines(): SnapLine[] {
    if (this.linesRev === this.store.revision) return this.linesCache;
    const out: SnapLine[] = [];
    for (const p of this.store.design.parts) {
      const def = getDef(p.type);
      if (def.compartment || def.envelope) continue;
      if (isSheet(p)) {
        const c = deckCorners(p).map((w) => new THREE.Vector3(...w));
        c.forEach((a, i) => out.push({ a, b: c[(i + 1) % c.length], id: p.id }));
      } else if (def.structural && isSegmentLike(p)) {
        const [hx, hy, hz] = p.size.map((v) => v / 2);
        for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) {
          out.push({
            a: new THREE.Vector3(...localToWorld(p, [sx * hx, sy * hy, -hz])),
            b: new THREE.Vector3(...localToWorld(p, [sx * hx, sy * hy, hz])),
            id: p.id,
          });
        }
      }
    }
    this.linesRev = this.store.revision;
    this.linesCache = out;
    return out;
  }

  private snapAt(e: MouseEvent): Hover | null {
    const rect = this.host.dom.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const offset = this.host.vehicle.position;
    const toScreen = (w: THREE.Vector3) => {
      const v = w.clone().add(offset).project(this.host.camera);
      if (v.z > 1 || v.z < -1) return null;
      return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
    };
    const screenDist = (w: THREE.Vector3) => {
      const q = toScreen(w);
      return q ? Math.hypot(q.x - mx, q.y - my) : Infinity;
    };
    const ray = this.host.rayFrom(e);
    ray.origin.sub(offset);
    const last = this.points[this.points.length - 1];
    const free = e.altKey;
    const g = this.host.snap;
    const lines = this.snapLines();

    // 1. Points: part ends and corners, and the midpoints of every attach line.
    let best: THREE.Vector3 | null = null, bestD = SNAP_PX;
    let owner: string | undefined;
    let current: string | undefined;
    const consider = (w: THREE.Vector3) => {
      const d = screenDist(w);
      if (d < bestD) { bestD = d; best = w; owner = current; }
    };
    for (const q of this.points) consider(q);
    for (const p of this.store.design.parts) {
      current = p.id;
      const def = getDef(p.type);
      if (def.compartment || def.envelope || p.type === 'hullSides') continue;
      if (isSegmentLike(p)) for (const w of endpoints(p)) consider(new THREE.Vector3(...w));
      if (isSheet(p)) for (const w of deckCorners(p)) consider(new THREE.Vector3(...w));
      // Corners of cut-outs are connection points too.
      for (const hole of p.holes ?? []) {
        for (let i = 0; i + 1 < hole.length; i += 2) {
          if (p.type === 'hullSides') for (const sx of [-1, 1]) consider(new THREE.Vector3(sx * p.size[0] / 2, p.position[1] + hole[i + 1], p.position[2] + hole[i]));
          else consider(new THREE.Vector3(...localToWorld(p, [hole[i], 0, hole[i + 1]])));
        }
      }
      if (def.structural || isSheet(p) || p.type === 'window') {
        const [hx, hy, hz] = p.size.map((v) => v / 2);
        if (!p.points) for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) consider(new THREE.Vector3(...localToWorld(p, [sx * hx, sy * hy, sz * hz])));
      }
    }
    for (const l of lines) {
      current = l.id;
      consider(l.a.clone().add(l.b).multiplyScalar(0.5));
      consider(l.a);
      consider(l.b);
    }
    if (best) return { p: (best as THREE.Vector3).clone(), kind: 'point', target: owner };

    // 2. Along a line: an edge, face middle or centre line of a support or sheet.
    let lineHit: Hover | null = null, lineD = LINE_PX;
    for (const l of lines) {
      const dir = l.b.clone().sub(l.a);
      const len = dir.length();
      if (len < 1e-6) continue;
      dir.divideScalar(len);
      let t = closestOnLineToRay(l.a, dir, ray);
      if (t === null) continue;
      t = Math.max(0, Math.min(len, t));
      const q = l.a.clone().addScaledVector(dir, t);
      const d = screenDist(q);
      if (d >= lineD) continue;
      // Stop where a grid line crosses it.
      if (g && !free) {
        const k = [0, 1, 2].reduce((m, i) => (Math.abs(dir.getComponent(i)) > Math.abs(dir.getComponent(m)) ? i : m), 0);
        const target = Math.round(q.getComponent(k) / g) * g;
        const t2 = t + (target - q.getComponent(k)) / dir.getComponent(k);
        const q2 = l.a.clone().addScaledVector(dir, t2);
        if (t2 >= 0 && t2 <= len && screenDist(q2) < LINE_PX * 1.5) q.copy(q2);
      }
      lineD = d;
      lineHit = { p: q, kind: 'line', target: l.id, line: [l.a, l.b] };
    }

    // 3. Straight lines through the last point (vertical, level across, level fore–aft).
    let axisHit: Hover | null = null, axisD = AXIS_PX;
    if (last && !free) {
      AXES.forEach((axis, i) => {
        const t = closestOnLineToRay(last, axis, ray);
        if (t === null || Math.abs(t) < 1e-3) return;
        const d = screenDist(last.clone().addScaledVector(axis, t));
        const tt = g ? Math.round(t / g) * g || t : t;
        if (d < axisD) { axisD = d; axisHit = { p: last.clone().addScaledVector(axis, tt), kind: 'axis', axis: i }; }
      });
    }
    // Straight *and* on the line: where the straight line from the last point meets it.
    if (lineHit && last && !free) {
      const lh = lineHit as Hover;
      const [la, lb] = lh.line!;
      const ld = lb.clone().sub(la).normalize();
      for (let i = 0; i < 3; i++) {
        const hit = lineLineMeet(last, AXES[i], la, ld);
        if (!hit) continue;
        const tLine = hit.clone().sub(la).dot(ld);
        if (tLine < -1e-6 || tLine > la.distanceTo(lb) + 1e-6 || hit.distanceTo(last) < 1e-3) continue;
        if (screenDist(hit) < LINE_PX * 1.5) return { p: hit, kind: 'line', target: lh.target, line: lh.line, axis: i };
      }
    }
    if (lineHit && (!axisHit || lineD <= axisD)) return lineHit;
    if (axisHit) return axisHit;

    // Pull onto the centre line when the pointer is close to it on screen.
    const toCentre = (p: THREE.Vector3) => {
      if (screenDist(new THREE.Vector3(0, p.y, p.z)) < SNAP_PX && screenDist(p) < SNAP_PX * 2) p.x = 0;
      return p;
    };
    // 4. A part's surface.
    const hit = this.host.pickPoint(e);
    if (hit) return { p: toCentre(free ? hit : this.keepStraight(hit, toScreen)), kind: 'surface', target: this.host.pickId(e) ?? undefined };
    // 5. The working plane: level with the last point, or (Shift) the upright
    //    plane through it that faces you most, fore–aft or across.
    let plane: THREE.Plane;
    if (e.shiftKey && last) {
      const view = this.host.camera.getWorldDirection(new THREE.Vector3());
      const n = Math.abs(view.x) > Math.abs(view.z) ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, last);
    } else {
      plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(last?.y ?? 0));
    }
    const p = new THREE.Vector3();
    if (!ray.intersectPlane(plane, p)) return null;
    if (g) {
      // Grid-snap within the plane, keeping the plane's own coordinate exact.
      for (let k = 0; k < 3; k++) if (Math.abs(plane.normal.getComponent(k)) < 0.5) p.setComponent(k, Math.round(p.getComponent(k) / g) * g);
    }
    return { p: toCentre(free ? p : this.keepStraight(p, toScreen)), kind: 'plane' };
  }

  /**
   * Keep a free point straight with the last one in any direction it's close
   * to: e.g. an angled brace that stays exactly in its upright plane.
   */
  private keepStraight(p: THREE.Vector3, toScreen: (w: THREE.Vector3) => { x: number; y: number } | null): THREE.Vector3 {
    const last = this.points[this.points.length - 1];
    if (!last) return p;
    const out = p.clone();
    for (let k = 0; k < 3; k++) {
      const q = out.clone();
      q.setComponent(k, last.getComponent(k));
      const a = toScreen(out), b = toScreen(q);
      // Close enough that straightening it barely moves the pointer: make it exact.
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < PLANE_PX) out.copy(q);
    }
    return out;
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  private redraw() {
    const pts = [...this.points];
    if (this.hover) pts.push(this.hover.p);
    if (this.pen === 'frame' && this.points.length >= 2 && this.hover) pts.push(this.points[0]);
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.marker.visible = !!this.hover;
    // Light up the line being attached along.
    this.hl.visible = !!this.hover?.line;
    if (this.hover?.line) {
      this.hl.geometry.dispose();
      this.hl.geometry = new THREE.BufferGeometry().setFromPoints(this.hover.line);
    }
    const last = this.points[this.points.length - 1];
    const straight = last && this.hover ? straightness(last, this.hover.p) : null;
    (this.line.material as THREE.LineBasicMaterial).color.setHex(straight?.exact !== undefined ? AXIS_COLORS[straight.exact] : straight?.partial ? 0x7fe8ff : 0xffd35a);
    this.label.visible = !!straight;
    if (straight && this.hover) {
      this.label.position.copy(this.hover.p);
      this.label.element.textContent = straight.text;
      this.label.element.className = `draw-label${straight.exact !== undefined ? ' straight' : straight.partial ? ' partial' : ''}`;
    }
    const t = this.hover?.target ? this.store.get(this.hover.target) : undefined;
    this.targetBox.visible = !!t;
    if (t) {
      this.targetBox.position.set(...t.position);
      this.targetBox.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ');
      this.targetBox.scale.set(Math.max(t.size[0], 0.01), Math.max(t.size[1], 0.01), Math.max(t.size[2], 0.01));
      (this.targetBox.material as THREE.LineBasicMaterial).color.setHex(this.hover!.kind === 'point' ? 0xffd35a : 0x7dffb0);
    }
    if (this.hover) {
      this.marker.position.copy(this.hover.p);
      this.markerMat.color.setHex(this.hover.axis !== undefined ? AXIS_COLORS[this.hover.axis] : this.hover.kind === 'point' ? 0xffd35a : this.hover.kind === 'surface' || this.hover.kind === 'line' ? 0x7dffb0 : 0x6fb6ff);
    }
  }

  private status() {
    const last = this.points[this.points.length - 1];
    const len = last && this.hover ? ` · ${last.distanceTo(this.hover.p).toFixed(2)} m` : '';
    const where = this.hover ? ` · ${this.hover.kind === 'axis' ? `straight: ${AXIS_NAMES[this.hover.axis ?? 1]} (Alt to break away)` : this.hover.kind === 'line' ? `along an edge / middle line${this.hover.axis !== undefined ? `, straight ${AXIS_NAMES[this.hover.axis]}` : ''}` : this.hover.kind === 'point' ? 'on a connection point' : this.hover.kind === 'surface' ? 'on a surface' : 'on the working plane (Shift = vertical)'}` : '';
    if (this.pen === 'support') this.host.onStatus(`Supports: ${last ? 'click to place the other end' : 'click the first end'}${len}${where} · Esc to stop`);
    else if (this.pen === 'frame') this.host.onStatus(`Framing: ${this.points.length < 3 ? `click corner ${this.points.length + 1}` : 'click the first corner or press Enter to finish'}${len}${where} · Esc cancels`);
  }
}

/** Where two lines (point + unit direction) meet, if they (nearly) do. */
function lineLineMeet(p1: THREE.Vector3, d1: THREE.Vector3, p2: THREE.Vector3, d2: THREE.Vector3): THREE.Vector3 | null {
  const w = p1.clone().sub(p2);
  const b = d1.dot(d2);
  const denom = 1 - b * b;
  if (denom < 1e-9) return null;
  const t = (b * w.dot(d2) - w.dot(d1)) / denom;
  const u = (w.dot(d2) - b * w.dot(d1)) / denom;
  const a = p1.clone().addScaledVector(d1, t), c = p2.clone().addScaledVector(d2, u);
  return a.distanceTo(c) < 0.01 ? a : null;
}

/** Parameter t along the line o + a·t closest to a ray (null if they're parallel). */
function closestOnLineToRay(o: THREE.Vector3, a: THREE.Vector3, ray: THREE.Ray): number | null {
  const d = ray.direction;
  const w = o.clone().sub(ray.origin);
  const b = a.dot(d);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (b * w.dot(d) - w.dot(a)) / denom;
}

/** How straight the line from a to b is: exact axis, or how far off vertical/level it is. */
function straightness(a: THREE.Vector3, b: THREE.Vector3): { exact?: number; partial?: boolean; text: string } | null {
  const d = b.clone().sub(a);
  const len = d.length();
  if (len < 1e-4) return null;
  const lenText = `${len.toFixed(2)} m`;
  const eps = 1e-4;
  const flat = [Math.abs(d.x) < eps, Math.abs(d.y) < eps, Math.abs(d.z) < eps];
  if (flat[0] && flat[2]) return { exact: 1, text: `✓ Vertical · ${lenText}` };
  if (flat[1] && flat[2]) return { exact: 0, text: `✓ Level, across · ${lenText}` };
  if (flat[0] && flat[1]) return { exact: 2, text: `✓ Level, fore–aft · ${lenText}` };
  const fromVertical = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(d.y) / len)));
  // Angled lines that are still straight in one direction (an upright brace, a level diagonal).
  const held = flat[1] ? '✓ level' : flat[0] ? '✓ no lean across' : flat[2] ? '✓ no lean fore–aft' : '';
  const angle = flat[1] ? '' : fromVertical < 45 ? `${fromVertical.toFixed(1)}° from vertical` : `${(90 - fromVertical).toFixed(1)}° from level`;
  return { partial: !!held, text: [angle, held, lenText].filter(Boolean).join(' · ') };
}

import * as THREE from 'three';
import { getDef } from '../core/catalog';
import { localToWorld } from '../core/geometry';
import { deckCorners, endpoints, framePolygon3D, isSegmentLike, isSheet, support3D, type PenOptions } from '../core/pens';
import type { Store } from '../core/store';
import type { Vec3 } from '../core/types';

export type Pen3D = 'support' | 'frame';

interface Hover {
  p: THREE.Vector3;
  kind: 'point' | 'surface' | 'plane';
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
  onStatus(msg: string): void;
}

const SNAP_PX = 12;
const AXIS_LOCK = Math.cos(THREE.MathUtils.degToRad(8));

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

  constructor(private host: Draw3DHost, private store: Store, private opts: () => PenOptions) {
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd35a, depthTest: false }));
    this.line.renderOrder = 20;
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffd35a, depthTest: false });
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), this.markerMat);
    this.marker.renderOrder = 21;
    this.preview.add(this.line, this.marker);
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
        const part = support3D(last.toArray() as Vec3, p.toArray() as Vec3, this.opts());
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
  private snapAt(e: MouseEvent): Hover | null {
    const rect = this.host.dom.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const offset = this.host.vehicle.position;
    const toScreen = (w: THREE.Vector3) => {
      const v = w.clone().add(offset).project(this.host.camera);
      if (v.z > 1 || v.z < -1) return null;
      return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
    };
    // 1. Ends and corners of existing parts.
    let best: THREE.Vector3 | null = null, bestD = SNAP_PX;
    const consider = (w: THREE.Vector3) => {
      const s = toScreen(w);
      if (!s) return;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < bestD) { bestD = d; best = w; }
    };
    for (const q of this.points) consider(q);
    for (const p of this.store.design.parts) {
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
        const [hx, hy, hz] = p.size.map((s) => s / 2);
        if (!p.points) for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) consider(new THREE.Vector3(...localToWorld(p, [sx * hx, sy * hy, sz * hz])));
      }
    }
    if (best) return { p: (best as THREE.Vector3).clone(), kind: 'point' };
    // 2. A part's surface.
    const hit = this.host.pickPoint(e);
    if (hit) return { p: this.lock(hit), kind: 'surface' };
    // 3. The working plane.
    const last = this.points[this.points.length - 1];
    const ray = this.host.rayFrom(e);
    ray.origin.sub(offset);
    let plane: THREE.Plane;
    if (e.shiftKey && last) {
      const n = this.host.camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), last);
    } else {
      plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(last?.y ?? 0));
    }
    const p = new THREE.Vector3();
    if (!ray.intersectPlane(plane, p)) return null;
    const s = this.host.snap;
    if (s) {
      // Grid-snap within the plane, keeping the plane's own coordinate exact.
      if (Math.abs(plane.normal.y) > 0.9) { p.x = Math.round(p.x / s) * s; p.z = Math.round(p.z / s) * s; }
      else { p.y = Math.round(p.y / s) * s; }
    }
    return { p: this.lock(p), kind: 'plane' };
  }

  /** Lock onto the X, Y or Z axis through the last point when nearly aligned. */
  private lock(p: THREE.Vector3): THREE.Vector3 {
    const last = this.points[this.points.length - 1];
    if (!last) return p;
    const d = p.clone().sub(last);
    const len = d.length();
    if (len < 1e-6) return p;
    for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
      const c = d.dot(axis) / len;
      if (Math.abs(c) > AXIS_LOCK) return last.clone().addScaledVector(axis, d.dot(axis));
    }
    return p;
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  private redraw() {
    const pts = [...this.points];
    if (this.hover) pts.push(this.hover.p);
    if (this.pen === 'frame' && this.points.length >= 2 && this.hover) pts.push(this.points[0]);
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.marker.visible = !!this.hover;
    if (this.hover) {
      this.marker.position.copy(this.hover.p);
      this.markerMat.color.setHex(this.hover.kind === 'point' ? 0xffd35a : this.hover.kind === 'surface' ? 0x7dffb0 : 0x6fb6ff);
    }
  }

  private status() {
    const last = this.points[this.points.length - 1];
    const len = last && this.hover ? ` · ${last.distanceTo(this.hover.p).toFixed(2)} m` : '';
    const where = this.hover ? ` · ${this.hover.kind === 'point' ? 'on a connection point' : this.hover.kind === 'surface' ? 'on a surface' : 'on the working plane (Shift = vertical)'}` : '';
    if (this.pen === 'support') this.host.onStatus(`Supports: ${last ? 'click to place the other end' : 'click the first end'}${len}${where} · Esc to stop`);
    else if (this.pen === 'frame') this.host.onStatus(`Framing: ${this.points.length < 3 ? `click corner ${this.points.length + 1}` : 'click the first corner or press Enter to finish'}${len}${where} · Esc cancels`);
  }
}

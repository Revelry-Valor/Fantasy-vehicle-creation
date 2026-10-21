import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getDef, getMaterial } from '../model/catalog';
import { bendSegment, mapPath, pointAt, segmentCount } from '../model/curves';
import { localBox } from '../model/geometry';
import { makeBeam } from '../model/hull';
import { DEG, partMatrix, round } from '../model/math';
import { aimAt, clampValue, jointSpec, jointValues, poseGroups } from '../model/rig';
import type { Studio } from '../model/studio';
import { clone, newId, type Layer, type Part, type Vec3 } from '../model/types';
import { beamGeometry, buildPart, materialFor, retint, setClipPlanes } from './meshes';
import { VehicleView, type Tint, type ViewFlags } from './vehicleView';

export type Tool = 'select' | 'place' | 'beam' | 'pose' | 'aim' | 'ruler';
export type PlaneAxis = 'x' | 'y' | 'z';
export type GridMode = 'all' | 'plane' | 'off';
export type GizmoMode = 'translate' | 'rotate';
export type QuickView = 'front' | 'back' | 'side' | 'top' | 'three';

const AXIS: Record<PlaneAxis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

interface Snapped { p: Vec3; kind: 'magnet' | 'grid' | 'axis' }

/**
 * The 3D editor. Left mouse is for the active tool, right-drag orbits, middle
 * (or Shift+right) pans, and the wheel zooms toward the cursor.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly view = new VehicleView();
  private gizmo: TransformControls;
  private pivot = new THREE.Object3D();
  private gridGroup = new THREE.Group();
  private mirrorGroup = new THREE.Group();
  private overlay = new THREE.Group();
  private ray = new THREE.Raycaster();
  private dirty = true;

  tool: Tool = 'select';
  gizmoMode: GizmoMode = 'translate';
  placeDef = 'plate';
  beamDef = 'beam.square';
  /** Separate straight beams click to click, or one smooth beam through every click. */
  beamMode: 'chain' | 'curve' = 'chain';
  ghostRotation: Vec3 = [0, 0, 0];
  plane: { axis: PlaneAxis; offset: number } = { axis: 'y', offset: 0 };
  gridMode: GridMode = 'all';
  flags: ViewFlags = { hidden: new Set(), locked: new Set(), isolate: null, effects: false };
  clip: { axis: 'none' | 'x' | 'y' | 'z'; value: number; flip: boolean } = { axis: 'none', value: 0, flip: false };
  warned = new Set<string>();
  /** Transparent background for screenshots. */
  transparent = false;

  onStatus: (msg: string) => void = () => {};
  onToolChange: () => void = () => {};
  onRuler: (d: number | null) => void = () => {};

  private ghost: THREE.Object3D | null = null;
  private ghostPart: Part | null = null;
  private ghostBad = false;
  private beamPoints: Vec3[] = [];
  private cursor: Snapped | null = null;
  private cursorMark: THREE.Mesh;
  private beamPreview: THREE.Mesh | null = null;
  private pointMarks = new THREE.Group();
  private handles = new THREE.Group();
  private hoverId: string | null = null;
  private drag: null | { kind: 'gizmo'; start: THREE.Matrix4 } | { kind: 'handle'; part: string; index: number; mid: boolean; plane: THREE.Plane }
    | { kind: 'pose'; joint: string; start: number[]; startPoint: THREE.Vector3; axis: THREE.Vector3; pivot: THREE.Vector3; dof: number; piston: boolean }
    | { kind: 'marquee'; x0: number; y0: number; add: boolean } = null;
  private marquee: HTMLDivElement;
  private rulerPts: Vec3[] = [];
  private rulerLine: THREE.Line | null = null;
  playing = false;

  constructor(private container: HTMLElement, private studio: Studio) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    this.scene.background = new THREE.Color(0x1b1f25);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30281e, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 14, 6);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.camera.position.set(9, 7, 11);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper(), this.pivot);
    this.gizmo.addEventListener('dragging-changed', (e) => this.onGizmoDrag(!!(e as unknown as { value: boolean }).value));
    this.gizmo.addEventListener('objectChange', () => this.previewGizmo());
    this.gizmo.addEventListener('change', () => (this.dirty = true));

    this.cursorMark = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false }));
    this.cursorMark.renderOrder = 10;
    this.cursorMark.visible = false;
    this.overlay.add(this.cursorMark, this.pointMarks, this.handles);
    this.scene.add(this.view.root, this.gridGroup, this.mirrorGroup, this.overlay);

    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee';
    this.marquee.hidden = true;
    container.appendChild(this.marquee);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindPointer();
    const loop = () => {
      this.controls.update();
      if (this.dirty) { this.render(); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get v() { return this.studio.v; }
  /** A beam is being drawn. */
  get drawing() { return this.beamPoints.length > 0; }
  invalidate() { this.dirty = true; }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  render() {
    this.scene.background = this.transparent ? null : new THREE.Color(0x1b1f25);
    this.renderer.render(this.scene, this.camera);
  }

  // ── Sync with the document ────────────────────────────────────────────────

  /** Rebuild after a document change. */
  refresh() {
    const { rig } = this.studio.analysis();
    const tints = new Map<string, Tint>();
    for (const id of this.warned) tints.set(id, 'warning');
    if (this.hoverId) tints.set(this.hoverId, 'hover');
    for (const id of this.studio.selection) tints.set(id, 'selected');
    this.view.sync(this.v, rig, tints, this.flags);
    this.updateGrid();
    this.updateMirrorPlanes();
    this.updateGizmo();
    this.updateHandles();
    this.applyClip();
    this.dirty = true;
  }

  /** Joint values changed: just re-pose. */
  repose(values?: Record<string, number[]>) {
    this.view.pose(this.v, values);
    this.updateGizmo();
    this.updateHandles();
    this.dirty = true;
  }

  applyClip() {
    if (this.clip.axis === 'none') setClipPlanes([]);
    else {
      const n = AXIS[this.clip.axis].clone().multiplyScalar(this.clip.flip ? 1 : -1);
      setClipPlanes([new THREE.Plane(n, this.clip.flip ? -this.clip.value : this.clip.value)]);
    }
    this.dirty = true;
  }

  // ── Grid ──────────────────────────────────────────────────────────────────

  updateGrid() {
    for (const c of [...this.gridGroup.children]) { this.gridGroup.remove(c); (c as THREE.LineSegments).geometry?.dispose(); }
    if (this.gridMode === 'off') return;
    const { major, minor } = this.v.grid;
    const b = this.view.bounds();
    const ext = b.isEmpty() ? 0 : Math.max(...b.getSize(new THREE.Vector3()).toArray());
    const half = Math.max(12 * major, Math.ceil((ext * 0.9 + 4 * major) / major) * major);
    const planes: { axis: PlaneAxis; offset: number; strong: boolean }[] = [];
    if (this.gridMode === 'all' && !(this.plane.axis === 'y' && this.plane.offset === 0)) planes.push({ axis: 'y', offset: 0, strong: false });
    planes.push({ axis: this.plane.axis, offset: this.plane.offset, strong: true });
    for (const pl of planes) this.gridGroup.add(gridLines(pl.axis, pl.offset, half, major, minor, pl.strong));
    this.dirty = true;
  }

  private updateMirrorPlanes() {
    for (const c of [...this.mirrorGroup.children]) this.mirrorGroup.remove(c);
    const b = this.view.bounds();
    const size = b.isEmpty() ? 8 : Math.max(4, ...b.getSize(new THREE.Vector3()).toArray()) * 1.3;
    const o = this.v.mirror.origin;
    const colors = { x: 0xff6b6b, y: 0x6bff9a, z: 0x6ba8ff };
    for (const a of ['x', 'y', 'z'] as const) {
      if (!this.v.mirror[a] || !this.studio.liveMirror) continue;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: colors[a], transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false }));
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color: colors[a], transparent: true, opacity: 0.22 }));
      const g = new THREE.Group();
      g.add(m, edge);
      const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
      g.position.set(a === 'x' ? o[0] : c.x, a === 'y' ? o[1] : c.y, a === 'z' ? o[2] : c.z);
      if (a === 'x') g.rotation.y = Math.PI / 2;
      if (a === 'y') g.rotation.x = Math.PI / 2;
      this.mirrorGroup.add(g);
    }
  }

  setPlane(axis: PlaneAxis, offset = this.plane.offset) {
    this.plane = { axis, offset: round(offset, this.v.grid.minor) };
    this.updateGrid();
    this.onStatus(`Working plane: ${axis === 'y' ? 'level' : axis === 'x' ? 'side (upright, facing X)' : 'front (upright, facing Z)'} at ${this.plane.offset} m`);
  }

  cyclePlane() {
    const order: PlaneAxis[] = ['y', 'z', 'x'];
    const next = order[(order.indexOf(this.plane.axis) + 1) % 3];
    const c = this.cursor?.p;
    this.setPlane(next, c ? c[next === 'x' ? 0 : next === 'y' ? 1 : 2] : 0);
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  setTool(t: Tool, opts: { def?: string } = {}) {
    this.cancelBeam();
    this.clearGhost();
    this.rulerPts = [];
    if (this.rulerLine) { this.overlay.remove(this.rulerLine); this.rulerLine = null; this.onRuler(null); }
    this.tool = t;
    if (t === 'place' && opts.def) this.placeDef = opts.def;
    if (t === 'beam' && opts.def) this.beamDef = opts.def;
    this.cursorMark.visible = false;
    this.updateGizmo();
    this.updateHandles();
    this.onToolChange();
    this.dirty = true;
  }

  setGizmoMode(m: GizmoMode) {
    this.gizmoMode = m;
    this.gizmo.setMode(m);
    this.dirty = true;
  }

  /** Turn the ghost or the selection 90° (or 15° with fine) about an axis. */
  rotate(axis: PlaneAxis, degs = 90) {
    if (this.tool === 'place') {
      const r = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...this.ghostRotation.map((x) => x * DEG) as Vec3, 'XYZ'));
      const q = new THREE.Matrix4().makeRotationAxis(AXIS[axis], degs * DEG).multiply(r);
      const e = new THREE.Euler().setFromRotationMatrix(q, 'XYZ');
      this.ghostRotation = [e.x, e.y, e.z].map((x) => Math.round(x / DEG / 15) * 15) as Vec3;
      this.clearGhost();
      return;
    }
    const sel = this.studio.selection;
    if (!sel.length) return;
    const c = this.selectionCentre();
    const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(AXIS[axis], degs * DEG)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    this.studio.transformParts(sel, m, 'Rotate');
  }

  nudge(d: Vec3) {
    const sel = this.studio.selection;
    if (sel.length) this.studio.transformParts(sel, new THREE.Matrix4().makeTranslation(...d), 'Nudge', 'nudge');
    else if (d[1]) this.setPlane(this.plane.axis, this.plane.offset + (this.plane.axis === 'y' ? d[1] : d[1]));
  }

  // ── Pointer ───────────────────────────────────────────────────────────────

  private ndc(e: PointerEvent | MouseEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pick(e: PointerEvent | MouseEvent): { id: string; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hits = this.ray.intersectObjects(this.view.pickables(this.flags.locked), true);
    for (const h of hits) {
      const id = h.object.userData.partId as string | undefined;
      if (!id) continue;
      if (this.clip.axis !== 'none') {
        const k = this.clip.axis === 'x' ? h.point.x : this.clip.axis === 'y' ? h.point.y : h.point.z;
        if (this.clip.flip ? k < this.clip.value : k > this.clip.value) continue;
      }
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      if (n.dot(this.ray.ray.direction) > 0) n.negate();
      return { id, point: h.point.clone(), normal: n };
    }
    return null;
  }

  private planeHit(e: PointerEvent | MouseEvent, axis = this.plane.axis, offset = this.plane.offset): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const pl = new THREE.Plane(AXIS[axis], -offset);
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(pl, out) ? out : null;
  }

  private toScreen(p: Vec3): THREE.Vector2 {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2((v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height);
  }

  /** A point for drawing: an existing snap point near the cursor, else the working-plane grid. Shift locks to an axis from the last point. */
  private snapPoint(e: PointerEvent | MouseEvent, from?: Vec3): Snapped | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    const g = this.v.grid.minor;
    if (from && e.shiftKey) {
      // Along X, Y or Z from the last point, whichever line passes closest to the cursor.
      this.ray.setFromCamera(this.ndc(e), this.camera);
      let best: { p: Vec3; d: number } | null = null;
      for (const ax of ['x', 'y', 'z'] as PlaneAxis[]) {
        const dir = AXIS[ax];
        const o = new THREE.Vector3(...from);
        const pt = new THREE.Vector3();
        this.ray.ray.distanceSqToSegment(o.clone().addScaledVector(dir, -1e4), o.clone().addScaledVector(dir, 1e4), undefined, pt);
        const t = round(pt.clone().sub(o).dot(dir), g);
        const q = o.clone().addScaledVector(dir, t);
        const s = this.toScreen([q.x, q.y, q.z]);
        const d = s.distanceTo(mouse);
        if (!best || d < best.d) best = { p: [q.x, q.y, q.z], d };
      }
      if (best) return { p: best.p.map((x) => round(x, g)) as Vec3, kind: 'axis' };
    }
    if (!e.altKey) {
      let best: { p: Vec3; d: number } | null = null;
      const { rig } = this.studio.analysis();
      const mats = poseGroups(this.v, rig);
      for (const p of this.v.parts) {
        if (this.flags.hidden.has(p.layer) || (this.flags.isolate && this.flags.isolate !== p.layer)) continue;
        const gid = rig.groupOf.get(p.id);
        const m = gid !== undefined ? mats[gid] : null;
        for (const q of this.studio.solver.proxiesOf(this.v, p).snaps) {
          const w = m ? new THREE.Vector3(...q).applyMatrix4(m) : new THREE.Vector3(...q);
          const s = this.toScreen([w.x, w.y, w.z]);
          const d = s.distanceTo(mouse);
          if (d < 12 && (!best || d < best.d)) best = { p: [w.x, w.y, w.z], d };
        }
      }
      if (best) return { p: best.p.map((x) => round(x, g)) as Vec3, kind: 'magnet' };
    }
    const hit = this.planeHit(e);
    if (!hit) return null;
    return { p: [round(hit.x, g), round(hit.y, g), round(hit.z, g)], kind: 'grid' };
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('dblclick', (e) => this.onDouble(e));
    el.addEventListener('pointerleave', () => { this.cursorMark.visible = false; this.dirty = true; });
  }

  private onDown(e: PointerEvent) {
    this.renderer.domElement.focus();
    if (e.button === 2 && this.tool === 'beam' && this.beamPoints.length) { this.finishBeam(); return; }
    if (e.button !== 0) return;
    if (this.gizmo.dragging || (this.gizmo as unknown as { axis: string | null }).axis) return;
    switch (this.tool) {
      case 'select': {
        const h = this.handleAt(e);
        if (h) { this.startHandle(h, e); return; }
        const hit = this.pick(e);
        if (hit) {
          if (e.shiftKey || e.ctrlKey || e.metaKey) this.studio.toggleSelect(hit.id);
          else if (!this.studio.selection.includes(hit.id)) this.studio.select([hit.id]);
        } else {
          this.drag = { kind: 'marquee', x0: e.clientX, y0: e.clientY, add: e.shiftKey || e.ctrlKey };
          this.renderer.domElement.setPointerCapture(e.pointerId);
        }
        return;
      }
      case 'place': {
        if (this.ghostPart && !this.ghostBad) {
          const p = clone(this.ghostPart);
          p.id = newId();
          const made = this.studio.addParts([p], `Add ${getDef(p.def, this.v).name.toLowerCase()}`);
          this.onStatus(made.length > 1 ? `Placed with ${made.length - 1} mirrored twin${made.length > 2 ? 's' : ''}.` : 'Placed.');
          this.clearGhost();
          this.onMove(e);
        } else if (this.ghostBad) this.onStatus('That spot overlaps another part.');
        return;
      }
      case 'beam': {
        const s = this.snapPoint(e, this.beamPoints[this.beamPoints.length - 1]);
        if (!s) return;
        this.addBeamPoint(s);
        return;
      }
      case 'pose': this.startPose(e); return;
      case 'aim': {
        const hit = this.pick(e);
        const p = hit?.point ?? this.planeHit(e, 'y', 0);
        if (!p) return;
        const { rig } = this.studio.analysis();
        let moved: string[] = [];
        this.studio.pose('Aim', () => { moved = aimAt(this.v, rig, [p.x, p.y, p.z]); }, 'aim');
        this.onStatus(moved.length ? `Aimed ${moved.length} joint${moved.length > 1 ? 's' : ''} at the target.` : 'Nothing is linked to an aim control yet. Make one in Controls.');
        return;
      }
      case 'ruler': {
        const s = this.snapPoint(e, this.rulerPts[0]);
        if (!s) return;
        this.rulerPts = this.rulerPts.length >= 2 ? [s.p] : [...this.rulerPts, s.p];
        this.drawRuler();
        return;
      }
    }
  }

  private onMove(e: PointerEvent) {
    if (this.drag?.kind === 'marquee') { this.updateMarquee(e); return; }
    if (this.drag?.kind === 'handle') { this.moveHandle(e); return; }
    if (this.drag?.kind === 'pose') { this.movePose(e); return; }
    if (this.drag?.kind === 'gizmo') return;
    switch (this.tool) {
      case 'select': {
        const hit = this.handleAt(e) ? null : this.pick(e);
        const id = hit?.id ?? null;
        if (id !== this.hoverId) { this.hoverId = id; this.refreshTints(); }
        this.renderer.domElement.style.cursor = this.handleAt(e) ? 'grab' : id ? 'pointer' : 'default';
        return;
      }
      case 'place': this.moveGhost(e); return;
      case 'beam':
      case 'ruler': {
        const from = this.tool === 'beam' ? this.beamPoints[this.beamPoints.length - 1] : this.rulerPts.length === 1 ? this.rulerPts[0] : undefined;
        this.cursor = this.snapPoint(e, from);
        this.showCursor();
        if (this.tool === 'beam') this.updateBeamPreview();
        else if (this.rulerPts.length === 1 && this.cursor) this.drawRuler(this.cursor.p);
        return;
      }
      case 'pose': {
        const hit = this.pick(e);
        this.renderer.domElement.style.cursor = hit && this.jointFor(hit.id) ? 'grab' : 'default';
        return;
      }
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'marquee') this.finishMarquee(e);
    if (d.kind === 'handle' || d.kind === 'pose') this.drag = null;
    if (d.kind === 'marquee') this.drag = null;
  }

  private onDouble(e: MouseEvent) {
    if (this.tool === 'beam' && this.beamMode === 'curve') { this.finishBeam(); return; }
    if (this.tool === 'select') {
      const hit = this.pick(e);
      if (hit) this.focusOn([hit.point.x, hit.point.y, hit.point.z]);
    }
  }

  refreshTints() {
    const tints = new Map<string, Tint>();
    for (const id of this.warned) tints.set(id, 'warning');
    if (this.hoverId) tints.set(this.hoverId, 'hover');
    for (const id of this.studio.selection) tints.set(id, 'selected');
    for (const p of this.v.parts) {
      const t = tints.get(p.id) ?? 'none';
      for (const o of this.view.objectsOf(p.id)) retint(o, t);
    }
    this.dirty = true;
  }

  // ── Marquee selection ─────────────────────────────────────────────────────

  private updateMarquee(e: PointerEvent) {
    const d = this.drag as { x0: number; y0: number };
    const r = this.container.getBoundingClientRect();
    const x = Math.min(d.x0, e.clientX) - r.left, y = Math.min(d.y0, e.clientY) - r.top;
    const w = Math.abs(e.clientX - d.x0), h = Math.abs(e.clientY - d.y0);
    if (w + h < 6) return;
    Object.assign(this.marquee.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    this.marquee.hidden = false;
  }

  private finishMarquee(e: PointerEvent) {
    const d = this.drag as { x0: number; y0: number; add: boolean };
    this.marquee.hidden = true;
    const w = Math.abs(e.clientX - d.x0), h = Math.abs(e.clientY - d.y0);
    if (w + h < 6) { if (!d.add) this.studio.select([]); return; }
    const r = this.renderer.domElement.getBoundingClientRect();
    const x0 = Math.min(d.x0, e.clientX) - r.left, x1 = Math.max(d.x0, e.clientX) - r.left;
    const y0 = Math.min(d.y0, e.clientY) - r.top, y1 = Math.max(d.y0, e.clientY) - r.top;
    const ids: string[] = [];
    for (const p of this.v.parts) {
      if (this.flags.locked.has(p.layer) || this.flags.hidden.has(p.layer)) continue;
      const objs = this.view.objectsOf(p.id);
      const b = new THREE.Box3();
      for (const o of objs) b.expandByObject(o);
      if (b.isEmpty()) continue;
      const s = this.toScreen(b.getCenter(new THREE.Vector3()).toArray() as Vec3);
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) ids.push(p.id);
    }
    this.studio.select(ids, d.add);
    this.onStatus(`${this.studio.selection.length} selected.`);
  }

  // ── Gizmo ─────────────────────────────────────────────────────────────────

  selectionCentre(): THREE.Vector3 {
    const b = new THREE.Box3();
    for (const id of this.studio.selection) for (const o of this.view.objectsOf(id)) b.expandByObject(o);
    const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
    const g = this.v.grid.minor;
    return new THREE.Vector3(round(c.x, g), round(c.y, g), round(c.z, g));
  }

  updateGizmo() {
    const sel = this.studio.selected().filter((p) => !p.surface && !p.derived && !this.flags.locked.has(p.layer));
    if (this.tool !== 'select' || !sel.length || this.drag?.kind === 'gizmo') {
      if (this.drag?.kind !== 'gizmo') this.gizmo.detach();
      return;
    }
    this.pivot.position.copy(this.selectionCentre());
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.updateMatrixWorld();
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.setTranslationSnap(this.v.grid.minor);
    this.gizmo.setRotationSnap(15 * DEG);
    this.dirty = true;
  }

  private onGizmoDrag(on: boolean) {
    this.controls.enabled = !on;
    if (on) {
      this.drag = { kind: 'gizmo', start: this.pivot.matrixWorld.clone() };
    } else if (this.drag?.kind === 'gizmo') {
      const delta = this.pivot.matrixWorld.clone().multiply(this.drag.start.clone().invert());
      this.drag = null;
      const moved = !delta.equals(new THREE.Matrix4());
      if (moved) this.studio.transformParts(this.studio.selection, delta, this.gizmoMode === 'rotate' ? 'Rotate' : 'Move');
      else this.refresh();
    }
  }

  private previewGizmo() {
    if (this.drag?.kind !== 'gizmo') return;
    const delta = this.pivot.matrixWorld.clone().multiply(this.drag.start.clone().invert());
    for (const id of this.studio.selection) {
      const p = this.studio.get(id);
      if (!p) continue;
      for (const o of this.view.objectsOf(id)) {
        const rest = p.path || p.surface ? new THREE.Matrix4() : partMatrix(p);
        o.matrixAutoUpdate = false;
        o.matrix.copy(delta).multiply(rest);
        o.matrixWorldNeedsUpdate = true;
      }
    }
    const t = this.pivot.position.clone().sub(new THREE.Vector3().setFromMatrixPosition(this.drag.start));
    this.onStatus(this.gizmoMode === 'translate' ? `Move ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)} m` : 'Rotate in 15° steps');
    this.dirty = true;
  }

  // ── Beam handles: drag the middle to bend, the ends to move ───────────────

  private handleParts(): Part[] {
    if (this.tool !== 'select') return [];
    const sel = this.studio.selected();
    return sel.length === 1 && sel[0].path && !sel[0].derived ? sel : [];
  }

  updateHandles() {
    for (const c of [...this.handles.children]) this.handles.remove(c);
    const parts = this.handleParts();
    if (!parts.length) return;
    const p = parts[0];
    const r = Math.max(0.05, Math.min(0.25, this.camera.position.distanceTo(this.controls.target) * 0.008));
    const pts = p.path!.points;
    const mk = (pos: Vec3, mid: boolean, index: number) => {
      const m = new THREE.Mesh(mid ? new THREE.OctahedronGeometry(r * 1.2) : new THREE.SphereGeometry(r, 14, 10),
        new THREE.MeshBasicMaterial({ color: mid ? 0x4dd6ff : 0xffd34d, depthTest: false }));
      m.position.set(...pos);
      m.renderOrder = 11;
      m.userData = { handle: true, index, mid, part: p.id };
      this.handles.add(m);
    };
    pts.forEach((q, i) => mk(q, false, i));
    for (let i = 0; i < segmentCount(p.path!); i++) mk(pointAt(p.path!, i + 0.5), true, i);
    this.dirty = true;
  }

  private handleAt(e: PointerEvent | MouseEvent) {
    if (!this.handles.children.length) return null;
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hit = this.ray.intersectObjects(this.handles.children, false)[0];
    return hit ? (hit.object.userData as { index: number; mid: boolean; part: string }) : null;
  }

  private startHandle(h: { index: number; mid: boolean; part: string }, e: PointerEvent) {
    const p = this.studio.get(h.part)!;
    const at = h.mid ? pointAt(p.path!, h.index + 0.5) : p.path!.points[h.index];
    const n = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.drag = { kind: 'handle', part: h.part, index: h.index, mid: h.mid, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...at)) };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    const up = () => { this.controls.enabled = true; this.renderer.domElement.removeEventListener('pointerup', up); };
    this.renderer.domElement.addEventListener('pointerup', up);
  }

  private moveHandle(e: PointerEvent) {
    const d = this.drag as Extract<typeof this.drag, { kind: 'handle' }>;
    const p = this.studio.get(d.part);
    if (!p?.path) return;
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const q = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(d.plane, q)) return;
    if (d.mid) {
      // The bend between grid points is free.
      const path = bendSegment(p.path, d.index, [q.x, q.y, q.z]);
      this.studio.updatePart(p.id, { path }, 'Bend beam', `bend-${p.id}-${d.index}`);
      this.onStatus('Bending. Use the beam\'s properties for exact arcs and S-curves, or Straighten.');
    } else {
      const g = this.v.grid.minor;
      const s = this.snapPoint(e) ?? { p: [round(q.x, g), round(q.y, g), round(q.z, g)] as Vec3 };
      const pts = p.path.points.map((x) => [...x] as Vec3);
      pts[d.index] = s.p;
      const path = { ...p.path, points: pts };
      // Keep any bend handles attached to the moved point.
      if (path.handles) path.handles = path.handles.map((h, i) => (h && (i === d.index || i === d.index - 1) ? null : h));
      this.studio.updatePart(p.id, { path, position: pts[0] }, 'Move beam point', `pt-${p.id}-${d.index}`);
    }
  }

  // ── Place tool ────────────────────────────────────────────────────────────

  private clearGhost() {
    if (this.ghost) { this.overlay.remove(this.ghost); this.ghost = null; }
    this.ghostPart = null;
    this.dirty = true;
  }

  private moveGhost(e: PointerEvent) {
    const part = this.studio.newPart(this.placeDef, [0, 0, 0], [...this.ghostRotation] as Vec3);
    const g = this.v.grid.minor;
    const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...this.ghostRotation.map((x) => x * DEG) as Vec3, 'XYZ'));
    const box = localBox(part);
    // How far the part reaches from its origin along a direction.
    const reach = (n: THREE.Vector3) => {
      const c = new THREE.Vector3(...box.c).applyMatrix4(R).dot(n);
      let r = 0;
      for (let i = 0; i < 3; i++) {
        const ax = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix4(R);
        r += Math.abs(ax.dot(n)) * box.h[i];
      }
      return r - c;
    };
    const hit = this.pick(e);
    let pos: THREE.Vector3 | null = null;
    let normal = AXIS[this.plane.axis].clone();
    if (hit) {
      normal = hit.normal.clone();
      // Snap the normal to the nearest axis when it's close (flat faces).
      const a = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
      const k = a.indexOf(Math.max(...a));
      if (a[k] > 0.97) normal = new THREE.Vector3(k === 0 ? Math.sign(normal.x) : 0, k === 1 ? Math.sign(normal.y) : 0, k === 2 ? Math.sign(normal.z) : 0);
      pos = hit.point.clone().addScaledVector(normal, reach(normal));
    } else {
      const ph = this.planeHit(e);
      if (ph) {
        const cam = this.camera.position.clone().sub(ph);
        if (cam.dot(normal) < 0) normal.negate();
        pos = ph.addScaledVector(normal, reach(normal));
      }
    }
    if (!pos) return;
    // Grid in the surface's plane; flush against the surface along its normal.
    const arr = pos.toArray();
    const ax = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const along = ax.indexOf(Math.max(...ax));
    for (let i = 0; i < 3; i++) if (i !== along || ax[along] < 0.97) arr[i] = round(arr[i], g);
    if (!hit) arr[along] = round(arr[along], 1e-4);
    part.position = arr.map((x) => +x.toFixed(4)) as Vec3;
    this.ghostPart = part;
    const bad = this.studio.solver.wouldOverlap(this.v, part).length > 0;
    if (this.ghost) this.overlay.remove(this.ghost);
    const m = buildPart(this.v, part, bad ? 'ghostBad' : 'ghost');
    const grp = new THREE.Group();
    grp.add(m.main);
    if (m.head) grp.add(m.head);
    grp.matrixAutoUpdate = false;
    grp.matrix.copy(partMatrix(part));
    this.ghost = grp;
    this.ghostBad = bad;
    this.overlay.add(grp);
    this.onStatus(`${getDef(part.def, this.v).name} at ${part.position.map((x) => x.toFixed(2)).join(', ')}${bad ? ' — overlaps' : ''}. R / T / Shift+T turn it 90°.`);
    this.dirty = true;
  }

  // ── Beam tool ─────────────────────────────────────────────────────────────

  private showCursor() {
    if (!this.cursor) { this.cursorMark.visible = false; this.dirty = true; return; }
    this.cursorMark.visible = true;
    this.cursorMark.position.set(...this.cursor.p);
    const r = this.camera.position.distanceTo(this.cursorMark.position) * 0.006;
    this.cursorMark.scale.setScalar(r);
    (this.cursorMark.material as THREE.MeshBasicMaterial).color.set(this.cursor.kind === 'magnet' ? 0xffd34d : this.cursor.kind === 'axis' ? 0x7dff9a : 0x9fb8d6);
    this.dirty = true;
  }

  private addBeamPoint(s: Snapped) {
    const last = this.beamPoints[this.beamPoints.length - 1];
    if (last && last.every((x, i) => Math.abs(x - s.p[i]) < 1e-6)) {
      if (this.beamMode === 'curve') this.finishBeam();
      return;
    }
    this.beamPoints.push(s.p);
    // Follow the work: the plane moves through points picked off other parts.
    if (s.kind === 'magnet') {
      const k = this.plane.axis === 'x' ? 0 : this.plane.axis === 'y' ? 1 : 2;
      if (this.plane.offset !== s.p[k]) { this.plane.offset = s.p[k]; this.updateGrid(); }
    }
    if (this.beamMode === 'chain' && this.beamPoints.length === 2) {
      const [a, b] = this.beamPoints;
      this.studio.addParts([makeBeam(this.v, this.beamDef, [a, b])], `Add ${getDef(this.beamDef, this.v).name.toLowerCase()}`);
      this.beamPoints = [b];
    }
    this.drawPointMarks();
    this.updateBeamPreview();
  }

  finishBeam() {
    if (this.beamMode === 'curve' && this.beamPoints.length >= 2) {
      this.studio.addParts([makeBeam(this.v, this.beamDef, this.beamPoints)], 'Add curved beam');
    }
    this.cancelBeam();
  }

  cancelBeam() {
    this.beamPoints = [];
    if (this.beamPreview) { this.overlay.remove(this.beamPreview); this.beamPreview.geometry.dispose(); this.beamPreview = null; }
    for (const c of [...this.pointMarks.children]) this.pointMarks.remove(c);
    this.dirty = true;
  }

  private drawPointMarks() {
    for (const c of [...this.pointMarks.children]) this.pointMarks.remove(c);
    for (const p of this.beamPoints) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      m.position.set(...p);
      m.scale.setScalar(this.camera.position.distanceTo(m.position) * 0.005);
      m.renderOrder = 10;
      this.pointMarks.add(m);
    }
  }

  private updateBeamPreview() {
    if (this.beamPreview) { this.overlay.remove(this.beamPreview); this.beamPreview.geometry.dispose(); this.beamPreview = null; }
    if (!this.beamPoints.length || !this.cursor) { this.dirty = true; return; }
    const pts = [...this.beamPoints, this.cursor.p];
    const b = makeBeam(this.v, this.beamDef, pts);
    if (this.beamMode === 'chain') b.path!.smooth = false;
    const bad = this.studio.solver.wouldOverlap(this.v, b).length > 0;
    this.beamPreview = new THREE.Mesh(beamGeometry(b), materialFor(getMaterial(b.material, this.v), bad ? 'ghostBad' : 'ghost'));
    this.overlay.add(this.beamPreview);
    const last = this.beamPoints[this.beamPoints.length - 1];
    const L = Math.hypot(...this.cursor.p.map((x, i) => x - last[i]));
    this.onStatus(`Segment ${L.toFixed(2)} m${bad ? ' — passes through another part' : ''}. ${this.beamMode === 'curve' ? 'Double-click, Enter or right-click to finish.' : 'Right-click or Esc to stop.'} Shift: lock to X/Y/Z. Alt: ignore snap points.`);
    this.dirty = true;
  }

  // ── Pose tool: drag a part past a joint ───────────────────────────────────

  /** The joint that moves a part: the joint of its rigid group (or the part itself if it's a joint). */
  jointFor(id: string): string | null {
    const { rig } = this.studio.analysis();
    const p = this.studio.get(id);
    if (!p) return null;
    const gid = rig.groupOf.get(id);
    if (gid !== undefined && rig.groups[gid].joint) return rig.groups[gid].joint!;
    if (jointSpec(this.v, p)) return id;
    return null;
  }

  private startPose(e: PointerEvent) {
    const hit = this.pick(e);
    if (!hit) return;
    const jid = this.jointFor(hit.id);
    if (!jid) { this.onStatus('That part is on the main body. Drag something past a joint to move it.'); return; }
    const { rig } = this.studio.analysis();
    const j = rig.joints.get(jid);
    const p = this.studio.get(jid)!;
    const spec = jointSpec(this.v, p)!;
    if (!j || j.locked) { this.onStatus('That joint is locked: both of its sides connect to the same structure.'); return; }
    const mats = poseGroups(this.v, rig);
    const m = mats[j.parent].clone().multiply(partMatrix(p));
    const pivot = new THREE.Vector3().setFromMatrixPosition(m);
    let dof = 0;
    let local = new THREE.Vector3(1, 0, 0);
    if (spec.type === 'turret') local = new THREE.Vector3(0, 1, 0);
    if (spec.type === 'piston') local = new THREE.Vector3(getDef(p.def, this.v).shape === 'door' ? 1 : 0, getDef(p.def, this.v).shape === 'door' ? 0 : 1, 0);
    if (spec.type === 'wheel') { local = new THREE.Vector3(0, 1, 0); dof = 1; }
    if (spec.type === 'ball') {
      // Turn about whichever local axis faces the camera most.
      const view = this.camera.getWorldDirection(new THREE.Vector3());
      let best = 0, bd = -1;
      for (let i = 0; i < 3; i++) {
        const ax = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).transformDirection(m);
        const d = Math.abs(ax.dot(view));
        if (d > bd) { bd = d; best = i; }
      }
      dof = best;
      local = new THREE.Vector3(best === 0 ? 1 : 0, best === 1 ? 1 : 0, best === 2 ? 1 : 0);
    }
    const axis = local.transformDirection(m).normalize();
    this.drag = { kind: 'pose', joint: jid, start: jointValues(this.v, p), startPoint: hit.point.clone(), axis, pivot, dof, piston: spec.type === 'piston' };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    const up = () => { this.controls.enabled = true; this.renderer.domElement.removeEventListener('pointerup', up); };
    this.renderer.domElement.addEventListener('pointerup', up);
  }

  private movePose(e: PointerEvent) {
    const d = this.drag as Extract<typeof this.drag, { kind: 'pose' }>;
    const p = this.studio.get(d.joint);
    if (!p) return;
    const spec = jointSpec(this.v, p)!;
    const { rig } = this.studio.analysis();
    const j = rig.joints.get(d.joint)!;
    const fl = p.flip ?? [1, 1, 1];
    const sign = fl[0] * fl[1] * fl[2] * (j.moving === 'base' ? -1 : 1);
    this.ray.setFromCamera(this.ndc(e), this.camera);
    let value: number;
    if (d.piston) {
      // Closest point on the slide axis to the cursor ray.
      const pt = new THREE.Vector3();
      this.ray.ray.distanceSqToSegment(d.pivot.clone().addScaledVector(d.axis, -1e3), d.pivot.clone().addScaledVector(d.axis, 1e3), undefined, pt);
      const s0 = d.startPoint.clone().sub(d.pivot).dot(d.axis);
      const s1 = pt.sub(d.pivot).dot(d.axis);
      value = d.start[d.dof] + (s1 - s0) * (j.moving === 'base' ? -1 : 1);
    } else {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(d.axis, d.pivot);
      const q = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(plane, q)) return;
      const a = d.startPoint.clone().sub(d.pivot).projectOnPlane(d.axis);
      const b = q.sub(d.pivot);
      const ang = Math.atan2(a.clone().cross(b).dot(d.axis), a.dot(b)) / DEG;
      const step = e.shiftKey ? 1 : 5;
      value = d.start[d.dof] + Math.round((ang * sign) / step) * step;
    }
    const vals = d.start.slice();
    vals[d.dof] = clampValue(spec, d.dof, value);
    this.studio.pose(`Pose ${p.name || getDef(p.def, this.v).name}`, () => { this.v.jointValues[d.joint] = vals; }, `pose-${d.joint}`);
    this.onStatus(`${p.name || getDef(p.def, this.v).name}: ${vals[d.dof].toFixed(spec.type === 'piston' ? 2 : 0)}${spec.type === 'piston' ? ' m' : '°'} (limits ${spec.min} to ${spec.max}). Shift for 1° steps.`);
  }

  // ── Ruler ────────────────────────────────────────────────────────────────

  private drawRuler(live?: Vec3) {
    if (this.rulerLine) { this.overlay.remove(this.rulerLine); this.rulerLine.geometry.dispose(); this.rulerLine = null; }
    const pts = live && this.rulerPts.length === 1 ? [this.rulerPts[0], live] : this.rulerPts;
    if (pts.length < 2) { this.onRuler(null); this.dirty = true; return; }
    const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
    this.rulerLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }));
    this.rulerLine.renderOrder = 12;
    this.overlay.add(this.rulerLine);
    const d = Math.hypot(...pts[1].map((x, i) => x - pts[0][i]));
    const dd = pts[1].map((x, i) => Math.abs(x - pts[0][i]));
    this.onRuler(d);
    this.onStatus(`Distance ${d.toFixed(3)} m  (X ${dd[0].toFixed(2)}, Y ${dd[1].toFixed(2)}, Z ${dd[2].toFixed(2)})`);
    this.dirty = true;
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  frame(ids: string[] = []) {
    const b = new THREE.Box3();
    if (ids.length) for (const id of ids) for (const o of this.view.objectsOf(id)) b.expandByObject(o);
    else b.copy(this.view.bounds());
    if (b.isEmpty()) b.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(6, 3, 8));
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(0.5, b.getSize(new THREE.Vector3()).length() / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = r / Math.sin((this.camera.fov * DEG) / 2) * 1.05;
    this.animateTo(c.clone().addScaledVector(dir, dist), c);
  }

  focusOn(p: Vec3) {
    const t = new THREE.Vector3(...p);
    const off = this.camera.position.clone().sub(this.controls.target);
    this.animateTo(t.clone().add(off), t);
  }

  quickView(v: QuickView) {
    const b = this.view.bounds();
    if (b.isEmpty()) b.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(6, 3, 8));
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(1, b.getSize(new THREE.Vector3()).length() / 2);
    const d = r / Math.sin((this.camera.fov * DEG) / 2) * 1.05;
    const dirs: Record<QuickView, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1), side: new THREE.Vector3(1, 0, 0), top: new THREE.Vector3(0, 1, 0.0001), three: new THREE.Vector3(1, 0.7, 1.1).normalize(),
    };
    this.animateTo(c.clone().addScaledVector(dirs[v], d), c);
  }

  camState() { return { pos: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3 }; }
  setCam(s: { pos: Vec3; target: Vec3 }) { this.animateTo(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.target)); }

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 350);
      const e = k * k * (3 - 2 * k);
      this.camera.position.lerpVectors(p0, pos, e);
      this.controls.target.lerpVectors(t0, target, e);
      this.dirty = true;
      if (k < 1) requestAnimationFrame(step);
      else this.updateHandles();
    };
    step();
  }

  /** PNG of the current view (optionally with a transparent background). */
  screenshot(transparent = false, scale = 2): string {
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    const helpers = [this.gridGroup, this.mirrorGroup, this.overlay, this.gizmo.getHelper()];
    const vis = helpers.map((x) => x.visible);
    helpers.forEach((x) => (x.visible = false));
    this.transparent = transparent;
    this.renderer.setPixelRatio(Math.min(4, (window.devicePixelRatio || 1) * scale));
    this.resize();
    this.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.resize();
    helpers.forEach((x, i) => (x.visible = vis[i]));
    this.transparent = false;
    this.dirty = true;
    void w; void h;
    return url;
  }

  setLayerFlags(fn: (f: ViewFlags) => void) {
    fn(this.flags);
    this.refresh();
  }

  pathSnapped(p: Part, f: (x: Vec3) => Vec3) {
    return p.path ? mapPath(p.path, f) : undefined;
  }

  layerOf(id: string): Layer | null {
    return this.studio.get(id)?.layer ?? null;
  }
}

function gridLines(axis: PlaneAxis, offset: number, half: number, major: number, minor: number, strong: boolean): THREE.Group {
  const g = new THREE.Group();
  const minorPts: number[] = [], majorPts: number[] = [], axisPts: number[] = [];
  const put = (arr: number[], a: number, b: number, c: number, d: number) => {
    // (u, v) in the plane → world
    const w = (u: number, vv: number): [number, number, number] => (axis === 'y' ? [u, offset, vv] : axis === 'x' ? [offset, vv, u] : [u, vv, offset]);
    arr.push(...w(a, b), ...w(c, d));
  };
  const n = Math.round(half / minor);
  const showMinor = n <= 400;
  for (let i = -n; i <= n; i++) {
    const x = i * minor;
    const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
    const arr = i === 0 ? axisPts : isMajor ? majorPts : minorPts;
    if (!isMajor && !showMinor) continue;
    put(arr, x, -half, x, half);
    put(arr, -half, x, half, x);
  }
  const mk = (pts: number[], color: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  };
  g.add(mk(minorPts, 0x8aa0b8, strong ? 0.12 : 0.06), mk(majorPts, 0x9fb6d0, strong ? 0.32 : 0.16), mk(axisPts, 0xc8d6e6, strong ? 0.55 : 0.3));
  g.renderOrder = -1;
  return g;
}

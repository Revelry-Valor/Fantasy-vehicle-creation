import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Analysis } from '../core/analysis';
import { getDef, type Layer } from '../core/catalog';
import { getFluid } from '../core/fluids';
import { mirrorTransform } from '../core/geometry';
import { buildContactGraph, buildFluidNetworks } from '../core/networks';
import type { Store } from '../core/store';
import type { PartInstance, Vec3 } from '../core/types';
import type { Simulation } from '../sim/simulation';
import { DEFAULT_PEN_OPTIONS, type PenOptions } from '../core/pens';
import { Draw3D, type Pen3D } from './draw3d';
import { animatePart, buildPartObject, type PartObject } from './meshes';

export type ViewMode = 'structure' | 'interior' | 'exterior';
export type Tool = 'select' | 'place' | 'damage' | 'draw';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

interface Entry {
  obj: PartObject;
  key: string;
}

interface StyleOpts {
  analysis: Analysis | null;
  sim: Simulation | null;
}

const LAYER_STYLE: Record<ViewMode, Partial<Record<Layer, number>>> = {
  // opacity per layer; 0 = hidden, 1 = solid
  structure: { structure: 1, hull: 0.07, interior: 1, systems: 1, propulsion: 1, mechanism: 1, compartment: 0 },
  interior: { structure: 0.3, hull: 0, interior: 1, systems: 1, propulsion: 1, mechanism: 1, compartment: 1 },
  exterior: { structure: 1, hull: 1, interior: 1, systems: 1, propulsion: 1, mechanism: 1, compartment: 0 },
};

export class Viewport {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gizmo: TransformControls;
  vehicle = new THREE.Group();
  entries = new Map<string, Entry>();

  view: ViewMode = 'exterior';
  tool: Tool = 'select';
  gizmoMode: GizmoMode = 'translate';
  snap = 0.25;
  placeType: string | null = null;
  placeRotation = 0;
  showMarkers = true;
  showStress = true;
  section: { axis: 'x' | 'z' | 'none'; value: number } = { axis: 'none', value: 0 };

  onDamage: (id: string, repair: boolean) => void = () => {};
  onStatus: (msg: string) => void = () => {};

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private fineGrid: THREE.GridHelper;
  private water: THREE.Mesh;
  private stars: THREE.Points;
  private ghost: THREE.Group | null = null;
  private ghostTwin: THREE.Group | null = null;
  private ghostPart: PartInstance | null = null;
  private hoverId: string | null = null;
  private proxy = new THREE.Object3D();
  private dragStart: { id: string; position: Vec3; rotation: Vec3; size: Vec3 }[] = [];
  private proxyStart = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private markers = new THREE.Group();
  private cogMarker: THREE.Object3D;
  private colMarker: THREE.Object3D;
  private dimsBox: THREE.Box3Helper;
  private dimsLabel: CSS2DObject;
  private clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private particles: Particles;
  private timer = new THREE.Timer();
  private styleOpts: StyleOpts = { analysis: null, sim: null };
  private fluidOfPart = new Map<string, string>();
  private downAt: { x: number; y: number } | null = null;
  private rightDownAt: { x: number; y: number } | null = null;
  draw!: Draw3D;
  /** Shared with the blueprint so both editors draw with the same pen settings. */
  penOptions: () => PenOptions = () => ({ ...DEFAULT_PEN_OPTIONS });

  constructor(private container: HTMLElement, private store: Store) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    this.camera.position.set(18, 12, 22);

    // Camera: left-drag orbits, right- or middle-drag pans, the wheel zooms
    // toward whatever is under the cursor, double-click re-centres the orbit.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.2;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.9;
    this.controls.panSpeed = 1.2;
    this.controls.zoomSpeed = 1.4;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 3000;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.target.set(0, 2, 0);
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    this.renderer.domElement.addEventListener('dblclick', (e) => this.focusAt(e));

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if ((e as unknown as { value: boolean }).value) this.beginDrag();
      else this.endDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.proxy);

    // Lighting — a room environment map gives metals something to reflect.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x3a3025, 0.8));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    const sc = sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.far = 200;
    this.scene.add(sun);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.25 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(200, 20, 0x667788, 0x3d4652);
    this.fineGrid = new THREE.GridHelper(40, 40, 0x33404c, 0x33404c);
    this.scene.add(this.grid, this.fineGrid);

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: 0x1d5a86, transparent: true, opacity: 0.55, roughness: 0.15, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.visible = false;
    this.scene.add(this.water);

    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1500 + Math.random() * 500);
      sp.push(v.x, v.y, v.z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false }));
    this.stars.visible = false;
    this.scene.add(this.stars);

    this.scene.add(this.vehicle);

    // Physics markers
    this.cogMarker = makeMarker('CoG', 0xffcc00);
    this.colMarker = makeMarker('Lift', 0x40a0ff);
    this.dimsBox = new THREE.Box3Helper(new THREE.Box3(), 0x88aacc);
    this.dimsLabel = new CSS2DObject(el('div', 'dims-label'));
    this.markers.add(this.cogMarker, this.colMarker, this.dimsBox, this.dimsLabel);
    this.vehicle.add(this.markers);

    this.particles = new Particles();
    this.vehicle.add(this.particles.points);

    const self = this;
    this.draw = new Draw3D({
      camera: this.camera,
      dom: this.renderer.domElement,
      vehicle: this.vehicle,
      get snap() { return self.snap; },
      rayFrom: (e) => { this.setPointer(e); return this.raycaster.ray.clone(); },
      pickPoint: (e) => this.pick(e)?.point ?? null,
      pickId: (e) => this.pick(e)?.id ?? null,
      onStatus: (m) => this.onStatus(m),
    }, store, () => this.penOptions());
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applyEnvironment();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ── Sync with the store ────────────────────────────────────────────────────
  sync() {
    const parts = this.store.design.parts;
    const alive = new Set<string>();
    for (const p of parts) {
      alive.add(p.id);
      const { state: _state, ...propsNoState } = p.props;
      void _state;
      const key = JSON.stringify([p.type, p.size, p.material, propsNoState, p.points?.length, p.points?.[0]]);
      let e = this.entries.get(p.id);
      if (!e || e.key !== key) {
        const prevAnim = e?.obj.anim?.value;
        if (e) this.dispose(e.obj.root);
        const obj = buildPartObject(p);
        if (obj.anim && prevAnim !== undefined && obj.anim.kind !== 'envelope' && obj.anim.kind !== 'spin') obj.anim.value = prevAnim;
        e = { obj, key };
        this.entries.set(p.id, e);
        this.vehicle.add(obj.root);
      }
      e.obj.root.position.set(...p.position);
      e.obj.root.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ');
    }
    for (const [id, e] of this.entries) {
      if (!alive.has(id)) {
        this.dispose(e.obj.root);
        this.entries.delete(id);
      }
    }
    this.computeFluidColors();
    this.attachGizmo();
    this.restyle();
  }

  private dispose(root: THREE.Object3D) {
    root.removeFromParent();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  private computeFluidColors() {
    this.fluidOfPart.clear();
    const parts = this.store.design.parts;
    if (!parts.some((p) => getDef(p.type).conduit === 'fluid')) return;
    const nets = buildFluidNetworks(parts, buildContactGraph(parts));
    for (const n of nets) if (n.fluid) for (const id of n.conduits) this.fluidOfPart.set(id, n.fluid);
  }

  setAnalysis(a: Analysis | null) {
    this.styleOpts.analysis = a;
    this.updateMarkers();
    this.restyle();
  }

  setSimulation(sim: Simulation | null) {
    this.styleOpts.sim = sim;
    if (!sim) {
      this.moveVehicleY(0);
      this.particles.clear();
    }
    this.attachGizmo();
    this.restyle();
  }

  setView(v: ViewMode) {
    this.view = v;
    this.restyle();
  }

  /** Start drawing supports or framing in 3D. */
  startDraw(pen: Pen3D) {
    this.setTool('draw');
    this.draw.start(pen);
  }

  setTool(t: Tool, placeType: string | null = null) {
    if (t !== 'draw') this.draw?.stop();
    this.tool = t;
    this.placeType = placeType;
    this.clearGhost();
    if (t === 'place' && placeType) this.makeGhost(placeType);
    this.attachGizmo();
    this.renderer.domElement.style.cursor = t === 'place' ? 'copy' : t === 'damage' || t === 'draw' ? 'crosshair' : 'default';
  }

  setGizmoMode(m: GizmoMode) {
    this.gizmoMode = m;
    this.gizmo.setMode(m);
  }

  setSnap(s: number) {
    this.snap = s;
    this.gizmo.setTranslationSnap(s || null);
    this.gizmo.setRotationSnap(s ? THREE.MathUtils.degToRad(15) : null);
    this.scene.remove(this.fineGrid);
    const n = s > 0 ? Math.min(400, Math.round(40 / s)) : 40;
    this.fineGrid = new THREE.GridHelper(40, n, 0x33404c, 0x33404c);
    (this.fineGrid.material as THREE.Material).transparent = true;
    (this.fineGrid.material as THREE.Material).opacity = s >= 0.25 ? 0.35 : 0.15;
    this.fineGrid.position.y = -0.001;
    this.scene.add(this.fineGrid);
  }

  applyEnvironment() {
    const env = this.store.design.settings.environment;
    const sky = { land: 0x9cc3e0, air: 0x8fb8de, water: 0x9cc3e0, underwater: 0x0d2a40, space: 0x02030a }[env];
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = env === 'underwater' ? new THREE.Fog(0x0d2a40, 10, 160) : env === 'space' ? null : new THREE.Fog(sky, 150, 900);
    this.water.visible = env === 'water' || env === 'underwater';
    this.water.position.y = env === 'underwater' ? 30 : 0;
    this.stars.visible = env === 'space';
    this.ground.visible = env !== 'space';
    const gridOpacity = env === 'space' ? 0.2 : 1;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = gridOpacity;
  }

  // ── Styling ────────────────────────────────────────────────────────────────
  restyle() {
    const { analysis, sim } = this.styleOpts;
    const sel = new Set(this.store.selection);
    const unsupported = new Set(analysis?.unsupported ?? []);
    const layerOp = LAYER_STYLE[this.view];
    const leakingComps = new Set(sim?.state.leaks.map((l) => l.compartmentId).filter(Boolean) as string[]);
    const clip = this.section.axis === 'none' ? null : [this.clipPlane];
    if (this.section.axis !== 'none') {
      this.clipPlane.normal.set(this.section.axis === 'x' ? -1 : 0, 0, this.section.axis === 'z' ? -1 : 0);
      this.clipPlane.constant = this.section.value;
    }
    for (const p of this.store.design.parts) {
      const e = this.entries.get(p.id);
      if (!e) continue;
      const def = getDef(p.type);
      let opacity = layerOp[def.layer] ?? 1;
      if (def.envelope && this.view !== 'exterior') opacity = Math.min(opacity, 0.18);
      if (def.compartment && sim) opacity = 1;
      e.obj.root.visible = opacity > 0;
      const health = sim ? sim.health(p.id) : 1;
      for (const m of e.obj.mats) {
        m.clippingPlanes = clip;
        m.clipShadows = true;
        const baseOpacity = m.userData.baseOpacity as number;
        const baseTransparent = m.userData.baseTransparent as boolean;
        m.color.setHex(m.userData.baseColor);
        m.emissive.setHex(m.userData.baseEmissive);
        m.emissiveIntensity = 1;
        let op = Math.min(baseOpacity, opacity);
        // Plating on framing ghosts out so the structure and interior show through.
        if (m.userData.skin && this.view !== 'exterior') op = Math.min(op, this.view === 'structure' ? 0.07 : 0.12);
        // Framing sheets stay readable in the structural view and ghost out inside.
        if (m.userData.panel && this.view !== 'exterior') op = Math.min(op, this.view === 'structure' ? 0.5 : 0.12);
        const transparent = baseTransparent || op < 1;
        if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
        m.opacity = op;
        m.depthWrite = op >= 1 || !m.transparent ? true : baseTransparent ? m.depthWrite : false;

        if (this.view === 'structure' && def.structural && analysis && this.showStress) {
          const u = analysis.utilization[p.id];
          if (u !== undefined) m.color.copy(stressColor(u));
        }
        if (this.view !== 'exterior' && def.conduit) {
          const f = def.conduit === 'power' ? null : getFluid(this.fluidOfPart.get(p.id));
          m.color.setHex(def.conduit === 'power' ? 0xffcc33 : f?.color ?? 0x999999);
          m.emissive.setHex(def.conduit === 'power' ? 0x332200 : 0x000000);
        }
        if (unsupported.has(p.id)) m.emissive.setHex(0x880066);
        if (health < 1) {
          m.color.lerp(new THREE.Color(0x221a18), 1 - health);
          m.emissive.setHex(health < 0.99 ? 0x551100 : 0);
        }
        if (p.type === 'lamp' && m === e.obj.mats.find((x) => x.userData.baseColor === 0xffe7a0)) {
          const on = !!analysis?.powered.has(p.id) && health > 0.3;
          m.emissive.setHex(on ? 0xffcc66 : 0x000000);
          m.emissiveIntensity = on ? 2 : 1;
        }
        if (this.hoverId === p.id) m.emissive.setHex(0x223344);
        if (sel.has(p.id)) m.emissive.setHex(0x1a4a8a);
      }
      if (def.compartment) this.styleCompartment(e, p, sim, leakingComps.has(p.id));
    }
  }

  private styleCompartment(e: Entry, p: PartInstance, sim: Simulation | null, leaking: boolean) {
    let color = 0x4aa3ff, op = 0.08;
    if (sim) {
      const at = sim.state.atmos[p.id];
      if (at) {
        if (at.flammable > 0.04) { color = 0xff40c0; op = 0.3; }
        else if (at.temperature > 45) { color = 0xff5a20; op = Math.min(0.45, 0.1 + (at.temperature - 45) / 200); }
        else if (at.toxicity > 0.1) { color = 0x70e040; op = Math.min(0.45, 0.1 + at.toxicity * 0.5); }
        else if (at.oxygen < 0.18) { color = 0x9060ff; op = 0.25; }
        else if (leaking) { color = 0xffee88; op = 0.15; }
        this.setFlood(e, p, at.flood);
      }
    } else this.setFlood(e, p, 0);
    e.obj.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.LineBasicMaterial | undefined;
      if (!m) return;
      if (o.userData.compartmentFill) {
        (m as THREE.MeshStandardMaterial).color.setHex(color);
        (m as THREE.MeshStandardMaterial).emissive.setHex(color === 0x4aa3ff ? 0 : color);
        (m as THREE.MeshStandardMaterial).emissiveIntensity = 0.3;
        m.opacity = op;
        m.depthWrite = false;
      }
      if (o.userData.compartmentEdge) (m as THREE.LineBasicMaterial).color.setHex(color);
    });
  }

  private setFlood(e: Entry, _p: PartInstance, flood: number) {
    let w = e.obj.body.getObjectByName('flood') as THREE.Mesh | undefined;
    if (!w && flood > 0) {
      w = new THREE.Mesh(new THREE.BoxGeometry(0.98, 1, 0.98), new THREE.MeshStandardMaterial({ color: 0x2a70c0, transparent: true, opacity: 0.6 }));
      w.name = 'flood';
      e.obj.body.add(w);
    }
    if (!w) return;
    w.visible = flood > 0.001;
    w.scale.y = Math.max(0.001, flood);
    w.position.y = -0.5 + flood / 2;
  }

  private updateMarkers() {
    const a = this.styleOpts.analysis;
    this.markers.visible = this.showMarkers && !!a && a.partCount > 0;
    if (!a || !a.bounds) return;
    this.cogMarker.position.set(...a.cog);
    this.colMarker.visible = !!a.centerOfLift;
    if (a.centerOfLift) this.colMarker.position.set(...a.centerOfLift);
    const b = a.bounds;
    this.dimsBox.box.set(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    this.dimsLabel.position.set((b.min[0] + b.max[0]) / 2, b.max[1] + 0.5, (b.min[2] + b.max[2]) / 2);
    const [w, h, l] = a.dims;
    this.dimsLabel.element.textContent = `L ${l.toFixed(1)} m × W ${w.toFixed(1)} m × H ${h.toFixed(1)} m`;
  }

  // ── Gizmo ──────────────────────────────────────────────────────────────────
  private attachGizmo() {
    const sel = this.store.selectedParts();
    const locked = !!this.styleOpts.sim;
    if (this.tool !== 'select' || !sel.length || locked) {
      this.gizmo.detach();
      return;
    }
    const p = sel[0];
    this.proxy.position.set(...p.position);
    this.proxy.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ');
    this.proxy.scale.set(1, 1, 1);
    this.gizmo.attach(this.proxy);
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.setSpace(this.gizmoMode === 'scale' ? 'local' : 'world');
  }

  private beginDrag() {
    this.store.snapshot();
    this.dragStart = this.store.selectedParts().map((p) => ({ id: p.id, position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, size: [...p.size] as Vec3 }));
    this.proxyStart.pos.copy(this.proxy.position);
    this.proxyStart.quat.copy(this.proxy.quaternion);
  }

  private endDrag() {
    this.proxy.scale.set(1, 1, 1);
    this.dragStart = [];
    this.store.emit('change');
  }

  private onGizmoChange() {
    if (!this.dragStart.length) return;
    const delta = this.proxy.position.clone().sub(this.proxyStart.pos);
    const dq = this.proxy.quaternion.clone().multiply(this.proxyStart.quat.clone().invert());
    const handled = new Set<string>();
    for (const s of this.dragStart) {
      if (handled.has(s.id)) continue;
      const part = this.store.get(s.id);
      if (!part) continue;
      if (part.mirrorOf) handled.add(part.mirrorOf);
      if (this.gizmoMode === 'translate') {
        this.store.updatePart(s.id, { position: [s.position[0] + delta.x, s.position[1] + delta.y, s.position[2] + delta.z] }, false);
      } else if (this.gizmoMode === 'rotate') {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...s.rotation, 'XYZ'));
        const e = new THREE.Euler().setFromQuaternion(dq.clone().multiply(q), 'XYZ');
        // Multi-selection rotates around the gizmo pivot.
        const off = new THREE.Vector3(...s.position).sub(this.proxyStart.pos).applyQuaternion(dq).add(this.proxyStart.pos);
        this.store.updatePart(s.id, { rotation: [e.x, e.y, e.z], position: [off.x, off.y, off.z] }, false);
      } else {
        const sc = this.proxy.scale;
        const snap = (v: number) => (this.snap ? Math.max(this.snap / 4, Math.round(v / (this.snap / 4)) * (this.snap / 4)) : v);
        this.store.updatePart(s.id, { size: [snap(s.size[0] * sc.x), snap(s.size[1] * sc.y), snap(s.size[2] * sc.z)] }, false);
      }
    }
  }

  // ── Pointer interaction ────────────────────────────────────────────────────
  private bindPointer() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      this.rightDownAt = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
    });
    dom.addEventListener('pointerup', (e) => {
      // A right-click (not a right-drag pan) finishes what's being drawn.
      if (e.button !== 2 || !this.rightDownAt || this.tool !== 'draw') return;
      if (Math.hypot(e.clientX - this.rightDownAt.x, e.clientY - this.rightDownAt.y) < 5) this.draw.finish();
      this.rightDownAt = null;
    });
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => {
      if (!this.downAt || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved > 5 || this.gizmo.dragging) return;
      this.onClick(e);
    });
    dom.addEventListener('pointerleave', () => { if (this.ghost) this.ghost.visible = false; });
  }

  private setPointer(e: MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** First visible part under the pointer. */
  pick(e: MouseEvent): { id: string; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    this.setPointer(e);
    const roots = [...this.entries.values()].map((x) => x.obj.root).filter((r) => r.visible);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      const m = (h.object as THREE.Mesh).material as THREE.Material | undefined;
      if (m && m.transparent && m.opacity < 0.2) continue;
      if (this.clippedAway(h.point)) continue;
      const id = h.object.userData.partId as string | undefined;
      if (!id) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      return { id, point: h.point.clone().sub(this.vehicle.position), normal };
    }
    return null;
  }

  private clippedAway(pt: THREE.Vector3): boolean {
    return this.section.axis !== 'none' && this.clipPlane.distanceToPoint(pt) < 0;
  }

  private onMove(e: PointerEvent) {
    if (this.tool === 'draw') { this.draw.move(e); return; }
    if (this.tool === 'place' && this.ghost && this.ghostPart) {
      this.positionGhost(e);
      return;
    }
    if (this.gizmo.dragging) return;
    const hit = this.pick(e);
    const id = hit?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.restyle();
      if (id) {
        const p = this.store.get(id);
        if (p) this.onStatus(`${p.name || getDef(p.type).name}${this.tool === 'damage' ? ' — click to damage, shift-click to repair' : ''}`);
      } else this.onStatus('');
    }
  }

  private onClick(e: PointerEvent) {
    if (this.tool === 'draw') { this.draw.click(e); return; }
    if (this.tool === 'place') {
      if (this.ghostPart && this.ghost?.visible) {
        const part = this.store.makePart(this.ghostPart.type, this.ghostPart.position, this.ghostPart.rotation);
        this.store.addParts([part], !e.shiftKey);
      }
      return;
    }
    const hit = this.pick(e);
    if (this.tool === 'damage') {
      if (hit) this.onDamage(hit.id, e.shiftKey);
      return;
    }
    if (!hit) {
      if (!e.shiftKey) this.store.select([]);
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) this.store.toggleSelect(hit.id);
    else this.store.select([hit.id]);
  }

  // ── Placement ghost ────────────────────────────────────────────────────────
  private makeGhost(type: string) {
    this.ghostPart = this.store.makePart(type, [0, 0, 0]);
    const build = () => {
      const o = buildPartObject(this.ghostPart!);
      for (const m of o.mats) { m.transparent = true; m.opacity = 0.5; m.depthWrite = false; m.emissive.setHex(0x113355); }
      o.root.traverse((x) => { x.userData.ghost = true; x.raycast = () => {}; });
      return o.root;
    };
    this.ghost = build();
    this.ghostTwin = build();
    this.ghost.visible = this.ghostTwin.visible = false;
    this.vehicle.add(this.ghost, this.ghostTwin);
  }

  private clearGhost() {
    for (const g of [this.ghost, this.ghostTwin]) if (g) this.dispose(g);
    this.ghost = this.ghostTwin = null;
    this.ghostPart = null;
  }

  rotateGhost() {
    this.placeRotation = (this.placeRotation + Math.PI / 2) % (Math.PI * 2);
  }

  private positionGhost(e: PointerEvent) {
    const part = this.ghostPart!;
    const def = getDef(part.type);
    const hit = this.pick(e);
    const s = this.snap;
    const snapV = (v: number) => (s ? Math.round(v / s) * s : v);
    let pos: THREE.Vector3;
    let quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.placeRotation, 0));
    if (hit) {
      const n = hit.normal.clone().normalize();
      // Snap the normal to the nearest axis when close, so plates sit flush on walls.
      const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
      for (const a of ax) {
        const d = n.dot(a);
        if (Math.abs(d) > 0.97) n.copy(a).multiplyScalar(Math.sign(d));
      }
      if (def.surfaceAxis) {
        const local = def.surfaceAxis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        quat = new THREE.Quaternion().setFromUnitVectors(local, n);
        if (def.surfaceAxis === 'y' && Math.abs(n.y) > 0.9) quat.premultiply(new THREE.Quaternion().setFromAxisAngle(n, this.placeRotation));
      }
      // Push out along the normal by the half-extent of the rotated part.
      const hx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat), hy = new THREE.Vector3(0, 1, 0).applyQuaternion(quat), hz = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
      const half = (Math.abs(n.dot(hx)) * part.size[0] + Math.abs(n.dot(hy)) * part.size[1] + Math.abs(n.dot(hz)) * part.size[2]) / 2;
      pos = hit.point.clone().addScaledVector(n, half);
      // Snap along the surface but not across it.
      for (const k of ['x', 'y', 'z'] as const) if (Math.abs(n[k]) < 0.5) pos[k] = snapV(pos[k]);
    } else {
      this.setPointer(e);
      const planeHit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), planeHit)) {
        this.ghost!.visible = this.ghostTwin!.visible = false;
        return;
      }
      const hy = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
      const sz = part.size;
      const halfY = (Math.abs(hy.x) * sz[0] + Math.abs(hy.y) * sz[1] + Math.abs(hy.z) * sz[2]) / 2;
      pos = new THREE.Vector3(snapV(planeHit.x), halfY, snapV(planeHit.z));
    }
    const eul = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    part.position = [round(pos.x), round(pos.y), round(pos.z)];
    part.rotation = [eul.x, eul.y, eul.z];
    this.ghost!.position.copy(pos);
    this.ghost!.quaternion.copy(quat);
    this.ghost!.visible = true;
    const mirrored = this.store.mirror && Math.abs(pos.x) > 0.02;
    this.ghostTwin!.visible = mirrored;
    if (mirrored) {
      const m = mirrorTransform(part.position, part.rotation);
      this.ghostTwin!.position.set(...m.position);
      this.ghostTwin!.rotation.set(m.rotation[0], m.rotation[1], m.rotation[2], 'XYZ');
    }
    this.onStatus(`${def.name} at (${part.position.map((v) => v.toFixed(2)).join(', ')}) m — click to place, R to rotate, Esc to stop`);
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  frameAll() {
    const a = this.styleOpts.analysis;
    const b = a?.bounds;
    const center = b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2) : new THREE.Vector3(0, 1, 0);
    const radius = b ? Math.max(3, Math.hypot(...a!.dims) / 2) : 6;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center).add(this.vehicle.position);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, radius * 2.4);
  }

  /** Double-click: orbit around the point under the cursor (a part or the ground). */
  private focusAt(e: MouseEvent) {
    const hit = this.pick(e);
    let point: THREE.Vector3 | null = hit ? hit.point.clone().add(this.vehicle.position) : null;
    if (!point) {
      this.setPointer(e);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) point = p;
    }
    if (!point) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(offset.length(), Math.max(4, this.camera.position.distanceTo(point) * 0.7));
    this.controls.target.copy(point);
    this.camera.position.copy(point).add(offset.setLength(dist));
  }

  /** Slide the camera and its pivot across the screen (arrow keys). */
  panBy(dx: number, dy: number) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const step = dist * 0.08;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(dx * step);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * step);
    const d = right.add(up);
    this.camera.position.add(d);
    this.controls.target.add(d);
  }

  viewFrom(which: 'front' | 'side' | 'top' | 'iso') {
    const t = this.controls.target;
    const d = this.camera.position.distanceTo(t);
    const dir = { front: [0, 0.05, 1], side: [1, 0.05, 0], top: [0, 1, 0.001], iso: [1, 0.7, 1] }[which];
    const v = new THREE.Vector3(...(dir as Vec3)).normalize().multiplyScalar(d);
    this.camera.position.copy(t).add(v);
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Move the craft vertically and let the camera ride along. */
  private moveVehicleY(y: number) {
    const dy = y - this.vehicle.position.y;
    this.vehicle.position.y = y;
    this.camera.position.y += dy;
    this.controls.target.y += dy;
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────
  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Paused while the 2D blueprint is showing. */
  active = true;

  private frame() {
    this.timer.update();
    if (!this.active) return;
    const dt = Math.min(0.05, this.timer.getDelta());
    const sim = this.styleOpts.sim;
    if (sim) {
      const target = sim.state.altitude;
      this.moveVehicleY(this.vehicle.position.y + (target - this.vehicle.position.y) * Math.min(1, dt * 10));
    }
    for (const p of this.store.design.parts) {
      const e = this.entries.get(p.id);
      if (!e?.obj.anim) continue;
      const fill = sim ? sim.state.fill[p.id] ?? 1 : typeof p.props.fill === 'number' ? p.props.fill : 1;
      animatePart(e.obj, p, Number(p.props.state ?? 0), dt, !!sim, fill);
    }
    if (sim) {
      for (const leak of sim.state.leaks) {
        const p = this.store.get(leak.partId);
        const f = getFluid(leak.fluid);
        if (p && f) this.particles.emit(p.position, f.color, f.state === 'gas' ? (f.density < 1 ? 1.5 : 0.3) : -2, Math.min(8, 1 + leak.rate * 2) * dt * 30);
      }
    }
    this.particles.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

function el(tag: string, cls: string, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function makeMarker(label: string, color: number): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 10), mat);
  s.renderOrder = 10;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 24), mat);
  ring.rotation.x = Math.PI / 2;
  ring.renderOrder = 10;
  g.add(s, ring);
  const tag = new CSS2DObject(el('div', 'marker-label', label));
  tag.element.style.color = `#${color.toString(16).padStart(6, '0')}`;
  tag.position.set(0, 0.5, 0);
  g.add(tag);
  return g;
}

function stressColor(u: number): THREE.Color {
  const c = new THREE.Color();
  if (u > 1) return c.setHex(0xff2020);
  if (u < 0.5) return c.setHSL(0.33 - u * 0.2, 0.7, 0.45);
  return c.setHSL(0.23 - (u - 0.5) * 0.46, 0.85, 0.5);
}

class Particles {
  points: THREE.Points;
  private max = 3000;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private next = 0;
  private acc = 0;

  constructor() {
    this.pos = new Float32Array(this.max * 3).fill(99999);
    this.col = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.age = new Float32Array(this.max).fill(99);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.25, vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }));
    this.points.frustumCulled = false;
  }

  emit(at: Vec3, color: number, rise: number, count: number) {
    this.acc += count;
    const c = new THREE.Color(color);
    while (this.acc >= 1) {
      this.acc -= 1;
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      this.pos[i * 3] = at[0] + (Math.random() - 0.5) * 0.2;
      this.pos[i * 3 + 1] = at[1] + (Math.random() - 0.5) * 0.2;
      this.pos[i * 3 + 2] = at[2] + (Math.random() - 0.5) * 0.2;
      this.vel[i * 3] = (Math.random() - 0.5) * 1.2;
      this.vel[i * 3 + 1] = rise * (0.5 + Math.random());
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
      this.age[i] = 0;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] > 3) continue;
      this.age[i] += dt;
      if (this.age[i] > 3) { this.pos[i * 3 + 1] = 99999; continue; }
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.age.fill(99);
    this.pos.fill(99999);
  }
}

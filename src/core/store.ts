import { getDef } from './catalog';
import { mirrorShapeData, mirrorTransform } from './geometry';
import { clonePart, newDesign, newId, type Design, type DesignLayer, type DesignSettings, type PartInstance, type PropValue, type Vec3 } from './types';

type Listener = () => void;
type EventName = 'change' | 'selection' | 'settings';

const MIRROR_EPS = 0.02;

/**
 * Editor state: the design, the selection, undo history and mirror mode.
 * Parts are mutated in place and every committed change pushes a snapshot.
 */
export class Store {
  design: Design;
  selection: string[] = [];
  mirror = true;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Record<EventName, Set<Listener>> = { change: new Set(), selection: new Set(), settings: new Set() };
  /** Monotonic counter bumped on every change — cheap cache key. */
  revision = 0;

  constructor(design?: Design) {
    this.design = design ?? newDesign();
  }

  on(evt: EventName, fn: Listener): () => void {
    this.listeners[evt].add(fn);
    return () => this.listeners[evt].delete(fn);
  }

  emit(evt: EventName) {
    if (evt === 'change') this.revision++;
    for (const fn of this.listeners[evt]) fn();
  }

  get(id: string): PartInstance | undefined {
    return this.design.parts.find((p) => p.id === id);
  }

  twin(p: PartInstance): PartInstance | undefined {
    return p.mirrorOf ? this.get(p.mirrorOf) : undefined;
  }

  // ── History ──────────────────────────────────────────────────────────────
  snapshot() {
    this.undoStack.push(JSON.stringify(this.design));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Record history, run the mutation and notify listeners. */
  commit(fn: () => void) {
    this.snapshot();
    fn();
    this.emit('change');
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.design));
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.design));
    this.restore(s);
  }

  private restore(json: string) {
    this.design = JSON.parse(json);
    this.selection = this.selection.filter((id) => this.get(id));
    this.emit('change');
    this.emit('settings');
    this.emit('selection');
  }

  load(design: Design) {
    this.snapshot();
    this.design = design;
    this.selection = [];
    this.emit('change');
    this.emit('settings');
    this.emit('selection');
  }

  // ── Selection ────────────────────────────────────────────────────────────
  select(ids: string[], additive = false) {
    this.selection = additive ? [...new Set([...this.selection, ...ids])] : ids;
    this.emit('selection');
  }

  toggleSelect(id: string) {
    this.selection = this.selection.includes(id) ? this.selection.filter((s) => s !== id) : [...this.selection, id];
    this.emit('selection');
  }

  selectedParts(): PartInstance[] {
    return this.selection.map((id) => this.get(id)).filter((p): p is PartInstance => !!p);
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  setSettings(patch: Partial<DesignSettings>) {
    this.commit(() => Object.assign(this.design.settings, patch));
    this.emit('settings');
  }

  // ── Parts ────────────────────────────────────────────────────────────────
  /** Build a part with catalogue defaults (not yet added). */
  makePart(type: string, position: Vec3, rotation: Vec3 = [0, 0, 0]): PartInstance {
    const def = getDef(type);
    const k = def.scalesWithCrew ? this.design.settings.crewHeight / 1.8 : 1;
    return {
      id: newId(),
      type,
      position: [...position] as Vec3,
      rotation: [...rotation] as Vec3,
      size: def.defaultSize.map((s) => +(s * k).toFixed(3)) as Vec3,
      material: def.defaultMaterial,
      props: { ...(def.defaultProps ?? {}) },
    };
  }

  /** Add parts; with mirror mode on each off-centre part gets a linked twin. */
  addParts(parts: PartInstance[], select = true) {
    const added: string[] = [];
    const originals: string[] = [];
    this.commit(() => {
      for (const p of parts) {
        this.design.parts.push(p);
        added.push(p.id);
        originals.push(p.id);
        if (this.mirror && Math.abs(p.position[0]) > MIRROR_EPS && !p.mirrorOf) {
          const t = clonePart(p);
          t.id = newId();
          const m = mirrorTransform(p.position, p.rotation);
          t.position = m.position;
          t.rotation = m.rotation;
          // Shaped outlines and cut-outs must be mirrored too, or the twin comes out skewed.
          Object.assign(t, mirrorShapeData(p));
          t.mirrorOf = p.id;
          p.mirrorOf = t.id;
          this.design.parts.push(t);
          added.push(t.id);
        }
      }
    });
    if (select) this.select(originals);
    return added;
  }

  /**
   * Apply a change to a part and keep its mirror twin in sync. Pass
   * `record=false` for live drags where history was captured at drag start.
   */
  updatePart(id: string, patch: Partial<Pick<PartInstance, 'position' | 'rotation' | 'size' | 'material' | 'name' | 'points' | 'holes'>> & { props?: Record<string, PropValue> }, record = true) {
    const apply = () => {
      const p = this.get(id);
      if (!p) return;
      if (patch.position) p.position = [...patch.position] as Vec3;
      if (patch.rotation) p.rotation = [...patch.rotation] as Vec3;
      if (patch.size) p.size = patch.size.map((s) => Math.max(0.005, s)) as Vec3;
      if (patch.material) p.material = patch.material;
      if (patch.name !== undefined) p.name = patch.name;
      if ('points' in patch) p.points = patch.points;
      if ('holes' in patch) p.holes = patch.holes;
      if (patch.props) Object.assign(p.props, patch.props);
      const t = this.twin(p);
      if (t) {
        // A part dragged onto the centre line merges with its twin.
        const m = mirrorTransform(p.position, p.rotation);
        t.position = m.position;
        t.rotation = m.rotation;
        t.size = [...p.size] as Vec3;
        t.material = p.material;
        if (patch.props) Object.assign(t.props, patch.props);
        const mirrored = mirrorShapeData(p);
        if ('points' in patch) t.points = mirrored.points;
        if ('holes' in patch) t.holes = mirrored.holes;
      }
    };
    if (record) this.commit(apply);
    else { apply(); this.emit('change'); }
  }

  removeParts(ids: string[]) {
    const kill = new Set(ids);
    for (const id of ids) {
      const p = this.get(id);
      const t = p && this.twin(p);
      if (t) kill.add(t.id);
    }
    this.commit(() => {
      this.design.parts = this.design.parts.filter((p) => !kill.has(p.id));
      if (this.design.layers) this.design.layers = this.design.layers.filter((l) => !kill.has(l.floorId));
    });
    this.select(this.selection.filter((id) => !kill.has(id)));
  }

  /** Break the mirror link so the two sides can diverge. */
  unlinkMirror(ids: string[]) {
    this.commit(() => {
      for (const id of ids) {
        const p = this.get(id);
        const t = p && this.twin(p);
        if (p) delete p.mirrorOf;
        if (t) delete t.mirrorOf;
      }
    });
  }

  // ── Layers ───────────────────────────────────────────────────────────────
  makeLayer(floorId: string): DesignLayer | null {
    const floor = this.get(floorId);
    if (!floor) return null;
    const layers = (this.design.layers ??= []);
    const existing = layers.find((l) => l.floorId === floorId);
    if (existing) return existing;
    const layer: DesignLayer = { id: newId(), name: `Deck ${layers.length + 1}`, floorId, visible: true };
    this.commit(() => layers.push(layer));
    return layer;
  }

  updateLayer(id: string, patch: Partial<Omit<DesignLayer, 'id'>>) {
    const l = this.design.layers?.find((x) => x.id === id);
    if (l) this.commit(() => Object.assign(l, patch));
  }

  removeLayer(id: string) {
    this.commit(() => { this.design.layers = (this.design.layers ?? []).filter((l) => l.id !== id); });
  }

  duplicate(ids: string[], offset: Vec3 = [0, 0, 1]) {
    const src = ids.map((id) => this.get(id)).filter((p): p is PartInstance => !!p);
    // Don't duplicate both halves of a mirrored pair — the twin is recreated.
    const skip = new Set<string>();
    for (const p of src) if (p.mirrorOf && ids.includes(p.mirrorOf) && !skip.has(p.id)) skip.add(p.mirrorOf);
    const copies = src.filter((p) => !skip.has(p.id)).map((p) => {
      const c = clonePart(p);
      c.id = newId();
      delete c.mirrorOf;
      c.position = [p.position[0] + offset[0], p.position[1] + offset[1], p.position[2] + offset[2]];
      return c;
    });
    this.addParts(copies);
  }
}

import { defaultParams, getDef } from './catalog';
import { ConnectionSolver, structuralWarnings, type Graph, type Warning } from './connections';
import { mapPath } from './curves';
import { refreshDerived } from './hull';
import { eulerDeg, partMatrix } from './math';
import { skinPatch } from './geometry';
import { addTwins, family, syncFamily } from './mirror';
import { buildRig, jointSpec, type Rig } from './rig';
import { clone, newId, newVehicle, type Part, type Vec3, type Vehicle } from './types';
import { Matrix4 } from 'three';

/**
 * The studio's single source of truth: the vehicle document, its undo
 * history, and the selection. Every edit goes through `commit`, which keeps
 * mirror twins and derived stringers in line and records a history step.
 */

export interface HistoryEntry { label: string; time: number; snap: string }
type Event = 'change' | 'selection' | 'history' | 'pose';

export class Studio {
  v: Vehicle;
  selection: string[] = [];
  history: HistoryEntry[] = [];
  index = 0;
  revision = 0;
  /** Live mirror: new parts get twins on the enabled axes. */
  liveMirror = true;
  readonly solver = new ConnectionSolver();
  private graphCache: { rev: number; graph: Graph; rig: Rig; warnings: Warning[] } | null = null;
  private listeners: Record<Event, (() => void)[]> = { change: [], selection: [], history: [], pose: [] };
  private lastMerge: { key: string; time: number } | null = null;

  constructor(v: Vehicle = newVehicle()) {
    this.v = v;
    this.history = [{ label: 'Open', time: Date.now(), snap: JSON.stringify(v) }];
  }

  on(e: Event, f: () => void) { this.listeners[e].push(f); }
  emit(e: Event) { for (const f of this.listeners[e]) f(); }

  /**
   * Make an edit. `fn` mutates the document; parts it reports as touched have
   * their mirror families brought in line. Edits sharing a `merge` key within
   * a second fold into one history step (slider drags, nudges).
   */
  commit(label: string, fn: () => string[] | void, opts: { merge?: string } = {}) {
    const touched = fn() || [];
    for (const id of touched) if (this.v.parts.some((p) => p.id === id)) syncFamily(this.v, id);
    const changed = refreshDerived(this.v);
    for (const id of changed) syncFamily(this.v, id);
    this.prune();
    this.v.meta.modified = new Date().toISOString();
    this.revision++;
    const snap = JSON.stringify(this.v);
    const now = Date.now();
    const merge = opts.merge && this.lastMerge?.key === opts.merge && now - this.lastMerge.time < 1000 && this.index === this.history.length - 1 && this.index > 0;
    if (merge) this.history[this.index] = { label, time: now, snap };
    else {
      this.history.splice(this.index + 1);
      this.history.push({ label, time: now, snap });
      if (this.history.length > 300) this.history.splice(1, this.history.length - 300);
      this.index = this.history.length - 1;
    }
    this.lastMerge = opts.merge ? { key: opts.merge, time: now } : null;
    this.emit('change');
    this.emit('history');
  }

  /** Change joint values without touching the parts (posing). Recorded, merged while dragging. */
  pose(label: string, fn: () => void, merge = 'pose') {
    fn();
    this.revisionPoseOnly();
    const snap = JSON.stringify(this.v);
    const now = Date.now();
    if (this.lastMerge?.key === merge && now - this.lastMerge.time < 1000 && this.index === this.history.length - 1 && this.index > 0) {
      this.history[this.index] = { label, time: now, snap };
    } else {
      this.history.splice(this.index + 1);
      this.history.push({ label, time: now, snap });
      this.index = this.history.length - 1;
    }
    this.lastMerge = { key: merge, time: now };
    this.emit('pose');
    this.emit('history');
  }

  /** Joint values changed by playback: no history step. */
  revisionPoseOnly() { this.emit('pose'); }

  jumpTo(i: number) {
    if (i < 0 || i >= this.history.length || i === this.index) return;
    this.index = i;
    this.v = JSON.parse(this.history[i].snap);
    this.selection = this.selection.filter((id) => this.v.parts.some((p) => p.id === id));
    this.revision++;
    this.lastMerge = null;
    this.emit('change');
    this.emit('selection');
    this.emit('history');
  }

  undo() { this.jumpTo(this.index - 1); }
  redo() { this.jumpTo(this.index + 1); }
  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.history.length - 1; }

  /** Replace the whole document (open a file). Starts a fresh history. */
  load(v: Vehicle, label = 'Open') {
    this.v = v;
    this.selection = [];
    this.revision++;
    this.history = [{ label, time: Date.now(), snap: JSON.stringify(v) }];
    this.index = 0;
    this.emit('change');
    this.emit('selection');
    this.emit('history');
  }

  select(ids: string[], add = false) {
    const next = add ? [...new Set([...this.selection, ...ids])] : [...new Set(ids)];
    this.selection = next.filter((id) => this.v.parts.some((p) => p.id === id));
    this.emit('selection');
  }

  toggleSelect(id: string) {
    this.selection = this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id];
    this.emit('selection');
  }

  get(id: string) { return this.v.parts.find((p) => p.id === id); }
  selected(): Part[] { return this.selection.map((id) => this.get(id)).filter((p): p is Part => !!p); }

  /** Connection graph, rig and structural warnings, recomputed lazily after edits. */
  analysis() {
    if (this.graphCache?.rev === this.revision) return this.graphCache;
    const graph = this.solver.solve(this.v);
    const rig = buildRig(this.v, graph);
    const warnings = structuralWarnings(this.v, graph);
    for (const p of this.v.parts) {
      if (p.surface && !skinPatch(this.v, p)) warnings.push({ kind: 'skin', message: `${p.name || 'Skin plate'}: its edges no longer form a closed loop.`, parts: [p.id] });
    }
    this.graphCache = { rev: this.revision, graph, rig, warnings };
    return this.graphCache;
  }

  /** Remove references to parts that no longer exist. */
  private prune() {
    const ids = new Set(this.v.parts.map((p) => p.id));
    let again = true;
    while (again) {
      again = false;
      const before = this.v.parts.length;
      this.v.parts = this.v.parts.filter((p) => {
        if (p.surface && p.surface.edges.some((e) => !ids.has(e.part))) return false;
        if (p.derived && p.derived.ribs.filter((r) => ids.has(r)).length < 2) return false;
        return true;
      });
      if (this.v.parts.length !== before) { again = true; ids.clear(); for (const p of this.v.parts) ids.add(p.id); }
    }
    for (const p of this.v.parts) {
      if (p.mirror && !ids.has(p.mirror.source)) delete p.mirror;
      if (p.derived) p.derived.ribs = p.derived.ribs.filter((r) => ids.has(r));
    }
    for (const k of Object.keys(this.v.jointValues)) if (!ids.has(k)) delete this.v.jointValues[k];
    for (const c of this.v.controls) c.links = c.links.filter((l) => ids.has(l.joint));
    for (const pose of this.v.poses) for (const k of Object.keys(pose.values)) if (!ids.has(k)) delete pose.values[k];
    this.v.connections = this.v.connections.filter((c) => ids.has(c.a) && ids.has(c.b));
    this.selection = this.selection.filter((id) => ids.has(id));
  }

  // ── Editing operations ────────────────────────────────────────────────────

  /** Add parts (and their live twins). Returns the new parts. */
  addParts(parts: Part[], label = 'Add part', mirror = this.liveMirror): Part[] {
    const all: Part[] = [];
    this.commit(label, () => {
      for (const p of parts) {
        this.v.parts.push(p);
        all.push(p);
        if (mirror) all.push(...addTwins(this.v, p));
      }
    });
    return all;
  }

  /** Parts plus their mirror family members. */
  withFamilies(ids: string[]): string[] {
    const out = new Set<string>();
    for (const id of ids) for (const p of family(this.v, id)) out.add(p.id);
    return [...out];
  }

  deleteParts(ids: string[]) {
    if (!ids.length) return;
    const gone = new Set(this.withFamilies(ids));
    this.commit(gone.size > 1 ? `Delete ${gone.size} parts` : 'Delete part', () => {
      this.v.parts = this.v.parts.filter((p) => !gone.has(p.id));
    });
    this.select([]);
  }

  updatePart(id: string, patch: Partial<Part>, label = 'Edit part', merge?: string) {
    this.commit(label, () => {
      const p = this.get(id);
      if (!p) return;
      Object.assign(p, clone(patch));
      return [id];
    }, { merge });
  }

  /** Move and/or rotate parts by a world matrix (from the gizmo or nudges). */
  transformParts(ids: string[], m: Matrix4, label = 'Move', merge?: string) {
    const unique = this.withoutTwinsOf(ids);
    this.commit(label, () => {
      const touched: string[] = [];
      for (const id of unique) {
        const p = this.get(id);
        if (!p) continue;
        transformPart(p, m, this.v.grid.minor);
        touched.push(id);
      }
      return touched;
    }, { merge });
  }

  /** When a part and its own twin are both selected, only drive the first one (the twin follows). */
  withoutTwinsOf(ids: string[]): string[] {
    const out: string[] = [];
    const fams = new Set<string>();
    for (const id of ids) {
      const p = this.get(id);
      if (!p) continue;
      const src = p.mirror?.source ?? p.id;
      if (fams.has(src)) continue;
      fams.add(src);
      out.push(id);
    }
    return out;
  }

  duplicate(ids: string[], offset: Vec3) {
    const map = new Map<string, string>();
    const src = this.withoutTwinsOf(ids).map((id) => this.get(id)!).filter(Boolean);
    for (const p of src) map.set(p.id, newId());
    const copies = src.map((p) => {
      const q = clone(p);
      q.id = map.get(p.id)!;
      delete q.mirror;
      transformPart(q, new Matrix4().makeTranslation(...offset), this.v.grid.minor);
      if (q.surface) q.surface.edges = q.surface.edges.map((e) => ({ ...e, part: map.get(e.part) ?? e.part }));
      if (q.derived) q.derived.ribs = q.derived.ribs.map((r) => map.get(r) ?? r);
      return q;
    });
    const made = this.addParts(copies, copies.length > 1 ? `Duplicate ${copies.length} parts` : 'Duplicate');
    this.select(made.filter((p) => !p.mirror).map((p) => p.id));
  }

  newPart(defId: string, position: Vec3, rotation: Vec3 = [0, 0, 0]): Part {
    const def = getDef(defId, this.v);
    const p: Part = {
      id: newId(), def: defId, params: defaultParams(def), position, rotation,
      material: def.material, layer: def.layer,
    };
    if (def.joint) p.joint = { ...def.joint };
    if (def.stats) p.stats = { ...def.stats };
    return p;
  }

  isJoint(p: Part) { return !!jointSpec(this.v, p); }
}

/** Apply a world transform to a part's placement (or its path), keeping things on the grid. */
export function transformPart(p: Part, m: Matrix4, grid: number) {
  if (p.surface || p.derived) return;
  if (p.path) {
    p.path = mapPath(p.path, (x) => snap(applyPoint(m, x), grid));
    p.position = [...p.path.points[0]] as Vec3;
    return;
  }
  const pm = partMatrix(p);
  const nm = m.clone().multiply(pm);
  const pos = applyPoint(m, p.position);
  p.position = snap(pos, grid);
  // Rotation without the flip: strip it back off before reading the angles.
  const f = p.flip ?? [1, 1, 1];
  const unflip = new Matrix4().makeScale(f[0], f[1], f[2]);
  const r = nm.clone().multiply(unflip);
  r.setPosition(0, 0, 0);
  p.rotation = eulerDeg(r);
}

function applyPoint(m: Matrix4, v: Vec3): Vec3 {
  const e = m.elements;
  return [e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12], e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13], e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14]];
}

function snap(v: Vec3, g: number): Vec3 {
  const r = (x: number) => { const y = +(Math.round(x / g) * g).toFixed(6); return y === 0 ? 0 : y; };
  return [r(v[0]), r(v[1]), r(v[2])];
}


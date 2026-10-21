import * as THREE from 'three';
import { getDef } from '../model/catalog';
import { partSignature } from '../model/connections';
import { partMatrix } from '../model/math';
import { poseGroups, type Rig } from '../model/rig';
import type { Layer, Part, Vehicle } from '../model/types';
import { buildPart, disposeObject, retint, type PartMeshes } from './meshes';

export type Tint = 'none' | 'selected' | 'warning' | 'hover';

export interface ViewFlags {
  hidden: Set<Layer>;
  locked: Set<Layer>;
  isolate: Layer | null;
  effects: boolean;
}

interface Entry {
  key: string;
  tint: Tint;
  meshes: PartMeshes;
  main: THREE.Group;
  head?: THREE.Group;
  layer: Layer;
}

/**
 * Keeps a three.js copy of the vehicle in step with the document. Each rigid
 * group of the rig is a container whose matrix is its posed transform, so
 * posing only updates a handful of matrices.
 */
export class VehicleView {
  readonly root = new THREE.Group();
  private entries = new Map<string, Entry>();
  private groups: THREE.Group[] = [];
  private rig: Rig | null = null;

  sync(v: Vehicle, rig: Rig, tints: Map<string, Tint>, flags: ViewFlags) {
    this.rig = rig;
    const live = new Set(v.parts.map((p) => p.id));
    for (const [id, e] of this.entries) if (!live.has(id)) { this.drop(e); this.entries.delete(id); }
    // Rigid-group containers.
    while (this.groups.length < rig.groups.length) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      this.root.add(g);
      this.groups.push(g);
    }
    while (this.groups.length > rig.groups.length) this.root.remove(this.groups.pop()!);
    const bySig = new Map(v.parts.map((p) => [p.id, partSignature(p)]));
    for (const p of v.parts) {
      let key = bySig.get(p.id)! + p.material;
      if (p.surface) key += p.surface.edges.map((e) => bySig.get(e.part) ?? '').join('|');
      const tint = tints.get(p.id) ?? 'none';
      let e = this.entries.get(p.id);
      if (!e || e.key !== key) {
        if (e) this.drop(e);
        e = this.build(v, p, key);
        this.entries.set(p.id, e);
      }
      if (e.tint !== tint) {
        retint(e.main, tint);
        if (e.head) retint(e.head, tint);
        e.tint = tint;
      }
      e.layer = p.layer;
      const shown = flags.isolate ? p.layer === flags.isolate : !flags.hidden.has(p.layer);
      e.main.visible = shown;
      if (e.head) e.head.visible = shown;
      if (e.meshes.effect) e.meshes.effect.visible = flags.effects;
      // Place in rigid groups.
      const gid = rig.groupOf.get(p.id);
      const halves = rig.groups.filter((g) => g.halves.some(([j]) => j === p.id));
      if (e.head) {
        const gb = halves.find((g) => g.halves.some(([j, h]) => j === p.id && h === 'base'));
        const gh = halves.find((g) => g.halves.some(([j, h]) => j === p.id && h === 'head'));
        this.groups[gb?.id ?? 0].add(e.main);
        this.groups[gh?.id ?? 0].add(e.head);
      } else {
        this.groups[gid ?? halves[0]?.id ?? 0].add(e.main);
      }
    }
    this.pose(v);
  }

  /** Update group transforms for the current (or given) joint values. */
  pose(v: Vehicle, values?: Record<string, number[]>) {
    if (!this.rig) return;
    const mats = poseGroups(v, this.rig, values);
    mats.forEach((m, i) => { if (this.groups[i]) { this.groups[i].matrix.copy(m); this.groups[i].matrixWorldNeedsUpdate = true; } });
  }

  setEffects(on: boolean) {
    for (const e of this.entries.values()) if (e.meshes.effect) e.meshes.effect.visible = on;
  }

  private build(v: Vehicle, p: Part, key: string): Entry {
    const meshes = buildPart(v, p);
    const wrap = (o: THREE.Object3D) => {
      const g = new THREE.Group();
      g.add(o);
      if (!meshes.world) { g.matrixAutoUpdate = false; g.matrix.copy(partMatrix(p)); }
      g.userData.partId = p.id;
      g.traverse((x) => { x.userData.partId = p.id; });
      return g;
    };
    const main = wrap(meshes.main);
    const head = meshes.head ? wrap(meshes.head) : undefined;
    if (getDef(p.def, v).kind === 'joint' && head) { main.userData.half = 'base'; head.userData.half = 'head'; }
    return { key, tint: 'none', meshes, main, head, layer: p.layer };
  }

  private drop(e: Entry) {
    e.main.removeFromParent();
    e.head?.removeFromParent();
    disposeObject(e.main);
    if (e.head) disposeObject(e.head);
  }

  /** Meshes the pointer can hit (visible, unlocked). */
  pickables(locked: Set<Layer>): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of this.entries.values()) {
      if (locked.has(e.layer)) continue;
      for (const o of [e.main, e.head]) if (o?.visible) out.push(o);
    }
    return out;
  }

  objectsOf(id: string): THREE.Object3D[] {
    const e = this.entries.get(id);
    return e ? [e.main, ...(e.head ? [e.head] : [])] : [];
  }

  /** World bounding box of the whole vehicle as drawn. */
  bounds(): THREE.Box3 {
    const b = new THREE.Box3();
    this.root.updateMatrixWorld(true);
    for (const e of this.entries.values()) if (e.main.visible) { b.expandByObject(e.main); if (e.head) b.expandByObject(e.head); }
    return b;
  }
}

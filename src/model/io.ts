import { hasDef } from './catalog';
import { newVehicle, type Vehicle } from './types';

/** Check and complete a vehicle read from a file or storage. Returns null if it isn't one. */
export function parseVehicle(text: string): Vehicle | null {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return null; }
  return validateVehicle(x);
}

export function validateVehicle(x: unknown): Vehicle | null {
  const d = x as Partial<Vehicle>;
  if (!d || typeof d !== 'object' || d.format !== 'vehicle-studio' || !Array.isArray(d.parts)) return null;
  const base = newVehicle(typeof d.name === 'string' ? d.name : 'Untitled vehicle');
  const v: Vehicle = {
    ...base,
    ...d,
    grid: { ...base.grid, ...(d.grid ?? {}) },
    mirror: { ...base.mirror, ...(d.mirror ?? {}) },
    meta: { ...base.meta, ...(d.meta ?? {}) },
  } as Vehicle;
  for (const k of ['connections', 'controls', 'poses', 'animations', 'assemblies', 'materials', 'partDefs', 'statDefs'] as const) {
    if (!Array.isArray(v[k])) (v as unknown as Record<string, unknown>)[k] = [];
  }
  if (!v.jointValues || typeof v.jointValues !== 'object') v.jointValues = {};
  if (!v.stats || typeof v.stats !== 'object') v.stats = {};
  v.parts = v.parts.filter((p) => p && typeof p.id === 'string' && hasDef(p.def, v) && Array.isArray(p.position) && Array.isArray(p.rotation));
  for (const p of v.parts) {
    p.params = p.params ?? {};
    p.layer = p.layer ?? 'frame';
  }
  return v;
}

export function serialize(v: Vehicle): string {
  return JSON.stringify(v, null, 1);
}

// ── Browser storage: autosave and named versions ────────────────────────────

const AUTOSAVE = 'vehicle-studio:autosave';
const VERSIONS = 'vehicle-studio:versions';

export interface SavedVersion { id: string; name: string; time: string; vehicle: string }

function store(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function autosave(v: Vehicle) {
  try { store()?.setItem(AUTOSAVE, JSON.stringify(v)); } catch { /* full or blocked */ }
}

export function loadAutosave(): Vehicle | null {
  try {
    const s = store()?.getItem(AUTOSAVE);
    return s ? parseVehicle(s) : null;
  } catch { return null; }
}

export function listVersions(): SavedVersion[] {
  try { return JSON.parse(store()?.getItem(VERSIONS) ?? '[]'); } catch { return []; }
}

export function saveVersion(v: Vehicle, name: string): SavedVersion[] {
  const list = listVersions();
  list.unshift({ id: `ver${Date.now().toString(36)}`, name, time: new Date().toISOString(), vehicle: JSON.stringify(v) });
  try { store()?.setItem(VERSIONS, JSON.stringify(list.slice(0, 30))); } catch { /* full */ }
  return listVersions();
}

export function deleteVersion(id: string): SavedVersion[] {
  const list = listVersions().filter((x) => x.id !== id);
  try { store()?.setItem(VERSIONS, JSON.stringify(list)); } catch { /* blocked */ }
  return list;
}

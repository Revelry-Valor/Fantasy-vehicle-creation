import { storageGet, storageSet } from './dom';

/** Every keyboard shortcut, rebindable from Vehicle → Keys. */
export const ACTIONS = {
  select: { label: 'Select tool', key: 'v' },
  beam: { label: 'Beam tool', key: 'b' },
  pose: { label: 'Pose tool', key: 'p' },
  aim: { label: 'Aim tool', key: 'a' },
  ruler: { label: 'Ruler', key: 'l' },
  move: { label: 'Move gizmo', key: 'w' },
  rotateGizmo: { label: 'Rotate gizmo', key: 'e' },
  turnY: { label: 'Turn 90° (yaw)', key: 'r' },
  turnX: { label: 'Turn 90° (pitch)', key: 't' },
  turnZ: { label: 'Turn 90° (roll)', key: 'shift+t' },
  plane: { label: 'Cycle working plane', key: 'q' },
  planeUp: { label: 'Working plane up', key: 'pageup' },
  planeDown: { label: 'Working plane down', key: 'pagedown' },
  grid: { label: 'Grid: all / plane / off', key: 'g' },
  mirror: { label: 'Live mirror on/off', key: 'm' },
  frame: { label: 'Frame selection / all', key: 'f' },
  front: { label: 'Front view', key: '1' },
  side: { label: 'Side view', key: '2' },
  top: { label: 'Top view', key: '3' },
  three: { label: 'Three-quarter view', key: '4' },
  play: { label: 'Play / pause animation', key: ' ' },
  delete: { label: 'Delete selection', key: 'delete' },
  duplicate: { label: 'Duplicate', key: 'ctrl+d' },
  undo: { label: 'Undo', key: 'ctrl+z' },
  redo: { label: 'Redo', key: 'ctrl+y' },
  connected: { label: 'Select connected', key: 'c' },
  walk: { label: 'Walk-through mode', key: 'k' },
} as const;

export type Action = keyof typeof ACTIONS;
const STORE = 'vehicle-studio:keys';

let map: Record<Action, string> = load();

function load(): Record<Action, string> {
  const saved = storageGet<Partial<Record<Action, string>>>(STORE, {});
  const out = {} as Record<Action, string>;
  for (const k of Object.keys(ACTIONS) as Action[]) out[k] = saved[k] ?? ACTIONS[k].key;
  return out;
}

export function keyOf(a: Action) { return map[a]; }

export function rebind(a: Action, key: string) {
  map = { ...map, [a]: key };
  storageSet(STORE, map);
}

export function resetKeys() {
  storageSet(STORE, {});
  map = load();
}

/** Normalise an event to the same form as the map: "ctrl+shift+x". */
export function comboOf(e: KeyboardEvent): string {
  const k = e.key === ' ' ? ' ' : e.key.toLowerCase();
  const mods = [(e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt', e.shiftKey && k !== ' ' && 'shift'].filter(Boolean);
  return [...mods, k].join('+');
}

export function actionFor(e: KeyboardEvent): Action | null {
  const c = comboOf(e);
  for (const a of Object.keys(map) as Action[]) if (map[a] === c) return a;
  if (c === 'backspace' && map.delete === 'delete') return 'delete';
  if (c === 'ctrl+shift+z' && map.redo === 'ctrl+y') return 'redo';
  return null;
}

export function pretty(key: string) {
  return key.split('+').map((k) => (k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+');
}

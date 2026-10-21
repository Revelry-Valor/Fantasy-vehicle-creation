import './style.css';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { getDef } from './model/catalog';
import type { Warning } from './model/connections';
import { boxFrame, cylinderFrame, wedgeFrame } from './model/hull';
import { autosave, loadAutosave, parseVehicle, serialize } from './model/io';
import { addTwins } from './model/mirror';
import { motionWarnings, poseCollisions } from './model/rig';
import { SAMPLES } from './model/samples';
import { Studio } from './model/studio';
import { clone, newId, newVehicle, type Part, type PartDef, type Vec3 } from './model/types';
import { Viewport, type Tool } from './render/viewport';
import { Walk } from './render/walk';
import { PartBrowser } from './ui/browser';
import { clear, dataUrlToBlob, download, h, slug, storageGet, storageSet } from './ui/dom';
import { actionFor, keyOf, pretty } from './ui/keys';
import { MotionPanel } from './ui/motion';
import { ChecksPanel, HistoryPanel, VehiclePanel } from './ui/panels';
import { PropertiesPanel } from './ui/properties';
import { Tutorial } from './ui/tutorial';

type Tab = 'props' | 'motion' | 'checks' | 'history' | 'vehicle';
const $ = (id: string) => document.getElementById(id)!;

// ── State ───────────────────────────────────────────────────────────────────
const recovered = loadAutosave();
const studio = new Studio(recovered ?? newVehicle());
const vp = new Viewport($('viewport'), studio);
const walk = new Walk(vp);
let tab: Tab = 'props';
let playing: { anim: string; t0: number; offset: number } | null = null;
let playTime = 0;

const status = (m: string) => { $('status').textContent = m || defaultStatus(); };
vp.onStatus = status;
vp.onToolChange = () => { renderToolbar(); browser.render(); };

const browser = new PartBrowser($('browser'), studio, {
  pick: (d: PartDef) => {
    if (d.kind === 'skin') { status('Skin plates are made from beams: select 3 or 4 beams (or ribs and stringers), then use Skin in Properties.'); setTab('props'); return; }
    if (d.kind === 'beam') vp.setTool('beam', { def: d.id });
    else vp.setTool('place', { def: d.id });
    status(d.kind === 'beam' ? `${d.name}: click grid points. ${vp.beamMode === 'chain' ? 'Each click adds a straight beam.' : 'Double-click to finish the curved beam.'}` : `${d.name}: click to place. It snaps to the grid and sits on whatever is under the cursor.`);
  },
  generator: (k) => generatorDialog(k),
  placeAssembly: (id) => placeAssembly(id),
  deleteAssembly: (id) => studio.commit('Delete assembly', () => { studio.v.assemblies = studio.v.assemblies.filter((a) => a.id !== id); }),
  active: () => (vp.tool === 'place' ? vp.placeDef : vp.tool === 'beam' ? vp.beamDef : null),
});

const panes: Record<Tab, HTMLElement> = { props: h('div', { class: 'pane' }), motion: h('div', { class: 'pane' }), checks: h('div', { class: 'pane' }), history: h('div', { class: 'pane' }), vehicle: h('div', { class: 'pane' }) };
$('tab-body').append(...Object.values(panes));
const props = new PropertiesPanel(panes.props, studio, vp, status);
const motion = new MotionPanel(panes.motion, studio, {
  playing: () => !!playing,
  play: (id) => play(id),
  stop: () => stop(),
  time: () => playTime,
  seek: (t) => seek(t),
  aimTool: () => { vp.setTool('aim'); status('Click a target: every turret and gun linked to an aim control turns to face it.'); },
  status,
});
const checks = new ChecksPanel(panes.checks, studio, (w) => pickWarning(w), () => runMotionCheck());
const history = new HistoryPanel(panes.history, studio, status, () => vp.screenshot(false, 0.5));
const vehicle = new VehiclePanel(panes.vehicle, studio, vp, status, { tutorial: () => tutorial.start(), refreshBrowser: () => browser.render() });
const tutorial = new Tutorial($('viewport'), studio, vp, status);

// ── Wiring ──────────────────────────────────────────────────────────────────
let saveTimer = 0;
let motionTimer = 0;
studio.on('change', () => {
  checks.motion = [];
  checks.motionStale = true;
  updateWarnings();
  vp.refresh();
  browser.render();
  renderTab();
  renderToolbar();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => autosave(studio.v), 600);
  clearTimeout(motionTimer);
  motionTimer = window.setTimeout(() => { if (studio.v.parts.length < 400) runMotionCheck(true); }, 1500);
  tutorial.check();
  status('');
});
studio.on('selection', () => {
  vp.refreshTints();
  vp.updateGizmo();
  vp.updateHandles();
  if (tab === 'props' || tab === 'motion') renderTab();
  if (tab !== 'props' && tab !== 'motion' && studio.selection.length && !playing) setTab('props');
  browser.render();
});
let poseTimer = 0;
studio.on('pose', () => {
  vp.repose();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => autosave(studio.v), 600);
  // Collision while posing: parts that hit each other light up.
  clearTimeout(poseTimer);
  poseTimer = window.setTimeout(() => { if (!playing) updateWarnings(); }, 60);
  tutorial.check();
});
studio.on('history', () => { if (tab === 'history') history.render(); renderToolbar(); });

let posingHits: [string, string][] = [];
function updateWarnings() {
  const a = studio.analysis();
  posingHits = Object.keys(studio.v.jointValues).length && studio.v.parts.length < 600 ? poseCollisions(studio.v, a.rig, a.graph, studio.solver) : [];
  vp.warned = new Set([...a.warnings.flatMap((w) => w.parts), ...checks.motion.filter((w) => w.kind !== 'motion').flatMap((w) => w.parts), ...posingHits.flat()]);
  vp.refreshTints();
  const n = a.warnings.length + checks.motion.length + posingHits.length;
  const badge = document.querySelector('#tabs [data-tab="checks"] .badge');
  if (badge) { badge.textContent = n ? String(n) : ''; (badge as HTMLElement).hidden = !n; }
  if (tab === 'checks') checks.render(posingHits);
}

function runMotionCheck(quiet = false) {
  const a = studio.analysis();
  checks.motion = motionWarnings(studio.v, a.rig, a.graph, studio.solver, 8).filter((w) => w.kind !== 'motion' || !w.message.startsWith('In this pose'));
  checks.motionStale = false;
  updateWarnings();
  if (!quiet) status(checks.motion.length ? `${checks.motion.length} joint problem${checks.motion.length > 1 ? 's' : ''} found.` : 'Every joint moves through its whole range without hitting anything.');
}

function pickWarning(w: Warning) {
  studio.select(w.parts);
  vp.frame(w.parts);
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function setTab(t: Tab) {
  tab = t;
  for (const [k, el] of Object.entries(panes)) el.hidden = k !== t;
  const labels: Record<Tab, string> = { props: 'Properties', motion: 'Controls', checks: 'Checks', history: 'History', vehicle: 'Vehicle' };
  clear($('tabs'), (Object.keys(labels) as Tab[]).map((k) => h('button', { class: k === t ? 'active' : '', 'data-tab': k, onclick: () => setTab(k) }, labels[k], k === 'checks' ? h('span', { class: 'badge', hidden: true }) : null)));
  renderTab();
  updateWarnings();
}

function renderTab() {
  if (tab === 'props') props.render();
  if (tab === 'motion') motion.render();
  if (tab === 'checks') checks.render(posingHits);
  if (tab === 'history') history.render();
  if (tab === 'vehicle') vehicle.render();
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
function renderToolbar() {
  const btn = (label: string, on: () => void, o: { active?: boolean; title?: string; disabled?: boolean; cls?: string } = {}) =>
    h('button', { class: `${o.active ? 'active ' : ''}${o.cls ?? ''}`, title: o.title, disabled: o.disabled, onclick: on }, label);
  const k = (a: Parameters<typeof keyOf>[0]) => ` (${pretty(keyOf(a))})`;
  const tool = (t: Tool, label: string, title: string) => btn(label, () => { vp.setTool(t); if (t === 'pose') status('Drag any part past a joint to move it. Parts that would hit each other light up red.'); if (t === 'ruler') status('Click two points to measure between them.'); }, { active: vp.tool === t, title });
  const v = studio.v;
  const file = h('details', { class: 'menu' }, h('summary', {}, '☰ File'),
    h('div', { class: 'menu-body' },
      h('button', { onclick: () => { closeMenus(); if (confirm('Start a new vehicle? Undo can bring this one back.')) { stop(); const nv = newVehicle(); studio.commit('New vehicle', () => { Object.assign(studio.v, nv); }); setTimeout(() => vp.frame(), 50); } } }, 'New vehicle'),
      h('div', { class: 'menu-sep' }, 'Samples'),
      SAMPLES.map((s) => h('button', { title: s.description, onclick: () => { closeMenus(); stop(); studio.load(s.make(), `Open sample: ${s.name}`); setTimeout(() => vp.quickView('three'), 60); } }, s.name)),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { closeMenus(); ($('file-input') as HTMLInputElement).click(); } }, 'Open .json…'),
      h('button', { onclick: () => { closeMenus(); download(`${slug(v.name)}.vehicle.json`, serialize(v), 'application/json'); status('Saved as JSON (format described in docs/FILE_FORMAT.md).'); } }, 'Save .json'),
      h('button', { onclick: () => { closeMenus(); exportGLTF(); } }, 'Export glTF (.glb)'),
      h('div', { class: 'menu-sep' }, 'Images'),
      h('button', { onclick: () => { closeMenus(); download(`${slug(v.name)}.png`, dataUrlToBlob(vp.screenshot(false)), 'image/png'); } }, 'Screenshot'),
      h('button', { onclick: () => { closeMenus(); download(`${slug(v.name)}-transparent.png`, dataUrlToBlob(vp.screenshot(true)), 'image/png'); } }, 'Screenshot, transparent background'),
      h('button', { onclick: () => { closeMenus(); poseSheet(); } }, 'Pose renders (one image per pose)'),
      h('button', { onclick: () => { closeMenus(); turntable(); } }, 'Turntable video (.webm)'),
    ));
  const mirror = h('div', { class: 'group' },
    btn(`⇋ Mirror ${studio.liveMirror ? 'on' : 'off'}`, () => { studio.liveMirror = !studio.liveMirror; vp.refresh(); renderToolbar(); }, { active: studio.liveMirror, title: `Live mirror${k('mirror')}: build one side and the other follows` }),
    (['x', 'y', 'z'] as const).map((a) => btn(a.toUpperCase(), () => studio.commit('Mirror axes', () => { v.mirror[a] = !v.mirror[a]; }), { active: v.mirror[a] && studio.liveMirror, title: { x: 'Mirror left / right', y: 'Mirror top / bottom', z: 'Mirror front / back' }[a] })));
  const planeName = { y: 'Level', z: 'Front', x: 'Side' }[vp.plane.axis];
  clear($('toolbar'),
    h('div', { class: 'brand' }, '⬢ Vehicle Studio', h('input', { class: 'vname', value: v.name, title: 'Vehicle name', onchange: (e) => studio.commit('Rename vehicle', () => { v.name = (e.target as HTMLInputElement).value || 'Untitled vehicle'; }) })),
    file,
    h('div', { class: 'group' },
      btn('↶', () => studio.undo(), { title: 'Undo (Ctrl+Z)', disabled: !studio.canUndo() }),
      btn('↷', () => studio.redo(), { title: 'Redo (Ctrl+Y)', disabled: !studio.canRedo() })),
    h('div', { class: 'group' },
      tool('select', '➚ Select', `Select and move${k('select')}`),
      btn('▬ Beam', () => vp.setTool('beam'), { active: vp.tool === 'beam', title: `Draw beams${k('beam')}` }),
      tool('pose', '🦾 Pose', `Drag parts past joints${k('pose')}`),
      tool('aim', '⌖ Aim', `Aim linked turrets at a point${k('aim')}`),
      tool('ruler', '📏 Ruler', `Measure${k('ruler')}`)),
    vp.tool === 'select' ? h('div', { class: 'group' },
      btn('✥ Move', () => { vp.setGizmoMode('translate'); renderToolbar(); }, { active: vp.gizmoMode === 'translate', title: `Move gizmo${k('move')}` }),
      btn('⟳ Rotate', () => { vp.setGizmoMode('rotate'); renderToolbar(); }, { active: vp.gizmoMode === 'rotate', title: `Rotate gizmo, 15° steps${k('rotateGizmo')}` })) : null,
    vp.tool === 'beam' ? h('div', { class: 'group' },
      btn('Straight', () => { vp.beamMode = 'chain'; vp.cancelBeam(); renderToolbar(); }, { active: vp.beamMode === 'chain', title: 'Each click adds a straight beam' }),
      btn('Curved', () => { vp.beamMode = 'curve'; vp.cancelBeam(); renderToolbar(); }, { active: vp.beamMode === 'curve', title: 'One beam flowing through every click; double-click or Enter to finish' })) : null,
    mirror,
    h('div', { class: 'group', title: 'The plane you draw on' },
      btn(`▦ ${planeName} ${vp.plane.offset} m`, () => { vp.cyclePlane(); renderToolbar(); }, { title: `Working plane${k('plane')}. PgUp/PgDn move it.` }),
      btn({ all: 'Grid: all', plane: 'Grid: plane', off: 'Grid: off' }[vp.gridMode], () => { vp.gridMode = vp.gridMode === 'all' ? 'plane' : vp.gridMode === 'plane' ? 'off' : 'all'; vp.updateGrid(); renderToolbar(); }, { title: `Show the grid everywhere, only on the working plane, or not at all${k('grid')}` }),
      h('span', { class: 'muted small' }, `${v.grid.major} / ${v.grid.minor} m`)),
    h('div', { class: 'group' },
      (['front', 'side', 'top', 'three'] as const).map((q, i) => btn(['F', 'S', 'T', '¾'][i], () => vp.quickView(q), { title: `${q === 'three' ? 'Three-quarter' : q[0].toUpperCase() + q.slice(1)} view (${i + 1})` })),
      btn('⌖', () => vp.frame(studio.selection), { title: `Frame selection or everything${k('frame')}` }),
      btn('🚶', () => startWalk(), { active: walk.active, title: `Walk through at figure scale${k('walk')}` })),
    playing ? h('div', { class: 'group' }, btn('❚❚ Stop', () => stop(), { cls: 'primary' })) : null,
  );
}

function closeMenus() { document.querySelectorAll('details.menu').forEach((d) => d.removeAttribute('open')); }

// ── Playback ────────────────────────────────────────────────────────────────
function play(id: string | null) {
  const a = studio.v.animations.find((x) => x.id === id) ?? studio.v.animations[0];
  if (!a) return;
  motion.activeAnim = a.id;
  playing = { anim: a.id, t0: performance.now(), offset: playTime % Math.max(0.001, a.duration) };
  if (vp.flags.effects) vp.view.setEffects(true);
  renderToolbar();
  renderTab();
}

function stop() {
  if (!playing) return;
  playing = null;
  renderToolbar();
  renderTab();
  updateWarnings();
}

function seek(t: number) {
  stop();
  playTime = t;
  const vals = motion.sample(t);
  if (vals) studio.pose('Scrub', () => { Object.assign(studio.v.jointValues, vals); }, 'scrub');
  if (tab === 'motion') motion.render();
}

let lastFrame = performance.now();
function tick(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) {
    const a = studio.v.animations.find((x) => x.id === playing!.anim);
    if (!a) stop();
    else {
      playTime = playing.offset + (now - playing.t0) / 1000;
      if (!a.loop && playTime >= a.duration) { playTime = a.duration; stop(); }
      const vals = motion.sample(playTime) ?? {};
      // Wheels roll during playback when effects are on.
      if (vp.flags.effects) for (const p of studio.v.parts) if (getDef(p.def, studio.v).behavior === 'wheel') {
        const cur = studio.v.jointValues[p.id] ?? [0, 0];
        studio.v.jointValues[p.id] = [(cur[0] ?? 0) + dt * 120, vals[p.id]?.[1] ?? cur[1] ?? 0];
      }
      Object.assign(studio.v.jointValues, vals);
      vp.repose();
      const head = panes.motion.querySelector('.tl-head') as HTMLElement | null;
      if (head) head.style.left = `${(Math.min(a.duration, a.loop ? playTime % a.duration : playTime) / a.duration) * 100}%`;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── Actions ─────────────────────────────────────────────────────────────────
function cursorSpot(): Vec3 {
  const t = vp.controls.target;
  const g = studio.v.grid.major;
  return [Math.round(t.x / g) * g, Math.max(0, Math.round(t.y / g) * g), Math.round(t.z / g) * g];
}

function generatorDialog(kind: 'box' | 'wedge' | 'cylinder') {
  const g = studio.v.grid.major;
  const vals: Record<string, number> = kind === 'cylinder' ? { radius: 2 * g, length: 8 * g, stations: 4, stringers: 8 } : { width: 3 * g, height: 2 * g, length: 5 * g };
  const fields = Object.entries(vals).map(([key, val]) => h('label', { class: 'field' }, h('span', {}, key[0].toUpperCase() + key.slice(1)),
    h('input', { type: 'number', value: val, step: key === 'stations' || key === 'stringers' ? 1 : studio.v.grid.minor, oninput: (e) => { vals[key] = parseFloat((e.target as HTMLInputElement).value); } })));
  const dlg = h('dialog', { class: 'modal' },
    h('h3', {}, { box: 'Box frame', wedge: 'Wedge frame', cylinder: 'Cylinder frame' }[kind]),
    h('p', { class: 'hint' }, kind === 'cylinder' ? 'Ring ribs along Z with stringers through them. Select a stringer and use Skin hull to plate it.' : 'Beams around the shape, centred at the camera\'s focus. Edit them by hand afterwards.'),
    fields,
    h('div', { class: 'btn-row' },
      h('button', { class: 'primary', onclick: () => {
        const c = cursorSpot();
        let made: Part[] = [];
        studio.commit(`${kind} frame`, () => {
          const v = studio.v;
          const x = vals;
          if (kind === 'box') made = boxFrame(v, [c[0], c[1] + x.height / 2, c[2]], [x.width, x.height, x.length]);
          if (kind === 'wedge') made = wedgeFrame(v, [c[0], c[1] + x.height / 2, c[2]], [x.width, x.height, x.length]);
          if (kind === 'cylinder') made = cylinderFrame(v, [c[0], c[1] + x.radius, c[2]], x.radius, x.length, Math.max(2, Math.round(x.stations)), Math.max(3, Math.round(x.stringers)));
        });
        studio.select(made.map((p) => p.id));
        dlg.close();
        vp.frame(made.map((p) => p.id));
        status(`${made.length} beams added.`);
      } }, 'Create'),
      h('button', { onclick: () => dlg.close() }, 'Cancel')));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

function placeAssembly(id: string) {
  const a = studio.v.assemblies.find((x) => x.id === id);
  if (!a) return;
  const c = cursorSpot();
  const map = new Map(a.parts.map((p) => [p.id, newId()]));
  const inst = newId('i');
  const parts = a.parts.map((p) => {
    const q = clone(p);
    q.id = map.get(p.id)!;
    q.assembly = inst;
    const f = (x: Vec3): Vec3 => [x[0] + c[0], x[1] + c[1], x[2] + c[2]];
    if (q.path) q.path = { ...q.path, points: q.path.points.map(f), handles: q.path.handles?.map((hh) => (hh ? hh.map(f) : null)) };
    q.position = f(q.position);
    if (q.surface) q.surface.edges = q.surface.edges.map((e) => ({ ...e, part: map.get(e.part) ?? e.part }));
    if (q.derived) q.derived.ribs = q.derived.ribs.map((r) => map.get(r) ?? r);
    return q;
  });
  const made = studio.addParts(parts, `Place ${a.name}`);
  studio.select(made.filter((p) => !p.mirror).map((p) => p.id));
  vp.setTool('select');
  status(`Placed "${a.name}". Move it with the gizmo.`);
}

async function exportGLTF() {
  const ex = new GLTFExporter();
  const res = await ex.parseAsync(vp.view.root, { binary: true, onlyVisible: true });
  download(`${slug(studio.v.name)}.glb`, res as ArrayBuffer, 'model/gltf-binary');
  status('Exported glTF: open it in Blender or a game engine.');
}

/** One screenshot per saved pose, laid out on one sheet. */
async function poseSheet() {
  const v = studio.v;
  if (!v.poses.length) return status('Save some poses first (Controls → Poses).');
  const saved = structuredClone(v.jointValues);
  const shots: { name: string; img: HTMLImageElement }[] = [];
  for (const p of v.poses) {
    Object.assign(v.jointValues, structuredClone(p.values));
    vp.repose();
    const url = vp.screenshot(false, 1);
    const img = new Image();
    img.src = url;
    await img.decode();
    shots.push({ name: p.name, img });
  }
  v.jointValues = saved;
  vp.repose();
  const cols = Math.min(3, shots.length), rows = Math.ceil(shots.length / cols);
  const w = shots[0].img.width, hh = shots[0].img.height;
  const c = document.createElement('canvas');
  c.width = cols * w;
  c.height = rows * (hh + 40);
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1f25';
  g.fillRect(0, 0, c.width, c.height);
  shots.forEach((s, i) => {
    const x = (i % cols) * w, y = Math.floor(i / cols) * (hh + 40);
    g.drawImage(s.img, x, y);
    g.fillStyle = '#e8edf3';
    g.font = '600 26px system-ui, sans-serif';
    g.fillText(s.name, x + 16, y + hh + 30);
  });
  download(`${slug(v.name)}-poses.png`, dataUrlToBlob(c.toDataURL('image/png')), 'image/png');
}

/** Six seconds round the vehicle, recorded from the viewport. */
function turntable() {
  const canvas = vp.renderer.domElement;
  if (!('captureStream' in canvas) || typeof MediaRecorder === 'undefined') return status('This browser cannot record video.');
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => download(`${slug(studio.v.name)}-turntable.webm`, new Blob(chunks, { type: 'video/webm' }), 'video/webm');
  const target = vp.controls.target.clone();
  const off = vp.camera.position.clone().sub(target);
  const r = Math.hypot(off.x, off.z), y = off.y, a0 = Math.atan2(off.x, off.z);
  const t0 = performance.now();
  rec.start();
  status('Recording turntable…');
  const step = () => {
    const k = (performance.now() - t0) / 6000;
    const a = a0 + k * Math.PI * 2;
    vp.camera.position.set(target.x + Math.sin(a) * r, target.y + y, target.z + Math.cos(a) * r);
    vp.camera.lookAt(target);
    vp.invalidate();
    if (k < 1) requestAnimationFrame(step);
    else { rec.stop(); status('Turntable saved.'); }
  };
  step();
}

function startWalk() {
  if (walk.active) { walk.stop(); return; }
  const fig = studio.v.parts.find((p) => getDef(p.def, studio.v).shape === 'figure');
  walk.eye = fig ? (fig.params.h ?? 1.8) * 0.93 : 1.7;
  const at = fig ? new THREE.Vector3(...fig.position) : vp.controls.target.clone().setY(0);
  walk.start(at);
  status('Walk-through: W A S D to move, drag to look, Q / E down and up, Shift to hurry, Esc to leave.');
  renderToolbar();
}
walk.onExit = () => { renderToolbar(); status(''); };

function defaultStatus() {
  const a = studio.analysis();
  const n = studio.v.parts.length;
  return n ? `${n} parts · ${a.rig.joints.size} joints · ${a.warnings.length ? `${a.warnings.length} warning${a.warnings.length > 1 ? 's' : ''}` : 'no warnings'} · grid ${studio.v.grid.major}/${studio.v.grid.minor} m` : 'Empty vehicle. Pick a beam on the left and click grid points, or open a sample from ☰ File.';
}

// ── Files ───────────────────────────────────────────────────────────────────
($('file-input') as HTMLInputElement).addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const v = parseVehicle(await f.text());
  if (v) { stop(); studio.load(v, `Open ${f.name}`); setTimeout(() => vp.frame(), 60); }
  else status('That file is not a Vehicle Studio vehicle.');
  (e.target as HTMLInputElement).value = '';
});

// ── Keyboard ────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (walk.active) return;
  const t = e.target as HTMLElement;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (vp.tool === 'beam' && vp.drawing) vp.cancelBeam();
    else if (vp.tool !== 'select') vp.setTool('select');
    else studio.select([]);
    return;
  }
  if (e.key === 'Enter' && vp.tool === 'beam') { vp.finishBeam(); return; }
  const a = actionFor(e);
  if (!a) {
    const g = studio.v.grid.minor * (e.shiftKey ? 4 : 1);
    const arrows: Record<string, Vec3> = { ArrowLeft: [-g, 0, 0], ArrowRight: [g, 0, 0], ArrowUp: [0, 0, -g], ArrowDown: [0, 0, g] };
    if (arrows[e.key] && studio.selection.length) { e.preventDefault(); vp.nudge(arrows[e.key]); }
    return;
  }
  e.preventDefault();
  const g = studio.v.grid.minor;
  switch (a) {
    case 'select': vp.setTool('select'); break;
    case 'beam': vp.setTool('beam'); break;
    case 'pose': vp.setTool('pose'); break;
    case 'aim': vp.setTool('aim'); break;
    case 'ruler': vp.setTool('ruler'); break;
    case 'move': vp.setGizmoMode('translate'); vp.setTool('select'); break;
    case 'rotateGizmo': vp.setGizmoMode('rotate'); vp.setTool('select'); break;
    case 'turnY': vp.rotate('y'); break;
    case 'turnX': vp.rotate('x'); break;
    case 'turnZ': vp.rotate('z'); break;
    case 'plane': vp.cyclePlane(); break;
    case 'planeUp': if (studio.selection.length) vp.nudge([0, g, 0]); else vp.setPlane(vp.plane.axis, vp.plane.offset + g); break;
    case 'planeDown': if (studio.selection.length) vp.nudge([0, -g, 0]); else vp.setPlane(vp.plane.axis, vp.plane.offset - g); break;
    case 'grid': vp.gridMode = vp.gridMode === 'all' ? 'plane' : vp.gridMode === 'plane' ? 'off' : 'all'; vp.updateGrid(); break;
    case 'mirror': studio.liveMirror = !studio.liveMirror; vp.refresh(); status(`Live mirror ${studio.liveMirror ? 'on' : 'off'}.`); break;
    case 'frame': vp.frame(studio.selection); break;
    case 'front': vp.quickView('front'); break;
    case 'side': vp.quickView('side'); break;
    case 'top': vp.quickView('top'); break;
    case 'three': vp.quickView('three'); break;
    case 'play': if (playing) stop(); else play(motion.activeAnim); break;
    case 'delete': studio.deleteParts(studio.selection); break;
    case 'duplicate': if (studio.selection.length) studio.duplicate(studio.selection, [studio.v.grid.major, 0, 0]); break;
    case 'undo': studio.undo(); break;
    case 'redo': studio.redo(); break;
    case 'connected': { const { graph } = studio.analysis(); const seen = new Set(studio.selection); const st = [...seen]; while (st.length) for (const n of graph.adj.get(st.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); st.push(n); } studio.select([...seen]); break; }
    case 'walk': startWalk(); break;
  }
  renderToolbar();
});

// ── Boot ────────────────────────────────────────────────────────────────────
setTab('props');
renderToolbar();
browser.render();
vp.refresh();
setTimeout(() => vp.frame(), 80);
status(recovered && recovered.parts.length ? 'Recovered your last session from this browser.' : '');
if (!recovered && !storageGet('vehicle-studio:tutorial-seen', false)) {
  storageSet('vehicle-studio:tutorial-seen', true);
  setTimeout(() => tutorial.offer(), 600);
}
void addTwins;

// Handy for scripting and tests from the console.
(window as unknown as Record<string, unknown>).studio = { studio, vp, play, stop, runMotionCheck };

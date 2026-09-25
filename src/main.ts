import './style.css';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { analyze, type Analysis } from './core/analysis';
import { getDef, hasDef } from './core/catalog';
import { wrapHull } from './core/hullwrap';
import { Store } from './core/store';
import { TEMPLATES } from './core/templates';
import { newDesign, type Design, type Vec3 } from './core/types';
import { Viewport, type GizmoMode, type ViewMode } from './render/viewport';
import { Simulation } from './sim/simulation';
import { AnalysisPanel } from './ui/analysisPanel';
import { CatalogPanel } from './ui/catalog';
import { clear, download, h } from './ui/dom';
import { InspectorPanel } from './ui/inspector';
import { SettingsPanel } from './ui/settingsPanel';
import { SimPanel } from './ui/simPanel';

const AUTOSAVE_KEY = 'vessel-forge:autosave';
type Tab = 'inspect' | 'analysis' | 'simulate' | 'settings';

// ── State ────────────────────────────────────────────────────────────────────
const store = new Store(loadAutosave() ?? TEMPLATES[0].make());
let analysis: Analysis | null = null;
let sim: Simulation | null = null;
let simSnapshot: string | null = null;
let paused = false;
let speed = 1;
let tab: Tab = 'analysis';

const $ = (id: string) => document.getElementById(id)!;
const viewport = new Viewport($('viewport'), store);
const catalog = new CatalogPanel($('left'), (def) => {
  if (sim) return status('Stop the simulation to edit.');
  viewport.setTool('place', def.type);
  catalog.setActive(def.type);
  renderToolbar();
});
const tabBody = $('tab-body');
const panes: Record<Tab, HTMLElement> = {
  inspect: h('div', { class: 'pane' }),
  analysis: h('div', { class: 'pane' }),
  simulate: h('div', { class: 'pane' }),
  settings: h('div', { class: 'pane' }),
};
tabBody.append(...Object.values(panes));

const inspector = new InspectorPanel(panes.inspect, store, {
  wrapHull: (ids) => doWrapHull(ids),
  focus: (id) => focusPart(id),
});
const analysisPanel = new AnalysisPanel(panes.analysis, (ids) => {
  store.select(ids);
  setTab('inspect');
});
const simPanel = new SimPanel(panes.simulate, store, {
  start: startSim,
  stop: stopSim,
  togglePause: () => { paused = !paused; renderSim(); },
  setSpeed: (s) => { speed = s; renderSim(); },
  damageTool: () => { viewport.setTool('damage'); renderToolbar(); renderSim(); status('Damage mode: click a part to damage it, Shift-click to repair.'); },
  selectTool: () => { viewport.setTool('select'); renderToolbar(); renderSim(); },
});
const settingsPanel = new SettingsPanel(panes.settings, store, () => {
  const k = store.design.settings.crewHeight / 1.8;
  store.commit(() => {
    for (const p of store.design.parts) {
      const def = getDef(p.type);
      if (!def.scalesWithCrew) continue;
      const oldH = p.size[1];
      p.size = def.defaultSize.map((s) => +(s * k).toFixed(3)) as Vec3;
      p.position[1] += (p.size[1] - oldH) / 2;
    }
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────
viewport.onStatus = (m) => status(m);
viewport.onDamage = (id, repair) => {
  if (!sim) return;
  if (repair) sim.repair(id);
  else sim.damage(id, 0.35);
  viewport.restyle();
};

let analysisTimer = 0;
let saveTimer = 0;
store.on('change', () => {
  viewport.sync();
  clearTimeout(analysisTimer);
  analysisTimer = window.setTimeout(runAnalysis, 120);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(autosave, 800);
  inspector.render();
  renderToolbar();
});
store.on('selection', () => {
  viewport.sync();
  inspector.render();
  if (store.selection.length && tab !== 'simulate') setTab('inspect');
});
store.on('settings', () => {
  viewport.applyEnvironment();
  settingsPanel.render();
});

function runAnalysis() {
  analysis = analyze(store.design);
  viewport.setAnalysis(sim?.state.analysis ? { ...analysis, powered: sim.state.analysis.powered } : analysis);
  inspector.analysis = analysis;
  analysisPanel.render(analysis, store.design);
  inspector.render();
  const v = analysis.verdict;
  $('view-overlay').className = `verdict-chip ${v.level}`;
  $('view-overlay').textContent = analysis.partCount ? v.message : 'Empty design — pick a part on the left, or load a template from the menu.';
  $('view-overlay').hidden = !!sim;
  if (performance.now() - lastStatusAt > 4000) status('');
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setTab(t: Tab) {
  tab = t;
  for (const [k, el] of Object.entries(panes)) el.hidden = k !== t;
  const labels: Record<Tab, string> = { inspect: 'Inspect', analysis: 'Analysis', simulate: 'Simulate', settings: 'Settings' };
  clear($('tabs'), (Object.keys(labels) as Tab[]).map((k) =>
    h('button', { class: k === t ? 'active' : '', onclick: () => setTab(k) }, labels[k], k === 'simulate' && sim ? h('span', { class: 'live-dot' }) : null)));
  if (t === 'simulate') renderSim();
  if (t === 'settings') settingsPanel.render();
  if (t === 'analysis' && analysis) analysisPanel.render(analysis, store.design);
}

// ── Toolbar ──────────────────────────────────────────────────────────────────
function renderToolbar() {
  const tb = $('toolbar');
  const view = viewport.view;
  const btn = (label: string, on: () => void, opts: { active?: boolean; title?: string; disabled?: boolean; cls?: string } = {}) =>
    h('button', { class: `${opts.active ? 'active ' : ''}${opts.cls ?? ''}`, title: opts.title, disabled: opts.disabled, onclick: on }, label);
  const editing = !sim;
  const menu = h('details', { class: 'menu' },
    h('summary', {}, '☰ File'),
    h('div', { class: 'menu-body' },
      h('button', { onclick: () => { closeMenus(); if (confirm('Start a new empty design?')) store.load(newDesign()); } }, 'New empty design'),
      h('div', { class: 'menu-sep' }, 'Templates'),
      TEMPLATES.map((t) => h('button', { title: t.description, onclick: () => { closeMenus(); stopSim(); store.load(t.make()); setTimeout(() => viewport.frameAll(), 200); } }, t.name)),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { closeMenus(); ($('file-input') as HTMLInputElement).click(); } }, 'Open .json…'),
      h('button', { onclick: () => { closeMenus(); download(`${slug(store.design.name)}.vessel.json`, JSON.stringify(store.design, null, 1), 'application/json'); } }, 'Save .json'),
      h('button', { onclick: () => { closeMenus(); exportGLB(); } }, 'Export 3D model (.glb)'),
      h('button', { onclick: () => { closeMenus(); download(`${slug(store.design.name)}.png`, dataUrlToBlob(viewport.screenshot()), 'image/png'); } }, 'Screenshot (.png)'),
    ));
  clear(tb,
    h('div', { class: 'brand' }, '⚓ Vessel Forge', h('span', { class: 'design-name' }, store.design.name)),
    menu,
    h('div', { class: 'group' },
      btn('↶', () => store.undo(), { title: 'Undo (Ctrl+Z)', disabled: !store.canUndo() || !editing }),
      btn('↷', () => store.redo(), { title: 'Redo (Ctrl+Y)', disabled: !store.canRedo() || !editing }),
    ),
    h('div', { class: 'group' },
      btn('➚ Select', () => { viewport.setTool('select'); catalog.setActive(null); renderToolbar(); }, { active: viewport.tool === 'select', title: 'Select tool (Esc)' }),
      (['translate', 'rotate', 'scale'] as GizmoMode[]).map((m, i) =>
        btn(['✥ Move', '⟳ Rotate', '⤢ Size'][i], () => { viewport.setGizmoMode(m); viewport.setTool('select'); catalog.setActive(null); renderToolbar(); },
          { active: viewport.tool === 'select' && viewport.gizmoMode === m, title: `${['W', 'E', 'R'][i]}`, disabled: !editing })),
    ),
    h('div', { class: 'group' },
      btn(`⇋ Mirror ${store.mirror ? 'on' : 'off'}`, () => { store.mirror = !store.mirror; renderToolbar(); }, { active: store.mirror, title: 'Mirror new parts across the centre line (M)' }),
      h('label', { class: 'inline', title: 'Grid snap' }, 'Snap',
        h('select', { onchange: (e) => { viewport.setSnap(parseFloat((e.target as HTMLSelectElement).value)); } },
          [0, 0.05, 0.1, 0.25, 0.5, 1].map((s) => h('option', { value: s, selected: viewport.snap === s }, s ? `${s} m` : 'off')))),
    ),
    h('div', { class: 'group views' },
      ([['structure', '▦ Structural'], ['interior', '≋ Interior & Systems'], ['exterior', '⬢ Exterior']] as [ViewMode, string][]).map(([v, l], i) =>
        btn(l, () => { viewport.setView(v); renderToolbar(); }, { active: view === v, title: `View ${i + 1}` })),
    ),
    h('div', { class: 'group' },
      h('label', { class: 'inline', title: 'Cut the model open to see inside' }, 'Cut',
        h('select', { onchange: (e) => { viewport.section.axis = (e.target as HTMLSelectElement).value as 'x' | 'z' | 'none'; viewport.restyle(); renderToolbar(); } },
          [['none', 'none'], ['x', 'side'], ['z', 'front']].map(([v, l]) => h('option', { value: v, selected: viewport.section.axis === v }, l))),
        viewport.section.axis !== 'none' ? h('input', {
          type: 'range', min: -30, max: 30, step: 0.1, value: viewport.section.value,
          oninput: (e) => { viewport.section.value = parseFloat((e.target as HTMLInputElement).value); viewport.restyle(); },
        }) : null),
    ),
    h('div', { class: 'group' },
      btn('⬢ Wrap hull', () => doWrapHull(store.selection.length ? store.selection : store.design.parts.filter((p) => getDef(p.type).structural).map((p) => p.id)), { title: 'Generate hull plating over the selected framing (or all framing)', disabled: !editing }),
      btn('⌖ Fit', () => viewport.frameAll(), { title: 'Frame the whole vessel (F)' }),
      (['front', 'side', 'top', 'iso'] as const).map((v) => btn(v[0].toUpperCase(), () => viewport.viewFrom(v), { title: `${v} view` })),
      btn(viewport.showMarkers ? '◉ Markers' : '○ Markers', () => { viewport.showMarkers = !viewport.showMarkers; viewport.setAnalysis(analysis); renderToolbar(); }, { active: viewport.showMarkers, title: 'Show CoG / lift markers and dimensions' }),
    ),
    h('div', { class: 'group right' },
      sim ? btn('■ Stop sim', stopSim, { cls: 'danger' }) : btn('▶ Simulate', () => { startSim(); setTab('simulate'); }, { cls: 'primary' }),
    ),
  );
}

function closeMenus() {
  document.querySelectorAll('details.menu').forEach((d) => d.removeAttribute('open'));
}

// ── Actions ──────────────────────────────────────────────────────────────────
function doWrapHull(ids: string[]) {
  if (sim) return;
  const frame = ids.map((id) => store.get(id)).filter((p) => p && getDef(p.type).structural) as NonNullable<ReturnType<typeof store.get>>[];
  if (frame.length < 1) return status('Select some structural framing to wrap.');
  const mat = frame[0].material;
  const shell = wrapHull(frame, { material: mat, thickness: 0.02 });
  if (!shell) return status('Not enough framing to wrap.');
  const mirror = store.mirror;
  store.mirror = false;
  store.addParts([shell]);
  store.mirror = mirror;
  viewport.setView('exterior');
  renderToolbar();
  status(`Hull shell generated: ${(shell.props.area as number).toFixed(1)} m² of ${mat} plating. Change its thickness and material in the inspector.`);
}

function focusPart(id: string) {
  const p = store.get(id);
  if (!p) return;
  const t = viewport.controls.target;
  const off = viewport.camera.position.clone().sub(t).setLength(Math.max(3, Math.max(...p.size) * 2.5));
  t.set(...p.position);
  viewport.camera.position.copy(t).add(off);
}

function startSim() {
  if (sim) return;
  simSnapshot = JSON.stringify(store.design);
  store.select([]);
  sim = new Simulation(store.design);
  paused = false;
  viewport.setSimulation(sim);
  viewport.setTool('select');
  catalog.setActive(null);
  $('view-overlay').hidden = true;
  setTab('simulate');
  renderToolbar();
  status('Simulation running. Use 💥 Damage to hit parts; operate doors and valves from the inspector.');
}

function stopSim() {
  if (!sim) return;
  sim = null;
  viewport.setSimulation(null);
  viewport.setTool('select');
  if (simSnapshot) {
    // Restore valves/doors toggled during the run without adding an undo step.
    store.design = JSON.parse(simSnapshot);
    simSnapshot = null;
    store.emit('change');
  }
  renderToolbar();
  setTab(tab);
  runAnalysis();
}

function renderSim() {
  if (tab === 'simulate') simPanel.render(sim, paused, speed, viewport.tool === 'damage');
}

async function exportGLB() {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(viewport.vehicle, { binary: true, onlyVisible: true });
  download(`${slug(store.design.name)}.glb`, result as ArrayBuffer, 'model/gltf-binary');
}

let lastStatusAt = 0;
function status(msg: string) {
  if (msg) lastStatusAt = performance.now();
  $('status').textContent = msg || defaultStatus();
}

function defaultStatus() {
  const a = analysis;
  if (!a) return '';
  return `${a.partCount} parts · ${(a.totalMass / 1000).toFixed(2)} t · ${a.dims[2].toFixed(1)} × ${a.dims[0].toFixed(1)} × ${a.dims[1].toFixed(1)} m · crew height ${store.design.settings.crewHeight} m`;
}

// ── Persistence ──────────────────────────────────────────────────────────────
function autosave() {
  if (sim) return;
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.design)); } catch { /* storage unavailable */ }
}

function loadAutosave(): Design | null {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    return s ? validate(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

function validate(d: unknown): Design | null {
  const x = d as Design;
  if (!x || !Array.isArray(x.parts) || !x.settings) return null;
  x.parts = x.parts.filter((p) => p && hasDef(p.type) && Array.isArray(p.position) && Array.isArray(p.size));
  x.settings = { ...newDesign().settings, ...x.settings };
  return x;
}

($('file-input') as HTMLInputElement).addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const d = validate(JSON.parse(await f.text()));
  if (d) { stopSim(); store.load(d); setTimeout(() => viewport.frameAll(), 200); }
  else alert('That file is not a vessel design.');
  (e.target as HTMLInputElement).value = '';
});

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vessel';
}

function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.split(':')[1].split(';')[0] });
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'z' && !sim) { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (ctrl && k === 'y' && !sim) { e.preventDefault(); store.redo(); return; }
  if (ctrl && k === 'd' && !sim) { e.preventDefault(); store.duplicate(store.selection); return; }
  if (ctrl) return;
  if ((k === 'delete' || k === 'backspace') && store.selection.length && !sim) { store.removeParts(store.selection); return; }
  if (k === 'escape') { viewport.setTool('select'); catalog.setActive(null); store.select([]); renderToolbar(); return; }
  if (k === 'w') { viewport.setGizmoMode('translate'); renderToolbar(); }
  if (k === 'e') { viewport.setGizmoMode('rotate'); renderToolbar(); }
  if (k === 'r') {
    if (viewport.tool === 'place') viewport.rotateGhost();
    else { viewport.setGizmoMode('scale'); renderToolbar(); }
  }
  if (k === 'm') { store.mirror = !store.mirror; renderToolbar(); }
  if (k === 'f') viewport.frameAll();
  if (k === '1') { viewport.setView('structure'); renderToolbar(); }
  if (k === '2') { viewport.setView('interior'); renderToolbar(); }
  if (k === '3') { viewport.setView('exterior'); renderToolbar(); }
  // Arrow-key nudging by the snap step (PageUp/PageDown for vertical).
  const step = viewport.snap || 0.05;
  const nudge: Record<string, Vec3> = { arrowleft: [-step, 0, 0], arrowright: [step, 0, 0], arrowup: [0, 0, step], arrowdown: [0, 0, -step], pageup: [0, step, 0], pagedown: [0, -step, 0] };
  if (nudge[k] && store.selection.length && !sim) {
    e.preventDefault();
    const d = nudge[k];
    store.commit(() => {
      for (const p of store.selectedParts()) {
        store.updatePart(p.id, { position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]] }, false);
      }
    });
  }
});

// ── Simulation loop ──────────────────────────────────────────────────────────
let last = performance.now();
let uiAcc = 0;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (sim && !paused) {
    let remaining = dt * speed;
    while (remaining > 1e-6) {
      const step = Math.min(0.1, remaining);
      sim.step(step);
      remaining -= step;
    }
    uiAcc += dt;
    if (uiAcc > 0.25) {
      uiAcc = 0;
      renderSim();
      if (analysis && sim.state.analysis) viewport.setAnalysis({ ...analysis, powered: sim.state.analysis.powered, cog: sim.state.analysis.cog, centerOfLift: sim.state.analysis.centerOfLift });
      else viewport.restyle();
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── Boot ─────────────────────────────────────────────────────────────────────
viewport.setSnap(0.25);
viewport.sync();
runAnalysis();
renderToolbar();
setTab('analysis');
settingsPanel.render();
status('');
setTimeout(() => viewport.frameAll(), 50);

// Handy for scripting and debugging from the browser console.
(window as unknown as Record<string, unknown>).vesselForge = { store, viewport, getSim: () => sim, startSim, stopSim };

import { allMaterials, getDef, getMaterial, PART_DEFS } from '../model/catalog';
import type { Warning } from '../model/connections';
import { deleteVersion, listVersions, parseVehicle, saveVersion } from '../model/io';
import { fmtMass, vehicleReport } from '../model/report';
import type { Studio } from '../model/studio';
import { LAYERS, newId, type Finish, type Layer, type Material, type PartDef, type Vec3 } from '../model/types';
import type { Viewport } from '../render/viewport';
import { clear, h, numField, storageGet, storageSet } from './dom';
import { ACTIONS, keyOf, pretty, rebind, resetKeys, type Action } from './keys';

// ── Checks ──────────────────────────────────────────────────────────────────

export class ChecksPanel {
  motion: Warning[] = [];
  motionStale = true;
  constructor(private el: HTMLElement, private studio: Studio, private onPick: (w: Warning) => void, private runMotion: () => void) {}

  render(posing: [string, string][] = []) {
    const { warnings } = this.studio.analysis();
    const all = [...warnings, ...this.motion];
    const name = (id: string) => { const p = this.studio.get(id); return p ? p.name || getDef(p.def, this.studio.v).name : '?'; };
    const icon: Record<Warning['kind'], string> = { floating: '⛓', overlap: '⧉', motion: '↻', locked: '🔒', skin: '▤' };
    clear(this.el,
      h('p', { class: 'hint' }, 'Problems show up here as you build. Click one to select and zoom to the parts.'),
      all.length ? h('ul', { class: 'warnings' }, all.map((w) => h('li', { class: `w-${w.kind}`, onclick: () => this.onPick(w) }, h('span', { class: 'w-icon' }, icon[w.kind]), w.message)))
        : h('p', { class: 'ok-text' }, this.studio.v.parts.length ? '✓ Everything is connected, nothing overlaps.' : 'Nothing built yet.'),
      posing.length ? [h('div', { class: 'section-title' }, 'In the current pose'), h('ul', { class: 'warnings' }, posing.map(([a, b]) => h('li', { class: 'w-motion', onclick: () => this.onPick({ kind: 'motion', message: '', parts: [a, b] }) }, h('span', { class: 'w-icon' }, '↻'), `${name(a)} hits ${name(b)}`)))] : null,
      h('div', { class: 'section-title' }, 'Motion check'),
      h('p', { class: 'hint' }, 'Swing every joint through its range and report anything it would hit.'),
      h('button', { onclick: () => this.runMotion() }, this.motionStale ? '↻ Check joint ranges' : '↻ Check again'),
    );
  }
}

// ── History and versions ────────────────────────────────────────────────────

export class HistoryPanel {
  constructor(private el: HTMLElement, private studio: Studio, private status: (m: string) => void, private thumb: () => string) {}

  render() {
    const s = this.studio;
    const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const versions = listVersions();
    const list = h('ol', { class: 'history' }, s.history.map((e, i) => h('li', { class: `${i === s.index ? 'current' : ''}${i > s.index ? ' future' : ''}`, onclick: () => s.jumpTo(i), title: 'Roll back to this step' },
      h('span', {}, e.label), h('span', { class: 'muted' }, fmt(e.time)))).reverse());
    clear(this.el,
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => s.undo(), disabled: !s.canUndo() }, '↶ Undo'),
        h('button', { onclick: () => s.redo(), disabled: !s.canRedo() }, '↷ Redo')),
      list,
      h('div', { class: 'section-title' }, 'Saved versions'),
      h('div', { class: 'btn-row' }, h('button', { onclick: () => {
        const n = prompt('Name this version', `${s.v.name} — ${new Date().toLocaleString()}`);
        if (n) { saveVersion(s.v, n); this.render(); this.status('Version saved in this browser.'); }
      } }, '+ Save version')),
      versions.length ? h('ul', { class: 'versions' }, versions.map((ver) => h('li', {},
        h('div', {}, h('b', {}, ver.name), h('div', { class: 'muted' }, new Date(ver.time).toLocaleString())),
        h('div', { class: 'btn-row' },
          h('button', { class: 'mini', onclick: () => { const v = parseVehicle(ver.vehicle); if (v) { s.load(v, `Restore "${ver.name}"`); this.status('Version restored. Your previous state is in the history of the version you left… save it first if you need it.'); } } }, 'Restore'),
          h('button', { class: 'mini', onclick: () => this.compare(ver.vehicle, ver.name) }, 'Compare'),
          h('button', { class: 'mini', onclick: () => { deleteVersion(ver.id); this.render(); } }, '✕'))))) : h('p', { class: 'hint' }, 'Versions are kept in this browser. Use File → Save .json to keep a file.'),
    );
  }

  /** Side by side: the saved version against the vehicle as it is now. */
  private compare(saved: string, name: string) {
    const old = parseVehicle(saved);
    if (!old) return;
    const a = vehicleReport(old), b = vehicleReport(this.studio.v);
    const row = (label: string, x: string, y: string) => h('tr', { class: x !== y ? 'diff' : '' }, h('td', {}, label), h('td', {}, x), h('td', {}, y));
    const types = new Set([...a.byType.map((t) => t[0]), ...b.byType.map((t) => t[0])]);
    const n = (r: typeof a, t: string) => String(r.byType.find((x) => x[0] === t)?.[1] ?? 0);
    const dlg = h('dialog', { class: 'modal' },
      h('h3', {}, `Compare: ${name} → now`),
      h('div', { class: 'compare-imgs' }, h('figure', {}, h('div', { class: 'muted' }, 'Thumbnails only show the current vehicle; numbers compare both.')), h('img', { src: this.thumb() })),
      h('table', { class: 'report' }, h('tr', {}, h('th', {}, ''), h('th', {}, name), h('th', {}, 'Now')),
        row('Parts', String(a.parts), String(b.parts)),
        row('Size (L × W × H)', `${a.dims[2].toFixed(2)} × ${a.dims[0].toFixed(2)} × ${a.dims[1].toFixed(2)} m`, `${b.dims[2].toFixed(2)} × ${b.dims[0].toFixed(2)} × ${b.dims[1].toFixed(2)} m`),
        row('Mass', fmtMass(a.mass), fmtMass(b.mass)),
        row('Joints', String(a.joints.length), String(b.joints.length)),
        [...types].map((t) => row(t, n(a, t), n(b, t)))),
      h('div', { class: 'btn-row' }, h('button', { onclick: () => dlg.close() }, 'Close')));
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }
}

// ── Vehicle: report, settings, layers, materials, part editor, keys ─────────

const LAYER_NAMES: Record<Layer, string> = { frame: 'Frame', plating: 'Plating', functional: 'Functional', details: 'Details' };

export class VehiclePanel {
  section: 'report' | 'settings' | 'layers' | 'library' | 'keys' = 'report';
  constructor(private el: HTMLElement, private studio: Studio, private vp: Viewport, private status: (m: string) => void, private hooks: { tutorial: () => void; refreshBrowser: () => void }) {}

  render() {
    const tabs: [typeof this.section, string][] = [['report', 'Report'], ['settings', 'Settings'], ['layers', 'View'], ['library', 'Library'], ['keys', 'Keys']];
    clear(this.el,
      h('div', { class: 'subtabs' }, tabs.map(([k, l]) => h('button', { class: k === this.section ? 'active' : '', onclick: () => { this.section = k; this.render(); } }, l))),
      this.section === 'report' ? this.report() : this.section === 'settings' ? this.settings() : this.section === 'layers' ? this.layers() : this.section === 'library' ? this.library() : this.keys(),
    );
  }

  private report() {
    const r = vehicleReport(this.studio.v);
    const v = this.studio.v;
    return [
      h('table', { class: 'report' },
        h('tr', {}, h('td', {}, 'Length (Z)'), h('td', {}, `${r.dims[2].toFixed(2)} m`)),
        h('tr', {}, h('td', {}, 'Width (X)'), h('td', {}, `${r.dims[0].toFixed(2)} m`)),
        h('tr', {}, h('td', {}, 'Height (Y)'), h('td', {}, `${r.dims[1].toFixed(2)} m`)),
        h('tr', {}, h('td', {}, 'Parts'), h('td', {}, String(r.parts))),
        h('tr', { title: 'Information only: volume × material density' }, h('td', {}, 'Mass'), h('td', {}, fmtMass(r.mass))),
        h('tr', {}, h('td', {}, 'Centre of mass'), h('td', {}, r.cog ? r.cog.map((x) => x.toFixed(2)).join(', ') : '—'))),
      r.stats.length ? [h('div', { class: 'section-title' }, 'Stats'), h('table', { class: 'report' }, r.stats.map((s) => h('tr', {}, h('td', {}, s.label), h('td', {}, `${+s.total.toFixed(2)}${s.unit ? ` ${s.unit}` : ''}`))))] : null,
      h('div', { class: 'section-title' }, 'By type'),
      h('table', { class: 'report' }, r.byType.map(([n, c]) => h('tr', {}, h('td', {}, n), h('td', {}, String(c))))),
      h('div', { class: 'section-title' }, 'By material'),
      h('table', { class: 'report' }, r.byMaterial.map(([n, c, m]) => h('tr', {}, h('td', {}, n), h('td', {}, `${c} · ${fmtMass(m)}`)))),
      r.joints.length ? [h('div', { class: 'section-title' }, 'Joints'), h('table', { class: 'report' }, r.joints.map((j) => h('tr', { onclick: () => this.studio.select([j.id]) }, h('td', {}, j.name), h('td', {}, `${j.type} ${j.min} → ${j.max}${j.type === 'piston' ? ' m' : '°'}`))))] : null,
      h('div', { class: 'section-title' }, 'Notes'),
      h('textarea', { class: 'notes', placeholder: 'What is this vehicle? Who builds it?', onchange: (e) => this.studio.commit('Vehicle notes', () => { v.notes = (e.target as HTMLTextAreaElement).value; }) }, v.notes ?? ''),
    ];
  }

  private settings() {
    const v = this.studio.v;
    const o = v.mirror.origin;
    return [
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: v.name, onchange: (e) => this.studio.commit('Rename vehicle', () => { v.name = (e.target as HTMLInputElement).value || 'Untitled vehicle'; }) })),
      h('div', { class: 'section-title' }, 'Grid'),
      h('p', { class: 'hint' }, 'Set per vehicle: a 3 m buggy and a 270 m battleship need very different steps.'),
      h('div', { class: 'grid2' },
        numField('Major', v.grid.major, (x) => this.studio.commit('Grid', () => { v.grid.major = Math.max(0.01, x); if (v.grid.minor > v.grid.major) v.grid.minor = v.grid.major; }), { unit: 'm', step: 0.25 }),
        numField('Sub-grid', v.grid.minor, (x) => this.studio.commit('Grid', () => { v.grid.minor = Math.max(0.005, Math.min(v.grid.major, x)); }), { unit: 'm', step: 0.05 })),
      h('div', { class: 'btn-row' }, ([['Buggy', 0.5, 0.05], ['Vehicle', 1, 0.25], ['Ship', 5, 1], ['Capital ship', 10, 2.5]] as [string, number, number][]).map(([n, a, b]) =>
        h('button', { class: 'mini', onclick: () => this.studio.commit('Grid', () => { v.grid = { major: a, minor: b }; }) }, `${n} ${a}/${b}`))),
      h('div', { class: 'section-title' }, 'Mirror'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.studio.liveMirror, onchange: (e) => { this.studio.liveMirror = (e.target as HTMLInputElement).checked; this.vp.refresh(); this.render(); } }), 'Live mirror: new parts get twins'),
      h('div', { class: 'btn-row' }, (['x', 'y', 'z'] as const).map((a) => h('label', { class: 'check', title: { x: 'Left / right', y: 'Top / bottom', z: 'Front / back' }[a] },
        h('input', { type: 'checkbox', checked: v.mirror[a], onchange: (e) => this.studio.commit('Mirror axes', () => { v.mirror[a] = (e.target as HTMLInputElement).checked; }) }),
        `${a.toUpperCase()} (${{ x: 'left/right', y: 'top/bottom', z: 'front/back' }[a]})`))),
      h('p', { class: 'hint' }, 'The mirror planes pass through this point. Move it to a grid line for off-centre pairs, such as wing pods.'),
      h('div', { class: 'grid3' }, [0, 1, 2].map((i) => numField('XYZ'[i], o[i], (x) => this.studio.commit('Mirror origin', () => { const n = [...o] as Vec3; n[i] = Math.round(x / v.grid.minor) * v.grid.minor; v.mirror.origin = n; }), { unit: 'm', step: v.grid.minor }))),
      h('div', { class: 'section-title' }, 'Stats'),
      h('p', { class: 'hint' }, 'Your own numbers (crew, cargo, mana capacity…). Parts carry them; the report totals them up.'),
      h('table', { class: 'links' }, v.statDefs.map((s, i) => h('tr', {},
        h('td', {}, h('input', { type: 'text', value: s.label, onchange: (e) => this.studio.commit('Stat', () => { s.label = (e.target as HTMLInputElement).value; }) })),
        h('td', {}, h('input', { type: 'text', class: 'small', value: s.unit ?? '', placeholder: 'unit', onchange: (e) => this.studio.commit('Stat', () => { s.unit = (e.target as HTMLInputElement).value || undefined; }) })),
        h('td', {}, h('button', { class: 'mini', onclick: () => this.studio.commit('Remove stat', () => { v.statDefs.splice(i, 1); }) }, '✕'))))),
      h('button', { class: 'mini', onclick: () => { const l = prompt('Stat name (e.g. "Mana capacity")'); if (l) this.studio.commit('Add stat', () => { v.statDefs.push({ key: l.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: l }); }); } }, '+ Stat'),
      h('div', { class: 'section-title' }, 'Help'),
      h('button', { onclick: () => this.hooks.tutorial() }, '🎓 Guided first build'),
    ];
  }

  private layers() {
    const f = this.vp.flags;
    const marks = storageGet<{ name: string; pos: Vec3; target: Vec3 }[]>(`vehicle-studio:cams:${this.studio.v.id}`, []);
    return [
      h('div', { class: 'section-title' }, 'Layers'),
      h('table', { class: 'layers' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Show'), h('th', {}, 'Lock'), h('th', {}, 'Only')),
        LAYERS.map((l) => h('tr', {},
          h('td', {}, LAYER_NAMES[l]),
          h('td', {}, h('input', { type: 'checkbox', checked: !f.hidden.has(l), onchange: (e) => this.vp.setLayerFlags((x) => { if ((e.target as HTMLInputElement).checked) x.hidden.delete(l); else x.hidden.add(l); }) })),
          h('td', {}, h('input', { type: 'checkbox', checked: f.locked.has(l), onchange: (e) => this.vp.setLayerFlags((x) => { if ((e.target as HTMLInputElement).checked) x.locked.add(l); else x.locked.delete(l); }) })),
          h('td', {}, h('input', { type: 'radio', name: 'iso', checked: f.isolate === l, onclick: () => { this.vp.setLayerFlags((x) => { x.isolate = x.isolate === l ? null : l; }); this.render(); } })),
        ))),
      f.isolate ? h('button', { class: 'mini', onclick: () => { this.vp.setLayerFlags((x) => { x.isolate = null; }); this.render(); } }, 'Show all layers') : null,
      h('div', { class: 'section-title' }, 'Cross-section'),
      h('div', { class: 'btn-row' }, (['none', 'x', 'y', 'z'] as const).map((a) => h('button', { class: this.vp.clip.axis === a ? 'active' : '', onclick: () => { this.vp.clip.axis = a; this.vp.applyClip(); this.render(); } }, a === 'none' ? 'Off' : `Cut ${a.toUpperCase()}`))),
      this.vp.clip.axis !== 'none' ? [
        h('input', { type: 'range', class: 'wide', min: -50, max: 50, step: 0.05, value: this.vp.clip.value, oninput: (e) => { this.vp.clip.value = parseFloat((e.target as HTMLInputElement).value); this.vp.applyClip(); } }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.vp.clip.flip, onchange: (e) => { this.vp.clip.flip = (e.target as HTMLInputElement).checked; this.vp.applyClip(); } }), 'Keep the other side')] : null,
      h('div', { class: 'section-title' }, 'Effects'),
      h('label', { class: 'check', title: 'Thruster exhaust; wheels spin during playback' }, h('input', { type: 'checkbox', checked: f.effects, onchange: (e) => { f.effects = (e.target as HTMLInputElement).checked; this.vp.view.setEffects(f.effects); this.vp.invalidate(); } }), 'Show exhaust and running effects'),
      h('div', { class: 'section-title' }, 'Camera bookmarks'),
      marks.length ? h('ul', { class: 'asm-list' }, marks.map((m, i) => h('li', {},
        h('button', { class: 'link', onclick: () => this.vp.setCam(m) }, `📷 ${m.name}`),
        h('button', { class: 'mini', onclick: () => { marks.splice(i, 1); storageSet(`vehicle-studio:cams:${this.studio.v.id}`, marks); this.render(); } }, '✕')))) : h('p', { class: 'hint' }, 'Save camera angles you come back to.'),
      h('button', { class: 'mini', onclick: () => { const n = prompt('Bookmark name', `View ${marks.length + 1}`); if (n) { marks.push({ name: n, ...this.vp.camState() }); storageSet(`vehicle-studio:cams:${this.studio.v.id}`, marks); this.render(); } } }, '+ Bookmark this view'),
    ];
  }

  private library() {
    const v = this.studio.v;
    const finishes: Finish[] = ['matte', 'metal', 'glass', 'emissive'];
    return [
      h('div', { class: 'section-title' }, 'Materials'),
      h('p', { class: 'hint' }, 'Add your own colours and finishes. They are saved with this vehicle.'),
      h('div', { class: 'mat-grid' }, allMaterials(v).map((m) => h('div', { class: 'mat', title: `${m.name} · ${m.finish} · ${m.density} kg/m³` },
        h('span', { class: 'swatch', style: `background:${m.color}` }), h('span', {}, m.name),
        m.custom ? h('button', { class: 'mini', onclick: () => this.editMaterial(m) }, '✎') : null))),
      h('button', { class: 'mini', onclick: () => this.editMaterial(null) }, '+ Material'),
      h('div', { class: 'section-title' }, 'Custom parts'),
      h('p', { class: 'hint' }, 'Make a catalog part from any shape with your own default sizes, material and stats.'),
      v.partDefs.length ? h('ul', { class: 'asm-list' }, v.partDefs.map((d) => h('li', {}, h('span', {}, d.name), h('span', { class: 'muted' }, d.shape),
        h('button', { class: 'mini', onclick: () => this.editPart(d) }, '✎'),
        h('button', { class: 'mini', onclick: () => this.studio.commit('Delete custom part', () => { v.partDefs = v.partDefs.filter((x) => x.id !== d.id); v.parts = v.parts.filter((p) => p.def !== d.id); }) }, '✕')))) : null,
      h('button', { class: 'mini', onclick: () => this.editPart(null) }, '+ Custom part'),
      void finishes,
    ];
  }

  private editMaterial(m: Material | null) {
    const v = this.studio.v;
    const cur: Material = m ? { ...m } : { id: newId('m'), name: 'New material', color: '#7a8a99', finish: 'matte', density: 2700, custom: true };
    const finishes: Finish[] = ['matte', 'metal', 'glass', 'emissive'];
    const dlg = h('dialog', { class: 'modal' },
      h('h3', {}, m ? 'Edit material' : 'New material'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: cur.name, oninput: (e) => { cur.name = (e.target as HTMLInputElement).value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: cur.color, oninput: (e) => { cur.color = (e.target as HTMLInputElement).value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Finish'), h('select', { onchange: (e) => { cur.finish = (e.target as HTMLSelectElement).value as Finish; } }, finishes.map((f) => h('option', { value: f, selected: f === cur.finish }, f)))),
      numField('Density', cur.density, (x) => { cur.density = Math.max(1, x); }, { unit: 'kg/m³' }),
      h('label', { class: 'field' }, h('span', {}, 'Texture'), h('input', { type: 'file', accept: 'image/*', onchange: (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { cur.texture = String(r.result); };
        r.readAsDataURL(f);
      } })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'primary', onclick: () => { this.studio.commit(m ? 'Edit material' : 'Add material', () => { v.materials = v.materials.filter((x) => x.id !== cur.id); v.materials.push(cur); }); dlg.close(); this.render(); } }, 'Save'),
        m ? h('button', { class: 'danger', onclick: () => { this.studio.commit('Delete material', () => { v.materials = v.materials.filter((x) => x.id !== cur.id); for (const p of v.parts) if (p.material === cur.id) p.material = 'steel'; }); dlg.close(); this.render(); } }, 'Delete') : null,
        h('button', { onclick: () => dlg.close() }, 'Cancel')));
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  private editPart(d: PartDef | null) {
    const v = this.studio.v;
    const bases = PART_DEFS.filter((x) => x.kind !== 'skin');
    let base = d ? bases.find((b) => b.shape === d.shape && (b.kind !== 'beam' || b.section === d.section)) ?? bases[0] : bases.find((b) => b.id === 'greeble')!;
    const cur: PartDef = d ? structuredClone(d) : { ...structuredClone(base), id: newId('def'), name: 'My part', category: 'Custom', custom: true, stats: {} };
    const body = h('div', {});
    const draw = () => clear(body,
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: cur.name, oninput: (e) => { cur.name = (e.target as HTMLInputElement).value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Shape'), h('select', { disabled: !!d, onchange: (e) => {
        base = bases.find((b) => b.id === (e.target as HTMLSelectElement).value)!;
        Object.assign(cur, { ...structuredClone(base), id: cur.id, name: cur.name, category: 'Custom', custom: true, stats: cur.stats });
        draw();
      } }, bases.map((b) => h('option', { value: b.id, selected: b.id === base.id }, b.name)))),
      h('label', { class: 'field' }, h('span', {}, 'Material'), h('select', { onchange: (e) => { cur.material = (e.target as HTMLSelectElement).value; } }, allMaterials(v).map((m) => h('option', { value: m.id, selected: m.id === cur.material }, m.name)))),
      h('label', { class: 'field' }, h('span', {}, 'Description'), h('input', { type: 'text', value: cur.description, oninput: (e) => { cur.description = (e.target as HTMLInputElement).value; } })),
      h('div', { class: 'section-title' }, 'Default size'),
      h('div', { class: 'grid2' }, cur.params.map((p) => numField(p.label, p.default, (x) => { p.default = Math.max(p.min, Math.min(p.max, x)); }, { unit: p.unit === 'deg' ? '°' : p.unit }))),
      v.statDefs.length ? [h('div', { class: 'section-title' }, 'Stats'), h('div', { class: 'grid2' }, v.statDefs.map((s) => numField(s.label, cur.stats?.[s.key] ?? 0, (x) => { cur.stats = { ...(cur.stats ?? {}), [s.key]: x }; })))] : null,
    );
    draw();
    const dlg = h('dialog', { class: 'modal' }, h('h3', {}, d ? 'Edit custom part' : 'New custom part'), body,
      h('div', { class: 'btn-row' },
        h('button', { class: 'primary', onclick: () => { this.studio.commit(d ? 'Edit custom part' : 'Add custom part', () => { v.partDefs = v.partDefs.filter((x) => x.id !== cur.id); v.partDefs.push(cur); }); dlg.close(); this.hooks.refreshBrowser(); this.render(); this.status(`"${cur.name}" is in Parts → Custom.`); } }, 'Save'),
        h('button', { onclick: () => dlg.close() }, 'Cancel')));
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  private keys() {
    return [
      h('p', { class: 'hint' }, 'Click a key, then press the new one. Esc cancels.'),
      h('table', { class: 'keys-table' }, (Object.keys(ACTIONS) as Action[]).map((a) => h('tr', {},
        h('td', {}, ACTIONS[a].label),
        h('td', {}, h('button', { class: 'kbd-btn', onclick: (e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.textContent = 'Press a key…';
          const on = (ev: KeyboardEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;
            window.removeEventListener('keydown', on, true);
            if (ev.key !== 'Escape') {
              const k = [(ev.ctrlKey || ev.metaKey) && 'ctrl', ev.altKey && 'alt', ev.shiftKey && 'shift'].filter(Boolean).concat(ev.key === ' ' ? ' ' : ev.key.toLowerCase()).join('+');
              rebind(a, k);
            }
            this.render();
          };
          window.addEventListener('keydown', on, true);
        } }, pretty(keyOf(a))))))),
      h('button', { class: 'mini', onclick: () => { resetKeys(); this.render(); } }, 'Reset to defaults'),
    ];
  }
}

export { getMaterial };

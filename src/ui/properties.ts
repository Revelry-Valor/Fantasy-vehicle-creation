import { Matrix4 } from 'three';
import { allDefs, allMaterials, defaultParams, getDef } from '../model/catalog';
import { arcSegment, sCurveSegment, segmentCount, straightenSegment } from '../model/curves';
import { partAABB } from '../model/geometry';
import { layStringers, skinBetween, skinHull, stringerSet } from '../model/hull';
import { addTwins, breakSymmetry, family, mirrorCopies } from '../model/mirror';
import { dofCount, jointSpec } from '../model/rig';
import type { Studio } from '../model/studio';
import { LAYERS, clone, newId, type Assembly, type Layer, type Part, type Section, type Vec3 } from '../model/types';
import type { Viewport } from '../render/viewport';
import { clear, h, numField } from './dom';

const SECTIONS: [Section, string][] = [['square', 'Square'], ['round', 'Round'], ['ibeam', 'I-section'], ['channel', 'Channel']];
const LAYER_NAMES: Record<Layer, string> = { frame: 'Frame', plating: 'Plating', functional: 'Functional', details: 'Details' };

/** The properties panel: whatever is selected, and what you can do with it. */
export class PropertiesPanel {
  constructor(private el: HTMLElement, private studio: Studio, private vp: Viewport, private status: (m: string) => void) {}

  render() {
    const sel = this.studio.selected();
    if (!sel.length) return clear(this.el, this.empty());
    if (sel.length === 1) return clear(this.el, this.single(sel[0]));
    clear(this.el, this.multi(sel));
  }

  private empty() {
    return h('div', { class: 'empty' },
      h('p', {}, h('b', {}, 'Nothing selected.')),
      h('p', { class: 'hint' }, 'Pick a beam on the left and click grid points to build a frame, or pick a part to place it. Click parts to select them; drag on empty space to box-select.'),
      h('ul', { class: 'tips' },
        h('li', {}, h('kbd', {}, 'Right-drag'), ' orbit · ', h('kbd', {}, 'Middle-drag'), ' pan · ', h('kbd', {}, 'Wheel'), ' zoom'),
        h('li', {}, h('kbd', {}, 'Q'), ' change the working plane · ', h('kbd', {}, 'PgUp/PgDn'), ' move it'),
        h('li', {}, h('kbd', {}, 'Shift'), ' while drawing beams locks to X, Y or Z (for uprights)'),
        h('li', {}, h('kbd', {}, 'R'), ' / ', h('kbd', {}, 'T'), ' turn 90° · ', h('kbd', {}, 'M'), ' live mirror on/off')));
  }

  private commitPart(p: Part, patch: Partial<Part>, label: string, merge?: string) {
    this.studio.updatePart(p.id, patch, label, merge);
  }

  private single(p: Part) {
    const v = this.studio.v;
    const def = getDef(p.def, v);
    const fam = family(v, p.id);
    const src = p.mirror ? this.studio.get(p.mirror.source) : null;
    const spec = jointSpec(v, p);
    const swaps = allDefs(v).filter((d) => d.kind === def.kind && (def.kind !== 'shape' || d.shape !== 'figure'));
    const { graph } = this.studio.analysis();
    const neighbours = [...(graph.adj.get(p.id) ?? [])].map((id) => this.studio.get(id)).filter((x): x is Part => !!x);
    const nameOf = (x: Part) => x.name || getDef(x.def, v).name;
    const out: (HTMLElement | null)[] = [];
    out.push(h('div', { class: 'prop-head' },
      h('input', { class: 'name', type: 'text', value: p.name ?? '', placeholder: def.name, onchange: (e) => this.commitPart(p, { name: (e.target as HTMLInputElement).value || undefined }, 'Rename') }),
      h('div', { class: 'muted' }, def.description)));
    // Type, material, layer.
    out.push(h('div', { class: 'grid2' },
      h('label', { class: 'field', title: 'Swap part: change its type in place, keeping where it is and what it connects to' }, h('span', {}, 'Type'),
        h('select', { onchange: (e) => this.swap(p, (e.target as HTMLSelectElement).value) }, swaps.map((d) => h('option', { value: d.id, selected: d.id === p.def }, d.name)))),
      h('label', { class: 'field' }, h('span', {}, 'Material'),
        h('select', { onchange: (e) => this.commitPart(p, { material: (e.target as HTMLSelectElement).value }, 'Material') }, allMaterials(v).map((m) => h('option', { value: m.id, selected: m.id === p.material }, m.name)))),
      h('label', { class: 'field' }, h('span', {}, 'Layer'),
        h('select', { onchange: (e) => this.commitPart(p, { layer: (e.target as HTMLSelectElement).value as Layer }, 'Layer') }, LAYERS.map((l) => h('option', { value: l, selected: l === p.layer }, LAYER_NAMES[l])))),
    ));
    // Parameters.
    if (def.params.length) {
      out.push(h('div', { class: 'section-title' }, 'Size'));
      out.push(h('div', { class: 'grid2' }, def.params.map((pd) => numField(pd.label, p.params[pd.key] ?? pd.default, (x) => {
        const step = pd.step ?? (pd.unit === 'm' ? Math.min(v.grid.minor, pd.min > 0 ? pd.min : v.grid.minor) : 1);
        const snapped = pd.unit === 'm' && x >= v.grid.minor ? Math.round(x / Math.min(step, 0.005)) * Math.min(step, 0.005) : x;
        const val = Math.max(pd.min, Math.min(pd.max, +snapped.toFixed(4)));
        this.commitPart(p, { params: { ...p.params, [pd.key]: val } }, `${pd.label}`);
      }, { unit: pd.unit === 'deg' ? '°' : pd.unit, min: pd.min, max: pd.max, step: pd.unit === 'm' ? 0.005 : 1 }))));
    }
    // Placement for shapes.
    if (!p.path && !p.surface) {
      out.push(h('div', { class: 'section-title' }, 'Placement'));
      out.push(h('div', { class: 'grid3' }, (['X', 'Y', 'Z'] as const).map((a, i) => numField(a, p.position[i], (x) => {
        const pos = [...p.position] as Vec3;
        pos[i] = Math.round(x / v.grid.minor) * v.grid.minor;
        this.commitPart(p, { position: pos }, 'Move');
      }, { step: v.grid.minor, unit: 'm' }))));
      out.push(h('div', { class: 'grid3' }, (['Pitch', 'Yaw', 'Roll'] as const).map((a, i) => numField(a, p.rotation[i], (x) => {
        const r = [...p.rotation] as Vec3;
        r[i] = Math.round(x / 15) * 15;
        this.commitPart(p, { rotation: r }, 'Rotate');
      }, { step: 15, unit: '°' }))));
    }
    // Beams.
    if (p.path) {
      const n = segmentCount(p.path);
      out.push(h('div', { class: 'section-title' }, 'Beam'));
      out.push(h('div', { class: 'grid2' },
        h('label', { class: 'field', title: 'Cross-section' }, h('span', {}, 'Section'),
          h('select', { onchange: (e) => this.commitPart(p, { section: (e.target as HTMLSelectElement).value as Section }, 'Section') },
            SECTIONS.map(([s, l]) => h('option', { value: s, selected: (p.section ?? def.section) === s }, l)))),
        h('label', { class: 'check', title: 'Flow smoothly through every point instead of turning sharp corners' },
          h('input', { type: 'checkbox', checked: !!p.path.smooth, disabled: !!p.derived, onchange: (e) => this.commitPart(p, { path: { ...p.path!, smooth: (e.target as HTMLInputElement).checked } }, 'Smooth beam') }), 'Smooth'),
        h('label', { class: 'check', title: 'Join the last point back to the first (a ring rib)' },
          h('input', { type: 'checkbox', checked: !!p.path.closed, disabled: !!p.derived || p.path.points.length < 3, onchange: (e) => this.commitPart(p, { path: { ...p.path!, closed: (e.target as HTMLInputElement).checked } }, 'Close beam') }), 'Closed loop')));
      out.push(h('p', { class: 'hint' }, p.derived ? 'A stringer: it follows its ribs. Reshape a rib to move it.' : `${p.path.points.length} points. Drag the yellow points to move them, the blue diamond on a segment to bend it.`));
      if (!p.derived) {
        out.push(h('div', { class: 'segments' }, Array.from({ length: n }, (_, i) => h('div', { class: 'seg-row' },
          h('span', { class: 'muted' }, n > 1 ? `Segment ${i + 1}` : 'Bend'),
          h('button', { class: 'mini', title: 'Straight between its points', onclick: () => this.commitPart(p, { path: straightenSegment(p.path!, i) }, 'Straighten') }, 'Straight'),
          h('button', { class: 'mini', title: 'A 90° arc, bulging up (or outward)', onclick: () => this.commitPart(p, { path: arcSegment(p.path!, i, 90, this.bulgeDir(p)) }, 'Arc 90°') }, 'Arc 90°'),
          h('button', { class: 'mini', title: 'A gentle 45° arc', onclick: () => this.commitPart(p, { path: arcSegment(p.path!, i, 45, this.bulgeDir(p)) }, 'Arc 45°') }, '45°'),
          h('button', { class: 'mini', title: 'Leave and arrive parallel: a jog', onclick: () => this.commitPart(p, { path: sCurveSegment(p.path!, i) }, 'S-curve') }, 'S-curve'),
          h('button', { class: 'mini', title: 'Flip the bulge to the other side', onclick: () => this.flipBend(p, i) }, '⇅')))));
      }
    }
    // Skins.
    if (p.surface) {
      out.push(h('div', { class: 'section-title' }, 'Plate'));
      out.push(h('div', { class: 'grid2' },
        numField('Thickness', p.surface.thickness, (x) => this.commitPart(p, { surface: { ...p.surface!, thickness: Math.max(0.002, x) } }, 'Plate thickness'), { unit: 'm', step: 0.005 }),
        h('button', { onclick: () => this.commitPart(p, { surface: { ...p.surface!, side: p.surface!.side === 1 ? -1 : 1 } }, 'Flip plate side'), title: 'Put the plate on the other side of its beams' }, '⇅ Other side')));
      out.push(h('p', { class: 'hint' }, `Follows ${p.surface.edges.length} beams. Bend or move them and the plate reshapes.`));
    }
    // Joints.
    if (spec) {
      const unit = spec.type === 'piston' ? 'm' : '°';
      out.push(h('div', { class: 'section-title' }, 'Joint'));
      out.push(h('p', { class: 'hint' }, ({ hinge: 'Turns about its X axis (the barrel).', turret: 'Rotates about its vertical axis.', ball: 'Turns on every axis within its limits.', piston: 'Slides its top end out.', wheel: 'Spins on X; steers about Y within its limits.' } as const)[spec.type],
        ' Parts touching its top half move with it.'));
      out.push(h('div', { class: 'grid3' },
        numField('Min', spec.min, (x) => this.commitPart(p, { joint: { ...spec, min: Math.min(x, spec.max) } }, 'Joint limits'), { unit }),
        numField('Max', spec.max, (x) => this.commitPart(p, { joint: { ...spec, max: Math.max(x, spec.min) } }, 'Joint limits'), { unit }),
        numField('Rest', spec.rest, (x) => this.commitPart(p, { joint: { ...spec, rest: Math.max(spec.min, Math.min(spec.max, x)) } }, 'Joint rest'), { unit })));
      if (spec.type === 'turret') out.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!spec.continuous, onchange: (e) => this.commitPart(p, { joint: { ...spec, continuous: (e.target as HTMLInputElement).checked } }, 'Joint') }), 'Turns all the way round'));
      const { rig } = this.studio.analysis();
      const rj = rig.joints.get(p.id);
      if (rj?.locked) out.push(h('p', { class: 'warn-text' }, 'Locked: both halves connect to the same structure. Break one of the connections below.'));
      out.push(h('div', { class: 'btn-row' },
        h('button', { onclick: () => { const g = rj ? rig.groups[rj.child] : null; if (g) this.studio.select(g.parts.length ? g.parts : [p.id]); }, title: 'Select everything this joint moves' }, 'Select moving side'),
        h('button', { onclick: () => this.studio.pose('Reset joint', () => { this.studio.v.jointValues[p.id] = Array.from({ length: dofCount(spec) }, (_, i) => (spec.type === 'wheel' && i === 0 ? 0 : spec.rest)); }) }, 'Reset to rest')));
    }
    // Mirror.
    out.push(h('div', { class: 'section-title' }, 'Mirror'));
    if (src) out.push(h('p', { class: 'hint' }, `Mirror of ${nameOf(src)} across ${p.mirror!.axes.toUpperCase().split('').join(' + ')}. Edits on either side carry over.`));
    else if (fam.length > 1) out.push(h('p', { class: 'hint' }, `Has ${fam.length - 1} mirrored twin${fam.length > 2 ? 's' : ''}.`));
    else out.push(h('p', { class: 'hint' }, 'No twins.'));
    out.push(h('div', { class: 'btn-row' },
      fam.length > 1 ? h('button', { title: 'This part stops following (or leading) its twins', onclick: () => this.studio.commit('Break symmetry', () => { breakSymmetry(this.studio.v, p.id); }) }, 'Break symmetry') : null,
      fam.length === 1 ? h('button', { title: 'Add live twins on the mirror axes that are on', onclick: () => this.studio.commit('Mirror part', () => { addTwins(this.studio.v, p); }) }, 'Mirror it') : null));
    // Connections.
    out.push(h('div', { class: 'section-title' }, `Connected to (${neighbours.length})`));
    out.push(neighbours.length ? h('ul', { class: 'conn-list' }, neighbours.slice(0, 40).map((n) => h('li', {},
      h('button', { class: 'link', onclick: () => this.studio.select([n.id]) }, nameOf(n)),
      v.connections.some((c) => c.mode === 'forced' && ((c.a === p.id && c.b === n.id) || (c.b === p.id && c.a === n.id))) ? h('span', { class: 'muted' }, 'forced') : null,
      h('button', { class: 'mini', title: 'Break this connection', onclick: () => this.setConnection(p.id, n.id, 'broken') }, 'Break')))) : h('p', { class: 'hint' }, 'Not touching anything.'));
    const brokenHere = v.connections.filter((c) => c.mode === 'broken' && (c.a === p.id || c.b === p.id));
    if (brokenHere.length) out.push(h('p', { class: 'hint' }, `${brokenHere.length} broken by hand. `, h('button', { class: 'link', onclick: () => this.studio.commit('Restore connections', () => { this.studio.v.connections = this.studio.v.connections.filter((c) => !brokenHere.includes(c)); }) }, 'Restore')));
    // Stats and notes.
    if (v.statDefs.length) {
      out.push(h('div', { class: 'section-title' }, 'Stats'));
      out.push(h('div', { class: 'grid2' }, v.statDefs.map((sd) => numField(sd.label, p.stats?.[sd.key] ?? def.stats?.[sd.key] ?? 0, (x) => this.commitPart(p, { stats: { ...(p.stats ?? {}), [sd.key]: x } }, 'Stats'), { unit: sd.unit }))));
    }
    out.push(h('div', { class: 'section-title' }, 'Notes'));
    out.push(h('textarea', { class: 'notes', placeholder: 'Lore, purpose, maker…', onchange: (e) => this.commitPart(p, { notes: (e.target as HTMLTextAreaElement).value || undefined }, 'Notes') }, p.notes ?? ''));
    out.push(this.actions([p]));
    return out;
  }

  private bulgeDir(p: Part): Vec3 {
    const pts = p.path!.points;
    const a = pts[0], b = pts[pts.length - 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    // Horizontal beams bulge up; upright ones bulge away from the centre line.
    if (Math.abs(d[1]) < 0.5 * Math.hypot(d[0], d[2])) return [0, 1, 0];
    const mx = (a[0] + b[0]) / 2;
    return [mx >= this.studio.v.mirror.origin[0] ? 1 : -1, 0, 0];
  }

  private flipBend(p: Part, i: number) {
    const h0 = p.path!.handles?.[i];
    if (!h0) return;
    const a = p.path!.points[i], b = p.path!.points[(i + 1) % p.path!.points.length];
    // Reflect handles through the chord line.
    const refl = (q: Vec3): Vec3 => {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
      const t = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / L2;
      const f: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
      return [2 * f[0] - q[0], 2 * f[1] - q[1], 2 * f[2] - q[2]];
    };
    const handles = p.path!.handles!.slice();
    handles[i] = h0.map(refl);
    this.commitPart(p, { path: { ...p.path!, handles } }, 'Flip bend');
  }

  private swap(p: Part, defId: string) {
    const def = getDef(defId, this.studio.v);
    const params = { ...defaultParams(def) };
    for (const k of Object.keys(params)) if (p.params[k] !== undefined) params[k] = p.params[k];
    const patch: Partial<Part> = { def: defId, params, section: def.kind === 'beam' ? def.section : undefined };
    if (def.joint) patch.joint = { ...def.joint };
    this.commitPart(p, patch, `Swap to ${def.name}`);
  }

  private setConnection(a: string, b: string, mode: 'forced' | 'broken') {
    this.studio.commit(mode === 'broken' ? 'Break connection' : 'Force connection', () => {
      const v = this.studio.v;
      v.connections = v.connections.filter((c) => !((c.a === a && c.b === b) || (c.a === b && c.b === a)));
      v.connections.push({ a, b, mode });
    });
  }

  private multi(sel: Part[]) {
    const v = this.studio.v;
    const beams = sel.filter((p) => p.path);
    const counts = new Map<string, number>();
    for (const p of sel) { const n = getDef(p.def, v).name; counts.set(n, (counts.get(n) ?? 0) + 1); }
    return [
      h('div', { class: 'prop-head' }, h('b', {}, `${sel.length} parts selected`), h('div', { class: 'muted' }, [...counts].map(([n, c]) => `${c}× ${n}`).join(', '))),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Material'),
          h('select', { onchange: (e) => this.studio.commit('Material', () => { const m = (e.target as HTMLSelectElement).value; for (const p of sel) this.studio.get(p.id)!.material = m; return sel.map((p) => p.id); }) },
            h('option', { value: '' }, '—'), allMaterials(v).map((m) => h('option', { value: m.id }, m.name)))),
        h('label', { class: 'field' }, h('span', {}, 'Layer'),
          h('select', { onchange: (e) => this.studio.commit('Layer', () => { const l = (e.target as HTMLSelectElement).value as Layer; for (const p of sel) this.studio.get(p.id)!.layer = l; return sel.map((p) => p.id); }) },
            h('option', { value: '' }, '—'), LAYERS.map((l) => h('option', { value: l }, LAYER_NAMES[l]))))),
      sel.length === 2 ? h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.setConnection(sel[0].id, sel[1].id, 'forced'), title: 'Treat these two as attached even if they don\'t touch' }, 'Force connection'),
        h('button', { onclick: () => this.setConnection(sel[0].id, sel[1].id, 'broken'), title: 'Treat these two as separate even though they touch' }, 'Break connection')) : null,
      beams.length >= 2 ? h('div', { class: 'section-title' }, 'Hull') : null,
      beams.length >= 3 && beams.length <= 4 && beams.length === sel.length ? h('button', { class: 'wide-btn', onclick: () => this.skin(beams.map((b) => b.id)), title: 'A plate whose edges follow these beams' }, '▤ Skin between these beams') : null,
      beams.length >= 2 && beams.every((b) => !b.derived) ? h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.stringers(beams.map((b) => b.id)), title: 'Treat the selected beams as ribs and lay stringers through them' }, '≋ Lay stringers'),
        h('input', { type: 'number', class: 'small', id: 'stringer-count', value: 6, min: 1, max: 64, title: 'How many stringers' })) : null,
      this.actions(sel),
    ];
  }

  private skin(ids: string[]) {
    let ok = false;
    const made: Part[] = [];
    this.studio.commit('Skin between beams', () => {
      const s = skinBetween(this.studio.v, ids);
      if (s) { made.push(s); if (this.studio.liveMirror) addTwins(this.studio.v, s); ok = true; }
    });
    const bad = made.filter((m) => !this.studio.analysis().warnings.every((w) => !w.parts.includes(m.id)));
    this.status(ok && !bad.length ? 'Plate added. It follows its beams if you bend them.' : 'Those beams don\'t form a closed loop end to end; the plate is flagged in Checks.');
    if (made[0]) this.studio.select([made[0].id]);
  }

  private stringers(ids: string[]) {
    const n = parseInt((this.el.querySelector('#stringer-count') as HTMLInputElement | null)?.value ?? '6', 10) || 6;
    let made: Part[] = [];
    this.studio.commit('Lay stringers', () => {
      made = layStringers(this.studio.v, ids, n);
      if (this.studio.liveMirror) for (const m of [...made]) addTwins(this.studio.v, m);
    });
    this.status(made.length ? `${made.length} stringers laid through ${ids.length} ribs. Select one and use Skin hull to plate every cell.` : 'Select at least two ribs.');
    if (made[0]) this.studio.select([made[0].id]);
  }

  /** Actions shared by one or many selected parts. */
  private actions(sel: Part[]) {
    const v = this.studio.v;
    const ids = sel.map((p) => p.id);
    const stringer = sel.find((p) => p.derived) ?? sel.find((p) => stringerSet(v, p.id).length > 1);
    return h('div', { class: 'actions' },
      h('div', { class: 'section-title' }, 'Actions'),
      stringer ? h('button', { class: 'wide-btn', onclick: () => {
        let made: Part[] = [];
        this.studio.commit('Skin hull', () => {
          made = skinHull(this.studio.v, stringer.id);
          if (this.studio.liveMirror) for (const m of [...made]) addTwins(this.studio.v, m);
        });
        this.status(made.length ? `Plated ${made.length} cells.` : 'Every cell already has a plate.');
      }, title: 'A plate in every cell between neighbouring ribs and stringers' }, '▤ Skin hull') : null,
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.studio.select(this.connected(ids)), title: 'Everything attached, directly or through other parts' }, 'Select connected'),
        h('button', { onclick: () => this.selectPastJoint(ids), title: 'Everything that moves with the nearest joint' }, 'Select past joint')),
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.studio.duplicate(ids, [v.grid.major, 0, 0]) }, 'Duplicate'),
        h('button', { onclick: () => this.saveAssembly(ids) }, 'Save as assembly'),
        h('button', { class: 'danger', onclick: () => this.studio.deleteParts(ids) }, 'Delete')),
      h('div', { class: 'section-title' }, 'Mirror copy'),
      h('div', { class: 'btn-row' }, (['x', 'y', 'z'] as const).map((a) => h('button', { title: `A one-off copy across the ${a.toUpperCase()} mirror plane`, onclick: () => {
        let made: Part[] = [];
        this.studio.commit(`Mirror copy ${a.toUpperCase()}`, () => { made = mirrorCopies(this.studio.v, this.studio.withFamilies(ids), a); });
        this.studio.select(made.map((m) => m.id));
      } }, `Across ${a.toUpperCase()}`))),
      h('div', { class: 'section-title' }, 'Pattern'),
      h('div', { class: 'btn-row pattern' },
        h('input', { type: 'number', class: 'small', id: 'arr-n', value: 4, min: 1, max: 200, title: 'Copies' }), h('span', { class: 'muted' }, 'copies every'),
        h('input', { type: 'number', class: 'small', id: 'arr-k', value: 1, step: 0.25, title: 'Grid cells (major)' }), h('span', { class: 'muted' }, 'cells along'),
        h('select', { id: 'arr-ax' }, ['x', 'y', 'z'].map((a) => h('option', { value: a, selected: a === 'z' }, a.toUpperCase()))),
        h('button', { onclick: () => this.pattern(ids) }, 'Repeat')),
      sel.length > 1 ? h('div', { class: 'section-title' }, 'Align & distribute') : null,
      sel.length > 1 ? h('div', { class: 'align-grid' }, (['x', 'y', 'z'] as const).map((a, i) => [
        h('span', { class: 'muted' }, a.toUpperCase()),
        h('button', { class: 'mini', onclick: () => this.align(ids, i, 'min') }, 'Min'),
        h('button', { class: 'mini', onclick: () => this.align(ids, i, 'mid') }, 'Centre'),
        h('button', { class: 'mini', onclick: () => this.align(ids, i, 'max') }, 'Max'),
        h('button', { class: 'mini', onclick: () => this.distribute(ids, i), disabled: sel.length < 3 }, 'Spread'),
      ])) : null,
    );
  }

  private connected(ids: string[]): string[] {
    const { graph } = this.studio.analysis();
    const seen = new Set(ids);
    const stack = [...ids];
    while (stack.length) for (const n of graph.adj.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return [...seen];
  }

  private selectPastJoint(ids: string[]) {
    const { rig } = this.studio.analysis();
    const out = new Set<string>();
    for (const id of ids) {
      const jid = this.vp.jointFor(id);
      const j = jid ? rig.joints.get(jid) : null;
      if (!j) continue;
      const kids = new Set([j.child]);
      let grew = true;
      while (grew) { grew = false; for (const g of rig.groups) if (g.parent !== undefined && kids.has(g.parent) && !kids.has(g.id)) { kids.add(g.id); grew = true; } }
      for (const g of rig.groups) if (kids.has(g.id)) { for (const p of g.parts) out.add(p); for (const [jj] of g.halves) out.add(jj); }
    }
    if (!out.size) this.status('Nothing here moves on a joint.');
    else this.studio.select([...out]);
  }

  private saveAssembly(ids: string[]) {
    const name = prompt('Name this assembly (e.g. "Walker leg")', 'Assembly');
    if (!name) return;
    const all = this.studio.withoutTwinsOf(ids).map((id) => this.studio.get(id)!).filter(Boolean);
    const box = all.map((p) => partAABB(p, this.studio.v)).filter(Boolean);
    const min = [0, 1, 2].map((i) => Math.min(...box.map((b) => b!.min[i])));
    const g = this.studio.v.grid.minor;
    const origin: Vec3 = [Math.round(((min[0] + Math.max(...box.map((b) => b!.max[0]))) / 2) / g) * g, Math.round(min[1] / g) * g, Math.round(((min[2] + Math.max(...box.map((b) => b!.max[2]))) / 2) / g) * g];
    const parts = all.map((p) => { const q = clone(p); delete q.mirror; return q; });
    const a: Assembly = { id: newId('a'), name, parts: parts.map((p) => p), notes: undefined };
    // Store relative to its own origin.
    const m = new Matrix4().makeTranslation(-origin[0], -origin[1], -origin[2]);
    for (const p of a.parts) {
      if (p.path) p.path = { ...p.path, points: p.path.points.map((q) => [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]] as Vec3), handles: p.path.handles?.map((hh) => (hh ? hh.map((q) => [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]] as Vec3) : null)) };
      p.position = [p.position[0] - origin[0], p.position[1] - origin[1], p.position[2] - origin[2]];
    }
    void m;
    this.studio.commit('Save assembly', () => { this.studio.v.assemblies.push(a); });
    this.status(`Saved "${name}" (${parts.length} parts). Place copies from the Parts panel.`);
  }

  private pattern(ids: string[]) {
    const n = parseInt((this.el.querySelector('#arr-n') as HTMLInputElement).value, 10) || 1;
    const k = parseFloat((this.el.querySelector('#arr-k') as HTMLInputElement).value) || 1;
    const ax = (this.el.querySelector('#arr-ax') as HTMLSelectElement).value;
    const step = k * this.studio.v.grid.major;
    const i = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
    const src = this.studio.withoutTwinsOf(ids).map((id) => this.studio.get(id)!).filter((p) => p && !p.derived);
    const copies: Part[] = [];
    for (let c = 1; c <= n; c++) {
      const map = new Map(src.map((p) => [p.id, newId()]));
      for (const p of src) {
        const q = clone(p);
        q.id = map.get(p.id)!;
        delete q.mirror;
        const off: Vec3 = [0, 0, 0];
        off[i] = step * c;
        if (q.path) q.path = { ...q.path, points: q.path.points.map((x) => [x[0] + off[0], x[1] + off[1], x[2] + off[2]] as Vec3), handles: q.path.handles?.map((hh) => (hh ? hh.map((x) => [x[0] + off[0], x[1] + off[1], x[2] + off[2]] as Vec3) : null)) };
        q.position = [q.position[0] + off[0], q.position[1] + off[1], q.position[2] + off[2]];
        if (q.surface) q.surface.edges = q.surface.edges.map((e) => ({ ...e, part: map.get(e.part) ?? e.part }));
        copies.push(q);
      }
    }
    this.studio.addParts(copies, `Pattern ×${n}`);
    this.status(`${n} copies made every ${step} m along ${ax.toUpperCase()}.`);
  }

  private boxOf(id: string) {
    return partAABB(this.studio.get(id)!, this.studio.v);
  }

  private align(ids: string[], axis: number, mode: 'min' | 'mid' | 'max') {
    const ref = this.boxOf(ids[0]);
    if (!ref) return;
    const target = mode === 'min' ? ref.min[axis] : mode === 'max' ? ref.max[axis] : (ref.min[axis] + ref.max[axis]) / 2;
    this.studio.commit('Align', () => {
      const touched: string[] = [];
      for (const id of this.studio.withoutTwinsOf(ids.slice(1))) {
        const b = this.boxOf(id);
        if (!b) continue;
        const cur = mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2;
        const d: Vec3 = [0, 0, 0];
        d[axis] = Math.round((target - cur) / this.studio.v.grid.minor) * this.studio.v.grid.minor;
        moveBy(this.studio.get(id)!, d);
        touched.push(id);
      }
      return touched;
    });
  }

  private distribute(ids: string[], axis: number) {
    const items = this.studio.withoutTwinsOf(ids).map((id) => ({ id, b: this.boxOf(id)! })).filter((x) => x.b).map((x) => ({ ...x, c: (x.b.min[axis] + x.b.max[axis]) / 2 })).sort((a, b) => a.c - b.c);
    if (items.length < 3) return;
    const a = items[0].c, z = items[items.length - 1].c;
    this.studio.commit('Distribute', () => {
      items.forEach((it, i) => {
        const want = a + ((z - a) * i) / (items.length - 1);
        const d: Vec3 = [0, 0, 0];
        d[axis] = Math.round((want - it.c) / this.studio.v.grid.minor) * this.studio.v.grid.minor;
        moveBy(this.studio.get(it.id)!, d);
      });
      return items.map((x) => x.id);
    });
  }
}

function moveBy(p: Part, d: Vec3) {
  if (p.surface || p.derived) return;
  if (p.path) {
    const f = (x: Vec3): Vec3 => [x[0] + d[0], x[1] + d[1], x[2] + d[2]];
    p.path = { ...p.path, points: p.path.points.map(f), handles: p.path.handles?.map((hh) => (hh ? hh.map(f) : null)) };
  }
  p.position = [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]];
}

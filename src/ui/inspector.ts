import { dryMass, contentsMass, memberCapacity, type Analysis } from '../core/analysis';
import { getDef } from '../core/catalog';
import { FLUIDS, getFluid } from '../core/fluids';
import { partVolume } from '../core/geometry';
import { MATERIALS } from '../core/materials';
import { deckOutline } from '../core/pens';
import type { Store } from '../core/store';
import type { PartInstance, Vec3 } from '../core/types';
import { h, clear, fmt, num } from './dom';

const DEG = 180 / Math.PI;

export interface InspectorActions {
  wrapHull: (ids: string[]) => void;
  focus: (id: string) => void;
  makeLayer: (id: string) => void;
}

export class InspectorPanel {
  analysis: Analysis | null = null;

  constructor(private el: HTMLElement, private store: Store, private actions: InspectorActions) {}

  render() {
    // Don't yank a field out from under the user while they're typing.
    if (this.el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const sel = this.store.selectedParts();
    if (!sel.length) {
      clear(this.el,
        h('div', { class: 'empty' },
          h('p', {}, 'Nothing selected.'),
          h('p', { class: 'hint' }, 'Click a part to inspect it. Shift-click adds to the selection.'),
          h('p', { class: 'hint' }, 'Keys: W move · E rotate · R scale · Del delete · Ctrl+D duplicate · M mirror · 1/2/3 views · F frame'),
        ));
      return;
    }
    if (sel.length > 1) {
      const mass = sel.reduce((s, p) => s + (this.analysis?.partMass[p.id] ?? dryMass(p)), 0);
      const anyStructural = sel.some((p) => getDef(p.type).structural);
      clear(this.el,
        h('div', { class: 'insp-head' }, h('b', {}, `${sel.length} parts`), h('span', { class: 'muted' }, fmt.kg(mass))),
        h('div', { class: 'btn-row' },
          h('button', { onclick: () => this.store.duplicate(this.store.selection) }, 'Duplicate'),
          h('button', { class: 'danger', onclick: () => this.store.removeParts(this.store.selection) }, 'Delete'),
        ),
        anyStructural ? h('button', { class: 'wide', onclick: () => this.actions.wrapHull(this.store.selection) }, '⬢ Wrap hull around selection') : null,
        h('p', { class: 'hint' }, 'Drag the gizmo to move or rotate the whole group.'),
      );
      return;
    }
    this.renderPart(sel[0]);
  }

  private renderPart(p: PartInstance) {
    const def = getDef(p.type);
    const up = (patch: Parameters<Store['updatePart']>[1]) => this.store.updatePart(p.id, patch);
    const setProp = (k: string, v: string | number | boolean) => up({ props: { [k]: v } });
    const vec = (label: string, v: Vec3, set: (v: Vec3) => void, scale = 1, step = 0.05) =>
      h('div', { class: 'vec' }, h('span', { class: 'vec-label' }, label),
        ...(['x', 'y', 'z'] as const).map((axis, i) => h('input', {
          type: 'number', step, value: +(v[i] * scale).toFixed(3), title: axis,
          onchange: (e) => {
            const n = parseFloat((e.target as HTMLInputElement).value);
            if (!Number.isFinite(n)) return;
            const next = [...v] as Vec3;
            next[i] = n / scale;
            set(next);
          },
        })));

    const twin = this.store.twin(p);
    const util = this.analysis?.utilization[p.id];
    const mass = this.analysis?.partMass[p.id] ?? dryMass(p) + contentsMass(p, Number(p.props.fill ?? 1));
    const fluid = getFluid(String(p.props.fluid ?? ''));

    const rows: (HTMLElement | null)[] = [];
    if (typeof p.props.thickness === 'number') rows.push(num('Thickness', p.props.thickness * 1000, (v) => setProp('thickness', v / 1000), { step: 1, min: 0.1, unit: 'mm' }));
    if (def.container) {
      rows.push(h('label', { class: 'field' }, h('span', {}, 'Contents'),
        h('select', { onchange: (e) => setProp('fluid', (e.target as HTMLSelectElement).value) },
          FLUIDS.filter((f) => (def.envelope ? f.state === 'gas' : true)).map((f) => h('option', { value: f.id, selected: f.id === p.props.fluid }, `${f.name}${f.fantasy ? ' ✦' : ''}`)))));
      rows.push(h('label', { class: 'field' }, h('span', {}, 'Fill'),
        h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: Number(p.props.fill ?? 1), onchange: (e) => setProp('fill', parseFloat((e.target as HTMLInputElement).value)) }),
        h('em', {}, fmt.pct(Number(p.props.fill ?? 1)))));
      if (typeof p.props.pressure === 'number') rows.push(num('Pressure', p.props.pressure, (v) => setProp('pressure', Math.max(1, v)), { step: 5, min: 1, unit: 'bar' }));
    }
    if (typeof p.props.cargo === 'number') rows.push(num('Cargo', p.props.cargo, (v) => setProp('cargo', Math.max(0, v)), { step: 50, min: 0, unit: 'kg' }));
    if (typeof p.props.chainLength === 'number') rows.push(num('Chain length', p.props.chainLength, (v) => setProp('chainLength', Math.max(0.5, v)), { step: 1, min: 0.5, unit: 'm' }));
    if (typeof p.props.liftCoefficient === 'number') rows.push(num('Lift coeff. CL', p.props.liftCoefficient, (v) => setProp('liftCoefficient', v), { step: 0.05 }));
    if (def.compartment) {
      rows.push(h('label', { class: 'field' }, h('span', {}, 'Label'), h('input', { type: 'text', value: String(p.props.label ?? ''), onchange: (e) => setProp('label', (e.target as HTMLInputElement).value) })));
      rows.push(h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: p.props.sealed === true, onchange: (e) => setProp('sealed', (e.target as HTMLInputElement).checked) }), h('span', {}, 'Sealed / pressurised')));
    }
    if (p.type === 'frame') {
      const skinOpts = (cur: string) => [h('option', { value: 'none', selected: cur === 'none' }, 'None'),
        ...MATERIALS.map((m) => h('option', { value: m.id, selected: m.id === cur }, `${m.name}${m.fantasy ? ' ✦' : ''}`))];
      rows.push(h('div', { class: 'section-title' }, 'Sheet & armor'));
      rows.push(num('Sheet', p.size[1] * 1000, (v) => up({ size: [p.size[0], Math.max(0.5, v) / 1000, p.size[2]] }), { step: 1, min: 0.5, unit: 'mm' }));
      rows.push(h('label', { class: 'field' }, h('span', {}, 'Outside face'),
        h('select', { onchange: (e) => setProp('skinOuter', (e.target as HTMLSelectElement).value) }, skinOpts(String(p.props.skinOuter ?? 'none')))));
      rows.push(h('label', { class: 'field' }, h('span', {}, 'Inside face'),
        h('select', { onchange: (e) => setProp('skinInner', (e.target as HTMLSelectElement).value) }, skinOpts(String(p.props.skinInner ?? 'none')))));
      rows.push(num('Armor', Number(p.props.skinThickness ?? 0.03) * 1000, (v) => setProp('skinThickness', Math.max(0.5, v) / 1000), { step: 1, min: 0.5, unit: 'mm' }));
      rows.push(h('button', { class: 'wide', onclick: () => setProp('outSign', Number(p.props.outSign ?? 1) >= 0 ? -1 : 1) }, '⇅ Swap outside and inside'));
    }
    if (p.type === 'deck') {
      rows.push(h('p', { class: 'hint' }, p.points
        ? `Shaped floor, ${deckOutline(p).length} corners. In the top plan: drag corners, drag a + to add one, double-click a corner to remove it.`
        : 'To reshape: select it in the top plan, drag its corners or pull a + on an edge to add a corner.'));
      if (p.points) rows.push(h('button', { class: 'wide', onclick: () => up({ points: undefined, size: p.size }) }, '▭ Reset to a rectangle'));
      const isLayer = (this.store.design.layers ?? []).some((l) => l.floorId === p.id);
      rows.push(isLayer
        ? h('p', { class: 'hint' }, '▤ This floor is a layer.')
        : h('button', { class: 'wide', onclick: () => this.actions.makeLayer(p.id) }, '▤ Make this floor a layer'));
    }
    if (p.type === 'hullShell' || p.type === 'hullSides') {
      rows.push(h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: p.props.sealed !== false, onchange: (e) => setProp('sealed', (e.target as HTMLInputElement).checked) }), h('span', {}, 'Watertight (displaces water)')));
    }
    if (p.type === 'valve') {
      const open = p.props.open !== false;
      rows.push(h('button', { class: `wide ${open ? '' : 'danger'}`, onclick: () => setProp('open', !open) }, open ? '◉ Valve OPEN — click to close' : '◎ Valve CLOSED — click to open'));
    }
    if (def.mechanism) {
      const state = Number(p.props.state ?? 0);
      if (def.mechanism === 'turret') {
        rows.push(h('label', { class: 'field' }, h('span', {}, 'Traverse'),
          h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: state, oninput: (e) => this.store.updatePart(p.id, { props: { state: parseFloat((e.target as HTMLInputElement).value) } }, false) }),
          h('em', {}, `${Math.round(state * 360)}°`)));
      } else {
        const verb = { lift: ['Raise', 'Lower'], winch: ['Lower chain', 'Reel in'], door: ['Open', 'Close'], bayDoors: ['Open', 'Close'], turret: ['', ''] }[def.mechanism];
        rows.push(h('button', { class: 'wide operate', onclick: () => setProp('state', state > 0.5 ? 0 : 1) }, `⚙ ${state > 0.5 ? verb[1] : verb[0]}`));
      }
    }

    const matOptions = MATERIALS.map((m) => h('option', { value: m.id, selected: m.id === p.material }, `${m.name}${m.fantasy ? ' ✦' : ''}`));

    clear(this.el,
      h('div', { class: 'insp-head' },
        h('input', { class: 'name-input', type: 'text', value: p.name ?? '', placeholder: def.name, onchange: (e) => up({ name: (e.target as HTMLInputElement).value }) }),
        h('span', { class: 'badge' }, def.category)),
      h('p', { class: 'desc' }, def.description),
      h('div', { class: 'stats' },
        stat('Mass', fmt.kg(mass)),
        def.container && fluid ? stat('Holds', `${(partVolume(p) * 1000 >= 10000 ? `${partVolume(p).toFixed(1)} m³` : `${Math.round(partVolume(p) * 1000)} L`)} ${fluid.name}`) : null,
        def.structural ? stat('Capacity', fmt.n(memberCapacity(p))) : null,
        util !== undefined ? stat('Load', fmt.pct(util), util > 1 ? 'bad' : util > 0.7 ? 'warn' : 'good') : null,
        this.analysis?.unsupported.includes(p.id) ? stat('Support', 'floating!', 'bad') : null,
        def.electricDemand ? stat('Power', this.analysis?.powered.has(p.id) ? 'wired ✓' : 'no power', this.analysis?.powered.has(p.id) ? 'good' : 'warn') : null,
      ),
      h('label', { class: 'field' }, h('span', {}, 'Material'), h('select', { onchange: (e) => up({ material: (e.target as HTMLSelectElement).value }) }, matOptions)),
      vec('Position m', p.position, (v) => up({ position: v })),
      vec('Rotation °', p.rotation, (v) => up({ rotation: v }), DEG, 15),
      p.type === 'hullShell' ? null : vec('Size m', p.size, (v) => up({ size: v })),
      ...rows,
      twin ? h('p', { class: 'hint mirror-note' }, '⇋ Mirrored — edits apply to both sides. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.store.unlinkMirror([p.id]); } }, 'Unlink')) : null,
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.actions.focus(p.id) }, 'Focus'),
        h('button', { onclick: () => this.store.duplicate([p.id]) }, 'Duplicate'),
        h('button', { class: 'danger', onclick: () => this.store.removeParts([p.id]) }, 'Delete'),
      ),
      def.structural ? h('button', { class: 'wide', onclick: () => this.actions.wrapHull([p.id]) }, '⬢ Wrap hull around this') : null,
    );
  }
}

function stat(label: string, value: string, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('span', {}, label), h('b', {}, value));
}

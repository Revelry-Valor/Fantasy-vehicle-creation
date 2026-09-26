import { MATERIALS } from '../core/materials';
import { FLOOR_TYPES, FRAME_TYPES, SUPPORT_TYPES, type PenKind, type PenOptions } from '../core/pens';
import type { Store } from '../core/store';
import type { Blueprint } from '../render/blueprint';
import { h, clear } from './dom';

const PENS: { id: PenKind; name: string; key: string; hint: string }[] = [
  { id: 'floor', name: 'Floor', key: '1', hint: 'Walkable decking. Side view: a horizontal line. Top view: a rectangle. Select a floor in the top plan to drag its corners, pull out new corners from the + on each edge, or double-click a corner to remove it.' },
  { id: 'room', name: 'Floor + ceiling', key: '2', hint: 'A floor, a ceiling above it and the room (air volume) between.' },
  { id: 'support', name: 'Supports', key: '3', hint: 'Beams and pillars. Snaps to horizontal and vertical; hold Shift for any angle.' },
  { id: 'frame', name: 'Framing', key: '4', hint: 'Draw the outline of the craft point by point in thin planking or metal sheet. Add armor to either face if you like. Close the loop to seal the hull.' },
];

/** Left-panel controls for the 2D blueprint: view, tools, pens, options and layers. */
export class PenPanel {
  constructor(private el: HTMLElement, private store: Store, private bp: Blueprint, private onChange: () => void) {}

  render() {
    if (this.el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text') return;
    const bp = this.bp;
    const o = bp.opts;
    const set = <K extends keyof PenOptions>(k: K, v: PenOptions[K]) => { o[k] = v; this.render(); bp.invalidate(); };
    const num = (label: string, key: keyof PenOptions, unit: string, step: number, scale = 1, min = 0.01) =>
      h('label', { class: 'field' }, h('span', {}, label),
        h('input', {
          type: 'number', step, min: min * scale, value: +((o[key] as number) * scale).toFixed(3),
          onchange: (e) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v) && v > 0) set(key, (v / scale) as never); },
        }), h('em', {}, unit));
    const select = (label: string, key: keyof PenOptions, options: { value: string; label: string }[]) =>
      h('label', { class: 'field' }, h('span', {}, label),
        h('select', { onchange: (e) => set(key, (e.target as HTMLSelectElement).value as never) },
          options.map((x) => h('option', { value: x.value, selected: x.value === o[key] }, x.label))));
    const mats = MATERIALS.filter((m) => m.id !== 'glass' && m.id !== 'rubber').map((m) => ({ value: m.id, label: `${m.name}${m.fantasy ? ' ✦' : ''}` }));
    const skins = [{ value: 'none', label: 'None' }, ...mats];
    const side = bp.view === 'side';

    let options: (HTMLElement | null)[] = [];
    if (bp.tool === 'pen') {
      switch (bp.pen) {
        case 'floor':
        case 'room':
          options = [
            select('Flooring', 'floorType', FLOOR_TYPES.map((f) => ({ value: f.id, label: `${f.name} (${Math.round(f.thickness * 1000)} mm)` }))),
            side ? num('Width', 'width', 'm', 0.25) : null,
            bp.pen === 'room' ? num('Ceiling height', 'ceilingHeight', 'm', 0.1) : null,
          ];
          break;
        case 'support':
          options = [
            select('Type', 'supportType', SUPPORT_TYPES.map((s) => ({ value: s.id, label: s.name }))),
            select('Material', 'supportMaterial', mats),
            num('Thickness', 'supportSize', 'cm', 1, 100),
            side
              ? h('div', { class: 'seg' }, h('span', {}, 'Place'),
                segBtn('Both sides', o.supportPlacement === 'sides', () => set('supportPlacement', 'sides')),
                segBtn('Centre', o.supportPlacement === 'centre', () => set('supportPlacement', 'centre')))
              : h('div', { class: 'seg' }, h('span', {}, 'Draw'),
                segBtn('Pillars', o.supportOrientation === 'pillar', () => set('supportOrientation', 'pillar')),
                segBtn('Beams', o.supportOrientation === 'beam', () => set('supportOrientation', 'beam'))),
            side ? num('Width', 'width', 'm', 0.25) : o.supportOrientation === 'pillar' ? num('Pillar height', 'ceilingHeight', 'm', 0.1) : null,
          ];
          break;
        case 'frame':
          options = [
            h('label', { class: 'field' }, h('span', {}, 'Sheet'),
              h('select', {
                onchange: (e) => {
                  const ft = FRAME_TYPES.find((f) => f.id === (e.target as HTMLSelectElement).value)!;
                  o.frameMaterial = ft.material;
                  o.frameDepth = ft.thickness;
                  this.render();
                },
              }, FRAME_TYPES.map((f) => h('option', { value: f.id, selected: f.material === o.frameMaterial }, f.name)))),
            num('Thickness', 'frameDepth', 'mm', 1, 1000, 0.001),
            select('Armor outside', 'skinOuter', skins),
            select('Armor inside', 'skinInner', skins),
            o.skinOuter !== 'none' || o.skinInner !== 'none' ? num('Armor', 'skinThickness', 'mm', 1, 1000, 0.001) : null,
            side ? num('Width', 'width', 'm', 0.25) : num('Wall height', 'ceilingHeight', 'm', 0.1),
          ];
          break;
      }
    }

    const layers = bp.layers();
    const active = bp.activeLayer();
    clear(this.el,
      h('div', { class: 'panel-title' }, 'Blueprint'),
      h('div', { class: 'seg wide' },
        segBtn('Side profile', side, () => { bp.setView('side'); this.onChange(); }),
        segBtn('Top plan', !side, () => { bp.setView('top'); this.onChange(); })),
      h('div', { class: 'tool-grid' },
        toolBtn('➚ Select', 'V', bp.tool === 'select', () => bp.setTool('select')),
        toolBtn('▤ Make layer', '', bp.tool === 'layer', () => bp.setTool('layer')),
      ),
      h('div', { class: 'section-title' }, 'Pens'),
      h('div', { class: 'tool-grid' }, PENS.map((p) =>
        toolBtn(p.name, p.key, bp.tool === 'pen' && bp.pen === p.id, () => bp.setTool('pen', { pen: p.id }), p.hint))),
      bp.tool === 'pen' ? h('p', { class: 'hint' }, PENS.find((p) => p.id === bp.pen)!.hint) : null,
      options.length ? h('div', { class: 'pen-options' }, options) : null,
      h('div', { class: 'section-title' }, 'Layers'),
      layers.length
        ? h('ul', { class: 'layers' }, [...layers].reverse().map((l) => h('li', { class: l.id === active?.id ? 'active' : '' },
          h('input', { type: 'checkbox', checked: l.visible, title: 'Show in top plan', onchange: (e) => this.store.updateLayer(l.id, { visible: (e.target as HTMLInputElement).checked }) }),
          h('input', { type: 'text', class: 'layer-name', value: l.name, onchange: (e) => this.store.updateLayer(l.id, { name: (e.target as HTMLInputElement).value }) }),
          h('button', { class: 'mini', title: 'Draw on this layer', onclick: () => { bp.activeLayerId = l.id; if (bp.view !== 'top') bp.setView('top'); bp.invalidate(); this.onChange(); } }, `${l.y.toFixed(2)} m`),
          h('button', { class: 'mini danger', title: 'Remove layer (keeps the floor)', onclick: () => this.store.removeLayer(l.id) }, '✕'))))
        : h('p', { class: 'hint' }, 'No layers yet. Draw a floor, then use Make layer and click it. The top plan can then show one deck at a time.'),
      layers.length ? h('label', { class: 'field check' },
        h('input', { type: 'checkbox', checked: !bp.showAllLayers, onchange: (e) => { bp.showAllLayers = !(e.target as HTMLInputElement).checked; bp.invalidate(); } }),
        h('span', {}, 'Top plan: show only ticked layers')) : null,
    );
  }
}

function segBtn(label: string, active: boolean, onclick: () => void) {
  return h('button', { class: active ? 'active' : '', onclick }, label);
}

function toolBtn(label: string, key: string, active: boolean, onclick: () => void, title?: string) {
  return h('button', { class: `tool${active ? ' active' : ''}`, onclick, title }, label, key ? h('kbd', {}, key) : null);
}

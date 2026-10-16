import type { Store } from '../core/store';
import type { SheetSettings } from '../core/types';
import { sheetSettings } from '../render/sheet';
import { clear, h } from './dom';

const SCALES = [0, 10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 1000];

/** Left-panel options for the drafting sheet: style, title block and which views to draw. */
export class SheetPanel {
  onExport?: () => void;

  constructor(private el: HTMLElement, private store: Store) {}

  private set(patch: Partial<SheetSettings>) {
    this.store.commit(() => {
      this.store.design.sheet = { ...sheetSettings(this.store.design), ...patch };
    });
  }

  render() {
    const s = sheetSettings(this.store.design);
    const field = (label: string, value: string, on: (v: string) => void, placeholder = '') =>
      h('label', { class: 'field' }, h('span', {}, label),
        h('input', { type: 'text', value, placeholder, onchange: (e) => on((e.target as HTMLInputElement).value) }));
    const check = (label: string, on: boolean, set: (v: boolean) => void) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => set((e.target as HTMLInputElement).checked) }), label);
    clear(this.el,
      h('div', { class: 'panel-title' }, 'Drafting sheet'),
      h('p', { class: 'hint' }, 'A general-arrangement drawing of the craft, all views at one scale. The side view is cut on the centre line: framing and plating are sliced and hatched, fittings stay whole. Drag to pan, scroll to zoom, double-click to fit.'),
      h('div', { class: 'seg' }, h('span', {}, 'Style'),
        h('button', { class: s.style === 'line' ? 'active' : '', onclick: () => this.set({ style: 'line' }), title: 'Black ink on white, numbered key' }, 'Line'),
        h('button', { class: s.style === 'shaded' ? 'active' : '', onclick: () => this.set({ style: 'shaded' }), title: 'Grey shaded cutaway, labels on the drawing' }, 'Shaded')),
      h('div', { class: 'section-title' }, 'Title block'),
      h('div', { class: 'pen-options' },
        field('Name', this.store.design.name, (v) => this.store.commit(() => { this.store.design.name = v || 'Untitled Vessel'; })),
        field('Subtitle', s.subtitle, (v) => this.set({ subtitle: v })),
        field('Pattern', s.pattern, (v) => this.set({ pattern: v }), 'e.g. Mk II gunship'),
        field('Drawn by', s.drawnBy, (v) => this.set({ drawnBy: v })),
        h('label', { class: 'field' }, h('span', {}, 'Scale'),
          h('select', { onchange: (e) => this.set({ scale: parseInt((e.target as HTMLSelectElement).value, 10) }) },
            SCALES.map((n) => h('option', { value: n, selected: s.scale === n }, n ? `1 : ${n}` : 'Fit to sheet')))),
      ),
      h('div', { class: 'section-title' }, 'Show'),
      h('div', { class: 'checks' },
        check('Side cutaway', s.views.side, (v) => this.set({ views: { ...s.views, side: v } })),
        check('Plan', s.views.plan, (v) => this.set({ views: { ...s.views, plan: v } })),
        check('Front', s.views.front, (v) => this.set({ views: { ...s.views, front: v } })),
        check('Callouts', s.callouts, (v) => this.set({ callouts: v })),
        check('Particulars', s.specs, (v) => this.set({ specs: v })),
      ),
      h('button', { class: 'primary wide-btn', onclick: () => this.onExport?.() }, '⤓ Export sheet (.png)'),
      h('p', { class: 'hint' }, 'Name parts in the Inspector to change what the callouts say. Parts with the same name are counted together.'),
    );
  }
}

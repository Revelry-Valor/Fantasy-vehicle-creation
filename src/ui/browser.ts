import { allDefs } from '../model/catalog';
import { localBox, partAABB } from '../model/geometry';
import type { Studio } from '../model/studio';
import { defaultParams } from '../model/catalog';
import type { Category, PartDef } from '../model/types';
import { clear, h, storageGet, storageSet } from './dom';
import { thumbnail } from './thumbs';

const CATS: Category[] = ['Beams', 'Plates & shapes', 'Joints', 'Functional', 'Details', 'Custom'];
const FAV = 'vehicle-studio:favourites';

export interface BrowserHost {
  pick(def: PartDef): void;
  generator(kind: 'box' | 'wedge' | 'cylinder'): void;
  placeAssembly(id: string): void;
  deleteAssembly(id: string): void;
  active(): string | null;
}

/** The part browser: categories, search, favourites, thumbnails and a "fits here" filter. */
export class PartBrowser {
  private query = '';
  private favOnly = false;
  private fitsOnly = false;
  private favs = new Set<string>(storageGet<string[]>(FAV, []));

  constructor(private el: HTMLElement, private studio: Studio, private host: BrowserHost) {}

  private fits(def: PartDef): boolean {
    const sel = this.studio.selected();
    if (sel.length !== 1) return true;
    const box = partAABB(sel[0], this.studio.v);
    if (!box) return true;
    if (def.kind === 'beam' || def.kind === 'skin') return true;
    const lb = localBox({ id: 'x', def: def.id, params: defaultParams(def), position: [0, 0, 0], rotation: [0, 0, 0], material: def.material, layer: def.layer });
    const fx = box.max[0] - box.min[0], fz = box.max[2] - box.min[2];
    const [a, b] = [lb.h[0] * 2, lb.h[2] * 2].sort((x, y) => x - y);
    const [c, d] = [fx, fz].sort((x, y) => x - y);
    return a <= c + 1e-6 && b <= d + 1e-6;
  }

  render() {
    const q = this.query.trim().toLowerCase();
    const defs = allDefs(this.studio.v).filter((d) =>
      (!q || `${d.name} ${d.description} ${d.category} ${(d.tags ?? []).join(' ')}`.toLowerCase().includes(q)) &&
      (!this.favOnly || this.favs.has(d.id)) && (!this.fitsOnly || this.fits(d)));
    const active = this.host.active();
    const card = (d: PartDef) => h('div', { class: `part-card${active === d.id ? ' active' : ''}`, title: d.description, onclick: () => this.host.pick(d) },
      h('img', { src: thumbnail(d, this.studio.v), alt: '', draggable: 'false' }),
      h('span', { class: 'part-name' }, d.name),
      h('button', {
        class: `fav${this.favs.has(d.id) ? ' on' : ''}`, title: this.favs.has(d.id) ? 'Remove from favourites' : 'Add to favourites',
        onclick: (e) => { e.stopPropagation(); if (this.favs.has(d.id)) this.favs.delete(d.id); else this.favs.add(d.id); storageSet(FAV, [...this.favs]); this.render(); },
      }, this.favs.has(d.id) ? '★' : '☆'));
    const sections = CATS.map((c) => {
      const list = defs.filter((d) => d.category === c);
      if (!list.length) return null;
      return h('section', {}, h('div', { class: 'section-title' }, c), h('div', { class: 'part-grid' }, list.map(card)));
    });
    const asm = this.studio.v.assemblies;
    clear(this.el,
      h('div', { class: 'panel-title' }, 'Parts'),
      h('input', { type: 'search', class: 'search', placeholder: 'Search parts…', value: this.query, oninput: (e) => { this.query = (e.target as HTMLInputElement).value; this.render(); this.focusSearch(); } }),
      h('div', { class: 'filters' },
        h('label', { class: 'check', title: 'Only show starred parts' }, h('input', { type: 'checkbox', checked: this.favOnly, onchange: (e) => { this.favOnly = (e.target as HTMLInputElement).checked; this.render(); } }), 'Favourites'),
        h('label', { class: 'check', title: 'With one part selected, only show parts that fit on top of it' }, h('input', { type: 'checkbox', checked: this.fitsOnly, onchange: (e) => { this.fitsOnly = (e.target as HTMLInputElement).checked; this.render(); } }), 'Fits here')),
      sections,
      defs.length ? null : h('p', { class: 'hint' }, 'No parts match.'),
      h('section', {}, h('div', { class: 'section-title' }, 'Frame generators'),
        h('div', { class: 'gen-grid' },
          h('button', { onclick: () => this.host.generator('box'), title: 'Twelve beams around a box' }, '▣ Box frame'),
          h('button', { onclick: () => this.host.generator('wedge'), title: 'A box tapering to a keel line' }, '◣ Wedge frame'),
          h('button', { onclick: () => this.host.generator('cylinder'), title: 'Ring ribs with stringers, ready to skin' }, '◎ Cylinder frame'))),
      h('section', {}, h('div', { class: 'section-title' }, 'Assemblies'),
        asm.length
          ? h('ul', { class: 'asm-list' }, asm.map((a) => h('li', {},
            h('button', { class: 'link', onclick: () => this.host.placeAssembly(a.id), title: a.notes || 'Place a copy' }, `⧉ ${a.name}`),
            h('span', { class: 'muted' }, `${a.parts.length}`),
            h('button', { class: 'mini', title: 'Delete assembly', onclick: () => this.host.deleteAssembly(a.id) }, '✕'))))
          : h('p', { class: 'hint' }, 'Select parts and use "Save as assembly" to reuse a leg, turret or engine pod.')),
    );
  }

  private focusSearch() {
    const s = this.el.querySelector('input.search') as HTMLInputElement | null;
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
}

import { CATALOG, CATEGORIES, type PartDef } from '../core/catalog';
import { h, clear } from './dom';

const ICONS: Record<string, string> = {
  'Structure': '▦', 'Hull & Armor': '⬢', 'Lift & Buoyancy': '◯', 'Propulsion': '✢', 'Locomotion': '⚙',
  'Crew & Furnishing': '☺', 'Weapons': '⚔', 'Storage': '▣', 'Doors & Windows': '▯', 'Systems': '≋',
  'Mechanisms': '⛓', 'Compartments': '⬚',
};

export class CatalogPanel {
  private search = '';
  private collapsed = new Set<string>();
  active: string | null = null;

  constructor(private el: HTMLElement, private onPick: (def: PartDef) => void) {
    this.render();
  }

  setActive(type: string | null) {
    this.active = type;
    this.render();
  }

  render() {
    const q = this.search.toLowerCase();
    const input = h('input', {
      type: 'search', placeholder: 'Search parts…', value: this.search, class: 'search',
      oninput: (e) => {
        this.search = (e.target as HTMLInputElement).value;
        this.render();
        const again = this.el.querySelector('input.search') as HTMLInputElement;
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      },
    });
    const groups = CATEGORIES.map((cat) => {
      const items = CATALOG.filter((d) => d.category === cat && !d.hidden && (!q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)));
      if (!items.length) return null;
      const open = q || !this.collapsed.has(cat);
      return h('div', { class: 'cat-group' },
        h('button', {
          class: 'cat-head', onclick: () => {
            if (this.collapsed.has(cat)) this.collapsed.delete(cat); else this.collapsed.add(cat);
            this.render();
          },
        }, h('span', { class: 'cat-icon' }, ICONS[cat] ?? '•'), cat, h('span', { class: 'chev' }, open ? '▾' : '▸')),
        open ? h('div', { class: 'cat-items' }, items.map((d) =>
          h('button', {
            class: `cat-item${this.active === d.type ? ' active' : ''}`,
            title: `${d.description}\n${d.defaultSize.join(' × ')} m`,
            onclick: () => this.onPick(d),
          }, h('span', { class: 'name' }, d.name), h('span', { class: 'dims' }, d.defaultSize.map((s) => (s < 1 ? s.toFixed(2).replace(/^0/, '') : s.toFixed(s % 1 ? 1 : 0))).join('×'))),
        )) : null,
      );
    });
    clear(this.el, h('div', { class: 'panel-title' }, 'Parts'), input, h('div', { class: 'cat-list' }, groups),
      h('p', { class: 'hint' }, 'Pick a part, then click in the scene to place it. Parts snap onto the surface you click. Hold Shift to keep your selection.'));
  }
}

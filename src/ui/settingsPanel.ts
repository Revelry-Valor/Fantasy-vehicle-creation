import type { Store } from '../core/store';
import type { Environment } from '../core/types';
import { h, clear, num } from './dom';

export const CREW_PRESETS: { name: string; height: number }[] = [
  { name: 'Gnome / Halfling', height: 1.0 },
  { name: 'Dwarf', height: 1.35 },
  { name: 'Human', height: 1.8 },
  { name: 'Elf', height: 1.9 },
  { name: 'Orc', height: 2.0 },
  { name: 'Ogre', height: 2.8 },
  { name: 'Giant', height: 5 },
];

const ENVS: { id: Environment; name: string; hint: string }[] = [
  { id: 'air', name: '☁ Sky', hint: 'Needs lift ≥ weight.' },
  { id: 'land', name: '⛰ Land', hint: 'Needs wheels, tracks or legs.' },
  { id: 'water', name: '≈ Water surface', hint: 'Needs buoyancy and stability.' },
  { id: 'underwater', name: '⚓ Underwater', hint: 'Neutral buoyancy and a pressure hull.' },
  { id: 'space', name: '✦ Space', hint: 'Reaction thrust and a sealed hull.' },
];

export class SettingsPanel {
  constructor(private el: HTMLElement, private store: Store, private onRescaleCrew: () => void) {}

  render() {
    if (this.el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const s = this.store.design.settings;
    const set = (patch: Partial<typeof s>) => this.store.setSettings(patch);
    clear(this.el,
      h('label', { class: 'field' }, h('span', {}, 'Name'),
        h('input', { type: 'text', value: this.store.design.name, onchange: (e) => this.store.commit(() => { this.store.design.name = (e.target as HTMLInputElement).value; }) })),
      h('div', { class: 'section-title' }, 'Operating environment'),
      h('div', { class: 'env-grid' }, ENVS.map((e) => h('button', {
        class: s.environment === e.id ? 'active' : '', title: e.hint, onclick: () => set({ environment: e.id }),
      }, e.name))),
      s.environment === 'air' || s.environment === 'land' ? num('Cruise speed', s.cruiseSpeed, (v) => set({ cruiseSpeed: Math.max(0, v) }), { step: 1, min: 0, unit: 'm/s' }) : null,
      s.environment === 'air' || s.environment === 'water' ? num('Wind speed', s.windSpeed, (v) => set({ windSpeed: Math.max(0, v) }), { step: 1, min: 0, unit: 'm/s' }) : null,
      s.environment === 'air' ? num('Altitude', s.altitude, (v) => set({ altitude: Math.max(0, v) }), { step: 100, min: 0, unit: 'm' }) : null,
      s.environment === 'underwater' ? num('Operating depth', s.depth, (v) => set({ depth: Math.max(0, v) }), { step: 10, min: 0, unit: 'm' }) : null,
      h('div', { class: 'section-title' }, 'Scale'),
      num('Crew height', s.crewHeight, (v) => set({ crewHeight: Math.max(0.3, v) }), { step: 0.05, min: 0.3, unit: 'm' }),
      h('div', { class: 'chips' }, CREW_PRESETS.map((p) => h('button', {
        class: `chip ${Math.abs(p.height - s.crewHeight) < 0.01 ? 'active' : ''}`,
        onclick: () => set({ crewHeight: p.height }),
      }, `${p.name} ${p.height} m`))),
      h('p', { class: 'hint' }, 'New seats, beds, doors and crew are sized for this height. Everything is in real metres, so a design built for dwarves will feel cramped to an ogre.'),
      h('button', { class: 'wide', onclick: () => this.onRescaleCrew() }, 'Resize existing crew & furnishings to this height'),
    );
  }
}

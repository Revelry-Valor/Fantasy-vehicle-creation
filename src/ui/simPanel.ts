import { getDef } from '../core/catalog';
import { getFluid } from '../core/fluids';
import type { Store } from '../core/store';
import type { Simulation } from '../sim/simulation';
import { h, clear, fmt } from './dom';

export interface SimControls {
  start: () => void;
  stop: () => void;
  togglePause: () => void;
  setSpeed: (s: number) => void;
  damageTool: () => void;
  selectTool: () => void;
}

export class SimPanel {
  private controls = h('div');
  private body = h('div');
  private controlsKey = '';

  constructor(private el: HTMLElement, private store: Store, private ctl: SimControls) {}

  render(sim: Simulation | null, paused: boolean, speed: number, damageMode: boolean) {
    if (!sim) {
      this.controlsKey = '';
      clear(this.el,
        h('p', {}, 'Run the design to see how it behaves.'),
        h('ul', { class: 'hint-list' },
          h('li', {}, 'The craft rises or sinks with its real net lift.'),
          h('li', {}, 'Use the Damage tool to hit pipes, gasbags, tanks and wires.'),
          h('li', {}, 'Leaks drain whatever is connected and flood the surrounding compartment with that fluid — steam scalds, fuel poisons, hydrogen can explode, helium suffocates.'),
          h('li', {}, 'Close valves to isolate a leak; open doors to vent a compartment.'),
        ),
        h('button', { class: 'wide primary', onclick: this.ctl.start }, '▶ Start simulation'));
      return;
    }
    const s = sim.state;
    const a = s.analysis;
    const env = sim.design.settings.environment;
    const parts = this.store.design.parts;
    const containers = parts.filter((p) => getDef(p.type).container);
    const comps = parts.filter((p) => getDef(p.type).compartment);
    const crew = parts.filter((p) => getDef(p.type).crew);
    const damaged = parts.filter((p) => sim.health(p.id) < 1);

    // Controls are only rebuilt when they change, so clicks never land on a
    // button that the live readout below just replaced.
    const key = `${paused}|${speed}|${damageMode}`;
    if (key !== this.controlsKey || !this.el.contains(this.controls)) {
      this.controlsKey = key;
      clear(this.controls,
        h('div', { class: 'btn-row' },
          h('button', { onclick: this.ctl.togglePause }, paused ? '▶ Resume' : '❚❚ Pause'),
          h('button', { class: 'danger', onclick: this.ctl.stop }, '■ Stop & reset'),
        ),
        h('div', { class: 'btn-row' },
          ...[1, 4, 16].map((x) => h('button', { class: speed === x ? 'active' : '', onclick: () => this.ctl.setSpeed(x) }, `${x}×`)),
          h('button', { class: damageMode ? 'active danger' : '', onclick: damageMode ? this.ctl.selectTool : this.ctl.damageTool, title: 'Click parts to damage them; Shift-click repairs' }, '💥 Damage'),
        ),
      );
      clear(this.el, this.controls, this.body);
    }
    clear(this.body,
      h('table', { class: 'kv' },
        h('tr', {}, h('td', {}, 'Time'), h('td', {}, `${s.time.toFixed(1)} s`)),
        env === 'air' || env === 'underwater' ? h('tr', {}, h('td', {}, env === 'air' ? 'Height above ground' : 'Depth change'), h('td', {}, `${(env === 'air' ? s.altitude : -s.altitude).toFixed(1)} m`)) : null,
        env === 'air' || env === 'underwater' ? h('tr', {}, h('td', {}, 'Vertical speed'), h('td', {}, `${s.verticalSpeed.toFixed(2)} m/s`)) : null,
        a ? h('tr', { class: a.netVerticalN >= 0 ? 'good' : 'bad' }, h('td', {}, 'Net lift'), h('td', {}, fmt.n(a.netVerticalN))) : null,
        a ? h('tr', {}, h('td', {}, 'Mass'), h('td', {}, fmt.kg(a.totalMass))) : null,
      ),
      containers.length ? h('div', { class: 'section-title' }, 'Tanks & gasbags') : null,
      h('div', { class: 'meters' }, containers.map((p) => {
        const f = s.fill[p.id] ?? 0;
        const fluid = getFluid(String(p.props.fluid ?? ''));
        const color = `#${(fluid?.color ?? 0x888888).toString(16).padStart(6, '0')}`;
        return h('div', { class: 'meter', onclick: () => this.store.select([p.id]) },
          h('span', { class: 'm-label' }, p.name || getDef(p.type).name),
          h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${f * 100}%;background:${color}` })),
          h('span', { class: 'm-val' }, fmt.pct(f)));
      })),
      comps.length ? h('div', { class: 'section-title' }, 'Compartments') : null,
      comps.map((c) => {
        const at = s.atmos[c.id];
        if (!at) return null;
        const bad = at.temperature > 60 || at.toxicity > 0.2 || at.oxygen < 0.16 || at.flammable > 0.04 || at.flood > 0.3;
        return h('div', { class: `atmos ${bad ? 'bad' : ''}`, onclick: () => this.store.select([c.id]) },
          h('b', {}, String(c.props.label || c.name || 'Compartment'), at.exploded ? ' 💥' : ''),
          h('div', { class: 'atmos-grid' },
            cell('Temp', `${at.temperature.toFixed(0)} °C`, at.temperature > 60 ? 'bad' : at.temperature > 40 ? 'warn' : ''),
            cell('O₂', `${(at.oxygen * 100).toFixed(1)}%`, at.oxygen < 0.16 ? 'bad' : at.oxygen < 0.19 ? 'warn' : ''),
            cell('Toxic', fmt.pct(at.toxicity), at.toxicity > 0.2 ? 'bad' : at.toxicity > 0.05 ? 'warn' : ''),
            cell('Flammable', `${(at.flammable * 100).toFixed(1)}%`, at.flammable > 0.04 ? 'bad' : at.flammable > 0.01 ? 'warn' : ''),
            at.flood > 0 ? cell('Flooded', fmt.pct(at.flood), at.flood > 0.3 ? 'bad' : 'warn') : null,
          ));
      }),
      crew.length ? h('div', { class: 'section-title' }, 'Crew') : null,
      h('ul', { class: 'crew' }, crew.map((p) => {
        const st = sim.crewStatus(p);
        return h('li', { class: st.level }, h('b', {}, p.name || 'Crew'), ` — ${st.status}`);
      })),
      damaged.length ? h('div', { class: 'section-title' }, 'Damage') : null,
      h('ul', { class: 'crew' }, damaged.map((p) => h('li', { class: sim.health(p.id) === 0 ? 'error' : 'warn' },
        `${p.name || getDef(p.type).name}: ${fmt.pct(sim.health(p.id))} `,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); sim.repair(p.id); } }, 'repair')))),
      h('div', { class: 'section-title' }, 'Event log'),
      h('ul', { class: 'log' }, [...s.log].reverse().slice(0, 40).map((l) => h('li', { class: l.level }, h('span', { class: 't' }, `${l.t.toFixed(1)}s`), l.msg))),
    );
  }
}

function cell(label: string, value: string, cls: string) {
  return h('div', { class: `cell ${cls}` }, h('span', {}, label), h('b', {}, value));
}

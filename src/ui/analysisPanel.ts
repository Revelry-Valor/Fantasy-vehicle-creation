import type { Analysis, Issue } from '../core/analysis';
import type { Category } from '../core/catalog';
import type { Design } from '../core/types';
import { h, clear, fmt } from './dom';

const LEVEL_ICON: Record<Issue['level'], string> = { ok: '✔', info: 'ℹ', warn: '⚠', error: '✖' };

export class AnalysisPanel {
  constructor(private el: HTMLElement, private onSelect: (ids: string[]) => void) {}

  render(a: Analysis | null, design: Design) {
    if (!a) return;
    const env = design.settings.environment;
    const rows: [string, string, string?][] = [
      ['Total mass', fmt.kg(a.totalMass)],
      ['Weight', fmt.n(a.weightN)],
    ];
    if (a.gasLiftN) rows.push(['Gas lift', fmt.n(a.gasLiftN)]);
    if (a.wingLiftN) rows.push([`Wing lift @ ${design.settings.cruiseSpeed} m/s`, fmt.n(a.wingLiftN)]);
    if (a.magicLiftN) rows.push(['Arcane lift', fmt.n(a.magicLiftN)]);
    if (env === 'water' || env === 'underwater') rows.push(['Buoyancy', fmt.n(env === 'water' ? a.displacementCapacityN : a.waterBuoyancyN), env === 'water' ? 'max if fully submerged' : undefined]);
    if (env !== 'land' && env !== 'space') rows.push(['Net vertical', `${a.netVerticalN >= 0 ? '+' : ''}${fmt.n(a.netVerticalN)}`, a.netVerticalN >= 0 ? 'good' : 'bad']);
    rows.push(['Thrust', fmt.n(a.thrustN)]);
    if (a.thrustN) rows.push(['Acceleration', `${a.accel.toFixed(2)} m/s²`]);
    if (a.deltaV) rows.push(['Δv', `${Math.round(a.deltaV)} m/s`]);
    if (a.groundPressureKPa !== null) rows.push(['Ground pressure', `${a.groundPressureKPa.toFixed(0)} kPa`]);
    if (a.rolloverDeg !== null && env === 'land') rows.push(['Rollover angle', `${a.rolloverDeg.toFixed(0)}°`]);
    if (a.draft !== null) rows.push(['Draft', fmt.m(a.draft)]);
    if (a.metacentricHeight !== null) rows.push(['GM (stability)', fmt.m(a.metacentricHeight), a.metacentricHeight > 0 ? 'good' : 'bad']);
    if (a.crushDepth !== null && (env === 'underwater' || env === 'space')) rows.push(['Crush depth', `${Math.round(a.crushDepth)} m`]);
    if (env === 'underwater') rows.push([`Pressure @ ${design.settings.depth} m`, `${a.pressureAtDepthBar.toFixed(1)} bar`]);
    rows.push(['Engine power', `${a.mechSupplyKW.toFixed(0)} / ${a.mechDemandKW.toFixed(0)} kW`, a.mechSupplyKW >= a.mechDemandKW ? '' : 'warn']);
    if (a.elecDemandW) rows.push(['Electric', `${(a.elecSupplyW / 1000).toFixed(1)} / ${(a.elecDemandW / 1000).toFixed(1)} kW`, a.elecSupplyW >= a.elecDemandW ? '' : 'warn']);

    const cats = Object.entries(a.massByCategory).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0)) as [Category, number][];
    const maxCat = Math.max(1, ...cats.map((c) => c[1]));

    const issues = [...a.issues].sort((x, y) => order(x.level) - order(y.level));

    clear(this.el,
      h('div', { class: `verdict ${a.verdict.level}` }, h('span', { class: 'v-icon' }, LEVEL_ICON[a.verdict.level]), a.verdict.message),
      h('div', { class: 'dims' },
        h('div', {}, h('b', {}, a.dims[2].toFixed(1)), ' m long'),
        h('div', {}, h('b', {}, a.dims[0].toFixed(1)), ' m beam'),
        h('div', {}, h('b', {}, a.dims[1].toFixed(1)), ' m tall'),
      ),
      h('table', { class: 'kv' }, rows.map(([k, v, cls]) => h('tr', { class: cls ?? '' }, h('td', {}, k), h('td', {}, v)))),
      h('div', { class: 'section-title' }, 'Crew'),
      h('div', { class: 'chips' },
        chip('Crew', a.crew), chip('Seats', a.seats), chip('Berths', a.beds), chip('Weapons', a.weapons), chip('Helms', a.controlStations),
      ),
      h('div', { class: 'section-title' }, 'Checks'),
      issues.length ? h('ul', { class: 'issues' }, issues.map((i) => h('li', {
        class: `${i.level}${i.partIds?.length ? ' clickable' : ''}`,
        onclick: i.partIds?.length ? () => this.onSelect(i.partIds!) : undefined,
        title: i.partIds?.length ? 'Click to select the parts involved' : undefined,
      }, h('span', { class: 'i-icon' }, LEVEL_ICON[i.level]), i.message))) : h('p', { class: 'hint' }, 'No problems found.'),
      h('div', { class: 'section-title' }, 'Mass breakdown'),
      h('div', { class: 'bars' }, cats.map(([c, m]) => h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, c),
        h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${(m / maxCat) * 100}%` })),
        h('span', { class: 'bar-val' }, fmt.kg(m))))),
      h('p', { class: 'hint' }, 'Yellow marker = centre of gravity, blue = centre of lift. In Structural view members are coloured by load: green → red.'),
    );
  }
}

function order(l: Issue['level']) {
  return { error: 0, warn: 1, info: 2, ok: 3 }[l];
}

function chip(label: string, n: number) {
  return h('span', { class: 'chip' }, h('b', {}, String(n)), ' ', label);
}

import { getDef } from '../model/catalog';
import { applyControl, clampValue, dofCount, jointSpec, jointValues, sampleAnimation } from '../model/rig';
import type { Studio } from '../model/studio';
import { newId, type Animation, type Control, type Part } from '../model/types';
import { clear, h } from './dom';

const DOF_NAMES: Record<string, string[]> = { ball: ['Pitch', 'Yaw', 'Roll'], wheel: ['Spin', 'Steer'] };

export interface MotionHost {
  playing(): boolean;
  play(anim: string | null): void;
  stop(): void;
  time(): number;
  seek(t: number): void;
  aimTool(): void;
  status(m: string): void;
}

/** Controls panel: a slider for every joint, linked controls, saved poses and the timeline. */
export class MotionPanel {
  activeAnim: string | null = null;

  constructor(private el: HTMLElement, private studio: Studio, private host: MotionHost) {}

  render() {
    const v = this.studio.v;
    const joints = v.parts.filter((p) => jointSpec(v, p) && !(p.mirror && false));
    const name = (p: Part) => p.name || getDef(p.def, v).name;
    const { rig } = this.studio.analysis();
    if (this.activeAnim && !v.animations.some((a) => a.id === this.activeAnim)) this.activeAnim = null;
    if (!this.activeAnim && v.animations.length) this.activeAnim = v.animations[0].id;
    const anim = v.animations.find((a) => a.id === this.activeAnim) ?? null;
    clear(this.el,
      // Joints.
      h('div', { class: 'section-title' }, `Joints (${joints.length})`),
      joints.length ? null : h('p', { class: 'hint' }, 'Add a hinge, turret ring, ball joint, piston or wheel from Parts → Joints. Whatever touches its top half moves with it.'),
      h('div', { class: 'joint-list' }, joints.map((p) => {
        const spec = jointSpec(v, p)!;
        const vals = jointValues(v, p);
        const locked = rig.joints.get(p.id)?.locked;
        const unit = spec.type === 'piston' ? 'm' : '°';
        return h('div', { class: `joint${this.studio.selection.includes(p.id) ? ' sel' : ''}` },
          h('div', { class: 'joint-head' },
            h('button', { class: 'link', onclick: () => this.studio.select([p.id]) }, name(p)),
            h('span', { class: 'muted' }, spec.type, p.mirror ? ' · mirrored' : ''),
            locked ? h('span', { class: 'warn-text' }, 'locked') : null),
          Array.from({ length: dofCount(spec) }, (_, d) => {
            const free = spec.type === 'wheel' && d === 0;
            const min = free ? -180 : spec.min, max = free ? 180 : spec.max;
            const step = spec.type === 'piston' ? 0.01 : 1;
            const shown = free ? ((((vals[d] + 180) % 360) + 360) % 360) - 180 : vals[d];
            return h('label', { class: 'slider' },
              h('span', {}, DOF_NAMES[spec.type]?.[d] ?? (spec.type === 'piston' ? 'Extend' : 'Angle')),
              h('input', { type: 'range', min, max, step, value: shown, disabled: locked,
                oninput: (e) => {
                  const x = parseFloat((e.target as HTMLInputElement).value);
                  this.studio.pose(`Pose ${name(p)}`, () => { const cur = jointValues(v, p); cur[d] = clampValue(spec, d, x); v.jointValues[p.id] = cur; }, `slider-${p.id}-${d}`);
                  const out = (e.target as HTMLElement).parentElement!.querySelector('output');
                  if (out) out.textContent = `${x.toFixed(spec.type === 'piston' ? 2 : 0)}${unit}`;
                } }),
              h('output', {}, `${shown.toFixed(spec.type === 'piston' ? 2 : 0)}${unit}`));
          }));
      })),
      joints.length ? h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.studio.pose('All joints to rest', () => { v.jointValues = {}; }) }, 'All to rest'),
        h('button', { onclick: () => this.mirrorPose(), title: 'Copy each joint\'s value to its mirror twin, so both sides match' }, 'Match twins')) : null,

      // Controls.
      h('div', { class: 'section-title' }, 'Linked controls'),
      h('p', { class: 'hint' }, 'One dial for many joints, each with its own ratio and direction. An aim control turns its turrets and guns toward a clicked point.'),
      v.controls.map((c) => this.control(c, joints, name)),
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => this.addControl(false), title: 'New control; selected joints are linked to it' }, '+ Control'),
        h('button', { onclick: () => this.addControl(true), title: 'New aim control; selected turrets and hinges are linked to it' }, '+ Aim control'),
        v.controls.some((c) => c.aim) ? h('button', { onclick: () => this.host.aimTool() }, '⌖ Aim at point') : null),

      // Poses.
      h('div', { class: 'section-title' }, 'Poses'),
      v.poses.length ? h('ul', { class: 'pose-list' }, v.poses.map((ps) => h('li', {},
        h('button', { class: 'pose-btn', onclick: () => this.studio.pose(`Pose: ${ps.name}`, () => { Object.assign(v.jointValues, structuredClone(ps.values)); }, `apply-${ps.id}`), title: 'Switch to this pose' }, ps.name),
        h('button', { class: 'mini', onclick: () => this.studio.commit('Update pose', () => { ps.values = this.currentValues(); }), title: 'Store the current joint positions in this pose' }, 'Update'),
        h('button', { class: 'mini', onclick: () => { const n = prompt('Rename pose', ps.name); if (n) this.studio.commit('Rename pose', () => { ps.name = n; }); } }, '✎'),
        h('button', { class: 'mini', onclick: () => this.studio.commit('Delete pose', () => { v.poses = v.poses.filter((x) => x.id !== ps.id); for (const a of v.animations) a.keys = a.keys.filter((k) => k.pose !== ps.id); }) }, '✕')))) : h('p', { class: 'hint' }, 'Set the joints, then save the pose: rest, kneeling, mid-stride, guns deployed.'),
      h('div', { class: 'btn-row' }, h('button', { onclick: () => {
        const n = prompt('Name this pose', v.poses.length ? `Pose ${v.poses.length + 1}` : 'Rest');
        if (n) this.studio.commit('Save pose', () => { v.poses.push({ id: newId('pose'), name: n, values: this.currentValues() }); });
      } }, '+ Save current pose')),

      // Animation.
      h('div', { class: 'section-title' }, 'Timeline'),
      v.animations.length ? h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Animation'), h('select', { onchange: (e) => { this.host.stop(); this.activeAnim = (e.target as HTMLSelectElement).value; this.render(); } },
          v.animations.map((a) => h('option', { value: a.id, selected: a.id === this.activeAnim }, a.name)))),
        h('button', { onclick: () => this.newAnim() }, '+ New')) : h('div', { class: 'btn-row' }, h('button', { onclick: () => this.newAnim(), disabled: v.poses.length < 2, title: v.poses.length < 2 ? 'Save at least two poses first' : '' }, '+ New animation')),
      anim ? this.timeline(anim) : null,
    );
  }

  private currentValues(): Record<string, number[]> {
    const v = this.studio.v;
    const out: Record<string, number[]> = {};
    for (const p of v.parts) if (jointSpec(v, p)) out[p.id] = jointValues(v, p);
    return out;
  }

  private mirrorPose() {
    const v = this.studio.v;
    this.studio.pose('Match twins', () => {
      for (const p of v.parts) {
        if (!p.mirror || !jointSpec(v, p)) continue;
        const src = v.parts.find((x) => x.id === p.mirror!.source);
        if (src) v.jointValues[p.id] = jointValues(v, src).slice();
      }
    });
  }

  private addControl(aim: boolean) {
    const v = this.studio.v;
    const sel = this.studio.selected().filter((p) => {
      const s = jointSpec(v, p);
      return s && (!aim || s.type === 'turret' || s.type === 'hinge');
    });
    const c: Control = { id: newId('c'), name: aim ? 'Aim' : `Control ${v.controls.length + 1}`, value: 0, min: -180, max: 180, aim, links: sel.map((p) => ({ joint: p.id, ratio: 1, offset: 0 })) };
    if (!aim && sel.length && sel.every((p) => jointSpec(v, p)!.type === 'piston')) { c.min = 0; c.max = Math.max(...sel.map((p) => jointSpec(v, p)!.max)); }
    this.studio.commit(aim ? 'Add aim control' : 'Add control', () => { v.controls.push(c); });
    this.host.status(sel.length ? `Linked ${sel.length} joint${sel.length > 1 ? 's' : ''}.` : 'Control added. Select joints and press "+ selected" to link them.');
  }

  private control(c: Control, joints: Part[], name: (p: Part) => string) {
    const v = this.studio.v;
    return h('div', { class: 'control' },
      h('div', { class: 'joint-head' },
        h('input', { type: 'text', class: 'ctl-name', value: c.name, onchange: (e) => this.studio.commit('Rename control', () => { c.name = (e.target as HTMLInputElement).value; }) }),
        c.aim ? h('span', { class: 'tag' }, 'aim') : null,
        h('button', { class: 'mini', onclick: () => this.studio.commit('Delete control', () => { v.controls = v.controls.filter((x) => x.id !== c.id); }) }, '✕')),
      c.aim ? null : h('label', { class: 'slider' }, h('span', {}, 'Value'),
        h('input', { type: 'range', min: c.min, max: c.max, step: (c.max - c.min) / 360, value: c.value, oninput: (e) => {
          const x = parseFloat((e.target as HTMLInputElement).value);
          this.studio.pose(`Control ${c.name}`, () => applyControl(v, c.id, x), `ctl-${c.id}`);
          const out = (e.target as HTMLElement).parentElement!.querySelector('output');
          if (out) out.textContent = x.toFixed(1);
        } }), h('output', {}, c.value.toFixed(1))),
      h('table', { class: 'links' },
        c.links.map((l, i) => h('tr', {},
          h('td', {}, h('select', { onchange: (e) => this.studio.commit('Link', () => { l.joint = (e.target as HTMLSelectElement).value; }) }, joints.map((j) => h('option', { value: j.id, selected: j.id === l.joint }, name(j))))),
          c.aim ? null : h('td', { title: 'Ratio: −1 turns the other way, 0.5 half as far' }, h('input', { type: 'number', class: 'small', step: 0.1, value: l.ratio, onchange: (e) => this.studio.commit('Link ratio', () => { l.ratio = parseFloat((e.target as HTMLInputElement).value) || 0; }) })),
          c.aim ? null : h('td', { title: 'Offset added after the ratio' }, h('input', { type: 'number', class: 'small', step: 1, value: l.offset, onchange: (e) => this.studio.commit('Link offset', () => { l.offset = parseFloat((e.target as HTMLInputElement).value) || 0; }) })),
          h('td', {}, h('button', { class: 'mini', onclick: () => this.studio.commit('Unlink', () => { c.links.splice(i, 1); }) }, '✕'))))),
      h('button', { class: 'mini', onclick: () => {
        const sel = this.studio.selected().filter((p) => jointSpec(v, p) && !c.links.some((l) => l.joint === p.id));
        if (!sel.length) return this.host.status('Select one or more joints first.');
        this.studio.commit('Link joints', () => { for (const p of sel) c.links.push({ joint: p.id, ratio: 1, offset: 0 }); });
      } }, '+ selected joints'));
  }

  private newAnim() {
    const v = this.studio.v;
    const n = prompt('Name this animation', v.animations.length ? `Animation ${v.animations.length + 1}` : 'Walk cycle');
    if (!n) return;
    const keys = v.poses.slice(0, 4).map((p, i) => ({ time: i, pose: p.id }));
    const a: Animation = { id: newId('anim'), name: n, duration: Math.max(1, keys.length), loop: true, smooth: true, keys };
    this.studio.commit('New animation', () => { v.animations.push(a); });
    this.activeAnim = a.id;
    this.render();
  }

  private timeline(a: Animation) {
    const v = this.studio.v;
    const t = this.host.time();
    const W = 100;
    const bar = h('div', { class: 'tl-bar', title: 'Click to scrub' });
    bar.addEventListener('pointerdown', (e) => {
      const r = bar.getBoundingClientRect();
      const seek = (x: number) => { this.host.seek(Math.max(0, Math.min(a.duration, ((x - r.left) / r.width) * a.duration))); };
      seek(e.clientX);
      const mv = (ev: PointerEvent) => seek(ev.clientX);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    });
    for (const k of a.keys) {
      const pose = v.poses.find((p) => p.id === k.pose);
      bar.append(h('div', { class: 'tl-key', style: `left:${(k.time / a.duration) * W}%`, title: `${pose?.name ?? '?'} at ${k.time}s` }, h('span', {}, pose?.name ?? '?')));
    }
    bar.append(h('div', { class: 'tl-head', style: `left:${(Math.min(a.duration, t % (a.duration || 1)) / a.duration) * W}%` }));
    return h('div', { class: 'timeline' },
      h('div', { class: 'btn-row' },
        this.host.playing() ? h('button', { class: 'primary', onclick: () => this.host.stop() }, '❚❚ Pause') : h('button', { class: 'primary', onclick: () => this.host.play(a.id) }, '▶ Play'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.loop, onchange: (e) => this.studio.commit('Loop', () => { a.loop = (e.target as HTMLInputElement).checked; }) }), 'Loop'),
        h('label', { class: 'check', title: 'Ease in and out of each pose' }, h('input', { type: 'checkbox', checked: a.smooth, onchange: (e) => this.studio.commit('Smooth', () => { a.smooth = (e.target as HTMLInputElement).checked; }) }), 'Smooth'),
        h('label', { class: 'inline' }, 'Length', h('input', { type: 'number', class: 'small', min: 0.1, step: 0.1, value: a.duration, onchange: (e) => this.studio.commit('Animation length', () => { a.duration = Math.max(0.1, parseFloat((e.target as HTMLInputElement).value) || 1); }) }), 's')),
      bar,
      h('table', { class: 'keys' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Pose'), h('th', {})),
        a.keys.map((k, i) => h('tr', {},
          h('td', {}, h('input', { type: 'number', class: 'small', min: 0, step: 0.1, value: k.time, onchange: (e) => this.studio.commit('Key time', () => { k.time = Math.max(0, Math.min(a.duration, parseFloat((e.target as HTMLInputElement).value) || 0)); }) })),
          h('td', {}, h('select', { onchange: (e) => this.studio.commit('Key pose', () => { k.pose = (e.target as HTMLSelectElement).value; }) }, v.poses.map((p) => h('option', { value: p.id, selected: p.id === k.pose }, p.name)))),
          h('td', {}, h('button', { class: 'mini', onclick: () => this.studio.commit('Remove key', () => { a.keys.splice(i, 1); }) }, '✕'))))),
      h('div', { class: 'btn-row' },
        h('button', { disabled: !v.poses.length, onclick: () => this.studio.commit('Add key', () => { const last = a.keys.reduce((m, k) => Math.max(m, k.time), -1); const time = Math.min(a.duration, +(last + 1).toFixed(2)); if (time >= a.duration) a.duration = time + 1; a.keys.push({ time, pose: v.poses[0].id }); }) }, '+ Key'),
        h('button', { class: 'danger', onclick: () => { this.host.stop(); this.studio.commit('Delete animation', () => { v.animations = v.animations.filter((x) => x.id !== a.id); }); } }, 'Delete')),
      h('p', { class: 'hint' }, 'The studio blends between the poses in order, so a walker steps through its stride without actually walking.'));
  }

  /** For playback: values at time t. */
  sample(t: number) {
    const a = this.studio.v.animations.find((x) => x.id === this.activeAnim);
    return a ? sampleAnimation(this.studio.v, a, t) : null;
  }
}

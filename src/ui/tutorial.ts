import { getDef } from '../model/catalog';
import type { Studio } from '../model/studio';
import type { Viewport } from '../render/viewport';
import { clear, h } from './dom';

interface Step { title: string; body: string; done: (s: Studio) => boolean }

const STEPS: Step[] = [
  { title: '1 · A frame', body: 'Pick Square beam in Parts. Click four grid points to draw a rectangle on the floor; each click adds a straight beam. Right-click or Esc to stop. Hold Shift to draw straight up.',
    done: (s) => s.v.parts.filter((p) => p.path).length >= 4 },
  { title: '2 · Plating', body: 'Choose Select (V). Shift-click the four beams (or drag a box around them), then press "Skin between these beams" in Properties. The plate follows the beams; drag a beam\'s blue diamond to bend it and watch the plate follow.',
    done: (s) => s.v.parts.some((p) => p.surface) },
  { title: '3 · Mirroring', body: 'Live mirror is on across X (left/right). Pick any part, say a Greeble block, and place it off the centre line: its twin appears on the other side. Edit either one and the other follows.',
    done: (s) => s.v.parts.some((p) => p.mirror) },
  { title: '4 · A joint', body: 'Place a Hinge on your frame, then put a beam or plate on its top half. Choose Pose (P) and drag that part: it swings on the hinge within its limits. Save the pose in Controls.',
    done: (s) => Object.values(s.v.jointValues).some((x) => x.some((y) => Math.abs(y) > 0.5)) && s.v.parts.some((p) => getDef(p.def, s.v).kind === 'joint') },
];

/** The guided first build: frame, plating, mirroring and one joint. */
export class Tutorial {
  private el: HTMLDivElement;
  private i = -1;

  constructor(host: HTMLElement, private studio: Studio, private vp: Viewport, private status: (m: string) => void) {
    this.el = h('div', { class: 'tutorial', hidden: true });
    host.append(this.el);
  }

  offer() {
    this.i = -2;
    clear(this.el,
      h('b', {}, 'New here?'),
      h('p', {}, 'A two-minute guided build: a frame, plating, mirroring and one joint.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'primary', onclick: () => this.start() }, 'Start'), h('button', { onclick: () => this.close() }, 'No thanks')));
    this.el.hidden = false;
  }

  start() {
    this.i = 0;
    this.vp.setTool('select');
    this.draw();
  }

  close() {
    this.i = -1;
    this.el.hidden = true;
  }

  check() {
    if (this.i < 0 || this.i >= STEPS.length) return;
    if (STEPS[this.i].done(this.studio)) {
      this.i++;
      if (this.i >= STEPS.length) {
        clear(this.el, h('b', {}, '✓ That\'s the loop.'),
          h('p', {}, 'Frames from beams, plates over them, mirrored sides and posable joints. Open ☰ File → Samples for a walker, a battleship and a buggy to take apart.'),
          h('div', { class: 'btn-row' }, h('button', { class: 'primary', onclick: () => this.close() }, 'Done')));
        this.status('Tutorial complete.');
        return;
      }
      this.draw();
    }
  }

  private draw() {
    const st = STEPS[this.i];
    clear(this.el,
      h('div', { class: 'tut-head' }, h('b', {}, st.title), h('span', { class: 'muted' }, `${this.i + 1} / ${STEPS.length}`)),
      h('p', {}, st.body),
      h('div', { class: 'btn-row' },
        h('button', { onclick: () => { this.i = Math.min(STEPS.length - 1, this.i + 1); this.draw(); } }, 'Skip step'),
        h('button', { onclick: () => this.close() }, 'Close')));
    this.el.hidden = false;
  }
}

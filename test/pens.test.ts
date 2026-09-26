import { describe, expect, test } from 'vitest';
import { analyze } from '../src/core/analysis';
import { DEFAULT_PEN_OPTIONS, drawFloor, drawFraming, drawHullSides, drawRoom, drawSupport, endpoints, moveEndpoint, resolveLayers, toPlane } from '../src/core/pens';
import { rotationMatrix } from '../src/core/geometry';
import { Store } from '../src/core/store';
import { newDesign } from '../src/core/types';

const opts = { ...DEFAULT_PEN_OPTIONS, width: 4 };

describe('pens', () => {
  test('side-view floor spans the drawn length and the set width', () => {
    const [f] = drawFloor('side', { u: -3, v: 1 }, { u: 5, v: 1 }, opts);
    expect(f.size[0]).toBe(4);
    expect(f.size[2]).toBe(8);
    expect(f.position[2]).toBe(1);
    expect(f.position[1] + f.size[1] / 2).toBeCloseTo(1); // top surface on the line
  });

  test('room makes floor, ceiling and an air volume', () => {
    const parts = drawRoom('side', { u: 0, v: 0 }, { u: 4, v: 0 }, { ...opts, ceilingHeight: 2.5 });
    expect(parts.map((p) => p.type)).toEqual(['deck', 'deck', 'compartment']);
    const ceiling = parts[1];
    expect(ceiling.position[1] - ceiling.size[1] / 2).toBeCloseTo(2.5);
  });

  test('side supports come as a mirrored pair against the walls', () => {
    const parts = drawSupport('side', { u: 0, v: 0 }, { u: 0, v: 2 }, opts);
    expect(parts).toHaveLength(2);
    expect(parts[0].mirrorOf).toBe(parts[1].id);
    expect(Math.abs(parts[0].position[0])).toBeCloseTo(1.9);
    const [a, b] = endpoints(parts[0]).map((w) => toPlane('side', w));
    expect(Math.min(a.v, b.v)).toBeCloseTo(0);
    expect(Math.max(a.v, b.v)).toBeCloseTo(2);
  });

  test('top-view walls stand up from the layer', () => {
    const [w] = drawFraming('top', [{ u: 0, v: 1 }, { u: 3, v: 1 }], { ...opts, ceilingHeight: 2.4 }, 1);
    const [a, b] = endpoints(w);
    expect(a[1]).toBeCloseTo(2.2); // centre of a 2.4 m wall on a 1 m deck
    expect(Math.abs(b[2] - a[2])).toBeCloseTo(3);
    expect(w.size[0]).toBeCloseTo(2.4); // the span runs vertically
  });

  test('closed framing loop makes a sealed hull that floats', () => {
    const loop = [{ u: -5, v: 0 }, { u: 5, v: 0 }, { u: 5, v: 2 }, { u: -5, v: 2 }, { u: -5, v: 0 }];
    const frames = drawFraming('side', loop, opts);
    const sides = drawHullSides(loop, opts)!;
    expect(sides.props.volume).toBeCloseTo(80);
    const d = newDesign();
    d.settings.environment = 'water';
    d.parts = [...frames, sides];
    const a = analyze(d);
    expect(a.displacementCapacityN).toBeGreaterThan(a.weightN);
    expect(a.unsupported).toEqual([]);
  });

  test('framing outside faces point away from the middle', () => {
    const loop = [{ u: -5, v: 0 }, { u: 5, v: 0 }, { u: 5, v: 2 }, { u: -5, v: 2 }];
    const [bottom, , top] = drawFraming('side', loop, opts);
    // World-space direction the outside plating faces.
    const outside = (p: typeof top) => {
      const m = rotationMatrix(p.rotation);
      return m[4] * Number(p.props.outSign);
    };
    expect(outside(bottom)).toBeLessThan(0); // belly plating faces down
    expect(outside(top)).toBeGreaterThan(0); // roof plating faces up
  });
});

describe('editing', () => {
  test('moving one end leaves the other end fixed', () => {
    const [s] = drawSupport('side', { u: 0, v: 0 }, { u: 0, v: 2 }, { ...opts, supportPlacement: 'centre' });
    const [e0, e1] = endpoints(s);
    const top = e0[1] > e1[1] ? 0 : 1;
    const fixed = endpoints(s)[top === 0 ? 1 : 0];
    const next = moveEndpoint(s, top as 0 | 1, [0, 2, 1])!;
    const moved = { ...s, ...next };
    const after = endpoints(moved);
    after[top === 0 ? 1 : 0].forEach((v, i) => expect(v).toBeCloseTo(fixed[i]));
    after[top].forEach((v, i) => expect(v).toBeCloseTo([0, 2, 1][i]));
    expect(moved.size[2]).toBeCloseTo(Math.hypot(1, 2));
  });

  test('layers follow their floor and vanish with it', () => {
    const s = new Store();
    const [f] = drawFloor('side', { u: 0, v: 3 }, { u: 4, v: 3 }, opts);
    s.addParts([f]);
    s.makeLayer(f.id);
    expect(resolveLayers(s.design)[0].y).toBeCloseTo(3);
    s.updatePart(f.id, { position: [0, 5 - f.size[1] / 2, 2] });
    expect(resolveLayers(s.design)[0].y).toBeCloseTo(5);
    s.removeParts([f.id]);
    expect(s.design.layers).toEqual([]);
  });
});

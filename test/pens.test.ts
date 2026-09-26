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
    expect(f.position[1]).toBeCloseTo(1); // centred on the drawn line
  });

  test('room makes floor, ceiling and an air volume', () => {
    const parts = drawRoom('side', { u: 0, v: 0 }, { u: 4, v: 0 }, { ...opts, ceilingHeight: 2.5 });
    expect(parts.map((p) => p.type)).toEqual(['deck', 'deck', 'compartment']);
    const [floor, ceiling] = parts;
    const floorTop = floor.position[1] + floor.size[1] / 2;
    expect(ceiling.position[1] - ceiling.size[1] / 2).toBeCloseTo(floorTop + 2.5);
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
    expect(resolveLayers(s.design)[0].y).toBeCloseTo(3 + f.size[1] / 2);
    s.updatePart(f.id, { position: [0, 5 - f.size[1] / 2, 2] });
    expect(resolveLayers(s.design)[0].y).toBeCloseTo(5);
    s.removeParts([f.id]);
    expect(s.design.layers).toEqual([]);
  });
});

describe('shaped floors', () => {
  test('dragging a corner onto its neighbour turns a square into a triangle', async () => {
    const { deckOutline, withDeckOutline } = await import('../src/core/pens');
    const { dryMass } = await import('../src/core/analysis');
    const [f] = drawFloor('top', { u: 0, v: 0 }, { u: 4, v: 4 }, opts, 1);
    const square = dryMass(f);
    const outline = deckOutline(f);
    outline.splice(2, 1); // drop one corner
    const tri = { ...f, ...withDeckOutline(f, outline) };
    expect(deckOutline(tri)).toHaveLength(3);
    expect(dryMass(tri) / square).toBeCloseTo(0.5, 2);
  });

  test('corners come back in world space after re-centring', async () => {
    const { deckCorners, deckOutline, withDeckOutline } = await import('../src/core/pens');
    const [f] = drawFloor('top', { u: 0, v: 0 }, { u: 4, v: 2 }, opts, 1);
    const outline = deckOutline(f);
    outline.splice(3, 0, [0, 3]); // pull a new corner out of the +z (bow) edge
    const shaped = { ...f, ...withDeckOutline(f, outline) };
    const zs = deckCorners(shaped).map((w) => w[2]);
    expect(Math.max(...zs)).toBeCloseTo(5);
    expect(Math.min(...zs)).toBeCloseTo(0);
  });
});

describe('shaped framing', () => {
  test('a roof sheet can be cut to a point from the top plan', async () => {
    const { deckOutline, facesView, planeToSheetLocal, withDeckOutline, deckCorners } = await import('../src/core/pens');
    const { dryMass } = await import('../src/core/analysis');
    // Roof drawn right-to-left in the side profile, 4 m wide, 6 m long at y = 3.
    const [roof] = drawFraming('side', [{ u: 3, v: 3 }, { u: -3, v: 3 }], opts);
    expect(facesView(roof, 'top')).toBe(true);
    expect(facesView(roof, 'side')).toBe(false);
    const full = dryMass(roof);
    // Pull the two bow corners together at the centre line: a pointed roof.
    const corners = deckCorners(roof);
    const bow = corners.map((w, i) => ({ w, i })).filter(({ w }) => w[2] > 2.9).map(({ i }) => i);
    const outline = deckOutline(roof);
    for (const i of bow) outline[i] = planeToSheetLocal(roof, 'top', { u: 3, v: 0 });
    const pointed = { ...roof, ...withDeckOutline(roof, outline) };
    const ys = deckCorners(pointed).map((w) => w[1]);
    ys.forEach((y) => expect(y).toBeCloseTo(3));
    expect(dryMass(pointed) / full).toBeCloseTo(0.5, 2);
  });

  test('top-plan walls are shaped from the side profile', async () => {
    const { facesView } = await import('../src/core/pens');
    const [wall] = drawFraming('top', [{ u: 0, v: 1 }, { u: 3, v: 1 }], { ...opts, ceilingHeight: 2.4 }, 1);
    expect(facesView(wall, 'side')).toBe(true);
    expect(facesView(wall, 'top')).toBe(false);
  });
});

describe('connections, armor and 3D', () => {
  test('a support started from an indented support keeps that offset', async () => {
    const { drawSupport } = await import('../src/core/pens');
    const parts = drawSupport('side', { u: 0, v: 0 }, { u: 0, v: 2 }, opts, 0, 0.05, { out: 1.2 });
    expect(parts).toHaveLength(2);
    expect(Math.abs(parts[0].position[0])).toBeCloseTo(1.2);
  });

  test('a floor started on a narrower sheet takes its width', async () => {
    const [f] = drawFloor('side', { u: 0, v: 1 }, { u: 3, v: 1 }, opts, 0, { width: 2.5 });
    expect(f.size[0]).toBeCloseTo(2.5);
  });

  test('top-plan beams and pillars', async () => {
    const { drawSupport } = await import('../src/core/pens');
    const [beam] = drawSupport('top', { u: 0, v: 1 }, { u: 4, v: 1 }, opts, 2, 0.05);
    expect(beam.name).toBe('Beam');
    expect(beam.position[1]).toBeLessThan(2); // tucked under the deck
    const [atHeight] = drawSupport('top', { u: 0, v: 1 }, { u: 4, v: 1 }, opts, 2, 0.05, { out: 3.4 });
    expect(atHeight.position[1]).toBeCloseTo(3.4);
    const [pillar] = drawSupport('top', { u: 1, v: 1 }, { u: 1, v: 1 }, { ...opts, ceilingHeight: 2.4 }, 2);
    expect(pillar.name).toBe('Pillar');
    expect(pillar.position[1]).toBeCloseTo(3.2);
  });

  test('armor side choices', async () => {
    const { armorProps } = await import('../src/core/pens');
    expect(armorProps('steel', 'outside')).toEqual({ skinOuter: 'steel', skinInner: 'none' });
    expect(armorProps('steel', 'inside')).toEqual({ skinOuter: 'none', skinInner: 'steel' });
    expect(armorProps('steel', 'both')).toEqual({ skinOuter: 'steel', skinInner: 'steel' });
    expect(armorProps('none', 'both')).toEqual({ skinOuter: 'none', skinInner: 'none' });
  });

  test('3D support runs between two points', async () => {
    const { support3D } = await import('../src/core/pens');
    const s = support3D([0, 0, 0], [1, 2, 2], opts)!;
    const [a, b] = endpoints(s);
    const ends = [a, b].map((w) => w.map((v) => +v.toFixed(3)));
    expect(ends).toContainEqual([0, 0, 0]);
    expect(ends).toContainEqual([1, 2, 2]);
  });

  test('3D framing sheet passes through its corners', async () => {
    const { framePolygon3D, deckCorners } = await import('../src/core/pens');
    const pts: [number, number, number][] = [[2, 0, 0], [2, 0, 3], [2, 2, 3], [2, 2, 0]]; // a side panel at x = 2
    const f = framePolygon3D(pts, opts, [0, 1, 1.5])!;
    const corners = deckCorners(f).map((w) => w.map((v) => +v.toFixed(3)));
    for (const p of pts) expect(corners).toContainEqual(p);
    // Outside faces away from the craft (towards +x).
    expect(f.props.outSign).toBeDefined();
    const n = rotationMatrix(f.rotation);
    expect(n[1] * Number(f.props.outSign)).toBeGreaterThan(0);
  });
});

describe('ramps, ladders and cut-outs', () => {
  test('a ramp joins two floor levels', async () => {
    const { drawRamp } = await import('../src/core/pens');
    const [r] = drawRamp('side', { u: 0, v: 0 }, { u: 4, v: 2 }, opts);
    expect(r.type).toBe('deck');
    const [a, b] = endpoints(r).sort((p, q) => p[1] - q[1]);
    expect(a[1]).toBeCloseTo(0);
    expect(b[1]).toBeCloseTo(2);
    expect(b[2]).toBeCloseTo(4);
  });

  test('stairs climb the right way', async () => {
    const { drawRamp } = await import('../src/core/pens');
    const [s] = drawRamp('side', { u: 4, v: 0 }, { u: 0, v: 2 }, { ...opts, rampStyle: 'stairs' });
    expect(s.type).toBe('stairs');
    expect(s.size[1]).toBeCloseTo(2);
    expect(s.size[2]).toBeCloseTo(4);
    // Local +Z (the climbing direction) points from the low end (u = 4) toward the high end (u = 0).
    const m = rotationMatrix(s.rotation);
    expect(m[8]).toBeLessThan(0);
  });

  test('a ladder stands along the drawn line', async () => {
    const { drawLadder } = await import('../src/core/pens');
    const [l] = drawLadder('side', { u: 1, v: 0 }, { u: 1, v: 3 }, opts);
    expect(l.size[1]).toBeCloseTo(3);
    expect(l.position[1]).toBeCloseTo(1.5);
    expect(Math.abs(l.rotation[0])).toBeCloseTo(0);
  });

  test('cutting a window out of a framing sheet removes its weight', async () => {
    const { sheetHole, holeHitsSheet, windowFor } = await import('../src/core/pens');
    const { dryMass } = await import('../src/core/analysis');
    // A wall drawn in the top plan faces the side profile.
    const [wall] = drawFraming('top', [{ u: 0, v: 1 }, { u: 4, v: 1 }], { ...opts, ceilingHeight: 2.4 }, 0);
    const full = dryMass(wall);
    const hole = sheetHole(wall, 'side', { u: 1, v: 1 }, { u: 2, v: 2 })!;
    expect(hole).not.toBeNull();
    expect(holeHitsSheet(wall, hole)).toBe(true);
    const cut = { ...wall, holes: [hole] };
    // 1 m² out of a 4 × 2.4 m sheet.
    expect(dryMass(cut) / full).toBeCloseTo(1 - 1 / 9.6, 3);
    const win = windowFor(wall, hole, opts);
    expect(win.position[1]).toBeCloseTo(1.5);
    expect(win.position[2]).toBeCloseTo(1.5);
  });

  test('cut-outs mirror onto the twin', () => {
    const s = new Store();
    const [f] = drawFloor('top', { u: 0, v: 1 }, { u: 4, v: 3 }, opts, 0);
    s.addParts([f]);
    s.updatePart(f.id, { holes: [[-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]] });
    const twin = s.twin(s.get(f.id)!)!;
    expect(twin.holes![0][0]).toBeCloseTo(0.5);
  });
});

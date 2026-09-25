import { describe, expect, test } from 'vitest';
import { analyze, dryMass, memberCapacity } from '../src/core/analysis';
import { getDef } from '../src/core/catalog';
import { mirrorTransform, partsTouch, rotationMatrix, shapeVolume } from '../src/core/geometry';
import { wrapHull } from '../src/core/hullwrap';
import { buildContactGraph, buildFluidNetworks } from '../src/core/networks';
import { Store } from '../src/core/store';
import { skyGalleon, submersible, trackedCrawler } from '../src/core/templates';
import { newDesign, type PartInstance } from '../src/core/types';
import { Simulation } from '../src/sim/simulation';

const part = (type: string, position: [number, number, number], extra: Partial<PartInstance> = {}): PartInstance => {
  const d = getDef(type);
  return { id: Math.random().toString(36).slice(2), type, position, rotation: [0, 0, 0], size: [...d.defaultSize], material: d.defaultMaterial, props: { ...(d.defaultProps ?? {}) }, ...extra };
};

describe('geometry', () => {
  test('rotation matrix matches a quarter turn about Y', () => {
    const m = rotationMatrix([0, Math.PI / 2, 0]);
    // (0,0,1) → (1,0,0)
    expect(m[2]).toBeCloseTo(1);
    expect(m[8]).toBeCloseTo(0);
  });

  test('mirror flips x and y/z rotation', () => {
    const m = mirrorTransform([2, 1, 3], [0.1, 0.2, 0.3]);
    expect(m.position).toEqual([-2, 1, 3]);
    expect(m.rotation).toEqual([0.1, -0.2, -0.3]);
  });

  test('oriented boxes: a diagonal beam does not touch a box in its AABB corner', () => {
    const beam = part('beam', [0, 0, 0], { size: [0.1, 0.1, 10], rotation: [0, Math.PI / 4, 0] });
    const box = part('crate', [3, 0, -3], { size: [0.5, 0.5, 0.5] });
    expect(partsTouch(beam, box)).toBe(false);
    const onIt = part('crate', [2, 0, 2], { size: [0.5, 0.5, 0.5] });
    expect(partsTouch(beam, onIt)).toBe(true);
  });

  test('ellipsoid volume', () => {
    expect(shapeVolume('ellipsoid', [2, 2, 2])).toBeCloseTo((4 / 3) * Math.PI);
  });
});

describe('physics', () => {
  test('oak beam mass = volume × density', () => {
    expect(dryMass(part('beam', [0, 0, 0], { size: [0.2, 0.2, 3] }))).toBeCloseTo(0.12 * 700);
  });

  test('hydrogen envelope lifts about 1.1 kg per m³', () => {
    const d = newDesign();
    d.settings.altitude = 0;
    const env = part('envelope', [0, 10, 0], { size: [10, 10, 10] });
    d.parts = [env];
    const a = analyze(d);
    const vol = (Math.PI / 6) * 1000;
    expect(a.gasLiftN / 9.81 / vol).toBeCloseTo(1.225, 2);
  });

  test('steel beam is far stronger than a pine one of the same size', () => {
    const pine = memberCapacity(part('beam', [0, 0, 0], { material: 'pine' }));
    const steel = memberCapacity(part('beam', [0, 0, 0], { material: 'steel' }));
    expect(steel / pine).toBeGreaterThan(10);
  });

  test('parts not touching the frame are flagged', () => {
    const d = newDesign();
    d.parts = [part('keel', [0, 0.3, 0]), part('seat', [0, 1.1, 0]), part('crate', [10, 10, 10])];
    const a = analyze(d);
    expect(a.unsupported).toHaveLength(1);
  });

  test('overloaded beam is detected', () => {
    const d = newDesign();
    const beam = part('beam', [0, 0.1, 0], { size: [0.05, 0.05, 4], material: 'pine' });
    const crate = part('crate', [0, 0.7, 0], { props: { cargo: 5000 } });
    d.parts = [beam, crate];
    const a = analyze(d);
    expect(a.utilization[beam.id]).toBeGreaterThan(1);
  });
});

describe('templates', () => {
  test('sky galleon flies with everything attached', () => {
    const a = analyze(skyGalleon());
    expect(a.netVerticalN).toBeGreaterThan(0);
    expect(a.unsupported).toEqual([]);
    expect(a.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('crawler is supported and on tracks', () => {
    const a = analyze(trackedCrawler());
    expect(a.unsupported).toEqual([]);
    expect(a.groundPressureKPa!).toBeLessThan(100);
  });

  test('submersible is trimmed neutral', () => {
    const a = analyze(submersible());
    expect(Math.abs(a.netVerticalN / 9.81)).toBeLessThan(a.totalMass * 0.02);
    expect(a.crushDepth!).toBeGreaterThan(80);
  });
});

describe('systems & simulation', () => {
  test('galleon gas manifold joins both gasbags and the reservoir', () => {
    const d = skyGalleon();
    const nets = buildFluidNetworks(d.parts, buildContactGraph(d.parts));
    const gas = nets.find((n) => n.fluid === 'hydrogen')!;
    const types = gas.containers.map((id) => d.parts.find((p) => p.id === id)!.type).sort();
    expect(types).toEqual(['envelope', 'envelope', 'gasTank']);
  });

  test('a ruptured gas riser deflates the envelopes and fills the hold with hydrogen', () => {
    const d = skyGalleon();
    const lamp = d.parts.find((p) => p.type === 'lamp')!;
    d.parts = d.parts.filter((p) => p !== lamp); // no ignition source for this test
    const sim = new Simulation(d);
    const riser = d.parts.find((p) => p.name === 'Gas Manifold')!;
    const hold = d.parts.find((p) => p.props.label === 'Crew Hold')!;
    const envelope = d.parts.find((p) => p.type === 'envelope')!;
    const lift0 = sim.state.analysis!.gasLiftN;
    sim.damage(riser.id, 0.8);
    for (let i = 0; i < 1200; i++) sim.step(0.1);
    expect(sim.state.fill[envelope.id]).toBeLessThan(0.8);
    expect(sim.state.analysis!.gasLiftN).toBeLessThan(lift0);
    expect(sim.state.atmos[hold.id].flammable).toBeGreaterThan(0.04);
    expect(sim.state.atmos[hold.id].oxygen).toBeLessThan(0.21);
  });

  test('closing the valves isolates the gasbags from a manifold leak', () => {
    const d = skyGalleon();
    const sim = new Simulation(d);
    for (const v of d.parts.filter((p) => p.type === 'valve')) sim.toggleValve(v.id);
    sim.damage(d.parts.find((p) => p.name === 'Gas Manifold')!.id, 0.8);
    for (let i = 0; i < 100; i++) sim.step(0.1);
    const env = d.parts.find((p) => p.type === 'envelope')!;
    expect(sim.state.fill[env.id]).toBeCloseTo(1);
  });

  test('a lit lamp ignites hydrogen in the hold', () => {
    const d = skyGalleon();
    const sim = new Simulation(d);
    sim.damage(d.parts.find((p) => p.name === 'Gas Manifold')!.id, 0.8);
    for (let i = 0; i < 300; i++) sim.step(0.1);
    const hold = d.parts.find((p) => p.props.label === 'Crew Hold')!;
    expect(sim.state.atmos[hold.id].exploded).toBe(true);
  });

  test('steam leak scalds the compartment', () => {
    const d = newDesign();
    const boiler = part('boiler', [0, 1.1, 0]);
    const pipe = part('pipe', [0, 1.1, 1.7], { size: [0.1, 0.1, 2] });
    const room = part('compartment', [0, 1.2, 1.5], { size: [4, 2.4, 6] });
    d.parts = [boiler, pipe, room];
    const sim = new Simulation(d);
    sim.damage(pipe.id, 1);
    for (let i = 0; i < 200; i++) sim.step(0.1);
    expect(sim.state.atmos[room.id].temperature).toBeGreaterThan(40);
  });
});

describe('store', () => {
  test('mirror mode creates and syncs a twin', () => {
    const s = new Store();
    const p = s.makePart('seat', [1, 0, 0]);
    s.addParts([p]);
    expect(s.design.parts).toHaveLength(2);
    s.updatePart(p.id, { position: [2, 0, 1] });
    const t = s.twin(s.get(p.id)!)!;
    expect(t.position).toEqual([-2, 0, 1]);
    s.undo();
    expect(s.twin(s.get(p.id)!)!.position).toEqual([-1, 0, 0]);
  });

  test('centre-line parts are not mirrored', () => {
    const s = new Store();
    s.addParts([s.makePart('keel', [0, 0, 0])]);
    expect(s.design.parts).toHaveLength(1);
  });

  test('hull wrap encloses the frame', () => {
    const frame = [part('keel', [0, 0, 0]), part('beam', [0, 2, 0], { size: [4, 0.2, 0.2] })];
    const shell = wrapHull(frame)!;
    expect(shell.props.volume as number).toBeGreaterThan(0);
    expect(shell.size[2]).toBeGreaterThan(12);
  });
});

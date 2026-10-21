import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { pathLength, pointAt, bendSegment, arcSegment } from '../src/model/curves';
import { skinPatch, partProxies, obbPenetration } from '../src/model/geometry';
import { boxFrame, cylinderFrame, layStringers, skinBetween, skinHull, makeBeam, refreshDerived } from '../src/model/hull';
import { addTwins, breakSymmetry, family, reflectPart } from '../src/model/mirror';
import { aimAt, applyControl, jointMotion, poseGroups, sampleAnimation, motionWarnings } from '../src/model/rig';
import { Studio } from '../src/model/studio';
import { components } from '../src/model/connections';
import { parseVehicle, serialize } from '../src/model/io';
import { newVehicle, type Vec3 } from '../src/model/types';
import { partMatrix } from '../src/model/math';

const close = (a: Vec3, b: Vec3, eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);

describe('curves', () => {
  it('straight beams are straight and the right length', () => {
    const path = { points: [[0, 0, 0], [0, 0, 4]] as Vec3[] };
    expect(pathLength(path)).toBeCloseTo(4, 5);
    expect(pointAt(path, 0.5)).toEqual([0, 0, 2]);
  });
  it('bending a beam puts its middle where it was dragged', () => {
    const path = bendSegment({ points: [[0, 0, 0], [4, 0, 0]] }, 0, [2, 1, 0]);
    const m = pointAt(path, 0.5);
    expect(close(m, [2, 1, 0], 1e-9)).toBe(true);
    expect(pointAt(path, 0)).toEqual([0, 0, 0]);
    expect(pointAt(path, 1)).toEqual([4, 0, 0]);
  });
  it('a 90° arc preset is close to a true circle', () => {
    const path = arcSegment({ points: [[0, 0, 0], [2, 0, 0]] }, 0, 90, [0, 1, 0]);
    // Chord 2, 90°: radius √2, centre (1, −1, 0).
    for (const t of [0.25, 0.5, 0.75]) {
      const p = pointAt(path, t);
      expect(Math.hypot(p[0] - 1, p[1] + 1)).toBeCloseTo(Math.SQRT2, 3);
    }
  });
  it('multi-point beams pass through every point', () => {
    const path = { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]] as Vec3[], smooth: true };
    for (let i = 0; i < 4; i++) expect(close(pointAt(path, i), path.points[i])).toBe(true);
  });
});

describe('connections and checks', () => {
  it('a box frame is one connected body with no overlaps', () => {
    const s = new Studio(newVehicle());
    s.commit('frame', () => { boxFrame(s.v, [0, 1, 0], [2, 2, 4]); });
    const { graph, warnings } = s.analysis();
    expect(components(s.v, graph)).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
  it('flags a floating part and an overlap', () => {
    const s = new Studio(newVehicle());
    s.commit('frame', () => { boxFrame(s.v, [0, 1, 0], [2, 2, 4]); });
    const plate = s.newPart('plate', [10, 0, 0]);
    s.addParts([plate], 'plate', false);
    // A beam passing through the middle of the box's floor beam, off the grid points.
    const b = makeBeam(s.v, 'beam.square', [[-0.13, 0, -2.9], [-0.13, 0, 3.1]]);
    s.addParts([b], 'beam', false);
    const kinds = s.analysis().warnings.map((w) => w.kind).sort();
    expect(kinds).toContain('floating');
    expect(kinds).toContain('overlap');
  });
  it('only retests pairs touched by an edit', () => {
    const s = new Studio(newVehicle());
    s.commit('frame', () => { boxFrame(s.v, [0, 1, 0], [2, 2, 4]); });
    s.analysis();
    const id = s.v.parts[0].id;
    s.updatePart(id, { params: { w: 0.25, h: 0.25 } });
    s.analysis();
    expect(s.solver.tested).toBeLessThanOrEqual(6);
  });
});

describe('mirroring', () => {
  it('live twins reflect position, paths and follow edits from either side', () => {
    const s = new Studio(newVehicle());
    const b = makeBeam(s.v, 'beam.square', [[1, 0, 0], [3, 1, 2]]);
    const made = s.addParts([b]);
    expect(made).toHaveLength(2);
    const twin = made[1];
    expect(twin.path!.points[1]).toEqual([-3, 1, 2]);
    s.updatePart(twin.id, { path: { points: [[-1, 0, 0], [-4, 1, 2]] } });
    expect(s.get(b.id)!.path!.points[1]).toEqual([4, 1, 2]);
  });
  it('parts on the mirror plane get no twin', () => {
    const s = new Studio(newVehicle());
    const made = s.addParts([s.newPart('plate', [0, 0, 0])]);
    expect(made).toHaveLength(1);
  });
  it('three axes make seven twins', () => {
    const v = newVehicle();
    v.mirror = { x: true, y: true, z: true, origin: [0, 0, 0] };
    const s = new Studio(v);
    const made = s.addParts([s.newPart('greeble', [1, 1, 1])]);
    expect(made).toHaveLength(8);
  });
  it('mirrored shapes are exact reflections, even lopsided ones', () => {
    const v = newVehicle();
    const s = new Studio(v);
    const w = s.newPart('wedge', [2, 0, 1], [0, 30, 0]);
    const t = reflectPart(v, w, 'x');
    const a = new Vector3(0.3, 0.2, 0.4).applyMatrix4(partMatrix(w));
    const b = new Vector3(0.3, 0.2, 0.4).applyMatrix4(partMatrix(t));
    expect(b.x).toBeCloseTo(-a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
  });
  it('breaking symmetry stops a twin following', () => {
    const s = new Studio(newVehicle());
    const p = s.newPart('plate', [2, 0, 0]);
    const [, t] = s.addParts([p]);
    s.commit('break', () => { breakSymmetry(s.v, t.id); });
    s.updatePart(p.id, { position: [3, 0, 0] });
    expect(s.get(t.id)!.position).toEqual([-2, 0, 0]);
    expect(family(s.v, p.id)).toHaveLength(1);
  });
});

describe('hulls', () => {
  it('stringers follow their ribs and skins fill the cells', () => {
    const s = new Studio(newVehicle());
    s.liveMirror = false;
    let parts: ReturnType<typeof cylinderFrame> = [];
    s.commit('cyl', () => { parts = cylinderFrame(s.v, [0, 2, 0], 2, 6, 3, 6); });
    const stringers = parts.filter((p) => p.derived);
    expect(stringers).toHaveLength(6);
    let skins: ReturnType<typeof skinHull> = [];
    s.commit('skin', () => { skins = skinHull(s.v, stringers[0].id); });
    expect(skins).toHaveLength(12);
    for (const k of skins) expect(skinPatch(s.v, k)).not.toBeNull();
    // Reshape a rib: stringers move with it.
    const rib = parts[0];
    const before = JSON.stringify(stringers[1].path);
    s.updatePart(rib.id, { path: { ...rib.path!, points: rib.path!.points.map((p) => [p[0] * 1.5, p[1], p[2]] as Vec3) } });
    expect(JSON.stringify(s.get(stringers[1].id)!.path)).not.toEqual(before);
  });
  it('skins between four beams', () => {
    const v = newVehicle();
    const bs = [makeBeam(v, 'beam.square', [[0, 0, 0], [2, 0, 0]]), makeBeam(v, 'beam.square', [[2, 0, 0], [2, 0, 2]]),
      makeBeam(v, 'beam.square', [[0, 0, 2], [2, 0, 2]]), makeBeam(v, 'beam.square', [[0, 0, 0], [0, 0, 2]])];
    v.parts.push(...bs);
    const sk = skinBetween(v, bs.map((b) => b.id))!;
    const patch = skinPatch(v, sk)!;
    expect(patch.area).toBeCloseTo(4, 5);
  });
  it('stringers through twin ribs are mirrored', () => {
    const s = new Studio(newVehicle());
    const ribs = [0, 4].map((z) => makeBeam(s.v, 'beam.square', [[0, 2, z], [1.5, 1, z], [1, 0, z]]));
    const made = s.addParts(ribs);
    expect(made).toHaveLength(4);
    let st: ReturnType<typeof layStringers> = [];
    s.commit('st', () => { st = layStringers(s.v, ribs.map((r) => r.id), 3); for (const x of [...st]) addTwins(s.v, x); });
    refreshDerived(s.v);
    const twins = s.v.parts.filter((p) => p.derived && p.mirror);
    expect(twins.length).toBeGreaterThan(0);
    const t = twins[0];
    const src = s.get(t.mirror!.source)!;
    expect(close(t.path!.points[0], [-src.path!.points[0][0], src.path!.points[0][1], src.path!.points[0][2]])).toBe(true);
  });
});

describe('joints', () => {
  function turretRig() {
    const v = newVehicle();
    v.mirror.x = false;
    const s = new Studio(v);
    s.liveMirror = false;
    const deck = s.newPart('plate', [0, 0, 0]);
    deck.params = { w: 4, l: 4, t: 0.2 };
    const ring = s.newPart('turret', [0, 0.225, 0]);
    ring.params = { r: 0.75, h: 0.25 };
    const hinge = s.newPart('hinge', [0, 0.5, 0]);
    hinge.params = { s: 0.5 };
    const gun = makeBeam(v, 'beam.round', [[0, 0.75, -0.25], [0, 0.75, 2]]);
    gun.params = { w: 0.2 };
    s.addParts([deck, ring, hinge, gun]);
    return { s, deck, ring, hinge, gun };
  }
  it('splits rigid groups at joints and chains them', () => {
    const { s, deck, ring, hinge, gun } = turretRig();
    const { rig } = s.analysis();
    const gDeck = rig.groupOf.get(deck.id)!, gGun = rig.groupOf.get(gun.id)!;
    expect(gDeck).not.toEqual(gGun);
    expect(rig.joints.get(ring.id)!.locked).toBe(false);
    expect(rig.joints.get(hinge.id)!.locked).toBe(false);
    expect(rig.order.indexOf(ring.id)).toBeLessThan(rig.order.indexOf(hinge.id));
  });
  it('turning the ring swings the gun; aim points it at a target', () => {
    const { s, ring, gun } = turretRig();
    const { rig } = s.analysis();
    s.v.jointValues[ring.id] = [90];
    const m = poseGroups(s.v, rig)[rig.groupOf.get(gun.id)!];
    const tip = new Vector3(0, 0.75, 2).applyMatrix4(m);
    expect(tip.x).toBeCloseTo(2, 5);
    expect(tip.z).toBeCloseTo(0, 5);
    s.v.controls.push({ id: 'c1', name: 'Aim', value: 0, min: -180, max: 180, aim: true, links: [{ joint: ring.id, ratio: 1, offset: 0 }] });
    aimAt(s.v, rig, [-5, 0.75, 0]);
    const m2 = poseGroups(s.v, rig)[rig.groupOf.get(gun.id)!];
    const tip2 = new Vector3(0, 0.75, 2).applyMatrix4(m2);
    expect(tip2.x).toBeCloseTo(-2, 4);
  });
  it('a mirrored hinge turns the opposite way', () => {
    const v = newVehicle();
    const s = new Studio(v);
    const h = s.newPart('hinge', [2, 0, 0]);
    const [, t] = s.addParts([h]);
    const p = new Vector3(2, 1, 1);
    const pt = new Vector3(-2, 1, 1);
    // Rotate both by the same value: results should be reflections of each other.
    const a = p.clone().applyMatrix4(jointMotion(s.v, s.get(h.id)!, [30]));
    const b = pt.clone().applyMatrix4(jointMotion(s.v, s.get(t.id)!, [30]));
    expect(b.x).toBeCloseTo(-a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
  });
  it('controls drive linked joints with ratios; animations blend poses', () => {
    const { s, ring } = turretRig();
    s.v.controls.push({ id: 'c', name: 'Dial', value: 0, min: -90, max: 90, links: [{ joint: ring.id, ratio: -2, offset: 10 }] });
    applyControl(s.v, 'c', 20);
    expect(s.v.jointValues[ring.id][0]).toBe(-30);
    s.v.poses.push({ id: 'a', name: 'A', values: { [ring.id]: [0] } }, { id: 'b', name: 'B', values: { [ring.id]: [90] } });
    const anim = { id: 'x', name: 'Swing', duration: 2, loop: true, smooth: false, keys: [{ time: 0, pose: 'a' }, { time: 1, pose: 'b' }] };
    expect(sampleAnimation(s.v, anim, 0.5)![ring.id][0]).toBeCloseTo(45);
    expect(sampleAnimation(s.v, anim, 1.5)![ring.id][0]).toBeCloseTo(45);
  });
  it('motion check finds a gun that hits the deck', () => {
    const { s, hinge } = turretRig();
    s.updatePart(hinge.id, { joint: { type: 'hinge', min: -90, max: 90, rest: 0 } });
    const { rig, graph } = s.analysis();
    const w = motionWarnings(s.v, rig, graph, s.solver);
    expect(w.some((x) => x.kind === 'motion')).toBe(true);
  });
});

describe('history and files', () => {
  it('undo, redo and jumping to any step', () => {
    const s = new Studio(newVehicle());
    s.addParts([s.newPart('plate', [0, 0, 0])]);
    s.addParts([s.newPart('plate', [0, 0, 2])]);
    expect(s.v.parts).toHaveLength(2);
    s.undo();
    expect(s.v.parts).toHaveLength(1);
    s.redo();
    expect(s.v.parts).toHaveLength(2);
    s.jumpTo(0);
    expect(s.v.parts).toHaveLength(0);
  });
  it('round-trips through JSON', () => {
    const s = new Studio(newVehicle('Test'));
    s.commit('frame', () => { boxFrame(s.v, [0, 1, 0], [2, 2, 2]); });
    const back = parseVehicle(serialize(s.v))!;
    expect(back.name).toBe('Test');
    expect(back.parts).toHaveLength(12);
    expect(parseVehicle('{"nope":1}')).toBeNull();
  });
  it('proxies of a beam are long thin boxes', () => {
    const v = newVehicle();
    const b = makeBeam(v, 'beam.square', [[0, 0, 0], [0, 0, 2]]);
    const px = partProxies(b, v);
    expect(px).toHaveLength(1);
    expect(obbPenetration(px[0].obb, px[0].obb)).toBeGreaterThan(0);
  });
});

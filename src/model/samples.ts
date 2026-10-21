import { getDef } from './catalog';
import { boxFrame, layStringers, makeBeam, skinBetween, skinHull } from './hull';
import { addTwins, family } from './mirror';
import { Studio } from './studio';
import { newId, newVehicle, type Part, type Vec3, type Vehicle } from './types';

/**
 * Sample vehicles from the spec: a walker with a stride cycle, a battleship
 * whose turrets all track one aim control, and a buggy that steers.
 * They're built through the same calls the editor uses.
 */

function part(s: Studio, def: string, position: Vec3, params: Record<string, number> = {}, extra: Partial<Part> = {}): Part {
  const p = s.newPart(def, position);
  p.params = { ...p.params, ...params };
  Object.assign(p, extra);
  return p;
}

/** The part plus its live twins, added in one go. */
function put(s: Studio, p: Part): Part[] {
  s.v.parts.push(p);
  return [p, ...addTwins(s.v, p)];
}

function twinOf(v: Vehicle, p: Part): Part | undefined {
  return family(v, p.id).find((x) => x.id !== p.id);
}

function skinFaces(s: Studio, beams: Part[], faces: [number, number, number, number][]) {
  for (const f of faces) {
    const sk = skinBetween(s.v, f.map((i) => beams[i].id), 0.04, 'hullgrey');
    if (sk) sk.material = 'hullgrey';
  }
}

// ── Walker ──────────────────────────────────────────────────────────────────

function walker(): Vehicle {
  const v = newVehicle('Walker AT-6');
  v.grid = { major: 1, minor: 0.05 };
  v.notes = 'Four-legged assault walker. Each leg is a hip, knee and ankle hinge. Try Controls → Timeline → Play.';
  const s = new Studio(v);
  s.liveMirror = true;
  // Body: a box frame skinned on top, sides and ends.
  const body = boxFrame(v, [0, 6, 0], [4, 2.5, 8], 'beam.square');
  for (const b of body) b.material = 'darksteel';
  // boxFrame order: 4 along X (y,z = ±), 4 along Y (x,z), 4 along Z (x,y).
  // Faces: top [2,3,9,11], left [4,5,8,9], right [6,7,10,11], back [0,2,4,6]; the front gets a plate.
  skinFaces(s, body, [[2, 3, 9, 11], [4, 5, 8, 9], [6, 7, 10, 11], [0, 2, 4, 6]]);
  for (const p of v.parts) if (p.surface) p.material = 'olive';
  // Front plate and head.
  put(s, part(s, 'plate', [0, 6, 4.15], { w: 4.2, l: 2.6, t: 0.1 }, { rotation: [90, 0, 0], material: 'olive' }));
  put(s, part(s, 'cylinder', [0, 6, 5.2], { r: 0.8, l: 2 }, { material: 'olive', name: 'Head' }));
  put(s, part(s, 'canopy', [0, 6.95, 5.4], { w: 0.9, h: 0.3, l: 1.2 }, { name: 'Viewport' }));
  for (const x of [0.3]) put(s, makeBeam(v, 'beam.round', [[x, 5.125, 5.6], [x, 5.125, 7.6]], { name: 'Chin gun', material: 'gunmetal' }));
  // One side's legs; the mirror builds the other.
  const legs: { hip: Part; knee: Part; ankle: Part }[] = [];
  for (const z of [3, -3]) {
    const hip = part(s, 'hinge', [2, 4.5, z], { s: 0.5 }, { name: z > 0 ? 'Front hip' : 'Rear hip', joint: { type: 'hinge', min: -45, max: 45, rest: 0 } });
    const knee = part(s, 'hinge', [2, 2.35, z], { s: 0.5 }, { name: z > 0 ? 'Front knee' : 'Rear knee', joint: { type: 'hinge', min: -60, max: 60, rest: 0 } });
    const ankle = part(s, 'hinge', [2, 0.45, z], { s: 0.5 }, { name: z > 0 ? 'Front ankle' : 'Rear ankle', joint: { type: 'hinge', min: -40, max: 40, rest: 0 } });
    put(s, hip);
    put(s, makeBeam(v, 'beam.ibeam', [[2, 4.35, z], [2, 2.5, z]], { name: 'Thigh', material: 'darksteel' }));
    put(s, knee);
    put(s, makeBeam(v, 'beam.ibeam', [[2, 2.2, z], [2, 0.6, z]], { name: 'Shin', material: 'darksteel' }));
    put(s, ankle);
    put(s, part(s, 'plate', [2, 0.25, z], { w: 1, l: 1.2, t: 0.1 }, { name: 'Foot', material: 'gunmetal' }));
    legs.push({ hip, knee, ankle });
  }
  v.parts.push(part(s, 'figure', [3.5, 0, 0], { h: 1.8 }, { name: 'Crew (scale)' }));
  // Poses: stand, two halves of a stride, and kneel.
  const all = (f: (leg: typeof legs[number], side: number, front: boolean) => [number, number, number]) => {
    const out: Record<string, number[]> = {};
    legs.forEach((leg, i) => {
      for (const side of [1, -1]) {
        const pick = (p: Part) => (side === 1 ? p : twinOf(v, p)!);
        const [a, b, c] = f(leg, side, i === 0);
        out[pick(leg.hip).id] = [a];
        out[pick(leg.knee).id] = [b];
        out[pick(leg.ankle).id] = [c];
      }
    });
    return out;
  };
  const stand = { id: newId('pose'), name: 'Stand', values: all(() => [0, 0, 0]) };
  // Diagonal pairs step together: front-left with rear-right.
  const strideA = { id: newId('pose'), name: 'Stride A', values: all((_, side, front) => ((side === 1) === front ? [-22, 30, -8] : [18, -6, -12])) };
  const strideB = { id: newId('pose'), name: 'Stride B', values: all((_, side, front) => ((side === 1) === front ? [18, -6, -12] : [-22, 30, -8])) };
  const kneel = { id: newId('pose'), name: 'Kneel', values: all((_, __, front) => (front ? [-35, 55, -20] : [0, 0, 0])) };
  v.poses.push(stand, strideA, strideB, kneel);
  v.animations.push({ id: newId('anim'), name: 'Walk cycle', duration: 2, loop: true, smooth: true, keys: [{ time: 0, pose: strideA.id }, { time: 1, pose: strideB.id }] });
  return v;
}

// ── Battleship ─────────────────────────────────────────────────────────────

function battleship(): Vehicle {
  const v = newVehicle('Battleship Resolute');
  v.grid = { major: 5, minor: 0.5 };
  v.notes = 'Ribs and stringers plated as one hull. Three turrets on rings, guns on hinges, all on one aim control: choose the Aim tool and click the sea.';
  const s = new Studio(v);
  const H = 8;
  const half = (z: number) => Math.max(1.5, 12 * (1 - Math.pow(Math.max(0, z - 2) / 50, 2)) - (z < -30 ? (-(z) - 30) * 0.15 : 0));
  const stations = [-40, -25, -10, 5, 20, 35, 48];
  const ribs: Part[] = [];
  const deck: Part[] = [];
  for (const z of stations) {
    const w = half(z);
    const keel = z > 40 ? 3 : 0;
    const r = makeBeam(v, 'beam.channel', [[0, keel, z], [w * 0.85, H * 0.3 + keel * 0.5, z], [w, H, z]], { name: `Rib ${ribs.length + 1}`, material: 'navygrey' });
    r.params = { w: 0.4, h: 0.6 };
    ribs.push(...put(s, r).slice(0, 1));
    const d = makeBeam(v, 'beam.ibeam', [[-w, H, z], [w, H, z]], { name: 'Deck beam', material: 'navygrey' });
    d.params = { w: 0.4, h: 0.6 };
    v.parts.push(d);
    deck.push(d);
  }
  const st = layStringers(v, ribs.map((r) => r.id), 5, 'beam.channel');
  for (const x of st) { x.params = { w: 0.4, h: 0.6 }; x.material = 'navygrey'; }
  for (const x of [...st]) addTwins(v, x);
  s.commit('build', () => {});
  const skins = skinHull(v, st[0].id, 0.08, 'navygrey');
  for (const k of [...skins]) addTwins(v, k);
  // Deck plates between the deck beams and the top stringers.
  const top = st[st.length - 1], topTwin = twinOf(v, top)!;
  for (let k = 0; k + 1 < deck.length; k++) {
    v.parts.push({
      id: newId(), def: 'skin', params: { t: 0.1 }, position: [0, 0, 0], rotation: [0, 0, 0], material: 'tan', layer: 'plating', name: 'Deck',
      surface: { side: 1, thickness: 0.1, edges: [
        { part: deck[k].id, t0: 0, t1: 1 }, { part: top.id, t0: k, t1: k + 1 }, { part: deck[k + 1].id, t0: 1, t1: 0 }, { part: topTwin.id, t0: k + 1, t1: k },
      ] },
    });
  }
  // Superstructure and funnel.
  v.parts.push(part(s, 'greeble', [0, H + 0.3 + 3, -10], { w: 6, h: 6, l: 8 }, { name: 'Bridge tower', material: 'navygrey' }));
  v.parts.push(part(s, 'cylinder', [0, H + 6.3 + 2, -12], { r: 1.2, l: 4 }, { rotation: [90, 0, 0], name: 'Funnel', material: 'gunmetal' }));
  // Turrets: ring → housing → gun hinge → barrels.
  const aim = { id: newId('c'), name: 'Main battery', value: 0, min: -180, max: 180, aim: true, links: [] as { joint: string; ratio: number; offset: number }[] };
  const turret = (z: number, name: string, dir: 1 | -1, min: number, max: number) => {
    const ring = part(s, 'turret', [0, H + 0.3 + 0.2, z], { r: 3, h: 0.4 }, { name: `${name} ring`, joint: { type: 'turret', min, max, rest: 0, continuous: false } });
    const house = part(s, 'greeble', [0, H + 0.7 + 1, z], { w: 5, h: 2, l: 6 }, { name: `${name} housing`, material: 'navygrey' });
    const hinge = part(s, 'hinge', [0, H + 2.7 + 0.45, z + 2 * dir], { s: 1.5 }, { name: `${name} guns`, rotation: [0, dir > 0 ? 0 : 180, 0], joint: { type: 'hinge', min: -30, max: 5, rest: 0 } });
    v.parts.push(ring, house, hinge);
    for (const x of [-0.4, 0.4]) {
      const b = makeBeam(v, 'beam.round', [[x, H + 3.6 + 0.25, z + 1.5 * dir], [x, H + 3.6 + 0.25, z + 12 * dir]], { name: `${name} barrel`, material: 'gunmetal' });
      b.params = { w: 0.5 };
      v.parts.push(b);
    }
    aim.links.push({ joint: ring.id, ratio: 1, offset: 0 }, { joint: hinge.id, ratio: 1, offset: 0 });
  };
  turret(20, 'A turret', 1, -150, 150);
  turret(5, 'B turret', 1, -135, 135);
  turret(-25, 'Y turret', -1, -135, 135);
  v.controls.push(aim);
  return v;
}

// ── Buggy ───────────────────────────────────────────────────────────────────

function buggy(): Vehicle {
  const v = newVehicle('Desert buggy');
  v.grid = { major: 0.5, minor: 0.05 };
  v.notes = 'Steer control: the front wheels are linked with opposite ratios because a mirrored wheel turns the other way.';
  const s = new Studio(v);
  const frame = boxFrame(v, [0, 0.6, 0], [1.6, 0.4, 3], 'beam.square');
  for (const b of frame) { b.params = { w: 0.12, h: 0.12 }; b.material = 'tan'; }
  v.parts.push(part(s, 'plate', [0, 0.48, 0], { w: 1.72, l: 3.12, t: 0.04 }, { name: 'Floor pan', material: 'darksteel' }));
  // Roll cage.
  const cage: Vec3[][] = [[[0.8, 0.8, -0.3], [0.7, 1.7, -0.1], [-0.7, 1.7, -0.1], [-0.8, 0.8, -0.3]], [[0.8, 0.8, 0.9], [0.6, 1.5, 0.5], [-0.6, 1.5, 0.5], [-0.8, 0.8, 0.9]]];
  for (const pts of cage) { const b = makeBeam(v, 'beam.round', pts, { name: 'Roll bar', material: 'red' }); b.params = { w: 0.08 }; b.path!.smooth = true; v.parts.push(b); }
  put(s, part(s, 'greeble', [0.35, 0.7, 0.1], { w: 0.5, h: 0.4, l: 0.5 }, { name: 'Seat', material: 'carbon' }));
  put(s, part(s, 'greeble', [0, 0.7, -1.05], { w: 1, h: 0.4, l: 0.7 }, { name: 'Engine', material: 'gunmetal' }));
  // Wheels on axles; the mirror adds the other side.
  const wheels: Part[] = [];
  for (const z of [1.1, -1.1]) {
    put(s, makeBeam(v, 'beam.round', [[0.8, 0.4, z], [1.07, 0.4, z]], { name: 'Axle', material: 'steel', params: { w: 0.1 } }));
    const w = part(s, 'wheel', [1.1, 0.4, z], { r: 0.4, w: 0.3 }, { name: z > 0 ? 'Front wheel' : 'Rear wheel', joint: { type: 'wheel', min: z > 0 ? -30 : 0, max: z > 0 ? 30 : 0, rest: 0, continuous: true } });
    put(s, w);
    wheels.push(w);
  }
  put(s, part(s, 'light', [0.5, 0.8, 1.64], { r: 0.08 }, { name: 'Headlight' }));
  v.parts.push(part(s, 'figure', [-1.6, 0, 0.4], { h: 1.8 }, { name: 'Driver (scale)' }));
  const fl = wheels[0], fr = twinOf(v, fl)!;
  v.controls.push({ id: newId('c'), name: 'Steer', value: 0, min: -30, max: 30, links: [{ joint: fl.id, dof: 1, ratio: 1, offset: 0 }, { joint: fr.id, dof: 1, ratio: -1, offset: 0 }] });
  void getDef;
  return v;
}

export const SAMPLES: { id: string; name: string; description: string; make: () => Vehicle }[] = [
  { id: 'walker', name: 'Walker', description: 'Four legs of hip, knee and ankle hinges, with stand, stride and kneel poses and a walk cycle.', make: walker },
  { id: 'battleship', name: 'Battleship', description: 'Ribs, stringers and a plated hull; three turrets linked to one aim control.', make: battleship },
  { id: 'buggy', name: 'Buggy', description: 'A small frame on four wheels with a linked steering control.', make: buggy },
];

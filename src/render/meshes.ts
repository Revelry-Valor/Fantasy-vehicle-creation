import * as THREE from 'three';
import { getDef, getMaterial } from '../model/catalog';
import { frames, samplePath } from '../model/curves';
import { beamSize, sectionProfile, skinPatch } from '../model/geometry';
import type { Material, Part, Vehicle } from '../model/types';

/**
 * Meshes for every part type, built from parameters. Shapes are built in the
 * part's local frame; beams and skins are built in world space because their
 * shape comes from their path or boundary beams.
 */

// ── Materials ───────────────────────────────────────────────────────────────

const matCache = new Map<string, THREE.MeshStandardMaterial>();
const matSource = new WeakMap<THREE.Material, Material>();
const texLoader = new THREE.TextureLoader();
let clipPlanes: THREE.Plane[] = [];

/** Section view: clip every part material by these planes. */
export function setClipPlanes(planes: THREE.Plane[]) {
  clipPlanes = planes;
  for (const m of matCache.values()) { m.clippingPlanes = planes.length ? planes : null; m.needsUpdate = true; }
}

/** Re-tint every mesh under an object (selection, warnings, hover). */
export function retint(o: THREE.Object3D, tint: Parameters<typeof materialFor>[1]) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    const src = matSource.get(m.material as THREE.Material);
    if (src) m.material = materialFor(src, tint);
  });
}

export function materialFor(m: Material, tint: 'none' | 'selected' | 'warning' | 'hover' | 'ghost' | 'ghostBad' = 'none'): THREE.MeshStandardMaterial {
  const key = `${m.id}|${m.color}|${m.finish}|${m.texture ? m.texture.length : 0}|${tint}`;
  let mat = matCache.get(key);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(m.color) });
  switch (m.finish) {
    case 'metal': mat.metalness = 0.75; mat.roughness = 0.38; break;
    case 'glass': mat.metalness = 0.1; mat.roughness = 0.05; mat.transparent = true; mat.opacity = 0.38; mat.depthWrite = false; break;
    case 'emissive': mat.emissive = new THREE.Color(m.color); mat.emissiveIntensity = 1.6; mat.roughness = 0.4; break;
    default: mat.metalness = 0.05; mat.roughness = 0.78;
  }
  if (m.texture) {
    const t = texLoader.load(m.texture);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    mat.map = t;
  }
  if (tint === 'selected') { mat.emissive = new THREE.Color(0x2a6fff); mat.emissiveIntensity = 0.55; }
  if (tint === 'hover') { mat.emissive = new THREE.Color(0x3a5070); mat.emissiveIntensity = 0.5; }
  if (tint === 'warning') { mat.emissive = new THREE.Color(0xff2a1a); mat.emissiveIntensity = 0.6; }
  if (tint === 'ghost' || tint === 'ghostBad') {
    mat.transparent = true;
    mat.opacity = 0.55;
    mat.depthWrite = false;
    mat.emissive = new THREE.Color(tint === 'ghost' ? 0x2a8f5a : 0xff2020);
    mat.emissiveIntensity = 0.7;
  }
  mat.side = THREE.DoubleSide;
  mat.userData.cached = true;
  if (clipPlanes.length) mat.clippingPlanes = clipPlanes;
  matCache.set(key, mat);
  matSource.set(mat, m);
  return mat;
}

// ── Shared shape geometry ───────────────────────────────────────────────────

const geoCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.cached = true; geoCache.set(key, g); }
  return g;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  return cached(`box|${w}|${h}|${d}|${x}|${y}|${z}`, () => new THREE.BoxGeometry(w, h, d).translate(x, y, z));
}

/** Cylinder along an axis. */
function cyl(r1: number, r2: number, l: number, axis: 'x' | 'y' | 'z', seg = 32, x = 0, y = 0, z = 0) {
  return cached(`cyl|${r1}|${r2}|${l}|${axis}|${seg}|${x}|${y}|${z}`, () => {
    const g = new THREE.CylinderGeometry(r2, r1, l, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    return g.translate(x, y, z);
  });
}

export interface PartMeshes {
  /** The whole part, or a joint's fixed half. */
  main: THREE.Object3D;
  /** A joint's moving half. */
  head?: THREE.Object3D;
  /** Thruster exhaust, shown during playback. */
  effect?: THREE.Object3D;
  /** True when the mesh is built in world space (beams, skins). */
  world: boolean;
}

function group(...parts: [THREE.BufferGeometry, THREE.Material][]): THREE.Group {
  const g = new THREE.Group();
  for (const [geo, mat] of parts) g.add(new THREE.Mesh(geo, mat));
  return g;
}

function darker(m: Material, k = 0.55): Material {
  const c = new THREE.Color(m.color).multiplyScalar(k);
  return { ...m, id: `${m.id}~d${k}`, color: `#${c.getHexString()}` };
}

/** Build the meshes for one part. */
export function buildPart(v: Vehicle, p: Part, tint: Parameters<typeof materialFor>[1] = 'none'): PartMeshes {
  const def = getDef(p.def, v);
  const M = getMaterial(p.material, v);
  const mat = materialFor(M, tint);
  const dark = materialFor(darker(M), tint);
  const steel = materialFor(getMaterial('darksteel'), tint);
  const P = p.params;
  if (def.kind === 'beam') return { main: new THREE.Mesh(beamGeometry(p), mat), world: true };
  if (def.kind === 'skin') {
    const g = skinGeometry(v, p);
    return { main: g ? new THREE.Mesh(g, mat) : new THREE.Group(), world: true };
  }
  switch (def.shape) {
    case 'plate': return { main: group([box(P.w, P.t, P.l), mat]), world: false };
    case 'wedge': return { main: group([cached(`wedge|${P.w}|${P.h}|${P.l}`, () => wedge(P.w, P.h, P.l)), mat]), world: false };
    case 'cylinder': return { main: group([cyl(P.r, P.r, P.l, 'z', 40), mat]), world: false };
    case 'cone': return { main: group([cyl(P.r1, P.r2, P.l, 'z', 40), mat]), world: false };
    case 'hullPanel': return { main: group([cached(`panel|${P.r}|${P.a}|${P.l}|${P.t}`, () => hullPanel(P.r, P.a, P.l, P.t)), mat]), world: false };
    case 'hinge': {
      const s = P.s;
      return {
        main: group([box(s, s * 0.3, s * 0.4, 0, -s * 0.15, 0), dark], [cyl(s * 0.12, s * 0.12, s * 1.04, 'x', 20), steel]),
        head: group([box(s * 0.9, s * 0.3, s * 0.4, 0, s * 0.15, 0), mat], [cyl(s * 0.14, s * 0.14, s * 0.5, 'x', 20), mat]),
        world: false,
      };
    }
    case 'turret': {
      const r = P.r, h = P.h;
      return {
        main: group([cyl(r, r, h / 2, 'y', 48, 0, -h / 4, 0), dark]),
        head: group([cyl(r * 0.94, r * 0.94, h / 2, 'y', 48, 0, h / 4, 0), mat], [box(r * 0.16, h * 0.52, r * 0.12, 0, h / 4, r * 0.9), steel]),
        world: false,
      };
    }
    case 'ball': {
      const r = P.r;
      return {
        main: group([cyl(r * 1.1, r * 0.8, r * 1.1, 'y', 32, 0, -r * 0.85, 0), dark]),
        head: group([cached(`sphere|${r}`, () => new THREE.SphereGeometry(r, 32, 20)), mat], [cyl(r * 0.5, r * 0.5, r * 0.9, 'y', 20, 0, r * 0.95, 0), mat]),
        world: false,
      };
    }
    case 'piston': {
      const l = P.l, r = P.r;
      return {
        main: group([cyl(r, r, l * 0.6, 'y', 24, 0, -l * 0.2, 0), dark]),
        head: group([cyl(r * 0.55, r * 0.55, l * 0.7, 'y', 20, 0, l * 0.15, 0), mat], [cyl(r * 0.9, r * 0.9, r * 0.6, 'x', 20, 0, l * 0.5 - r * 0.3, 0), steel]),
        world: false,
      };
    }
    case 'wheel': {
      const r = P.r, w = P.w;
      const head = group([cyl(r, r, w, 'x', 48), mat], [cyl(r * 0.62, r * 0.62, w * 1.02, 'x', 32), materialFor(getMaterial('steel'), tint)], [cyl(r * 0.2, r * 0.2, w * 1.1, 'x', 16), steel]);
      // Spokes show the wheel turning.
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(box(w * 1.04, r * 0.08, r * 1.1), steel);
        s.rotation.x = (i / 5) * Math.PI;
        head.add(s);
      }
      return { main: group([cyl(r * 0.15, r * 0.15, w * 0.2, 'x', 12), steel]), head, world: false };
    }
    case 'door': {
      const { w, h, t } = P as Record<string, number>;
      return {
        main: group([box(w * 0.04, h, t * 1.4, -w / 2 - w * 0.02, 0, 0), dark]),
        head: group([box(w, h, t), mat], [box(w * 0.6, h * 0.12, t * 1.1, 0, h * 0.25, 0), materialFor(getMaterial('glass'), tint)]),
        world: false,
      };
    }
    case 'thruster': {
      const r = P.r, l = P.l;
      const bell = cached(`bell|${r}|${l}`, () => {
        const pts: THREE.Vector2[] = [];
        for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push(new THREE.Vector2(r * (0.35 + 0.65 * u * u), -l / 2 + u * l * 0.55)); }
        const g = new THREE.LatheGeometry(pts, 40);
        g.rotateX(Math.PI / 2);
        g.scale(1, 1, -1);
        return g;
      });
      const plume = new THREE.Mesh(cyl(r * 0.95, r * 0.2, l * 1.6, 'z', 24, 0, 0, -l / 2 - l * 0.8 + l * 0.1),
        new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      plume.visible = false;
      const g = group([bell, dark], [cyl(r * 0.45, r * 0.45, l * 0.5, 'z', 32, 0, 0, l * 0.25), mat]);
      g.add(plume);
      return { main: g, effect: plume, world: false };
    }
    case 'light': return { main: group([cached(`sphere|${P.r}`, () => new THREE.SphereGeometry(P.r, 24, 16)), mat], [cyl(P.r * 0.7, P.r * 0.7, P.r * 0.4, 'y', 16, 0, -P.r * 0.9, 0), steel]), world: false };
    case 'canopy': return {
      main: group([cached(`canopy|${P.w}|${P.h}|${P.l}`, () => new THREE.SphereGeometry(0.5, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2).scale(P.w, P.h * 2, P.l).translate(0, -P.h / 2, 0)), mat],
        [box(P.w * 1.02, P.h * 0.08, P.l * 1.02, 0, -P.h / 2 + P.h * 0.04, 0), steel]),
      world: false,
    };
    case 'greeble': {
      const { w, h, l } = P as Record<string, number>;
      const g = group([box(w, h, l), mat], [box(w * 0.7, h * 0.3, l * 0.3, 0, h * 0.62, -l * 0.2), dark]);
      for (let i = 0; i < 4; i++) g.add(new THREE.Mesh(box(w * 0.5, h * 0.06, l * 0.05, 0, h * 0.53, l * (0.1 + i * 0.1)), dark));
      return { main: g, world: false };
    }
    case 'bolt': return { main: group([cyl(P.r, P.r, P.r * 0.5, 'y', 6), mat]), world: false };
    case 'figure': {
      const h = P.h;
      const k = h / 1.8;
      const g = group(
        [box(0.13 * k, 0.85 * k, 0.16 * k, -0.1 * k, 0.425 * k, 0), mat], [box(0.13 * k, 0.85 * k, 0.16 * k, 0.1 * k, 0.425 * k, 0), mat],
        [box(0.42 * k, 0.62 * k, 0.24 * k, 0, 1.15 * k, 0), mat],
        [box(0.1 * k, 0.6 * k, 0.12 * k, -0.27 * k, 1.12 * k, 0), mat], [box(0.1 * k, 0.6 * k, 0.12 * k, 0.27 * k, 1.12 * k, 0), mat],
        [cached(`fighead|${k}`, () => new THREE.SphereGeometry(0.12 * k, 20, 14).translate(0, 1.62 * k, 0)), mat],
      );
      return { main: g, world: false };
    }
    default: return { main: group([box(1, 1, 1), mat]), world: false };
  }
}

function wedge(w: number, h: number, l: number) {
  const s = new THREE.Shape();
  s.moveTo(-l / 2, -h / 2);
  s.lineTo(l / 2, -h / 2);
  s.lineTo(-l / 2, h / 2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

function hullPanel(r: number, aDeg: number, l: number, t: number) {
  const a = Math.min(359, aDeg) * (Math.PI / 180);
  const ro = r + t / 2, ri = Math.max(0.001, r - t / 2);
  const n = Math.max(8, Math.ceil(aDeg / 3));
  const s = new THREE.Shape();
  for (let i = 0; i <= n; i++) { const f = -a / 2 + (a * i) / n; const x = ro * Math.sin(f), y = ro * Math.cos(f); if (i === 0) s.moveTo(x, y); else s.lineTo(x, y); }
  for (let i = n; i >= 0; i--) { const f = -a / 2 + (a * i) / n; s.lineTo(ri * Math.sin(f), ri * Math.cos(f)); }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: l, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -l / 2);
  g.computeVertexNormals();
  return g;
}

/** Sweep the beam's section along its path. Flat sides stay crisp; round beams are smooth. */
export function beamGeometry(p: Part): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  if (!p.path || p.path.points.length < 2) return geo;
  const { w, h, section } = beamSize(p);
  const prof = sectionProfile(section, w, h);
  const s = samplePath(p.path, 24);
  const fr = frames(s);
  const closed = !!p.path.closed;
  if (closed && fr.length > 2) fr.pop();
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const round = section === 'round';
  const at = (k: number, x: number, y: number) => {
    const f = fr[k];
    return [f.p[0] + f.b[0] * x + f.n[0] * y, f.p[1] + f.b[1] * x + f.n[1] * y, f.p[2] + f.b[2] * x + f.n[2] * y];
  };
  const dirAt = (k: number, x: number, y: number) => {
    const f = fr[k];
    return [f.b[0] * x + f.n[0] * y, f.b[1] * x + f.n[1] * y, f.b[2] * x + f.n[2] * y];
  };
  const rows = closed ? fr.length + 1 : fr.length;
  const K = (k: number) => (closed ? k % fr.length : k);
  const np = prof.length;
  if (round) {
    for (let k = 0; k < rows; k++) for (let i = 0; i <= np; i++) {
      const [x, y] = prof[i % np];
      pos.push(...at(K(k), x, y));
      const d = dirAt(K(k), x, y);
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      nor.push(d[0] / l, d[1] / l, d[2] / l);
    }
    for (let k = 0; k + 1 < rows; k++) for (let i = 0; i < np; i++) {
      const a = k * (np + 1) + i, b = a + 1, c = a + np + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  } else {
    for (let i = 0; i < np; i++) {
      const [x0, y0] = prof[i], [x1, y1] = prof[(i + 1) % np];
      const ex = x1 - x0, ey = y1 - y0;
      const el = Math.hypot(ex, ey) || 1;
      const nx = ey / el, ny = -ex / el;
      const base = pos.length / 3;
      for (let k = 0; k < rows; k++) {
        pos.push(...at(K(k), x0, y0), ...at(K(k), x1, y1));
        const d = dirAt(K(k), nx, ny);
        nor.push(...d, ...d);
      }
      for (let k = 0; k + 1 < rows; k++) {
        const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  if (!closed) {
    // End caps.
    const tris = THREE.ShapeUtils.triangulateShape(prof.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const [k, sgn] of [[0, -1], [fr.length - 1, 1]] as const) {
      const base = pos.length / 3;
      const t = fr[k].t;
      for (const [x, y] of prof) { pos.push(...at(k, x, y)); nor.push(t[0] * sgn, t[1] * sgn, t[2] * sgn); }
      for (const [a, b, c] of tris) idx.push(...(sgn > 0 ? [base + a, base + b, base + c] : [base + a, base + c, base + b]));
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

/** A skin plate: outer and inner faces of its Coons patch, with the edges closed off. */
export function skinGeometry(v: Vehicle, p: Part): THREE.BufferGeometry | null {
  const patch = skinPatch(v, p);
  if (!patch) return null;
  const { outer, inner } = patch;
  const rows = outer.length, cols = outer[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (grid: typeof outer) => { const base = pos.length / 3; for (const r of grid) for (const q of r) pos.push(...q); return base; };
  const o = push(outer), i0 = push(inner);
  for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < cols; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    idx.push(o + a, o + b, o + d, o + a, o + d, o + c);
    idx.push(i0 + a, i0 + d, i0 + b, i0 + a, i0 + c, i0 + d);
  }
  // Edge walls.
  const ring: number[] = [];
  for (let i = 0; i < cols; i++) ring.push(i);
  for (let j = 1; j < rows; j++) ring.push(j * cols + cols - 1);
  for (let i = cols - 2; i >= 0; i--) ring.push((rows - 1) * cols + i);
  for (let j = rows - 2; j > 0; j--) ring.push(j * cols);
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    idx.push(o + a, i0 + a, o + b, o + b, i0 + a, i0 + b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function disposeObject(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.cached) m.geometry.dispose();
  });
}

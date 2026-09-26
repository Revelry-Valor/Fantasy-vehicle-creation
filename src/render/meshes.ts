import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { getDef } from '../core/catalog';
import { getFluid } from '../core/fluids';
import { getMaterial } from '../core/materials';
import type { PartInstance } from '../core/types';

/**
 * Procedural meshes for every catalogue shape.
 *
 * Most builders work in a unit box ([-0.5, 0.5]³) and the "body" group is then
 * scaled to the part's size. Builders where stretching would look wrong
 * (ladders, trusses, tracks, chains…) build at real size instead.
 */

export interface AnimHandle {
  kind: 'door' | 'hatch' | 'ramp' | 'bayDoors' | 'lift' | 'winch' | 'turret' | 'spin' | 'envelope';
  nodes: THREE.Object3D[];
  /** Current animated value 0..1. */
  value: number;
}

export interface PartObject {
  root: THREE.Group;
  body: THREE.Group;
  anim?: AnimHandle;
  mats: THREE.MeshStandardMaterial[];
}

type Mats = {
  main: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  fluid: THREE.MeshStandardMaterial;
};

function std(color: number, metalness = 0, roughness = 0.8, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
}

function makeMats(p: PartInstance): Mats {
  const m = getMaterial(p.material);
  const fluid = getFluid(String(p.props.fluid ?? ''));
  return {
    main: std(m.color, m.metalness, m.roughness, m.transparent ? { transparent: true, opacity: 0.45 } : {}),
    dark: std(0x2a2a2e, 0.6, 0.6),
    metal: std(0x8a8f96, 0.8, 0.4),
    brass: std(0xc9a23e, 0.9, 0.3),
    cloth: std(0xe8dcc0, 0, 1, { side: THREE.DoubleSide }),
    glass: std(0x9fd6e8, 0.1, 0.05, { transparent: true, opacity: 0.35 }),
    glow: std(0xffe7a0, 0, 0.5, { emissive: 0x000000 }),
    skin: std(0xd9a57b, 0, 0.9),
    fluid: std(fluid?.color ?? 0x888888, 0.2, 0.5),
  };
}

// ── Primitive helpers ────────────────────────────────────────────────────────
function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  return mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
}
/** Cylinder along an axis. */
function cyl(r: number, len: number, mat: THREE.Material, axis: 'x' | 'y' | 'z' = 'y', x = 0, y = 0, z = 0, seg = 20, r2 = r) {
  const m = mesh(new THREE.CylinderGeometry(r, r2, len, seg), mat, x, y, z);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  return m;
}
function sphere(r: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  return mesh(new THREE.SphereGeometry(r, 20, 14), mat, x, y, z);
}
/** A pivot group placed at (x,y,z) so children rotate around that point. */
function pivot(x: number, y: number, z: number, ...children: THREE.Object3D[]) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  for (const c of children) {
    c.position.x -= x; c.position.y -= y; c.position.z -= z;
    g.add(c);
  }
  return g;
}

// ── Builders ─────────────────────────────────────────────────────────────────
type Built = { group: THREE.Group; unit: boolean; anim?: AnimHandle };

function unit(...children: THREE.Object3D[]): Built {
  const g = new THREE.Group();
  g.add(...children);
  return { group: g, unit: true };
}
function real(...children: THREE.Object3D[]): Built {
  const g = new THREE.Group();
  g.add(...children);
  return { group: g, unit: false };
}

function airfoilShape(): THREE.Shape {
  const s = new THREE.Shape();
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = t;
    const yt = 5 * 0.9 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    if (i === 0) s.moveTo(0.5 - x, yt * 0.5);
    else s.lineTo(0.5 - x, yt * 0.5);
  }
  for (let i = 24; i >= 0; i--) {
    const x = i / 24;
    const yt = 5 * 0.9 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    s.lineTo(0.5 - x, -yt * 0.3);
  }
  return s;
}

function boatHullGeometry(): THREE.BufferGeometry {
  const stations = 24, ring = 16;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const z = -0.5 + i / stations;
    const t = (z + 0.5); // 0 stern → 1 bow
    // Beam tapers to a point at the bow and to a transom at the stern.
    const bowTaper = t > 0.6 ? Math.sqrt(Math.max(0, 1 - ((t - 0.6) / 0.4) ** 2)) : 1;
    const sternTaper = 0.75 + 0.25 * Math.min(1, t / 0.3);
    const halfBeam = 0.5 * bowTaper * sternTaper;
    const depth = 1 * (0.85 + 0.15 * Math.sin(Math.PI * t));
    for (let j = 0; j <= ring; j++) {
      const a = (j / ring) * Math.PI; // 0 = port gunwale, π = starboard gunwale
      const x = -Math.cos(a) * Math.max(halfBeam, 0.002);
      const y = 0.5 - depth * Math.pow(Math.sin(a), 0.6);
      pos.push(x, y, z);
    }
  }
  for (let i = 0; i < stations; i++) for (let j = 0; j < ring; j++) {
    const a = i * (ring + 1) + j, b = a + ring + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  // Transom
  const base = pos.length / 3;
  pos.push(0, 0.5, -0.5);
  for (let j = 0; j < ring; j++) idx.push(base, j + 1, j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function build(p: PartInstance, M: Mats): Built {
  const def = getDef(p.type);
  const [W, H, D] = p.size;
  const state = Number(p.props.state ?? 0);
  switch (def.shape) {
    case 'box': return unit(box(1, 1, 1, M.main));
    case 'tube': {
      const g = unit(cyl(0.5, 1, M.main, 'z', 0, 0, 0, 16));
      if (def.container) g.group.add(cyl(0.505, 0.04, M.fluid, 'z', 0, 0, 0.3, 16), cyl(0.505, 0.04, M.fluid, 'z', 0, 0, -0.3, 16));
      return g;
    }
    case 'cylinderY': return unit(cyl(0.5, 1, M.main, 'y'), cyl(0.505, 0.04, M.fluid, 'y', 0, 0.3, 0));
    case 'capsule': {
      const g = new THREE.Group();
      const m = mesh(new THREE.CapsuleGeometry(0.5, Math.max(0.01, D / Math.max(W, H) - 1), 8, 20), M.main);
      m.rotation.x = Math.PI / 2;
      m.scale.set(1, 1 / (D / Math.max(W, H)), 1);
      g.add(m);
      if (def.container) g.add(cyl(0.505, 0.03, M.fluid, 'z', 0, 0, 0.3, 16));
      return { group: g, unit: true };
    }
    case 'ellipsoid': {
      const skin = mesh(new THREE.SphereGeometry(0.5, 40, 24), M.main);
      const seams = new THREE.Group();
      // Meridian seams running nose to tail, plus a couple of girth bands.
      for (let i = 0; i < 6; i++) {
        const holder = new THREE.Group();
        const t = mesh(new THREE.TorusGeometry(0.502, 0.002, 4, 64), M.dark);
        t.rotation.y = Math.PI / 2;
        holder.rotation.z = (i / 6) * Math.PI;
        holder.add(t);
        seams.add(holder);
      }
      for (const z of [-0.25, 0.25]) {
        const r = Math.sqrt(0.25 - z * z) + 0.002;
        seams.add(mesh(new THREE.TorusGeometry(r, 0.002, 4, 64), M.dark, 0, 0, z));
      }
      const g = unit(skin, seams);
      g.anim = { kind: 'envelope', nodes: [g.group], value: 1 };
      return g;
    }
    case 'rib': {
      const t = Math.min(D, 0.3);
      const s = new THREE.Shape();
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const a = Math.PI + (i / n) * Math.PI;
        const x = (W / 2) * Math.cos(a), y = H / 2 + H * Math.sin(a);
        if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
      }
      for (let i = n; i >= 0; i--) {
        const a = Math.PI + (i / n) * Math.PI;
        s.lineTo((W / 2 - t) * Math.cos(a), H / 2 + (H - t) * Math.sin(a));
      }
      const geo = new THREE.ExtrudeGeometry(s, { depth: D, bevelEnabled: false });
      geo.translate(0, 0, -D / 2);
      return real(mesh(geo, M.main));
    }
    case 'truss': {
      const g = new THREE.Group();
      const r = Math.min(W, H) * 0.06;
      const cx = W / 2 - r, cy = H / 2 - r;
      for (const [x, y] of [[-cx, -cy], [cx, -cy], [-cx, cy], [cx, cy]]) g.add(cyl(r, D, M.main, 'z', x, y, 0, 8));
      const bays = Math.max(1, Math.round(D / Math.max(W, H)));
      const bay = D / bays;
      const brace = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
        const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2);
        const len = a.distanceTo(b);
        const m = mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, len, 6), M.main);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        g.add(m);
      };
      for (let i = 0; i < bays; i++) {
        const z1 = -D / 2 + i * bay, z2 = z1 + bay;
        const flip = i % 2 ? -1 : 1;
        brace(-cx, -cy * flip, z1, -cx, cy * flip, z2);
        brace(cx, -cy * flip, z1, cx, cy * flip, z2);
        brace(-cx * flip, cy, z1, cx * flip, cy, z2);
        brace(-cx * flip, -cy, z1, cx * flip, -cy, z2);
      }
      return real(g);
    }
    case 'hullShell': {
      const pts: THREE.Vector3[] = [];
      const arr = p.points ?? [];
      for (let i = 0; i + 2 < arr.length; i += 3) pts.push(new THREE.Vector3(arr[i], arr[i + 1], arr[i + 2]));
      if (pts.length < 4) return unit(box(1, 1, 1, M.main));
      M.main.side = THREE.DoubleSide;
      return real(mesh(new ConvexGeometry(pts), M.main));
    }
    case 'frame': {
      const g = new THREE.Group();
      const rail = Math.min(0.15, Math.max(0.05, W * 0.04));
      g.add(box(rail, H, D, M.main, -W / 2 + rail / 2, 0, 0), box(rail, H, D, M.main, W / 2 - rail / 2, 0, 0));
      const ties = Math.floor(D) + 1;
      for (let i = 0; i < ties; i++) {
        const z = ties === 1 ? 0 : -D / 2 + 0.04 + (i / (ties - 1)) * (D - 0.08);
        g.add(box(W - 2 * rail, H * 0.6, 0.08, M.main, 0, 0, z));
      }
      const t = Number(p.props.skinThickness ?? 0.03);
      const s = Number(p.props.outSign ?? 1) >= 0 ? 1 : -1;
      for (const [key, side] of [['skinOuter', s], ['skinInner', -s]] as const) {
        const matId = String(p.props[key] ?? 'none');
        if (matId === 'none') continue;
        const sm = getMaterial(matId);
        const mat = std(sm.color, sm.metalness, sm.roughness, sm.transparent ? { transparent: true, opacity: 0.45 } : {});
        mat.userData.skin = true;
        g.add(box(W, t, D, mat, 0, side * (H / 2 + t / 2), 0));
      }
      return real(g);
    }
    case 'profile': {
      const pts = p.points ?? [];
      const shape = new THREE.Shape();
      for (let i = 0; i + 2 < pts.length; i += 3) {
        if (i === 0) shape.moveTo(pts[i + 2], pts[i + 1]);
        else shape.lineTo(pts[i + 2], pts[i + 1]);
      }
      const t = Number(p.props.thickness ?? 0.02);
      const g = new THREE.Group();
      if (pts.length >= 9) {
        for (const side of [1, -1]) {
          const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
          geo.rotateY(-Math.PI / 2);
          geo.translate(side > 0 ? W / 2 + t : -W / 2, 0, 0);
          g.add(mesh(geo, M.main));
        }
      }
      M.main.userData.skin = true;
      return real(g);
    }
    case 'boatHull': {
      M.main.side = THREE.DoubleSide;
      const hull = mesh(boatHullGeometry(), M.main);
      const rail = box(0.02, 0.03, 0.9, M.dark, -0.49, 0.5, -0.05);
      const rail2 = rail.clone(); rail2.position.x = 0.49;
      return unit(hull, rail, rail2);
    }
    case 'wing': {
      const geo = new THREE.ExtrudeGeometry(airfoilShape(), { depth: 1, bevelEnabled: false });
      geo.translate(0, 0, -0.5);
      const m = mesh(geo, M.main);
      m.rotation.y = Math.PI / 2; // chord along Z, span along X
      return unit(m);
    }
    case 'fin': {
      const s = new THREE.Shape();
      s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(0.1, 0.5); s.lineTo(-0.5, 0.5); s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
      geo.translate(0, 0, -0.5);
      const m = mesh(geo, M.main);
      m.rotation.y = Math.PI / 2;
      return unit(m);
    }
    case 'propeller':
    case 'screw': {
      const spin = new THREE.Group();
      const blades = def.shape === 'screw' ? 4 : 3;
      spin.add(cyl(0.08, 0.9, M.metal, 'z'));
      for (let i = 0; i < blades; i++) {
        const b = box(0.12, 0.46, 0.08, M.main, 0, 0.26, 0);
        const holder = new THREE.Group();
        b.rotation.y = 0.5;
        holder.add(b);
        holder.rotation.z = (i / blades) * Math.PI * 2;
        spin.add(holder);
      }
      const g = unit(spin);
      g.anim = { kind: 'spin', nodes: [spin], value: 0 };
      return g;
    }
    case 'engine': {
      const g = unit(
        box(0.9, 0.55, 0.9, M.main, 0, -0.2, 0),
        box(1, 0.08, 1, M.dark, 0, -0.46, 0),
        cyl(0.12, 0.35, M.metal, 'y', -0.2, 0.25, -0.25), cyl(0.12, 0.35, M.metal, 'y', 0.2, 0.25, -0.25),
        cyl(0.12, 0.35, M.metal, 'y', -0.2, 0.25, 0.2), cyl(0.12, 0.35, M.metal, 'y', 0.2, 0.25, 0.2),
      );
      const fly = cyl(0.35, 0.08, M.dark, 'z', 0, -0.1, 0.48, 24);
      const spin = new THREE.Group(); spin.position.set(0, -0.1, 0.48); fly.position.set(0, 0, 0); spin.add(fly);
      g.group.add(spin);
      g.anim = { kind: 'spin', nodes: [spin], value: 0 };
      return g;
    }
    case 'sail': {
      const mast = cyl(0.25, 1, M.dark.clone(), 'y', 0, 0, 0.42, 10);
      (mast.material as THREE.MeshStandardMaterial).color.set(0x6b4a2a);
      const geo = new THREE.PlaneGeometry(1, 0.8, 8, 8);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) + 0.5, v = pos.getY(i) / 0.8 + 0.5;
        pos.setZ(i, Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.35);
      }
      geo.computeVertexNormals();
      const sail = mesh(geo, M.cloth);
      sail.rotation.y = Math.PI / 2;
      sail.scale.set(0.8, 1, 1);
      sail.position.set(0, 0.05, -0.05);
      M.cloth.color.set(getMaterial(p.material).color);
      const yard = cyl(0.15, 0.95, M.dark, 'z', 0, 0.45, -0.02, 8);
      const boom = cyl(0.15, 0.95, M.dark, 'z', 0, -0.35, -0.02, 8);
      return unit(mast, sail, yard, boom);
    }
    case 'nozzle': {
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        pts.push(new THREE.Vector2(0.15 + 0.35 * t * t, -0.5 + t * 0.8));
      }
      const bell = mesh(new THREE.LatheGeometry(pts, 24), M.main);
      (bell.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      bell.rotation.x = -Math.PI / 2;
      const chamber = cyl(0.2, 0.3, M.metal, 'z', 0, 0, 0.35);
      return unit(bell, chamber);
    }
    case 'crystal': {
      const c = mesh(new THREE.OctahedronGeometry(0.45, 0), std(0xb070ff, 0.1, 0.1, { emissive: 0x5020a0, emissiveIntensity: 0.8, transparent: true, opacity: 0.85 }));
      c.scale.set(0.8, 1, 0.8);
      c.position.y = 0.05;
      return unit(c, cyl(0.5, 0.12, M.brass, 'y', 0, -0.44, 0, 8), cyl(0.3, 0.12, M.brass, 'y', 0, 0.44, 0, 8));
    }
    case 'wheel': {
      const tire = mesh(new THREE.TorusGeometry(0.36, 0.14, 12, 32), M.main);
      tire.rotation.y = Math.PI / 2;
      tire.scale.set(1, 1, 3.3);
      const spin = new THREE.Group();
      spin.add(tire, cyl(0.25, 0.9, M.metal, 'x', 0, 0, 0, 20), cyl(0.07, 1, M.dark, 'x'));
      const g = unit(spin);
      g.anim = { kind: 'spin', nodes: [spin], value: 0 };
      return g;
    }
    case 'track': {
      const g = new THREE.Group();
      const r = H / 2;
      const straight = Math.max(0.01, D - 2 * r);
      const tread = M.main;
      g.add(box(W, 0.06, straight, tread, 0, r - 0.03, 0), box(W, 0.06, straight, tread, 0, -r + 0.03, 0));
      for (const z of [straight / 2, -straight / 2]) {
        const end = mesh(new THREE.CylinderGeometry(r, r, W, 20, 1, true, z > 0 ? 0 : Math.PI, Math.PI), tread);
        end.rotation.z = Math.PI / 2;
        end.position.z = z;
        (end.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
        g.add(end);
      }
      const wheels = Math.max(2, Math.round(straight / (r * 1.1)) + 1);
      for (let i = 0; i < wheels; i++) {
        const z = -straight / 2 + (i / (wheels - 1)) * straight;
        g.add(cyl(r * 0.78, W * 0.7, M.dark, 'x', 0, 0, z, 16));
      }
      g.add(box(W * 0.3, r, straight, M.dark, 0, 0, 0));
      // Grousers
      const n = Math.floor(straight / 0.25);
      for (let i = 0; i < n; i++) g.add(box(W * 1.02, 0.05, 0.08, M.dark, 0, -r, -straight / 2 + (i + 0.5) * (straight / n)));
      return real(g);
    }
    case 'leg': {
      const hip = sphere(0.22, M.dark, 0, 0.4, 0);
      const thigh = box(0.3, 0.5, 0.3, M.main, 0, 0.18, 0.12); thigh.rotation.x = 0.4;
      const knee = sphere(0.18, M.dark, 0, -0.05, 0.22);
      const shin = box(0.25, 0.45, 0.25, M.main, 0, -0.25, 0.1); shin.rotation.x = -0.35;
      const foot = box(0.9, 0.1, 0.95, M.dark, 0, -0.47, 0);
      return unit(hip, thigh, knee, shin, foot);
    }
    case 'crew': {
      const cloth = std(0x3a5a8a, 0, 0.9);
      const legL = box(0.28, 0.46, 0.5, M.dark, -0.18, -0.26, 0), legR = legL.clone(); legR.position.x = 0.18;
      const torso = box(0.8, 0.32, 0.8, cloth, 0, 0.13, 0);
      const armL = box(0.18, 0.3, 0.45, cloth, -0.5, 0.12, 0), armR = armL.clone(); armR.position.x = 0.5;
      const head = sphere(0.24, M.skin, 0, 0.4, 0); head.scale.set(1, 0.42, 1.4);
      return unit(legL, legR, torso, armL, armR, head);
    }
    case 'seat': return unit(box(1, 0.1, 1, M.main, 0, -0.05, 0), box(1, 0.55, 0.12, M.main, 0, 0.22, -0.44),
      ...[[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].map(([x, z]) => box(0.1, 0.45, 0.1, M.main, x, -0.28, z)));
    case 'bench': return unit(box(1, 0.1, 1, M.main, 0, -0.05, 0), box(1, 0.45, 0.12, M.main, 0, 0.27, -0.44),
      box(0.06, 0.45, 0.9, M.main, -0.45, -0.28, 0), box(0.06, 0.45, 0.9, M.main, 0.45, -0.28, 0));
    case 'bed': return unit(box(1, 0.5, 1, M.main, 0, -0.25, 0), box(0.94, 0.35, 0.96, M.cloth, 0, 0.17, 0), box(0.6, 0.15, 0.18, std(0xffffff), 0, 0.42, -0.38));
    case 'bunk': {
      const mat = std(0xd8d0c0, 0, 1);
      return unit(
        box(1, 0.06, 1, M.main, 0, -0.3, 0), box(0.94, 0.08, 0.96, mat, 0, -0.23, 0),
        box(1, 0.06, 1, M.main, 0, 0.2, 0), box(0.94, 0.08, 0.96, mat, 0, 0.27, 0),
        ...[[-0.47, -0.47], [0.47, -0.47], [-0.47, 0.47], [0.47, 0.47]].map(([x, z]) => box(0.06, 1, 0.04, M.main, x, 0, z)),
      );
    }
    case 'table': return unit(box(1, 0.08, 1, M.main, 0, 0.46, 0),
      ...[[-0.44, -0.4], [0.44, -0.4], [-0.44, 0.4], [0.44, 0.4]].map(([x, z]) => box(0.06, 0.92, 0.08, M.main, x, 0, z)));
    case 'lavatory': {
      const bowl = cyl(0.35, 0.55, std(0xf2f2ee, 0.1, 0.2), 'y', 0, -0.2, 0.1, 20, 0.25);
      return unit(bowl, box(0.8, 0.45, 0.25, M.main, 0, 0.2, -0.37), box(0.7, 0.04, 0.6, std(0x333333), 0, 0.09, 0.1));
    }
    case 'stove': return unit(box(1, 0.9, 1, M.main, 0, -0.05, 0), box(1, 0.05, 1, M.dark, 0, 0.42, 0), cyl(0.07, 0.6, M.dark, 'y', 0.35, 0.7, -0.35));
    case 'helm': {
      const wheel = new THREE.Group();
      wheel.add(mesh(new THREE.TorusGeometry(0.35, 0.03, 8, 32), M.main));
      for (let i = 0; i < 8; i++) {
        const s = box(0.02, 0.9, 0.02, M.main); s.rotation.z = (i / 8) * Math.PI; wheel.add(s);
      }
      wheel.position.set(0, 0.1, 0.3);
      return unit(box(0.3, 0.9, 0.3, M.main, 0, -0.1, -0.1), wheel, cyl(0.1, 0.4, M.brass, 'z', 0, 0.1, 0.15));
    }
    case 'ladder': {
      const g = new THREE.Group();
      g.add(box(0.05, H, 0.05, M.main, -W / 2 + 0.025, 0, 0), box(0.05, H, 0.05, M.main, W / 2 - 0.025, 0, 0));
      const n = Math.floor(H / 0.3);
      for (let i = 0; i < n; i++) g.add(cyl(0.02, W, M.main, 'x', 0, -H / 2 + 0.15 + i * 0.3, 0, 6));
      return real(g);
    }
    case 'stairs': {
      const g = new THREE.Group();
      const n = Math.max(2, Math.round(H / 0.19));
      for (let i = 0; i < n; i++) {
        const y = -H / 2 + (i + 0.5) * (H / n);
        const z = -D / 2 + (i + 0.5) * (D / n);
        g.add(box(W, 0.04, D / n + 0.05, M.main, 0, y, z));
      }
      const len = Math.hypot(H, D);
      for (const x of [-W / 2, W / 2]) {
        const s = box(0.05, 0.25, len, M.main, x, 0, 0);
        s.rotation.x = -Math.atan2(H, D);
        g.add(s);
      }
      return real(g);
    }
    case 'railing': {
      const g = new THREE.Group();
      const n = Math.max(2, Math.round(D / 1) + 1);
      for (let i = 0; i < n; i++) g.add(box(W, H, W, M.main, 0, 0, -D / 2 + (i / (n - 1)) * D));
      g.add(box(W * 1.4, 0.06, D, M.main, 0, H / 2 - 0.03, 0), box(W, 0.04, D, M.main, 0, 0, 0));
      return real(g);
    }
    case 'cannon': {
      const barrel = cyl(0.2, 1, M.main, 'z', 0, 0.22, 0.05, 20, 0.28);
      const carriage = box(0.9, 0.35, 0.6, std(0x5a3a22), 0, -0.2, -0.15);
      const wheels = [-0.45, 0.45].flatMap((x) => [0.1, -0.35].map((z) => cyl(0.18, 0.08, M.dark, 'x', x, -0.32, z, 16)));
      return unit(barrel, carriage, ...wheels);
    }
    case 'ballista': {
      const arms = box(1, 0.08, 0.08, M.main, 0, 0.2, 0.2);
      const rail = box(0.1, 0.08, 1, M.main, 0, 0.1, 0);
      const bolt = cyl(0.02, 0.9, M.metal, 'z', 0, 0.18, 0.05, 6);
      const stand = box(0.3, 0.6, 0.3, M.main, 0, -0.2, 0);
      const base = box(0.6, 0.1, 0.6, M.main, 0, -0.45, 0);
      return unit(arms, rail, bolt, stand, base);
    }
    case 'turret': {
      const top = new THREE.Group();
      top.add(box(0.85, 0.45, 0.85, M.main, 0, 0.15, 0), cyl(0.07, 0.7, M.dark, 'z', -0.12, 0.2, 0.7, 12), cyl(0.07, 0.7, M.dark, 'z', 0.12, 0.2, 0.7, 12));
      const g = unit(cyl(0.5, 0.35, M.dark, 'y', 0, -0.32, 0, 24), top);
      g.anim = { kind: 'turret', nodes: [top], value: state };
      return g;
    }
    case 'mount': return unit(cyl(0.2, 1, M.main, 'y', 0, 0, 0, 12), cyl(0.5, 0.08, M.main, 'y', 0, -0.46, 0, 12), sphere(0.3, M.dark, 0, 0.5, 0));
    case 'gun': return unit(box(0.8, 0.6, 0.35, M.main, 0, 0, -0.15), cyl(0.12, 0.65, M.dark, 'z', 0, 0.05, 0.3, 10), box(0.4, 0.5, 0.2, M.dark, 0, -0.1, -0.42));
    case 'crate': {
      const g = unit(box(0.96, 0.96, 0.96, M.main));
      for (const [x, z] of [[-0.48, -0.48], [0.48, -0.48], [-0.48, 0.48], [0.48, 0.48]]) g.group.add(box(0.08, 1, 0.08, M.dark, x, 0, z));
      return g;
    }
    case 'barrel': {
      const pts = [];
      for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2(0.42 + 0.08 * Math.sin(Math.PI * t), -0.5 + t)); }
      const g = unit(mesh(new THREE.LatheGeometry(pts, 20), M.main), cyl(0.43, 0.01, M.main, 'y', 0, 0.5, 0));
      for (const y of [-0.35, 0.35]) g.group.add(cyl(0.49, 0.05, M.dark, 'y', 0, y, 0));
      return g;
    }
    case 'door': {
      const slab = box(1, 1, 1, M.main, 0, 0, 0);
      const knob = box(0.06, 0.03, 1.8, M.brass, 0.38, 0, 0);
      const leaf = pivot(-0.5, 0, 0, slab, knob);
      const g = unit(leaf);
      g.anim = { kind: 'door', nodes: [leaf], value: state };
      return g;
    }
    case 'porthole': {
      const ring = mesh(new THREE.TorusGeometry(0.42, 0.08, 10, 28), M.main);
      const glass = cyl(0.4, 0.3, M.glass, 'z', 0, 0, 0, 24);
      return unit(ring, glass);
    }
    case 'hatch': {
      const leaf = pivot(0, 0, -0.5, box(1, 1, 1, M.main), box(0.3, 0.4, 0.05, M.brass, 0, 0.6, 0.3));
      const g = unit(leaf);
      g.anim = { kind: 'hatch', nodes: [leaf], value: state };
      return g;
    }
    case 'ramp': {
      const leaf = pivot(0, -0.5, 0, box(1, 1, 1, M.main));
      for (let i = 0; i < 6; i++) leaf.add(box(0.95, 0.03, 1.4, M.dark, 0, -0.35 + i * 0.15, 0.1));
      const g = unit(leaf);
      g.anim = { kind: 'ramp', nodes: [leaf], value: state };
      return g;
    }
    case 'bayDoors': {
      const l = pivot(-0.5, 0, 0, box(0.5, 1, 1, M.main, -0.25, 0, 0));
      const r = pivot(0.5, 0, 0, box(0.5, 1, 1, M.main, 0.25, 0, 0));
      const g = unit(l, r);
      g.anim = { kind: 'bayDoors', nodes: [l, r], value: state };
      return g;
    }
    case 'valve': {
      const open = p.props.open !== false;
      const handle = mesh(new THREE.TorusGeometry(0.3, 0.05, 6, 16), std(open ? 0x3aa655 : 0xd03030, 0.3, 0.5));
      handle.rotation.x = Math.PI / 2;
      handle.position.y = 0.4;
      return unit(cyl(0.35, 1, M.main, 'z', 0, 0, 0, 12), cyl(0.05, 0.4, M.metal, 'y', 0, 0.2, 0), handle);
    }
    case 'lamp': return unit(cyl(0.45, 0.15, M.main, 'y', 0, 0.42, 0, 12), sphere(0.32, M.glow, 0, 0, 0),
      ...[0, 1, 2, 3].map((i) => { const b = box(0.04, 0.8, 0.04, M.main, Math.cos(i * Math.PI / 2) * 0.35, 0, Math.sin(i * Math.PI / 2) * 0.35); return b; }));
    case 'generator': return unit(cyl(0.42, 0.8, M.main, 'z', 0, 0.05, 0, 20), box(0.9, 0.12, 0.9, M.dark, 0, -0.44, 0),
      cyl(0.44, 0.12, M.brass, 'z', 0, 0.05, 0.25, 20), cyl(0.44, 0.12, M.brass, 'z', 0, 0.05, -0.25, 20), cyl(0.08, 0.3, M.metal, 'z', 0, 0.05, 0.5));
    case 'battery': return unit(box(1, 0.85, 1, M.main, 0, -0.07, 0), box(1.01, 0.1, 1.01, std(0x40c0ff, 0, 0.3, { emissive: 0x2080ff, emissiveIntensity: 0.6 }), 0, 0, 0),
      cyl(0.08, 0.15, M.dark, 'y', -0.25, 0.45, 0), cyl(0.08, 0.15, std(0xc03030), 'y', 0.25, 0.45, 0));
    case 'boiler': return unit(cyl(0.48, 0.75, M.main, 'y', 0, 0.05, 0), sphere(0.48, M.main, 0, 0.42, 0), box(0.9, 0.3, 0.9, M.dark, 0, -0.35, 0),
      box(0.3, 0.18, 0.05, std(0xff6a20, 0, 0.5, { emissive: 0xff4400, emissiveIntensity: 1 }), 0, -0.35, 0.46), cyl(0.06, 0.3, M.brass, 'y', 0.25, 0.6, 0));
    case 'lift': {
      const g = new THREE.Group();
      for (const [x, z] of [[-0.48, -0.48], [0.48, -0.48], [-0.48, 0.48], [0.48, 0.48]]) g.add(box(0.04, 1, 0.04, M.main, x, 0, z));
      g.add(box(1, 0.03, 1, M.main, 0, 0.485, 0));
      const plat = new THREE.Group();
      plat.add(box(0.94, 0.04, 0.94, M.dark), box(0.94, 0.2, 0.02, M.metal, 0, 0.12, -0.46));
      g.add(plat);
      const b: Built = { group: g, unit: true };
      b.anim = { kind: 'lift', nodes: [plat], value: state };
      return b;
    }
    case 'winch': {
      const g = new THREE.Group();
      g.add(box(0.08, H, D, M.dark, -W / 2 + 0.04, 0, 0), box(0.08, H, D, M.dark, W / 2 - 0.04, 0, 0), box(W, 0.08, D, M.dark, 0, -H / 2 + 0.04, 0));
      g.add(cyl(H * 0.3, W - 0.16, M.main, 'x', 0, 0.05, 0, 20));
      const chain = new THREE.Group();
      const linkGeo = new THREE.TorusGeometry(0.05, 0.015, 6, 10);
      const maxLen = Number(p.props.chainLength ?? 10);
      const links = Math.min(400, Math.ceil(maxLen / 0.08));
      for (let i = 0; i < links; i++) {
        const l = mesh(linkGeo, M.metal, 0, -i * 0.08, 0);
        l.rotation.y = i % 2 ? Math.PI / 2 : 0;
        l.rotation.x = 0;
        l.castShadow = false;
        chain.add(l);
      }
      const hook = new THREE.Group();
      const hk = mesh(new THREE.TorusGeometry(0.12, 0.03, 8, 16, Math.PI * 1.4), M.metal);
      hk.rotation.z = Math.PI * 0.8;
      hook.add(hk, box(0.08, 0.2, 0.08, M.dark, 0, 0.12, 0));
      chain.userData.links = links;
      chain.userData.hook = hook;
      chain.position.y = -H / 2;
      g.add(chain, hook);
      const b: Built = { group: g, unit: false };
      b.anim = { kind: 'winch', nodes: [chain, hook], value: state };
      return b;
    }
    case 'compartment': {
      const mat = std(0x4aa3ff, 0, 1, { transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.6 }));
      m.userData.compartmentFill = true;
      edges.userData.compartmentEdge = true;
      return unit(m, edges);
    }
    default:
      return unit(box(1, 1, 1, M.main));
  }
}

export function buildPartObject(p: PartInstance): PartObject {
  const M = makeMats(p);
  const b = build(p, M);
  const root = new THREE.Group();
  const body = b.group;
  root.add(body);
  if (b.unit) body.scale.set(p.size[0], p.size[1], p.size[2]);
  root.position.set(...p.position);
  root.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ');
  root.userData.partId = p.id;
  root.userData.size = [...p.size];
  const mats = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    o.userData.partId = p.id;
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.MeshStandardMaterial) {
      // Materials are per-part so highlight tinting doesn't leak.
      mats.add(m);
      m.userData.baseColor = m.color.getHex();
      m.userData.baseEmissive = m.emissive.getHex();
      m.userData.baseOpacity = m.opacity;
      m.userData.baseTransparent = m.transparent;
    }
  });
  return { root, body, anim: b.anim, mats: [...mats] };
}

/** Advance a part's animated components toward `target` (0..1). */
export function animatePart(obj: PartObject, p: PartInstance, target: number, dt: number, running: boolean, envelopeFill = 1) {
  const a = obj.anim;
  if (!a) return;
  if (a.kind === 'spin') {
    if (running) for (const n of a.nodes) {
      if (p.type === 'wheel') n.rotation.x += dt * 3;
      else n.rotation.z += dt * (p.type === 'propeller' ? 25 : 8);
    }
    return;
  }
  if (a.kind === 'envelope') {
    const f = Math.max(0.05, envelopeFill);
    // Deflating: the envelope sags and shrinks.
    const g = a.nodes[0];
    g.scale.set(p.size[0] * (0.55 + 0.45 * Math.sqrt(f)), p.size[1] * (0.25 + 0.75 * f), p.size[2] * (0.8 + 0.2 * f));
    g.position.y = -p.size[1] * (1 - (0.25 + 0.75 * f)) / 2;
    return;
  }
  const speed = a.kind === 'winch' ? 0.15 : 0.6;
  a.value += Math.sign(target - a.value) * Math.min(Math.abs(target - a.value), speed * dt);
  const v = a.value;
  switch (a.kind) {
    case 'door': a.nodes[0].rotation.y = -v * Math.PI * 0.55; break;
    case 'hatch': a.nodes[0].rotation.x = -v * Math.PI * 0.6; break;
    case 'ramp': a.nodes[0].rotation.x = v * Math.PI * 0.5; break;
    case 'bayDoors':
      a.nodes[0].rotation.z = -v * Math.PI * 0.5;
      a.nodes[1].rotation.z = v * Math.PI * 0.5;
      break;
    case 'turret': a.nodes[0].rotation.y = v * Math.PI * 2; break;
    case 'lift': a.nodes[0].position.y = -0.48 + v * 0.93; break;
    case 'winch': {
      const [chain, hook] = a.nodes;
      const len = v * Number(p.props.chainLength ?? 10);
      const shown = Math.max(1, Math.floor(len / 0.08));
      chain.children.forEach((c, i) => (c.visible = i < shown));
      hook.position.y = -p.size[1] / 2 - len - 0.15;
      break;
    }
  }
}

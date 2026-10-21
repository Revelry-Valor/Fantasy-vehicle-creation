import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { defaultParams, getDef } from '../model/catalog';
import { makeBeam } from '../model/hull';
import { partMatrix } from '../model/math';
import { newVehicle, type Part, type PartDef, type Vehicle } from '../model/types';
import { buildPart } from '../render/meshes';

/** Small rendered pictures of catalog parts for the browser, made once and cached. */
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
const cache = new Map<string, string>();

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(96, 96);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
  const d = new THREE.DirectionalLight(0xffffff, 1.5);
  d.position.set(3, 5, 4);
  scene.add(d);
  camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
}

export function thumbnail(def: PartDef, v: Vehicle = newVehicle()): string {
  const key = `${def.id}|${JSON.stringify(def.params.map((p) => p.default))}|${def.material}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    if (!renderer) setup();
    let p: Part;
    if (def.kind === 'beam') p = makeBeam(v, def.id, def.id === 'beam.round' ? [[-0.8, -0.3, 0], [0, 0.35, 0], [0.8, -0.3, 0]] : [[-0.8, 0, 0], [0.8, 0, 0]]);
    else p = { id: 'thumb', def: def.id, params: defaultParams(def), position: [0, 0, 0], rotation: [0, 0, 0], material: def.material, layer: def.layer };
    if (def.id === 'beam.round' && p.path) p.path.smooth = true;
    const g = new THREE.Group();
    if (def.kind === 'skin') {
      const m = buildPart(v, { ...p, def: 'plate', params: { w: 1, l: 1, t: 0.05 } });
      g.add(m.main);
    } else {
      const m = buildPart(v, p);
      const holder = new THREE.Group();
      holder.add(m.main);
      if (m.head) holder.add(m.head);
      if (!m.world) { holder.matrixAutoUpdate = false; holder.matrix.copy(partMatrix(p)); }
      g.add(holder);
    }
    scene.add(g);
    const b = new THREE.Box3().setFromObject(g);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(0.05, b.getSize(new THREE.Vector3()).length() / 2);
    camera.position.copy(c).add(new THREE.Vector3(1, 0.75, 1.2).normalize().multiplyScalar(r / Math.sin(15 * Math.PI / 180) * 1.02));
    camera.lookAt(c);
    renderer!.render(scene, camera);
    const url = renderer!.domElement.toDataURL('image/png');
    scene.remove(g);
    cache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

export function clearThumbs() { cache.clear(); }
export { getDef };

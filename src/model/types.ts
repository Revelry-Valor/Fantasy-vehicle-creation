/**
 * The vehicle document. Everything the studio shows or edits lives here; the
 * 3D view, checks, mirroring and animation all read from or write to it.
 *
 * Units: metres for lengths, degrees for angles. Axes: +X right (starboard),
 * +Y up, +Z forward (bow). Saved files are this object as JSON; see
 * docs/FILE_FORMAT.md.
 */

export type Vec3 = [number, number, number];
export type MirrorAxis = 'x' | 'y' | 'z';

// ── Catalog ─────────────────────────────────────────────────────────────────

export type Finish = 'matte' | 'metal' | 'glass' | 'emissive';

export interface Material {
  id: string;
  name: string;
  /** CSS hex colour, e.g. "#8c9298". */
  color: string;
  finish: Finish;
  /** kg/m³, for the mass readout only. */
  density: number;
  /** Optional texture as a data URL. */
  texture?: string;
  custom?: boolean;
}

export type Layer = 'frame' | 'plating' | 'functional' | 'details';
export const LAYERS: Layer[] = ['frame', 'plating', 'functional', 'details'];

export type Category = 'Beams' | 'Plates & shapes' | 'Joints' | 'Functional' | 'Details' | 'Custom';

export type Behavior = 'none' | 'joint' | 'wheel' | 'light' | 'thruster';

export type JointType = 'hinge' | 'turret' | 'ball' | 'piston' | 'wheel';

/**
 * How a part is built:
 *  beam     — a cross-section swept along a path of grid points
 *  shape    — a parametric solid placed by position and rotation
 *  skin     — a plate generated from 3–4 boundary beams
 *  joint    — a shape with a moving half
 *  model    — an imported glTF/OBJ mesh (reserved)
 *  vehicle  — a saved vehicle placed as a live reference (reserved)
 */
export type PartKind = 'beam' | 'shape' | 'skin' | 'joint' | 'model' | 'vehicle';

export type ShapeId =
  | 'beam' | 'plate' | 'wedge' | 'cylinder' | 'cone' | 'hullPanel' | 'skin'
  | 'hinge' | 'turret' | 'ball' | 'piston' | 'wheel'
  | 'thruster' | 'light' | 'door' | 'canopy' | 'greeble' | 'bolt' | 'figure';

export interface ParamDef {
  key: string;
  label: string;
  unit: 'm' | 'deg' | '';
  min: number;
  max: number;
  default: number;
  /** Lengths snap to the sub-grid unless this is set. */
  step?: number;
}

export interface StatDef {
  key: string;
  label: string;
  unit?: string;
}

export interface JointSpec {
  type: JointType;
  /** Limits in degrees (rotations) or metres (pistons). */
  min: number;
  max: number;
  rest: number;
  /** Turret rings and wheels can spin all the way round. */
  continuous?: boolean;
}

export interface PartDef {
  id: string;
  name: string;
  category: Category;
  kind: PartKind;
  shape: ShapeId;
  description: string;
  params: ParamDef[];
  layer: Layer;
  material: string;
  behavior: Behavior;
  joint?: JointSpec;
  /** Cross-section for beams. */
  section?: Section;
  /** User-defined numbers that total up for the vehicle (crew, cargo…). */
  stats?: Record<string, number>;
  tags?: string[];
  custom?: boolean;
}

export type Section = 'square' | 'round' | 'ibeam' | 'channel' | 'custom';

// ── Parts ───────────────────────────────────────────────────────────────────

/**
 * A beam's path: grid points it runs through, plus optional Bézier handles per
 * segment. A segment with no handles is straight (two points) or flows through
 * its neighbours smoothly (three or more points).
 */
export interface CurvePath {
  points: Vec3[];
  /** One entry per segment: [handle after start, handle before end], world space. */
  handles?: (Vec3[] | null)[];
  /** Spline through the points (true) or straight segments with corners (false). */
  smooth?: boolean;
  closed?: boolean;
}

/** A stretch of a beam, by path parameter (0 = first point, n = n-th point). */
export interface EdgeRef {
  part: string;
  t0: number;
  t1: number;
  /** t0/t1 are fractions of the beam's length (so the edge follows a rib that gets reshaped). */
  frac?: boolean;
}

/** A conforming plate: the beams its edges follow, in loop order. */
export interface Surface {
  edges: EdgeRef[];
  thickness: number;
  /** Which side of the frame the plate sits on (+1 / −1 along its normal). */
  side: 1 | -1;
}

/** A stringer laid through ribs: its path is recomputed whenever a rib changes. */
export interface Derived {
  kind: 'stringer';
  ribs: string[];
  /** Where on each rib it passes, as a fraction of the rib's length. */
  s: number;
}

export interface MirrorLink {
  /** The part this one mirrors. The source itself has no link. */
  source: string;
  /** Which planes it is reflected across, e.g. "x" or "xz". */
  axes: string;
}

export interface Part {
  id: string;
  def: string;
  name?: string;
  params: Record<string, number>;
  /** Grid position of the part's centre (for beams and skins: unused, kept at the path start). */
  position: Vec3;
  /** Euler XYZ in degrees, snapped to 15°. */
  rotation: Vec3;
  /** Local axis flips (±1). Mirrored twins carry the reflection here so every shape mirrors exactly. */
  flip?: Vec3;
  material: string;
  layer: Layer;
  path?: CurvePath;
  section?: Section;
  surface?: Surface;
  derived?: Derived;
  mirror?: MirrorLink;
  /** Joint behaviour copied from the catalog so it can be tuned per part. */
  joint?: JointSpec;
  notes?: string;
  stats?: Record<string, number>;
  /** Reserved: paint, decal and livery layers. */
  livery?: { layers: unknown[] };
  /** Reserved: id of a saved vehicle placed here as a live reference. */
  vehicleRef?: string;
  /** Assembly instance this part was placed from. */
  assembly?: string;
}

/** A hand override of the automatic connection between two parts. */
export interface ConnectionOverride {
  a: string;
  b: string;
  mode: 'forced' | 'broken';
}

export interface ControlLink {
  /** Joint part id. */
  joint: string;
  /** Which degree of freedom (0 for most joints; ball: 0–2; wheel: 0 spin, 1 steer). */
  dof?: number;
  ratio: number;
  offset: number;
}

export interface Control {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  links: ControlLink[];
  /** An aim control: "aim at point" turns its turrets and guns toward a target. */
  aim?: boolean;
}

export interface Pose {
  id: string;
  name: string;
  values: Record<string, number[]>;
}

export interface AnimationKey {
  /** Seconds from the start. */
  time: number;
  pose: string;
}

export interface Animation {
  id: string;
  name: string;
  duration: number;
  loop: boolean;
  /** Ease between keys (true) or move at constant speed (false). */
  smooth: boolean;
  keys: AnimationKey[];
}

export interface Assembly {
  id: string;
  name: string;
  notes?: string;
  parts: Part[];
}

export interface Vehicle {
  format: 'vehicle-studio';
  version: 1;
  id: string;
  name: string;
  notes?: string;
  grid: { major: number; minor: number };
  mirror: { x: boolean; y: boolean; z: boolean; origin: Vec3 };
  parts: Part[];
  connections: ConnectionOverride[];
  /** Current joint values, per joint part id (degrees or metres, one per degree of freedom). */
  jointValues: Record<string, number[]>;
  controls: Control[];
  poses: Pose[];
  animations: Animation[];
  assemblies: Assembly[];
  materials: Material[];
  partDefs: PartDef[];
  statDefs: StatDef[];
  stats: Record<string, number>;
  /** Reserved: the base hull this vehicle is a variant of. */
  baseVehicle?: string;
  meta: { created: string; modified: string; app: string };
}

let counter = 0;
export function newId(prefix = 'p'): string {
  counter = (counter + 1) % 1679616;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

export function newVehicle(name = 'Untitled vehicle'): Vehicle {
  const now = new Date().toISOString();
  return {
    format: 'vehicle-studio',
    version: 1,
    id: newId('v'),
    name,
    grid: { major: 1, minor: 0.25 },
    mirror: { x: true, y: false, z: false, origin: [0, 0, 0] },
    parts: [],
    connections: [],
    jointValues: {},
    controls: [],
    poses: [],
    animations: [],
    assemblies: [],
    materials: [],
    partDefs: [],
    statDefs: [
      { key: 'crew', label: 'Crew' },
      { key: 'cargo', label: 'Cargo', unit: 't' },
      { key: 'weapons', label: 'Weapon slots' },
    ],
    stats: {},
    meta: { created: now, modified: now, app: 'Vehicle Studio 0.1' },
  };
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

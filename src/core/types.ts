/**
 * Core data model. Everything is in SI units: metres, kilograms, seconds, newtons.
 *
 * Coordinate convention for a vehicle:
 *   +X = starboard (right), -X = port (left)   — the mirror plane is X = 0
 *   +Y = up
 *   +Z = bow (forward)
 */

export type Vec3 = [number, number, number];

export type PropValue = number | string | boolean;

export interface PartInstance {
  id: string;
  type: string;
  name?: string;
  position: Vec3;
  /** Euler angles in radians, XYZ order. */
  rotation: Vec3;
  /** Bounding dimensions in metres (local X, Y, Z). */
  size: Vec3;
  material: string;
  /** Id of the twin part on the other side of the mirror plane. */
  mirrorOf?: string;
  props: Record<string, PropValue>;
  /** Custom vertex cloud for generated shells (flat xyz list, local space). */
  points?: number[];
}

export type Environment = 'land' | 'air' | 'water' | 'underwater' | 'space';

export interface DesignSettings {
  /** Height of a typical crew member in metres; furnishings scale to it. */
  crewHeight: number;
  environment: Environment;
  /** Airspeed / water speed used for wing lift, m/s. */
  cruiseSpeed: number;
  /** Wind speed used for sail thrust, m/s. */
  windSpeed: number;
  /** Operating depth for underwater craft, m. */
  depth: number;
  /** Altitude for air density, m. */
  altitude: number;
}

/** A deck promoted to a layer: the top-down view can show layers one at a time. */
export interface DesignLayer {
  id: string;
  name: string;
  /** The floor part whose top surface sets this layer's elevation. */
  floorId: string;
  visible: boolean;
}

export interface Design {
  name: string;
  version: 1;
  settings: DesignSettings;
  parts: PartInstance[];
  layers?: DesignLayer[];
}

export const DEFAULT_SETTINGS: DesignSettings = {
  crewHeight: 1.8,
  environment: 'air',
  cruiseSpeed: 15,
  windSpeed: 8,
  depth: 50,
  altitude: 300,
};

export function newDesign(name = 'Untitled Vessel'): Design {
  return { name, version: 1, settings: { ...DEFAULT_SETTINGS }, parts: [], layers: [] };
}

let idCounter = 0;
export function newId(): string {
  idCounter++;
  return `p${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function clonePart(p: PartInstance): PartInstance {
  return {
    ...p,
    position: [...p.position] as Vec3,
    rotation: [...p.rotation] as Vec3,
    size: [...p.size] as Vec3,
    props: { ...p.props },
    points: p.points ? [...p.points] : undefined,
  };
}

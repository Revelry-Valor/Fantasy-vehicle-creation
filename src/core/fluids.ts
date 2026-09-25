/**
 * Fluids that can live in tanks, envelopes and pipes. Densities are at
 * roughly 1 atm / 15 °C (kg/m³). Hazard numbers drive the compartment
 * atmosphere simulation when a fluid leaks.
 */
export interface FluidDef {
  id: string;
  name: string;
  density: number;
  state: 'gas' | 'liquid';
  /** Temperature the fluid is carried at, °C. */
  temperature: number;
  /** 0..1 how poisonous it is to breathe once it's mixed into the air. */
  toxicity: number;
  /** 0..1 how readily it burns / explodes when mixed with air. */
  flammability: number;
  /** Displaces oxygen when it fills a room. */
  asphyxiant: boolean;
  color: number;
  fantasy?: boolean;
}

export const AIR_DENSITY_SEA_LEVEL = 1.225;
export const WATER_DENSITY = 1025; // sea water
export const G = 9.81;

export const FLUIDS: FluidDef[] = [
  { id: 'hydrogen', name: 'Hydrogen', density: 0.0899, state: 'gas', temperature: 15, toxicity: 0, flammability: 1, asphyxiant: true, color: 0x9fc8ff },
  { id: 'helium', name: 'Helium', density: 0.1786, state: 'gas', temperature: 15, toxicity: 0, flammability: 0, asphyxiant: true, color: 0xf0e6ff },
  { id: 'hotair', name: 'Hot Air (100 °C)', density: 0.946, state: 'gas', temperature: 100, toxicity: 0, flammability: 0, asphyxiant: false, color: 0xffb080 },
  { id: 'aether', name: 'Aether Gas', density: 0.02, state: 'gas', temperature: -10, toxicity: 0.3, flammability: 0.2, asphyxiant: true, color: 0xb070ff, fantasy: true },
  { id: 'steam', name: 'Steam', density: 0.6, state: 'gas', temperature: 180, toxicity: 0, flammability: 0, asphyxiant: false, color: 0xf4f4f4 },
  { id: 'exhaust', name: 'Exhaust / Smoke', density: 1.3, state: 'gas', temperature: 250, toxicity: 0.9, flammability: 0, asphyxiant: true, color: 0x444444 },
  { id: 'fuel', name: 'Lamp Oil / Fuel', density: 820, state: 'liquid', temperature: 15, toxicity: 0.5, flammability: 0.9, asphyxiant: false, color: 0x7a5a1a },
  { id: 'propellant', name: 'Rocket Propellant', density: 1100, state: 'liquid', temperature: -20, toxicity: 0.8, flammability: 1, asphyxiant: false, color: 0xd0e070 },
  { id: 'water', name: 'Water', density: 1000, state: 'liquid', temperature: 15, toxicity: 0, flammability: 0, asphyxiant: false, color: 0x3a7bd5 },
  { id: 'coolant', name: 'Alchemical Coolant', density: 1100, state: 'liquid', temperature: -30, toxicity: 0.6, flammability: 0, asphyxiant: false, color: 0x40e0c0, fantasy: true },
  { id: 'waste', name: 'Waste Water', density: 1020, state: 'liquid', temperature: 20, toxicity: 0.3, flammability: 0, asphyxiant: false, color: 0x6b5a3a },
  { id: 'air', name: 'Compressed Air', density: 1.225, state: 'gas', temperature: 15, toxicity: 0, flammability: 0, asphyxiant: false, color: 0xdddddd },
];

const byId = new Map(FLUIDS.map((f) => [f.id, f]));

export function getFluid(id: string | undefined): FluidDef | undefined {
  return id ? byId.get(id) : undefined;
}

/** International Standard Atmosphere density approximation, valid to ~11 km. */
export function airDensityAt(altitude: number): number {
  const t = 1 - 2.25577e-5 * Math.max(0, altitude);
  return AIR_DENSITY_SEA_LEVEL * Math.pow(Math.max(t, 0.01), 4.2559);
}

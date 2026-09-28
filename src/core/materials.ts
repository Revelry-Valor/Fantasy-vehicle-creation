/**
 * Construction materials. Density in kg/m³, strength is an approximate yield /
 * bending strength in MPa used for member load checks and pressure ratings.
 * Fantasy materials are extrapolated to be "plausibly better" than real ones.
 */
export interface MaterialDef {
  id: string;
  name: string;
  density: number;
  strength: number;
  color: number;
  metalness: number;
  roughness: number;
  fantasy?: boolean;
  transparent?: boolean;
}

export const MATERIALS: MaterialDef[] = [
  { id: 'oak', name: 'Oak', density: 700, strength: 40, color: 0x8a5a33, metalness: 0, roughness: 0.85 },
  { id: 'pine', name: 'Pine', density: 500, strength: 30, color: 0xc49a5a, metalness: 0, roughness: 0.85 },
  { id: 'bamboo', name: 'Bamboo', density: 400, strength: 50, color: 0xb8b060, metalness: 0, roughness: 0.7 },
  { id: 'ironwood', name: 'Ironwood', density: 1100, strength: 90, color: 0x4a3322, metalness: 0, roughness: 0.8 },
  { id: 'iron', name: 'Wrought Iron', density: 7870, strength: 200, color: 0x5d5d62, metalness: 0.7, roughness: 0.6 },
  { id: 'steel', name: 'Steel', density: 7850, strength: 350, color: 0x8c9298, metalness: 0.8, roughness: 0.4 },
  { id: 'bronze', name: 'Bronze', density: 8800, strength: 250, color: 0xb0793a, metalness: 0.85, roughness: 0.35 },
  { id: 'brass', name: 'Brass', density: 8500, strength: 200, color: 0xc9a23e, metalness: 0.9, roughness: 0.3 },
  { id: 'copper', name: 'Copper', density: 8960, strength: 70, color: 0xb86b3c, metalness: 0.9, roughness: 0.35 },
  { id: 'aluminum', name: 'Aluminium', density: 2700, strength: 270, color: 0xc4c8cc, metalness: 0.8, roughness: 0.35 },
  { id: 'titanium', name: 'Titanium', density: 4500, strength: 880, color: 0x9ea3a8, metalness: 0.8, roughness: 0.4 },
  { id: 'carbon', name: 'Carbon Composite', density: 1600, strength: 600, color: 0x222428, metalness: 0.3, roughness: 0.5 },
  { id: 'silk', name: 'Oiled Silk', density: 1300, strength: 400, color: 0xe8dcc0, metalness: 0, roughness: 0.9 },
  { id: 'canvas', name: 'Canvas', density: 1500, strength: 60, color: 0xd8ccb0, metalness: 0, roughness: 1 },
  { id: 'leather', name: 'Leather', density: 900, strength: 20, color: 0x6b4226, metalness: 0, roughness: 0.9 },
  { id: 'glass', name: 'Glass', density: 2500, strength: 50, color: 0x9fd6e8, metalness: 0.1, roughness: 0.05, transparent: true },
  { id: 'rubber', name: 'Rubber', density: 1100, strength: 15, color: 0x1c1c1c, metalness: 0, roughness: 0.95 },
  { id: 'stone', name: 'Stone', density: 2600, strength: 15, color: 0x8a8580, metalness: 0, roughness: 1 },
  { id: 'mythril', name: 'Mythril', density: 2200, strength: 900, color: 0xcfe3f5, metalness: 0.95, roughness: 0.2, fantasy: true },
  { id: 'adamantine', name: 'Adamantine', density: 9000, strength: 2500, color: 0x3b4a5a, metalness: 0.9, roughness: 0.3, fantasy: true },
  { id: 'dragonbone', name: 'Dragonbone', density: 1600, strength: 500, color: 0xe5dcc2, metalness: 0, roughness: 0.6, fantasy: true },
  { id: 'dragonhide', name: 'Dragonhide', density: 1200, strength: 300, color: 0x5d2e2e, metalness: 0.1, roughness: 0.7, fantasy: true },
  { id: 'skywood', name: 'Skywood (lighter than oak)', density: 250, strength: 45, color: 0x9bb5a0, metalness: 0, roughness: 0.8, fantasy: true },
];

const byId = new Map(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string): MaterialDef {
  return byId.get(id) ?? MATERIALS[0];
}

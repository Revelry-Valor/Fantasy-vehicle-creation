import type { PropValue, Vec3 } from './types';

export type Layer = 'structure' | 'hull' | 'interior' | 'systems' | 'propulsion' | 'mechanism' | 'compartment';

export type Shape =
  | 'box' | 'tube' | 'cylinderY' | 'ellipsoid' | 'rib' | 'truss' | 'hullShell' | 'boatHull' | 'capsule'
  | 'wing' | 'fin' | 'propeller' | 'engine' | 'sail' | 'nozzle' | 'crystal' | 'screw'
  | 'wheel' | 'track' | 'leg'
  | 'crew' | 'seat' | 'bench' | 'bunk' | 'bed' | 'table' | 'lavatory' | 'stove' | 'helm' | 'ladder' | 'stairs' | 'railing'
  | 'cannon' | 'ballista' | 'turret' | 'mount' | 'gun'
  | 'crate' | 'barrel'
  | 'door' | 'porthole' | 'hatch' | 'ramp' | 'bayDoors'
  | 'valve' | 'lamp' | 'generator' | 'battery' | 'boiler'
  | 'lift' | 'winch'
  | 'compartment';

export type Category =
  | 'Structure' | 'Hull & Armor' | 'Lift & Buoyancy' | 'Propulsion' | 'Locomotion'
  | 'Crew & Furnishing' | 'Weapons' | 'Storage' | 'Doors & Windows' | 'Systems' | 'Mechanisms' | 'Compartments';

export const CATEGORIES: Category[] = [
  'Structure', 'Hull & Armor', 'Lift & Buoyancy', 'Propulsion', 'Locomotion', 'Crew & Furnishing',
  'Weapons', 'Storage', 'Doors & Windows', 'Systems', 'Mechanisms', 'Compartments',
];

export type Mechanism = 'lift' | 'door' | 'winch' | 'turret' | 'bayDoors';

export interface PartDef {
  type: string;
  name: string;
  category: Category;
  layer: Layer;
  shape: Shape;
  description: string;
  defaultSize: Vec3;
  defaultMaterial: string;
  /**
   * How mass is computed:
   *  solid — shape volume × fill × density
   *  shell — surface area × props.thickness × density (fabric, tanks, hulls)
   *  fixed — mass (kg) at default size, scaled by volume ratio; material is cosmetic
   */
  massMode: 'solid' | 'shell' | 'fixed';
  fill?: number;
  mass?: number;
  /** Carries loads — other parts can hang off it. */
  structural?: boolean;
  /** Sized relative to the crew height setting. */
  scalesWithCrew?: boolean;
  /** Which local axis to point along a surface normal when placed on another part. */
  surfaceAxis?: 'y' | 'z';
  /** Holds a fluid (tank, envelope, boiler…). */
  container?: boolean;
  /** Lifting-gas envelope — gives buoyant lift in air. */
  envelope?: boolean;
  /** Sealed displacement hull for water. Fraction of bounding volume that displaces. */
  displacement?: number;
  /** Carries fluid or power between touching parts. */
  conduit?: 'fluid' | 'power';
  /** Thrust in newtons at default size and the environments it works in. */
  thrust?: number;
  thrustEnv?: string[];
  /** Mechanical power demand (kW) to deliver the thrust. */
  powerDemand?: number;
  /** Mechanical/electrical power supplied (kW). */
  powerSupply?: number;
  /** Electrical consumption (W). */
  electricDemand?: number;
  electricSupply?: number;
  /** Specific impulse for rocket thrusters, s. */
  isp?: number;
  /** Magical lift in newtons (works in air/land). */
  magicLift?: number;
  wing?: boolean;
  sail?: boolean;
  /** Ground contact: fraction of footprint touching the ground. */
  contact?: 'wheel' | 'track' | 'leg';
  mechanism?: Mechanism;
  seats?: number;
  beds?: number;
  crew?: boolean;
  controlStation?: boolean;
  compartment?: boolean;
  weapon?: boolean;
  hidden?: boolean;
  defaultProps?: Record<string, PropValue>;
}

const AIR_ENVS = ['air', 'land', 'water'];
const WATER_ENVS = ['water', 'underwater'];

export const CATALOG: PartDef[] = [
  // ─── Structure ──────────────────────────────────────────────────────────
  { type: 'beam', name: 'Square Beam', category: 'Structure', layer: 'structure', shape: 'box',
    description: 'Solid timber or metal beam. The basic framing member.',
    defaultSize: [0.2, 0.2, 3], defaultMaterial: 'oak', massMode: 'solid', fill: 1, structural: true },
  { type: 'ibeam', name: 'I-Beam', category: 'Structure', layer: 'structure', shape: 'box',
    description: 'Rolled I-section: most of the stiffness for a third of the weight.',
    defaultSize: [0.2, 0.3, 4], defaultMaterial: 'steel', massMode: 'solid', fill: 0.3, structural: true },
  { type: 'strut', name: 'Round Strut', category: 'Structure', layer: 'structure', shape: 'tube',
    description: 'Round pole or tube strut for bracing and masts.',
    defaultSize: [0.15, 0.15, 3], defaultMaterial: 'oak', massMode: 'solid', fill: 1, structural: true },
  { type: 'keel', name: 'Keel', category: 'Structure', layer: 'structure', shape: 'box',
    description: 'The backbone running bow to stern. Start here.',
    defaultSize: [0.4, 0.6, 12], defaultMaterial: 'oak', massMode: 'solid', fill: 1, structural: true },
  { type: 'rib', name: 'Hull Rib', category: 'Structure', layer: 'structure', shape: 'rib',
    description: 'Curved U-frame that gives the hull its cross-section.',
    defaultSize: [4, 3, 0.2], defaultMaterial: 'oak', massMode: 'solid', fill: 0.14, structural: true },
  { type: 'truss', name: 'Truss Section', category: 'Structure', layer: 'structure', shape: 'truss',
    description: 'Open lattice girder — airship-style lightweight framing.',
    defaultSize: [0.6, 0.6, 3], defaultMaterial: 'aluminum', massMode: 'solid', fill: 0.08, structural: true },
  { type: 'deck', name: 'Deck / Floor', category: 'Structure', layer: 'structure', shape: 'box',
    description: 'Walkable planking or deck plate. Carries furniture and crew.',
    defaultSize: [3, 0.08, 3], defaultMaterial: 'pine', massMode: 'solid', fill: 1, structural: true, surfaceAxis: 'y' },
  { type: 'bulkhead', name: 'Bulkhead / Wall', category: 'Structure', layer: 'structure', shape: 'box',
    description: 'Internal wall. Separates compartments and stiffens the hull.',
    defaultSize: [3, 2.4, 0.08], defaultMaterial: 'pine', massMode: 'solid', fill: 1, structural: true, surfaceAxis: 'z' },

  // ─── Hull & Armor ───────────────────────────────────────────────────────
  { type: 'plate', name: 'Hull Plate', category: 'Hull & Armor', layer: 'hull', shape: 'box',
    description: 'Skin panel. Snaps flat onto whatever surface you click. Thickness = height.',
    defaultSize: [2, 0.03, 2], defaultMaterial: 'oak', massMode: 'solid', fill: 1, surfaceAxis: 'y' },
  { type: 'armor', name: 'Armor Plate', category: 'Hull & Armor', layer: 'hull', shape: 'box',
    description: 'Thick protective plate. Heavy — watch your centre of gravity.',
    defaultSize: [2, 0.08, 2], defaultMaterial: 'steel', massMode: 'solid', fill: 1, surfaceAxis: 'y' },
  { type: 'boatHull', name: 'Boat Hull', category: 'Hull & Armor', layer: 'hull', shape: 'boatHull',
    description: 'Sealed displacement hull. Floats on water; can be a sky-ship gondola too.',
    defaultSize: [4, 2, 12], defaultMaterial: 'oak', massMode: 'shell', displacement: 0.55, structural: true,
    defaultProps: { thickness: 0.06 } },
  { type: 'pressureHull', name: 'Pressure Hull', category: 'Hull & Armor', layer: 'hull', shape: 'capsule',
    description: 'Cylindrical pressure vessel for submersibles and spacecraft. Rated by material & thickness.',
    defaultSize: [3, 3, 8], defaultMaterial: 'steel', massMode: 'shell', displacement: 0.9, structural: true,
    defaultProps: { thickness: 0.04 } },
  { type: 'pontoon', name: 'Pontoon / Float', category: 'Hull & Armor', layer: 'hull', shape: 'capsule',
    description: 'Sealed float for seaplanes and catamarans.',
    defaultSize: [1, 1, 6], defaultMaterial: 'aluminum', massMode: 'shell', displacement: 0.9,
    defaultProps: { thickness: 0.004 } },
  { type: 'hullShell', name: 'Wrapped Hull Shell', category: 'Hull & Armor', layer: 'hull', shape: 'hullShell',
    description: 'Skin generated by wrapping the framing. Thickness sets weight and protection.',
    defaultSize: [1, 1, 1], defaultMaterial: 'oak', massMode: 'shell', hidden: true,
    defaultProps: { thickness: 0.03, sealed: true } },

  // ─── Lift & Buoyancy ────────────────────────────────────────────────────
  { type: 'envelope', name: 'Gas Envelope (Blimp)', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'ellipsoid',
    description: 'Lifting-gas envelope. Lift = (air density − gas density) × volume × g.',
    defaultSize: [6, 6, 16], defaultMaterial: 'silk', massMode: 'shell', container: true, envelope: true,
    defaultProps: { thickness: 0.0004, fluid: 'hydrogen', fill: 1 } },
  { type: 'gasCell', name: 'Gas Cell', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'ellipsoid',
    description: 'Smaller gas bag, usually inside a rigid frame.',
    defaultSize: [3, 3, 3], defaultMaterial: 'silk', massMode: 'shell', container: true, envelope: true,
    defaultProps: { thickness: 0.0004, fluid: 'helium', fill: 1 } },
  { type: 'balloon', name: 'Hot Air Balloon', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'ellipsoid',
    description: 'Open envelope of heated air. Weak lift, but no rare gases needed.',
    defaultSize: [14, 16, 14], defaultMaterial: 'canvas', massMode: 'shell', container: true, envelope: true,
    defaultProps: { thickness: 0.0003, fluid: 'hotair', fill: 1 } },
  { type: 'wing', name: 'Wing', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'wing',
    description: 'Aerofoil. Lift = ½ρv²·S·CL at cruise speed.',
    defaultSize: [8, 0.3, 2], defaultMaterial: 'pine', massMode: 'solid', fill: 0.12, wing: true, structural: true,
    defaultProps: { liftCoefficient: 0.8 } },
  { type: 'fin', name: 'Tail Fin / Rudder', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'fin',
    description: 'Stabiliser and steering surface.',
    defaultSize: [0.15, 2, 2.5], defaultMaterial: 'pine', massMode: 'solid', fill: 0.3 },
  { type: 'levitator', name: 'Levitation Crystal', category: 'Lift & Buoyancy', layer: 'propulsion', shape: 'crystal',
    description: 'Arcane lift source. Pushes against the earth; needs 10 kW of power.',
    defaultSize: [0.8, 1.4, 0.8], defaultMaterial: 'glass', massMode: 'fixed', mass: 60, magicLift: 20000, electricDemand: 10000 },

  // ─── Propulsion ─────────────────────────────────────────────────────────
  { type: 'propeller', name: 'Air Propeller', category: 'Propulsion', layer: 'propulsion', shape: 'propeller',
    description: 'Air screw. Thrust scales with diameter². Needs engine power.',
    defaultSize: [2.5, 2.5, 0.4], defaultMaterial: 'oak', massMode: 'fixed', mass: 60,
    thrust: 4000, thrustEnv: AIR_ENVS, powerDemand: 40 },
  { type: 'screw', name: 'Marine Screw', category: 'Propulsion', layer: 'propulsion', shape: 'screw',
    description: 'Water propeller for boats and submersibles.',
    defaultSize: [1.2, 1.2, 0.5], defaultMaterial: 'bronze', massMode: 'fixed', mass: 120,
    thrust: 12000, thrustEnv: WATER_ENVS, powerDemand: 60 },
  { type: 'steamEngine', name: 'Steam Engine', category: 'Propulsion', layer: 'propulsion', shape: 'engine',
    description: 'Reciprocating steam engine. Pipe it to a boiler.',
    defaultSize: [1.2, 1.3, 1.8], defaultMaterial: 'iron', massMode: 'fixed', mass: 900, powerSupply: 60 },
  { type: 'combustionEngine', name: 'Combustion Engine', category: 'Propulsion', layer: 'propulsion', shape: 'engine',
    description: 'Oil-burning engine. Pipe it to a fuel tank.',
    defaultSize: [1, 1, 1.4], defaultMaterial: 'steel', massMode: 'fixed', mass: 450, powerSupply: 150 },
  { type: 'sail', name: 'Mast & Sail', category: 'Propulsion', layer: 'propulsion', shape: 'sail',
    description: 'Wind-driven thrust = ½ρ·v²·A·Cd. Works on water and in the sky.',
    defaultSize: [0.3, 9, 5], defaultMaterial: 'canvas', massMode: 'fixed', mass: 300, sail: true },
  { type: 'thruster', name: 'Rocket Thruster', category: 'Propulsion', layer: 'propulsion', shape: 'nozzle',
    description: 'Reaction engine. Works anywhere; drinks propellant (Isp 300 s).',
    defaultSize: [1.2, 1.2, 1.8], defaultMaterial: 'steel', massMode: 'fixed', mass: 400,
    thrust: 60000, thrustEnv: ['air', 'land', 'water', 'underwater', 'space'], isp: 300 },

  // ─── Locomotion ─────────────────────────────────────────────────────────
  { type: 'wheel', name: 'Wheel', category: 'Locomotion', layer: 'propulsion', shape: 'wheel',
    description: 'Road wheel. Width is X; diameter is Y/Z.',
    defaultSize: [0.4, 1.2, 1.2], defaultMaterial: 'rubber', massMode: 'fixed', mass: 80, contact: 'wheel' },
  { type: 'track', name: 'Track Assembly', category: 'Locomotion', layer: 'propulsion', shape: 'track',
    description: 'Caterpillar track with road wheels. Spreads weight for soft ground.',
    defaultSize: [0.6, 1.2, 6], defaultMaterial: 'steel', massMode: 'fixed', mass: 2500, contact: 'track', powerDemand: 50 },
  { type: 'leg', name: 'Walker Leg', category: 'Locomotion', layer: 'propulsion', shape: 'leg',
    description: 'Articulated leg for walking machines.',
    defaultSize: [0.8, 3, 1], defaultMaterial: 'steel', massMode: 'fixed', mass: 900, contact: 'leg', powerDemand: 30 },

  // ─── Crew & Furnishing ──────────────────────────────────────────────────
  { type: 'crew', name: 'Crew Member', category: 'Crew & Furnishing', layer: 'interior', shape: 'crew',
    description: 'Scale reference and crew. Height follows the crew-height setting.',
    defaultSize: [0.5, 1.8, 0.3], defaultMaterial: 'leather', massMode: 'fixed', mass: 80, scalesWithCrew: true, crew: true },
  { type: 'seat', name: 'Seat', category: 'Crew & Furnishing', layer: 'interior', shape: 'seat',
    description: 'Single seat.', defaultSize: [0.5, 1, 0.55], defaultMaterial: 'oak', massMode: 'fixed', mass: 15, scalesWithCrew: true, seats: 1 },
  { type: 'bench', name: 'Bench', category: 'Crew & Furnishing', layer: 'interior', shape: 'bench',
    description: 'Seats three.', defaultSize: [1.6, 0.9, 0.5], defaultMaterial: 'oak', massMode: 'fixed', mass: 35, scalesWithCrew: true, seats: 3 },
  { type: 'bed', name: 'Bed', category: 'Crew & Furnishing', layer: 'interior', shape: 'bed',
    description: 'Single berth.', defaultSize: [1, 0.55, 2.1], defaultMaterial: 'oak', massMode: 'fixed', mass: 40, scalesWithCrew: true, beds: 1 },
  { type: 'bunk', name: 'Bunk Bed', category: 'Crew & Furnishing', layer: 'interior', shape: 'bunk',
    description: 'Two berths stacked.', defaultSize: [1, 1.8, 2.1], defaultMaterial: 'oak', massMode: 'fixed', mass: 70, scalesWithCrew: true, beds: 2 },
  { type: 'table', name: 'Table', category: 'Crew & Furnishing', layer: 'interior', shape: 'table',
    description: 'Mess or chart table.', defaultSize: [1.2, 0.75, 0.8], defaultMaterial: 'oak', massMode: 'fixed', mass: 25, scalesWithCrew: true },
  { type: 'lavatory', name: 'Lavatory', category: 'Crew & Furnishing', layer: 'interior', shape: 'lavatory',
    description: 'Head / toilet. Pipe to water and waste tanks.', defaultSize: [0.6, 0.8, 0.7], defaultMaterial: 'bronze', massMode: 'fixed', mass: 45, scalesWithCrew: true },
  { type: 'stove', name: 'Galley Stove', category: 'Crew & Furnishing', layer: 'interior', shape: 'stove',
    description: 'Cooking stove. Heats its compartment.', defaultSize: [1, 0.9, 0.6], defaultMaterial: 'iron', massMode: 'fixed', mass: 150, scalesWithCrew: true },
  { type: 'helm', name: 'Helm', category: 'Crew & Furnishing', layer: 'interior', shape: 'helm',
    description: "Ship's wheel / control station. Every vessel needs one.", defaultSize: [1, 1.4, 0.5], defaultMaterial: 'oak', massMode: 'fixed', mass: 40, scalesWithCrew: true, controlStation: true },
  { type: 'ladder', name: 'Ladder', category: 'Crew & Furnishing', layer: 'interior', shape: 'ladder',
    description: 'Vertical access between decks.', defaultSize: [0.5, 3, 0.1], defaultMaterial: 'oak', massMode: 'fixed', mass: 15 },
  { type: 'stairs', name: 'Stairs', category: 'Crew & Furnishing', layer: 'interior', shape: 'stairs',
    description: 'Companionway stairs.', defaultSize: [1, 2.4, 3], defaultMaterial: 'oak', massMode: 'fixed', mass: 120 },
  { type: 'railing', name: 'Railing', category: 'Crew & Furnishing', layer: 'interior', shape: 'railing',
    description: 'Deck rail.', defaultSize: [0.06, 1, 3], defaultMaterial: 'oak', massMode: 'fixed', mass: 20, scalesWithCrew: true },

  // ─── Weapons ────────────────────────────────────────────────────────────
  { type: 'cannon', name: 'Cannon', category: 'Weapons', layer: 'interior', shape: 'cannon',
    description: 'Muzzle-loading cannon on a carriage.', defaultSize: [0.7, 0.8, 2.6], defaultMaterial: 'bronze', massMode: 'fixed', mass: 1400, weapon: true },
  { type: 'ballista', name: 'Ballista', category: 'Weapons', layer: 'interior', shape: 'ballista',
    description: 'Torsion bolt thrower.', defaultSize: [2.2, 1.1, 2], defaultMaterial: 'oak', massMode: 'fixed', mass: 350, weapon: true },
  { type: 'turret', name: 'Gun Turret', category: 'Weapons', layer: 'interior', shape: 'turret',
    description: 'Rotating armored turret. Use "Operate" to traverse.', defaultSize: [2.2, 1.6, 2.2], defaultMaterial: 'steel', massMode: 'fixed', mass: 3500, weapon: true, mechanism: 'turret' },
  { type: 'gunMount', name: 'Pintle Mount', category: 'Weapons', layer: 'interior', shape: 'mount',
    description: 'Swivel post for a light gun.', defaultSize: [0.4, 1.1, 0.4], defaultMaterial: 'steel', massMode: 'fixed', mass: 40, surfaceAxis: 'y' },
  { type: 'gun', name: 'Mounted Gun', category: 'Weapons', layer: 'interior', shape: 'gun',
    description: 'Light repeating gun. Place on a pintle mount.', defaultSize: [0.25, 0.35, 1.5], defaultMaterial: 'steel', massMode: 'fixed', mass: 35, weapon: true },

  // ─── Storage ────────────────────────────────────────────────────────────
  { type: 'fuelTank', name: 'Fuel Tank', category: 'Storage', layer: 'systems', shape: 'tube',
    description: 'Horizontal liquid tank. Mass includes contents.', defaultSize: [1.2, 1.2, 2.5], defaultMaterial: 'steel', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.004, fluid: 'fuel', fill: 0.9 } },
  { type: 'waterTank', name: 'Water Tank', category: 'Storage', layer: 'systems', shape: 'cylinderY',
    description: 'Upright fresh-water tank.', defaultSize: [1.2, 1.6, 1.2], defaultMaterial: 'copper', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.003, fluid: 'water', fill: 0.9 } },
  { type: 'gasTank', name: 'Gas Reservoir', category: 'Storage', layer: 'systems', shape: 'capsule',
    description: 'Compressed gas bottle (pressure in bar). Tops up envelopes.', defaultSize: [0.8, 0.8, 3], defaultMaterial: 'steel', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.012, fluid: 'hydrogen', fill: 1, pressure: 150 } },
  { type: 'ballastTank', name: 'Ballast Tank', category: 'Storage', layer: 'systems', shape: 'capsule',
    description: 'Flood with water to sink, blow to rise. Adjust fill.', defaultSize: [1.5, 1.5, 4], defaultMaterial: 'steel', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.01, fluid: 'water', fill: 0.3 } },
  { type: 'crate', name: 'Cargo Crate', category: 'Storage', layer: 'interior', shape: 'crate',
    description: 'Crate with configurable cargo mass.', defaultSize: [1.2, 1.2, 1.2], defaultMaterial: 'pine', massMode: 'fixed', mass: 60,
    defaultProps: { cargo: 500 } },
  { type: 'barrel', name: 'Barrel', category: 'Storage', layer: 'interior', shape: 'barrel',
    description: 'Cask of water, fuel or rum.', defaultSize: [0.6, 0.9, 0.6], defaultMaterial: 'oak', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.025, fluid: 'water', fill: 1 } },

  // ─── Doors & Windows ────────────────────────────────────────────────────
  { type: 'door', name: 'Door', category: 'Doors & Windows', layer: 'interior', shape: 'door',
    description: 'Hinged door. Open doors ventilate compartments.', defaultSize: [0.9, 2.05, 0.08], defaultMaterial: 'oak', massMode: 'fixed', mass: 35, scalesWithCrew: true, surfaceAxis: 'z', mechanism: 'door' },
  { type: 'porthole', name: 'Window / Porthole', category: 'Doors & Windows', layer: 'hull', shape: 'porthole',
    description: 'Round glazed window.', defaultSize: [0.6, 0.6, 0.1], defaultMaterial: 'brass', massMode: 'fixed', mass: 18, surfaceAxis: 'z' },
  { type: 'hatch', name: 'Hatch', category: 'Doors & Windows', layer: 'hull', shape: 'hatch',
    description: 'Deck hatch.', defaultSize: [0.9, 0.08, 0.9], defaultMaterial: 'oak', massMode: 'fixed', mass: 30, surfaceAxis: 'y', mechanism: 'door' },
  { type: 'ramp', name: 'Cargo Ramp', category: 'Doors & Windows', layer: 'hull', shape: 'ramp',
    description: 'Stern ramp hinged at the bottom edge. Lowers outward.', defaultSize: [3, 3, 0.2], defaultMaterial: 'steel', massMode: 'fixed', mass: 900, mechanism: 'door' },
  { type: 'bayDoors', name: 'Cargo Bay Doors', category: 'Doors & Windows', layer: 'hull', shape: 'bayDoors',
    description: 'Belly doors that swing down. Pair with a winch.', defaultSize: [3, 0.15, 4], defaultMaterial: 'steel', massMode: 'fixed', mass: 700, mechanism: 'bayDoors' },

  // ─── Systems ────────────────────────────────────────────────────────────
  { type: 'pipe', name: 'Pipe', category: 'Systems', layer: 'systems', shape: 'tube',
    description: 'Carries whatever fluid the tank/envelope it touches holds. Can be damaged.', defaultSize: [0.1, 0.1, 2], defaultMaterial: 'copper', massMode: 'solid', fill: 0.3, conduit: 'fluid' },
  { type: 'valve', name: 'Valve', category: 'Systems', layer: 'systems', shape: 'valve',
    description: 'Closing it isolates a leak downstream.', defaultSize: [0.3, 0.3, 0.3], defaultMaterial: 'brass', massMode: 'fixed', mass: 8, conduit: 'fluid',
    defaultProps: { open: true } },
  { type: 'wire', name: 'Wiring / Cable', category: 'Systems', layer: 'systems', shape: 'tube',
    description: 'Carries power from generators and batteries to lamps and machines.', defaultSize: [0.04, 0.04, 2], defaultMaterial: 'copper', massMode: 'solid', fill: 0.5, conduit: 'power' },
  { type: 'lamp', name: 'Lamp', category: 'Systems', layer: 'systems', shape: 'lamp',
    description: 'Electric lamp. Lights when wired to power.', defaultSize: [0.3, 0.3, 0.3], defaultMaterial: 'brass', massMode: 'fixed', mass: 3, electricDemand: 60, surfaceAxis: 'y' },
  { type: 'generator', name: 'Dynamo', category: 'Systems', layer: 'systems', shape: 'generator',
    description: 'Electrical generator (20 kW).', defaultSize: [1, 1, 1.4], defaultMaterial: 'iron', massMode: 'fixed', mass: 350, electricSupply: 20000 },
  { type: 'battery', name: 'Battery / Mana Cell', category: 'Systems', layer: 'systems', shape: 'battery',
    description: 'Stored power (5 kW).', defaultSize: [0.8, 0.6, 0.5], defaultMaterial: 'brass', massMode: 'fixed', mass: 120, electricSupply: 5000 },
  { type: 'boiler', name: 'Boiler', category: 'Systems', layer: 'systems', shape: 'boiler',
    description: 'Makes steam for engines. Scalding if its pipes rupture.', defaultSize: [1.4, 2.2, 1.4], defaultMaterial: 'iron', massMode: 'shell', container: true,
    defaultProps: { thickness: 0.02, fluid: 'steam', fill: 1, pressure: 10 } },

  // ─── Mechanisms ─────────────────────────────────────────────────────────
  { type: 'lift', name: 'Lift / Elevator', category: 'Mechanisms', layer: 'mechanism', shape: 'lift',
    description: 'Platform that travels the height of its shaft.', defaultSize: [2, 4, 2], defaultMaterial: 'steel', massMode: 'fixed', mass: 900, mechanism: 'lift',
    electricDemand: 3000 },
  { type: 'winch', name: 'Cargo Winch & Chain', category: 'Mechanisms', layer: 'mechanism', shape: 'winch',
    description: 'Lowers a chain and hook to haul loads aboard.', defaultSize: [1.2, 0.8, 0.8], defaultMaterial: 'iron', massMode: 'fixed', mass: 350, mechanism: 'winch',
    defaultProps: { chainLength: 10, capacity: 2000 } },

  // ─── Compartments ───────────────────────────────────────────────────────
  { type: 'compartment', name: 'Compartment', category: 'Compartments', layer: 'compartment', shape: 'compartment',
    description: 'An air volume. Leaks inside it change its temperature and air quality.', defaultSize: [3, 2.4, 4], defaultMaterial: 'glass', massMode: 'fixed', mass: 0, compartment: true,
    defaultProps: { label: 'Cabin' } },
];

const byType = new Map(CATALOG.map((d) => [d.type, d]));

export function getDef(type: string): PartDef {
  const d = byType.get(type);
  if (!d) throw new Error(`Unknown part type: ${type}`);
  return d;
}

export function hasDef(type: string): boolean {
  return byType.has(type);
}

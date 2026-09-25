import { getDef } from './catalog';
import { partsTouch, worldAABB, aabbOverlap, type AABB } from './geometry';
import type { PartInstance } from './types';

export type ContactGraph = Map<string, Set<string>>;

/**
 * Which parts physically touch which. Compartments are pure air volumes and
 * never "touch" anything for load or plumbing purposes.
 */
export function buildContactGraph(parts: PartInstance[]): ContactGraph {
  const graph: ContactGraph = new Map();
  const solid = parts.filter((p) => !getDef(p.type).compartment);
  const boxes: AABB[] = solid.map(worldAABB);
  for (const p of solid) graph.set(p.id, new Set());
  // Sort-and-sweep along X to avoid testing every pair.
  const order = solid.map((_, i) => i).sort((i, j) => boxes[i].min[0] - boxes[j].min[0]);
  const tol = 0.03;
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (boxes[j].min[0] > boxes[i].max[0] + tol) break;
      if (!aabbOverlap(boxes[i], boxes[j], tol)) continue;
      if (partsTouch(solid[i], solid[j], tol)) {
        graph.get(solid[i].id)!.add(solid[j].id);
        graph.get(solid[j].id)!.add(solid[i].id);
      }
    }
  }
  return graph;
}

export interface FluidNetwork {
  conduits: string[];
  containers: string[];
  /** Non-container parts plumbed in: engines, lavatories, stoves… */
  fixtures: string[];
  fluid?: string;
}

export function isOpenConduit(p: PartInstance): boolean {
  const def = getDef(p.type);
  if (def.conduit !== 'fluid') return false;
  return p.props.open !== false;
}

/** Group connected pipes (through open valves) and find what they plumb together. */
export function buildFluidNetworks(parts: PartInstance[], graph: ContactGraph): FluidNetwork[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const nets: FluidNetwork[] = [];
  for (const start of parts) {
    if (seen.has(start.id) || !isOpenConduit(start)) continue;
    const net: FluidNetwork = { conduits: [], containers: [], fixtures: [] };
    const attached = new Set<string>();
    const stack = [start.id];
    seen.add(start.id);
    while (stack.length) {
      const id = stack.pop()!;
      net.conduits.push(id);
      for (const nId of graph.get(id) ?? []) {
        const n = byId.get(nId)!;
        if (isOpenConduit(n)) {
          if (!seen.has(nId)) { seen.add(nId); stack.push(nId); }
        } else if (getDef(n.type).conduit !== 'fluid') {
          attached.add(nId);
        }
      }
    }
    const counts = new Map<string, number>();
    for (const id of attached) {
      const p = byId.get(id)!;
      const def = getDef(p.type);
      if (def.conduit === 'power') continue;
      if (def.container) {
        net.containers.push(id);
        const f = String(p.props.fluid ?? '');
        if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
      } else if (def.structural || def.compartment) {
        // pipes resting on a beam aren't plumbed into it
      } else {
        net.fixtures.push(id);
      }
    }
    let best = 0;
    for (const [f, c] of counts) if (c > best) { best = c; net.fluid = f; }
    nets.push(net);
  }
  return nets;
}

export interface PowerResult {
  powered: Set<string>;
  supplyW: number;
  demandW: number;
}

/**
 * Electricity flows from generators/batteries along healthy wires to anything
 * with an electrical demand that touches the grid (or the supplier directly).
 */
export function solvePower(parts: PartInstance[], graph: ContactGraph, health: (id: string) => number): PowerResult {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const powered = new Set<string>();
  const visited = new Set<string>();
  let supplyW = 0, demandW = 0;
  for (const p of parts) {
    const d = getDef(p.type);
    if (d.electricDemand) demandW += d.electricDemand;
  }
  for (const src of parts) {
    const d = getDef(src.type);
    if (!d.electricSupply || health(src.id) < 0.3 || visited.has(src.id)) continue;
    // BFS over live wires starting from this supplier.
    const stack = [src.id];
    visited.add(src.id);
    const grid: string[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      grid.push(id);
      for (const nId of graph.get(id) ?? []) {
        if (visited.has(nId)) continue;
        const n = byId.get(nId)!;
        const nd = getDef(n.type);
        const live = health(nId) >= 0.3;
        if ((nd.conduit === 'power' || nd.electricSupply) && live) {
          visited.add(nId);
          stack.push(nId);
        } else if (nd.electricDemand && live) {
          powered.add(nId);
        }
      }
    }
    for (const id of grid) {
      const gd = getDef(byId.get(id)!.type);
      if (gd.electricSupply) supplyW += gd.electricSupply;
    }
  }
  return { powered, supplyW, demandW };
}

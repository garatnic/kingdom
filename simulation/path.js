import { footprint } from '../data/buildings.js';
import { TERRAIN_COST } from '../data/balance.js';

export function findPath(world, start, goal) {
  const { width, height, terrain } = world.map;
  const inBounds = ({ x, y }) => Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < width && y >= 0 && y < height;
  if (!inBounds(start) || !inBounds(goal)) return null;

  const index = ({ x, y }) => y * width + x;
  const origin = index(start);
  const destination = index(goal);
  const blocked = new Set();
  for (const building of world.buildings) {
    for (let y = building.y; y < building.y + (building.height ?? 1); y++) {
      for (let x = building.x; footprint(building, { x, y }); x++) blocked.add(index({ x, y }));
    }
  }
  if (blocked.has(destination) || !Number.isFinite(TERRAIN_COST[terrain[destination]])) return null;

  const heuristic = tile => Math.abs(tile % width - goal.x) + Math.abs(Math.floor(tile / width) - goal.y);
  const costs = new Map([[origin, 0]]);
  const previous = new Map();
  const pending = new Set([origin]);
  while (pending.size) {
    let current;
    let best = Infinity;
    for (const tile of pending) {
      const score = costs.get(tile) + heuristic(tile);
      if (score < best) {
        current = tile;
        best = score;
      }
    }
    if (current === destination) {
      const path = [];
      for (let tile = destination; tile !== origin; tile = previous.get(tile)) {
        path.push({ x: tile % width, y: Math.floor(tile / width) });
      }
      return path.reverse();
    }
    pending.delete(current);
    const x = current % width;
    const y = Math.floor(current / width);
    for (const neighbor of [{ x, y: y - 1 }, { x: x - 1, y }, { x: x + 1, y }, { x, y: y + 1 }]) {
      if (!inBounds(neighbor)) continue;
      const tile = index(neighbor);
      const cost = costs.get(current) + TERRAIN_COST[terrain[tile]];
      if (blocked.has(tile) || !(cost < (costs.get(tile) ?? Infinity))) continue;
      costs.set(tile, cost);
      previous.set(tile, current);
      pending.add(tile);
    }
  }
  return null;
}

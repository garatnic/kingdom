import { footprint } from '../data/buildings.js';
import { TERRAIN_COST } from '../data/balance.js';

function earlier(a, b) {
  return a.score < b.score || (a.score === b.score && a.order < b.order);
}

function push(heap, value) {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!earlier(value, heap[parent])) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function pop(heap) {
  const result = heap[0];
  const last = heap.pop();
  if (!heap.length) return result;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && earlier(heap[child + 1], heap[child])) child++;
    if (!earlier(heap[child], last)) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return result;
}

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
  const pending = [{ tile: origin, cost: 0, score: heuristic(origin), order: 0 }];
  const order = new Map([[origin, 0]]);
  while (pending.length) {
    const next = pop(pending);
    const current = next.tile;
    if (next.cost !== costs.get(current)) continue;
    if (current === destination) {
      const path = [];
      for (let tile = destination; tile !== origin; tile = previous.get(tile)) {
        path.push({ x: tile % width, y: Math.floor(tile / width) });
      }
      return path.reverse();
    }
    const x = current % width;
    const y = Math.floor(current / width);
    for (const neighbor of [{ x, y: y - 1 }, { x: x - 1, y }, { x: x + 1, y }, { x, y: y + 1 }]) {
      if (!inBounds(neighbor)) continue;
      const tile = index(neighbor);
      const cost = costs.get(current) + TERRAIN_COST[terrain[tile]];
      if (blocked.has(tile) || !(cost < (costs.get(tile) ?? Infinity))) continue;
      costs.set(tile, cost);
      previous.set(tile, current);
      if (!order.has(tile)) order.set(tile, order.size);
      push(pending, { tile, cost, score: cost + heuristic(tile), order: order.get(tile) });
    }
  }
  return null;
}

export function reachableTiles(world, start, extraBlock) {
  const { width, height, terrain } = world.map;
  const inside = ({ x, y }) => x >= 0 && x < width && y >= 0 && y < height;
  const index = ({ x, y }) => y * width + x;
  const seen = new Uint8Array(width * height);
  if (!inside(start)) return seen;
  for (const b of extraBlock ? [...world.buildings, extraBlock] : world.buildings) {
    for (let y = b.y; y < b.y + (b.height ?? 1); y++) {
      for (let x = b.x; x < b.x + (b.width ?? 1); x++) {
        if (inside({ x, y })) seen[y * width + x] = 2;
      }
    }
  }
  if (seen[index(start)] || terrain[index(start)] === 'water') return seen;
  const queue = [index(start)];
  seen[index(start)] = 1;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const x = current % width;
    const y = Math.floor(current / width);
    for (const tile of [{ x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 }]) {
      if (!inside(tile)) continue;
      const next = index(tile);
      if (seen[next] || terrain[next] === 'water') continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return seen;
}

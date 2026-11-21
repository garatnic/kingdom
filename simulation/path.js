import { TERRAIN_COST } from '../data/balance.js';

const pathWorkspaces = new WeakMap();

const verticalFirst = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const horizontalFirst = [[-1, 0], [1, 0], [0, -1], [0, 1]];

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

export function findPath(world, start, goal, bounds) {
  const { width, height, terrain } = world.map;
  const limitX = bounds?.width ?? width;
  const limitY = bounds?.height ?? height;
  const inBounds = ({ x, y }) => Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < limitX && y >= 0 && y < limitY;
  if (!inBounds(start) || !inBounds(goal)) return null;

  const index = ({ x, y }) => y * width + x;
  const origin = index(start);
  const destination = index(goal);
  const size = width * height;
  let workspace = pathWorkspaces.get(world);
  if (workspace?.visited.length !== size) {
    workspace = { visited: new Uint32Array(size), blocked: new Uint32Array(size),
      costs: new Float64Array(size), previous: new Uint32Array(size), order: new Uint32Array(size), stamp: 0 };
    pathWorkspaces.set(world, workspace);
  }
  const { visited, blocked, costs, previous, order } = workspace;
  if (workspace.stamp === 0xffffffff) {
    visited.fill(0);
    blocked.fill(0);
    workspace.stamp = 0;
  }
  const stamp = ++workspace.stamp;
  for (const building of world.buildings) {
    for (let y = building.y; y < building.y + (building.height ?? 1); y++) {
      for (let x = building.x; x < building.x + (building.width ?? 1); x++) blocked[y * width + x] = stamp;
    }
  }
  if (blocked[destination] === stamp || !Number.isFinite(TERRAIN_COST[terrain[destination]])) return null;

  const heuristic = tile => Math.abs(tile % width - goal.x) + Math.abs(Math.floor(tile / width) - goal.y);
  visited[origin] = stamp;
  costs[origin] = 0;
  order[origin] = 0;
  let frontierOrder = 1;
  const pending = [{ tile: origin, cost: 0, score: heuristic(origin), order: 0 }];
  while (pending.length) {
    const next = pop(pending);
    const current = next.tile;
    if (next.cost !== costs[current]) continue;
    if (current === destination) {
      const path = [];
      for (let tile = destination; tile !== origin; tile = previous[tile]) {
        path.push({ x: tile % width, y: Math.floor(tile / width) });
      }
      return path.reverse();
    }
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of verticalFirst) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= limitX || ny < 0 || ny >= limitY) continue;
      const tile = ny * width + nx;
      const cost = next.cost + TERRAIN_COST[terrain[tile]];
      const seen = visited[tile] === stamp;
      if (blocked[tile] === stamp || !(cost < (seen ? costs[tile] : Infinity))) continue;
      costs[tile] = cost;
      previous[tile] = current;
      if (!seen) {
        visited[tile] = stamp;
        order[tile] = frontierOrder++;
      }
      push(pending, { tile, cost, score: cost + heuristic(tile), order: order[tile] });
    }
  }
  return null;
}

export function reachableTiles(world, start, extraBlock, targets, bounds) {
  const { width, height, terrain } = world.map;
  const limitX = bounds?.width ?? width;
  const limitY = bounds?.height ?? height;
  const inside = (x, y) => x >= 0 && x < limitX && y >= 0 && y < limitY;
  const seen = new Uint8Array(width * height);
  if (!Number.isInteger(start.x) || !Number.isInteger(start.y) || !inside(start.x, start.y)) return seen;
  for (const b of extraBlock ? [...world.buildings, extraBlock] : world.buildings) {
    for (let y = b.y; y < b.y + (b.height ?? 1); y++) {
      for (let x = b.x; x < b.x + (b.width ?? 1); x++) {
        if (inside(x, y)) seen[y * width + x] = 2;
      }
    }
  }
  const origin = start.y * width + start.x;
  if (seen[origin] || terrain[origin] === 'water') return seen;
  const queue = new Uint32Array(width * height);
  let end = 1;
  queue[0] = origin;
  seen[origin] = 1;
  const pending = targets && new Set(targets);
  pending?.delete(origin);
  for (let i = 0; i < end && pending?.size !== 0; i++) {
    const current = queue[i];
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of horizontalFirst) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      const next = ny * width + nx;
      if (seen[next] || terrain[next] === 'water') continue;
      seen[next] = 1;
      pending?.delete(next);
      queue[end++] = next;
    }
  }
  return seen;
}

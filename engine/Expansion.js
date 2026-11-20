import { SIZE, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { nextId } from '../simulation/Identity.js';
import { findPath, reachableTiles } from '../simulation/path.js';

export const CHUNK_SIZE = 32;
export const MAX_WORLD_SIZE = 128;
const MIN_EXPANSION_TICK = 2 * TIME_TICKS_PER_DAY;
const RETRY_TICKS = TIME_TICKS_PER_DAY;

export function validWorldDimension(size) {
  return Number.isInteger(size) && size >= SIZE && size <= MAX_WORLD_SIZE && size % CHUNK_SIZE === 0;
}

// Coordinate-based terrain leaves the simulation RNG free for residents and events.
function terrainAt(seed, x, y) {
  const sample = (gx, gy) => {
    let hash = seed ^ Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
  };
  const gx = Math.floor(x / 8);
  const gy = Math.floor(y / 8);
  const smooth = t => t * t * (3 - 2 * t);
  const u = smooth((x % 8) / 8);
  const v = smooth((y % 8) / 8);
  const top = sample(gx, gy) * (1 - u) + sample(gx + 1, gy) * u;
  const bottom = sample(gx, gy + 1) * (1 - u) + sample(gx + 1, gy + 1) * u;
  const height = top * (1 - v) + bottom * v;
  return height < 0.28 ? 'water' : height < 0.53 ? 'grass' : height < 0.76 ? 'forest' : 'mountain';
}

export function surveyRoute(world, citizen) {
  const { map, worldTimeTick } = world;
  if (worldTimeTick < (map.nextSurveyTick ?? MIN_EXPANSION_TICK) ||
      citizen.profession !== 'adventurer' ||
      world.citizens.some(c => c.alive && c.action.kind === 'survey')) return null;

  const origin = citizen.lastKnownSafeTile;
  const candidates = [];
  if (map.width < MAX_WORLD_SIZE) {
    for (let y = 0; y < map.height; y += 1) candidates.push({ x: map.width - 1, y, direction: 'east' });
  }
  if (map.height < MAX_WORLD_SIZE) {
    for (let x = 0; x < map.width; x += 1) candidates.push({ x, y: map.height - 1, direction: 'south' });
  }
  const cost = tile => Math.abs(tile.x - origin.x) + Math.abs(tile.y - origin.y);
  candidates.sort((a, b) => cost(a) - cost(b));
  if (!candidates.length) return null;
  const reachable = reachableTiles(world, origin);
  const goal = candidates.find(tile => reachable[tile.y * map.width + tile.x] === 1);
  if (goal) return { goal, path: findPath(world, origin, goal) };
  map.nextSurveyTick = worldTimeTick + RETRY_TICKS;
  return null;
}

export function discoverFrontier(world, tile, direction, citizenId) {
  const { map } = world;
  const east = direction === 'east';
  if ((!east && direction !== 'south') || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
      tile.x < 0 || tile.x >= map.width || tile.y < 0 || tile.y >= map.height ||
      (east ? tile.x !== map.width - 1 || map.width >= MAX_WORLD_SIZE
        : tile.y !== map.height - 1 || map.height >= MAX_WORLD_SIZE) ||
      map.terrain[tile.y * map.width + tile.x] === 'water') return false;
  const seed = String(world.seed).split('').reduce((hash, code) => Math.imul(hash ^ code.charCodeAt(0), 16777619), 2166136261);
  const width = map.width + (east ? CHUNK_SIZE : 0);
  const height = map.height + (east ? 0 : CHUNK_SIZE);
  const terrain = Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < map.width && y < map.height) return map.terrain[y * map.width + x];
    if (east ? y === tile.y : x === tile.x) return 'grass';
    return terrainAt(seed, x, y);
  });
  for (const [resource, distance, quantity] of [['food', 6, 12], ['wood', 14, 20], ['stone', 22, 30]]) {
    const x = tile.x + (east ? distance : 0);
    const y = tile.y + (east ? 0 : distance);
    world.resourceNodes.push({ id: nextId(world, 'node'), resource, x, y, quantity });
  }
  Object.assign(map, { width, height, terrain, nextSurveyTick: world.worldTimeTick + RETRY_TICKS });
  emitOnce(world, `frontier/${width}/${height}`, 'frontierDiscovered', { ...tile, citizenId, width, height });
  return true;
}

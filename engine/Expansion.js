import { SIZE, START_REGION_SIZE, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { nextId } from '../simulation/Identity.js';
import { findPath, reachableTiles } from '../simulation/path.js';

const SURVEY_BAND = 32;
const MIN_EXPANSION_TICK = 2 * TIME_TICKS_PER_DAY;
const RETRY_TICKS = TIME_TICKS_PER_DAY;

export function validSurveyDimension(size) {
  return Number.isInteger(size) && size >= START_REGION_SIZE && size <= SIZE && size % SURVEY_BAND === 0;
}

export function validWorldDimension(size) {
  return size === SIZE || (Number.isInteger(size) && size >= START_REGION_SIZE &&
    size <= 128 && size % SURVEY_BAND === 0);
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

export function fixedMapTerrain(seed, oldTerrain, oldWidth, oldHeight) {
  const hash = String(seed).split('').reduce((value, code) => Math.imul(value ^ code.charCodeAt(0), 16777619), 2166136261);
  return Array.from({ length: SIZE * SIZE }, (_, index) => {
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    return x < oldWidth && y < oldHeight ? oldTerrain[y * oldWidth + x] : terrainAt(hash, x, y);
  });
}

export function migrateFixedMap(world) {
  const { map } = world;
  if (map.width === SIZE && map.height === SIZE) return;
  const { width, height, terrain } = map;
  Object.assign(map, {
    terrain: fixedMapTerrain(world.seed, terrain, width, height),
    surveyedWidth: width, surveyedHeight: height, width: SIZE, height: SIZE
  });
}

export function surveyRoute(world, citizen) {
  const { map, worldTimeTick } = world;
  if (worldTimeTick < (map.nextSurveyTick ?? MIN_EXPANSION_TICK) ||
      citizen.profession !== 'adventurer' ||
      world.citizens.some(c => c.alive && c.action.kind === 'survey')) return null;

  const origin = citizen.lastKnownSafeTile;
  const candidates = [];
  if (map.surveyedWidth < map.width) {
    for (let y = 0; y < map.surveyedHeight; y++) candidates.push({ x: map.surveyedWidth - 1, y, direction: 'east' });
  }
  if (map.surveyedHeight < map.height) {
    for (let x = 0; x < map.surveyedWidth; x++) candidates.push({ x, y: map.surveyedHeight - 1, direction: 'south' });
  }
  if (!candidates.length) return null;
  const cost = tile => Math.abs(tile.x - origin.x) + Math.abs(tile.y - origin.y);
  candidates.sort((a, b) => cost(a) - cost(b));
  const reachable = reachableTiles(world, origin);
  const goal = candidates.find(tile => reachable[tile.y * map.width + tile.x] === 1);
  if (goal) return { goal, path: findPath(world, origin, goal) };
  map.nextSurveyTick = worldTimeTick + RETRY_TICKS;
  return null;
}

export function discoverFrontier(world, tile, direction, citizenId) {
  const { map } = world;
  const east = direction === 'east';
  const { surveyedWidth, surveyedHeight } = map;
  if ((!east && direction !== 'south') || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
      tile.x < 0 || tile.x >= surveyedWidth || tile.y < 0 || tile.y >= surveyedHeight ||
      (east ? tile.x !== surveyedWidth - 1 || surveyedWidth >= map.width
        : tile.y !== surveyedHeight - 1 || surveyedHeight >= map.height) ||
      map.terrain[tile.y * map.width + tile.x] === 'water') return false;
  const width = surveyedWidth + (east ? SURVEY_BAND : 0);
  const height = surveyedHeight + (east ? 0 : SURVEY_BAND);
  const reachable = reachableTiles(world, tile);
  const occupied = new Set([
    ...world.resourceNodes, ...world.stockpiles,
    ...world.constructionSites.flatMap(site => Array.from({ length: site.width * site.height },
      (_, i) => ({ x: site.x + i % site.width, y: site.y + Math.floor(i / site.width) })))
  ].map(p => p.y * map.width + p.x));
  const candidates = [];
  for (let y = east ? 0 : surveyedHeight; y < height; y++) {
    for (let x = east ? surveyedWidth : 0; x < width; x++) {
      const index = y * map.width + x;
      if (reachable[index] === 1 && !occupied.has(index)) candidates.push({ x, y });
    }
  }
  for (const [resource, distance, quantity] of [['food', 6, 12], ['wood', 14, 20], ['stone', 22, 30]]) {
    const target = { x: tile.x + (east ? distance : 0), y: tile.y + (east ? 0 : distance) };
    const cost = point => Math.abs(point.x - target.x) + Math.abs(point.y - target.y);
    candidates.sort((a, b) => cost(a) - cost(b));
    const point = candidates.shift();
    if (point) world.resourceNodes.push({ id: nextId(world, 'node'), resource, ...point, quantity });
  }
  Object.assign(map, { surveyedWidth: width, surveyedHeight: height, nextSurveyTick: world.worldTimeTick + RETRY_TICKS });
  emitOnce(world, `frontier/${width}/${height}`, 'frontierDiscovered', { ...tile, citizenId, width, height });
  return true;
}

import {
  SIZE, START_REGION_SIZE, LAYOUT, FRONTIER, POPULATION, TIME_TICKS_PER_YEAR, DECISION_TICKS,
  MAGIC_AFFINITY_THRESHOLD, INITIAL_MAGIC_AFFINITY_MIN_COUNT
} from '../data/balance.js';
import { fixedMapTerrain } from './Expansion.js';
import { random, seedState } from './random.js';
import { buildings, footprint } from '../data/buildings.js';
import { findPath } from '../simulation/path.js';
import { lifespan, nextId, professions } from '../simulation/Identity.js';

const races = ['human', 'elf', 'dwarf'];
const names = ['アルディン', 'ミラ', 'ドルン', 'リナ', 'フィア', 'バルド',
  'ノア', 'エリン', 'ガレン', 'セラ', 'イリス', 'トルン'];

function starterTerrain(state) {
  const size = START_REGION_SIZE;
  const spacing = LAYOUT.noiseSpacing;
  const width = Math.ceil(size / spacing) + 1;
  const noise = Array.from({ length: width ** 2 }, () => random(state));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  const [water, grass, forest] = LAYOUT.thresholds;
  return Array.from({ length: size ** 2 }, (_, i) => {
    const x = (i % size) / spacing;
    const y = Math.floor(i / size) / spacing;
    const cell = Math.floor(y) * width + Math.floor(x);
    const u = smooth(x % 1);
    const v = smooth(y % 1);
    const height = lerp(lerp(noise[cell], noise[cell + 1], u),
      lerp(noise[cell + width], noise[cell + width + 1], u), v);
    return height < water ? 'water' : height < grass ? 'grass' : height < forest ? 'forest' : 'mountain';
  });
}

export function createWorld(seed, { mixedFamilies = false, alliedIntervention = false } = {}) {
  const rngState = seedState(String(seed));
  const center = START_REGION_SIZE / 2;
  const map = { width: SIZE, height: SIZE, terrain: fixedMapTerrain(seed, starterTerrain(rngState), START_REGION_SIZE, START_REGION_SIZE),
    surveyedWidth: START_REGION_SIZE, surveyedHeight: START_REGION_SIZE, navigationVersion: 0 };
  const world = {
    seed: String(seed), rngState, worldTimeTick: 0, gameSpeed: 1, tickRemainder: 0,
    idCounters: {}, map, citizens: [], settlements: [], nations: [], buildings: [],
    resourceNodes: [], stockpiles: [], constructionSites: [], reservations: [],
    inTransit: [], monsters: [], quests: [], researchStates: [], events: [], settings: { ...(mixedFamilies && { mixedFamilies: true }), ...(alliedIntervention && { alliedIntervention: true }) }
  };
  const set = (x, y, terrain) => { map.terrain[y * SIZE + x] = terrain; };
  const settlementId = nextId(world, 'settlement');
  world.settlements.push({ id: settlementId, x: center, y: center, nationId: null });
  const houseId = nextId(world, 'building');
  const house = { id: houseId, kind: 'house', settlementId, x: center, y: center,
    width: buildings.house.width, height: buildings.house.height, capacity: LAYOUT.houseCapacity, state: 'active' };
  world.buildings.push(house);

  for (let dy = -LAYOUT.spawnRadius; dy <= LAYOUT.spawnRadius; dy++) {
    for (let dx = -LAYOUT.spawnRadius; dx <= LAYOUT.spawnRadius; dx++) {
      set(center + dx, center + dy, 'grass');
    }
  }

  const origin = { x: center + 1, y: center - 1 };
  for (const [resource, terrain, quantity, dx, dy] of LAYOUT.nodes) {
    const node = { id: nextId(world, 'node'), resource, quantity, x: center + dx, y: center + dy };
    set(node.x, node.y, terrain);
    world.resourceNodes.push(node);
    if (findPath(world, origin, node) === null) {
      const approach = { x: node.x, y: node.y };
      // Connect the node to the prepared settlement clearing.
      while (Math.abs(approach.x - center) > LAYOUT.spawnRadius ||
             Math.abs(approach.y - center) > LAYOUT.spawnRadius) {
        if (Math.abs(approach.x - center) > LAYOUT.spawnRadius) {
          approach.x -= Math.sign(approach.x - center);
        } else {
          approach.y -= Math.sign(approach.y - center);
        }
        set(approach.x, approach.y, 'grass');
      }
      world.events.push({ id: nextId(world, 'event'), type: 'terrainCorrection',
        worldTimeTick: 0, x: node.x, y: node.y, nodeId: node.id });
    }
  }
  const frontier = { x: center + FRONTIER.dx, y: center + FRONTIER.dy };
  for (let dy = -FRONTIER.clearingRadius; dy <= FRONTIER.clearingRadius; dy++) {
    for (let dx = -FRONTIER.clearingRadius; dx <= FRONTIER.clearingRadius; dx++) {
      set(frontier.x + dx, frontier.y + dy, 'grass');
    }
  }
  if (findPath(world, origin, frontier) === null) {
    for (let x = frontier.x; x < center; x++) set(x, center, 'grass');
    world.events.push({ id: nextId(world, 'event'), type: 'terrainCorrection',
      worldTimeTick: 0, ...frontier });
  }
  for (const [resource, terrain, quantity, dx, dy] of FRONTIER.resources) {
    const node = { id: nextId(world, 'node'), resource, quantity, x: frontier.x + dx, y: frontier.y + dy };
    set(node.x, node.y, terrain);
    world.resourceNodes.push(node);
  }
  map.frontier = frontier;
  const inventory = Object.fromEntries(Object.keys(LAYOUT.provisions).map(resource => [resource, 0]));
  world.stockpiles.push({ id: nextId(world, 'stockpile'), settlementId, ...origin, capacity: LAYOUT.stockpileCapacity,
    total: { ...LAYOUT.provisions }, reserved: { ...inventory } });

  const spawn = [];
  for (let dy = -LAYOUT.spawnRadius; dy <= LAYOUT.spawnRadius; dy++) {
    for (let dx = -LAYOUT.spawnRadius; dx <= LAYOUT.spawnRadius; dx++) {
      const tile = { x: center + dx, y: center + dy };
      if (!footprint(house, tile)) spawn.push(tile);
    }
  }
  for (let i = 0; i < POPULATION; i++) {
    const tile = spawn.splice(Math.floor(random(rngState) * spawn.length), 1)[0];
    const [minAge, maxAge] = LAYOUT.age;
    const years = minAge + Math.floor(random(rngState) * (maxAge - minAge + 1));
    world.citizens.push({
      id: nextId(world, 'citizen'), name: names[i], race: races[i % races.length],
      birthWorldTimeTick: -years * TIME_TICKS_PER_YEAR, alive: true, sex: 'unspecified',
      settlementId, nationId: null, homeBuildingId: i < LAYOUT.houseCapacity ? houseId : null,
      familyId: null, parentIds: [], childIds: [], partnerId: null,
      x: tile.x + 0.5, y: tile.y + 0.5, hp: 100, hunger: 20, fatigue: 10, fear: 0,
      traits: { diligence: random(rngState), bravery: random(rngState),
        curiosity: random(rngState), magicAffinity: random(rngState) },
      skills: { farming: 0, woodcutting: 0, mining: 0, building: 0, combat: 0, magic: 0 },
      profession: professions[i % professions.length], inventory: { ...inventory },
      action: { kind: 'idle', phase: 'plan', targetId: null, startedAt: 0, progress: 0 },
      decisionAt: Math.floor(i * DECISION_TICKS / POPULATION), failedTargets: {},
      lastKnownSafeTile: tile
    });
  }
  for (const citizen of world.citizens) {
    citizen.lifespanYears = lifespan(world, citizen.race);
    citizen.relationships = {};
  }
  const qualifying = world.citizens.filter(citizen => citizen.traits.magicAffinity >= MAGIC_AFFINITY_THRESHOLD);
  const missing = INITIAL_MAGIC_AFFINITY_MIN_COUNT - qualifying.length;
  for (const citizen of world.citizens.filter(c => !qualifying.includes(c)).slice(0, Math.max(0, missing))) {
    citizen.traits.magicAffinity = MAGIC_AFFINITY_THRESHOLD;
  }
  return world;
}

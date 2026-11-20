import { LIFE_CREATION_LIMIT } from '../simulation/DetailLevel.js';
import { LAYOUT, citizenRaces, TERRAIN_COST, TIME_TICKS_PER_YEAR } from '../data/balance.js';
import { footprint } from '../data/buildings.js';
import { monsters } from '../data/combat.js';
import { random } from '../engine/random.js';
import { spawnMonster } from '../simulation/Adventure.js';
import { resources } from '../simulation/Economy.js';
import { lifespan, nextId, professions } from '../simulation/Identity.js';
import { findPath } from '../simulation/path.js';
import { emitOnce } from './History.js';

const scope = 8;
const sumDistance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const cell = person => person.lastKnownSafeTile ?? person;
const same = (a, b) => a.x === b.x && a.y === b.y;

const inBounds = (world, tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y) &&
  tile.x >= 0 && tile.y >= 0 && tile.x < world.map.width && tile.y < world.map.height;
const terrainAt = (world, tile) => world.map.terrain[tile.y * world.map.width + tile.x];
const isStructure = (world, tile) => [...world.buildings, ...world.constructionSites].some(b => footprint(b, tile));
const isOccupied = (world, tile) => isStructure(world, tile) ||
  [...world.citizens, ...world.monsters].some(entity => entity.alive && same(cell(entity), tile));

function placement(world, tile, quantity) {
  if (isOccupied(world, tile)) return [];
  const pending = [tile];
  const visited = new Set();
  const selected = [];
  for (const point of pending) {
    const key = point.x + ',' + point.y;
    if (visited.has(key)) continue;
    visited.add(key);
    if (!inBounds(world, point) || sumDistance(tile, point) > scope ||
        isOccupied(world, point) || terrainAt(world, point) === 'water') continue;
    selected.push(point);
    if (selected.length === quantity) return selected;
    pending.push({ x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 });
  }
  return [];
}

function makeCitizen(world, race, tile) {
  const id = nextId(world, 'citizen');
  const number = Number(id.split(':')[1]);
  const [min, max] = LAYOUT.age;
  const age = min + Math.floor(random(world.rngState) * (max - min + 1));
  const near = world.settlements.filter(s => sumDistance(s, tile) <= scope)
    .sort((a, b) => sumDistance(a, tile) - sumDistance(b, tile))[0];
  const stats = ['diligence', 'bravery', 'curiosity', 'magicAffinity'];
  const traits = Object.fromEntries(stats.map(stat => [stat, random(world.rngState)]));
  traits.magicAffinity = Math.max(traits.magicAffinity, citizenRaces[race].minMagicAffinity ?? 0);
  const skills = Object.fromEntries(['farming', 'woodcutting', 'mining', 'building', 'combat', 'magic'].map(key => [key, 0]));
  return {
    id, name: `住民 ${number}`, race, birthWorldTimeTick: world.worldTimeTick - age * TIME_TICKS_PER_YEAR,
    lifespanYears: lifespan(world, race), alive: true, sex: 'unspecified', settlementId: near?.id ?? null,
    nationId: near?.nationId ?? null, homeBuildingId: null, familyId: null, parentIds: [], childIds: [],
    partnerId: null, relationships: {}, x: tile.x + 0.5, y: tile.y + 0.5, hp: 100, hunger: 20,
    fatigue: 10, fear: 0, traits, skills, profession: professions[(number - 1) % professions.length],
    inventory: Object.fromEntries(resources.map(key => [key, 0])), lastKnownSafeTile: tile,
    action: { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 },
    decisionAt: world.worldTimeTick, failedTargets: {}
  };
}

function editTerrain(world, tile, terrain) {
  if (isStructure(world, tile)) return 'OCCUPIED';
  if (!Object.hasOwn(TERRAIN_COST, terrain)) return 'INVALID_KIND';
  if (terrain === 'water' && (isOccupied(world, tile) ||
      world.citizens.some(c => c.alive && Math.floor(c.x) === tile.x && Math.floor(c.y) === tile.y) ||
      world.resourceNodes.some(n => same(n, tile)) || world.settlements.some(s => same(s, tile)) ||
      world.stockpiles.some(s => same(s, tile)))) return 'OCCUPIED';
  const map = { ...world.map, terrain: world.map.terrain.slice() };
  map.terrain[tile.y * map.width + tile.x] = terrain;
  const candidate = { ...world, map };
  for (const settlement of world.settlements) {
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    const anchor = store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;
    const targets = [...world.resourceNodes.filter(n => !n.dropped),
      ...world.citizens.filter(c => c.alive && c.settlementId === settlement.id).map(cell)];
    if (findPath(candidate, anchor, anchor) === null || targets.some(target =>
      findPath(world, anchor, target) !== null && findPath(candidate, anchor, target) === null)) return 'PATH_DISCONNECTED';
  }
  world.map.terrain = map.terrain;
  world.map.navigationVersion++;
  return null;
}

export function applyGodCommand(world, command) {
  const { commandId, kind, payload } = command;
  if (typeof commandId !== 'string' || !commandId.length || commandId.length > 80 || !payload) return 'INVALID_COMMAND';
  if (world.events.some(e => e.type === 'god_intervention' && e.sourceTransactionId === commandId)) return 'DUPLICATE';
  const tile = { x: payload.x, y: payload.y };
  if (!inBounds(world, tile)) return 'OUT_OF_BOUNDS';
  const { value, quantity } = payload;
  if (kind === 'terrain') {
    const error = editTerrain(world, tile, value);
    if (error) return error;
  } else {
    const maxima = { life: 10, resource: 100, monster: 5 };
    if (!Object.hasOwn(maxima, kind)) return 'INVALID_KIND';
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxima[kind]) return 'INVALID_QUANTITY';
    if (terrainAt(world, tile) === 'water') return 'UNWALKABLE';
    if (kind === 'resource') {
      if (!resources.includes(value)) return 'INVALID_KIND';
      if (isStructure(world, tile)) return 'OCCUPIED';
      world.resourceNodes.push({ id: nextId(world, 'node'), resource: value, quantity, ...tile, dropped: true });
    } else {
      if (kind === 'life' && !Object.hasOwn(citizenRaces, value) || kind === 'monster' && !Object.hasOwn(monsters, value)) return 'INVALID_KIND';
      const limit = kind === 'life' ? LIFE_CREATION_LIMIT : monsters[value].cap;
      const count = kind === 'life' ? world.citizens.filter(c => c.alive).length :
        world.monsters.filter(m => m.alive && m.species === value).length;
      if (count + quantity > limit) return 'LIMIT_REACHED';
      const positions = placement(world, tile, quantity);
      if (!positions.length) return 'OCCUPIED';
      for (const point of positions) {
        if (kind === 'life') world.citizens.push(makeCitizen(world, value, point));
        else spawnMonster(world, value, point);
      }
    }
  }
  emitOnce(world, commandId, 'god_intervention', { ...tile, kind, value, quantity: kind === 'terrain' ? 0 : quantity });
  return null;
}

import { LIFE_CREATION_LIMIT } from '../simulation/DetailLevel.js';
import { citizenRaces, TERRAIN_COST, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { FARM_HARVEST_TICKS, footprint } from '../data/buildings.js';
import { monsters } from '../data/combat.js';
import { createAdult } from '../simulation/CreateAdult.js';
import { spawnMonster } from '../simulation/Adventure.js';
import { resources } from '../simulation/Economy.js';
import { territoryAt } from '../simulation/Territory.js';
import { nextId } from '../simulation/Identity.js';
import { reachableTiles } from '../simulation/path.js';
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

function editTerrain(world, tile, terrain) {
  if (isStructure(world, tile)) return 'OCCUPIED';
  if (!Object.hasOwn(TERRAIN_COST, terrain)) return 'INVALID_KIND';
  if (terrain === 'water' && (isOccupied(world, tile) ||
      world.citizens.some(c => c.alive && Math.floor(c.x) === tile.x && Math.floor(c.y) === tile.y) ||
      world.resourceNodes.some(n => same(n, tile)) || world.settlements.some(s => same(s, tile)) ||
      world.stockpiles.some(s => same(s, tile)))) return 'OCCUPIED';
  const map = { ...world.map, terrain: world.map.terrain.slice() };
  map.terrain[tile.y * map.width + tile.x] = terrain;
  if (terrain === 'water' && terrainAt(world, tile) !== 'water') {
    const candidate = { ...world, map };
    const index = point => point.y * map.width + point.x;
    const nodes = world.resourceNodes.filter(node => !node.dropped);
    for (const settlement of world.settlements) {
      const store = world.stockpiles.find(s => s.settlementId === settlement.id);
      const anchor = store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;
      if (same(anchor, tile)) return 'OCCUPIED';
      const targets = [...nodes, ...world.citizens.filter(c => c.alive && c.settlementId === settlement.id).map(cell)]
        .map(index);
      const before = reachableTiles(world, anchor, undefined, targets);
      const preserved = targets.filter(target => before[target] === 1);
      const after = reachableTiles(candidate, anchor, undefined, preserved);
      if (preserved.some(target => after[target] !== 1)) return 'PATH_DISCONNECTED';
    }
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
  let affectedCitizenIds;
  let affectedFarms;
  let affectedFoodNodes;
  let terrainChange;
  if (kind === 'disaster' && value === 'frost') {
    const until = world.worldTimeTick + TIME_TICKS_PER_DAY;
    affectedFoodNodes = world.resourceNodes.filter(node => node.resource === 'food' && !node.dropped &&
      sumDistance(node, tile) <= 5 && (node.quantity > 0 || (node.renewAt ?? until) < until));
    if (!affectedFoodNodes.length) return 'NO_TARGET';
    for (const node of affectedFoodNodes) {
      node.quantity = 0;
      node.renewAt = Math.max(node.renewAt ?? 0, until);
      node.frostCommandId = commandId;
    }
  } else if (kind === 'disaster') {
    if (value !== 'drought') return 'INVALID_KIND';
    const until = world.worldTimeTick + TIME_TICKS_PER_DAY;
    affectedFarms = world.buildings.filter(b => b.kind === 'farm' && sumDistance(b, tile) <= 5 &&
      (b.harvestAt ?? b.completedAt + FARM_HARVEST_TICKS) < until);
    if (!affectedFarms.length) return 'NO_TARGET';
    for (const farm of affectedFarms) {
      farm.harvestAt = until;
      farm.droughtCommandId = commandId;
    }
  } else if (kind === 'blessing' && value === 'fertility') {
    affectedFarms = world.buildings.filter(b => b.kind === 'farm' && sumDistance(b, tile) <= 5 &&
      (b.harvestAt ?? b.completedAt + FARM_HARVEST_TICKS) > world.worldTimeTick);
    if (!affectedFarms.length) return 'NO_TARGET';
    for (const farm of affectedFarms) farm.harvestAt = world.worldTimeTick;
  } else if (kind === 'blessing') {
    if (value !== 'recovery') return 'INVALID_KIND';
    const affected = world.citizens.filter(c => c.alive && sumDistance(cell(c), tile) <= 3 &&
      (c.hp < 100 || c.fear > 0));
    if (!affected.length) return 'NO_TARGET';
    for (const citizen of affected) {
      citizen.hp = Math.min(100, citizen.hp + 25);
      citizen.fear = Math.max(0, citizen.fear - 20);
    }
    affectedCitizenIds = affected.map(c => c.id);
  } else if (kind === 'terrain') {
    const before = terrainAt(world, tile);
    let terrain = value;
    if (value === 'undo') {
      const previous = world.events.findLast(event => event.type === 'god_intervention' &&
        event.kind === 'terrain' && same(event, tile));
      if (!previous?.terrainChange || previous.value === 'undo' || previous.terrainChange.after !== before) {
        return 'NO_TARGET';
      }
      terrain = previous.terrainChange.before;
    }
    const error = editTerrain(world, tile, terrain);
    if (error) return error;
    terrainChange = { before, after: terrain };
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
        if (kind === 'life') {
          const near = world.settlements.filter(s => sumDistance(s, point) <= scope)
            .sort((a, b) => sumDistance(a, point) - sumDistance(b, point))[0];
          world.citizens.push(createAdult(world, value, point, near));
        } else {
          spawnMonster(world, value, point);
        }
      }
    }
  }
  emitOnce(world, commandId, 'god_intervention', {
    ...tile, kind, value, quantity: affectedCitizenIds?.length ?? affectedFarms?.length ?? affectedFoodNodes?.length ?? (kind === 'terrain' ? 0 : quantity),
    ...(terrainChange && { terrainChange }),
    ...(affectedCitizenIds && { affectedCitizenIds }),
    ...(affectedFoodNodes && {
      affectedNodeIds: affectedFoodNodes.map(node => node.id),
      nationIds: [...new Set(affectedFoodNodes.map(node => territoryAt(world, node)).filter(Boolean))]
    }),
    ...(affectedFarms && {
      affectedBuildingIds: affectedFarms.map(b => b.id),
      nationIds: [...new Set(world.settlements.filter(s =>
        s.nationId && affectedFarms.some(b => b.settlementId === s.id)).map(s => s.nationId))]
    })
  });
  return null;
}

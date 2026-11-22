import { emitOnce } from '../systems/History.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { commissionGear, recordAdventureSuccess, trainCombat } from './AdventurerGrowth.js';
import { COMBAT, gear, monsters } from '../data/combat.js';
import { ADULT_AGE, START_REGION_SIZE, FOOD_HUNGER_RESTORED, FOOD_TARGET_PER_PERSON, GATHER_BATCH, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { random } from '../engine/random.js';
import { ageYears, nextId } from './Identity.js';
import { available, deposit, storageRoom, storeTile } from './Economy.js';
import { recordDeath } from './Population.js';
import { campaignFor } from './War.js';
import { findPath, reachableTiles } from './path.js';

const manaSurvey = { radius: 4, reserve: 5, quantity: 5 };

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tileOf = citizen => citizen.lastKnownSafeTile;
const tileKey = ({ x, y }) => x + ',' + y;

function emit(world, type, quest, tile, extra = {}) {
  emitOnce(world, quest.id, type, { questId: quest.id, settlementId: quest.settlementId,
    x: tile.x, y: tile.y, ...extra });
}

export function spawnMonster(world, species, tile) {
  const config = monsters[species];
  if (!config || world.monsters.filter(m => m.alive && m.species === species).length >= config.cap ||
      !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 ||
      tile.x >= world.map.width || tile.y >= world.map.height ||
      findPath(world, tile, tile) === null ||
      world.monsters.some(m => m.alive && m.x === tile.x && m.y === tile.y)) return null;
  const monster = { id: nextId(world, 'monster'), species, x: tile.x, y: tile.y, alive: true,
    homeTile: { x: tile.x, y: tile.y }, hp: config.hp, maxHp: config.hp, attackAt: 0, moveAt: world.worldTimeTick + config.stepTicks };
  world.monsters.push(monster);
  return monster;
}

function spawnZones(world) {
  const forbidden = new Set();
  const protect = (origin, radius) => {
    for (let dy = 1 - radius; dy < radius; dy++) {
      for (let dx = 1 - radius; dx < radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < radius) {
          forbidden.add(tileKey({ x: origin.x + dx, y: origin.y + dy }));
        }
      }
    }
  };
  for (const settlement of world.settlements) protect(settlement, COMBAT.spawnDistance);
  for (const citizen of world.citizens) {
    if (citizen.alive) protect(tileOf(citizen), COMBAT.residentSafety);
  }
  return forbidden;
}

function spawnAway(world, species, forbidden, habitatOnly = false, settlement = null) {
  const candidates = [];
  const occupied = new Set(world.monsters.filter(m => m.alive).map(tileKey));
  const bounds = { width: world.map.surveyedWidth ?? world.map.width,
    height: world.map.surveyedHeight ?? world.map.height };
  const radius = COMBAT.dispersalRadius;
  const minX = settlement ? Math.max(0, settlement.x - radius) : 0;
  const minY = settlement ? Math.max(0, settlement.y - radius) : 0;
  const maxX = settlement ? Math.min(bounds.width, settlement.x + radius + 1) : bounds.width;
  const maxY = settlement ? Math.min(bounds.height, settlement.y + radius + 1) : bounds.height;
  const store = settlement && world.stockpiles.find(s => s.settlementId === settlement.id);
  const reachable = settlement && reachableTiles(world, store ? storeTile(world, store) : settlement,
    null, null, bounds);
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const tile = { x, y };
      if (settlement && (distance(tile, settlement) > radius || reachable[y * world.map.width + x] !== 1)) continue;
      const terrain = world.map.terrain[y * world.map.width + x];
      const key = tileKey(tile);
      if (!forbidden.has(key) && !occupied.has(key) && terrain !== 'water' &&
          (!habitatOnly || monsters[species].habitat.includes(terrain)) &&
          (!monsters[species].requiresExpansion || x >= START_REGION_SIZE || y >= START_REGION_SIZE)) {
        candidates.push(tile);
      }
    }
  }
  const { prey, sight } = monsters[species];
  const preyHomes = prey ? world.monsters.filter(m => m.alive && m.species === prey) : [];
  const nearPrey = candidates.filter(tile => preyHomes.some(m =>
    distance(tile, m) <= sight && findPath(world, tile, m) !== null));
  const tried = new Set();
  for (const pool of [nearPrey, candidates]) {
    while (pool.length) {
      const index = Math.floor(random(world.rngState) * pool.length);
      const [tile] = pool.splice(index, 1);
      if (tried.has(tile)) continue;
      tried.add(tile);
      const monster = spawnMonster(world, species, tile);
      if (monster) return monster;
    }
  }
  return null;
}

function replenishSpecies(world, species, forbidden) {
  const config = monsters[species];
  const population = world.monsters.filter(m => m.alive && m.species === species);
  const lastDeath = world.monsters.reduce((time, m) =>
    m.species === species && !m.alive ? Math.max(time, m.diedAt ?? 0) : time, 0);
  const canImmigrate = world.worldTimeTick - lastDeath >= TIME_TICKS_PER_DAY;
  if (species === 'goblin' && canImmigrate) {
    for (const settlement of world.settlements) {
      if (world.citizens.some(c => c.alive && c.settlementId === settlement.id) &&
          population.every(m => distance(m.homeTile, settlement) > COMBAT.dispersalRadius) &&
          spawnAway(world, species, forbidden, true, settlement)) return true;
    }
  }
  for (const parent of population) {
    const home = parent.homeTile;
    const homeTerrain = world.map.terrain[home.y * world.map.width + home.x];
    if (parent.relocating || world.worldTimeTick < (parent.nextBreedAt ?? 0) || distance(parent, home) > 4 ||
        !config.habitat.includes(homeTerrain) || findPath(world, home, home) === null) continue;
    const colony = population.filter(m => distance(m.homeTile, home) <= 6).length;
    if (colony >= 3 || nestQuestFor(world, parent)?.status === 'claimed') continue;
    const candidates = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tile = { x: home.x + dx, y: home.y + dy };
        if (tile.x < 0 || tile.x >= world.map.width || tile.y < 0 || tile.y >= world.map.height ||
            forbidden.has(tileKey(tile)) ||
            !config.habitat.includes(world.map.terrain[tile.y * world.map.width + tile.x])) continue;
        candidates.push(tile);
      }
    }
    while (candidates.length) {
      const index = Math.floor(random(world.rngState) * candidates.length);
      const newborn = spawnMonster(world, species, candidates.splice(index, 1)[0]);
      if (!newborn) continue;
      newborn.parentMonsterId = parent.id;
      newborn.homeTile = { ...home };
      const founded = !population.some(member => member.hasNest && sameNest(member, parent));
      newborn.hasNest = parent.hasNest = true;
      if (founded) emitOnce(world, newborn.id, 'monsterNestFounded', { ...home, species });
      newborn.nextBreedAt = parent.nextBreedAt = world.worldTimeTick + TIME_TICKS_PER_DAY;
      return true;
    }
  }
  // Immigration restores a locally extinct species after a quiet day.
  return !population.length && canImmigrate &&
    Boolean(spawnAway(world, species, forbidden, true));
}

const activeQuest = quest => quest.status === 'open' || quest.status === 'claimed';
const sameNest = (a, b) => a.species === b.species && distance(a.homeTile, b.homeTile) === 0;

export function offerTradeEscort(world, settlement, partner, destination, path) {
  if (!world.buildings.some(b => b.kind === 'guild' && b.settlementId === settlement.id) ||
      world.quests.filter(q => q.settlementId === settlement.id && activeQuest(q)).length >= COMBAT.questLimit ||
      world.citizens.filter(c => c.alive && c.profession === 'adventurer' &&
        c.settlementId === settlement.id && ageYears(world, c) >= ADULT_AGE).length < 2) return;
  const threats = world.monsters.filter(monster => monster.alive && monsters[monster.species].attack >= monsters.goblin.attack);
  const lastDanger = path.findLastIndex(tile => threats.some(monster => distance(tile, monster) <= 5));
  if (lastDanger < 0 || lastDanger >= COMBAT.tradeEscortRadius) return;
  const steps = Math.min(path.length, COMBAT.tradeEscortRadius, lastDanger + 2);
  const goal = path.length <= COMBAT.tradeEscortRadius ? destination : path[steps - 1];
  const escortDistance = path.length <= COMBAT.tradeEscortRadius ? path.length : steps;
  const quest = { id: nextId(world, 'quest'), kind: 'escort_trade', settlementId: settlement.id,
    partnerId: partner.id, escortGoal: { x: goal.x, y: goal.y }, status: 'open',
    claimedBy: null, createdAt: world.worldTimeTick, expiresAt: world.worldTimeTick + Math.max(4, Math.ceil(escortDistance / 12)) * COMBAT.questDuration, lootIds: [] };
  world.quests.push(quest);
  return quest.id;
}

export function assignedAdventure(world, citizen) {
  return world.quests.find(q => q.status === 'claimed' && (q.claimedBy === citizen.id || q.escortId === citizen.id));
}

function nestQuestFor(world, monster) {
  return world.quests.find(q => activeQuest(q) && q.kind === 'clear_nest' &&
    q.species === monster.species && distance(q.nestTile, monster.homeTile) === 0);
}

function promoteNestQuest(world, quest, target) {
  if (!target.hasNest || world.quests.some(other => other !== quest && activeQuest(other) &&
      world.monsters.some(m => m.id === other.targetId && sameNest(m, target)))) return false;
  Object.assign(quest, { kind: 'clear_nest', species: target.species, nestTile: { ...target.homeTile },
    expiresAt: world.worldTimeTick + COMBAT.questDuration * 2, rewardFood: COMBAT.rewardFood * 2 });
  return true;
}

export function issueQuest(world, settlement, target, allowNest = true) {
  if (!target?.alive || nestQuestFor(world, target) ||
      world.quests.some(q => q.targetId === target.id && activeQuest(q))) {
    return null;
  }
  const quest = { id: nextId(world, 'quest'), kind: 'clear_monsters', settlementId: settlement.id,
    targetId: target.id, rewardFood: COMBAT.rewardFood, status: 'open', claimedBy: null,
    createdAt: world.worldTimeTick, expiresAt: world.worldTimeTick + COMBAT.questDuration, lootIds: [] };
  if (allowNest) promoteNestQuest(world, quest, target);
  world.quests.push(quest);
  return quest;
}

export function isQuestCargo(world, node) {
  if (!node.dropped) return false;
  return world.quests.some(q => q.status === 'claimed' &&
    (q.id === node.questId || (q.kind === 'recover_supplies' && q.targetId === node.id)));
}

function offerRecovery(world, settlement, store, origin) {
  if (!store || !world.buildings.some(b => b.kind === 'guild' && b.settlementId === settlement.id) ||
      world.citizens.filter(c => c.alive && c.settlementId === settlement.id && c.profession === 'adventurer').length < 2 ||
      world.quests.some(q => q.kind === 'recover_supplies' && q.settlementId === settlement.id && activeQuest(q))) return false;
  const foodTarget = world.citizens.filter(c => c.alive && c.settlementId === settlement.id).length * FOOD_TARGET_PER_PERSON;
  const minimum = settlement.foodWarning ? 4 : 2;
  const piles = world.resourceNodes.filter(n => n.dropped && !n.questId && n.quantity >= minimum &&
    (!settlement.foodWarning || n.resource === 'food') && storageRoom(store, n.resource, foodTarget) >= minimum &&
    distance(origin, n) >= 8 && distance(origin, n) <= 32 &&
    !world.quests.some(q => q.targetId === n.id && activeQuest(q)));
  const target = piles.sort((a, b) => distance(origin, a) - distance(origin, b))
    .find(node => findPath(world, origin, node) !== null);
  if (!target) return false;
  world.quests.push({ id: nextId(world, 'quest'), kind: 'recover_supplies', settlementId: settlement.id,
    targetId: target.id, status: 'open', claimedBy: null, createdAt: world.worldTimeTick,
    expiresAt: world.worldTimeTick + COMBAT.questDuration, lootIds: [] });
  return true;
}

function canProspect(world, store, settlementId) {
  return available(store, 'manaStone') < manaSurvey.reserve && unlocked(world, settlementId, 'steel_1');
}

function openMountain(world, tile) {
  const { map } = world;
  return tile.x >= 0 && tile.y >= 0 && tile.x < map.surveyedWidth && tile.y < map.surveyedHeight &&
    map.terrain[tile.y * map.width + tile.x] === 'mountain' &&
    !world.resourceNodes.some(node => distance(tile, node) === 0) &&
    !world.stockpiles.some(store => distance(tile, store) === 0) &&
    !world.constructionSites.some(site => tile.x >= site.x && tile.x < site.x + site.width &&
      tile.y >= site.y && tile.y < site.y + site.height);
}

function manaProspect(world, node, store, settlementId) {
  if (node.resource !== 'stone' || !canProspect(world, store, settlementId) ||
      world.quests.some(q => q.targetId === node.id && q.discoveredNodeId)) return null;

  const nearby = [];
  for (let dy = -manaSurvey.radius; dy <= manaSurvey.radius; dy++) {
    const reach = manaSurvey.radius - Math.abs(dy);
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx || dy) nearby.push({ x: node.x + dx, y: node.y + dy });
    }
  }
  nearby.sort((a, b) => distance(node, a) - distance(node, b));
  return nearby.find(tile => openMountain(world, tile) && findPath(world, node, tile) !== null);
}

function mountainSurveyTarget(world, origin, surveys) {
  const assigned = new Set(surveys.filter(q => q.prospectTile && activeQuest(q)).map(q => tileKey(q.prospectTile)));
  const candidates = [];
  for (let dy = -24; dy <= 24; dy++) {
    const reach = 24 - Math.abs(dy);
    for (let dx = -reach; dx <= reach; dx++) {
      if (Math.abs(dx) + Math.abs(dy) < 6) continue;
      const tile = { x: origin.x + dx, y: origin.y + dy };
      if (openMountain(world, tile) && !assigned.has(tileKey(tile))) candidates.push(tile);
    }
  }
  if (!candidates.length) return null;
  const reachable = reachableTiles(world, origin, undefined, candidates.map(tile => tile.y * world.map.width + tile.x));
  candidates.sort((a, b) => distance(origin, a) - distance(origin, b));
  return candidates.find(tile => reachable[tile.y * world.map.width + tile.x] === 1);
}

function surveyTarget(world, quest) {
  return quest.prospectTile ?? world.resourceNodes.find(node => node.id === quest.targetId);
}

function offerSurvey(world, settlement, store, origin, prospectOnly) {
  if (!store || settlement.foodWarning || available(store, 'food') < 4 ||
      !world.buildings.some(b => b.kind === 'guild' && b.settlementId === settlement.id) ||
      world.citizens.filter(c => c.alive && c.profession === 'adventurer' && c.settlementId === settlement.id).length < 2 ||
      world.quests.some(q => q.kind === 'survey_resources' && q.settlementId === settlement.id && activeQuest(q))) return;
  const surveys = world.quests.filter(q => q.kind === 'survey_resources');
  const assigned = new Set(surveys.filter(activeQuest).map(q => q.targetId));
  const surveyed = new Set(surveys.filter(q => q.status === 'completed' &&
    q.settlementId === settlement.id).map(q => q.targetId));
  const destinations = world.resourceNodes.filter(node => !node.dropped &&
    distance(origin, node) <= 24 && !assigned.has(node.id));
  destinations.sort((a, b) => distance(origin, a) - distance(origin, b));
  const prospect = destinations.find(node => manaProspect(world, node, store, settlement.id) &&
    findPath(world, origin, node) !== null);
  const prospectTile = !prospect && canProspect(world, store, settlement.id)
    ? mountainSurveyTarget(world, origin, surveys) : null;
  const target = prospect ?? (prospectTile || prospectOnly ? null : destinations.find(node => node.quantity > 0 &&
    !surveyed.has(node.id) && distance(origin, node) >= 12 && findPath(world, origin, node) !== null));
  if (!target && !prospectTile) return;
  world.quests.push({ id: nextId(world, 'quest'), kind: 'survey_resources', settlementId: settlement.id,
    ...(prospectTile ? { prospectTile } : { targetId: target.id }),
    status: 'open', claimedBy: null, createdAt: world.worldTimeTick,
    expiresAt: world.worldTimeTick + 2 * COMBAT.questDuration, lootIds: [] });
  return true;
}

function claimSurvey(world, citizen, quest, store, travel) {
  const node = quest.escortGoal ?? surveyTarget(world, quest);
  if (!node || available(store, 'food') < 4 ||
      world.settlements.find(s => s.id === quest.settlementId)?.foodWarning) return false;
  const escort = findEscort(world, citizen, candidate => findPath(world, tileOf(candidate), node) !== null);
  if (!escort || !travel(node, 'adventure', quest.id)) return false;
  store.total.food -= 2;
  citizen.inventory.food++;
  escort.inventory.food++;
  Object.assign(quest, { status: 'claimed', stage: 'survey', claimedBy: citizen.id, escortId: escort.id, surveyVisitors: [] });
  emit(world, quest.kind === 'escort_trade' ? 'tradeEscortDeparted' : 'resourceSurveyDeparted', quest, tileOf(citizen), { actorIds: [citizen.id, escort.id] });
  return true;
}

function continueSurvey(world, citizen, quest, store, origin, travel) {
  const lead = citizen.id === quest.claimedBy;
  if (!lead && quest.escortReturned) return true;
  const escortAlive = world.citizens.some(candidate => candidate.id === quest.escortId && candidate.alive);
  const node = quest.escortGoal ?? surveyTarget(world, quest);
  const tile = tileOf(citizen);
  if (quest.stage === 'survey') {
    if (!escortAlive || citizen.hunger >= NEEDS.eat || citizen.hp <= COMBAT.retreatHp) {
      quest.retreated = true;
      quest.stage = 'return';
      delete quest.escortSpell;
    } else {
      if (quest.escortSpell) return true;
      if (distance(tile, node)) {
        if (travel(node, 'adventure', quest.id)) return true;
        quest.retreated = true;
        quest.stage = 'return';
      } else {
        if (!quest.surveyVisitors.includes(citizen.id)) quest.surveyVisitors.push(citizen.id);
        if (quest.surveyVisitors.length < 2) return true;
        quest.stage = 'return';
        quest.surveyQuantity = node.quantity ?? 0;
      }
    }
  }
  if (distance(tile, origin)) return travel(origin, 'adventure', quest.id);
  const population = world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length;
  deposit(citizen, store, population * FOOD_TARGET_PER_PERSON);
  if (!lead) {
    quest.escortReturned = true;
    return true;
  }
  if (escortAlive && !quest.escortReturned) return true;
  quest.status = quest.retreated || !escortAlive ? 'retreated' : 'completed';
  if (quest.status === 'completed') {
    const actors = [citizen.id, quest.escortId];
    if (quest.kind === 'escort_trade') {
      emit(world, 'tradeEscortReturned', quest, node, { actorIds: actors, sourceSettlementId: quest.partnerId });
      return false;
    }
    if (!quest.prospectTile) emit(world, 'resourceSurveyReturned', quest, node, {
      actorIds: actors, resource: node.resource, quantity: quest.surveyQuantity
    });
    const prospect = quest.prospectTile
      ? openMountain(world, node) && findPath(world, origin, node) !== null && node
      : manaProspect(world, node, store, quest.settlementId);
    if (prospect) {
      const vein = { id: nextId(world, 'node'), ...prospect, resource: 'manaStone', quantity: manaSurvey.quantity };
      world.resourceNodes.push(vein);
      quest.discoveredNodeId = vein.id;
      emit(world, 'manaVeinDiscovered', quest, vein, { actorIds: actors, quantity: vein.quantity });
    }
  }
  return false;
}

function findEscort(world, citizen, reachable) {
  const leaderId = world.nations.find(n => n.id === citizen.nationId)?.leaderId;
  return world.citizens.find(c => c !== citizen && c.alive && c.settlementId === citizen.settlementId &&
    ageYears(world, c) >= ADULT_AGE && c.profession === 'adventurer' && c.action.kind === 'idle' && c.hp >= 70 &&
    c.hunger < NEEDS.eat && c.fatigue < NEEDS.sleep && !c.expeditionId && c.id !== leaderId &&
    !world.inTransit.some(item => item.carrierId === c.id) &&
    !assignedAdventure(world, c) && !campaignFor(world, c) && reachable(c));
}

function claimRecovery(world, citizen, quest, store, travel) {
  const node = world.resourceNodes.find(n => n.id === quest.targetId);
  if (!node || node.quantity < 2 || available(store, 'food') < 2) return false;
  const home = world.settlements.find(s => s.id === quest.settlementId);
  if (home?.foodWarning && (node.resource !== 'food' || node.quantity < 4)) return false;
  const foodTarget = world.citizens.filter(c => c.alive && c.settlementId === quest.settlementId).length * FOOD_TARGET_PER_PERSON;
  const room = storageRoom(store, node.resource, foodTarget);
  const pickupAmount = Math.min(GATHER_BATCH, Math.floor(Math.min(node.quantity, room) / 2));
  if (pickupAmount < (home?.foodWarning ? 2 : 1)) return false;
  const escort = findEscort(world, citizen, c => findPath(world, tileOf(c), node) !== null);
  if (!escort || !travel(node, 'adventure', quest.id)) return false;
  store.total.food -= 2;
  citizen.inventory.food++;
  escort.inventory.food++;
  Object.assign(quest, { status: 'claimed', stage: 'recover', claimedBy: citizen.id,
    escortId: escort.id, provision: 1, recoveredBy: {}, pickupAmount });
  emit(world, 'supplyRecoveryDeparted', quest, tileOf(citizen), { actorIds: [citizen.id, escort.id] });
  return true;
}

function continueRecovery(world, citizen, quest, store, origin, travel) {
  const node = world.resourceNodes.find(n => n.id === quest.targetId);
  const tile = tileOf(citizen);
  const isLead = citizen.id === quest.claimedBy;
  const escort = world.citizens.find(c => c.id === quest.escortId && c.alive);
  if (!isLead && quest.escortReturned) return true;
  if (!escort || (quest.stage === 'recover' && (citizen.hunger >= NEEDS.eat || citizen.hp <= COMBAT.retreatHp))) {
    quest.retreated = true;
    quest.stage = 'return';
  }
  if (quest.stage === 'recover' && !Object.hasOwn(quest.recoveredBy, citizen.id)) {
    if (distance(tile, node) && travel(node, 'adventure', quest.id)) return true;
    const quantity = distance(tile, node) ? 0 : Math.min(node.quantity, quest.pickupAmount);
    citizen.inventory[node.resource] += quantity;
    node.quantity -= quantity;
    quest.recoveredBy[citizen.id] = quantity;
  }
  if (distance(tile, origin)) return travel(origin, 'adventure', quest.id);
  const population = world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length;
  deposit(citizen, store, population * FOOD_TARGET_PER_PERSON);
  if (!isLead) {
    quest.escortReturned = true;
    return true;
  }
  if (escort && !quest.escortReturned) return true;
  const quantity = Object.values(quest.recoveredBy).reduce((sum, value) => sum + value, 0);
  quest.status = quest.retreated || !quantity ? 'retreated' : 'completed';
  emit(world, 'supplyRecoveryReturned', quest, origin, { actorIds: [citizen.id, quest.escortId], quantity, resource: node.resource });
  return false;
}

function pursuePrey(world, predator, config) {
  const claimed = monster => world.quests.some(q => q.status === 'claimed' && q.targetId === monster.id) ||
    nestQuestFor(world, monster)?.status === 'claimed';
  if (!config.prey || claimed(predator)) return null;
  const targets = world.monsters.filter(m => m.alive && m.species === config.prey &&
    distance(predator, m) <= config.sight && distance(predator.homeTile, m) <= COMBAT.wanderRadius &&
    !claimed(m)).sort((a, b) => distance(predator, a) - distance(predator, b));
  for (const target of targets) {
    if (distance(predator, target) <= 1) return predator;
    const next = findPath(world, predator, target)?.[0];
    if (next && distance(predator.homeTile, next) <= COMBAT.wanderRadius) return next;
  }
  return null;
}

function relocateDisplacedNests(world) {
  const { width, height, terrain } = world.map;
  const bounds = { width: world.map.surveyedWidth ?? width, height: world.map.surveyedHeight ?? height };
  const colonies = new Map();
  for (const monster of world.monsters) {
    if (!monster.alive || !monster.hasNest) continue;
    const key = monster.species + '/' + tileKey(monster.homeTile);
    if (!colonies.has(key)) colonies.set(key, []);
    colonies.get(key).push(monster);
  }
  const activeTargets = new Set(world.quests.filter(q => q.status === 'claimed').map(q => q.targetId));
  for (const colony of colonies.values()) {
    const leader = colony[0];
    const from = leader.homeTile;
    const habitat = monsters[leader.species].habitat;
    if (habitat.includes(terrain[from.y * width + from.x]) && findPath(world, from, from) !== null) continue;
    if (nestQuestFor(world, leader)?.status === 'claimed' || colony.some(m => activeTargets.has(m.id))) continue;

    const forbidden = spawnZones(world);
    const candidates = [];
    for (let y = Math.max(0, from.y - COMBAT.wanderRadius); y < Math.min(bounds.height, from.y + COMBAT.wanderRadius + 1); y++) {
      for (let x = Math.max(0, from.x - COMBAT.wanderRadius); x < Math.min(bounds.width, from.x + COMBAT.wanderRadius + 1); x++) {
        const tile = { x, y };
        if (distance(from, tile) <= COMBAT.wanderRadius && habitat.includes(terrain[y * width + x]) &&
            !forbidden.has(tileKey(tile)) && world.monsters.every(m => !m.alive || distance(m.homeTile, tile) > 0)) {
          candidates.push(tile);
        }
      }
    }
    candidates.sort((a, b) => distance(from, a) - distance(from, b));
    const destination = candidates.find(tile => colony.every(m => findPath(world, m, tile, bounds) !== null));
    if (!destination) continue;

    const quest = nestQuestFor(world, leader);
    if (quest) quest.status = 'expired';
    for (const monster of colony) {
      monster.homeTile = { ...destination };
      monster.relocating = true;
    }
    emitOnce(world, leader.id + '/relocate/' + world.worldTimeTick, 'monsterNestRelocated', {
      ...destination, fromX: from.x, fromY: from.y, species: leader.species, quantity: colony.length
    });
  }
}

function moveMonsters(world) {
  const reserved = new Set(world.monsters.filter(m => m.alive).map(tileKey));
  for (const monster of world.monsters) {
    if (!monster.alive || world.worldTimeTick < monster.moveAt) continue;
    const config = monsters[monster.species];
    if (monster.relocating && distance(monster, monster.homeTile) <= 1) delete monster.relocating;
    monster.moveAt = world.worldTimeTick + config.stepTicks;
    const quest = world.quests.find(q => q.status === 'claimed' && q.targetId === monster.id && q.stage === 'fight');
    const opponent = quest && world.citizens.find(c => c.alive && c.id === quest.claimedBy);
    const distanceToOpponent = opponent ? distance(monster, tileOf(opponent)) : Infinity;
    if (distanceToOpponent <= COMBAT.rangedDistance) continue;
    let tile;
    if (distanceToOpponent <= config.sight) {
      tile = findPath(world, monster, tileOf(opponent))?.[0];
    } else if (monster.relocating || distance(monster, monster.homeTile) >= COMBAT.wanderRadius) {
      tile = findPath(world, monster, monster.homeTile)?.[0];
    } else {
      tile = pursuePrey(world, monster, config);
      if (!tile) {
        const offsets = [[0, -1], [-1, 0], [1, 0], [0, 1], [0, 0]];
        const [dx, dy] = offsets[Math.floor(random(world.rngState) * offsets.length)];
        const goal = { x: monster.x + dx, y: monster.y + dy };
        tile = findPath(world, goal, goal) === null ? null : goal;
      }
    }
    if (!tile || reserved.has(tileKey(tile)) ||
        world.settlements.some(s => distance(s, tile) < COMBAT.residentSafety)) continue;
    reserved.delete(tileKey(monster));
    Object.assign(monster, tile);
    reserved.add(tileKey(monster));
  }
}

function huntPrey(world) {
  const protectedTargets = new Set(world.quests.filter(q => q.status === 'claimed').map(q => q.targetId));
  for (const predator of world.monsters) {
    const { prey, huntDamage } = monsters[predator.species];
    if (!predator.alive || !prey || protectedTargets.has(predator.id)) continue;
    const target = world.monsters.find(m => m.alive && m.species === prey &&
      !protectedTargets.has(m.id) && nestQuestFor(world, m)?.status !== 'claimed' && distance(predator, m) === 1);
    if (!target) continue;
    target.hp = Math.max(0, target.hp - huntDamage);
    if (target.hp > 0) continue;
    target.alive = false;
    target.diedAt = world.worldTimeTick;
    for (const quest of world.quests) {
      if (quest.targetId !== target.id || quest.status !== 'open') continue;
      const replacement = quest.kind === 'clear_nest' && world.monsters.find(m => m.alive && sameNest(m, target));
      if (replacement) quest.targetId = replacement.id;
      else quest.status = 'expired';
    }
    emitOnce(world, target.id + '/predation', 'monsterPredation', {
      monsterId: target.id, predatorId: predator.id, x: target.x, y: target.y
    });
  }
}

function canCastSpell(world, citizen) {
  return citizen.skills.magic > 0 && (citizen.mp ?? 0) >= TECH.spellMp &&
    world.worldTimeTick >= (citizen.spellReadyAt ?? 0) && unlocked(world, citizen.settlementId, 'magic_1');
}

function spendSpell(world, citizen) {
  citizen.mp -= TECH.spellMp;
  citizen.spellReadyAt = world.worldTimeTick + TECH.spellCooldownTicks;
}

function spellPower(world, citizen) {
  const arcane = unlocked(world, citizen.settlementId, 'magic_2') ? TECH.arcaneSpellBonus : 0;
  return TECH.spellAttack + arcane + (gear[citizen.gearId]?.spellAttack ?? 0);
}

function bindMonster(world, quest, monster, citizen) {
  if (quest.boundTargetId === monster.id || monsters[monster.species].attack < monsters.goblin.attack ||
      !unlocked(world, citizen.settlementId, 'binding_1')) return false;
  const until = world.worldTimeTick + COMBAT.interval;
  monster.moveAt = Math.max(monster.moveAt, until);
  monster.attackAt = Math.max(monster.attackAt, until);
  quest.boundTargetId = monster.id;
  emitOnce(world, quest.id + '/' + monster.id, 'monsterBound', {
    citizenId: citizen.id, settlementId: citizen.settlementId, questId: quest.id,
    monsterId: monster.id, x: monster.x, y: monster.y
  });
  return true;
}

function resolveEscortEncounter(world, quest, lead) {
  const partner = world.citizens.find(citizen => citizen.id === quest.escortId && citizen.alive);
  if (!partner) {
    delete quest.escortSpell;
    return;
  }
  const team = [lead, partner];
  const now = world.worldTimeTick;
  const spell = quest.escortSpell;
  const enemy = spell
    ? world.monsters.find(monster => monster.alive && monster.id === spell.monsterId)
    : world.monsters.find(monster => monster.alive && now >= monster.attackAt &&
      monsters[monster.species].attack >= monsters.goblin.attack &&
      team.some(member => distance(tileOf(member), monster) <= COMBAT.rangedDistance));
  if (!enemy) {
    delete quest.escortSpell;
    return;
  }
  const melee = team.filter(member => distance(tileOf(member), enemy) <= COMBAT.rangedDistance);
  const eligible = member => member.hp > COMBAT.retreatHp && member.hunger < NEEDS.eat &&
    distance(tileOf(member), enemy) <= TECH.spellRange && canCastSpell(world, member);
  const caster = spell ? team.find(member => member.id === spell.casterId && eligible(member)) : team.find(eligible);
  if (spell && !caster) {
    delete quest.escortSpell;
    return;
  }
  if (!spell && caster) {
    const tile = tileOf(caster);
    caster.x = tile.x + 0.5;
    caster.y = tile.y + 0.5;
    caster.action = { kind: 'adventure', phase: 'perform', targetId: quest.id, startedAt: now, progress: 0 };
    quest.escortSpell = { casterId: caster.id, monsterId: enemy.id, readyAt: now + TECH.spellCastTicks };
    return;
  }
  if (spell && now < spell.readyAt) return;
  delete quest.escortSpell;

  let bound = false;
  let spellAttack = 0;
  if (caster) {
    spendSpell(world, caster);
    bound = bindMonster(world, quest, enemy, caster);
    if (!bound) spellAttack = spellPower(world, caster);
    emitOnce(world, [quest.id, enemy.id, now].join('/'), 'tradeEscortSpell', {
      questId: quest.id, settlementId: quest.settlementId, citizenId: caster.id,
      monsterId: enemy.id, x: enemy.x, y: enemy.y, bound
    });
  }
  const participants = caster && !melee.includes(caster) ? [...melee, caster] : melee;
  const target = melee[0];
  const config = monsters[enemy.species];
  const attack = melee.reduce((power, member) => member === caster ? power :
    power + COMBAT.attack + member.skills.combat + (gear[member.gearId]?.attack ?? 0), spellAttack);
  const retaliates = !bound && target && now >= enemy.attackAt;
  enemy.attackAt = Math.max(enemy.attackAt, now + COMBAT.interval);
  if (attack) enemy.hp = Math.max(0, enemy.hp - damage(world, attack, config.defense));
  emitOnce(world, `${quest.id}/${enemy.id}`, 'tradeEscortClash', {
    questId: quest.id, settlementId: quest.settlementId, actorIds: participants.map(member => member.id),
    monsterId: enemy.id, x: enemy.x, y: enemy.y
  });
  if (!enemy.hp) {
    enemy.alive = false;
    enemy.diedAt = world.worldTimeTick;
    for (const member of participants) trainCombat(world, member, quest, config.xp);
    emitOnce(world, `${quest.id}/${enemy.id}`, 'monsterDefeated', {
      questId: quest.id, settlementId: quest.settlementId, actorIds: participants.map(member => member.id),
      monsterId: enemy.id, x: enemy.x, y: enemy.y
    });
    return;
  }

  if (!retaliates) return;
  target.hp = Math.max(0, target.hp - damage(world, config.attack, COMBAT.defense + (gear[target.gearId]?.defense ?? 0)));
  if (!target.hp) recordDeath(world, target, 'combat');
  if (target.hp <= COMBAT.retreatHp) {
    quest.retreated = true;
    quest.stage = 'return';
    for (const member of team) {
      const tile = tileOf(member);
      member.x = tile.x + 0.5;
      member.y = tile.y + 0.5;
      member.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 };
      member.decisionAt = world.worldTimeTick;
    }
  }
}

export function updateAdventureWorld(world, ticks) {
  const now = world.worldTimeTick;
  const first = world.nextMonsterSpawnTick === undefined;
  if (first) {
    const forbidden = spawnZones(world);
    for (const [species, config] of Object.entries(monsters)) {
      if (config.requiresExpansion) continue;
      for (let i = 0; i < config.cap; i++) {
        if (world.monsters.filter(m => m.alive && m.species === species).length >= config.cap) break;
        if (!spawnAway(world, species, forbidden)) break;
      }
    }
    world.nextMonsterSpawnTick = now + COMBAT.spawnInterval;
  } else if (now >= world.nextMonsterSpawnTick) {
    world.nextMonsterSpawnTick += COMBAT.spawnInterval;
    const expanded = (world.map.surveyedWidth ?? world.map.width) > START_REGION_SIZE ||
      (world.map.surveyedHeight ?? world.map.height) > START_REGION_SIZE;
    const candidates = Object.keys(monsters).filter(key => {
      const config = monsters[key];
      return (!config.requiresExpansion || expanded) && world.monsters.filter(m => m.alive && m.species === key).length < config.cap;
    });
    if (candidates.length) {
      const forbidden = spawnZones(world);
      candidates.some(species => replenishSpecies(world, species, forbidden));
    }
  }

  for (const quest of world.quests) {
    if (quest.status === 'open' && (now >= quest.expiresAt ||
        ((quest.kind === 'clear_monsters' || quest.kind === 'clear_nest') &&
          !world.monsters.some(m => m.id === quest.targetId && m.alive)))) quest.status = 'expired';
    if (quest.status !== 'claimed') {
      delete quest.escortSpell;
      continue;
    }
    const citizen = world.citizens.find(c => c.alive && c.id === quest.claimedBy);
    if (!citizen) {
      quest.status = 'failed';
      delete quest.escortSpell;
    } else if (now >= quest.expiresAt && quest.stage !== 'return') {
      quest.stage = 'return';
      quest.retreated = true;
      delete quest.escortSpell;
      citizen.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: now, progress: 0 };
      citizen.x = citizen.lastKnownSafeTile.x + 0.5;
      citizen.y = citizen.lastKnownSafeTile.y + 0.5;
      citizen.decisionAt = now;
    } else if (now >= quest.expiresAt + TIME_TICKS_PER_DAY) {
      quest.status = 'failed';
    } else if (quest.kind === 'escort_trade' && quest.stage === 'survey') {
      resolveEscortEncounter(world, quest, citizen);
    }
  }
  moveMonsters(world);
  const day = Math.floor(now / TIME_TICKS_PER_DAY) > Math.floor((now - ticks) / TIME_TICKS_PER_DAY);
  if (day) {
    relocateDisplacedNests(world);
    huntPrey(world);
  }
  if (!first && !day) return;
  for (const settlement of world.settlements) {
    if (day) {
      const threat = world.monsters.find(monster => monster.alive &&
        monsters[monster.species].attack >= monsters.goblin.attack && distance(settlement, monster) <= 8);
      if (threat) {
        emitOnce(world, `${settlement.id}/${Math.floor(now / TIME_TICKS_PER_DAY)}`, 'monsterThreat', {
          settlementId: settlement.id, nationId: settlement.nationId, monsterId: threat.id,
          species: threat.species, x: threat.x, y: threat.y
        });
      }
    }
    if (settlement.foodWarning) {
      const openRecovery = world.quests.find(q => q.settlementId === settlement.id &&
        q.kind === 'recover_supplies' && q.status === 'open');
      if (openRecovery && !world.resourceNodes.some(node => node.id === openRecovery.targetId &&
          node.resource === 'food' && node.quantity >= 4)) openRecovery.status = 'expired';
    }
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    const raidsAvailable = store && !settlement.foodWarning && available(store, 'food') >= 2 &&
      world.buildings.some(b => b.kind === 'guild' && b.settlementId === settlement.id) &&
      world.citizens.filter(c => c.alive && c.settlementId === settlement.id &&
        c.profession === 'adventurer' && ageYears(world, c) >= ADULT_AGE).length >= 2;
    if (raidsAvailable) {
      for (const quest of world.quests) {
        if (quest.settlementId !== settlement.id || quest.kind !== 'clear_monsters' || quest.status !== 'open') continue;
        const target = world.monsters.find(monster => monster.id === quest.targetId && monster.alive);
        if (target) promoteNestQuest(world, quest, target);
      }
    }
    let slots = COMBAT.questLimit - world.quests.filter(q => q.settlementId === settlement.id && activeQuest(q)).length;
    const origin = store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;
    const imminentThreat = world.monsters.some(m => m.alive &&
      monsters[m.species].attack >= monsters.goblin.attack && distance(m, settlement) <= 8);
    if (slots <= 0 && imminentThreat) {
      const survey = world.quests.find(q => q.settlementId === settlement.id &&
        q.kind === 'survey_resources' && q.status === 'open');
      const unassigned = survey && world.monsters.find(m => m.alive &&
        monsters[m.species].attack >= monsters.goblin.attack && distance(m, settlement) <= 8 &&
        !nestQuestFor(world, m) && !world.quests.some(q => q.targetId === m.id && activeQuest(q)) &&
        findPath(world, origin, m) !== null);
      if (survey && unassigned && issueQuest(world, settlement, unassigned, false)) survey.status = 'expired';
    }
    if (slots <= 0 && !imminentThreat && raidsAvailable && !world.quests.some(q =>
        q.settlementId === settlement.id && q.kind === 'clear_nest' && activeQuest(q))) {
      const replaceable = world.quests.find(q => q.settlementId === settlement.id && q.status === 'open' &&
        q.kind === 'clear_monsters');
      const target = replaceable && world.monsters.find(monster => monster.alive && monster.hasNest &&
        distance(origin, monster) <= COMBAT.questRadius &&
        !world.quests.some(q => activeQuest(q) &&
          world.monsters.some(m => m.id === q.targetId && sameNest(m, monster))) &&
        findPath(world, origin, monster) !== null);
      if (target && issueQuest(world, settlement, target)) replaceable.status = 'expired';
    }
    if (slots <= 0) continue;
    if (offerRecovery(world, settlement, store, origin)) slots--;
    if (slots === 0) continue;
    if ((!imminentThreat || slots > 1) && offerSurvey(world, settlement, store, origin, slots === 1)) slots--;
    const nearby = world.monsters.filter(m => m.alive && distance(m, settlement) <= COMBAT.questRadius);
    if (!nearby.length) continue;
    const connected = reachableTiles(world, origin, undefined, nearby.map(m => m.y * world.map.width + m.x));
    const enemies = nearby.filter(m => connected[m.y * world.map.width + m.x] === 1)
      .sort((a, b) => {
        const priority = monster => Number(monsters[monster.species].attack >= monsters.goblin.attack &&
          distance(monster, settlement) <= 8);
        return priority(b) - priority(a) ||
          (raidsAvailable ? Number(Boolean(b.hasNest)) - Number(Boolean(a.hasNest)) : 0) ||
          distance(a, settlement) - distance(b, settlement);
      });
    for (const enemy of enemies) {
      if (slots <= 0) break;
      if (issueQuest(world, settlement, enemy, raidsAvailable)) slots--;
    }
  }
}

function approach(world, citizen, monster) {
  const current = tileOf(citizen);
  if (distance(current, monster) <= COMBAT.rangedDistance) return current;
  const tiles = [{ x: monster.x - 1, y: monster.y }, { x: monster.x + 1, y: monster.y },
    { x: monster.x, y: monster.y - 1 }, { x: monster.x, y: monster.y + 1 }];
  let best = null;
  let length = Infinity;
  for (const goal of tiles) {
    const path = findPath(world, current, goal);
    if (path !== null && path.length < length) {
      best = goal;
      length = path.length;
    }
  }
  return best;
}

export function claimAdventure(world, citizen, store, travel) {
  if (citizen.profession !== 'adventurer' || assignedAdventure(world, citizen) ||
      campaignFor(world, citizen) || ageYears(world, citizen) < ADULT_AGE ||
      citizen.hp <= COMBAT.retreatHp || citizen.hunger >= NEEDS.eat ||
      citizen.fatigue >= NEEDS.sleep || available(store, 'food') < 1) return false;
  for (const quest of world.quests) {
    if (quest.status !== 'open' || quest.settlementId !== citizen.settlementId) continue;
    if (quest.kind === 'recover_supplies') {
      if (claimRecovery(world, citizen, quest, store, travel)) return true;
      continue;
    }
    if (quest.kind === 'survey_resources' || quest.kind === 'escort_trade') {
      if (claimSurvey(world, citizen, quest, store, travel)) return true;
      continue;
    }
    const monster = world.monsters.find(m => m.id === quest.targetId && m.alive);
    if (!monster || distance(storeTile(world, store), monster) > COMBAT.questRadius) continue;
    const raid = quest.kind === 'clear_nest';
    const dangerousHunt = monsters[monster.species].attack >= monsters.goblin.attack &&
      world.buildings.some(b => b.kind === 'guild' && b.settlementId === quest.settlementId);
    const escort = (raid || dangerousHunt) && available(store, 'food') >= 2
      ? findEscort(world, citizen, candidate => approach(world, candidate, monster) !== null) : undefined;
    if (raid && !escort) continue;
    const goal = approach(world, citizen, monster);
    if (!goal || !travel(goal, 'adventure', quest.id)) continue;
    commissionGear(world, citizen, store);
    store.total.food--;
    citizen.inventory.food++;
    quest.status = 'claimed';
    quest.claimedBy = citizen.id;
    quest.stage = 'fight';
    quest.strikeAt = null;
    quest.provision = 1;
    if (escort) {
      quest.escortId = escort.id;
      store.total.food--;
      escort.inventory.food++;
      emit(world, 'cooperativeExpedition', quest, tileOf(citizen), { actorIds: [citizen.id, escort.id] });
    }
    emit(world, 'adventureDeparted', quest, tileOf(citizen), { citizenId: citizen.id });
    return true;
  }
  return false;
}

function damage(world, attack, defense) {
  return Math.max(1, Math.floor(attack * (0.9 + random(world.rngState) * 0.2) - defense * 0.5));
}

function defeat(world, citizen, quest, monster) {
  const config = monsters[monster.species];
  monster.alive = false;
  monster.diedAt = world.worldTimeTick;
  trainCombat(world, citizen, quest, config.xp);
  for (const [resource, chance] of config.loot) {
    if (random(world.rngState) >= chance) continue;
    const node = { id: nextId(world, 'node'), resource, quantity: 1, x: monster.x, y: monster.y, dropped: true, questId: quest.id };
    world.resourceNodes.push(node);
    quest.lootIds.push(node.id);
  }
  quest.stage = 'loot';
  emitOnce(world, quest.id + '/' + monster.id, 'monsterDefeated', { questId: quest.id,
    settlementId: quest.settlementId, x: monster.x, y: monster.y, citizenId: citizen.id, monsterId: monster.id });
}

export function continueAdventure(world, citizen, quest, store, origin, travel) {
  if (quest?.status !== 'claimed' || !store) return false;
  if (quest.kind === 'survey_resources' || quest.kind === 'escort_trade') return continueSurvey(world, citizen, quest, store, origin, travel);
  if (quest.kind === 'recover_supplies') return continueRecovery(world, citizen, quest, store, origin, travel);
  const monster = world.monsters.find(m => m.id === quest.targetId);
  const position = tileOf(citizen);
  if (quest.escortId === citizen.id) {
    if (citizen.hp <= COMBAT.retreatHp || citizen.fear >= COMBAT.fearRetreat || citizen.hunger >= NEEDS.eat ||
        (monster?.alive && distance(origin, monster) > COMBAT.questRadius)) quest.escortRetreated = true;
    if (quest.escortRetreated || quest.stage === 'return') {
      if (distance(position, origin) > 0) return travel(origin, 'adventure', quest.id);
      if (!quest.escortReturned && !quest.escortAteProvision && citizen.inventory.food > 0) {
        citizen.inventory.food--;
        citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
      }
      quest.escortReturned = true;
      deposit(citizen, store, world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length * FOOD_TARGET_PER_PERSON);
      return true;
    }
    if (quest.stage !== 'fight' || !monster?.alive || distance(position, monster) <= COMBAT.rangedDistance) return true;
    const goal = approach(world, citizen, monster);
    return Boolean(goal && travel(goal, 'adventure', quest.id));
  }
  if (quest.claimedBy !== citizen.id) return false;
  const escort = quest.escortId && world.citizens.find(c => c.id === quest.escortId && c.alive);
  const canCast = canCastSpell(world, citizen);
  const spell = quest.casting === true || canCast;
  const range = spell ? TECH.spellRange : COMBAT.rangedDistance;
  if (quest.stage === 'fight') {
    const cutoff = COMBAT.retreatHp - (COMBAT.retreatHp - COMBAT.braveRetreatHp) * citizen.traits.bravery;
    const unsupportedRaid = quest.kind === 'clear_nest' && quest.escortId && (!escort || quest.escortRetreated);
    if (unsupportedRaid || citizen.hp <= cutoff || citizen.fear >= COMBAT.fearRetreat || citizen.hunger >= NEEDS.eat ||
        !monster?.alive || distance(origin, monster) > COMBAT.questRadius) {
      quest.stage = 'return';
      quest.retreated = true;
    } else if (distance(position, monster) > range) {
      quest.casting = false;
      quest.strikeAt = null;
      const goal = approach(world, citizen, monster);
      if (goal && travel(goal, 'adventure', quest.id)) return true;
      quest.stage = 'return';
      quest.retreated = true;
    } else {
      const config = monsters[monster.species];
      if (quest.strikeAt === null ||
          (!quest.casting && canCast && world.worldTimeTick >= quest.strikeAt)) {
        quest.casting = spell;
        quest.strikeAt = world.worldTimeTick + (spell ? TECH.spellCastTicks : COMBAT.strikeDelay);
      }
      if (world.worldTimeTick >= quest.strikeAt) {
        if (quest.casting) spendSpell(world, citizen);
        const weapon = unlocked(world, citizen.settlementId, 'weapons_1') ? TECH.weaponBonus : 0;
        const steel = !quest.casting && unlocked(world, citizen.settlementId, 'steel_1') ? TECH.steelWeaponBonus : 0;
        const equipment = gear[citizen.gearId];
        const attack = quest.casting ? spellPower(world, citizen)
          : COMBAT.attack + citizen.skills.combat + weapon + steel + (equipment?.attack ?? 0);
        const bound = quest.casting && bindMonster(world, quest, monster, citizen);
        if (!bound && (quest.casting || distance(position, monster) <= COMBAT.rangedDistance)) {
          const support = escort && !quest.escortRetreated && escort.hp > COMBAT.retreatHp &&
            distance(tileOf(escort), monster) <= COMBAT.rangedDistance;
          const bonus = support ? Math.floor(COMBAT.attack / 2) + escort.skills.combat : 0;
          if (support) quest.escortContributed = true;
          monster.hp = Math.max(0, monster.hp - damage(world, attack + bonus, config.defense));
        }
        quest.casting = false;
        quest.strikeAt = world.worldTimeTick + COMBAT.interval;
        if (monster.hp === 0) defeat(world, citizen, quest, monster);
      }
      if (monster.alive && distance(position, monster) <= COMBAT.rangedDistance && world.worldTimeTick >= monster.attackAt) {
        citizen.hp = Math.max(0, citizen.hp - damage(world, config.attack, COMBAT.defense + (gear[citizen.gearId]?.defense ?? 0)));
        monster.attackAt = world.worldTimeTick + COMBAT.interval;
        if (!citizen.hp) {
          recordDeath(world, citizen, 'combat');
          quest.status = 'failed';
          return false;
        }
      }
      if (quest.stage === 'fight') return true;
    }
  }
  if (quest.stage === 'loot') {
    const remains = world.resourceNodes.filter(node => quest.lootIds.includes(node.id) && node.quantity > 0);
    const node = remains[0];
    if (node && distance(position, node) > 0 && travel(node, 'adventure', quest.id)) return true;
    for (const item of remains) {
      if (distance(position, item) > 0) continue;
      citizen.inventory[item.resource] += item.quantity;
      item.quantity = 0;
    }
    const next = quest.kind === 'clear_nest' && world.monsters.find(m => m.alive && sameNest(m, monster));
    if (next) {
      quest.targetId = next.id;
      quest.stage = 'fight';
      quest.strikeAt = null;
      return true;
    }
    if (quest.kind === 'clear_nest') {
      emit(world, 'monsterNestCleared', quest, quest.nestTile, { citizenId: citizen.id, species: quest.species });
    }
    quest.stage = 'return';
  }
  if (distance(position, origin) > 0) return travel(origin, 'adventure', quest.id);
  if (escort && !quest.escortReturned && world.worldTimeTick < quest.expiresAt + TIME_TICKS_PER_DAY / 2) return true;
  const hasProvision = quest.provision && citizen.inventory.food > 0;
  if (hasProvision) {
    citizen.inventory.food--;
    citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
    quest.provision = 0;
  }
  const population = world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length;
  deposit(citizen, store, population * FOOD_TARGET_PER_PERSON);
  if (!quest.retreated && available(store, 'food') >= quest.rewardFood) {
    store.total.food -= quest.rewardFood;
    citizen.inventory.food += quest.rewardFood;
  } else if (!quest.retreated) {
    quest.unpaidFood = quest.rewardFood;
  }
  quest.status = quest.retreated ? 'retreated' : 'completed';
  if (!quest.retreated) {
    recordAdventureSuccess(world, citizen, quest);
    if (escort && quest.escortReturned && quest.escortContributed && !quest.escortRetreated) recordAdventureSuccess(world, escort, quest);
  }
  emit(world, 'adventureReturned', quest, origin, { citizenId: citizen.id, retreated: Boolean(quest.retreated) });
  return false;
}

import { emitOnce } from '../systems/History.js';
import { citizenRaces, DECISION_TICKS, WALK_TICKS, WANDER_RADIUS, TERRAIN_COST, FOOD_TARGET_PER_PERSON, FOOD_HUNGER_RESTORED, FOOD_HUNGER_PER_HOUR, LARGE_SETTLEMENT_POPULATION, NEEDS, NEED_HOUR_TICKS, GATHER_TICKS } from '../data/balance.js';
import { discoverFrontier, surveyBounds, surveyRoute } from '../engine/Expansion.js';
import { FAR_DISTANCE, movementBudget } from './DetailLevel.js';
import { random } from '../engine/random.js';
import { findPath, reachableTiles } from './path.js';
import { available, deposit, freeCapacity, gatherForStore, harvest, renewNodes, resources, storageRoom, storeTile } from './Economy.js';
import { eat, shareEmergencyMeals, updateNeeds } from './Needs.js';
import { COMBAT } from '../data/combat.js';
import { FARM_HARVEST_TICKS, FARM_YIELD } from '../data/buildings.js';
import {
  buildAtSite, deliverMaterials, materialsDelivered, pickUpMaterials, planSettlementConstruction,
  reserveMaterials, workTile
} from './Construction.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { assignedAdventure, claimAdventure, continueAdventure, isQuestCargo } from './Adventure.js';
import { campaignFor, invasionOrder } from './War.js';
import { recordDeath } from './Population.js';
import { buildingDistance, tileDistance } from './Territory.js';

const tileOf = citizen => ({ x: Math.floor(citizen.x), y: Math.floor(citizen.y) });
const idle = tick => ({ kind: 'idle', phase: 'plan', targetId: null, startedAt: tick, progress: 0 });

const jobs = { farmer: ['food'], woodcutter: ['wood'], miner: ['stone', 'iron', 'manaStone'] };

const SURVEY_DISTANCE_BONUS = 4;

function gatherPriority(world, settlementId, distance) {
  const surveyed = new Set();
  for (const quest of world.quests) {
    if (quest.kind === 'survey_resources' && quest.status === 'completed' && quest.settlementId === settlementId) {
      surveyed.add(quest.targetId);
      if (quest.discoveredNodeId) surveyed.add(quest.discoveredNodeId);
    }
  }
  const score = node => distance(node) - (surveyed.has(node.id) ? SURVEY_DISTANCE_BONUS : 0);
  return (a, b) => score(a) - score(b) || distance(a) - distance(b);
}

function travel(world, citizen, goal, kind, targetId = null) {
  const path = findPath(world, tileOf(citizen), goal);
  if (path === null || (!path.length && kind === 'explore')) return false;
  citizen.action = {
    kind, phase: path.length ? 'travel' : 'perform', targetId,
    startedAt: world.worldTimeTick, progress: 0, path, goal: { x: goal.x, y: goal.y },
    navigationVersion: world.map.navigationVersion
  };
  return true;
}

function interruptForFood(world, citizen) {
  const { kind, phase } = citizen.action;
  const interruptible = phase === 'perform' && kind === 'build' || phase === 'travel' &&
    ['gather', 'haul', 'explore', 'survey', 'deliverMaterials', 'recoverMaterials', 'pickUpMaterials'].includes(kind);
  if (citizen.hunger < 95 || !interruptible) return;
  const store = world.stockpiles.find(s => s.settlementId === citizen.settlementId);
  if (!store || available(store, 'food') < 1) return;
  const { x, y } = citizen;
  citizen.x = citizen.lastKnownSafeTile.x + 0.5;
  citizen.y = citizen.lastKnownSafeTile.y + 0.5;
  if (!travel(world, citizen, storeTile(world, store), 'eat', store.id)) Object.assign(citizen, { x, y });
}

function takeAbandonedCargo(shipment, citizen) {
  shipment.carrierId = citizen.id;
  delete shipment.x;
  delete shipment.y;
}

function resumeConstructionDelivery(world, citizen) {
  const shipment = world.inTransit.find(item => item.carrierId === citizen.id);
  if (shipment) {
    const site = world.constructionSites.find(s => s.id === shipment.destinationId);
    const goal = site && workTile(world, tileOf(citizen), site);
    if (goal) travel(world, citizen, goal, 'deliverMaterials', shipment.id);
  }
  return Boolean(shipment);
}

function constructionRoute(world, citizen, store, population) {
  const origin = storeTile(world, store);
  const originTile = tileOf(citizen);
  const claimed = new Set(world.citizens.filter(c => c.alive && c.action.kind === 'recoverMaterials')
    .map(c => c.action.targetId));
  const abandoned = world.inTransit.filter(item => item.carrierId === null && !claimed.has(item.id) &&
    world.constructionSites.some(site => site.id === item.destinationId && site.settlementId === citizen.settlementId));
  abandoned.sort((a, b) => tileDistance(originTile, a) - tileDistance(originTile, b));
  if (abandoned.some(item => travel(world, citizen, item, 'recoverMaterials', item.id))) return true;
  const settlement = world.settlements.find(s => s.id === citizen.settlementId);
  const site = planSettlementConstruction(world, settlement, store, origin, population);
  if (!site) return false;
  if (materialsDelivered(site)) {
    const goal = workTile(world, tileOf(citizen), site);
    return goal && travel(world, citizen, goal, 'build', site.id);
  }
  reserveMaterials(world, site, store);
  const reservation = world.reservations.find(r => r.siteId === site.id && r.state === 'reserved');
  return reservation && travel(world, citizen, origin, 'pickUpMaterials', reservation.id);
}

function adventure(world, citizen, quest, store) {
  return store && continueAdventure(world, citizen, quest, store, storeTile(world, store),
    (goal, kind, targetId) => travel(world, citizen, goal, kind, targetId));
}

function chooseRoute(world, citizen, store, population) {
  if (citizen.expeditionId) {
    const expedition = world.expeditions.find(item => item.id === citizen.expeditionId);
    if (!expedition.arrivedIds.includes(citizen.id) &&
        !travel(world, citizen, expedition, 'expedition', expedition.id)) expedition.failed = true;
    return;
  }
  const active = citizen.profession === 'adventurer' && assignedAdventure(world, citizen);
  if (active && adventure(world, citizen, active, store)) return;
  const campaign = campaignFor(world, citizen);
  if (campaign?.rations > 0 && citizen.hunger >= NEEDS.eat - 8) {
    campaign.rations--;
    citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
  }
  if (store && citizen.hunger >= NEEDS.eat && available(store, 'food') > 0 &&
      travel(world, citizen, storeTile(world, store), 'eat', store.id)) return;
  if (store && !campaign && citizen.hunger >= 95 && citizen.inventory.food === 0) {
    const origin = tileOf(citizen);
    const food = world.resourceNodes.filter(node => node.resource === 'food' && node.quantity > 0 &&
      tileDistance(origin, node) <= 8 && !isQuestCargo(world, node));
    food.sort((a, b) => tileDistance(origin, a) - tileDistance(origin, b));
    if (food.some(node => travel(world, citizen, node, 'forage', node.id))) return;
  }

  if (citizen.fatigue >= NEEDS.sleep || (citizen.hp <= COMBAT.retreatHp && citizen.hunger < NEEDS.eat)) {
    citizen.action = { ...idle(world.worldTimeTick), kind: 'sleep', phase: 'perform' };
    return;
  }
  const invasion = invasionOrder(world, citizen);
  if (invasion && travel(world, citizen, invasion, 'warMarch', invasion.id)) return;
  if (campaign?.arrivedIds.includes(citizen.id)) return;
  if (resumeConstructionDelivery(world, citizen)) return;
  const foodTarget = population * FOOD_TARGET_PER_PERSON;
  if (store && freeCapacity(store) > 0) {
    if (resources.some(key => citizen.inventory[key] > 0 && storageRoom(store, key, foodTarget) > 0) &&
        travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
  }
  if (store && citizen.profession === 'builder' && constructionRoute(world, citizen, store, population)) return;
  if (store && freeCapacity(store) > 0) {
    if (citizen.profession === 'builder') {
      const origin = tileOf(citizen);
      const drops = world.resourceNodes.filter(node => node.dropped && node.quantity > 0 &&
        storageRoom(store, node.resource, foodTarget) > 0 && !isQuestCargo(world, node));
      drops.sort((a, b) => tileDistance(origin, a) - tileDistance(origin, b));
      if (drops.some(node => travel(world, citizen, node, 'gather', node.id))) return;
    }
    const helpsHarvest = citizen.profession === 'farmer' || (citizen.profession === 'adventurer' &&
      !active && !campaign && world.settlements.some(s => s.id === citizen.settlementId && s.foodWarning));
    if (helpsHarvest && available(store, 'food') < foodTarget && storageRoom(store, 'food', foodTarget) > 0) {
      const assigned = new Set(world.citizens.filter(c => c.alive && c.action.kind === 'farm')
        .map(c => c.action.targetId));
      const origin = tileOf(citizen);
      const ripe = world.buildings.filter(farm => farm.kind === 'farm' &&
        farm.settlementId === citizen.settlementId && !assigned.has(farm.id) &&
        (farm.harvestAt ?? farm.completedAt + FARM_HARVEST_TICKS) <= world.worldTimeTick);
      if (population >= LARGE_SETTLEMENT_POPULATION) {
        ripe.sort((a, b) => blessedFarmFirst(a, b) || buildingDistance(origin, a) - buildingDistance(origin, b));
      } else {
        ripe.sort(blessedFarmFirst);
      }
      for (const farm of ripe) {
        const goal = workTile(world, origin, farm);
        if (goal && travel(world, citizen, goal, 'farm', farm.id)) return;
      }
    }
    const candidates = (jobs[citizen.profession] ?? []).filter(key =>
      storageRoom(store, key, foodTarget) > 0 && available(store, key) < (key === 'food' ? population * FOOD_TARGET_PER_PERSON : key === 'wood' ? 24 : 12));
    candidates.sort((a, b) => available(store, a) - available(store, b));
    for (const resource of candidates) {
      const current = tileOf(citizen);
      const distance = node => Math.abs(node.x - current.x) + Math.abs(node.y - current.y);
      const nodes = world.resourceNodes.filter(node => node.resource === resource && node.quantity > 0)
        .sort(gatherPriority(world, citizen.settlementId, distance));
      for (const node of nodes) {
        if ((!node.dropped || !isQuestCargo(world, node)) &&
            travel(world, citizen, node, 'gather', node.id)) return;
      }
    }
  }
  const survey = surveyRoute(world, citizen);
  if (survey) {
    const { goal, path } = survey;
    citizen.action = { kind: 'survey', phase: path.length ? 'travel' : 'perform',
      goal: { x: goal.x, y: goal.y }, direction: goal.direction, targetId: null, path, progress: 0,
      startedAt: world.worldTimeTick, navigationVersion: world.map.navigationVersion };
    return;
  }
  if (store && claimAdventure(world, citizen, store, (goal, kind, targetId) =>
    travel(world, citizen, goal, kind, targetId))) return;
  const { x, y } = world.settlements.find(s => s.id === citizen.settlementId) ?? citizen.lastKnownSafeTile;
  const offset = () => Math.floor(random(world.rngState) * (2 * WANDER_RADIUS + 1)) - WANDER_RADIUS;
  travel(world, citizen, { x: x + offset(), y: y + offset() }, 'explore');
}

function blessedFarmFirst(a, b) {
  return Number(Boolean(b.fertilityCommandId)) - Number(Boolean(a.fertilityCommandId));
}

export function farmYield(world, farm, worker) {
  const { settlementId } = farm;
  let multiplier = unlocked(world, settlementId, 'farming_1') ? TECH.farmYieldMultiplier : 1;
  if (unlocked(world, settlementId, 'irrigation_1')) multiplier += TECH.irrigationBonus;
  if (unlocked(world, settlementId, 'verdant_1')) multiplier += TECH.verdantBonus;
  const aptitude = worker?.profession === 'farmer' ? citizenRaces[worker.race]?.farmYieldBonus ?? 0 : 0;
  return Math.floor(FARM_YIELD * multiplier) + (farm.arcaneIrrigation ? TECH.arcaneIrrigationYield : 0) + aptitude;
}

function harvestFarm(world, farm, farmer, store) {
  farm.harvestAt = world.worldTimeTick + FARM_HARVEST_TICKS;
  const quantity = farmYield(world, farm, farmer);
  if (farm.droughtCommandId) {
    const id = farm.droughtCommandId;
    const drought = world.events.find(e => e.sourceTransactionId === id && e.type === 'god_intervention');
    const settlement = world.settlements.find(s => s.id === farm.settlementId);
    const foodBeforeDrought = drought?.foodBeforeDrought?.[farm.settlementId];
    emitOnce(world, JSON.stringify([id, farm.id]), 'droughtHarvestRecovered', {
      causeEventId: drought?.id, buildingId: farm.id, settlementId: farm.settlementId,
      nationId: settlement?.nationId, actorIds: [farmer.id], x: farm.x, y: farm.y,
      quantity, ...(store && { foodBeforeHarvest: available(store, 'food') }),
      ...(foodBeforeDrought !== undefined && { foodBeforeDrought })
    });
    delete farm.droughtCommandId;
  }
  if (farm.fertilityCommandId) {
    const id = farm.fertilityCommandId;
    const blessing = world.events.find(e => e.sourceTransactionId === id && e.type === 'god_intervention');
    const nationId = world.settlements.find(s => s.id === farm.settlementId)?.nationId;
    emitOnce(world, JSON.stringify([id, farm.id]), 'blessedFarmHarvested', {
      causeEventId: blessing?.id, buildingId: farm.id, settlementId: farm.settlementId,
      nationId, actorIds: [farmer.id], x: farm.x, y: farm.y, quantity
    });
    delete farm.fertilityCommandId;
  }
  return quantity;
}


const distantRoutes = new WeakMap();

function distantConnectivity(world, store, origin) {
  const { navigationVersion } = world.map;
  let routes = distantRoutes.get(world);
  if (routes?.version !== navigationVersion) {
    routes = { version: navigationVersion, depots: new Map() };
    distantRoutes.set(world, routes);
  }
  const cached = routes.depots.get(store.id);
  if (cached?.x === origin.x && cached.y === origin.y) return cached.tiles;
  const tiles = reachableTiles(world, origin);
  routes.depots.set(store.id, { ...origin, tiles });
  return tiles;
}

function updateDistantSettlements(world, camera, population) {
  if (!camera) return;
  const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const carriers = new Set(world.inTransit.map(item => item.carrierId));
  const claimedFarms = new Set(world.citizens.filter(c => c.alive && c.action.kind === 'farm')
    .map(c => c.action.targetId));
  const claimedNodes = new Set(world.citizens.filter(c => c.alive && c.action.kind === 'gather')
    .map(c => c.action.targetId));
  for (const settlement of world.settlements) {
    const residents = population.get(settlement.id) ?? 0;
    if (residents < 16) continue;
    const buildings = world.buildings.filter(b => b.settlementId === settlement.id);
    const radius = buildings.reduce((max, b) => Math.max(max, distance(settlement, b) +
      Math.max(b.width ?? 1, b.height ?? 1) - 1), 12);
    if (distance(settlement, camera) <= FAR_DISTANCE ||
        buildings.some(b => distance(b, camera) <= FAR_DISTANCE + 2) ||
        world.constructionSites.some(s => s.settlementId === settlement.id && distance(s, camera) <= FAR_DISTANCE + 2)) continue;
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    if (!store) continue;
    const origin = storeTile(world, store);
    const locals = world.citizens.filter(c => c.alive && c.hp > 0 && c.settlementId === settlement.id &&
      c.action.kind === 'idle' && distance(c.lastKnownSafeTile, origin) <= 8 &&
      !c.expeditionId && !carriers.has(c.id) && !campaignFor(world, c) && !assignedAdventure(world, c));
    const hungry = locals.filter(c => c.hunger >= NEEDS.eat).sort((a, b) => b.hunger - a.hunger || a.hp - b.hp);
    let connected;
    if (hungry.length && available(store, 'food') > 0) {
      connected = distantConnectivity(world, store, origin);
      for (const citizen of hungry) {
        const { x, y } = citizen.lastKnownSafeTile;
        if (connected[y * world.map.width + x] === 1) eat(citizen, store);
      }
    }
    const foodTarget = residents * FOOD_TARGET_PER_PERSON;
    const ready = [];
    for (const citizen of locals) {
      if (resources.some(key => citizen.inventory[key] > 0 && storageRoom(store, key, foodTarget) > 0)) {
        connected ??= distantConnectivity(world, store, origin);
        const { x, y } = citizen.lastKnownSafeTile;
        if (connected[y * world.map.width + x] === 1 && deposit(citizen, store, foodTarget)) {
          citizen.decisionAt = Math.max(citizen.decisionAt, world.worldTimeTick + DECISION_TICKS);
          continue;
        }
      }
      ready.push(citizen);
    }
    const workers = ready.filter(c => (c.profession === 'farmer' ||
      (settlement.foodWarning && c.profession === 'adventurer')) && c.hp > COMBAT.retreatHp &&
      c.hunger < NEEDS.eat && c.fatigue < NEEDS.sleep && c.inventory.food === 0);
    const dispatched = new Set();
    for (const resource of ['wood', 'stone', 'iron', 'manaStone']) {
      const target = resource === 'wood' ? 24 : 12;
      if (available(store, resource) >= target || storageRoom(store, resource, foodTarget) <= 0) continue;
      const crew = ready.filter(c => jobs[c.profession]?.includes(resource) && !dispatched.has(c.id) && c.hp > COMBAT.retreatHp &&
        c.hunger < NEEDS.eat && c.fatigue < NEEDS.sleep && !c.inventory[resource]);
      if (!crew.length) continue;
      connected ??= distantConnectivity(world, store, origin);
      const accessible = tile => connected[tile.y * world.map.width + tile.x] === 1;
      if (!crew.some(c => accessible(c.lastKnownSafeTile))) continue;
      const sources = world.resourceNodes.filter(n => n.resource === resource && !n.dropped && n.quantity > 0 &&
        !claimedNodes.has(n.id) && distance(settlement, n) <= radius && accessible(n));
      sources.sort(gatherPriority(world, settlement.id, node => distance(origin, node)));
      for (const worker of crew) {
        if (available(store, resource) >= target) break;
        if (!accessible(worker.lastKnownSafeTile)) continue;
        const source = sources.find(n => n.quantity > 0);
        if (!source || !gatherForStore(world, source, store, foodTarget, worker)) break;
        dispatched.add(worker.id);
        worker.decisionAt = Math.max(worker.decisionAt, world.worldTimeTick + DECISION_TICKS);
      }
    }
    let site = world.constructionSites.find(s => s.settlementId === settlement.id);
    const constructionBusy = site && world.citizens.some(c => c.alive && c.settlementId === settlement.id &&
        ['build', 'pickUpMaterials', 'deliverMaterials', 'recoverMaterials'].includes(c.action.kind));
    if (!constructionBusy) {
      const builders = ready.filter(c => c.profession === 'builder' && c.hp > COMBAT.retreatHp &&
        c.hunger < NEEDS.eat && c.fatigue < NEEDS.sleep &&
        !world.inTransit.some(item => item.carrierId === c.id));
      if (builders.length) {
        connected ??= distantConnectivity(world, store, origin);
        const builder = builders.find(c => {
          const { x, y } = c.lastKnownSafeTile;
          return connected[y * world.map.width + x] === 1;
        });
        if (builder) {
          const salvage = world.resourceNodes.find(node => node.dropped && node.quantity > 0 &&
            distance(node, settlement) <= radius && connected[node.y * world.map.width + node.x] === 1 &&
            !claimedNodes.has(node.id) && !isQuestCargo(world, node) &&
            storageRoom(store, node.resource, foodTarget) > 0);
          if (salvage && gatherForStore(world, salvage, store, foodTarget, builder)) {
            builder.decisionAt = Math.max(builder.decisionAt, world.worldTimeTick + DECISION_TICKS);
          } else {
            site ??= planSettlementConstruction(world, settlement, store, origin, residents);
            if (site && workTile(world, origin, site)) {
              if (materialsDelivered(site)) {
                buildAtSite(world, site, NEED_HOUR_TICKS / 2, builder);
              } else {
                const abandoned = world.inTransit.find(item => item.destinationId === site.id &&
                  item.carrierId === null && distance(item, settlement) <= radius &&
                  connected[item.y * world.map.width + item.x] === 1);
                reserveMaterials(world, site, store);
                const reservation = world.reservations.find(r => r.siteId === site.id && r.state === 'reserved');
                const shipment = abandoned ?? (reservation && pickUpMaterials(world, reservation, builder));
                if (abandoned) takeAbandonedCargo(abandoned, builder);
                if (shipment) deliverMaterials(world, shipment, builder);
              }
              builder.decisionAt = Math.max(builder.decisionAt, world.worldTimeTick + DECISION_TICKS);
            }
          }
        }
      }
    }
    if (!workers.length) continue;
    const farms = buildings.filter(building => building.kind === 'farm').sort(blessedFarmFirst);
    for (const farm of farms) {
      const room = storageRoom(store, 'food', foodTarget);
      if (available(store, 'food') >= foodTarget || room <= 0) break;
      if (claimedFarms.has(farm.id) ||
          (farm.harvestAt ?? farm.completedAt + FARM_HARVEST_TICKS) > world.worldTimeTick) continue;
      const field = workTile(world, origin, farm);
      if (!field) continue;
      const worker = workers.findIndex(c => findPath(world, c.lastKnownSafeTile, field) !== null);
      if (worker === -1) continue;
      const [farmer] = workers.splice(worker, 1);
      const yieldPerFarm = harvestFarm(world, farm, farmer, store);
      const delivered = Math.min(yieldPerFarm, room, foodTarget - available(store, 'food'));
      store.total.food += delivered;
      farmer.inventory.food += yieldPerFarm - delivered;
      farmer.decisionAt = Math.max(farmer.decisionAt, world.worldTimeTick + DECISION_TICKS);
      if (!workers.length) break;
    }
  }
}

function perform(world, citizen, store, ticks, population) {
  const action = citizen.action;
  if (action.kind === 'survey') discoverFrontier(world, citizen.lastKnownSafeTile, action.direction, citizen.id);
  if (action.kind === 'warMarch') {
    const invasion = invasionOrder(world, citizen);
    if (invasion?.id === action.targetId) invasion.arrivedIds.push(citizen.id);
  }
  if (action.kind === 'expedition') {
    const expedition = world.expeditions.find(item => item.id === action.targetId);
    if (!expedition.arrivedIds.includes(citizen.id)) expedition.arrivedIds.push(citizen.id);
  }
  if (action.kind === 'adventure') {
    const quest = world.quests.find(q => q.id === action.targetId);
    if (adventure(world, citizen, quest, store)) return;
  }
  if (action.kind === 'sleep' &&
      (citizen.fatigue > 20 || (citizen.hp < NEEDS.recoveryHp && citizen.hunger < NEEDS.eat))) {
    if (store && citizen.hunger >= NEEDS.eat && available(store, 'food') > 0) {
      travel(world, citizen, storeTile(world, store), 'eat', store.id);
    }
    return;
  }
  if (action.kind === 'gather' || action.kind === 'forage') {
    action.progress += ticks;
    if (action.progress < GATHER_TICKS) return;
    const node = world.resourceNodes.find(n => n.id === action.targetId);
    if (node && !isQuestCargo(world, node) && harvest(world, citizen, node) &&
        action.kind === 'forage' && citizen.hunger >= NEEDS.eat) {
      citizen.inventory.food--;
      citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
    }
    if (store && node && citizen.inventory[node.resource] && travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
  }
  if (action.kind === 'farm') {
    const farm = world.buildings.find(b => b.id === action.targetId);
    if (farm && (farm.harvestAt ?? farm.completedAt + FARM_HARVEST_TICKS) <= world.worldTimeTick) {
      citizen.inventory.food += harvestFarm(world, farm, citizen, store);
      if (store && travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
    }
  }
  if (action.kind === 'build') {
    const site = world.constructionSites.find(s => s.id === action.targetId);
    if (site && !buildAtSite(world, site, ticks, citizen)) return;
  }
  if (action.kind === 'pickUpMaterials') {
    pickUpMaterials(world, world.reservations.find(r => r.id === action.targetId), citizen);
  }
  if (action.kind === 'recoverMaterials') {
    const shipment = world.inTransit.find(item => item.id === action.targetId && item.carrierId === null);
    if (shipment) takeAbandonedCargo(shipment, citizen);
  }
  if (action.kind === 'deliverMaterials') {
    deliverMaterials(world, world.inTransit.find(item => item.id === action.targetId), citizen);
  }
  if (action.kind === 'haul' && store?.id === action.targetId) {
    deposit(citizen, store, population * FOOD_TARGET_PER_PERSON);
  }
  if (action.kind === 'eat' && store?.id === action.targetId) eat(citizen, store);
  citizen.action = idle(world.worldTimeTick);
}

export function updateCitizens(world, ticks, camera) {
  renewNodes(world);
  const population = new Map();
  for (const c of world.citizens) {
    if (c.alive) population.set(c.settlementId, (population.get(c.settlementId) ?? 0) + 1);
  }
  if (Math.floor(world.worldTimeTick / NEED_HOUR_TICKS) >
      Math.floor((world.worldTimeTick - ticks) / NEED_HOUR_TICKS)) {
    shareEmergencyMeals(world);
    for (const citizen of world.citizens) {
      if (!citizen.alive) continue;
      if (citizen.hunger >= NEEDS.eat - FOOD_HUNGER_PER_HOUR && citizen.inventory.food > 0) {
        const quest = assignedAdventure(world, citizen);
        citizen.inventory.food--;
        citizen.hunger -= FOOD_HUNGER_RESTORED;
        if (quest?.claimedBy === citizen.id) quest.provision = 0;
        else if (quest) quest.escortAteProvision = true;
      }
      updateNeeds(world, citizen, ticks);
      interruptForFood(world, citizen);
    }
    updateDistantSettlements(world, camera, population);
  }
  for (const citizen of world.citizens) {
    if (!citizen.alive) continue;
    if (citizen.hp <= 0) {
      recordDeath(world, citizen, 'starvation');
      continue;
    }
    if (!citizen.settlementId && !citizen.expeditionId) {
      const tile = citizen.lastKnownSafeTile;
      const near = world.settlements.find(s => Math.abs(s.x - tile.x) + Math.abs(s.y - tile.y) <= 8);
      if (near) {
        citizen.settlementId = near.id;
        citizen.nationId = near.nationId;
      }
    }
    const store = world.stockpiles.find(s => s.settlementId === citizen.settlementId);
    if (citizen.action.kind === 'warMarch' && !invasionOrder(world, citizen)) {
      citizen.x = citizen.lastKnownSafeTile.x + 0.5;
      citizen.y = citizen.lastKnownSafeTile.y + 0.5;
      citizen.action = idle(world.worldTimeTick);
    }
    if (citizen.action.phase === 'travel' &&
        citizen.action.navigationVersion !== world.map.navigationVersion) {
      const safe = citizen.lastKnownSafeTile;
      citizen.x = safe.x + 0.5;
      citizen.y = safe.y + 0.5;
      const bounds = citizen.action.kind === 'survey' ? surveyBounds(world.map) : undefined;
      const path = findPath(world, safe, citizen.action.goal, bounds);
      delete citizen.action.deferredMovement;
      if (path?.length) {
        Object.assign(citizen.action, { path, progress: 0, navigationVersion: world.map.navigationVersion });
      } else {
        citizen.action = path ? { ...citizen.action, phase: 'perform', progress: 0 } : idle(world.worldTimeTick);
      }
    }

    if (world.worldTimeTick >= citizen.decisionAt && citizen.action.phase === 'plan') {
      citizen.decisionAt = world.worldTimeTick + (citizen.decisionAt - world.worldTimeTick) % DECISION_TICKS;
      citizen.decisionAt += DECISION_TICKS;
      chooseRoute(world, citizen, store, population.get(citizen.settlementId));
    }

    const work = citizen.fatigue >= 100 ? ticks / 2 : ticks;
    if (citizen.action.phase === 'perform') {
      perform(world, citizen, store, work, population.get(citizen.settlementId));
      continue;
    }
    let remaining = citizen.action.phase === 'travel' ? movementBudget(citizen, camera, work) : 0;
    while (remaining > 0 && citizen.action.phase === 'travel') {
      const action = citizen.action;
      const [target] = action.path;
      const safe = citizen.lastKnownSafeTile;
      const cost = TERRAIN_COST[world.map.terrain[target.y * world.map.width + target.x]];
      const duration = cost * WALK_TICKS;
      const used = Math.min(remaining, duration - action.progress);
      action.progress += used;
      remaining -= used;
      const fraction = action.progress / duration;
      citizen.x = safe.x + 0.5 + (target.x - safe.x) * fraction;
      citizen.y = safe.y + 0.5 + (target.y - safe.y) * fraction;
      if (action.progress === duration) {
        citizen.lastKnownSafeTile = action.path.shift();
        action.progress = 0;
        if (!action.path.length) {
          if (action.kind === 'explore') citizen.action = idle(world.worldTimeTick);
          else action.phase = 'perform';
        }
      }
    }
  }
}

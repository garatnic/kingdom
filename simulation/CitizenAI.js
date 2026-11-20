import { DECISION_TICKS, WALK_TICKS, WANDER_RADIUS, TERRAIN_COST, FOOD_TARGET_PER_PERSON, NEEDS, GATHER_TICKS } from '../data/balance.js';
import { random } from '../engine/random.js';
import { findPath } from './path.js';
import { available, deposit, freeCapacity, harvest, renewNodes, resources } from './Economy.js';
import { eat, updateNeeds } from './Needs.js';
import { FARM_HARVEST_TICKS, FARM_YIELD } from '../data/buildings.js';
import {
  buildAtSite, deliverMaterials, materialsDelivered, pickUpMaterials, planSettlementConstruction,
  reserveMaterials, workTile
} from './Construction.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { claimAdventure, continueAdventure } from './Adventure.js';
import { recordDeath } from './Population.js';

const tileOf = citizen => ({ x: Math.floor(citizen.x), y: Math.floor(citizen.y) });
const idle = tick => ({ kind: 'idle', phase: 'plan', targetId: null, startedAt: tick, progress: 0 });

function storeTile(world, store) {
  if (store.x !== undefined) return store;
  const settlement = world.settlements.find(s => s.id === store.settlementId);
  return { x: settlement.x + 1, y: settlement.y };
}

const jobs = { farmer: ['food'], woodcutter: ['wood'], miner: ['stone', 'iron', 'manaStone'] };

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

function constructionRoute(world, citizen, store, population) {
  const origin = storeTile(world, store);
  const shipment = world.inTransit.find(item => item.carrierId === citizen.id);
  if (shipment) {
    const site = world.constructionSites.find(s => s.id === shipment.destinationId);
    const goal = site && workTile(world, tileOf(citizen), site);
    return goal && travel(world, citizen, goal, 'deliverMaterials', shipment.id);
  }
  const abandoned = world.inTransit.find(item => item.carrierId === null &&
    world.constructionSites.some(site => site.id === item.destinationId && site.settlementId === citizen.settlementId));
  if (abandoned && travel(world, citizen, abandoned, 'recoverMaterials', abandoned.id)) return true;
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
  if (citizen.profession === 'adventurer') {
    const active = world.quests.find(q => q.status === 'claimed' && q.claimedBy === citizen.id);
    if (active && adventure(world, citizen, active, store)) return;
  }
  if (store && citizen.hunger >= NEEDS.eat && available(store, 'food') > 0 &&
      travel(world, citizen, storeTile(world, store), 'eat', store.id)) return;
  if (citizen.fatigue >= NEEDS.sleep) {
    citizen.action = { ...idle(world.worldTimeTick), kind: 'sleep', phase: 'perform' };
    return;
  }
  if (store && freeCapacity(store) > 0) {
    if (resources.some(key => citizen.inventory[key] > 0) &&
        travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
    if (citizen.profession === 'builder') {
      const dropped = world.resourceNodes.find(node => node.dropped && node.quantity > 0);
      if (dropped && travel(world, citizen, dropped, 'gather', dropped.id)) return;
    }
    if (citizen.profession === 'farmer' && available(store, 'food') < population * FOOD_TARGET_PER_PERSON) {
      const farm = world.buildings.find(b => b.kind === 'farm' && b.settlementId === citizen.settlementId &&
        (b.harvestAt ?? b.completedAt + FARM_HARVEST_TICKS) <= world.worldTimeTick);
      const goal = farm && workTile(world, tileOf(citizen), farm);
      if (goal && travel(world, citizen, goal, 'farm', farm.id)) return;
    }
    const candidates = (jobs[citizen.profession] ?? []).filter(key =>
      available(store, key) < (key === 'food' ? population * FOOD_TARGET_PER_PERSON : key === 'wood' ? 24 : 12));
    candidates.sort((a, b) => available(store, a) - available(store, b));
    for (const resource of candidates) {
      const current = tileOf(citizen);
      const distance = node => Math.abs(node.x - current.x) + Math.abs(node.y - current.y);
      const nodes = world.resourceNodes.filter(node => node.resource === resource).sort((a, b) => distance(a) - distance(b));
      for (const node of nodes) {
        if (node.resource === resource && node.quantity > 0 &&
            travel(world, citizen, node, 'gather', node.id)) return;
      }
    }
  }
  if (store && claimAdventure(world, citizen, store, (goal, kind, targetId) =>
    travel(world, citizen, goal, kind, targetId))) return;
  if (store && citizen.profession === 'builder' && constructionRoute(world, citizen, store, population)) return;
  const { x, y } = world.settlements.find(s => s.id === citizen.settlementId) ?? citizen.lastKnownSafeTile;
  const offset = () => Math.floor(random(world.rngState) * (2 * WANDER_RADIUS + 1)) - WANDER_RADIUS;
  travel(world, citizen, { x: x + offset(), y: y + offset() }, 'explore');
}

function perform(world, citizen, store, ticks) {
  const action = citizen.action;
  if (action.kind === 'expedition') {
    const expedition = world.expeditions.find(item => item.id === action.targetId);
    if (!expedition.arrivedIds.includes(citizen.id)) expedition.arrivedIds.push(citizen.id);
  }
  if (action.kind === 'adventure') {
    const quest = world.quests.find(q => q.id === action.targetId);
    if (adventure(world, citizen, quest, store)) return;
  }
  if (action.kind === 'sleep' && citizen.fatigue > 20) return;
  if (action.kind === 'gather') {
    action.progress += ticks;
    if (action.progress < GATHER_TICKS) return;
    const node = world.resourceNodes.find(n => n.id === action.targetId);
    harvest(world, citizen, node);
    if (store && node && citizen.inventory[node.resource] && travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
  }
  if (action.kind === 'farm') {
    const farm = world.buildings.find(b => b.id === action.targetId);
    if (farm && (farm.harvestAt ?? farm.completedAt + FARM_HARVEST_TICKS) <= world.worldTimeTick) {
      farm.harvestAt = world.worldTimeTick + FARM_HARVEST_TICKS;
      const multiplier = unlocked(world, citizen.settlementId, 'farming_1') ? TECH.farmYieldMultiplier : 1;
      citizen.inventory.food += Math.floor(FARM_YIELD * multiplier);
      if (store && travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
    }
  }
  if (action.kind === 'build') {
    const site = world.constructionSites.find(s => s.id === action.targetId);
    if (site && !buildAtSite(world, site, ticks)) return;
  }
  if (action.kind === 'pickUpMaterials') {
    pickUpMaterials(world, world.reservations.find(r => r.id === action.targetId), citizen);
  }
  if (action.kind === 'recoverMaterials') {
    const shipment = world.inTransit.find(item => item.id === action.targetId && item.carrierId === null);
    if (shipment) {
      shipment.carrierId = citizen.id;
      delete shipment.x;
      delete shipment.y;
    }
  }
  if (action.kind === 'deliverMaterials') {
    deliverMaterials(world, world.inTransit.find(item => item.id === action.targetId), citizen);
  }
  if (action.kind === 'haul' && store?.id === action.targetId) deposit(citizen, store);
  if (action.kind === 'eat' && store?.id === action.targetId) eat(citizen, store);
  citizen.action = idle(world.worldTimeTick);
}

export function updateCitizens(world, ticks) {
  renewNodes(world);
  const population = new Map();
  for (const c of world.citizens) {
    if (c.alive) population.set(c.settlementId, (population.get(c.settlementId) ?? 0) + 1);
  }
  for (const citizen of world.citizens) {
    if (!citizen.alive) continue;
    updateNeeds(world, citizen, ticks);
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
    if (citizen.action.phase === 'travel' &&
        citizen.action.navigationVersion !== world.map.navigationVersion) {
      const safe = citizen.lastKnownSafeTile;
      citizen.x = safe.x + 0.5;
      citizen.y = safe.y + 0.5;
      const path = findPath(world, safe, citizen.action.goal);
      if (path?.length) {
        Object.assign(citizen.action, { path, progress: 0, navigationVersion: world.map.navigationVersion });
      } else {
        citizen.action = path ? { ...citizen.action, phase: 'perform' } : idle(world.worldTimeTick);
      }
    }

    if (world.worldTimeTick >= citizen.decisionAt && citizen.action.phase === 'plan') {
      citizen.decisionAt = world.worldTimeTick + (citizen.decisionAt - world.worldTimeTick) % DECISION_TICKS;
      citizen.decisionAt += DECISION_TICKS;
      chooseRoute(world, citizen, store, population.get(citizen.settlementId));
    }

    if (citizen.action.phase === 'perform') {
      perform(world, citizen, store, ticks);
      continue;
    }
    let remaining = ticks;
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

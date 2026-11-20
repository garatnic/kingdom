import { DECISION_TICKS, WALK_TICKS, WANDER_RADIUS, TERRAIN_COST, FOOD_TARGET_PER_PERSON, NEEDS, GATHER_TICKS } from '../data/balance.js';
import { random } from '../engine/random.js';
import { findPath } from './path.js';
import { available, deposit, freeCapacity, harvest, renewNodes, resources } from './Economy.js';
import { eat, updateNeeds } from './Needs.js';
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

function chooseRoute(world, citizen, store, population) {
  if (store && citizen.hunger >= NEEDS.eat && available(store, 'food') > 0 &&
      travel(world, citizen, storeTile(world, store), 'eat', store.id)) return;
  if (citizen.fatigue >= NEEDS.sleep) {
    citizen.action = { ...idle(world.worldTimeTick), kind: 'sleep', phase: 'perform' };
    return;
  }
  if (store && freeCapacity(store) > 0) {
    if (resources.some(key => citizen.inventory[key] > 0) &&
        travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
    const candidates = (jobs[citizen.profession] ?? []).filter(key =>
      available(store, key) < (key === 'food' ? population * FOOD_TARGET_PER_PERSON : key === 'wood' ? 24 : 12));
    candidates.sort((a, b) => available(store, a) - available(store, b));
    for (const resource of candidates) {
      for (const node of world.resourceNodes) {
        if (node.resource === resource && node.quantity > 0 &&
            travel(world, citizen, node, 'gather', node.id)) return;
      }
    }
  }
  const { x, y } = world.settlements.find(s => s.id === citizen.settlementId) ?? world.settlements[0];
  const offset = () => Math.floor(random(world.rngState) * (2 * WANDER_RADIUS + 1)) - WANDER_RADIUS;
  travel(world, citizen, { x: x + offset(), y: y + offset() }, 'explore');
}

function perform(world, citizen, store, ticks) {
  const action = citizen.action;
  if (action.kind === 'sleep' && citizen.fatigue > 20) return;
  if (action.kind === 'gather') {
    action.progress += ticks;
    if (action.progress < GATHER_TICKS) return;
    const node = world.resourceNodes.find(n => n.id === action.targetId);
    harvest(world, citizen, node);
    if (store && node && citizen.inventory[node.resource] && travel(world, citizen, storeTile(world, store), 'haul', store.id)) return;
  }
  if (action.kind === 'haul' && store?.id === action.targetId) deposit(citizen, store);
  if (action.kind === 'eat' && store?.id === action.targetId) eat(citizen, store);
  citizen.action = idle(world.worldTimeTick);
}

export function updateCitizens(world, ticks) {
  renewNodes(world);
  const population = world.citizens.filter(c => c.alive).length;
  for (const citizen of world.citizens) {
    if (!citizen.alive) continue;
    updateNeeds(world, citizen, ticks);
    if (citizen.hp <= 0) {
      recordDeath(world, citizen, 'starvation');
      continue;
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
      chooseRoute(world, citizen, store, population);
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

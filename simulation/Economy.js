import {
  CONSTRUCTION_STORAGE_RESERVE, FOOD_TARGET_PER_PERSON, GATHER_BATCH, LARGE_SETTLEMENT_POPULATION,
  LAYOUT, NODE_RENEWAL_TICKS
} from '../data/balance.js';

export const resources = Object.keys(LAYOUT.provisions);
export const available = (store, resource) => store.total[resource] - store.reserved[resource];
export const freeCapacity = store => store.capacity - resources.reduce((sum, key) => sum + store.total[key], 0);

export function storeTile(world, store) {
  if (store.x !== undefined) return store;
  const settlement = world.settlements.find(s => s.id === store.settlementId);
  return { x: settlement.x + 1, y: settlement.y };
}

export function storageRoom(store, resource, foodTarget = 0) {
  const room = freeCapacity(store);
  const largeSettlement = foodTarget >= LARGE_SETTLEMENT_POPULATION * FOOD_TARGET_PER_PERSON;
  if (!largeSettlement) {
    return Math.max(0, resource === 'food' ? room : room - Math.max(0, foodTarget - store.total.food));
  }
  const woodNeeded = Math.max(0, CONSTRUCTION_STORAGE_RESERVE.wood - available(store, 'wood'));
  const stoneNeeded = Math.max(0, CONSTRUCTION_STORAGE_RESERVE.stone - available(store, 'stone'));
  const constructionRoom = woodNeeded + stoneNeeded;
  if (resource === 'food') return Math.max(0, Math.min(room - constructionRoom, foodTarget - store.total.food));
  const otherSupplyRoom = Math.max(0, room - constructionRoom - Math.max(0, foodTarget - store.total.food));
  const ownConstructionRoom = resource === 'wood' ? woodNeeded : resource === 'stone' ? stoneNeeded : 0;
  return Math.max(0, Math.min(room, otherSupplyRoom + ownConstructionRoom));
}

export function harvest(world, worker, node) {
  if (!worker.alive || !node || worker.settlementId == null ||
      worker.inventory[node.resource] !== 0 || node.quantity <= 0 ||
      worker.lastKnownSafeTile.x !== node.x || worker.lastKnownSafeTile.y !== node.y) return false;
  worker.inventory[node.resource] += extract(world, node, GATHER_BATCH);
  return true;
}

function extract(world, node, limit) {
  const quantity = Math.min(node.quantity, limit);
  node.quantity -= quantity;
  if (!node.dropped && node.quantity === 0 && Object.hasOwn(NODE_RENEWAL_TICKS, node.resource)) {
    node.renewAt = world.worldTimeTick + NODE_RENEWAL_TICKS[node.resource];
  }
  return quantity;
}

export function gatherForStore(world, node, store, foodTarget) {
  const room = storageRoom(store, node.resource, foodTarget);
  if (room <= 0 || node.quantity <= 0) return false;
  store.total[node.resource] += extract(world, node, Math.min(GATHER_BATCH, room));
  return true;
}

export function deposit(worker, store, foodTarget = 0) {
  if (!worker.alive || store.settlementId !== worker.settlementId) return false;
  let moved = 0;
  for (const resource of resources) {
    const quantity = Math.min(worker.inventory[resource], storageRoom(store, resource, foodTarget));
    worker.inventory[resource] -= quantity;
    store.total[resource] += quantity;
    moved += quantity;
  }
  return moved > 0;
}

export function renewNodes(world) {
  for (const node of world.resourceNodes) {
    if (node.resource === 'stone' && !node.dropped && node.quantity === 0 && node.renewAt === undefined) {
      node.renewAt = world.worldTimeTick + NODE_RENEWAL_TICKS.stone;
    }
    if (node.renewAt !== undefined && world.worldTimeTick >= node.renewAt) {
      node.quantity = LAYOUT.nodes.find(([resource]) => resource === node.resource)[2];
      delete node.renewAt;
    }
  }
}

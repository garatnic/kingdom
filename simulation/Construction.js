import { buildings, footprint, workTicks } from '../data/buildings.js';
import { nextId } from './Identity.js';
import { available, freeCapacity } from './Economy.js';
import {
  CONSTRUCTION_STORAGE_RESERVE, FOOD_BIRTH_PER_PERSON, FOOD_EMERGENCY_PER_PERSON,
  FOOD_TARGET_PER_PERSON, LARGE_SETTLEMENT_POPULATION
} from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { findPath, reachableTiles } from './path.js';

function availableSite(world, kind, x, y, allowForest = false) {
  const type = buildings[kind];
  if (!type || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  const site = { x, y, width: type.width, height: type.height };
  for (let dy = 0; dy < type.height; dy++) {
    for (let dx = 0; dx < type.width; dx++) {
      const tile = { x: x + dx, y: y + dy };
      if (tile.x < 0 || tile.x >= world.map.width || tile.y < 0 || tile.y >= world.map.height) return null;
      const terrain = world.map.terrain[tile.y * world.map.width + tile.x];
      if ((terrain !== 'grass' && !(allowForest && terrain === 'forest')) ||
          [...world.buildings, ...world.constructionSites].some(b => footprint(b, tile)) ||
          world.resourceNodes.some(n => n.x === tile.x && n.y === tile.y) ||
          world.stockpiles.some(s => s.x === tile.x && s.y === tile.y)) return null;
    }
  }
  return site;
}

export function planSite(world, settlement, kind, x, y, allowForest = false) {
  const site = availableSite(world, kind, x, y, allowForest);
  if (!site) return null;
  Object.assign(site, { id: nextId(world, 'site'), settlementId: settlement.id, kind, delivered: {}, progress: 0 });
  world.constructionSites.push(site);
  return site;
}

export function reserveMaterials(world, site, store) {
  if (store.settlementId !== site.settlementId || !world.constructionSites.includes(site) ||
      world.reservations.some(r => r.siteId === site.id)) return false;
  const materials = Object.entries(buildings[site.kind].cost);
  if (materials.some(([key, quantity]) => available(store, key) < quantity)) return false;
  for (const [resource, quantity] of materials) {
    const id = nextId(world, 'reservation');
    world.reservations.push({ id, reservationId: id, siteId: site.id, sourceId: store.id,
      resource, quantity, state: 'reserved' });
    store.reserved[resource] += quantity;
  }
  return true;
}

export function pickUpMaterials(world, reservation, carrier) {
  if (!world.reservations.includes(reservation) || reservation.state !== 'reserved' || !carrier.alive) return null;
  const store = world.stockpiles.find(s => s.id === reservation.sourceId);
  const { resource, quantity } = reservation;
  if (carrier.settlementId !== store?.settlementId || store.reserved[resource] < quantity ||
      store.total[resource] < quantity) return null;
  store.reserved[resource] -= quantity;
  store.total[resource] -= quantity;
  reservation.state = 'inTransit';
  const id = nextId(world, 'shipment');
  const shipment = { id, shipmentId: id, reservationId: reservation.id, sourceId: store.id,
    destinationId: reservation.siteId, carrierId: carrier.id, resource, quantity, state: 'inTransit' };
  world.inTransit.push(shipment);
  return shipment;
}

export function deliverMaterials(world, shipment, carrier) {
  if (!world.inTransit.includes(shipment) || shipment.state !== 'inTransit' ||
      shipment.carrierId !== carrier.id || !carrier.alive) return false;
  const site = world.constructionSites.find(s => s.id === shipment.destinationId);
  const reservation = world.reservations.find(r => r.id === shipment.reservationId);
  if (!site || reservation?.state !== 'inTransit') return false;
  site.delivered[shipment.resource] = (site.delivered[shipment.resource] ?? 0) + shipment.quantity;
  reservation.state = 'delivered';
  world.inTransit.splice(world.inTransit.indexOf(shipment), 1);
  return true;
}

export function materialsDelivered(site) {
  return Object.entries(buildings[site.kind].cost).every(([key, qty]) => site.delivered[key] === qty);
}

export function buildAtSite(world, site, ticks) {
  if (!world.constructionSites.includes(site) || !materialsDelivered(site) ||
      !Number.isSafeInteger(ticks) || ticks <= 0) return null;
  const percent = unlocked(world, site.settlementId, 'building_1') ? TECH.buildingWorkPercent : 100;
  const preciseTicks = ticks * percent + (site.workRemainder ?? 0);
  site.workRemainder = preciseTicks % 100;
  site.progress = Math.min(site.progress + Math.floor(preciseTicks / 100), workTicks(site.kind));
  if (site.progress < workTicks(site.kind) || world.monsters.some(m => m.alive && footprint(site, m)) ||
      world.citizens.some(c => c.alive &&
      (footprint(site, c.lastKnownSafeTile) || footprint(site, { x: Math.floor(c.x), y: Math.floor(c.y) }))) || !keepsPathsOpen(world, site)) return null;
  const { x, y, width, height, kind, settlementId } = site;
  const building = { id: nextId(world, 'building'), x, y, width, height, kind, settlementId, state: 'active',
    capacity: buildings[kind].capacity ?? 0, completedAt: world.worldTimeTick };
  world.buildings.push(building);
  if (kind === 'warehouse') {
    const store = world.stockpiles.find(candidate => candidate.settlementId === settlementId);
    if (store) store.capacity += building.capacity;
  }
  if (kind === 'house') {
    const residents = world.citizens.filter(c => c.alive && c.settlementId === settlementId && !c.homeBuildingId);
    for (const citizen of residents.slice(0, building.capacity)) citizen.homeBuildingId = building.id;
  }
  world.map.navigationVersion++;
  world.reservations = world.reservations.filter(r => r.siteId !== site.id);
  world.constructionSites.splice(world.constructionSites.indexOf(site), 1);
  emitOnce(world, site.id, 'constructionCompleted', { buildingId: building.id,
    settlementId, x, y, consumed: { ...site.delivered } });
  return building;
}

function perimeter(site) {
  const points = [];
  for (let x = site.x; x < site.x + site.width; x++) {
    points.push({ x, y: site.y - 1 }, { x, y: site.y + site.height });
  }
  for (let y = site.y; y < site.y + site.height; y++) {
    points.push({ x: site.x - 1, y }, { x: site.x + site.width, y });
  }
  return points;
}

function keepsPathsOpen(world, site) {
  const { width, height, terrain } = world.map;
  const indices = perimeter(site)
    .filter(t => t.x >= 0 && t.x < width && t.y >= 0 && t.y < height &&
      !world.buildings.some(building => footprint(building, t)))
    .map(t => t.y * width + t.x)
    .filter(index => terrain[index] !== 'water');
  if (indices.length < 2) return true;
  const start = { x: indices[0] % width, y: Math.floor(indices[0] / width) };
  const reachable = reachableTiles(world, start, site);
  return indices.every(index => reachable[index] === 1);
}

export function workTile(world, start, site) {
  const points = perimeter(site);
  let best = null;
  let distance = Infinity;
  for (const goal of points) {
    const path = findPath(world, start, goal);
    if (path !== null && path.length < distance) {
      best = goal;
      distance = path.length;
    }
  }
  return best;
}

export function planSettlementConstruction(world, settlement, store, origin, population) {
  const existing = world.constructionSites.find(site => site.settlementId === settlement.id);
  const local = world.buildings.filter(building => building.settlementId === settlement.id);
  const farms = local.filter(b => b.kind === 'farm').length;
  const housing = local.filter(b => b.kind === 'house').reduce((sum, b) => sum + b.capacity, 0);
  const hasCouples = world.citizens.some(c => c.alive && c.settlementId === settlement.id && c.partnerId);
  const growthReserve = population >= 16 && available(store, 'food') >= population * FOOD_BIRTH_PER_PERSON ? Math.max(2, Math.ceil(population / 12)) : 0;
  const needsHousing = housing < population + growthReserve || (hasCouples && housing === population);
  const policy = world.nations.find(n => n.id === settlement.nationId)?.policy.primary;
  const facilityOrder = policy === 'defense'
    ? ['warehouse', 'barracks', 'smithy', 'guild'] : ['warehouse', 'smithy', 'guild', 'barracks'];
  const farmTarget = Math.max(TECH.farmEraFarms, Math.ceil(population / 8));
  const farmReserve = population >= LARGE_SETTLEMENT_POPULATION ? FOOD_BIRTH_PER_PERSON : FOOD_EMERGENCY_PER_PERSON;
  const requiresFarms = farms < farmTarget &&
    (available(store, 'food') < population * farmReserve ||
      (policy === 'food' && available(store, 'food') < population * 4) ||
      (farms < TECH.farmEraFarms && local.some(b => b.kind === 'warehouse') && population >= TECH.farmEraPopulation &&
        unlocked(world, settlement.id, 'farming_1')));
  const emergencySpace = population * (population >= 24 ? FOOD_BIRTH_PER_PERSON : FOOD_EMERGENCY_PER_PERSON);
  const needsGrowthStorage = population >= LARGE_SETTLEMENT_POPULATION &&
    store.capacity < population * FOOD_TARGET_PER_PERSON + CONSTRUCTION_STORAGE_RESERVE;
  const cramped = needsGrowthStorage || freeCapacity(store) + store.total.food < emergencySpace;
  const urgent = cramped ? 'warehouse' : farms === 0 || requiresFarms ? 'farm' : needsHousing ? 'house' : null;
  if (existing) {
    const committed = world.reservations.some(r => r.siteId === existing.id);
    if (!urgent || urgent === existing.kind || committed) return existing;
    cancelSite(world, existing);
  }
  const kind = urgent ?? facilityOrder.find(type => !local.some(b => b.kind === type) &&
    Object.entries(buildings[type].cost).every(([resource, quantity]) => available(store, resource) >= quantity));
  if (!kind) return null;
  const allowForest = population >= LARGE_SETTLEMENT_POPULATION && (kind === 'house' || kind === 'warehouse');
  const { width, height } = world.map;
  let connected;
  for (let radius = 1; radius <= 12; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = settlement.x + dx;
        const y = settlement.y + dy;
        const footprintCandidate = availableSite(world, kind, x, y, allowForest);
        if (!footprintCandidate || footprint(footprintCandidate, origin)) continue;
        connected ??= reachableTiles(world, origin);
        const accessible = perimeter(footprintCandidate).some(tile => tile.x >= 0 && tile.x < width &&
          tile.y >= 0 && tile.y < height && connected[tile.y * width + tile.x] === 1);
        if (!accessible || !keepsPathsOpen(world, footprintCandidate)) continue;
        const site = planSite(world, settlement, kind, x, y, allowForest);
        if (site) return site;
      }
    }
  }
  return null;
}

export function cancelSite(world, site) {
  const index = world.constructionSites.indexOf(site);
  if (index < 0) return false;
  const reservations = world.reservations.filter(r => r.siteId === site.id);
  const dropMaterials = (resource, quantity, tile) => {
    world.resourceNodes.push({ id: nextId(world, 'node'), resource, quantity,
      x: tile.x, y: tile.y, dropped: true });
  };
  for (const reservation of reservations) {
    const store = world.stockpiles.find(s => s.id === reservation.sourceId);
    const { resource, quantity, state } = reservation;
    if (state === 'reserved') store.reserved[resource] -= quantity;
    if (state === 'delivered') dropMaterials(resource, quantity, site);
    if (state === 'inTransit') {
      const shipment = world.inTransit.find(s => s.reservationId === reservation.id);
      const carrier = world.citizens.find(person => person.id === shipment.carrierId);
      dropMaterials(resource, quantity, carrier?.lastKnownSafeTile ?? shipment);
      world.inTransit.splice(world.inTransit.indexOf(shipment), 1);
    }
  }
  world.reservations = world.reservations.filter(r => r.siteId !== site.id);
  world.constructionSites.splice(index, 1);
  return true;
}

import { CONSTRUCTION_STORAGE_RESERVE, FOOD_BIRTH_PER_PERSON, FOOD_TARGET_PER_PERSON, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { NATIONS } from '../data/nations.js';
import { buildings } from '../data/buildings.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { emitOnce } from '../systems/History.js';
import { available, storageRoom, storeTile } from './Economy.js';
import { findPath } from './path.js';

export function updateFoodAid(world) {
  if (!world.settlements.some(settlement => settlement.foodAid || settlement.materialAid || settlement.nationId)) return;
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  const stores = new Map(world.stockpiles.map(store => [store.settlementId, store]));
  const settlements = new Map(world.settlements.map(settlement => [settlement.id, settlement]));
  const population = new Map();
  for (const citizen of world.citizens) {
    if (citizen.alive) population.set(citizen.settlementId, (population.get(citizen.settlementId) ?? 0) + 1);
  }

  function route(from, to) {
    return findPath(world, storeTile(world, from), storeTile(world, to));
  }

  const nations = new Map(world.nations.map(nation => [nation.id, nation]));
  function friendly(sourceId, destinationId) {
    const source = nations.get(sourceId);
    const destination = nations.get(destinationId);
    return source && destination && source.fallenAt === undefined && destination.fallenAt === undefined &&
      (source.relations?.[destinationId] ?? 0) >= NATIONS.friendly &&
      (destination.relations?.[sourceId] ?? 0) >= NATIONS.friendly &&
      !world.campaigns?.some(c => (c.status === 'marching' || c.status === 'siege') &&
        ((c.attackerId === sourceId && c.defenderId === destinationId) ||
          (c.attackerId === destinationId && c.defenderId === sourceId)));
  }

  function settle(destination, field, resource, quantityKey) {
    const aid = destination[field];
    if (!aid || day < aid.arrivalDay) return;
    const source = settlements.get(aid.sourceId);
    const from = stores.get(aid.sourceId);
    const to = stores.get(destination.id);
    const residents = population.get(destination.id) ?? 0;
    const partiesValid = source.nationId === aid.nationId &&
      destination.nationId === (aid.recipientNationId ?? aid.nationId) &&
      (!aid.recipientNationId || friendly(aid.nationId, aid.recipientNationId));
    if (!aid.returning && partiesValid && residents && route(from, to)) {
      const delivered = Math.min(aid[quantityKey], storageRoom(to, resource, residents * FOOD_TARGET_PER_PERSON));
      if (delivered) {
        to.total[resource] += delivered;
        aid[quantityKey] -= delivered;
        const food = resource === 'food';
        emitOnce(world, `${destination.id}/${field}/${day}`, food ? (aid.recipientNationId ? 'foreignFoodAidDelivered' : 'foodAidDelivered') : 'materialAidDelivered', {
          settlementId: destination.id, nationId: destination.nationId, sourceSettlementId: source.id,
          x: destination.x, y: destination.y, ...(food ? { food: delivered } : { resource, quantity: delivered }),
          ...(aid.recipientNationId ? { nationIds: [aid.nationId, aid.recipientNationId] } : {})
        });
      }
    }
    if (!aid[quantityKey]) {
      delete destination[field];
    } else if (!aid.returning) {
      aid.returning = true;
      aid.arrivalDay = day + aid.travelDays;
    } else if (route(to, from)) {
      const returned = Math.min(aid[quantityKey], storageRoom(from, resource));
      from.total[resource] += returned;
      aid[quantityKey] -= returned;
      if (!aid[quantityKey]) delete destination[field];
    }
  }

  for (const destination of world.settlements) {
    settle(destination, 'foodAid', 'food', 'food');
    settle(destination, 'materialAid', destination.materialAid?.resource, 'quantity');
  }

  const recipients = world.settlements.filter(settlement => settlement.foodWarning &&
    settlement.nationId && population.get(settlement.id) && !settlement.foodAid);
  const foodPerResident = settlement => available(stores.get(settlement.id), 'food') / population.get(settlement.id);
  recipients.sort((a, b) => foodPerResident(a) - foodPerResident(b));
  for (const destination of recipients) {
    const residents = population.get(destination.id);
    const to = stores.get(destination.id);
    const needed = Math.min(residents * FOOD_BIRTH_PER_PERSON - available(to, 'food'),
      storageRoom(to, 'food', residents * FOOD_TARGET_PER_PERSON));
    if (needed <= 0) continue;
    const sources = world.settlements.filter(source => source !== destination && !source.foodWarning &&
      (source.nationId === destination.nationId || friendly(source.nationId, destination.nationId)));
    sources.sort((a, b) => Number(b.nationId === destination.nationId) - Number(a.nationId === destination.nationId));
    for (const source of sources) {
      const adultsAndChildren = population.get(source.id);
      if (!adultsAndChildren) continue;
      const from = stores.get(source.id);
      const food = Math.min(needed, adultsAndChildren, available(from, 'food') - adultsAndChildren * FOOD_BIRTH_PER_PERSON);
      if (food <= 0) continue;
      const path = route(from, to);
      if (!path) continue;
      const travelDays = Math.max(1, Math.ceil(path.length / 32));
      from.total.food -= food;
      destination.foodAid = { sourceId: source.id, nationId: source.nationId,
        food, travelDays, arrivalDay: day + travelDays, returning: false };
      if (source.nationId !== destination.nationId) destination.foodAid.recipientNationId = destination.nationId;
      break;
    }
  }

  const projectNeeds = new Map(world.constructionSites.map(site => [site.settlementId,
    world.reservations.some(r => r.siteId === site.id) ? {} : buildings[site.kind].cost]));
  const steelDemand = TECH.miningToolIron + TECH.miningToolIronReserve;
  const industrialNeeds = new Map();
  for (const smithy of world.buildings.filter(b => b.kind === 'smithy')) {
    const id = smithy.settlementId;
    if (unlocked(world, id, 'steel_1') && world.citizens.some(c =>
        c.alive && c.settlementId === id && c.profession === 'miner' && !c.steelMiningTools)) {
      industrialNeeds.set(id, steelDemand);
    }
  }

  for (const destination of world.settlements) {
    const residents = population.get(destination.id);
    if (!residents || destination.foodWarning || !destination.nationId || destination.materialAid) continue;
    const to = stores.get(destination.id);
    const demand = { ...projectNeeds.get(destination.id) };
    demand.iron = Math.max(demand.iron ?? 0, industrialNeeds.get(destination.id) ?? 0);
    for (const [resource, target] of Object.entries(demand)) {
      const needed = Math.min(target - available(to, resource), storageRoom(to, resource, residents * FOOD_TARGET_PER_PERSON));
      if (needed <= 0) continue;
      for (const source of world.settlements) {
        if (source === destination || source.nationId !== destination.nationId || source.foodWarning ||
            !population.has(source.id)) continue;
        const from = stores.get(source.id);
        const reserve = Math.max(CONSTRUCTION_STORAGE_RESERVE[resource] ?? TECH.miningToolIronReserve,
          projectNeeds.get(source.id)?.[resource] ?? 0, resource === 'iron' ? industrialNeeds.get(source.id) ?? 0 : 0);
        const quantity = Math.min(needed, available(from, resource) - reserve);
        if (quantity <= 0) continue;
        const path = route(from, to);
        if (!path) continue;
        const travelDays = Math.max(1, Math.ceil(path.length / 32));
        from.total[resource] -= quantity;
        destination.materialAid = { sourceId: source.id, nationId: source.nationId,
          resource, quantity, travelDays, arrivalDay: day + travelDays, returning: false };
        break;
      }
      if (destination.materialAid) break;
    }
  }
}

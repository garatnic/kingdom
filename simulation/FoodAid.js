import { FOOD_BIRTH_PER_PERSON, FOOD_TARGET_PER_PERSON, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { available, storageRoom, storeTile } from './Economy.js';
import { findPath } from './path.js';

export function updateFoodAid(world) {
  if (!world.settlements.some(settlement => settlement.foodAid || (settlement.foodWarning && settlement.nationId))) return;
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

  for (const destination of world.settlements) {
    const aid = destination.foodAid;
    if (!aid || day < aid.arrivalDay) continue;
    const source = settlements.get(aid.sourceId);
    const from = stores.get(aid.sourceId);
    const to = stores.get(destination.id);
    const residents = population.get(destination.id) ?? 0;
    const sameNation = source.nationId === aid.nationId && destination.nationId === aid.nationId;
    if (!aid.returning && sameNation && residents && route(from, to)) {
      const delivered = Math.min(aid.food, storageRoom(to, 'food', residents * FOOD_TARGET_PER_PERSON));
      if (delivered) {
        to.total.food += delivered;
        aid.food -= delivered;
        emitOnce(world, `${destination.id}/foodAid/${day}`, 'foodAidDelivered', {
          settlementId: destination.id, nationId: destination.nationId, sourceSettlementId: source.id,
          x: destination.x, y: destination.y, food: delivered
        });
      }
    }
    if (aid.food && !aid.returning) {
      aid.returning = true;
      aid.arrivalDay = day + aid.travelDays;
    } else if (aid.food) {
      const returned = Math.min(aid.food, storageRoom(from, 'food'));
      from.total.food += returned;
      aid.food -= returned;
    }
    if (!aid.food) delete destination.foodAid;
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
    for (const source of world.settlements) {
      if (source === destination || source.nationId !== destination.nationId || source.foodWarning) continue;
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
      break;
    }
  }
}

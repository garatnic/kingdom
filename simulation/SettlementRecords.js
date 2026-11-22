import { FOOD_BIRTH_PER_PERSON, FOOD_EMERGENCY_PER_PERSON, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { available } from './Economy.js';

export const RECORD_DAYS = 30;

export function observancesFor(settlement) {
  return settlement?.observances ?? (settlement?.observance ? [settlement.observance] : []);
}

export function rememberRecovery(world, settlement, event, kind) {
  if (!settlement) return;
  const existing = observancesFor(settlement);
  if (existing.some(memory => memory.kind === kind)) return;
  settlement.observances = [...existing, { kind, originEventId: event.id,
    nextDay: Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY) + 5 }];
  delete settlement.observance;
}

export function recordSettlements(world) {
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  const counts = new Map(world.settlements.map(s => [s.id, { population: 0, hungry: 0, waitingCargo: 0 }]));
  for (const citizen of world.citizens) {
    const count = counts.get(citizen.settlementId);
    if (!citizen.alive || !count) continue;
    count.population++;
    if (citizen.hunger >= NEEDS.eat) count.hungry++;
  }
  const sites = new Map(world.constructionSites.map(site => [site.id, site.settlementId]));
  for (const shipment of world.inTransit) {
    const count = counts.get(sites.get(shipment.destinationId));
    if (count && shipment.carrierId === null) count.waitingCargo += shipment.quantity;
  }
  for (const settlement of world.settlements) {
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    if (!store) continue;
    const records = settlement.dailyRecords ??= [];
    if (records.at(-1)?.day === day) continue;
    const current = { day, food: available(store, 'food'), ...counts.get(settlement.id) };
    const previous = records.at(-1);
    records.push(current);
    if (!current.population) delete settlement.foodWarning;
    if (current.population) {
      const short = record => record && record.population > 0 &&
        record.food < record.population * FOOD_EMERGENCY_PER_PERSON;
      const alert = settlement.foodWarning === true;
      const nextAlert = alert ? current.food < current.population * FOOD_BIRTH_PER_PERSON :
        previous?.day === day - 1 && short(previous) && short(current);
      if (nextAlert !== alert) {
        settlement.foodWarning = nextAlert;
        const shortage = !nextAlert && world.events.findLast(event =>
          event.settlementId === settlement.id && event.type === 'foodShortage');
        const recorded = emitOnce(world, `${settlement.id}/food/${day}`, nextAlert ? 'foodShortage' : 'foodRecovered', {
          settlementId: settlement.id, nationId: settlement.nationId, x: settlement.x, y: settlement.y,
          food: current.food, population: current.population,
          ...(shortage && { causeEventId: shortage.id, foodAtShortage: shortage.food })
        });
        if (recorded && shortage) rememberRecovery(world, settlement, world.events.at(-1), 'scarcity');
      }
    }
    if (records.length > RECORD_DAYS) records.shift();
  }
}

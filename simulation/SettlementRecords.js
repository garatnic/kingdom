import { NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { available } from './Economy.js';

export const RECORD_DAYS = 30;

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
    records.push({ day, food: available(store, 'food'), ...counts.get(settlement.id) });
    if (records.length > RECORD_DAYS) records.shift();
  }
}

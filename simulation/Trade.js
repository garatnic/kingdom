import { FOOD_TARGET_PER_PERSON, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { friendlyNations } from './Diplomacy.js';
import { available, storageRoom, storeTile } from './Economy.js';
import { findPath } from './path.js';

const targets = { wood: 10, stone: 5, iron: 4, manaStone: 5 };

function exchange(first, second) {
  return Object.entries(targets).find(([resource, target]) =>
    available(first, resource) >= target + 2 && available(second, resource) < target)?.[0];
}

export function updateTrade(world) {
  if (world.nations.length < 2) return;
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  const nations = new Map(world.nations.map(nation => [nation.id, nation]));
  const settlements = new Map(world.settlements.map(settlement => [settlement.id, settlement]));
  const stores = new Map(world.stockpiles.map(store => [store.settlementId, store]));
  const route = (a, b) => findPath(world, storeTile(world, a), storeTile(world, b));
  const population = new Map();
  for (const c of world.citizens) {
    if (c.alive) population.set(c.settlementId, (population.get(c.settlementId) ?? 0) + 1);
  }
  const foodTarget = id => (population.get(id) ?? 0) * FOOD_TARGET_PER_PERSON;
  const busy = new Set();
  for (const a of world.settlements) {
    const trade = a.trade;
    if (!trade) continue;
    const b = settlements.get(trade.partnerId);
    const first = stores.get(a.id);
    const second = stores.get(b.id);
    busy.add(a.id);
    busy.add(b.id);
    if (trade.arrivalDay > day) continue;
    if (!trade.returning) {
      const valid = a.nationId === trade.firstNationId && b.nationId === trade.secondNationId &&
        friendlyNations(world, nations.get(a.nationId), nations.get(b.nationId)) &&
        !a.foodWarning && !b.foodWarning && population.has(a.id) && population.has(b.id) &&
        storageRoom(first, trade.incoming, foodTarget(a.id)) >= trade.incomingQuantity &&
        storageRoom(second, trade.outgoing, foodTarget(b.id)) >= trade.outgoingQuantity;
      if (valid && route(first, second)) {
        first.total[trade.incoming] += trade.incomingQuantity;
        second.total[trade.outgoing] += trade.outgoingQuantity;
        emitOnce(world, `${a.id}/${b.id}/trade/${day}`, 'internationalTradeCompleted', {
          settlementId: a.id, sourceSettlementId: b.id, nationIds: [a.nationId, b.nationId],
          x: a.x, y: a.y, outgoing: trade.outgoing, incoming: trade.incoming,
          quantity: trade.outgoingQuantity
        });
        delete a.trade;
      } else {
        trade.returning = true;
        trade.arrivalDay = day + trade.travelDays;
      }
      continue;
    }

    if (!route(second, first)) continue;
    const returnedOutgoing = Math.min(trade.outgoingQuantity, storageRoom(first, trade.outgoing));
    const returnedIncoming = Math.min(trade.incomingQuantity, storageRoom(second, trade.incoming));
    first.total[trade.outgoing] += returnedOutgoing;
    second.total[trade.incoming] += returnedIncoming;
    trade.outgoingQuantity -= returnedOutgoing;
    trade.incomingQuantity -= returnedIncoming;
    if (!trade.outgoingQuantity && !trade.incomingQuantity) delete a.trade;
  }

  if (day % 5 !== 0) return;
  const capitals = world.nations.filter(n => n.fallenAt === undefined).map(n => settlements.get(n.capitalId))
    .filter(s => s && population.has(s.id) && !s.foodWarning);
  for (const [index, a] of capitals.entries()) {
    if (busy.has(a.id)) continue;
    for (const b of capitals.slice(index + 1)) {
      if (busy.has(b.id) || !friendlyNations(world, nations.get(a.nationId), nations.get(b.nationId))) continue;
      const first = stores.get(a.id);
      const second = stores.get(b.id);
      const outgoing = exchange(first, second);
      const incoming = exchange(second, first);
      if (!outgoing || !incoming) continue;
      const quantity = Math.min(2, targets[incoming] - available(first, incoming),
        targets[outgoing] - available(second, outgoing));
      if (storageRoom(first, incoming, foodTarget(a.id)) < quantity ||
          storageRoom(second, outgoing, foodTarget(b.id)) < quantity) continue;
      const path = route(first, second);
      if (!path) continue;
      const travelDays = Math.max(1, Math.ceil(path.length / 32));
      first.total[outgoing] -= quantity;
      second.total[incoming] -= quantity;
      a.trade = { partnerId: b.id, firstNationId: a.nationId, secondNationId: b.nationId,
        outgoing, incoming, outgoingQuantity: quantity, incomingQuantity: quantity,
        travelDays, arrivalDay: day + travelDays, returning: false };
      busy.add(b.id);
      break;
    }
  }
}

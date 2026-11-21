import { arcaneGearDemand } from './Industry.js';
import { FOOD_TARGET_PER_PERSON, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { offerTradeEscort } from './Adventure.js';
import { buildings } from '../data/buildings.js';
import { emitOnce } from '../systems/History.js';
import { friendlyNations } from './Diplomacy.js';
import { available, storageRoom, storeTile } from './Economy.js';
import { findPath } from './path.js';

const targets = { wood: 10, stone: 5, iron: 4, manaStone: 5 };

function exchange(source, destination, sourceTargets, destinationTargets, foodTarget, reciprocal = false) {
  for (const resource of Object.keys(targets)) {
    const stock = available(source, resource);
    const received = available(destination, resource);
    const wanted = reciprocal ? Math.floor((stock - received) / 2) : destinationTargets[resource] - received;
    const quantity = Math.min(2, stock - sourceTargets[resource], wanted,
      storageRoom(destination, resource, foodTarget));
    if (quantity > 0) return { resource, quantity };
  }
  return null;
}

function recruitEscort(world, a, b, first, second, path) {
  const firstDepot = storeTile(world, first);
  const secondDepot = storeTile(world, second);
  const escortQuestId = offerTradeEscort(world, a, b, secondDepot, path) ??
    offerTradeEscort(world, b, a, firstDepot, [...path.slice(0, -1)].reverse().concat(firstDepot));
  if (escortQuestId) a.trade.escortQuestId = escortQuestId;
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
      const escort = trade.escortQuestId && world.quests.find(q => q.id === trade.escortQuestId);
      const path = valid && route(first, second);
      // A monster can reach the road after dispatch, including after a save and reload.
      if (path && !trade.escortQuestId) {
        recruitEscort(world, a, b, first, second, path);
        if (trade.escortQuestId) continue;
      }
      if (path && escort && ['open', 'claimed'].includes(escort.status) &&
          world.worldTimeTick < escort.expiresAt + TIME_TICKS_PER_DAY) continue;
      if (path && (!trade.escortQuestId || escort?.status === 'completed')) {
        first.total[trade.incoming] += trade.incomingQuantity;
        second.total[trade.outgoing] += trade.outgoingQuantity;
        emitOnce(world, `${a.id}/${b.id}/trade/${day}`, 'internationalTradeCompleted', {
          settlementId: a.id, sourceSettlementId: b.id, nationIds: [a.nationId, b.nationId],
          x: a.x, y: a.y, outgoing: trade.outgoing, incoming: trade.incoming,
          quantity: trade.outgoingQuantity
        });
        delete a.trade;
      } else {
        if (escort?.status === 'open') escort.status = 'expired';
        if (escort?.status === 'claimed') {
          escort.retreated = true;
          escort.stage = 'return';
        }
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
  const reserves = new Map(capitals.map(capital => {
    const site = world.constructionSites.find(item => item.settlementId === capital.id);
    const cost = site && !world.reservations.some(reservation => reservation.siteId === site.id)
      ? buildings[site.kind].cost : {};
    const industry = arcaneGearDemand(world, stores.get(capital.id));
    return [capital.id, Object.fromEntries(Object.entries(targets)
      .map(([resource, target]) => [resource, Math.max(target, cost[resource] ?? 0, industry[resource] ?? 0)]))];
  }));
  for (const [index, a] of capitals.entries()) {
    if (busy.has(a.id)) continue;
    for (const b of capitals.slice(index + 1)) {
      if (busy.has(b.id) || !friendlyNations(world, nations.get(a.nationId), nations.get(b.nationId))) continue;
      const first = stores.get(a.id);
      const second = stores.get(b.id);
      const firstTargets = reserves.get(a.id);
      const secondTargets = reserves.get(b.id);
      const firstOffer = exchange(first, second, firstTargets, secondTargets, foodTarget(b.id));
      const secondOffer = exchange(second, first, secondTargets, firstTargets, foodTarget(a.id));
      if (!firstOffer && !secondOffer) continue;
      const outgoingOffer = firstOffer ?? exchange(first, second, firstTargets, secondTargets, foodTarget(b.id), true);
      const incomingOffer = secondOffer ?? exchange(second, first, secondTargets, firstTargets, foodTarget(a.id), true);
      if (!outgoingOffer || !incomingOffer || outgoingOffer.resource === incomingOffer.resource) continue;
      const outgoing = outgoingOffer.resource;
      const incoming = incomingOffer.resource;
      const quantity = Math.min(outgoingOffer.quantity, incomingOffer.quantity);
      const path = route(first, second);
      if (!path) continue;
      const travelDays = Math.max(1, Math.ceil(path.length / 32));
      first.total[outgoing] -= quantity;
      second.total[incoming] -= quantity;
      a.trade = { partnerId: b.id, firstNationId: a.nationId, secondNationId: b.nationId,
        outgoing, incoming, outgoingQuantity: quantity, incomingQuantity: quantity,
        travelDays, arrivalDay: day + travelDays, returning: false };
      recruitEscort(world, a, b, first, second, path);
      busy.add(b.id);
      break;
    }
  }
}

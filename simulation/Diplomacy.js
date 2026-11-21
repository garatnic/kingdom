import { TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { NATIONS } from '../data/nations.js';

export function friendlyNations(world, source, destination) {
  return source && destination && source.id !== destination.id && source.fallenAt === undefined && destination.fallenAt === undefined &&
    (source.relations?.[destination.id] ?? 0) >= NATIONS.friendly &&
    (destination.relations?.[source.id] ?? 0) >= NATIONS.friendly &&
    !world.campaigns?.some(c => (c.status === 'marching' || c.status === 'siege') &&
    ((c.attackerId === source.id && c.defenderId === destination.id) ||
      (c.attackerId === destination.id && c.defenderId === source.id)));
}

export function alliedNations(world, first, second) {
  const since = first?.alliances?.[second?.id];
  return since !== undefined && since === second.alliances?.[first.id] && friendlyNations(world, first, second);
}

export function updateAlliances(world) {
  const now = world.worldTimeTick;
  const lookback = 90 * TIME_TICKS_PER_DAY;
  const exchanges = new Map();
  for (const event of world.events) {
    if (!['internationalTradeCompleted', 'foreignFoodAidDelivered'].includes(event.type) ||
        event.worldTimeTick < now - lookback || event.nationIds?.length !== 2) continue;
    const key = [...event.nationIds].sort().join('/');
    const count = exchanges.get(key) ?? 0;
    exchanges.set(key, count + 1);
  }

  for (const [index, first] of world.nations.entries()) {
    for (const second of world.nations.slice(index + 1)) {
      const key = [first.id, second.id].sort().join('/');
      const friendly = friendlyNations(world, first, second);
      const since = first.alliances?.[second.id];
      if (since !== undefined && !friendly) {
        delete first.alliances[second.id];
        delete second.alliances[first.id];
        emitOnce(world, `${key}/${since}`, 'allianceEnded', { nationIds: [first.id, second.id] });
      } else if (since === undefined && friendly && (exchanges.get(key) ?? 0) >= 2) {
        // Let the previous exchange window expire before the pair can form another pact.
        const ended = world.events.findLast(event => event.type === 'allianceEnded' &&
          event.nationIds.includes(first.id) && event.nationIds.includes(second.id));
        if (ended && now - ended.worldTimeTick < lookback) continue;
        first.alliances ??= {};
        second.alliances ??= {};
        first.alliances[second.id] = second.alliances[first.id] = now;
        const capital = world.settlements.find(settlement => settlement.id === first.capitalId);
        emitOnce(world, `${key}/${now}`, 'allianceFormed', {
          nationIds: [first.id, second.id], x: capital.x, y: capital.y
        });
      }
    }
  }
}

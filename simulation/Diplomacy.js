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

export function allianceProgress(world) {
  const now = world.worldTimeTick;
  const lookback = 90 * TIME_TICKS_PER_DAY;
  const exchanges = new Map();
  const envoyVisits = new Map();
  const endedAt = new Map();
  for (const event of world.events) {
    if (event.worldTimeTick < now - lookback || event.nationIds?.length !== 2) continue;
    if (event.type === 'allianceEnded') {
      endedAt.set([...event.nationIds].sort().join('/'), event.worldTimeTick);
    }
    if (event.type === 'internationalTradeCompleted' || event.type === 'foreignFoodAidDelivered') {
      const key = [...event.nationIds].sort().join('/');
      exchanges.set(key, (exchanges.get(key) ?? 0) + 1);
    } else if (world.settings.alliedIntervention) {
      if (event.type === 'pactEnvoyArrived') {
        const key = [...event.nationIds].sort().join('/');
        envoyVisits.set(key, (envoyVisits.get(key) ?? 0) + 1);
      } else if (['borderFriction', 'allianceEnded', 'friendshipReached', 'warDeclared'].includes(event.type)) {
        envoyVisits.delete([...event.nationIds].sort().join('/'));
      }
    }
  }

  return (first, second) => {
    const key = [first.id, second.id].sort().join('/');
    const cooldown = (endedAt.get(key) ?? -Infinity) + lookback - now;
    return {
      exchanges: exchanges.get(key) ?? 0, requiredExchanges: 2,
      envoyVisits: envoyVisits.get(key) ?? 0, requiredEnvoys: world.settings.alliedIntervention ? 3 : null,
      cooldownDays: Math.max(0, Math.ceil(cooldown / TIME_TICKS_PER_DAY))
    };
  };
}

export function updateAlliances(world) {
  const now = world.worldTimeTick;
  const progressFor = allianceProgress(world);
  for (const [index, first] of world.nations.entries()) {
    for (const second of world.nations.slice(index + 1)) {
      const key = [first.id, second.id].sort().join('/');
      const friendly = friendlyNations(world, first, second);
      const since = first.alliances?.[second.id];
      const progress = progressFor(first, second);
      const throughExchange = progress.exchanges >= progress.requiredExchanges;
      const throughEnvoys = progress.requiredEnvoys !== null && progress.envoyVisits >= progress.requiredEnvoys;
      if (since !== undefined && !friendly) {
        delete first.alliances[second.id];
        delete second.alliances[first.id];
        emitOnce(world, `${key}/${since}`, 'allianceEnded', { nationIds: [first.id, second.id] });
      } else if (since === undefined && friendly && (throughExchange || throughEnvoys)) {
        if (progress.cooldownDays > 0) continue;
        first.alliances ??= {};
        second.alliances ??= {};
        first.alliances[second.id] = second.alliances[first.id] = now;
        const capital = world.settlements.find(settlement => settlement.id === first.capitalId);
        emitOnce(world, `${key}/${now}`, 'allianceFormed', {
          nationIds: [first.id, second.id], x: capital.x, y: capital.y,
          ...(throughEnvoys && !throughExchange && { basis: 'envoys' })
        });
      }
    }
  }
}

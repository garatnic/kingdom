import { nextId } from '../simulation/Identity.js';

const importance = {
  terrainCorrection: 1, adventureDeparted: 1, adventureReturned: 1,
  constructionCompleted: 2, monsterDefeated: 2, monsterPredation: 2, monsterNestFounded: 2, monsterNestCleared: 3, cooperativeExpedition: 2, supplyRecoveryDeparted: 1, supplyRecoveryReturned: 2, borderFriction: 2,
  marriage: 3, birth: 3, migrantArrived: 3, independentExpedition: 3, settlementFounded: 3, god_intervention: 3,
  adventurerRankUp: 3, combatLevelUp: 2, adventurerEquipped: 2,
  warDeclared: 4, fieldBattle: 4, siegeStarted: 3, territoryOccupied: 4, siegeRepelled: 3, campaignCancelled: 4, truceAgreed: 4, peaceAgreed: 4, nationFallen: 5, frontierDiscovered: 3, founding: 4, leaderSucceeded: 4, research_unlocked: 4, death: 5, civilizationAdvanced: 5
};

export const eventImportance = event => event.importance ?? importance[event.type] ?? 0;

export function emitOnce(world, sourceTransactionId, type, detail) {
  if (world.events.some(e => e.sourceTransactionId === sourceTransactionId && e.type === type)) return false;
  world.events.push({ ...detail, sourceTransactionId, type, id: nextId(world, 'event'),
    worldTimeTick: world.worldTimeTick, importance: importance[type] ?? 0 });
  return true;
}

export function historyFor(world, kind, id) {
  if (!id && kind !== 'world') return [];
  return world.events.filter(e => {
    if (kind === 'world') return eventImportance(e) >= 2;
    if (kind === 'citizen') {
      return e.citizenId === id || e.leaderId === id || e.citizenIds?.includes(id) ||
        e.parentIds?.includes(id) || e.actorIds?.includes(id) || e.affectedCitizenIds?.includes(id);
    }
    const nation = world.nations.find(n => n.id === id);
    const research = world.researchStates.find(state => state.ownerId === id);
    return e.nationId === id || e.ownerId === id || e.nationIds?.includes(id) ||
      nation?.settlementIds.includes(e.settlementId) || (Boolean(research) && e.researchId === research.id);
  });
}

export function trimHistory(world) {
  const limits = { 1: 500, 2: 2000 };
  const counts = {};
  const next = [];
  for (let i = world.events.length - 1; i >= 0; i--) {
    const event = world.events[i];
    const level = eventImportance(event);
    counts[level] = (counts[level] ?? 0) + 1;
    if (level > 0 && counts[level] <= (limits[level] ?? Infinity)) next.push(event);
  }
  world.events = next.reverse();
}

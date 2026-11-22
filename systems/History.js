import { nextId } from '../simulation/Identity.js';

const importance = {
  pactEnvoyArrived: 2, campaignRationsRecovered: 2, aidReturning: 2, aidReturned: 2, internationalTradeReturned: 2,
  healingReceived: 1, terrainCorrection: 1, adventureDeparted: 1, adventureReturned: 1,
  constructionCompleted: 2, foodShortage: 2, foodRecovered: 2, frostRecovered: 2, blessedFarmHarvested: 2, droughtHarvestRecovered: 2, foodAidDelivered: 2, foreignFoodAidDelivered: 2, materialAidDelivered: 2, monsterDefeated: 2, monsterBound: 2, monsterPredation: 2, monsterThreat: 2, monsterNestFounded: 2, monsterNestRelocated: 2, monsterNestCleared: 3, cooperativeExpedition: 2, supplyRecoveryDeparted: 1, supplyRecoveryReturned: 2, tradeEscortClash: 2, tradeEscortDeparted: 1, tradeEscortReturned: 2, resourceSurveyDeparted: 1, resourceSurveyReturned: 2, borderFriction: 2, friendshipReached: 3, allianceFormed: 3, allianceEnded: 3, internationalTradeCompleted: 2, internationalTradeReturning: 2,
  marriage: 3, birth: 3, migrantArrived: 3, independentExpedition: 3, settlementFounded: 3, god_intervention: 3,
  manaVeinDiscovered: 3, arcaneIrrigationInstalled: 2, miningToolsForged: 2, adventurerRankUp: 3, combatLevelUp: 2, guildApprenticeAdvanced: 2, adventurerEquipped: 2,
  alliedDefenseMobilized: 4, warDeclared: 4, fieldBattle: 4, siegeStarted: 3, territoryOccupied: 4, siegeRepelled: 3, campaignCancelled: 4, truceAgreed: 4, peaceAgreed: 4, nationFallen: 5, frontierDiscovered: 3, founding: 4, leaderSucceeded: 4, research_unlocked: 4, death: 5, civilizationAdvanced: 5
};

export const eventImportance = event => event.importance ?? importance[event.type] ?? 0;

export function emitOnce(world, sourceTransactionId, type, detail) {
  if (world.events.some(e => e.sourceTransactionId === sourceTransactionId && e.type === type)) return false;
  world.events.push({ ...detail, sourceTransactionId, type, id: nextId(world, 'event'),
    worldTimeTick: world.worldTimeTick, importance: importance[type] ?? 0 });
  return true;
}

export function involvesCitizen(event, id) {
  return event.citizenId === id || event.leaderId === id || event.citizenIds?.includes(id) ||
    event.parentIds?.includes(id) || event.actorIds?.includes(id) || event.affectedCitizenIds?.includes(id);
}

export function historyFor(world, kind, id) {
  if (!id && kind !== 'world') return [];
  if (kind === 'world') return world.events.filter(e => eventImportance(e) >= 2);
  if (kind === 'citizen') return world.events.filter(e => involvesCitizen(e, id));
  const nation = world.nations.find(n => n.id === id);
  const research = world.researchStates.find(state => state.ownerId === id);
  return world.events.filter(e => e.nationId === id || e.ownerId === id || e.nationIds?.includes(id) ||
    nation?.settlementIds.includes(e.settlementId) || (Boolean(research) && e.researchId === research.id));
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
  if (next.length !== world.events.length) world.events = next.reverse();
}

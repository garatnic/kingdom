import { ADULT_AGE, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { alliedNations, friendlyNations } from './Diplomacy.js';
import { available, freeCapacity, storeTile } from './Economy.js';
import { ageYears, nextId } from './Identity.js';
import { unlocked } from './Research.js';
import { findPath } from './path.js';

const WAR = { hostility: -60, unitCount: 3, offensiveLimit: 2, foodPerUnit: 8, marchDays: 3, siegeDays: 5, occupationDays: 3, truceDays: 10 };

export function activeNations(world) {
  return world.nations.filter(n => n.fallenAt === undefined);
}

export function truceBetween(world, first, second) {
  return world.campaigns?.findLast(c => c.status === 'repelled' && !c.cancelled && !c.peaceAgreed && c.endedAt !== undefined &&
    ((c.attackerId === first.id && c.defenderId === second.id) ||
      (c.attackerId === second.id && c.defenderId === first.id)) &&
    world.worldTimeTick < c.endedAt + WAR.truceDays * TIME_TICKS_PER_DAY);
}

export function campaignFor(world, citizen) {
  return world.campaigns?.find(c => (c.status === 'marching' || c.status === 'siege') &&
    c.memberIds.includes(citizen.id));
}

export function invasionOrder(world, citizen) {
  const campaign = campaignFor(world, citizen);
  return campaign?.status === 'marching' && !campaign.arrivedIds.includes(citizen.id) ? campaign : null;
}

function startCampaign(world, attacker, defender, supportedFront) {
  const target = world.settlements.find(s => s.id === defender.capitalId);
  const destination = world.stockpiles.find(p => p.settlementId === target.id);
  const home = world.stockpiles.find(p => p.settlementId === attacker.capitalId);
  const goal = { x: destination.x ?? target.x + 1, y: destination.y ?? target.y };
  const provisions = WAR.foodPerUnit * WAR.unitCount;
  if (available(home, 'food') < provisions + 8 ||
      !world.buildings.some(b => b.kind === 'barracks' && attacker.settlementIds.includes(b.settlementId))) return;
  const eligible = world.citizens.filter(c => c.alive && c.nationId === attacker.id &&
    c.id !== attacker.leaderId && !c.expeditionId && !campaignFor(world, c) && c.hp >= 60 && c.hunger < 65 &&
    ageYears(world, c) >= ADULT_AGE &&
    !world.inTransit.some(s => s.carrierId === c.id) &&
    !world.quests.some(q => (q.claimedBy === c.id || q.escortId === c.id) && q.status === 'claimed'));
  eligible.sort((a, b) => (b.skills.combat + b.traits.bravery) - (a.skills.combat + a.traits.bravery));
  const team = [];
  for (const citizen of eligible) {
    if (findPath(world, citizen.lastKnownSafeTile, goal) !== null) team.push(citizen);
    if (team.length === WAR.unitCount) break;
  }
  if (team.length !== WAR.unitCount) return;

  const campaign = { id: nextId(world, 'campaign'), attackerId: attacker.id, defenderId: defender.id,
    settlementId: target.id, supplySettlementId: home.settlementId, ...goal, memberIds: team.map(c => c.id), arrivedIds: [],
    rations: provisions, status: 'marching', beganAt: world.worldTimeTick, siegeDays: 0, occupationDays: 0,
    ...(supportedFront && { supportsCampaignId: supportedFront.id }) };
  world.campaigns ??= [];
  world.campaigns.push(campaign);
  home.total.food -= provisions;
  const nationIds = supportedFront ? [attacker.id, defender.id, supportedFront.defenderId] : [attacker.id, defender.id];
  emitOnce(world, campaign.id, supportedFront ? 'alliedDefenseMobilized' : 'warDeclared',
    { x: goal.x, y: goal.y, nationIds, actorIds: campaign.memberIds });
  return campaign;
}

function occupy(world, campaign, attacker, defender) {
  const target = world.settlements.find(s => s.id === campaign.settlementId);
  defender.settlementIds = defender.settlementIds.filter(id => id !== target.id);
  defender.capitalId = defender.settlementIds[0] ?? null;
  attacker.settlementIds.push(target.id);
  target.nationId = attacker.id;
  target.researchOwnerId = attacker.id;
  for (const citizen of world.citizens) {
    if (citizen.settlementId === target.id) citizen.nationId = attacker.id;
  }
  campaign.status = 'occupied';
  emitOnce(world, campaign.id, 'territoryOccupied', { x: target.x, y: target.y, settlementId: target.id,
    nationIds: [attacker.id, defender.id] });
  if (!defender.capitalId) {
    defender.fallenAt = world.worldTimeTick;
    emitOnce(world, campaign.id, 'nationFallen', { x: target.x, y: target.y, nationId: defender.id });
  }
}

function fightFieldBattle(world, campaign, attackers, defender) {
  const militia = world.citizens.filter(c => c.alive && c.nationId === defender.id &&
    c.settlementId === campaign.settlementId && ageYears(world, c) >= ADULT_AGE && c.hp >= 50 &&
    !c.expeditionId && !campaignFor(world, c) && !world.quests.some(q => (q.claimedBy === c.id || q.escortId === c.id) && q.status === 'claimed') &&
    Math.abs(c.lastKnownSafeTile.x - campaign.x) + Math.abs(c.lastKnownSafeTile.y - campaign.y) <= 8);
  if (militia.length < 2) return true;
  const strength = group => group.reduce((sum, c) => {
    const weapons = unlocked(world, c.settlementId, 'weapons_1') ? 1.5 : 0;
    return sum + (2 + c.skills.combat + c.traits.bravery + weapons) * c.hp / 100;
  }, 0);
  const attack = strength(attackers);
  const defense = strength(militia);
  const attackerWon = attack > defense;
  const wound = (group, opposingStrength, lost) => {
    const damage = Math.min(45, Math.ceil(opposingStrength / group.length * (lost ? 7 : 4)));
    for (const citizen of group) citizen.hp = Math.max(1, citizen.hp - damage);
  };
  wound(attackers, defense, !attackerWon);
  wound(militia, attack, attackerWon);
  emitOnce(world, campaign.id, 'fieldBattle', {
    x: campaign.x, y: campaign.y, nationIds: [campaign.attackerId, defender.id],
    actorIds: [...attackers, ...militia].map(c => c.id), winnerId: attackerWon ? campaign.attackerId : defender.id
  });
  return attackerWon;
}

function resolveCampaign(world, campaign, attacker, defender) {
  const team = world.citizens.filter(c => c.alive && c.nationId === attacker.id && campaign.memberIds.includes(c.id));
  const present = team.filter(c => campaign.arrivedIds.includes(c.id) &&
    Math.abs(c.lastKnownSafeTile.x - campaign.x) + Math.abs(c.lastKnownSafeTile.y - campaign.y) <= 2);
  if (campaign.status === 'marching') {
    if (team.length >= 2 && present.length === team.length) {
      if (!fightFieldBattle(world, campaign, present, defender)) {
        campaign.status = 'repelled';
        return;
      }
      campaign.status = 'siege';
      emitOnce(world, campaign.id, 'siegeStarted', { x: campaign.x, y: campaign.y, nationIds: [attacker.id, defender.id] });
    } else if (team.length < 2 || world.worldTimeTick - campaign.beganAt >= WAR.marchDays * TIME_TICKS_PER_DAY) {
      campaign.status = 'repelled';
    }
    return;
  }

  const guards = world.citizens.filter(c => c.alive && c.settlementId === campaign.settlementId &&
    ageYears(world, c) >= ADULT_AGE && c.hp >= 35 && !campaignFor(world, c));
  const barracks = world.buildings.some(b => b.kind === 'barracks' && b.settlementId === campaign.settlementId);
  const attack = present.reduce((sum, c) => sum + c.hp / 25 + c.skills.combat, 0);
  const defense = guards.length + (barracks ? 2 : 0);
  campaign.siegeDays++;
  campaign.occupationDays = attack > defense ? campaign.occupationDays + 1 : 0;
  for (const citizen of present) {
    // A wounded member leaves the siege and can recover through normal AI.
    citizen.hp = Math.max(1, citizen.hp - Math.max(2, Math.ceil(defense / present.length)));
  }
  campaign.arrivedIds = present.filter(c => c.hp >= 35).map(c => c.id);
  if (campaign.occupationDays >= WAR.occupationDays) occupy(world, campaign, attacker, defender);
  else if (campaign.siegeDays >= WAR.siegeDays || campaign.arrivedIds.length < 2) campaign.status = 'repelled';
}

function recoverRations(world, campaign, attacker) {
  if (campaign.rations === 0) return;
  const capitalStore = world.stockpiles.find(p => p.settlementId === attacker.capitalId);
  const supplyStore = world.stockpiles.find(p => p.settlementId === campaign.supplySettlementId);
  const returned = capitalStore ? Math.min(campaign.rations, Math.max(0, freeCapacity(capitalStore))) : 0;
  if (capitalStore) capitalStore.total.food += returned;
  const quantity = campaign.rations - returned;
  const store = capitalStore ?? supplyStore;
  const { x, y } = store ? storeTile(world, store) : campaign;
  if (quantity) {
    world.resourceNodes.push({ id: nextId(world, 'node'), resource: 'food', x, y, quantity, dropped: true });
  }
  emitOnce(world, campaign.id, 'campaignRationsRecovered', {
    x, y, nationId: campaign.attackerId, food: returned, dropped: quantity
  });
  campaign.rations = 0;
}

function samePair(campaign, first, second) {
  return (campaign.attackerId === first.id && campaign.defenderId === second.id) ||
    (campaign.attackerId === second.id && campaign.defenderId === first.id);
}

function updateCampaign(world, campaign, attacker, defender) {
  resolveCampaign(world, campaign, attacker, defender);
  if (campaign.status !== 'occupied' && campaign.status !== 'repelled') return;
  campaign.endedAt = world.worldTimeTick;
  recoverRations(world, campaign, attacker);
  if (campaign.status !== 'repelled') return;

  const location = { x: campaign.x, y: campaign.y, nationIds: [attacker.id, defender.id] };
  emitOnce(world, campaign.id, 'siegeRepelled', location);
  const recentDefeat = world.campaigns.some(c => c !== campaign && c.status === 'repelled' && !c.cancelled &&
    samePair(c, attacker, defender) && c.endedAt >= world.worldTimeTick - 45 * TIME_TICKS_PER_DAY);
  if (recentDefeat) {
    campaign.peaceAgreed = true;
    attacker.relations[defender.id] = defender.relations[attacker.id] = 0;
    emitOnce(world, campaign.id, 'peaceAgreed', location);
  } else {
    emitOnce(world, campaign.id, 'truceAgreed', {
      ...location, expiresAt: world.worldTimeTick + WAR.truceDays * TIME_TICKS_PER_DAY
    });
  }
}

export function updateWar(world) {
  const nationsById = new Map(world.nations.map(n => [n.id, n]));
  const fronts = (world.campaigns ?? []).filter(c => c.status === 'marching' || c.status === 'siege');
  const outgoing = new Map();
  for (const { attackerId } of fronts) outgoing.set(attackerId, (outgoing.get(attackerId) ?? 0) + 1);
  const incoming = new Set(fronts.map(c => c.defenderId));
  const defenseEnded = campaign => {
    if (!campaign.supportsCampaignId) return false;
    const supported = fronts.find(front => front.id === campaign.supportsCampaignId);
    if (supported?.status !== 'siege') return true;
    const beneficiary = nationsById.get(supported.defenderId);
    return beneficiary.fallenAt !== undefined ||
      world.settlements.find(s => s.id === supported.settlementId)?.nationId !== beneficiary.id ||
      !alliedNations(world, nationsById.get(campaign.attackerId), beneficiary);
  };
  const invalid = campaign => nationsById.get(campaign.attackerId).fallenAt !== undefined ||
    nationsById.get(campaign.defenderId).fallenAt !== undefined ||
    world.settlements.find(s => s.id === campaign.settlementId)?.nationId !== campaign.defenderId ||
    defenseEnded(campaign);
  // Resolve the siege first so an ally cannot capture a capital after its reason to intervene ends.
  for (const supported of [false, true]) {
    for (const campaign of fronts) {
      if (Boolean(campaign.supportsCampaignId) === supported && !invalid(campaign)) {
        updateCampaign(world, campaign, nationsById.get(campaign.attackerId), nationsById.get(campaign.defenderId));
      }
    }
  }
  for (const campaign of fronts) {
    if ((campaign.status !== 'marching' && campaign.status !== 'siege') || !invalid(campaign)) continue;
    campaign.status = 'repelled';
    campaign.cancelled = true;
    campaign.endedAt = world.worldTimeTick;
    const attacker = nationsById.get(campaign.attackerId);
    recoverRations(world, campaign, attacker);
    emitOnce(world, campaign.id, 'campaignCancelled', {
      x: campaign.x, y: campaign.y, nationIds: [campaign.attackerId, campaign.defenderId]
    });
  }
  const nations = activeNations(world);
  const canOpenFront = (attacker, defender) => {
    if ((outgoing.get(attacker.id) ?? 0) >= WAR.offensiveLimit || incoming.has(defender.id) ||
        fronts.some(c => samePair(c, attacker, defender)) || truceBetween(world, attacker, defender) ||
        world.campaigns?.some(c => (c.status === 'marching' || c.status === 'siege') && samePair(c, attacker, defender))) return false;
    const last = world.campaigns?.findLast(c => samePair(c, attacker, defender));
    return last?.status !== 'occupied' || world.worldTimeTick - last.endedAt >= WAR.truceDays * TIME_TICKS_PER_DAY;
  };
  const openFront = (attacker, defender, supportedFront) => {
    if (!canOpenFront(attacker, defender) || !startCampaign(world, attacker, defender, supportedFront)) return false;
    outgoing.set(attacker.id, (outgoing.get(attacker.id) ?? 0) + 1);
    incoming.add(defender.id);
    return true;
  };
  const opponents = [];
  for (const [index, first] of nations.entries()) {
    for (const second of nations.slice(index + 1)) {
      const relation = first.relations[second.id] ?? 0;
      if (relation <= WAR.hostility) opponents.push({ first, second, relation });
    }
  }
  opponents.sort((a, b) => a.relation - b.relation);
  for (const { first, second } of opponents) {
    const attackers = [first, second].sort((a, b) => b.weights.defense - a.weights.defense);
    for (const candidate of attackers) {
      const defender = candidate === first ? second : first;
      if (openFront(candidate, defender)) break;
    }
  }

  if (!world.settings.alliedIntervention) return;
  for (const front of fronts) {
    if (front.status !== 'siege' || front.supportsCampaignId || invalid(front) ||
        world.campaigns.some(c => c.supportsCampaignId === front.id)) continue;
    const aggressor = nationsById.get(front.attackerId);
    const beneficiary = nationsById.get(front.defenderId);
    for (const ally of nations) {
      if (ally.id === aggressor.id || !alliedNations(world, ally, beneficiary) ||
          friendlyNations(world, ally, aggressor)) continue;
      if (openFront(ally, aggressor, front)) break;
    }
  }
}

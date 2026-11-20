import { ADULT_AGE, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { emitOnce } from '../systems/History.js';
import { available, freeCapacity } from './Economy.js';
import { ageYears, nextId } from './Identity.js';
import { findPath } from './path.js';

const WAR = { hostility: -60, unitCount: 3, foodPerUnit: 8, marchDays: 3, siegeDays: 5, occupationDays: 3, truceDays: 10 };

export function activeNations(world) {
  return world.nations.filter(n => n.fallenAt === undefined);
}

export function truceBetween(world, first, second) {
  return world.campaigns?.findLast(c => c.status === 'repelled' && c.endedAt !== undefined &&
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

function startCampaign(world, attacker, defender) {
  const target = world.settlements.find(s => s.id === defender.capitalId);
  const destination = world.stockpiles.find(p => p.settlementId === target.id);
  const home = world.stockpiles.find(p => p.settlementId === attacker.capitalId);
  const goal = { x: destination.x ?? target.x + 1, y: destination.y ?? target.y };
  const provisions = WAR.foodPerUnit * WAR.unitCount;
  if (available(home, 'food') < provisions + 8 ||
      !world.buildings.some(b => b.kind === 'barracks' && attacker.settlementIds.includes(b.settlementId))) return;
  const eligible = world.citizens.filter(c => c.alive && c.nationId === attacker.id &&
    c.id !== attacker.leaderId && !c.expeditionId && c.hp >= 60 && c.hunger < 65 &&
    ageYears(world, c) >= ADULT_AGE &&
    !world.inTransit.some(s => s.carrierId === c.id) &&
    !world.quests.some(q => q.claimedBy === c.id && q.status === 'claimed'));
  eligible.sort((a, b) => (b.skills.combat + b.traits.bravery) - (a.skills.combat + a.traits.bravery));
  const team = eligible.filter(c => findPath(world, c.lastKnownSafeTile, goal) !== null).slice(0, WAR.unitCount);
  if (team.length !== WAR.unitCount) return;

  const campaign = { id: nextId(world, 'campaign'), attackerId: attacker.id, defenderId: defender.id,
    settlementId: target.id, ...goal, memberIds: team.map(c => c.id), arrivedIds: [],
    rations: provisions, status: 'marching', beganAt: world.worldTimeTick, siegeDays: 0, occupationDays: 0 };
  world.campaigns ??= [];
  world.campaigns.push(campaign);
  home.total.food -= provisions;
  emitOnce(world, campaign.id, 'warDeclared', { x: goal.x, y: goal.y, nationIds: [attacker.id, defender.id], actorIds: campaign.memberIds });
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

function resolveCampaign(world, campaign, attacker, defender) {
  const team = world.citizens.filter(c => c.alive && c.nationId === attacker.id && campaign.memberIds.includes(c.id));
  const present = team.filter(c => campaign.arrivedIds.includes(c.id) &&
    Math.abs(c.lastKnownSafeTile.x - campaign.x) + Math.abs(c.lastKnownSafeTile.y - campaign.y) <= 2);
  if (campaign.status === 'marching') {
    if (team.length >= 2 && present.length === team.length) {
      campaign.status = 'siege';
      emitOnce(world, campaign.id, 'siegeStarted', { x: campaign.x, y: campaign.y, nationIds: [attacker.id, defender.id] });
    } else if (team.length < 2 || world.worldTimeTick - campaign.beganAt >= WAR.marchDays * TIME_TICKS_PER_DAY) {
      campaign.status = 'repelled';
    }
    return;
  }

  const guards = world.citizens.filter(c => c.alive && c.settlementId === campaign.settlementId &&
    ageYears(world, c) >= ADULT_AGE && c.hp >= 35);
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
  const store = world.stockpiles.find(p => p.settlementId === attacker.capitalId);
  const returned = Math.min(campaign.rations, Math.max(0, freeCapacity(store)));
  store.total.food += returned;
  campaign.rations -= returned;
  if (campaign.rations && store.x !== undefined) {
    world.resourceNodes.push({ id: nextId(world, 'node'), resource: 'food',
      x: store.x, y: store.y, quantity: campaign.rations, dropped: true });
    campaign.rations = 0;
  }
}

export function updateWar(world) {
  const [first, second] = activeNations(world);
  if (!second) return;
  const active = world.campaigns?.find(c => c.status === 'marching' || c.status === 'siege');
  if (active) {
    const attacker = world.nations.find(n => n.id === active.attackerId);
    const defender = world.nations.find(n => n.id === active.defenderId);
    resolveCampaign(world, active, attacker, defender);
    if (active.status === 'occupied' || active.status === 'repelled') {
      active.endedAt = world.worldTimeTick;
      recoverRations(world, active, attacker);
    }
    if (active.status === 'repelled') {
      const location = { x: active.x, y: active.y, nationIds: [attacker.id, defender.id] };
      emitOnce(world, active.id, 'siegeRepelled', location);
      emitOnce(world, active.id, 'truceAgreed', {
        ...location, expiresAt: world.worldTimeTick + WAR.truceDays * TIME_TICKS_PER_DAY
      });
    }
    return;
  }
  const last = world.campaigns?.at(-1);
  if (truceBetween(world, first, second)) return;
  if (last?.status === 'occupied' && world.worldTimeTick - last.endedAt < WAR.truceDays * TIME_TICKS_PER_DAY) return;
  if ((first.relations[second.id] ?? 0) > WAR.hostility) return;
  const attackers = [first, second].sort((a, b) => b.weights.defense - a.weights.defense);
  for (const candidate of attackers) {
    startCampaign(world, candidate, candidate === first ? second : first);
    if (world.campaigns?.at(-1) !== last) break;
  }
}

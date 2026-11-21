import { activeNations, truceBetween, updateWar } from './War.js';
import { emitOnce } from '../systems/History.js';
import { ADULT_AGE, FOOD_EMERGENCY_PER_PERSON, LAYOUT, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { buildings, footprint } from '../data/buildings.js';
import { NATIONS } from '../data/nations.js';
import { available, freeCapacity, resources } from './Economy.js';
import { ageYears, nextId } from './Identity.js';
import { ensureResearch, getResearch } from './Research.js';
import { findPath } from './path.js';
import { claimSettlement, initializeTerritory, territoryAt } from './Territory.js';

export { territoryAt } from './Territory.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const leaderScore = c => 0.4 * c.traits.diligence + 0.3 * c.traits.bravery + 0.3 * 0.5;
const residents = (world, settlementId) => world.citizens.filter(c => c.alive && c.settlementId === settlementId);
const depot = (world, settlementId) => world.stockpiles.find(s => s.settlementId === settlementId);
const origin = (settlement, store) => store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;

function settleNation(world, settlement, leader) {
  const state = ensureResearch(world, settlement);
  const nation = { id: nextId(world, 'nation'), name: `王国 ${world.nations.length + 1}`,
    capitalId: settlement.id, settlementIds: [settlement.id], leaderId: leader.id, createdAt: world.worldTimeTick,
    weights: { food: 1 + leader.traits.diligence * 0.5, defense: 1 + leader.traits.bravery * 0.5,
      research: 1 + leader.traits.curiosity * 0.5 }, relations: {}, policy: {} };
  for (const other of world.nations) {
    nation.relations[other.id] = 0;
    other.relations[nation.id] = 0;
  }
  initializeTerritory(world);
  world.nations.push(nation);
  settlement.nationId = settlement.researchOwnerId = nation.id;
  state.ownerId = nation.id;
  claimSettlement(world, settlement);
  for (const citizen of world.citizens.filter(c => c.settlementId === settlement.id)) citizen.nationId = nation.id;
  emitOnce(world, nation.id, 'founding', { nationId: nation.id, settlementId: settlement.id,
    leaderId: leader.id, x: settlement.x, y: settlement.y });
  return nation;
}

function checkFounding(world, settlement) {
  if (settlement.nationId || world.nations.length >= NATIONS.limit) return;
  const people = residents(world, settlement.id);
  const store = depot(world, settlement.id);
  const adults = people.filter(c => ageYears(world, c) >= ADULT_AGE)
    .sort((a, b) => leaderScore(b) - leaderScore(a));
  const houses = world.buildings.filter(b => b.settlementId === settlement.id && b.kind === 'house');
  const days = (world.worldTimeTick - (settlement.createdAt ?? 0)) / TIME_TICKS_PER_DAY;
  const qualifies = people.length >= NATIONS.population && houses.length >= NATIONS.houses && adults.length &&
    store && available(store, 'food') >= people.length * FOOD_EMERGENCY_PER_PERSON && days >= NATIONS.minimumAgeDays;
  settlement.foundingDays = qualifies ? (settlement.foundingDays ?? 0) + 1 : 0;
  if (settlement.foundingDays >= NATIONS.consecutiveDays) settleNation(world, settlement, adults[0]);
}

function choosePolicy(world, nation) {
  const people = residents(world, nation.capitalId);
  const store = depot(world, nation.capitalId);
  const capacity = world.buildings.filter(b => b.kind === 'house' && b.settlementId === nation.capitalId)
    .reduce((sum, b) => sum + b.capacity, 0);
  const recentThreats = world.events.filter(e => e.type === 'adventureReturned' && e.retreated &&
    world.worldTimeTick - e.worldTimeTick <= 3 * TIME_TICKS_PER_DAY &&
    people.some(c => c.id === e.citizenId)).length;
  const candidates = [
    ['food', Math.max(0, 1 - available(store, 'food') / Math.max(1, people.length * FOOD_EMERGENCY_PER_PERSON)) * nation.weights.food],
    ['housing', Math.max(0, 1 - capacity / Math.max(1, people.length))],
    ['defense', Math.min(1, recentThreats / 2) * nation.weights.defense],
    ['research', 0.4 * nation.weights.research],
    ['exploration', 0.25]
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  nation.policy = { primary: candidates[0][0], secondary: candidates[1][0] };
}

export function relationLabel(value) {
  return value >= NATIONS.friendly ? 'friendly' : value <= NATIONS.hostile ? 'hostile' : 'neutral';
}

function expeditionTile(world, settlement, start) {
  const frontier = world.map.frontier;
  if (frontier && findPath(world, start, frontier) !== null &&
      world.settlements.every(existing => distance(existing, frontier) >= NATIONS.expeditionMinDistance) &&
      !world.constructionSites.some(site => footprint(site, frontier))) return frontier;
  for (let dy = -NATIONS.expeditionSearchDistance; dy <= NATIONS.expeditionSearchDistance; dy++) {
    for (let dx = -NATIONS.expeditionSearchDistance; dx <= NATIONS.expeditionSearchDistance; dx++) {
      const tile = { x: settlement.x + dx, y: settlement.y + dy };
      const offset = distance(tile, settlement);
      if (offset < NATIONS.expeditionMinDistance || offset > NATIONS.expeditionSearchDistance ||
          world.settlements.some(s => distance(s, tile) < 8)) continue;
      const grass = Array.from({ length: 4 }, (_, i) => ({ x: tile.x + i % 2, y: tile.y + Math.floor(i / 2) }));
      if (grass.some(p => p.x < 0 || p.y < 0 || p.x >= world.map.width || p.y >= world.map.height ||
          world.map.terrain[p.y * world.map.width + p.x] !== 'grass' ||
          world.buildings.some(b => footprint(b, p)) ||
          world.resourceNodes.some(n => n.x === p.x && n.y === p.y))) continue;
      if (findPath(world, start, tile) === null) continue;
      const localSupplies = ['food', 'wood'].every(key => world.resourceNodes.some(node =>
        node.resource === key && !node.dropped && distance(node, tile) <= NATIONS.expeditionNodeDistance &&
        (findPath(world, tile, node)?.length ?? Infinity) <= NATIONS.expeditionNodeDistance));
      if (localSupplies) return tile;
    }
  }
  return null;
}

export function startExpedition(world, nation) {
  world.expeditions ??= [];
  if (world.nations.length >= NATIONS.limit || world.settlements.length >= NATIONS.limit ||
      world.expeditions.some(e => e.status === 'travel')) return null;
  const settlement = world.settlements.find(s => s.id === nation.capitalId);
  const people = residents(world, settlement.id);
  const eligible = people.filter(c => c.id !== nation.leaderId && ageYears(world, c) >= ADULT_AGE &&
    c.hp >= 50 && !world.campaigns?.some(war => war.memberIds.includes(c.id) && ['marching', 'siege'].includes(war.status)) && !world.quests.some(q => q.status === 'claimed' && (q.claimedBy === c.id || q.escortId === c.id)) &&
    !world.inTransit.some(item => item.carrierId === c.id));
  // Select households before singles to avoid separating partners where possible.
  const pairs = eligible.filter(c => eligible.find(p => p.id === c.partnerId) &&
    people.indexOf(c) < people.findIndex(p => p.id === c.partnerId));
  const ordered = [...pairs.flatMap(c => [c, eligible.find(p => p.id === c.partnerId)]), ...eligible];
  const team = [...new Set(ordered)].slice(0, NATIONS.expeditionSize);
  const store = depot(world, settlement.id);
  if (team.length !== NATIONS.expeditionSize || people.length - team.length < NATIONS.population ||
      !store || Object.entries(NATIONS.supplies).some(([key, value]) => available(store, key) < value)) return null;
  const goal = expeditionTile(world, settlement, origin(settlement, store));
  if (!goal || team.some(c => findPath(world, c.lastKnownSafeTile, goal) === null)) return null;
  const id = nextId(world, 'expedition');
  const expedition = { id, originId: settlement.id, nationId: nation.id, ...goal,
    memberIds: team.map(c => c.id), arrivedIds: [], supplies: { ...NATIONS.supplies },
    inheritedTech: (getResearch(world, nation)?.unlockedIds ?? []).filter(key => ['farming_1', 'building_1'].includes(key)),
    status: 'travel', departedAt: world.worldTimeTick };
  for (const [key, amount] of Object.entries(expedition.supplies)) store.total[key] -= amount;
  for (const citizen of team) {
    citizen.settlementId = citizen.nationId = citizen.homeBuildingId = null;
    citizen.expeditionId = id;
    citizen.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 };
    Object.assign(citizen, { x: citizen.lastKnownSafeTile.x + 0.5, y: citizen.lastKnownSafeTile.y + 0.5 });
  }
  world.expeditions.push(expedition);
  emitOnce(world, id, 'independentExpedition', { expeditionId: id, nationId: nation.id,
    settlementId: settlement.id, x: settlement.x, y: settlement.y });
  return expedition;
}

const jobs = ['builder', 'farmer', 'woodcutter', 'miner'];

function finishExpedition(world, expedition, failed) {
  const members = expedition.memberIds.map(id => world.citizens.find(c => c.id === id));
  const source = world.settlements.find(s => s.id === expedition.originId);
  const target = failed ? source : { id: nextId(world, 'settlement'), x: expedition.x, y: expedition.y,
    nationId: null, createdAt: world.worldTimeTick };
  if (!failed) {
    world.settlements.push(target);
    ensureResearch(world, target, expedition.inheritedTech);
    world.stockpiles.push({ id: nextId(world, 'stockpile'), settlementId: target.id, x: target.x, y: target.y,
      capacity: LAYOUT.stockpileCapacity, total: { ...Object.fromEntries(resources.map(key => [key, 0])) },
      reserved: Object.fromEntries(resources.map(key => [key, 0])) });
  }
  const store = depot(world, target.id);
  for (const [resource, amount] of Object.entries(expedition.supplies)) {
    const received = Math.min(freeCapacity(store), amount);
    store.total[resource] += received;
    if (received < amount) {
      const tile = origin(target, store);
      world.resourceNodes.push({ id: nextId(world, 'node'), resource, quantity: amount - received, dropped: true,
        x: tile.x, y: tile.y });
    }
  }
  expedition.supplies = {};
  for (const [index, member] of members.entries()) {
    delete member.expeditionId;
    if (!member.alive) continue;
    member.settlementId = target.id;
    member.nationId = target.nationId;
    if (!failed) member.profession = jobs[index];
    member.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 };
  }
  expedition.status = failed ? 'failed' : 'settled';
  if (!failed) {
    expedition.destinationId = target.id;
    emitOnce(world, expedition.id, 'settlementFounded', { settlementId: target.id,
      expeditionId: expedition.id, x: target.x, y: target.y });
  }
}

function updateRelations(world) {
  const [first, second] = activeNations(world);
  if (!second || truceBetween(world, first, second)) return;
  const crossings = world.citizens.filter(c => c.alive && c.nationId &&
    [first.id, second.id].includes(c.nationId) && territoryAt(world, c.lastKnownSafeTile) ===
      (c.nationId === first.id ? second.id : first.id));
  if (!crossings.length) return;
  const value = Math.max(-100, first.relations[second.id] - crossings.length * 2);
  if (value === first.relations[second.id]) return;
  first.relations[second.id] = second.relations[first.id] = value;
  emitOnce(world, 'border/' + world.worldTimeTick, 'borderFriction', {
    nationIds: [first.id, second.id], value, ...crossings[0].lastKnownSafeTile });
}

export function updateNations(world, ticks) {
  for (const expedition of world.expeditions ?? []) {
    if (expedition.status !== 'travel') continue;
    const failed = expedition.failed || expedition.memberIds.some(id => !world.citizens.find(c => c.id === id)?.alive);
    if (failed || expedition.arrivedIds.length === expedition.memberIds.length) finishExpedition(world, expedition, failed);
  }
  const now = world.worldTimeTick;
  if (Math.floor(now / TIME_TICKS_PER_DAY) === Math.floor((now - ticks) / TIME_TICKS_PER_DAY)) return;
  for (const settlement of world.settlements) checkFounding(world, settlement);
  for (const nation of activeNations(world)) choosePolicy(world, nation);
  updateRelations(world);
  updateWar(world);
  const [first] = activeNations(world);
  if (first && now - first.createdAt >= NATIONS.expeditionAgeDays * TIME_TICKS_PER_DAY) startExpedition(world, first);
}

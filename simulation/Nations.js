import { activeNations, truceBetween, updateWar } from './War.js';
import { emitOnce } from '../systems/History.js';
import { ADULT_AGE, FOOD_EMERGENCY_PER_PERSON, LAYOUT, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { buildings, footprint } from '../data/buildings.js';
import { NATIONS } from '../data/nations.js';
import { available, freeCapacity, resources } from './Economy.js';
import { ageYears, nextId } from './Identity.js';
import { ensureResearch, getResearch } from './Research.js';
import { findPath, reachableTiles } from './path.js';
import { claimSettlement, initializeTerritory, territoryAt, tileDistance as distance } from './Territory.js';

export { territoryAt } from './Territory.js';

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
  for (const other of activeNations(world)) {
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
  if (settlement.nationId || activeNations(world).length >= NATIONS.limit) return;
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

function expeditionPlot(world, tile) {
  const { width, height, terrain } = world.map;
  return world.settlements.every(s => distance(s, tile) >= 8) &&
    [tile, { x: tile.x + 1, y: tile.y }, { x: tile.x, y: tile.y + 1 }, { x: tile.x + 1, y: tile.y + 1 }]
      .every(p => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height &&
        terrain[p.y * width + p.x] === 'grass' && !territoryAt(world, p) &&
        !world.buildings.some(b => footprint(b, p)) && !world.constructionSites.some(s => footprint(s, p)) &&
        !world.resourceNodes.some(n => distance(n, p) === 0) && !world.stockpiles.some(s => distance(s, p) === 0));
}

function expeditionTile(world, settlement, start) {
  const { width, height } = world.map;
  const supplies = ['food', 'wood'].map(key => world.resourceNodes.filter(node =>
    node.resource === key && !node.dropped && node.quantity > 0 &&
    Math.abs(distance(node, settlement) - NATIONS.expeditionMinDistance) <=
      NATIONS.expeditionNodeDistance + NATIONS.expeditionSearchDistance - NATIONS.expeditionMinDistance));
  if (supplies.some(nodes => !nodes.length)) return null;
  let connected;
  for (let y = Math.max(0, settlement.y - NATIONS.expeditionSearchDistance);
    y < Math.min(height - 1, settlement.y + NATIONS.expeditionSearchDistance + 1); y++) {
    for (let x = Math.max(0, settlement.x - NATIONS.expeditionSearchDistance);
      x < Math.min(width - 1, settlement.x + NATIONS.expeditionSearchDistance + 1); x++) {
      const tile = { x, y };
      const offset = distance(tile, settlement);
      if (offset < NATIONS.expeditionMinDistance || offset > NATIONS.expeditionSearchDistance) continue;
      const nearby = supplies.map(nodes => nodes.filter(node => distance(node, tile) <= NATIONS.expeditionNodeDistance));
      if (nearby.some(nodes => !nodes.length) || !expeditionPlot(world, tile)) continue;
      connected ??= reachableTiles(world, start);
      if (connected[y * width + x] === 1 && nearby.every(nodes => nodes.some(node =>
        (findPath(world, tile, node)?.length ?? Infinity) <= NATIONS.expeditionNodeDistance))) return tile;
    }
  }
  return null;
}

export function startExpedition(world, nation) {
  world.expeditions ??= [];
  const inhabited = new Set(world.citizens.filter(c => c.alive).map(c => c.settlementId));
  const reservedSlots = world.settlements.filter(s => !s.nationId && inhabited.has(s.id)).length;
  if (nation.fallenAt !== undefined || activeNations(world).length + reservedSlots >= NATIONS.limit ||
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
  const team = [];
  const jobsAtHome = new Map();
  for (const adult of people.filter(c => ageYears(world, c) >= ADULT_AGE)) {
    jobsAtHome.set(adult.profession, (jobsAtHome.get(adult.profession) ?? 0) + 1);
  }
  for (const candidate of new Set(ordered)) {
    if ((jobsAtHome.get(candidate.profession) ?? 0) < 2) continue;
    team.push(candidate);
    jobsAtHome.set(candidate.profession, jobsAtHome.get(candidate.profession) - 1);
    if (team.length === NATIONS.expeditionSize) break;
  }
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
  const nations = activeNations(world);
  if (nations.length < 2) return;
  const rivalries = new Map();
  for (const citizen of world.citizens) {
    if (!citizen.alive || !citizen.nationId) continue;
    const owner = territoryAt(world, citizen.lastKnownSafeTile);
    if (!owner || owner === citizen.nationId) continue;
    const key = [owner, citizen.nationId].sort().join('/');
    const crossing = rivalries.get(key);
    if (crossing) crossing.count++;
    else rivalries.set(key, { count: 1, tile: citizen.lastKnownSafeTile });
  }
  for (const [index, first] of nations.entries()) {
    for (const second of nations.slice(index + 1)) {
      const key = [first.id, second.id].sort().join('/');
      const crossing = rivalries.get(key);
      if (!crossing || truceBetween(world, first, second)) continue;
      const previous = first.relations[second.id] ?? 0;
      const value = Math.max(-100, previous - crossing.count * 2);
      if (value === previous) continue;
      first.relations[second.id] = second.relations[first.id] = value;
      emitOnce(world, `border/${world.worldTimeTick}/${key}`, 'borderFriction', {
        nationIds: [first.id, second.id], value, ...crossing.tile
      });
    }
  }
}

export function updateNations(world, ticks) {
  for (const expedition of world.expeditions ?? []) {
    if (expedition.status !== 'travel') continue;
    const arrived = expedition.arrivedIds.length === expedition.memberIds.length;
    const failed = expedition.failed || expedition.memberIds.some(id => !world.citizens.find(c => c.id === id)?.alive) ||
      (arrived && !expeditionPlot(world, expedition));
    if (failed || arrived) finishExpedition(world, expedition, failed);
  }
  const now = world.worldTimeTick;
  if (Math.floor(now / TIME_TICKS_PER_DAY) === Math.floor((now - ticks) / TIME_TICKS_PER_DAY)) return;
  for (const settlement of world.settlements) checkFounding(world, settlement);
  for (const nation of activeNations(world)) choosePolicy(world, nation);
  updateRelations(world);
  updateWar(world);
  for (const nation of activeNations(world)) {
    if (now - nation.createdAt >= NATIONS.expeditionAgeDays * TIME_TICKS_PER_DAY && startExpedition(world, nation)) break;
  }
}

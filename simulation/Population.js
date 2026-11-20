import { createAdult } from './CreateAdult.js';
import { reachableTiles } from './path.js';
import { LIFE_CREATION_LIMIT } from './DetailLevel.js';
import { emitOnce } from '../systems/History.js';
import { ageYears, lifespan, nextId, professions } from './Identity.js';
import { available, resources, storeTile } from './Economy.js';
import { random } from '../engine/random.js';
import {
  ADULT_AGE, BIRTH_CHECK_INTERVAL_TICKS, BIRTH_PROBABILITY_PER_YEAR, FAMILY, FOOD_BIRTH_PER_PERSON,
  citizenRaces, LIFESPAN_YEARS, TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR
} from '../data/balance.js';

export function recordDeath(world, citizen, cause) {
  if (!citizen.alive) return;
  citizen.alive = false;
  citizen.hp = 0;
  citizen.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 };
  citizen.homeBuildingId = null;
  const partner = world.citizens.find(person => person.id === citizen.partnerId);
  if (partner?.alive) {
    partner.partnerId = null;
    delete partner.nextBirthCheckTick;
  }
  delete citizen.nextBirthCheckTick;
  for (const shipment of world.inTransit.filter(item => item.carrierId === citizen.id)) {
    Object.assign(shipment, citizen.lastKnownSafeTile, { carrierId: null });
  }
  for (const resource of resources) {
    const quantity = citizen.inventory[resource];
    if (!quantity) continue;
    world.resourceNodes.push({
      id: nextId(world, 'node'), resource, quantity, ...citizen.lastKnownSafeTile, dropped: true
    });
    citizen.inventory[resource] = 0;
  }
  emitOnce(world, citizen.id, 'death', { cause, citizenId: citizen.id, nationId: citizen.nationId,
    settlementId: citizen.settlementId, ...citizen.lastKnownSafeTile });
}

function marry(world, first, second) {
  const familyId = first.familyId ?? second.familyId ?? nextId(world, 'family');
  first.familyId = second.familyId = familyId;
  first.partnerId = second.id;
  second.partnerId = first.id;
  first.nextBirthCheckTick = world.worldTimeTick + BIRTH_CHECK_INTERVAL_TICKS;
  const transaction = first.id + '/' + second.id + '/' + world.worldTimeTick;
  emitOnce(world, transaction, 'marriage', { citizenIds: [first.id, second.id], familyId,
    nationId: first.nationId, settlementId: first.settlementId, ...first.lastKnownSafeTile });
}

function dailyRelationships(world, citizens) {
  const adults = citizens.filter(c => c.alive && ageYears(world, c) >= ADULT_AGE);
  for (const [i, first] of adults.entries()) {
    for (const second of adults.slice(i + 1)) {
      if (!first.settlementId || first.settlementId !== second.settlementId || first.race !== second.race) continue;
      first.relationships ??= {};
      second.relationships ??= {};
      const newScore = score => Math.min(100, (score ?? 0) + FAMILY.relationshipPerDay);
      const a = first.relationships[second.id] = newScore(first.relationships[second.id]);
      const b = second.relationships[first.id] = newScore(second.relationships[first.id]);
      if (first.partnerId || second.partnerId || a < FAMILY.marriageThreshold || b < FAMILY.marriageThreshold ||
          Math.abs(ageYears(world, first) - ageYears(world, second)) > FAMILY.maxAgeGap) continue;
      marry(world, first, second);
    }
  }
}

function checkBirth(world, parent, people) {
  if (!parent.alive || parent.nextBirthCheckTick === undefined ||
      world.worldTimeTick < parent.nextBirthCheckTick) return;
  parent.nextBirthCheckTick += BIRTH_CHECK_INTERVAL_TICKS;
  const partner = people.get(parent.partnerId);
  if (!parent.settlementId || !partner?.alive || partner.partnerId !== parent.id ||
      parent.settlementId !== partner.settlementId || parent.race !== partner.race) return;
  const residents = world.citizens.filter(c => c.alive && c.settlementId === parent.settlementId);
  const home = world.buildings.find(b => b.kind === 'house' && b.settlementId === parent.settlementId &&
    residents.filter(c => c.homeBuildingId === b.id).length < b.capacity);
  const store = world.stockpiles.find(s => s.settlementId === parent.settlementId);
  if (!home || !store || available(store, 'food') < residents.length * FOOD_BIRTH_PER_PERSON) return;
  const recentChild = [...parent.childIds, ...partner.childIds].some(id =>
    world.worldTimeTick - people.get(id)?.birthWorldTimeTick < FAMILY.birthSpacingYears * TIME_TICKS_PER_YEAR);
  if (recentChild || random(world.rngState) >= BIRTH_PROBABILITY_PER_YEAR) return;

  const id = nextId(world, 'citizen');
  const tile = { ...parent.lastKnownSafeTile };
  const child = {
    id, name: `こども ${id.split(':')[1]}`, race: parent.race,
    birthWorldTimeTick: world.worldTimeTick, lifespanYears: lifespan(world, parent.race),
    alive: true, sex: 'unspecified', settlementId: parent.settlementId, nationId: parent.nationId,
    homeBuildingId: home.id, familyId: parent.familyId, parentIds: [parent.id, partner.id],
    childIds: [], partnerId: null, relationships: {}, x: tile.x + 0.5, y: tile.y + 0.5,
    hp: 100, hunger: 0, fatigue: 0, fear: 0, profession: null,
    traits: Object.fromEntries(Object.keys(parent.traits).map(key => [key, random(world.rngState)])),
    skills: Object.fromEntries(Object.keys(parent.skills).map(key => [key, 0])),
    inventory: Object.fromEntries(resources.map(key => [key, 0])),
    action: { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 },
    decisionAt: world.worldTimeTick, failedTargets: {}, lastKnownSafeTile: tile
  };
  if (citizenRaces[child.race].minMagicAffinity !== undefined) {
    child.traits.magicAffinity = Math.max(child.traits.magicAffinity, citizenRaces[child.race].minMagicAffinity);
  }
  parent.childIds.push(id);
  partner.childIds.push(id);
  world.citizens.push(child);
  emitOnce(world, id, 'birth', { citizenId: id, parentIds: [...child.parentIds],
    nationId: child.nationId, settlementId: child.settlementId, ...tile });
}

function fillVacancies(world) {
  for (const settlement of world.settlements) {
    const adults = world.citizens.filter(c => c.alive && c.settlementId === settlement.id &&
      ageYears(world, c) >= ADULT_AGE);
    const priorities = ['farmer', 'builder', 'woodcutter', 'miner', 'adventurer'].slice(0, adults.length);
    for (const role of priorities) {
      if (adults.some(c => c.profession === role)) continue;
      const candidate = adults.find(c => !world.inTransit.some(shipment => shipment.carrierId === c.id) &&
        !world.quests.some(quest => quest.status === 'claimed' && quest.claimedBy === c.id) &&
        (!priorities.includes(c.profession) || adults.filter(person => person.profession === c.profession).length > 1));
      if (candidate) candidate.profession = role;
    }
  }
}

function admitMigrant(world) {
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  if (day < 30 || day % 15 !== 0) return;
  const latestFrontier = world.events.findLast(e => e.type === 'frontierDiscovered');
  if (!latestFrontier) return;
  const living = world.citizens.filter(c => c.alive);
  if (living.length >= LIFE_CREATION_LIMIT) return;
  const race = ['orc', 'halfling', 'fairy'][(day / 15 - 2) % 3];
  for (const settlement of world.settlements) {
    const residents = living.filter(c => c.settlementId === settlement.id);
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    if (!residents.length || !store || available(store, 'food') < (residents.length + 1) * FOOD_BIRTH_PER_PERSON) continue;
    const home = world.buildings.find(b => b.kind === 'house' && b.settlementId === settlement.id &&
      residents.filter(c => c.homeBuildingId === b.id).length < b.capacity);
    if (!home) continue;
    const { x, y } = storeTile(world, store);
    const reception = { x, y };
    const reachable = reachableTiles(world, reception);
    if (!reachable[latestFrontier.y * world.map.width + latestFrontier.x]) continue;
    const migrant = createAdult(world, race, reception, settlement);
    migrant.homeBuildingId = home.id;
    world.citizens.push(migrant);
    emitOnce(world, migrant.id + '/arrival', 'migrantArrived', {
      citizenId: migrant.id, settlementId: settlement.id, nationId: settlement.nationId, race, ...reception
    });
    return;
  }
}

export function updatePopulation(world, ticks) {
  const daily = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY) >
    Math.floor((world.worldTimeTick - ticks) / TIME_TICKS_PER_DAY);
  let birthDue = false;
  for (const citizen of world.citizens) {
    if (!citizen.alive) continue;
    const age = ageYears(world, citizen);
    // Older saves have no stored lifespan; derive a stable midpoint for those residents.
    const [min, max] = LIFESPAN_YEARS[citizen.race];
    if (age >= (citizen.lifespanYears ?? Math.floor((min + max) / 2))) {
      recordDeath(world, citizen, 'oldAge');
    } else if (age >= ADULT_AGE && citizen.profession === null) {
      const sequence = Number(citizen.id.split(':')[1]) - 1;
      citizen.profession = professions[sequence % professions.length];
    }
    birthDue ||= citizen.nextBirthCheckTick <= world.worldTimeTick;
  }
  if (daily) {
    fillVacancies(world);
    dailyRelationships(world, world.citizens);
    admitMigrant(world);
  }
  if (!birthDue) return;
  const people = new Map(world.citizens.map(c => [c.id, c]));
  for (const citizen of people.values()) checkBirth(world, citizen, people);
}

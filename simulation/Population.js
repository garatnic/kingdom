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
  const people = new Map(citizens.map(c => [c.id, c]));
  const ancestors = citizen => new Set(citizen.parentIds.flatMap(id => [id, ...(people.get(id)?.parentIds ?? [])]));
  const groups = new Map();
  const adults = [];
  for (const citizen of citizens) {
    if (!citizen.alive || !citizen.settlementId || ageYears(world, citizen) < ADULT_AGE) continue;
    const key = citizen.settlementId + '/' + citizen.race;
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    const entry = { citizen, ancestors: ancestors(citizen), group, index: group.length };
    adults.push(entry);
    group.push(entry);
  }
  for (const { citizen: first, ancestors: firstAncestors, group, index } of adults) {
    for (let i = index + 1; i < group.length; i++) {
      const { citizen: second, ancestors: secondAncestors } = group[i];
      first.relationships ??= {};
      second.relationships ??= {};
      const newScore = score => Math.min(100, (score ?? 0) + FAMILY.relationshipPerDay);
      const a = first.relationships[second.id] = newScore(first.relationships[second.id]);
      const b = second.relationships[first.id] = newScore(second.relationships[first.id]);
      if (first.partnerId || second.partnerId || a < FAMILY.marriageThreshold || b < FAMILY.marriageThreshold ||
          Math.abs(ageYears(world, first) - ageYears(world, second)) > FAMILY.maxAgeGap) continue;
      if (firstAncestors.has(second.id) || secondAncestors.has(first.id) ||
          first.parentIds.some(id => second.parentIds.includes(id))) continue;
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
  if (!home || !store || available(store, 'food') < residents.length * FOOD_BIRTH_PER_PERSON) {
    if (residents.length >= 16) parent.nextBirthCheckTick = world.worldTimeTick + 5 * TIME_TICKS_PER_DAY;
    return;
  }
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
  const occupied = new Set([
    ...world.inTransit.map(shipment => shipment.carrierId),
    ...world.quests.filter(quest => quest.status === 'claimed').flatMap(quest => [quest.claimedBy, quest.escortId]),
    ...(world.campaigns ?? []).filter(c => c.status === 'marching' || c.status === 'siege').flatMap(c => c.memberIds)
  ]);
  for (const settlement of world.settlements) {
    const residents = world.citizens.filter(c => c.alive && c.settlementId === settlement.id);
    const adults = residents.filter(c => ageYears(world, c) >= ADULT_AGE);
    const priorities = ['farmer', 'builder', 'woodcutter', 'miner', 'adventurer'].slice(0, adults.length);
    const counts = new Map();
    for (const adult of adults) counts.set(adult.profession, (counts.get(adult.profession) ?? 0) + 1);
    for (const role of priorities) {
      if (counts.has(role)) continue;
      const candidate = adults.find(c => !occupied.has(c.id) &&
        (!priorities.includes(c.profession) || counts.get(c.profession) > 1));
      if (!candidate) continue;
      counts.set(candidate.profession, counts.get(candidate.profession) - 1);
      candidate.profession = role;
      counts.set(role, 1);
    }

    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    if (residents.length < 16 || !counts.has('farmer') || !store ||
        available(store, 'food') >= residents.length * FOOD_BIRTH_PER_PERSON) continue;
    const target = Math.min(adults.length - 4, Math.ceil(residents.length / 8));
    if (counts.get('farmer') >= target) continue;
    const candidate = adults.find(c => c.profession !== 'farmer' && !occupied.has(c.id) &&
      c.action.kind === 'idle' && counts.get(c.profession) > 1 &&
      c.id !== world.nations.find(nation => nation.id === settlement.nationId)?.leaderId);
    if (candidate) candidate.profession = 'farmer';
  }
}

function fillVacantHomes(world) {
  const occupancy = new Map();
  for (const citizen of world.citizens) {
    if (!citizen.alive || !citizen.homeBuildingId) continue;
    occupancy.set(citizen.homeBuildingId, (occupancy.get(citizen.homeBuildingId) ?? 0) + 1);
  }
  for (const citizen of world.citizens) {
    if (!citizen.alive || citizen.homeBuildingId || !citizen.settlementId) continue;
    const house = world.buildings.find(b => b.kind === 'house' && b.settlementId === citizen.settlementId &&
      (occupancy.get(b.id) ?? 0) < b.capacity);
    if (!house) continue;
    citizen.homeBuildingId = house.id;
    occupancy.set(house.id, (occupancy.get(house.id) ?? 0) + 1);
  }
}

function admitMigrants(world) {
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  if (day < 30 || day % 5 !== 0) return;
  const latestFrontier = world.events.findLast(e => e.type === 'frontierDiscovered');
  if (!latestFrontier) return;
  const living = world.citizens.filter(c => c.alive);
  const migrationRaces = ['orc', 'halfling', 'fairy'];
  const race = migrationRaces[(Math.floor(day / 15) - 2) % migrationRaces.length];
  for (const settlement of world.settlements) {
    const residents = living.filter(c => c.settlementId === settlement.id);
    if (!residents.length || (day % 15 !== 0 && residents.length < 24)) continue;
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    if (!store) continue;
    const food = available(store, 'food');
    let places = Math.min(Math.floor(food / FOOD_BIRTH_PER_PERSON) - residents.length,
      Math.max(1, Math.floor(residents.length / 24)), LIFE_CREATION_LIMIT - living.length);
    if (places <= 0) continue;
    const { x, y } = storeTile(world, store);
    const reception = { x, y };
    const reachable = reachableTiles(world, reception);
    if (reachable[latestFrontier.y * world.map.width + latestFrontier.x] !== 1) continue;
    for (const home of world.buildings) {
      if (home.kind !== 'house' || home.settlementId !== settlement.id) continue;
      const freeBeds = home.capacity - residents.filter(c => c.homeBuildingId === home.id).length;
      for (let i = 0; i < freeBeds && places > 0; i++, places--) {
        const migrant = createAdult(world, race, reception, settlement);
        migrant.homeBuildingId = home.id;
        world.citizens.push(migrant);
        living.push(migrant);
        emitOnce(world, migrant.id + '/arrival', 'migrantArrived', {
          citizenId: migrant.id, settlementId: settlement.id, nationId: settlement.nationId, race, ...reception
        });
      }
      if (places <= 0) break;
    }
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
    fillVacantHomes(world);
    dailyRelationships(world, world.citizens);
    admitMigrants(world);
  }
  if (!birthDue) return;
  const people = new Map(world.citizens.map(c => [c.id, c]));
  for (const citizen of people.values()) checkBirth(world, citizen, people);
}

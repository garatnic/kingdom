import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { updatePopulation } from '../simulation/Population.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR } from '../data/balance.js';

function marriedWorld() {
  const world = createWorld('families', { mixedFamilies: false });
  for (let day = 1; day <= 6; day++) {
    world.worldTimeTick = TIME_TICKS_PER_DAY * day;
    updatePopulation(world, 12);
  }
  return world;
}

test('daily marriage matches only one same-race adult and stores one annual deadline per pair', () => {
  const world = marriedWorld();
  assert.equal(world.events.filter(e => e.type === 'marriage').length, 6);
  const married = world.citizens.filter(c => c.partnerId);
  assert.equal(married.length, 12);
  for (const person of married) {
    const partner = world.citizens.find(c => c.id === person.partnerId);
    assert.equal(person.id, partner.partnerId);
    assert.equal(person.race, partner.race);
    assert.notEqual(Boolean(person.nextBirthCheckTick), Boolean(partner.nextBirthCheckTick));
  }
});

test('birth consumes one annual draw, preserves reciprocal family on reload, and death is idempotent', async () => {
  const world = marriedWorld();
  const parent = world.citizens.find(c => c.nextBirthCheckTick);
  const partner = world.citizens.find(c => c.id === parent.partnerId);
  for (const c of world.citizens) if (c !== parent) delete c.nextBirthCheckTick;
  world.stockpiles[0].total.food = 36;
  world.buildings[0].capacity = world.citizens.length + 1;
  world.rngState = [1, 1, 1, 1];
  world.worldTimeTick = parent.nextBirthCheckTick;
  updatePopulation(world, 12);
  const child = world.citizens.at(-1);
  assert.deepEqual(child.parentIds, [parent.id, partner.id]);
  assert.ok(parent.childIds.includes(child.id) && partner.childIds.includes(child.id));
  assert.equal(child.profession, null);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick += 12;
  world.worldTimeTick += 12;
  updatePopulation(restored, 12);
  updatePopulation(world, 12);
  assert.deepEqual(restored, world);
  parent.lifespanYears = 1;
  updatePopulation(world, 12);
  updatePopulation(world, 12);
  assert.equal(world.events.filter(e => e.type === 'death' && e.citizenId === parent.id).length, 1);
  assert.equal(parent.alive, false);
  assert.ok(child.parentIds.includes(parent.id));
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

test('food shortage advances the birth deadline without consuming randomness', () => {
  const world = marriedWorld();
  world.worldTimeTick = world.citizens.find(c => c.nextBirthCheckTick).nextBirthCheckTick;
  world.stockpiles[0].total.food = 0;
  const randomBefore = [...world.rngState];
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 12);
  assert.deepEqual(world.rngState, randomBefore);
  assert.ok(world.citizens.filter(c => c.nextBirthCheckTick)
    .every(c => c.nextBirthCheckTick === world.worldTimeTick + TIME_TICKS_PER_YEAR));
});

test('an expanded and connected world admits migrants only with food and spare housing', async () => {
  const world = createWorld('migration');
  const store = world.stockpiles[0];
  const home = world.buildings.find(b => b.kind === 'house');
  const y = store.y;
  for (let x = store.x; x < 64; x++) world.map.terrain[y * world.map.width + x] = 'grass';
  store.total.food = 0;
  world.worldTimeTick = 30 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 12);
  assert.ok(discoverFrontier(world, { x: 63, y }, 'east', world.citizens[0].id));
  world.worldTimeTick = 45 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 12);
  store.total.food = 45;
  home.capacity = world.citizens.length + 1;
  world.worldTimeTick = 60 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  const migrant = world.citizens.at(-1);
  assert.equal(world.citizens.length, 13);
  assert.equal(migrant.race, 'fairy');
  assert.equal(migrant.homeBuildingId, home.id);
  assert.equal(migrant.settlementId, store.settlementId);
  assert.deepEqual(migrant.lastKnownSafeTile, { x: store.x, y: store.y });
  assert.equal(world.events.find(e => e.type === 'migrantArrived').total, undefined);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.deepEqual(restored.citizens.at(-1), migrant);
});

test('food shortages in larger settlements add a farmer and retain essential jobs', () => {
  const world = createWorld('workforce');
  const jobs = ['farmer', 'builder', 'woodcutter', 'miner', 'adventurer'];
  for (const [index, citizen] of world.citizens.entries()) citizen.profession = index === 0 ? jobs[0] : jobs[1 + index % 4];
  for (let index = 0; index < 12; index++) {
    const adult = structuredClone(world.citizens[index]);
    adult.id = 'citizen:' + (13 + index);
    adult.profession = 'woodcutter';
    world.citizens.push(adult);
  }
  world.stockpiles[0].total.food = 0;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.filter(c => c.profession === 'farmer').length, 2);
  assert.ok(jobs.every(role => world.citizens.some(c => c.profession === role)));
});

test('vacant housing is reassigned to unhoused residents without exceeding capacity', () => {
  const world = createWorld('housing');
  const house = world.buildings.find(b => b.kind === 'house');
  const initialResidents = world.citizens.filter(c => c.homeBuildingId === house.id);
  const unhoused = world.citizens.find(c => !c.homeBuildingId);
  assert.equal(initialResidents.length, house.capacity);
  initialResidents[0].alive = false;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(unhoused.homeBuildingId, house.id);
  assert.equal(world.citizens.filter(c => c.alive && c.homeBuildingId === house.id).length, house.capacity);
});

test('a mature settlement admits a bounded group between regular migration days', () => {
  const world = createWorld('migration-group');
  const store = world.stockpiles[0];
  const home = world.buildings.find(b => b.kind === 'house');
  const { y } = store;
  for (let x = store.x; x < 64; x++) world.map.terrain[y * world.map.width + x] = 'grass';
  assert.ok(discoverFrontier(world, { x: 63, y }, 'east', world.citizens[0].id));
  while (world.citizens.length < 48) {
    const adult = structuredClone(world.citizens[0]);
    adult.id = 'citizen:' + (world.citizens.length + 1);
    world.citizens.push(adult);
  }
  world.idCounters.citizen = 49;
  home.capacity = 53;
  store.capacity = 300;
  store.total.food = 150;
  world.worldTimeTick = 35 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 50);
  assert.equal(world.events.filter(event => event.type === 'migrantArrived').length, 2);
  assert.ok(world.citizens.every(c => c.homeBuildingId === home.id));
  assert.equal(store.total.food, 150);
});

test('daily matchmaking skips parents and siblings and leaves unrelated adults eligible', () => {
  const world = createWorld('family-matching');
  const [parent, first, sibling, unrelated] = world.citizens;
  for (const citizen of [parent, first, sibling, unrelated]) {
    citizen.race = 'human';
    citizen.birthWorldTimeTick = -20 * TIME_TICKS_PER_YEAR;
    citizen.relationships = {};
  }
  parent.birthWorldTimeTick = -36 * TIME_TICKS_PER_YEAR;
  first.parentIds = sibling.parentIds = [parent.id];
  parent.childIds = [first.id, sibling.id];
  world.citizens = [parent, first, sibling, unrelated];
  for (const [a, b] of [[parent, first], [first, sibling], [first, unrelated]]) {
    a.relationships[b.id] = b.relationships[a.id] = 60;
  }
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(first.partnerId, unrelated.id);
  assert.equal(unrelated.partnerId, first.id);
  assert.equal(parent.partnerId, null);
  assert.equal(sibling.partnerId, null);
});

test('a resident born in the simulation can become a parent and preserve three generations after reload', async () => {
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const world = marriedWorld();
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const firstParent = world.citizens.find(c => c.nextBirthCheckTick);
  for (const citizen of world.citizens) if (citizen !== firstParent) delete citizen.nextBirthCheckTick;
  world.buildings[0].capacity = 30;
  store.capacity += 100;
  store.total.food = 50;
  world.worldTimeTick = firstParent.nextBirthCheckTick;
  world.rngState = [1, 1, 1, 1];
  updatePopulation(world, 12);
  const child = world.citizens.at(-1);
  assert.ok(firstParent.childIds.includes(child.id));

  world.worldTimeTick += 16 * TIME_TICKS_PER_YEAR;
  const newcomer = createAdult(world, child.race, child.lastKnownSafeTile, settlement);
  newcomer.birthWorldTimeTick = world.worldTimeTick - 18 * TIME_TICKS_PER_YEAR;
  child.relationships[newcomer.id] = newcomer.relationships[child.id] = 60;
  world.citizens.push(newcomer);
  for (const citizen of world.citizens) delete citizen.nextBirthCheckTick;
  updatePopulation(world, 12);
  assert.equal(child.partnerId, newcomer.id);

  world.worldTimeTick = child.nextBirthCheckTick;
  world.rngState = [1, 1, 1, 1];
  updatePopulation(world, 12);
  const grandchild = world.citizens.at(-1);
  assert.deepEqual(grandchild.parentIds, [child.id, newcomer.id]);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const savedChild = saved.citizens.find(c => c.id === child.id);
  assert.ok(savedChild.parentIds.includes(firstParent.id) && savedChild.childIds.includes(grandchild.id));
});

test('mixed families are opt-in and children inherit either parent race deterministically across reloads', async () => {
  const prepare = mixedFamilies => {
    const world = createWorld('mixed-family', { mixedFamilies });
    const [first, second] = world.citizens;
    world.citizens = [first, second];
    first.race = 'human';
    second.race = 'fairy';
    first.birthWorldTimeTick = second.birthWorldTimeTick = -20 * TIME_TICKS_PER_YEAR;
    first.relationships[second.id] = second.relationships[first.id] = 100;
    world.worldTimeTick = TIME_TICKS_PER_DAY;
    updatePopulation(world, 12);
    return world;
  };
  const standard = prepare(false);
  assert.ok(standard.citizens.every(person => person.partnerId === null));
  assert.ok(!(await readSnapshot(JSON.stringify(await createSnapshot(standard)))).settings.mixedFamilies);

  const mixed = prepare(true);
  const [parent, partner] = mixed.citizens;
  assert.equal(parent.partnerId, partner.id);
  assert.equal(partner.partnerId, parent.id);
  mixed.stockpiles[0].total.food = 12;
  mixed.buildings[0].capacity = 4;
  mixed.worldTimeTick = parent.nextBirthCheckTick;
  // First draw succeeds; the next draw selects the second parent's race.
  mixed.rngState = [0, 1, 500000, 0];
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(mixed)));
  updatePopulation(mixed, 12);
  updatePopulation(restored, 12);
  assert.deepEqual(restored, mixed);
  const child = mixed.citizens.at(-1);
  assert.deepEqual(child.parentIds, [parent.id, partner.id]);
  assert.equal(child.race, 'fairy');
  assert.ok(child.traits.magicAffinity >= 0.75);
});

test('new worlds default to both rules on while each can be disabled and old saves preserve their options', async () => {
  const defaults = createWorld('default-rules');
  assert.deepEqual(defaults.settings, { mixedFamilies: true, alliedIntervention: true });
  const familiesOff = createWorld('family-rule-off', { mixedFamilies: false });
  const interventionOff = createWorld('intervention-rule-off', { alliedIntervention: false });
  const legacy = createWorld('legacy-rules', { mixedFamilies: false, alliedIntervention: false });
  assert.deepEqual(familiesOff.settings, { alliedIntervention: true });
  assert.deepEqual(interventionOff.settings, { mixedFamilies: true });
  assert.deepEqual(legacy.settings, {});
  for (const world of [defaults, familiesOff, interventionOff, legacy]) {
    assert.deepEqual((await readSnapshot(JSON.stringify(await createSnapshot(world)))).settings, world.settings);
  }
});

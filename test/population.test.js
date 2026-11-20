import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { updatePopulation } from '../simulation/Population.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR } from '../data/balance.js';

function marriedWorld() {
  const world = createWorld('families');
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
  world.buildings[0].capacity = 5;
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
  for (let x = store.x; x < 64; x++) world.map.terrain[y * 64 + x] = 'grass';
  store.total.food = 0;
  world.worldTimeTick = 30 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 12);
  assert.ok(discoverFrontier(world, { x: 63, y }, 'east', world.citizens[0].id));
  world.worldTimeTick = 45 * TIME_TICKS_PER_DAY;
  updatePopulation(world, 12);
  assert.equal(world.citizens.length, 12);
  store.total.food = 45;
  home.capacity++;
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

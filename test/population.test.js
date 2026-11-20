import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
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

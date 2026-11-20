import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { resources } from '../simulation/Economy.js';
import { REAL_STEP_MS, TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR, TICKS_PER_STEP_AT_1X } from '../data/balance.js';

function verify(world) {
  const records = [world.citizens, world.settlements, world.nations, world.buildings, world.stockpiles,
    world.resourceNodes, world.constructionSites, world.reservations, world.inTransit, world.monsters,
    world.quests, world.researchStates, world.events, world.expeditions ?? []].flat();
  assert.equal(new Set(records.map(record => record.id)).size, records.length);
  for (const record of records) {
    const [kind, value] = record.id.split(':');
    assert.ok(world.idCounters[kind] > Number(value), record.id);
  }
  const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
  assert.ok(world.citizens.every(c => Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.hp)));
  assert.ok(world.citizens.every(c => Object.values(c.inventory).every(nonnegative)));
  assert.ok(world.resourceNodes.every(node => nonnegative(node.quantity)));
  assert.ok(world.stockpiles.every(store => resources.reduce((sum, key) => sum + store.total[key], 0) <= store.capacity));
  for (const store of world.stockpiles) {
    for (const key of resources) {
      const reserved = world.reservations.filter(r => r.sourceId === store.id && r.resource === key &&
        r.state === 'reserved').reduce((sum, r) => sum + r.quantity, 0);
      assert.ok(nonnegative(store.total[key]), key);
      assert.equal(store.reserved[key], reserved);
      assert.ok(reserved <= store.total[key]);
    }
  }
  for (const listing of [world.citizens, world.nations, world.inTransit, world.researchStates]) {
    assert.ok(listing.every(record => record.id));
  }
  for (const shipment of world.inTransit) {
    assert.ok(nonnegative(shipment.quantity));
    const reservation = world.reservations.find(r => r.id === shipment.reservationId);
    assert.equal(reservation?.state, 'inTransit');
    assert.equal(reservation.quantity, shipment.quantity);
  }
  for (const citizen of world.citizens.filter(c => c.alive && c.settlementId)) {
    assert.equal(citizen.nationId, world.settlements.find(s => s.id === citizen.settlementId)?.nationId);
  }
}

async function checkCase(label, seed, speed, steps, prepare = () => {}) {
  const world = createWorld(seed);
  prepare(world);
  setSpeed(world, speed);
  const startState = await createSnapshot(world);
  advanceFrame(world, 30000, true);
  assert.equal(world.worldTimeTick, 0);
  let largestStepMs = 0;
  let totalStepMs = 0;
  for (let i = 0; i < steps; i++) {
    const start = performance.now();
    advanceFrame(world, REAL_STEP_MS);
    const elapsed = performance.now() - start;
    totalStepMs += elapsed;
    largestStepMs = Math.max(largestStepMs, elapsed);
    if (world.worldTimeTick % TIME_TICKS_PER_DAY === 0) verify(world);
  }
  const expected = steps * speed * TICKS_PER_STEP_AT_1X;
  assert.equal(world.worldTimeTick, expected);
  verify(world);
  const saved = await createSnapshot(world);
  const restored = await readSnapshot(JSON.stringify(saved));
  assert.deepEqual(restored, world);
  for (let i = 0; i < 20; i++) {
    advanceFrame(world, REAL_STEP_MS);
    advanceFrame(restored, REAL_STEP_MS);
  }
  assert.deepEqual(restored, world);
  const tally = Object.fromEntries(['founding', 'birth', 'death', 'research_unlocked', 'adventureReturned']
    .map(type => [type, world.events.filter(event => event.type === type).length]));
  const summary = { label, seed, startState: { worldTimeTick: 0, rngState: startState.world.rngState,
    food: startState.world.stockpiles[0].total.food }, operations: { speed, frames: steps, frameMs: REAL_STEP_MS },
    expectedWorldTimeTick: expected, measuredWorldTimeTick: saved.world.worldTimeTick,
    averageSimulationStepMs: Number((totalStepMs / steps).toFixed(3)), largestStepMs: Number(largestStepMs.toFixed(3)),
    population: world.citizens.filter(c => c.alive).length, nations: world.nations.length,
    worldEvents: tally, invariantViolations: 0, result: 'pass' };
  return summary;
}

const years = 2 * TIME_TICKS_PER_YEAR / (20 * TICKS_PER_STEP_AT_1X);
const cases = [];
cases.push(await checkCase('normal-30-minutes-of-fixed-steps', 'world-tree', 1, 18_000));
cases.push(await checkCase('normal-seed-two-years', 'world-tree', 20, years));
cases.push(await checkCase('food-shortage-two-years', 'food-shortage', 20, years,
  world => { world.stockpiles[0].total.food = 0; }));
cases.push(await checkCase('obstacle-terrain-two-years', '障害地形', 20, years));
console.log(JSON.stringify({ scope: 'Simulation clock and state; browser is tested separately.', cases }, null, 2));

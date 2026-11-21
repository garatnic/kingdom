import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { deposit, harvest, freeCapacity } from '../simulation/Economy.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';

test('harvest and capacity-limited deposits conserve stock and refuse duplicate debit', () => {
  const world = createWorld('ledger');
  const worker = world.citizens[0];
  const node = world.resourceNodes.find(n => n.resource === 'wood');
  const store = world.stockpiles[0];
  const sum = () => node.quantity + worker.inventory.wood + store.total.wood;
  const initial = sum();
  worker.lastKnownSafeTile = { x: node.x, y: node.y };
  assert.equal(harvest(world, worker, node), true);
  assert.equal(harvest(world, worker, node), false);
  assert.equal(node.quantity, 18);
  assert.equal(worker.inventory.wood, 2);
  store.capacity -= freeCapacity(store) - 1;
  assert.equal(deposit(worker, store), true);
  assert.equal(deposit(worker, store), false);
  assert.equal(worker.inventory.wood, 1);
  assert.equal(freeCapacity(store), 0);
  assert.equal(sum(), initial);
});

test('natural play delivers mined and gathered resources, eats and sleeps', () => {
  for (const seed of ['world-tree', '障害地形', '0']) {
    const world = createWorld(seed);
    setSpeed(world, 20);
    let gathered = false;
    let ate = false;
    let rested = false;
    for (let i = 0; i < 125; i++) {
      const before = world.citizens.map(c => [c.hunger, c.fatigue]);
      advanceFrame(world, 100);
      const store = world.stockpiles[0];
      assert.ok(freeCapacity(store) >= 0);
      assert.ok(Object.values(store.total).every(n => Number.isInteger(n) && n >= 0));
      gathered ||= store.total.food > 24 && store.total.iron >= 4 && store.total.manaStone >= 1;
      ate ||= world.citizens.some((c, j) => c.hunger < before[j][0]);
      rested ||= world.citizens.some((c, j) => c.fatigue < before[j][1]);
    }
    assert.ok(gathered && ate && rested, seed);
  }
});

test('starvation records one death, preserves inventory as drops, and survives save/load', async () => {
  const world = createWorld('death');
  const worker = world.citizens[0];
  world.stockpiles[0].total.food = 0;
  worker.inventory.stone = 2;
  worker.hunger = 99;
  worker.hp = 3;
  world.worldTimeTick = 588;
  advanceFrame(world, 100);
  assert.equal(worker.alive, false);
  assert.equal(worker.inventory.stone, 0);
  assert.equal(world.resourceNodes.find(n => n.dropped).quantity, 2);
  advanceFrame(world, 100);
  assert.equal(world.events.filter(e => e.type === 'death').length, 1);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.deepEqual(restored, world);
});

test('injured residents recover during rest when adequately fed', () => {
  const world = createWorld('recovery');
  const worker = world.citizens[0];
  worker.hp = 25;
  worker.hunger = 20;
  advanceFrame(world, 100);
  assert.equal(worker.action.kind, 'sleep');
  setSpeed(world, 20);
  for (let i = 0; i < 35; i++) advanceFrame(world, 100);
  assert.ok(worker.hp > 25);
  assert.ok(worker.alive);
});

test('loot cannot consume space reserved for the settlement food target', () => {
  const world = createWorld('food-space');
  const [store] = world.stockpiles;
  const [worker] = world.citizens;
  worker.inventory.wood = 100;
  worker.inventory.food = 12;
  assert.equal(deposit(worker, store, 48), true);
  assert.equal(store.total.food, 36);
  assert.equal(freeCapacity(store), 12);
  assert.equal(deposit(worker, store, 48), false);
  worker.inventory.food = 12;
  assert.equal(deposit(worker, store, 48), true);
  assert.equal(store.total.food, 48);
  assert.equal(freeCapacity(store), 0);
});

test('urban farmers choose the nearby ripe field over an older distant field', async () => {
  const { updateCitizens } = await import('../simulation/CitizenAI.js');
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const world = createWorld('urban-farm');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  while (world.citizens.length < 32) world.citizens.push(createAdult(world, 'human', store, home));
  for (const person of world.citizens) person.decisionAt = 1000;
  const farmer = world.citizens.find(c => c.profession === 'farmer');
  Object.assign(farmer, { x: store.x + 0.5, y: store.y + 0.5, lastKnownSafeTile: { x: store.x, y: store.y }, decisionAt: 0 });
  for (const [index, offset] of [14, 4].entries()) {
    world.buildings.push({ id: 'building:' + (index + 2), kind: 'farm', settlementId: home.id,
      x: store.x + offset, y: store.y, width: 2, height: 2, harvestAt: 0 });
  }
  updateCitizens(world, 12);
  assert.equal(farmer.action.kind, 'farm');
  assert.equal(farmer.action.targetId, 'building:3');
});

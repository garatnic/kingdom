import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../simulation/path.js';
import { createWorld } from '../engine/World.js';
import { updateCitizens } from '../simulation/CitizenAI.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { applyGodCommand } from '../systems/GodPowers.js';

test('distant idle walking batches ticks and flushes them when the camera returns after save/load', async () => {
  const world = createWorld('distance');
  const citizen = world.citizens[0];
  world.citizens = [citizen];
  Object.assign(citizen, { x: 1.5, y: 1.5, lastKnownSafeTile: { x: 1, y: 1 } });
  world.map.terrain[world.map.width + 1] = world.map.terrain[world.map.width + 2] = 'grass';
  citizen.action = { kind: 'explore', phase: 'travel', goal: { x: 2, y: 1 },
    path: [{ x: 2, y: 1 }], progress: 0, navigationVersion: world.map.navigationVersion };
  updateCitizens(world, 12, { x: 64, y: 64 });
  assert.equal(citizen.x, 1.5);
  assert.equal(citizen.action.deferredMovement, 12);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  updateCitizens(restored, 12, { x: 1, y: 1 });
  assert.equal(restored.citizens[0].action.progress, 24);
  assert.equal(restored.citizens[0].action.deferredMovement, undefined);
});

test('the world creates, updates and restores three hundred individual residents', async () => {
  const world = createWorld('population');
  world.map.terrain.fill('grass');
  for (let i = 0; i < 29; i++) {
    const quantity = Math.min(10, 300 - world.citizens.length);
    assert.equal(applyGodCommand(world, {
      commandId: 'populate-' + i, kind: 'life',
      payload: { x: 3 + 7 * (i % 8), y: 3 + 7 * Math.floor(i / 8), value: 'human', quantity }
    }), null);
  }
  for (let i = 0; i < 40; i++) {
    world.worldTimeTick += 12;
    updateCitizens(world, 12, { x: 63, y: 63 });
  }
  assert.equal(world.citizens.filter(c => c.alive).length, 300);
  assert.equal(new Set(world.citizens.map(c => c.id)).size, 300);
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

test('distant logistics preserve carried cargo and deliver it once after restoration', async () => {
  const world = createWorld('distant-cargo');
  const citizen = world.citizens[0];
  const store = world.stockpiles[0];
  world.citizens = [citizen];
  world.map.terrain.fill('grass');
  const start = { x: store.x + 2, y: store.y };
  Object.assign(citizen, { x: start.x + 0.5, y: start.y + 0.5, lastKnownSafeTile: start });
  citizen.inventory.food = 2;
  citizen.action = { kind: 'haul', phase: 'travel', goal: { x: store.x, y: store.y },
    targetId: store.id, path: [{ x: start.x - 1, y: start.y }, { x: store.x, y: store.y }],
    progress: 0, navigationVersion: world.map.navigationVersion };
  const distant = { x: 100, y: 100 };
  updateCitizens(world, 12, distant);
  assert.equal(citizen.action.deferredMovement, 12);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  for (let i = 0; i < 8; i++) updateCitizens(restored, 12, distant);
  assert.equal(restored.stockpiles[0].total.food, store.total.food + 2);
  assert.equal(restored.citizens[0].inventory.food, 0);
});

test('far settlements move a ripe harvest to the shared store once across camera changes and reload', async () => {
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const { nextId } = await import('../simulation/Identity.js');
  const { NEED_HOUR_TICKS } = await import('../data/balance.js');
  const { FARM_YIELD, FARM_HARVEST_TICKS } = await import('../data/buildings.js');
  const world = createWorld('far-harvest');
  world.map.terrain.fill('grass');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const origin = { x: store.x, y: store.y };
  for (let i = 0; i < 4; i++) world.citizens.push(createAdult(world, 'human', origin, settlement));
  const farm = { id: nextId(world, 'building'), kind: 'farm', settlementId: settlement.id,
    x: origin.x + 3, y: origin.y, width: 2, height: 2, completedAt: 0, harvestAt: NEED_HOUR_TICKS };
  world.buildings.push(farm);
  world.worldTimeTick = NEED_HOUR_TICKS;
  for (const citizen of world.citizens) citizen.decisionAt = world.worldTimeTick + NEED_HOUR_TICKS;
  const foodBefore = store.total.food;
  updateCitizens(world, 12, origin);
  assert.equal(store.total.food, foodBefore);
  const distant = { x: 110, y: 110 };
  updateCitizens(world, 12, distant);
  assert.equal(store.total.food, foodBefore + FARM_YIELD);
  assert.equal(farm.harvestAt, world.worldTimeTick + FARM_HARVEST_TICKS);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  updateCitizens(restored, 12, distant);
  assert.equal(restored.stockpiles[0].total.food, foodBefore + FARM_YIELD);
  const depot = restored.stockpiles[0];
  depot.capacity = Object.values(depot.total).reduce((sum, value) => sum + value, 0) + 2;
  restored.worldTimeTick += FARM_HARVEST_TICKS;
  for (const citizen of restored.citizens) citizen.decisionAt = restored.worldTimeTick + NEED_HOUR_TICKS;
  updateCitizens(restored, 12, distant);
  assert.equal(depot.total.food, foodBefore + FARM_YIELD + 2);
  assert.equal(restored.citizens.reduce((sum, c) => sum + c.inventory.food, 0), FARM_YIELD - 2);
  const resumed = await readSnapshot(JSON.stringify(await createSnapshot(restored)));
  resumed.stockpiles[0].capacity += FARM_YIELD;
  resumed.worldTimeTick += NEED_HOUR_TICKS;
  updateCitizens(resumed, 12, distant);
  assert.equal(resumed.stockpiles[0].total.food, foodBefore + 2 * FARM_YIELD);
  assert.equal(resumed.citizens.reduce((sum, c) => sum + c.inventory.food, 0), 0);
});

test('distant meals use only available food and leave isolated residents to individual AI', async () => {
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const { NEED_HOUR_TICKS, NEEDS } = await import('../data/balance.js');
  const world = createWorld('far-meals');
  world.map.terrain.fill('grass');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const origin = { x: store.x, y: store.y };
  const blocked = { x: origin.x + 5, y: origin.y };
  const diners = [blocked, origin, origin].map(tile => {
    const person = createAdult(world, 'human', tile, settlement);
    person.hunger = NEEDS.eat;
    world.citizens.push(person);
    return person;
  });
  world.citizens.push(createAdult(world, 'human', origin, settlement));
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    world.map.terrain[(blocked.y + dy) * world.map.width + blocked.x + dx] = 'water';
  }
  world.worldTimeTick = NEED_HOUR_TICKS;
  store.reserved.food = store.total.food - 1;
  for (const citizen of world.citizens) citizen.decisionAt = world.worldTimeTick + NEED_HOUR_TICKS;
  updateCitizens(world, 12, { x: 110, y: 110 });
  assert.equal(store.total.food, store.reserved.food);
  assert.ok(diners[0].hunger >= NEEDS.eat);
  assert.ok(diners[1].hunger < NEEDS.eat);
  assert.ok(diners[2].hunger >= NEEDS.eat);
});

test('distant timber uses reachable deposits and conserves stock within storage limits', async () => {
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const { NEED_HOUR_TICKS } = await import('../data/balance.js');
  const world = createWorld('distant-timber');
  world.map.terrain.fill('grass');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const origin = { x: store.x, y: store.y };
  for (let i = 0; i < 4; i++) world.citizens.push(createAdult(world, 'human', origin, settlement));
  for (const citizen of world.citizens) {
    citizen.profession = citizen === world.citizens.at(-1) ? 'woodcutter' : 'farmer';
    citizen.decisionAt = NEED_HOUR_TICKS * 2;
  }
  const reachable = { id: 'node:900', resource: 'wood', quantity: 3, x: origin.x + 5, y: origin.y };
  const blocked = { id: 'node:901', resource: 'wood', quantity: 3, x: origin.x + 3, y: origin.y };
  world.resourceNodes = [blocked, reachable];
  world.map.terrain[blocked.y * world.map.width + blocked.x] = 'water';
  store.total.food = 64;
  store.total.wood = 0;
  store.total.stone = 0;
  store.capacity = 65;
  world.worldTimeTick = NEED_HOUR_TICKS;
  updateCitizens(world, 12, { x: 110, y: 110 });
  assert.equal(store.total.wood, 1);
  assert.equal(reachable.quantity, 2);
  assert.equal(blocked.quantity, 3);
});

test('distant construction delivers one reservation and resumes without double charging', async () => {
  const { createAdult } = await import('../simulation/CreateAdult.js');
  const { planSite } = await import('../simulation/Construction.js');
  const { NEED_HOUR_TICKS } = await import('../data/balance.js');
  const world = createWorld('distant-build');
  world.map.terrain.fill('grass');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const origin = { x: store.x, y: store.y };
  for (let i = 0; i < 4; i++) world.citizens.push(createAdult(world, 'human', origin, settlement));
  for (const citizen of world.citizens) citizen.profession = 'farmer';
  world.citizens.at(-1).profession = 'builder';
  const site = planSite(world, settlement, 'farm', origin.x + 5, origin.y);
  assert.ok(site);
  const wood = store.total.wood;
  const far = { x: 110, y: 110 };
  for (const citizen of world.citizens) citizen.decisionAt = NEED_HOUR_TICKS * 10;
  world.worldTimeTick = NEED_HOUR_TICKS;
  updateCitizens(world, 12, far);
  assert.equal(store.total.wood, wood - 2);
  assert.deepEqual(site.delivered, { wood: 2 });
  assert.equal(world.inTransit.length, 0);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  for (let hour = 2; hour <= 3; hour++) {
    restored.worldTimeTick = NEED_HOUR_TICKS * hour;
    updateCitizens(restored, 12, far);
  }
  assert.equal(restored.stockpiles[0].total.wood, wood - 2);
  assert.ok(restored.buildings.some(b => b.kind === 'farm'));
  restored.worldTimeTick = NEED_HOUR_TICKS * 4;
  updateCitizens(restored, 12, far);
  assert.ok(restored.constructionSites.some(s => s.id !== site.id));
});


test('a starving resident turns back to available food without losing cargo', async () => {
  const world = createWorld('hungry-hauler');
  world.map.terrain.fill('grass');
  const [store] = world.stockpiles;
  const [citizen] = world.citizens;
  const start = { x: store.x + 5, y: store.y };
  const goal = { x: start.x + 2, y: start.y };
  Object.assign(citizen, { x: start.x + 0.5, y: start.y + 0.5, lastKnownSafeTile: start, hunger: 93 });
  citizen.inventory.wood = 2;
  citizen.action = {
    kind: 'gather', phase: 'travel', goal, path: findPath(world, start, goal),
    progress: 0, navigationVersion: world.map.navigationVersion
  };
  world.worldTimeTick = 600;
  updateCitizens(world, 12);
  assert.equal(citizen.action.kind, 'eat');
  assert.deepEqual(citizen.action.goal, { x: store.x, y: store.y });
  assert.equal(citizen.inventory.wood, 2);
  await readSnapshot(JSON.stringify(await createSnapshot(world)));
});

test('a hungry builder leaves a stalled site to eat and preserves completed work', async () => {
  const { planSite } = await import('../simulation/Construction.js');
  const { NEED_HOUR_TICKS } = await import('../data/balance.js');
  const world = createWorld('builder-break');
  world.map.terrain.fill('grass');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const builder = world.citizens.find(c => c.profession === 'builder');
  const site = planSite(world, home, 'farm', store.x + 4, store.y);
  site.progress = 50;
  const tile = { x: site.x - 1, y: site.y };
  Object.assign(builder, { x: tile.x + 0.5, y: tile.y + 0.5, lastKnownSafeTile: tile, hunger: 94,
    action: { kind: 'build', phase: 'perform', targetId: site.id } });
  world.worldTimeTick = NEED_HOUR_TICKS;
  updateCitizens(world, 12);
  assert.equal(builder.action.kind, 'eat');
  assert.equal(site.progress, 50);
});

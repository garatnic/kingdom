import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { buildAtSite, cancelSite, deliverMaterials, pickUpMaterials, planSettlementConstruction, planSite, reserveMaterials } from '../simulation/Construction.js';
import { workTicks } from '../data/buildings.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { findPath } from '../simulation/path.js';

test('building materials are counted once across reserve, transport, site and consumption', async () => {
  let world = createWorld('construction');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const [carrier] = world.citizens;
  for (let y = 35; y < 37; y++) {
    for (let x = 35; x < 37; x++) world.map.terrain[y * 64 + x] = 'grass';
  }
  const site = planSite(world, settlement, 'house', 35, 35);
  assert.ok(site);
  assert.equal(planSite(world, settlement, 'house', 35, 35), null);
  assert.equal(reserveMaterials(world, site, store), true);
  assert.equal(reserveMaterials(world, site, store), false);
  assert.equal(store.total.wood, 20);
  assert.equal(store.reserved.wood, 8);
  assert.equal(buildAtSite(world, site, 99999), null);

  const shipment = pickUpMaterials(world, world.reservations[0], carrier);
  assert.equal(pickUpMaterials(world, world.reservations[0], carrier), null);
  assert.equal(store.total.wood, 12);
  assert.equal(store.reserved.wood, 0);
  assert.equal(store.total.wood + shipment.quantity, 20);

  world = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const [siteAfter] = world.constructionSites;
  const [workerAfter] = world.citizens;
  const [woodShipment] = world.inTransit;
  assert.equal(deliverMaterials(world, woodShipment, workerAfter), true);
  assert.equal(deliverMaterials(world, woodShipment, workerAfter), false);
  assert.equal(siteAfter.delivered.wood + world.stockpiles[0].total.wood, 20);
  const stone = pickUpMaterials(world, world.reservations[1], workerAfter);
  assert.equal(deliverMaterials(world, stone, workerAfter), true);
  assert.equal(buildAtSite(world, siteAfter, workTicks('house') - 1), null);
  assert.ok(buildAtSite(world, siteAfter, 1));
  assert.equal(buildAtSite(world, siteAfter, 1), null);
  assert.equal(world.constructionSites.length, 0);
  assert.equal(world.reservations.length, 0);
  assert.equal(world.inTransit.length, 0);
  assert.deepEqual(world.events.at(-1).consumed, { wood: 8, stone: 2 });
  assert.equal(findPath(world, workerAfter.lastKnownSafeTile, { x: 36, y: 36 }), null);
});

test('shortage never creates a partial reservation', () => {
  const world = createWorld('shortage');
  const [store] = world.stockpiles;
  const site = planSite(world, world.settlements[0], 'house', 30, 30);
  assert.ok(site);
  store.total.stone = 1;
  assert.equal(reserveMaterials(world, site, store), false);
  assert.equal(store.reserved.wood, 0);
  assert.equal(world.reservations.length, 0);
});

test('three seeded settlements autonomously build farms, house residents and retain food for ten days', async () => {
  const { advanceFrame, setSpeed } = await import('../engine/GameLoop.js');
  for (const seed of ['world-tree', '障害地形', '0']) {
    const world = createWorld(seed);
    setSpeed(world, 20);
    for (let i = 0; i < 600; i++) advanceFrame(world, 100);
    assert.equal(world.worldTimeTick, 10 * 14400);
    const farms = world.buildings.filter(b => b.kind === 'farm');
    assert.ok(farms.some(farm => farm.harvestAt > farm.completedAt + 4800), seed);
    assert.ok(world.citizens.every(c => c.alive && c.homeBuildingId), seed);
    assert.ok(world.stockpiles[0].total.food >= 24, seed);
    assert.deepEqual(new Set(world.buildings.map(b => b.kind)),
      new Set(['house', 'farm', 'warehouse', 'smithy', 'guild', 'barracks']), seed);
    assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
  }
});

test('cancellation releases reserved stone and drops in-transit wood once', () => {
  const world = createWorld('cancellation');
  const [store] = world.stockpiles;
  const site = planSite(world, world.settlements[0], 'house', 30, 30);
  assert.ok(site);
  assert.equal(reserveMaterials(world, site, store), true);
  pickUpMaterials(world, world.reservations[0], world.citizens[0]);
  assert.equal(cancelSite(world, site), true);
  assert.equal(cancelSite(world, site), false);
  assert.equal(store.reserved.stone, 0);
  assert.equal(store.total.stone, 10);
  assert.equal(store.total.wood + world.resourceNodes.find(n => n.dropped).quantity, 20);
  assert.equal(world.inTransit.length, 0);
});

test('an unfunded smithy cannot block the first farm', () => {
  const world = createWorld('needs-first');
  const [store] = world.stockpiles;
  const [settlement] = world.settlements;
  const site = planSite(world, settlement, 'smithy', 30, 30);
  assert.ok(site);
  assert.equal(reserveMaterials(world, site, store), false);
  const next = planSettlementConstruction(world, settlement, store, store, world.citizens.length);
  assert.equal(next.kind, 'farm');
  assert.ok(!world.constructionSites.includes(site));
  assert.equal(store.total.iron, 0);
});

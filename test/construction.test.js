import { territoryAt } from '../simulation/Territory.js';
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
    for (let x = 35; x < 37; x++) world.map.terrain[y * world.map.width + x] = 'grass';
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
  workerAfter.race = 'orc';
  workerAfter.profession = 'builder';
  assert.equal(buildAtSite(world, siteAfter, 100, workerAfter), null);
  assert.equal(siteAfter.progress, 110);
  assert.equal(buildAtSite(world, siteAfter, workTicks('house') - 111), null);
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
  const carrier = world.citizens[0];
  const shipment = pickUpMaterials(world, world.reservations[0], carrier);
  carrier.action = { kind: 'deliverMaterials', phase: 'travel', targetId: shipment.id };
  assert.equal(cancelSite(world, site), true);
  assert.equal(carrier.action.kind, 'idle');
  assert.equal(carrier.decisionAt, world.worldTimeTick);
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

test('a completed building cannot sever the only land connection', () => {
  const world = createWorld('crossing');
  world.map.terrain.fill('water');
  for (let y = 8; y <= 9; y++) {
    for (let x = 4; x <= 12; x++) world.map.terrain[y * world.map.width + x] = 'grass';
  }
  Object.assign(world.buildings[0], { x: 2, y: 8 });
  const shore = { x: 12, y: 8 };
  const base = { x: 4, y: 8 };
  assert.ok(findPath(world, base, shore));
  const site = planSite(world, world.settlements[0], 'farm', 7, 8);
  assert.ok(site);
  site.delivered.wood = 2;
  assert.equal(buildAtSite(world, site, workTicks('farm')), null);
  assert.ok(findPath(world, base, shore));
});

test('a growing settlement plans food production beyond its first two farms', () => {
  const world = createWorld('large-farm');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  store.total.food = 30;
  const first = planSite(world, settlement, 'farm', 35, 35);
  const second = planSite(world, settlement, 'farm', 37, 35);
  assert.ok(first && second);
  world.constructionSites.length = 0;
  world.buildings.push({ ...first, id: 'building:2' }, { ...second, id: 'building:3' });
  assert.equal(planSettlementConstruction(world, settlement, store, store, 24)?.kind, 'warehouse');
  store.capacity += 100;
  assert.equal(planSettlementConstruction(world, settlement, store, store, 24)?.kind, 'farm');
});

test('a large settlement below the family food reserve plans an additional farm', () => {
  const world = createWorld('farm-reserve');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  store.capacity = 200;
  store.total.food = 80;
  world.buildings.push({ ...world.buildings[0], kind: 'farm', x: settlement.x + 3, y: settlement.y + 2 });
  assert.equal(planSettlementConstruction(world, settlement, store, store, 32).kind, 'farm');
  world.constructionSites.length = 0;
  store.capacity = 135;
  settlement.foodWarning = true;
  assert.equal(planSettlementConstruction(world, settlement, store, store, 32).kind, 'farm');
});

test('growing towns keep room for warehouse materials before the food target fills the depot', async () => {
  const { deposit } = await import('../simulation/Economy.js');
  const world = createWorld('growth-storage');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  store.capacity = 200;
  store.total.food = 140;
  store.total.manaStone = 30;
  store.total.wood = 0;
  store.total.stone = 0;
  const [citizen] = world.citizens;
  citizen.inventory.food = 60;
  citizen.inventory.wood = 10;
  citizen.inventory.stone = 5;
  assert.equal(deposit(citizen, store, 48 * 4), true);
  assert.deepEqual([store.total.food, store.total.wood, store.total.stone], [155, 10, 5]);
  assert.equal(citizen.inventory.food, 45);
  assert.equal(planSettlementConstruction(world, settlement, store, store, 48).kind, 'warehouse');
});

test('mature settlements can extend housing into forest without building on depots', () => {
  const world = createWorld('forest-housing');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('forest');
  store.capacity = 250;
  store.total.food = 128;
  world.buildings.push({ ...world.buildings[0], kind: 'farm', x: settlement.x + 4, y: settlement.y + 2 });
  const site = planSettlementConstruction(world, settlement, store, store, 32);
  assert.equal(site.kind, 'house');
  assert.equal(world.map.terrain[site.y * world.map.width + site.x], 'forest');
  assert.ok(store.x < site.x || store.x >= site.x + site.width || store.y < site.y || store.y >= site.y + site.height);
});


test('settlements extend construction from existing buildings beyond the old center radius', () => {
  const world = createWorld('outer-district');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('mountain');
  store.capacity = 550;
  store.total.food = 400;
  const x = settlement.x + 14;
  const y = settlement.y;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) world.map.terrain[(y + dy) * world.map.width + x + dx] = 'forest';
  }
  world.buildings.push({ ...world.buildings[0], kind: 'farm', x: settlement.x + 3, y: settlement.y + 2 });
  assert.equal(planSettlementConstruction(world, settlement, store, store, 100), null);
  world.buildings.push({ ...world.buildings[0], kind: 'farm', x: x - 6, y });
  const site = planSettlementConstruction(world, settlement, store, store, 100);
  assert.equal(site.kind, 'house');
  assert.deepEqual([site.x, site.y], [x, y]);
});


test('finished buildings extend borders without taking an existing foreign claim', () => {
  const world = createWorld('border-growth');
  const [home] = world.settlements;
  const foreign = { id: 'settlement:2', nationId: 'nation:2', x: 46, y: 32 };
  home.nationId = 'nation:1';
  world.settlements.push(foreign);
  world.nations.push({ id: home.nationId }, { id: foreign.nationId });
  world.map.terrain.fill('grass');
  const neutral = { x: 41, y: 28 };
  const contested = { x: 42, y: 31 };
  assert.equal(territoryAt(world, neutral), null);
  assert.equal(territoryAt(world, contested), foreign.nationId);
  assert.equal(planSite(world, home, 'farm', 40, 32), null);
  const site = planSite(world, home, 'farm', 38, 30);
  assert.ok(site);
  assert.equal(territoryAt(world, neutral), null);
  site.delivered.wood = 2;
  assert.ok(buildAtSite(world, site, workTicks('farm')));
  assert.equal(territoryAt(world, neutral), home.nationId);
  assert.equal(territoryAt(world, contested), foreign.nationId);
});

test('an arcane capital builds the national farm requirement even with a full food reserve', async () => {
  const { ensureResearch } = await import('../simulation/Research.js');
  const world = createWorld('arcane-farm');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  store.capacity = 160;
  store.total.food = 80;
  const nation = { id: 'nation:1', capitalId: home.id, settlementIds: [home.id], policy: { primary: 'research' } };
  home.nationId = nation.id;
  world.nations.push(nation);
  const state = ensureResearch(world, nation, ['verdant_1']);
  state.civilization = 'arcane';
  world.buildings[0].capacity = 24;
  world.buildings.push(...[4, 7].map(offset => ({
    id: 'building:' + world.idCounters.building++, kind: 'farm', settlementId: home.id, width: 2, height: 2, x: home.x + offset, y: home.y
  })));
  world.map.terrain.fill('forest');
  const guild = planSettlementConstruction(world, home, store, store, 20);
  assert.equal(guild.kind, 'guild');
  cancelSite(world, guild);
  world.buildings.push({ ...guild, id: 'building:' + world.idCounters.building++ });
  world.map.terrain.fill('grass');
  assert.equal(planSettlementConstruction(world, home, store, store, 20).kind, 'farm');
});

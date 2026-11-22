import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';
import { applyGodCommand } from '../systems/GodPowers.js';
import { emitOnce, historyFor, trimHistory } from '../systems/History.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';

const command = (commandId, kind, tile, value, quantity) => ({
  commandId, kind, issuedAtRealTime: 0, payload: { ...tile, value, quantity }
});

test('god commands create people, resources and monsters atomically and deduplicate after reload', async () => {
  const world = createWorld('intervention');
  const occupied = world.citizens.map(c => c.lastKnownSafeTile);
  const grass = (x, y) => world.map.terrain[y * world.map.width + x] === 'grass';
  let tile;
  for (let x = 30; x <= 34 && !tile; x++) {
    for (let y = 30; y <= 34 && !tile; y++) {
      if (x < 32 && grass(x, y) && !occupied.some(p => p.x === x && p.y === y)) tile = { x, y };
    }
  }
  assert.ok(tile);
  assert.equal(applyGodCommand(world, command('life-1', 'life', tile, 'elf', 1)), null);
  assert.equal(world.citizens.length, 13);
  assert.equal(world.citizens.at(-1).id, 'citizen:13');
  assert.equal(world.citizens.at(-1).settlementId, 'settlement:1');
  const add = command('resource-1', 'resource', tile, 'iron', 5);
  assert.equal(applyGodCommand(world, add), null);
  assert.equal(world.resourceNodes.at(-1).quantity, 5);
  const frontier = world.map.frontier;
  assert.equal(applyGodCommand(world, command('monsters-1', 'monster', frontier, 'goblin', 4)), null);
  const beforeLimit = structuredClone(world);
  assert.equal(applyGodCommand(world, command('monsters-2', 'monster', frontier, 'goblin', 1)), 'LIMIT_REACHED');
  assert.deepEqual(world, beforeLimit);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(applyGodCommand(restored, add), 'DUPLICATE');
  assert.deepEqual(restored, world);
  assert.equal(historyFor(world, 'world').filter(e => e.type === 'god_intervention').length, 3);
});

test('terrain changes reject blocked routes and allow cost changes without moving residents', () => {
  const world = createWorld('terrain-editor');
  const tile = { x: 10, y: 10 };
  const origin = { x: 9, y: 10 };
  world.citizens = [];
  world.buildings = [];
  world.resourceNodes = [{ id: 'node:1', x: 11, y: 10, resource: 'food', quantity: 2 }];
  world.stockpiles = [{ ...world.stockpiles[0], ...origin }];
  world.map.terrain.fill('water');
  for (let x = 9; x <= 11; x++) world.map.terrain[10 * world.map.width + x] = 'grass';
  const before = structuredClone(world);
  assert.equal(applyGodCommand(world, command('cut-off', 'terrain', tile, 'water')), 'PATH_DISCONNECTED');
  assert.deepEqual(world, before);
  assert.equal(applyGodCommand(world, command('new-cost', 'terrain', tile, 'forest')), null);
  assert.equal(world.map.navigationVersion, 1);
  assert.equal(world.map.terrain[10 * world.map.width + 10], 'forest');
  const undo = command('undo-cost', 'terrain', tile, 'undo');
  assert.equal(applyGodCommand(world, undo), null);
  assert.equal(world.map.terrain[10 * world.map.width + 10], 'grass');
  assert.equal(world.map.navigationVersion, 2);
  assert.equal(applyGodCommand(world, undo), 'DUPLICATE');
  assert.equal(applyGodCommand(world, command('undo-again', 'terrain', tile, 'undo')), 'NO_TARGET');
});

test('history ignores duplicate transaction types and retains important events despite trimming', () => {
  const world = createWorld('history');
  const id = world.citizens[0].id;
  assert.equal(emitOnce(world, 'test-tx', 'death', { citizenId: id }), true);
  assert.equal(emitOnce(world, 'test-tx', 'death', { citizenId: id }), false);
  for (let i = 0; i < 520; i++) emitOnce(world, 'gather-' + i, 'adventureDeparted', {});
  trimHistory(world);
  assert.equal(world.events.filter(e => e.type === 'adventureDeparted').length, 500);
  assert.deepEqual(historyFor(world, 'citizen', id).map(e => e.type), ['death']);
});

test('invalid domain references cannot be committed to a snapshot', async () => {
  const world = createWorld('invalid-domain');
  world.quests.push({ id: 'quest:1', settlementId: world.settlements[0].id, targetId: 'monster:9999',
    claimedBy: null, lootIds: [] });
  world.idCounters.quest = 2;
  await assert.rejects(createSnapshot(world), /行動・建築・研究/);
});

test('three additional races can be created and restored without changing the starting population', async () => {
  const world = createWorld('intervention');
  assert.deepEqual([...new Set(world.citizens.map(c => c.race))].sort(), ['dwarf', 'elf', 'human']);
  const taken = new Set(world.citizens.map(c => c.lastKnownSafeTile.y * world.map.width + c.lastKnownSafeTile.x));
  const tiles = world.map.terrain.flatMap((terrain, i) =>
    terrain === 'grass' && !taken.has(i) ? [{ x: i % world.map.width, y: Math.floor(i / world.map.width) }] : []);
  const newRaces = ['orc', 'halfling', 'fairy'];
  newRaces.forEach((race, index) => {
    assert.equal(applyGodCommand(world, command(race, 'life', tiles[index], race, 1)), null);
  });
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.deepEqual(restored.citizens.slice(-3).map(c => c.race), newRaces);
  assert.ok(restored.citizens.at(-1).traits.magicAffinity >= 0.75);
});

test('divine blessing heals living residents in range and remains idempotent across saves', async () => {
  const world = createWorld('intervention');
  const patient = world.citizens[0];
  const tile = patient.lastKnownSafeTile;
  patient.hp = 60;
  patient.fear = 30;
  const blessing = command('bless-once', 'blessing', tile, 'recovery');
  assert.equal(applyGodCommand(world, blessing), null);
  assert.equal(patient.hp, 85);
  assert.equal(patient.fear, 10);
  const event = world.events.find(e => e.sourceTransactionId === 'bless-once');
  assert.deepEqual(event.affectedCitizenIds, [patient.id]);
  assert.ok(historyFor(world, 'citizen', patient.id).includes(event));
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(applyGodCommand(restored, blessing), 'DUPLICATE');
  assert.equal(restored.citizens[0].hp, 85);
  assert.equal(applyGodCommand(restored, command('empty', 'blessing', { x: 0, y: 0 }, 'recovery')), 'NO_TARGET');
});

test('drought delays local harvests and remains idempotent after restoration', async () => {
  const world = createWorld('drought');
  const settlementId = world.settlements[0].id;
  world.map.terrain.fill('grass');
  const farm = { id: 'building:2', kind: 'farm', settlementId, x: 35, y: 35,
    width: 2, height: 2, capacity: 0, completedAt: 0 };
  const distant = { ...farm, id: 'building:3', x: 48 };
  world.buildings.push(farm, distant);
  world.idCounters.building = 4;
  const drought = command('first-drought', 'disaster', farm, 'drought');
  assert.equal(applyGodCommand(world, drought), null);
  assert.equal(farm.harvestAt, TIME_TICKS_PER_DAY);
  assert.equal(distant.harvestAt, undefined);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(restored.buildings[1].harvestAt, TIME_TICKS_PER_DAY);
  assert.equal(applyGodCommand(restored, drought), 'DUPLICATE');
  const fertility = command('first-fertility', 'blessing', farm, 'fertility');
  const storeFood = restored.stockpiles[0].total.food;
  assert.equal(applyGodCommand(restored, fertility), null);
  assert.equal(restored.buildings[1].harvestAt, restored.worldTimeTick);
  assert.equal(restored.buildings[2].harvestAt, undefined);
  assert.equal(restored.stockpiles[0].total.food, storeFood);
  const revived = await readSnapshot(JSON.stringify(await createSnapshot(restored)));
  assert.equal(applyGodCommand(revived, fertility), 'DUPLICATE');
  const { updateCitizens } = await import('../simulation/CitizenAI.js');
  const farmer = revived.citizens.find(person => person.profession === 'farmer');
  farmer.action = { kind: 'farm', phase: 'perform', targetId: farm.id, startedAt: 0, progress: 0 };
  updateCitizens(revived, 12);
  updateCitizens(revived, 12);
  const recovery = revived.events.filter(event => event.type === 'droughtHarvestRecovered');
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].causeEventId, revived.events.find(event => event.value === 'drought').id);
  assert.ok(recovery[0].quantity > 0);
  assert.equal(recovery[0].foodBeforeHarvest, storeFood);
  assert.equal(recovery[0].foodBeforeDrought, storeFood);
  assert.equal(revived.buildings[1].droughtCommandId, undefined);
  const harvests = revived.events.filter(event => event.type === 'blessedFarmHarvested');
  assert.equal(harvests.length, 1);
  assert.equal(harvests[0].causeEventId, revived.events.find(event => event.value === 'fertility').id);
  assert.equal(harvests[0].quantity, recovery[0].quantity);
  assert.deepEqual(harvests[0].actorIds, [farmer.id]);
  assert.equal(revived.buildings[1].fertilityCommandId, undefined);

  const memory = revived.settlements[0].observances[0];
  assert.equal(memory.kind, 'thanksgiving');
  assert.equal(memory.originEventId, harvests[0].id);
  // The older singleton remains readable and gains a second tradition on recovery.
  revived.settlements[0].observance = memory;
  delete revived.settlements[0].observances;
  const { rememberRecovery } = await import('../simulation/SettlementRecords.js');
  const restoredLegacy = await readSnapshot(JSON.stringify(await createSnapshot(revived)));
  const local = restoredLegacy.settlements[0];
  rememberRecovery(restoredLegacy, local, recovery[0], 'scarcity');
  assert.deepEqual(local.observances.map(item => item.kind), ['thanksgiving', 'scarcity']);
  const ready = await readSnapshot(JSON.stringify(await createSnapshot(restoredLegacy)));
  ready.worldTimeTick = memory.nextDay * TIME_TICKS_PER_DAY + 24;
  const attendee = ready.citizens.find(person => person.id === farmer.id);
  const depot = ready.stockpiles[0];
  for (const citizen of ready.citizens) citizen.decisionAt = ready.worldTimeTick + TIME_TICKS_PER_DAY;
  Object.assign(attendee, {
    profession: null, decisionAt: ready.worldTimeTick, x: depot.x + 0.5, y: depot.y + 0.5,
    lastKnownSafeTile: { x: depot.x, y: depot.y }, inventory: Object.fromEntries(Object.keys(attendee.inventory).map(key => [key, 0])),
    action: { kind: 'idle', phase: 'plan', targetId: null, startedAt: ready.worldTimeTick, progress: 0 }
  });
  updateCitizens(ready, 12);
  updateCitizens(ready, 12);
  const observances = ready.events.filter(event => event.type === 'communityObservance');
  assert.equal(observances.length, 1);
  assert.equal(ready.settlements[0].observances[1].nextDay, memory.nextDay);
  attendee.decisionAt = ready.worldTimeTick;
  updateCitizens(ready, 12);
  assert.equal(ready.events.filter(event => event.type === 'communityObservance').length, 2);
  assert.equal(observances[0].causeEventId, harvests[0].id);
  assert.deepEqual(observances[0].actorIds, [attendee.id]);
  assert.ok(ready.settlements[0].observances[0].nextDay > memory.nextDay);
});

test('favorite citizens persist in a snapshot and reference existing residents', async () => {
  const world = createWorld('favorite-save');
  world.settings.favoriteCitizenIds = [world.citizens[0].id];
  const loaded = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.deepEqual(loaded.settings.favoriteCitizenIds, world.settings.favoriteCitizenIds);
  loaded.settings.favoriteCitizenIds = ['citizen:999999'];
  await assert.rejects(createSnapshot(loaded), /注目人物/);
});

test('frost pauses wild food regeneration through save and leaves dropped food untouched', async () => {
  const { renewNodes } = await import('../simulation/Economy.js');
  const world = createWorld('frost');
  const wild = world.resourceNodes.find(node => node.resource === 'food');
  const drop = command('frost-provisions', 'resource', wild, 'food', 3);
  assert.equal(applyGodCommand(world, drop), null);
  const frost = command('first-frost', 'disaster', wild, 'frost');
  assert.equal(applyGodCommand(world, frost), null);
  assert.equal(wild.quantity, 0);
  assert.equal(wild.renewAt, TIME_TICKS_PER_DAY);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(applyGodCommand(saved, frost), 'DUPLICATE');
  const savedWild = saved.resourceNodes.find(node => node.id === wild.id);
  const dropped = saved.resourceNodes.find(node => node.dropped && node.resource === 'food');
  saved.worldTimeTick = TIME_TICKS_PER_DAY - 1;
  renewNodes(saved);
  assert.equal(savedWild.quantity, 0);
  saved.worldTimeTick++;
  renewNodes(saved);
  assert.ok(savedWild.quantity > 0);
  assert.equal(dropped.quantity, 3);
  renewNodes(saved);
  const recovery = saved.events.filter(event => event.type === 'frostRecovered');
  assert.equal(recovery.length, 1);
  assert.ok(recovery[0].affectedNodeIds.includes(savedWild.id));
  assert.equal(recovery[0].causeEventId, saved.events.find(event => event.value === 'frost').id);
});

test('frost is recorded in the history of the nation that owns the affected tile', () => {
  const world = createWorld('frost-territory');
  const wild = world.resourceNodes.find(node => node.resource === 'food');
  const settlement = world.settlements[0];
  settlement.nationId = 'nation:1';
  world.territory = { [wild.y * world.map.width + wild.x]: settlement.id };
  assert.equal(applyGodCommand(world, command('national-frost', 'disaster', wild, 'frost')), null);
  const event = historyFor(world, 'nation', settlement.nationId).find(entry => entry.value === 'frost');
  assert.ok(event?.affectedNodeIds.includes(wild.id));
  assert.equal(historyFor(world, 'nation', 'nation:2').length, 0);
});

test('a drought sends one available adventurer to gather real food and links that response after reload', async () => {
  const { GATHER_TICKS } = await import('../data/balance.js');
  const { updateCitizens } = await import('../simulation/CitizenAI.js');
  const world = createWorld('drought-forage');
  world.map.terrain.fill('grass');
  const store = world.stockpiles[0];
  store.total.food = 0;
  const farm = { id: 'building:2', kind: 'farm', settlementId: store.settlementId, x: 39, y: 39,
    width: 2, height: 2, capacity: 0, completedAt: 0 };
  world.buildings.push(farm);
  world.idCounters.building = 3;

  const actor = world.citizens.find(citizen => citizen.profession === 'adventurer');
  const node = world.resourceNodes.find(item => item.resource === 'food');
  Object.assign(node, { x: store.x + 1, y: store.y });
  actor.lastKnownSafeTile = { x: node.x, y: node.y };
  actor.x = node.x + 0.5;
  actor.y = node.y + 0.5;
  for (const citizen of world.citizens) citizen.decisionAt = citizen === actor ? 0 : TIME_TICKS_PER_DAY;
  const previousQuantity = node.quantity;
  assert.equal(applyGodCommand(world, command('drought-response', 'disaster', farm, 'drought')), null);
  updateCitizens(world, 1);
  assert.equal(actor.action.droughtForageId, 'drought-response');

  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  updateCitizens(restored, GATHER_TICKS);
  const response = restored.events.find(event => event.type === 'droughtFoodForaged');
  assert.equal(response.causeEventId, restored.events.find(event => event.value === 'drought').id);
  assert.deepEqual(response.actorIds, [actor.id]);
  assert.equal(restored.resourceNodes.find(item => item.id === node.id).quantity, previousQuantity - response.quantity);
  assert.equal(restored.citizens.find(citizen => citizen.id === actor.id).inventory.food, response.quantity);
});

test('summer drought delays an unprotected farm and its recovery establishes a local observance', async () => {
  const { TIME_TICKS_PER_YEAR } = await import('../data/balance.js');
  const { seedState } = await import('../engine/random.js');
  const { updateWeather } = await import('../simulation/Weather.js');
  const { updateCitizens } = await import('../simulation/CitizenAI.js');
  const world = createWorld('weather-observance');
  const settlement = world.settlements[0];
  world.map.terrain.fill('grass');
  const farm = { id: 'building:2', kind: 'farm', settlementId: settlement.id, x: 35, y: 35,
    width: 2, height: 2, capacity: 0, completedAt: 0 };
  const protectedFarm = { ...farm, id: 'building:3', x: 48, arcaneIrrigation: true };
  world.buildings.push(farm, protectedFarm);
  world.idCounters.building = 4;
  let year = 1;
  while (seedState(JSON.stringify([world.seed, year, 'summer-drought']))[0] % 3 !== 0) year++;
  world.worldTimeTick = year * TIME_TICKS_PER_YEAR + 18 * TIME_TICKS_PER_DAY;

  updateWeather(world);
  updateWeather(world);
  const droughts = world.events.filter(event => event.type === 'seasonalDrought');
  assert.equal(droughts.length, 1);
  assert.ok(farm.harvestAt > world.worldTimeTick);
  assert.equal(protectedFarm.harvestAt, undefined);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = farm.harvestAt + 24;
  const farmer = restored.citizens.find(citizen => citizen.profession === 'farmer');
  farmer.action = { kind: 'farm', phase: 'perform', targetId: farm.id, startedAt: 0, progress: 0 };
  updateCitizens(restored, 12);
  const recovery = restored.events.find(event => event.type === 'droughtHarvestRecovered');
  assert.equal(recovery.causeEventId, droughts[0].id);
  assert.equal(restored.settlements[0].observances[0].originEventId, recovery.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
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

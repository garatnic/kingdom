import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { startExpedition, updateNations, relationLabel, territoryAt } from '../simulation/Nations.js';
import { nextId } from '../simulation/Identity.js';
import { getResearch, updateResearch } from '../simulation/Research.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';

test('a first nation establishes itself and transfers all four technologies to one owner', () => {
  const world = createWorld('world-tree');
  setSpeed(world, 20);
  for (let i = 0; i < 600; i++) advanceFrame(world, 100);
  assert.equal(world.nations.length, 1);
  const [nation] = world.nations;
  assert.ok(world.citizens.every(c => c.nationId === nation.id));
  assert.equal(world.researchStates.length, 1);
  const state = getResearch(world, nation);
  assert.deepEqual(new Set(state.unlockedIds), new Set(['farming_1', 'building_1', 'weapons_1', 'magic_1']));
  assert.ok(world.citizens.some(c => c.skills.magic >= 1 && c.mp >= 0));
  assert.equal(world.events.filter(e => e.type === 'founding').length, 1);
  assert.equal(state.civilization, 'agrarian');
});

test('an expedition moves four existing citizens and provisions, then permits a second nation', async () => {
  const world = createWorld('world-tree');
  setSpeed(world, 20);
  for (let i = 0; i < 600; i++) advanceFrame(world, 100);
  const before = { ...world.stockpiles[0].total };
  const ids = world.citizens.map(c => c.id);
  const expedition = startExpedition(world, world.nations[0]);
  assert.ok(expedition);
  const source = world.settlements[0];
  const distance = Math.abs(expedition.x - source.x) + Math.abs(expedition.y - source.y);
  assert.ok(distance >= 46 && distance <= 54);
  const settlers = world.citizens.filter(c => c.expeditionId === expedition.id);
  for (const role of new Set(settlers.map(c => c.profession))) {
    assert.ok(world.citizens.some(c => c.settlementId === source.id && c.profession === role));
  }
  assert.equal(world.citizens.filter(c => c.expeditionId === expedition.id).length, 4);
  assert.equal(world.citizens.filter(c => c.nationId).length, 8);
  for (const [key, quantity] of Object.entries(expedition.supplies)) {
    assert.equal(world.stockpiles[0].total[key] + quantity, before[key]);
  }
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
  for (let i = 0; i < 100 && expedition.status === 'travel'; i++) advanceFrame(world, 100);
  assert.equal(expedition.status, 'settled');
  assert.deepEqual(world.citizens.map(c => c.id), ids);
  const second = world.settlements[1];
  const team = world.citizens.filter(c => c.settlementId === second.id);
  for (const c of team) {
    const citizen = structuredClone(c);
    Object.assign(citizen, { id: nextId(world, 'citizen'), partnerId: null, relationships: {},
      parentIds: [], childIds: [] });
    delete citizen.nextBirthCheckTick;
    world.citizens.push(citizen);
  }
  while (world.buildings.filter(b => b.kind === 'house' && b.settlementId === second.id).length < 2) {
    const grass = world.map.frontier;
    const count = world.buildings.filter(b => b.kind === 'house' && b.settlementId === second.id).length;
    world.buildings.push({ id: nextId(world, 'building'), settlementId: second.id, kind: 'house',
      capacity: 4, x: grass.x + 1 + count, y: grass.y + 2 });
  }
  world.stockpiles[1].total.food = 24;
  for (let day = 4; day <= 6; day++) {
    world.worldTimeTick = Math.ceil(second.createdAt / TIME_TICKS_PER_DAY) * TIME_TICKS_PER_DAY + day * TIME_TICKS_PER_DAY;
    updateNations(world, 12);
  }
  assert.equal(world.nations.length, 2);
  const [first, other] = world.nations;
  assert.equal(relationLabel(first.relations[other.id]), 'neutral');
  assert.equal(territoryAt(world, second), other.id);
  assert.notEqual(getResearch(world, first).id, getResearch(world, other).id);
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

test('research tests usable iron rather than reserved inventory', () => {
  const world = createWorld('reserved-iron');
  const [store] = world.stockpiles;
  world.buildings.push({ id: nextId(world, 'building'), kind: 'smithy', settlementId: world.settlements[0].id });
  store.total.iron = 2;
  store.reserved.iron = 2;
  for (let hour = 1; hour <= 200; hour++) {
    world.worldTimeTick = hour * 600;
    updateResearch(world, 12);
  }
  const state = world.researchStates[0];
  assert.ok(!state.unlockedIds.includes('weapons_1'));
  store.reserved.iron = 0;
  world.worldTimeTick += 600;
  updateResearch(world, 12);
  assert.ok(state.unlockedIds.includes('weapons_1'));
  assert.equal(store.total.iron, 2);
});

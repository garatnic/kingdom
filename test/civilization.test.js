import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { civilizationProgress, ensureResearch, updateResearch } from '../simulation/Research.js';
import { nextId } from '../simulation/Identity.js';
import { NEED_HOUR_TICKS, TIME_TICKS_PER_DAY } from '../data/balance.js';

test('civilization advances per nation, resets interrupted streaks and unlocks later research', () => {
  const world = createWorld('civilization');
  const home = world.settlements[0];
  const first = { id: nextId(world, 'nation') };
  const second = { id: nextId(world, 'nation') };
  const other = { ...home, id: nextId(world, 'settlement'), nationId: second.id };
  home.nationId = first.id;
  world.nations.push(first, second);
  world.settlements.push(other);
  const store = world.stockpiles[0];
  store.total.iron = 4;
  store.total.stone = 12;
  store.total.food = 48;
  store.total.manaStone = 3;
  world.stockpiles.push({ ...structuredClone(store), id: nextId(world, 'stockpile'), settlementId: other.id });
  world.citizens[0].traits.magicAffinity = 1;
  const residents = world.citizens.slice();
  for (let i = 0; i < 20; i++) {
    const citizen = structuredClone(residents[i % residents.length]);
    citizen.id = nextId(world, 'citizen');
    citizen.settlementId = i < 4 ? home.id : other.id;
    world.citizens.push(citizen);
  }
  for (const kind of ['smithy', 'farm', 'guild', 'warehouse']) world.buildings.push({ kind, settlementId: home.id });
  const basic = ['farming_1', 'building_1', 'weapons_1', 'magic_1'];
  const state = ensureResearch(world, first, basic);
  const otherState = ensureResearch(world, second, basic);
  state.civilization = otherState.civilization = 'agrarian';
  state.knowledgePoints = 9000;
  const advance = days => {
    for (let i = 0; i < days; i++) {
      world.worldTimeTick += TIME_TICKS_PER_DAY;
      updateResearch(world, 12);
    }
  };
  advance(9);
  assert.equal(state.civilization, 'agrarian');
  assert.deepEqual(civilizationProgress(world, first, state), { target: 'iron', days: 9, neededDays: 10, unmet: [] });
  store.reserved.iron = 4;
  assert.deepEqual(civilizationProgress(world, first, state).unmet,
    [{ kind: 'resource', id: 'iron', current: 0, needed: 2 }]);
  advance(1);
  assert.equal(state.civilizationDays, 0);
  store.reserved.iron = 0;
  advance(10);
  assert.equal(state.civilization, 'iron');
  advance(12);
  assert.equal(state.civilization, 'kingdom');
  advance(20);
  assert.equal(state.civilization, 'arcane');
  assert.equal(otherState.civilization, 'agrarian');
  store.total.food = 60;
  store.total.manaStone = 5;
  for (const citizen of world.citizens.filter(c => c.settlementId === other.id).slice(0, 4)) citizen.settlementId = home.id;
  world.buildings.push(...Array.from({ length: 2 }, () => ({ kind: 'farm', settlementId: home.id })));
  advance(29);
  assert.equal(state.civilization, 'arcane');
  advance(1);
  assert.equal(state.civilization, 'mythic');
  assert.ok(state.unlockedIds.includes('verdant_1'));
  assert.ok(!otherState.unlockedIds.includes('verdant_1'));
  assert.deepEqual(world.events.filter(e => e.type === 'civilizationAdvanced').map(e => e.civilization),
    ['iron', 'kingdom', 'arcane', 'mythic']);
  for (const technology of ['steel_1', 'irrigation_1', 'magic_2']) assert.ok(state.unlockedIds.includes(technology));
});

test('restoration research heals a resting resident and spends MP once per game hour', () => {
  const world = createWorld('restoration');
  const state = ensureResearch(world, world.settlements[0]);
  state.unlockedIds.push('magic_1');
  const patient = world.citizens[0];
  patient.traits.magicAffinity = 1;
  patient.action = { kind: 'sleep', phase: 'perform' };
  patient.hp = 45;
  patient.mp = 5;
  world.worldTimeTick = NEED_HOUR_TICKS;
  updateResearch(world, 1);
  assert.equal(patient.hp, 45);
  state.unlockedIds.push('restoration_1');
  world.worldTimeTick += NEED_HOUR_TICKS;
  updateResearch(world, 1);
  assert.equal(patient.hp, 57);
  assert.equal(patient.mp, 5);
  world.worldTimeTick++;
  updateResearch(world, 1);
  assert.equal(patient.hp, 57);
  patient.action.phase = 'travel';
  world.worldTimeTick = NEED_HOUR_TICKS * 3;
  updateResearch(world, 1);
  assert.equal(patient.hp, 57);
});

test('restoration can treat a nearby resting neighbor once per hour', () => {
  const world = createWorld('care');
  ensureResearch(world, world.settlements[0], ['magic_1', 'restoration_1']);
  const [first, second, patient, distant] = world.citizens;
  for (const citizen of [first, second, patient, distant]) {
    citizen.action = { kind: 'sleep', phase: 'perform' };
    citizen.lastKnownSafeTile = { x: 32, y: 32 };
  }
  first.traits.magicAffinity = second.traits.magicAffinity = 1;
  patient.traits.magicAffinity = distant.traits.magicAffinity = 0;
  distant.lastKnownSafeTile = { x: 38, y: 38 };
  patient.hp = distant.hp = 30;
  world.worldTimeTick = NEED_HOUR_TICKS;
  updateResearch(world, 12);
  assert.equal(patient.hp, 42);
  assert.equal(distant.hp, 30);
  assert.equal(first.mp, 20);
  assert.equal(second.mp, 30);
});

test('steel industry equips miners after research and improves both mining paths across saves', async () => {
  const { produceMiningTools } = await import('../simulation/Industry.js');
  const { gatherForStore, harvest } = await import('../simulation/Economy.js');
  const { createSnapshot, readSnapshot } = await import('../systems/SaveManager.js');
  const world = createWorld('steel-industry');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const miner = world.citizens.find(c => c.profession === 'miner');
  assert.ok(miner);
  world.map.terrain.fill('grass');
  const state = ensureResearch(world, home);
  const capacity = store.capacity;
  store.capacity += 20;
  store.total.iron = 5;
  produceMiningTools(world);
  assert.equal(miner.steelMiningTools, undefined);

  const smithy = { id: nextId(world, 'building'), kind: 'smithy', settlementId: home.id,
    x: 1, y: 1, width: 2, height: 2, completedAt: 0 };
  world.buildings.push(smithy);
  produceMiningTools(world);
  assert.equal(store.total.iron, 5);
  state.unlockedIds.push('steel_1');
  store.reserved.iron = 2;
  produceMiningTools(world);
  assert.equal(miner.steelMiningTools, undefined);
  assert.equal(store.total.iron, 5);

  store.reserved.iron = 0;
  produceMiningTools(world);
  assert.equal(miner.steelMiningTools, true);
  assert.equal(store.total.iron, 3);

  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const savedMiner = restored.citizens.find(c => c.id === miner.id);
  const savedStore = restored.stockpiles[0];
  produceMiningTools(restored);
  assert.equal(savedStore.total.iron, 3);
  assert.equal(restored.events.filter(e => e.type === 'miningToolsForged').length, 1);

  const ore = { ...savedMiner.lastKnownSafeTile, quantity: 6, resource: 'iron' };
  assert.equal(harvest(restored, savedMiner, ore), true);
  assert.equal(savedMiner.inventory.iron, 3);
  assert.equal(gatherForStore(restored, ore, savedStore, 0, savedMiner), true);
  assert.equal(savedStore.total.iron, 6);
  assert.equal(ore.quantity, 0);
  assert.equal(savedStore.capacity, capacity + 20);
});

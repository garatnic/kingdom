import { commissionGear, trainCombat } from '../simulation/AdventurerGrowth.js';
import { ensureResearch } from '../simulation/Research.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { claimAdventure, continueAdventure, issueQuest, spawnMonster } from '../simulation/Adventure.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';

test('adventurers depart, defeat monsters, collect drops and return across three seeds', async () => {
  for (const seed of ['world-tree', '障害地形', '0']) {
    const world = createWorld(seed);
    setSpeed(world, 20);
    for (let i = 0; i < 300; i++) advanceFrame(world, 100);
    const completed = world.quests.filter(q => q.status === 'completed' && q.lootIds.length > 0);
    assert.ok(completed.length, seed);
    for (const q of completed) {
      const phases = ['adventureDeparted', 'monsterDefeated', 'adventureReturned'];
      const events = world.events.filter(e => e.questId === q.id && phases.includes(e.type));
      assert.deepEqual(events.map(e => e.type), ['adventureDeparted', 'monsterDefeated', 'adventureReturned']);
      assert.ok(q.lootIds.every(id => world.resourceNodes.find(n => n.id === id)?.quantity === 0));
    }
    assert.ok(world.citizens.some(c => c.adventuresCompleted > 0));
    assert.ok(world.events.some(e => e.type === 'adventurerRankUp'));
    const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
    advanceFrame(world, 100);
    advanceFrame(restored, 100);
    assert.deepEqual(restored, world);
  }
});

test('one quest cannot be claimed twice and windup/cooldown apply one hit', () => {
  const world = createWorld('combat');
  const [store] = world.stockpiles;
  const citizen = world.citizens.find(c => c.profession === 'adventurer');
  const tile = { x: store.x, y: store.y };
  citizen.lastKnownSafeTile = tile;
  const monster = spawnMonster(world, 'slime', { x: store.x - 1, y: store.y });
  assert.ok(monster);
  const quest = issueQuest(world, world.settlements[0], monster);
  const travel = () => true;
  assert.ok(claimAdventure(world, citizen, store, travel));
  const another = world.citizens.filter(c => c.profession === 'adventurer')[1];
  assert.equal(claimAdventure(world, another, store, travel), false);
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(monster.hp, 30);
  world.worldTimeTick = quest.strikeAt;
  continueAdventure(world, citizen, quest, store, tile, travel);
  const after = monster.hp;
  assert.ok(after < 30);
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(monster.hp, after);
});

test('magic requires research, resolves after casting and consumes MP once', async () => {
  const { ensureResearch } = await import('../simulation/Research.js');
  const world = createWorld('magic');
  const [store] = world.stockpiles;
  const citizen = world.citizens.find(c => c.profession === 'adventurer');
  const tile = { x: store.x, y: store.y };
  citizen.lastKnownSafeTile = tile;
  citizen.skills.magic = 1;
  citizen.mp = 30;
  const monster = spawnMonster(world, 'slime', { x: store.x - 1, y: store.y });
  const quest = issueQuest(world, world.settlements[0], monster);
  const travel = () => true;
  claimAdventure(world, citizen, store, travel);
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(quest.casting, false);
  assert.equal(citizen.mp, 30);
  ensureResearch(world, world.settlements[0]).unlockedIds.push('magic_1');
  quest.strikeAt = null;
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(quest.casting, true);
  world.worldTimeTick = quest.strikeAt;
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(citizen.mp, 20);
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(citizen.mp, 20);
});

test('fear and low HP trigger retreat without a strike or reward', () => {
  const world = createWorld('retreat');
  const [store] = world.stockpiles;
  const citizen = world.citizens.find(c => c.profession === 'adventurer');
  const tile = { x: store.x, y: store.y };
  citizen.lastKnownSafeTile = tile;
  const monster = spawnMonster(world, 'slime', { x: store.x - 1, y: store.y });
  const quest = issueQuest(world, world.settlements[0], monster);
  const travel = () => true;
  assert.ok(claimAdventure(world, citizen, store, travel));
  citizen.hp = 15;
  citizen.fear = 85;
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(quest.status, 'retreated');
  assert.equal(monster.hp, 30);
  assert.equal(citizen.inventory.food, 0);
  assert.equal(world.events.at(-1).retreated, true);
});


test('combat experience can advance multiple levels and forged gear uses available stock once', () => {
  const world = createWorld('equipment');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const citizen = world.citizens.find(c => c.profession === 'adventurer');
  trainCombat(world, citizen, { id: 'quest:1' }, 65);
  assert.equal(citizen.skills.combat, 2);
  assert.equal(citizen.combatXp, 5);
  world.buildings.push({ kind: 'smithy', settlementId: home.id });
  ensureResearch(world, home, ['weapons_1']);
  store.total.iron = 4;
  store.reserved.iron = 3;
  commissionGear(world, citizen, store);
  assert.equal(citizen.gearId, undefined);
  store.reserved.iron = 1;
  commissionGear(world, citizen, store);
  commissionGear(world, citizen, store);
  assert.equal(citizen.gearId, 'iron');
  assert.equal(store.total.iron, 2);
  assert.equal(store.reserved.iron, 1);
});

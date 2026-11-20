import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { issueQuest, spawnMonster, updateAdventureWorld } from '../simulation/Adventure.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';

test('a colony reproduces in suitable terrain without ignoring local limits or cooldown', () => {
  const world = createWorld('habitat');
  world.map.terrain.fill('forest');
  const parent = spawnMonster(world, 'slime', { x: 8, y: 8 });
  parent.moveAt = Number.MAX_SAFE_INTEGER;
  world.nextMonsterSpawnTick = 100;
  world.worldTimeTick = 100;
  updateAdventureWorld(world, 12);
  const offspring = world.monsters.find(m => m.parentMonsterId === parent.id);
  assert.ok(offspring);
  assert.ok(Math.abs(offspring.x - 8) <= 2 && Math.abs(offspring.y - 8) <= 2);
  assert.equal(parent.nextBreedAt, 100 + TIME_TICKS_PER_DAY);
  world.worldTimeTick = world.nextMonsterSpawnTick;
  updateAdventureWorld(world, 12);
  assert.equal(world.monsters.filter(m => m.parentMonsterId === parent.id).length, 1);
});

test('wisps immigrate after expansion and inhabit forest beyond the initial map', () => {
  const world = createWorld('ecology');
  world.map.terrain.fill('forest');
  for (let i = 0; i < 8; i++) spawnMonster(world, 'slime', { x: i + 3, y: 7 });
  for (let i = 0; i < 4; i++) spawnMonster(world, 'goblin', { x: i + 3, y: 9 });
  world.worldTimeTick = world.nextMonsterSpawnTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  assert.ok(!world.monsters.some(m => m.species === 'wisp'));
  discoverFrontier(world, { x: 63, y: 20 }, 'east', world.citizens[0].id);
  for (let y = 2; y < 12; y++) {
    for (let x = 70; x < 80; x++) world.map.terrain[y * world.map.width + x] = 'forest';
  }
  world.worldTimeTick = world.nextMonsterSpawnTick;
  updateAdventureWorld(world, 12);
  const wisp = world.monsters.find(m => m.species === 'wisp');
  assert.ok(wisp);
  assert.ok(wisp.homeTile.x >= 64);
  assert.equal(world.map.terrain[wisp.homeTile.y * world.map.width + wisp.homeTile.x], 'forest');
});

test('wisps prey on adjacent slimes and close unresolved bounties without awarding loot', () => {
  const world = createWorld('predation');
  world.map.terrain.fill('forest');
  world.nextMonsterSpawnTick = Number.MAX_SAFE_INTEGER;
  const slime = spawnMonster(world, 'slime', { x: 8, y: 8 });
  const wisp = spawnMonster(world, 'wisp', { x: 8, y: 9 });
  slime.moveAt = wisp.moveAt = Number.MAX_SAFE_INTEGER;
  const quest = issueQuest(world, world.settlements[0], slime);
  quest.expiresAt = 4 * TIME_TICKS_PER_DAY;
  const resourceCount = world.resourceNodes.length;
  for (let day = 1; day <= 3; day++) {
    world.worldTimeTick = day * TIME_TICKS_PER_DAY;
    updateAdventureWorld(world, 12);
  }
  assert.equal(slime.alive, false);
  assert.equal(quest.status, 'expired');
  assert.equal(world.resourceNodes.length, resourceCount);
  assert.equal(world.events.find(e => e.type === 'monsterPredation').predatorId, wisp.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { issueQuest, offerTradeEscort, spawnMonster, updateAdventureWorld } from '../simulation/Adventure.js';
import { applyGodCommand } from '../systems/GodPowers.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
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
  assert.deepEqual(offspring.homeTile, parent.homeTile);
  assert.equal(offspring.hasNest, true);
  assert.equal(world.events.filter(e => e.type === 'monsterNestFounded').length, 1);
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
  const prey = world.monsters.find(m => m.species === 'slime');
  Object.assign(prey, { x: 73, y: 8, homeTile: { x: 73, y: 8 }, moveAt: Number.MAX_SAFE_INTEGER });
  world.worldTimeTick = world.nextMonsterSpawnTick;
  updateAdventureWorld(world, 12);
  const wisp = world.monsters.find(m => m.species === 'wisp');
  assert.ok(wisp);
  assert.ok(wisp.homeTile.x >= 64);
  assert.ok(Math.abs(wisp.x - prey.x) + Math.abs(wisp.y - prey.y) <= 7);
  assert.equal(world.map.terrain[wisp.homeTile.y * world.map.width + wisp.homeTile.x], 'forest');
});

test('wisps prey on adjacent slimes and close unresolved bounties without awarding loot', () => {
  const world = createWorld('predation');
  world.map.terrain.fill('forest');
  world.nextMonsterSpawnTick = Number.MAX_SAFE_INTEGER;
  const slime = spawnMonster(world, 'slime', { x: 8, y: 8 });
  const wisp = spawnMonster(world, 'wisp', { x: 8, y: 10 });
  slime.moveAt = Number.MAX_SAFE_INTEGER;
  world.worldTimeTick = wisp.moveAt;
  updateAdventureWorld(world, 12);
  assert.equal(wisp.y, 9);
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


test('a dangerous monster near a settlement is recorded once per day', () => {
  const world = createWorld('threat');
  const [home] = world.settlements;
  world.map.terrain.fill('grass');
  world.nextMonsterSpawnTick = Number.MAX_SAFE_INTEGER;
  const goblin = spawnMonster(world, 'goblin', { x: home.x + 7, y: home.y });
  goblin.moveAt = Number.MAX_SAFE_INTEGER;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  updateAdventureWorld(world, 12);
  const threats = world.events.filter(event => event.type === 'monsterThreat');
  assert.equal(threats.length, 1);
  assert.equal(threats[0].settlementId, home.id);
  assert.equal(threats[0].monsterId, goblin.id);
});

test('a new colony at a cleared site is recorded as a separate founding', () => {
  const world = createWorld('recolonization');
  world.map.terrain.fill('forest');
  const site = { x: 8, y: 8 };
  for (let generation = 0; generation < 2; generation++) {
    const parent = spawnMonster(world, 'slime', site);
    assert.ok(parent);
    parent.moveAt = Number.MAX_SAFE_INTEGER;
    world.worldTimeTick = world.nextMonsterSpawnTick = (generation + 1) * TIME_TICKS_PER_DAY;
    updateAdventureWorld(world, 12);
    const colony = world.monsters.filter(m => m.alive && m.species === 'slime' &&
      m.homeTile.x === site.x && m.homeTile.y === site.y);
    assert.equal(colony.length, 2);
    for (const member of colony) Object.assign(member, { alive: false, hp: 0, diedAt: world.worldTimeTick });
  }
  assert.equal(world.events.filter(e => e.type === 'monsterNestFounded' &&
    e.species === 'slime' && e.x === site.x && e.y === site.y).length, 2);
});

test('goblins can establish a second habitat near an inhabited settlement', () => {
  const world = createWorld('goblin-dispersal');
  const [home] = world.settlements;
  const { terrain, width } = world.map;
  terrain.fill('forest');
  for (let i = 0; i < 8; i++) spawnMonster(world, 'slime', { x: i + 3, y: 7 });
  const original = spawnMonster(world, 'goblin', { x: 3, y: 3 });
  assert.ok(original);
  world.worldTimeTick = world.nextMonsterSpawnTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  const immigrant = world.monsters.find(m => m.species === 'goblin' && m.id !== original.id);
  assert.ok(immigrant);
  const distance = Math.abs(immigrant.homeTile.x - home.x) + Math.abs(immigrant.homeTile.y - home.y);
  assert.ok(distance >= 10 && distance <= 24);
  assert.equal(terrain[immigrant.homeTile.y * width + immigrant.homeTile.x], 'forest');
  assert.equal(immigrant.parentMonsterId, undefined);
});

test('a terrain edit displaces a nest after a claimed raid ends and the colony moves after reload', async () => {
  const world = createWorld('displaced-nest');
  world.map.terrain.fill('forest');
  const leader = spawnMonster(world, 'slime', { x: 8, y: 8 });
  const offspring = spawnMonster(world, 'slime', { x: 8, y: 9 });
  offspring.homeTile = { ...leader.homeTile };
  leader.hasNest = offspring.hasNest = true;
  const raid = issueQuest(world, world.settlements[0], leader);
  const adventurer = world.citizens[0];
  raid.status = 'claimed';
  raid.claimedBy = adventurer.id;
  raid.stage = 'fight';
  raid.expiresAt = 5 * TIME_TICKS_PER_DAY;
  assert.equal(applyGodCommand(world, {
    commandId: 'change-habitat', kind: 'terrain', payload: { x: 8, y: 8, value: 'mountain' }
  }), null);

  world.nextMonsterSpawnTick = 5 * TIME_TICKS_PER_DAY;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  assert.deepEqual(leader.homeTile, { x: 8, y: 8 });

  raid.status = 'open';
  raid.claimedBy = null;
  world.worldTimeTick += TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  assert.equal(raid.status, 'expired');
  assert.notDeepEqual(leader.homeTile, { x: 8, y: 8 });
  assert.deepEqual(leader.homeTile, offspring.homeTile);
  assert.equal(leader.relocating, true);
  assert.equal(world.events.filter(event => event.type === 'monsterNestRelocated').length, 1);

  const snapshot = await createSnapshot(world);
  const restored = await readSnapshot(JSON.stringify(snapshot));
  const restoredLeader = restored.monsters.find(monster => monster.id === leader.id);
  for (let step = 0; step < 20; step++) {
    restored.worldTimeTick += 125;
    updateAdventureWorld(restored, 125);
    if (!restoredLeader.relocating) break;
  }
  assert.equal(restoredLeader.relocating, undefined);
  assert.equal(restored.events.filter(event => event.type === 'monsterNestRelocated').length, 1);
});

test('a predator colony relocates toward reachable prey and records why it moved', () => {
  const world = createWorld('prey-distribution');
  world.map.terrain.fill('forest');
  const wisp = spawnMonster(world, 'wisp', { x: 8, y: 8 });
  const prey = spawnMonster(world, 'slime', { x: 19, y: 8 });
  wisp.hasNest = true;
  world.nextMonsterSpawnTick = TIME_TICKS_PER_DAY * 2;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  assert.equal(world.events.find(event => event.type === 'monsterNestRelocated')?.reason, 'prey');
  assert.ok(Math.abs(wisp.homeTile.x - prey.x) + Math.abs(wisp.homeTile.y - prey.y) <= 7);
  assert.equal(wisp.relocating, true);
});

test('a new settlement can displace a nest and the colony can leave the inner safety zone', () => {
  const world = createWorld('frontier-encroachment');
  world.map.terrain.fill('forest');
  const settlement = world.settlements[0];
  const origin = { x: settlement.x - 3, y: settlement.y };
  const goblin = spawnMonster(world, 'goblin', origin);
  if (!goblin) throw new Error('expected an open nest tile');
  goblin.hasNest = true;
  world.nextMonsterSpawnTick = TIME_TICKS_PER_DAY * 2;
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 12);
  assert.equal(world.events.find(event => event.type === 'monsterNestRelocated')?.reason, 'settlement');
  for (let step = 0; step < 20 && goblin.relocating; step++) {
    world.worldTimeTick += 125;
    updateAdventureWorld(world, 125);
  }
  assert.equal(goblin.relocating, undefined);
  assert.ok(Math.abs(goblin.x - settlement.x) + Math.abs(goblin.y - settlement.y) >= 9);
});

test('an occupied trade road can call for escorts before a dangerous colony reaches its new nest', () => {
  const world = createWorld('relocation-road-risk');
  world.map.terrain.fill('forest');
  const home = world.settlements[0];
  const partner = { ...home, id: 'settlement:2', x: 25, y: 12 };
  world.buildings.push({ kind: 'guild', settlementId: home.id });
  for (const resident of world.citizens.slice(0, 2)) resident.profession = 'adventurer';
  const goblin = spawnMonster(world, 'goblin', { x: 12, y: 2 });
  const road = Array.from({ length: 20 }, (_, index) => ({ x: 6 + index, y: 12 }));
  goblin.homeTile = { x: 12, y: 9 };
  assert.equal(offerTradeEscort(world, home, partner, partner, road), undefined);
  goblin.relocating = true;
  const survey = { id: 'quest:80', kind: 'survey_resources', status: 'open', settlementId: home.id };
  const raid = { id: 'quest:81', kind: 'clear_nest', status: 'claimed', settlementId: home.id };
  world.quests.push(survey, raid);
  assert.equal(offerTradeEscort(world, home, partner, partner, road), undefined);
  world.events.push({ id: 'event:99', type: 'monsterNestRelocated', monsterIds: [goblin.id], fromX: 12, fromY: 2, worldTimeTick: 0, ...goblin.homeTile });
  const id = offerTradeEscort(world, home, partner, partner, road);
  assert.equal(world.quests.find(quest => quest.id === id)?.kind, 'escort_trade');
  const request = world.events.find(event => event.type === 'tradeEscortRequested');
  assert.equal(request.questId, id);
  assert.deepEqual(world.quests.find(quest => quest.id === id).escortWaypoint, { x: request.x, y: request.y });
  assert.equal(request.causeEventId, 'event:99');
  assert.equal(survey.status, 'expired');
  assert.equal(raid.status, 'claimed');

  world.quests.find(quest => quest.id === id).status = 'completed';
  goblin.relocating = false;
  Object.assign(goblin, goblin.homeTile);
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  const afterArrival = offerTradeEscort(world, home, partner, partner, road);
  assert.equal(world.events.find(event => event.questId === afterArrival)?.causeEventId, 'event:99');

  world.worldTimeTick = 3 * TIME_TICKS_PER_DAY;
  world.quests.find(quest => quest.id === afterArrival).status = 'completed';
  const later = offerTradeEscort(world, home, partner, partner, road);
  assert.ok(later);
  assert.equal(world.events.find(event => event.questId === later)?.causeEventId, undefined);
});

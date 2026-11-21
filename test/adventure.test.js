import { TIME_TICKS_PER_DAY } from '../data/balance.js';
import { nextId } from '../simulation/Identity.js';
import { commissionGear, trainCombat } from '../simulation/AdventurerGrowth.js';
import { ensureResearch } from '../simulation/Research.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { claimAdventure, continueAdventure, issueQuest, spawnMonster, updateAdventureWorld, isQuestCargo } from '../simulation/Adventure.js';
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
      assert.equal(events[0].type, 'adventureDeparted');
      assert.equal(events.at(-1).type, 'adventureReturned');
      const defeats = events.slice(1, -1);
      assert.ok(defeats.length >= 1 && defeats.every(e => e.type === 'monsterDefeated'));
      if (q.kind !== 'clear_nest') assert.equal(defeats.length, 1);
      else assert.ok(world.events.some(e => e.questId === q.id && e.type === 'monsterNestCleared'));
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

test('a nest expedition shares combat, clears all nest members, and restores mid-quest', async () => {
  const world = createWorld('raid');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  world.map.terrain.fill('grass');
  const leader = world.citizens.find(c => c.profession === 'adventurer');
  const origin = { x: store.x, y: store.y };
  const first = spawnMonster(world, 'slime', { x: origin.x + 1, y: origin.y });
  const second = spawnMonster(world, 'slime', { x: origin.x, y: origin.y - 1 });
  first.hasNest = second.hasNest = true;
  second.homeTile = { ...first.homeTile };
  for (const person of world.citizens) person.lastKnownSafeTile = { ...origin };
  const quest = issueQuest(world, home, first);
  assert.equal(quest.kind, 'clear_nest');
  assert.equal(issueQuest(world, home, second), null);
  const travel = () => true;
  for (const person of world.citizens) {
    if (person !== leader && person.profession === 'adventurer') person.profession = 'farmer';
  }
  const provisions = store.total.food;
  assert.equal(claimAdventure(world, leader, store, () => assert.fail('Raid must wait for an escort')), false);
  assert.equal(store.total.food, provisions);
  world.citizens.find(c => c !== leader).profession = 'adventurer';
  assert.ok(claimAdventure(world, leader, store, travel));
  const escort = world.citizens.find(c => c.id === quest.escortId);
  assert.ok(escort);
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);

  const move = citizen => tile => {
    citizen.lastKnownSafeTile = { x: tile.x, y: tile.y };
    return true;
  };
  for (let i = 0; i < 50 && quest.status === 'claimed'; i++) {
    world.worldTimeTick += 20;
    continueAdventure(world, escort, quest, store, origin, move(escort));
    continueAdventure(world, leader, quest, store, origin, move(leader));
  }
  assert.equal(quest.status, 'completed');
  assert.equal(first.alive, false);
  assert.equal(second.alive, false);
  assert.equal(escort.adventuresCompleted, 1);
  assert.equal(world.events.filter(e => e.type === 'monsterNestCleared').length, 1);
});

test('a traveling adventurer eats the quest ration once when hunger rises', async () => {
  const { updateCitizens } = await import('../simulation/CitizenAI.js');
  const world = createWorld('rations');
  const [settlement] = world.settlements;
  const [store] = world.stockpiles;
  const adventurer = world.citizens.find(c => c.profession === 'adventurer');
  const tile = { x: settlement.x + 4, y: settlement.y };
  world.map.terrain[tile.y * world.map.width + tile.x] = 'grass';
  const target = spawnMonster(world, 'slime', tile);
  const quest = issueQuest(world, settlement, target);
  const food = store.total.food;
  assert.ok(claimAdventure(world, adventurer, store, () => true));
  assert.equal(adventurer.inventory.food, 1);
  assert.equal(store.total.food, food - 1);
  adventurer.hunger = 79;
  adventurer.decisionAt = 2400;
  world.worldTimeTick = 600;
  updateCitizens(world, 12);
  assert.equal(quest.provision, 0);
  assert.equal(adventurer.inventory.food, 0);
  assert.equal(adventurer.hunger, 42);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = 1200;
  updateCitizens(restored, 12);
  assert.equal(restored.citizens.find(c => c.id === adventurer.id).hunger, 45);
});


test('a guild can send a second adventurer to hunt a dangerous roaming monster', () => {
  const world = createWorld('guild-hunt');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const leader = world.citizens.find(c => c.profession === 'adventurer');
  const escort = world.citizens.find(c => c !== leader);
  escort.profession = 'adventurer';
  const tile = { x: store.x + 1, y: store.y };
  world.map.terrain.fill('grass');
  const monster = spawnMonster(world, 'goblin', tile);
  world.buildings.push({ id: 'building:2', kind: 'guild', x: home.x + 5, y: home.y, settlementId: home.id });
  const quest = issueQuest(world, home, monster);
  assert.equal(quest.kind, 'clear_monsters');
  const food = store.total.food;
  assert.ok(claimAdventure(world, leader, store, () => true));
  assert.equal(quest.escortId, escort.id);
  assert.equal(store.total.food, food - 2);
  assert.ok(world.events.some(e => e.type === 'cooperativeExpedition'));
});


test('guild partners recover abandoned cargo once across save and reload', async () => {
  const world = createWorld('supply-recovery');
  world.map.terrain.fill('grass');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const lead = world.citizens.find(c => c.profession === 'adventurer');
  world.citizens.find(c => c !== lead).profession = 'adventurer';
  world.buildings.push({ id: 'building:2', kind: 'guild', x: home.x + 5, y: home.y, settlementId: home.id });
  world.idCounters.building = 3;
  const node = { id: 'node:' + world.idCounters.node++, resource: 'wood', quantity: 4, x: store.x + 10, y: store.y, dropped: true };
  world.resourceNodes.push(node);
  const famine = structuredClone(world);
  famine.settlements[0].foodWarning = true;
  const food = { ...node, id: 'node:' + famine.idCounters.node++, resource: 'food', x: node.x + 5 };
  famine.resourceNodes.push(food);
  updateAdventureWorld(famine, 12);
  assert.equal(famine.quests.find(q => q.kind === 'recover_supplies')?.targetId, food.id);
  updateAdventureWorld(world, 12);
  const recovery = world.quests.find(q => q.kind === 'recover_supplies');
  assert.ok(recovery);
  assert.ok(claimAdventure(world, lead, store, () => true));
  assert.ok(isQuestCargo(world, node));
  const move = person => tile => {
    person.lastKnownSafeTile = { x: tile.x, y: tile.y };
    person.x = tile.x + 0.5;
    person.y = tile.y + 0.5;
    return true;
  };
  continueAdventure(world, lead, recovery, store, store, move(lead));
  continueAdventure(world, lead, recovery, store, store, move(lead));
  assert.equal(node.quantity, 2);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const quest = restored.quests.find(q => q.id === recovery.id);
  const savedStore = restored.stockpiles[0];
  const leader = restored.citizens.find(c => c.id === quest.claimedBy);
  const escort = restored.citizens.find(c => c.id === quest.escortId);
  const before = savedStore.total.wood;
  for (let i = 0; i < 5 && quest.status === 'claimed'; i++) {
    continueAdventure(restored, escort, quest, savedStore, savedStore, move(escort));
    continueAdventure(restored, leader, quest, savedStore, savedStore, move(leader));
  }
  assert.equal(quest.status, 'completed');
  assert.equal(savedStore.total.wood, before + 4);
  assert.equal(restored.resourceNodes.find(n => n.id === node.id).quantity, 0);
  assert.equal(restored.events.filter(e => e.type === 'supplyRecoveryReturned').length, 1);
});

for (const mode of ['ordinary', 'revisit', 'mountain']) {
  const direct = mode === 'mountain';
  const steel = mode !== 'ordinary';
  test(direct ? 'mountain prospecting reveals a vein without an existing stone deposit'
      : steel ? 'steel-era surveyors revisit a depleted deposit after a mid-survey save'
      : 'two guild surveyors report a resource without removing it after a mid-survey save', async () => {
    const world = createWorld('guild-survey');
    world.map.terrain.fill('grass');
    const [home] = world.settlements;
    const [store] = world.stockpiles;
    const lead = world.citizens.find(c => c.profession === 'adventurer');
    world.citizens.find(c => c !== lead).profession = 'adventurer';
    world.buildings.push({ id: 'building:2', kind: 'guild', x: home.x + 5, y: home.y, settlementId: home.id });
    world.idCounters.building = 3;
    const source = { id: 'node:' + world.idCounters.node++, resource: steel ? 'stone' : 'wood',
      quantity: 12, x: store.x + (steel ? 8 : 12), y: store.y };
    if (!direct) world.resourceNodes.push(source);
    if (steel) {
      const { ensureResearch } = await import('../simulation/Research.js');
      ensureResearch(world, home, ['steel_1']);
      if (!direct) world.quests.push({ id: nextId(world, 'quest'), kind: 'survey_resources', settlementId: home.id,
        targetId: source.id, status: 'completed', claimedBy: null, surveyQuantity: 12, lootIds: [] });
      source.quantity = 0;
      world.map.terrain[source.y * world.map.width + source.x + 3] = 'mountain';
    }
    updateAdventureWorld(world, 12);
    const quest = world.quests.find(q => q.kind === 'survey_resources' && q.status === 'open');
    assert.ok(quest);
    assert.ok(claimAdventure(world, lead, store, () => true));
    assert.equal(Boolean(quest.prospectTile), direct);
    const node = quest.prospectTile ?? world.resourceNodes.find(n => n.id === quest.targetId);
    const quantity = node.quantity;
    const move = person => tile => {
      person.lastKnownSafeTile = { x: tile.x, y: tile.y };
      person.x = tile.x + 0.5;
      person.y = tile.y + 0.5;
      return true;
    };
    move(lead)(node);
    continueAdventure(world, lead, quest, store, store, move(lead));
    assert.deepEqual(quest.surveyVisitors, [lead.id]);

    const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
    const restoredQuest = restored.quests.find(q => q.id === quest.id);
    const depot = restored.stockpiles[0];
    const team = [restoredQuest.escortId, restoredQuest.claimedBy].map(id => restored.citizens.find(c => c.id === id));
    for (let i = 0; i < 4; i++) {
      for (const person of team) continueAdventure(restored, person, restoredQuest, depot, depot, move(person));
    }
    assert.equal(restoredQuest.status, 'completed');
    if (!direct) assert.equal(restored.resourceNodes.find(n => n.id === node.id).quantity, quantity);
    const reports = restored.events.filter(e => e.type === 'resourceSurveyReturned');
    assert.equal(reports.length, direct ? 0 : 1);
    const discoveries = restored.events.filter(e => e.type === 'manaVeinDiscovered');
    assert.equal(discoveries.length, Number(steel));
    if (steel) {
      const vein = restored.resourceNodes.find(n => n.id === restoredQuest.discoveredNodeId);
      assert.deepEqual([vein.resource, vein.quantity, vein.x, vein.y], ['manaStone', 5, source.x + 3, source.y]);
      assert.equal(depot.total.manaStone, 0);
      assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(restored))), restored);
    }
    const report = direct ? discoveries[0] : reports[0];
    if (!direct) assert.equal(report.quantity, quantity);
    assert.deepEqual(report.actorIds, [restoredQuest.claimedBy, restoredQuest.escortId]);
  });
}

test('a new local threat can replace an unclaimed survey and a dead target frees its notice', () => {
  const world = createWorld('threat-priority');
  world.map.terrain.fill('grass');
  const [home] = world.settlements;
  world.nextMonsterSpawnTick = Infinity;
  const distant = spawnMonster(world, 'slime', { x: home.x + 13, y: home.y });
  const danger = spawnMonster(world, 'goblin', { x: home.x + 7, y: home.y });
  for (const monster of world.monsters) monster.moveAt = Infinity;
  issueQuest(world, home, distant);
  const survey = { id: nextId(world, 'quest'), kind: 'survey_resources', settlementId: home.id,
    status: 'open', targetId: world.resourceNodes[0].id, expiresAt: 4 * TIME_TICKS_PER_DAY };
  world.quests.push(survey);
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 1);
  assert.equal(survey.status, 'expired');
  const response = world.quests.find(q => q.targetId === danger.id);
  assert.equal(response.status, 'open');
  danger.alive = false;
  world.worldTimeTick++;
  updateAdventureWorld(world, 1);
  assert.equal(response.status, 'expired');
});

test('a guild with two adults promotes an open notice after a monster forms a nest', () => {
  const world = createWorld('new-nest-notice');
  world.map.terrain.fill('grass');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  world.nextMonsterSpawnTick = Infinity;
  const target = spawnMonster(world, 'goblin', { x: store.x + 8, y: store.y });
  target.moveAt = Infinity;
  const quest = issueQuest(world, home, target);
  assert.equal(quest.kind, 'clear_monsters');
  target.hasNest = true;
  world.buildings.push({ id: nextId(world, 'building'), kind: 'guild', settlementId: home.id,
    x: store.x + 4, y: store.y, width: 1, height: 1 });
  world.citizens[0].profession = world.citizens[1].profession = 'adventurer';
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateAdventureWorld(world, 1);
  assert.equal(quest.kind, 'clear_nest');
  assert.deepEqual(quest.nestTile, target.homeTile);
});

test('an arcane smithy commission protects mana reserves and persists its equipment', async () => {
  const { prepareArcaneGear } = await import('../simulation/Industry.js');
  const world = createWorld('arcane-equipment');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const adventurer = world.citizens.find(c => c.profession === 'adventurer');
  adventurer.skills.combat = 5;
  world.buildings.push({ id: nextId(world, 'building'), kind: 'smithy', settlementId: home.id,
    x: home.x + 4, y: home.y, width: 1, height: 1 });
  ensureResearch(world, home, ['steel_1', 'magic_2']);
  Object.assign(store.total, { iron: 8, manaStone: 5 });
  commissionGear(world, adventurer, store);
  assert.equal(adventurer.gearId, 'steel');
  store.total.manaStone++;
  prepareArcaneGear(world);
  prepareArcaneGear(world);
  assert.equal(adventurer.gearId, 'arcane');
  assert.equal(store.total.iron, 2);
  assert.equal(store.total.manaStone, 5);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(restored.citizens.find(c => c.id === adventurer.id).gearId, 'arcane');
});

test('an experienced adventurer can train an idle adult apprentice in the guild', async () => {
  const { trainGuildApprentices } = await import('../simulation/AdventurerGrowth.js');
  const world = createWorld('guild-training');
  world.map.terrain.fill('grass');
  const [home] = world.settlements;
  const point = { x: 2, y: 2 };
  world.buildings.push({ id: nextId(world, 'building'), kind: 'guild', settlementId: home.id,
    ...point, width: 1, height: 1 });
  const [mentor, apprentice] = world.citizens;
  for (const citizen of [mentor, apprentice]) {
    citizen.profession = 'adventurer';
    citizen.lastKnownSafeTile = { x: point.x - 1, y: point.y };
  }
  mentor.skills.combat = 3;
  mentor.adventuresCompleted = 5;
  apprentice.skills.combat = 1;
  apprentice.combatXp = 38;
  home.foodWarning = true;
  trainGuildApprentices(world);
  assert.equal(apprentice.combatXp, 38);
  home.foodWarning = false;
  trainGuildApprentices(world);
  assert.equal(apprentice.skills.combat, 2);
  assert.equal(apprentice.combatXp, 2);
  const lesson = world.events.find(event => event.type === 'guildApprenticeAdvanced');
  assert.deepEqual(lesson.actorIds, [mentor.id, apprentice.id]);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const savedApprentice = saved.citizens.find(c => c.id === apprentice.id);
  trainGuildApprentices(saved);
  assert.equal(savedApprentice.combatXp, 2);
  saved.worldTimeTick = TIME_TICKS_PER_DAY;
  trainGuildApprentices(saved);
  assert.equal(savedApprentice.combatXp, 6);
});

test('binding magic delays a dangerous monster once and resumed casting deals damage', async () => {
  const world = createWorld('binding');
  const [home] = world.settlements;
  const [store] = world.stockpiles;
  const citizen = world.citizens.find(c => c.profession === 'adventurer');
  const tile = { x: store.x, y: store.y };
  world.map.terrain.fill('grass');
  citizen.lastKnownSafeTile = tile;
  citizen.skills.magic = 1;
  citizen.mp = 30;
  ensureResearch(world, home, ['magic_1', 'magic_2', 'binding_1']);
  const monster = spawnMonster(world, 'goblin', { x: tile.x - 1, y: tile.y });
  const quest = issueQuest(world, home, monster);
  const travel = () => true;
  assert.ok(claimAdventure(world, citizen, store, travel));
  continueAdventure(world, citizen, quest, store, tile, travel);
  world.worldTimeTick = quest.strikeAt;
  continueAdventure(world, citizen, quest, store, tile, travel);
  assert.equal(quest.boundTargetId, monster.id);
  assert.equal(monster.hp, monster.maxHp);
  assert.ok(monster.attackAt > world.worldTimeTick);
  assert.equal(monster.moveAt, monster.attackAt);
  assert.equal(citizen.mp, 20);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const savedQuest = saved.quests[0];
  const caster = saved.citizens.find(c => c.id === citizen.id);
  const target = saved.monsters.find(m => m.id === monster.id);
  saved.worldTimeTick = Math.max(savedQuest.strikeAt, caster.spellReadyAt);
  continueAdventure(saved, caster, savedQuest, saved.stockpiles[0], tile, travel);
  assert.equal(savedQuest.casting, true);
  saved.worldTimeTick = savedQuest.strikeAt;
  continueAdventure(saved, caster, savedQuest, saved.stockpiles[0], tile, travel);
  assert.ok(target.hp < target.maxHp);
  assert.equal(saved.events.filter(e => e.type === 'monsterBound').length, 1);
});

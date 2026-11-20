import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';
import { advanceFrame } from '../engine/GameLoop.js';
import { nextId } from '../simulation/Identity.js';
import { activeNations, truceBetween, updateWar } from '../simulation/War.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';

function twoNations() {
  const world = createWorld('war');
  world.map.terrain.fill('grass');
  const home = world.settlements[0];
  const away = { id: nextId(world, 'settlement'), x: 13, y: 13, nationId: null };
  world.settlements.push(away);
  const invader = { id: nextId(world, 'nation'), name: 'North', capitalId: home.id,
    settlementIds: [home.id], leaderId: world.citizens[0].id, weights: { defense: 2, food: 1, research: 1 }, relations: {}, policy: {} };
  const defender = { ...invader, id: nextId(world, 'nation'), name: 'South', capitalId: away.id,
    settlementIds: [away.id], leaderId: world.citizens.at(-1).id, weights: { ...invader.weights, defense: 1 }, relations: {} };
  invader.relations[defender.id] = defender.relations[invader.id] = -60;
  world.nations.push(invader, defender);
  home.nationId = invader.id;
  away.nationId = defender.id;
  for (const [index, citizen] of world.citizens.entries()) {
    citizen.nationId = index < 10 ? invader.id : defender.id;
    if (index >= 10) {
      citizen.settlementId = away.id;
      citizen.homeBuildingId = null;
    }
  }
  const homeStore = world.stockpiles[0];
  homeStore.total.food = 52;
  world.stockpiles.push({ ...structuredClone(homeStore), id: nextId(world, 'stockpile'),
    settlementId: away.id, x: 13, y: 13 });
  world.buildings.push({ id: nextId(world, 'building'), kind: 'barracks', settlementId: home.id,
    x: 25, y: 25, width: 1, height: 1 });
  return { world, invader, defender, away, homeStore };
}

test('hostile nations send real citizens, occupying and inheriting ownership without duplicating stock', async () => {
  const { world, invader, defender, away, homeStore } = twoNations();
  updateWar(world);
  assert.equal(homeStore.total.food, 28);
  assert.equal(world.campaigns[0].memberIds.length, 3);
  assert.equal(world.campaigns[0].arrivedIds.length, 0);
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);

  world.gameSpeed = 20;
  for (let i = 0; i < 300 && world.campaigns[0].status !== 'occupied'; i++) advanceFrame(world, 100);
  assert.equal(world.campaigns[0].status, 'occupied');
  assert.deepEqual(activeNations(world).map(n => n.id), [invader.id]);
  assert.equal(away.nationId, invader.id);
  assert.equal(defender.capitalId, null);
  assert.equal(world.stockpiles.length, 2);
  assert.equal(world.citizens.length, 12);
  assert.ok(world.citizens.every(c => c.nationId === invader.id));
  assert.ok(world.events.some(e => e.type === 'nationFallen' && e.nationId === defender.id));
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

test('a failed campaign establishes a bilateral truce that expires after ten days', async () => {
  const { world, invader, defender } = twoNations();
  updateWar(world);
  world.worldTimeTick = 3 * TIME_TICKS_PER_DAY;
  updateWar(world);
  const [campaign] = world.campaigns;
  assert.equal(campaign.status, 'repelled');
  const treaty = world.events.find(e => e.type === 'truceAgreed');
  assert.equal(treaty.expiresAt, world.worldTimeTick + 10 * TIME_TICKS_PER_DAY);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(truceBetween(restored, defender, invader).id, campaign.id);
  restored.worldTimeTick = treaty.expiresAt - TIME_TICKS_PER_DAY;
  updateWar(restored);
  assert.equal(restored.campaigns.length, 1);
  restored.worldTimeTick = treaty.expiresAt;
  updateWar(restored);
  assert.equal(restored.campaigns.length, 2);
});

test('two defeats between the same nations lead to peace and neutral relations', async () => {
  const { world, invader, defender } = twoNations();
  updateWar(world);
  world.worldTimeTick = 3 * TIME_TICKS_PER_DAY;
  updateWar(world);
  world.worldTimeTick = 13 * TIME_TICKS_PER_DAY;
  updateWar(world);
  assert.equal(world.campaigns.length, 2);
  world.worldTimeTick = 16 * TIME_TICKS_PER_DAY;
  updateWar(world);
  assert.equal(invader.relations[defender.id], 0);
  assert.equal(defender.relations[invader.id], 0);
  assert.equal(truceBetween(world, invader, defender), undefined);
  assert.ok(world.events.some(event => event.type === 'peaceAgreed'));
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = 40 * TIME_TICKS_PER_DAY;
  updateWar(restored);
  assert.equal(restored.campaigns.length, 2);
});

test('a defending militia can repel the invading force in a field battle before the siege', async () => {
  const { world, invader, defender } = twoNations();
  const militia = world.citizens.filter(c => c.nationId === defender.id);
  for (const citizen of militia) {
    citizen.lastKnownSafeTile = { x: 13, y: 13 };
    citizen.x = citizen.y = 13.5;
    citizen.skills.combat = 10;
  }
  updateWar(world);
  const [campaign] = world.campaigns;
  for (const citizen of world.citizens.filter(c => campaign.memberIds.includes(c.id))) {
    citizen.lastKnownSafeTile = { x: 13, y: 13 };
    campaign.arrivedIds.push(citizen.id);
  }
  updateWar(world);
  assert.equal(campaign.status, 'repelled');
  assert.equal(campaign.siegeDays, 0);
  const battle = world.events.find(e => e.type === 'fieldBattle');
  assert.equal(battle.winnerId, defender.id);
  assert.deepEqual(battle.nationIds, [invader.id, defender.id]);
  assert.equal(battle.actorIds.length, 5);
  assert.ok(militia.every(c => c.hp < 100 && c.alive));
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

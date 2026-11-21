import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';
import { advanceFrame } from '../engine/GameLoop.js';
import { updateNations } from '../simulation/Nations.js';
import { territoryAt } from '../simulation/Territory.js';
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
  assert.equal(territoryAt(world, away), defender.id);
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
  assert.equal(territoryAt(world, away), invader.id);
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


test('five nations can handle independent fronts and preserve a fallen nation in the save', async () => {
  const { world, invader, defender, homeStore } = twoNations();
  const addNation = (x, y) => {
    const settlement = { id: nextId(world, 'settlement'), x, y };
    const nation = { ...invader, id: nextId(world, 'nation'), capitalId: settlement.id,
      settlementIds: [settlement.id], leaderId: null, relations: {}, policy: {} };
    settlement.nationId = nation.id;
    world.settlements.push(settlement);
    world.nations.push(nation);
    world.stockpiles.push({ ...structuredClone(homeStore), id: nextId(world, 'stockpile'),
      settlementId: settlement.id, x, y });
    return { nation, settlement };
  };
  const { nation: east, settlement } = addNation(82, 32);
  const { nation: west } = addNation(112, 32);
  const { nation: neutral } = addNation(150, 48);
  const participants = world.citizens.slice(4, 8);
  for (const c of participants) Object.assign(c, { nationId: east.id, settlementId: settlement.id, homeBuildingId: null });
  world.buildings.push({ id: nextId(world, 'building'), kind: 'barracks', settlementId: settlement.id, x: 84, y: 32 });
  east.relations[west.id] = west.relations[east.id] = -60;
  const twoAttacks = structuredClone(world);
  const [capital, firstTarget, secondTarget] = twoAttacks.nations;
  for (const citizen of twoAttacks.citizens.filter(c => c.nationId === secondTarget.id)) {
    Object.assign(citizen, { nationId: capital.id, settlementId: capital.capitalId });
  }
  capital.relations[secondTarget.id] = secondTarget.relations[capital.id] = -60;
  const depot = twoAttacks.stockpiles[0];
  depot.total.food = 80;
  depot.capacity = 200;
  updateWar(twoAttacks);
  const offensives = twoAttacks.campaigns.filter(c => c.attackerId === capital.id);
  assert.deepEqual(offensives.map(c => c.defenderId), [firstTarget.id, secondTarget.id]);
  assert.equal(new Set(offensives.flatMap(c => c.memberIds)).size, 6);
  assert.equal(depot.total.food, 32);
  await readSnapshot(JSON.stringify(await createSnapshot(twoAttacks)));
  const multi = structuredClone(world);
  const [multiInvader, multiDefender, multiEast, multiWest] = multi.nations;
  multiEast.relations[multiWest.id] = multiWest.relations[multiEast.id] = 0;
  multiInvader.relations[multiEast.id] = multiEast.relations[multiInvader.id] = -60;
  updateWar(multi);
  assert.deepEqual(multi.campaigns.map(c => [c.attackerId, c.defenderId]),
    [[multiInvader.id, multiDefender.id], [multiEast.id, multiInvader.id]]);
  assert.equal(new Set(multi.campaigns.flatMap(c => c.memberIds)).size, 6);
  const activeSave = await readSnapshot(JSON.stringify(await createSnapshot(multi)));
  const [outbound, incoming] = activeSave.campaigns;
  incoming.status = 'siege';
  incoming.occupationDays = 2;
  for (const c of activeSave.citizens.filter(c => incoming.memberIds.includes(c.id))) {
    c.lastKnownSafeTile = { x: incoming.x, y: incoming.y };
    c.skills.combat = 10;
    incoming.arrivedIds.push(c.id);
  }
  updateWar(activeSave);
  assert.equal(incoming.status, 'occupied');
  assert.equal(outbound.status, 'repelled');
  assert.equal(outbound.rations, 0);
  assert.equal(truceBetween(activeSave, multiInvader, multiDefender), undefined);
  assert.ok(activeSave.events.some(e => e.type === 'campaignCancelled'));
  await readSnapshot(JSON.stringify(await createSnapshot(activeSave)));
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  updateNations(world, 12);
  assert.equal(world.campaigns.length, 2);
  assert.deepEqual(world.campaigns.map(c => c.defenderId), [defender.id, west.id]);
  participants[0].lastKnownSafeTile = { x: 149, y: 48 };
  world.worldTimeTick += TIME_TICKS_PER_DAY;
  updateNations(world, 12);
  assert.equal(neutral.relations[east.id], -2);
  assert.ok(world.events.some(e => e.type === 'borderFriction' && e.nationIds.includes(neutral.id)));

  const archived = { ...neutral, id: nextId(world, 'nation'), capitalId: null, settlementIds: [], fallenAt: world.worldTimeTick };
  world.nations.push(archived);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(activeNations(restored).length, 5);
  assert.equal(restored.nations.length, 6);
  assert.deepEqual(restored.campaigns, world.campaigns);
});


test('existing overlapping borders keep their old nearest-center owner when migrating', () => {
  const { world, invader, defender, away } = twoNations();
  Object.assign(away, { x: 42, y: 32 });
  assert.equal(territoryAt(world, { x: 37, y: 32 }), invader.id);
  assert.equal(territoryAt(world, { x: 38, y: 32 }), defender.id);
});

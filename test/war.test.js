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

test('food aid survives reload, delivers once and returns if the destination changes hands', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const awayStore = world.stockpiles[1];
  awayStore.total.food = 0;
  away.foodWarning = true;
  updateFoodAid(world);
  assert.equal(away.foodAid, undefined);
  away.nationId = invader.id;
  invader.settlementIds.push(away.id);
  defender.settlementIds = [];
  defender.capitalId = null;
  defender.fallenAt = 0;
  for (const citizen of world.citizens.slice(-2)) citizen.nationId = invader.id;
  updateFoodAid(world);
  assert.equal(homeStore.total.food, 46);
  assert.equal(away.foodAid.food, 6);
  assert.equal(awayStore.total.food, 0);

  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(restored);
  updateFoodAid(restored);
  assert.equal(restored.stockpiles[1].total.food, 6);
  assert.equal(restored.events.filter(e => e.type === 'foodAidDelivered').length, 1);

  away.nationId = defender.id;
  world.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  assert.equal(away.foodAid.returning, true);
  const barrier = [];
  for (let y = 0; y < world.map.height; y++) {
    const index = y * world.map.width + 22;
    barrier.push(world.map.terrain[index]);
    world.map.terrain[index] = 'water';
  }
  world.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  assert.equal(homeStore.total.food, 46);
  assert.equal(away.foodAid.food, 6);
  for (let y = 0; y < world.map.height; y++) world.map.terrain[y * world.map.width + 22] = barrier[y];
  const capacity = homeStore.capacity;
  homeStore.capacity = Object.values(homeStore.total).reduce((sum, quantity) => sum + quantity, 0);
  world.worldTimeTick += TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  assert.equal(away.foodAid.food, 6);
  homeStore.capacity = capacity;
  world.worldTimeTick += TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  updateFoodAid(world);
  assert.equal(awayStore.total.food, 0);
  assert.equal(homeStore.total.food, 52);
  assert.equal(away.foodAid, undefined);
});

test('the scarcest reserve per resident receives limited food aid first', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { world, invader, away, homeStore } = twoNations();
  const third = { ...away, id: nextId(world, 'settlement'), x: 14, y: 13, foodWarning: true, nationId: invader.id };
  world.settlements.push(third);
  away.foodWarning = true;
  away.nationId = invader.id;
  world.citizens.at(-1).settlementId = third.id;
  homeStore.total.food = 31;
  world.stockpiles[1].total.food = 1;
  const thirdStore = {
    ...structuredClone(world.stockpiles[1]), id: nextId(world, 'stockpile'), settlementId: third.id,
    x: third.x, y: third.y
  };
  thirdStore.total.food = 0;
  world.stockpiles.push(thirdStore);
  updateFoodAid(world);
  assert.equal(third.foodAid.food, 1);
  assert.equal(away.foodAid, undefined);
  assert.equal(homeStore.total.food, 30);
});

test('domestic material aid supplies a real construction reservation after reloading', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { planSite, reserveMaterials } = await import('../simulation/Construction.js');
  const { world, invader, away, homeStore } = twoNations();
  const awayStore = world.stockpiles[1];
  updateWar(world);
  world.gameSpeed = 20;
  for (let i = 0; i < 300 && world.campaigns[0].status !== 'occupied'; i++) advanceFrame(world, 100);
  assert.equal(away.nationId, invader.id);
  const { cancelSite, pickUpMaterials, deliverMaterials, buildAtSite } = await import('../simulation/Construction.js');
  const existing = world.constructionSites.find(site => site.settlementId === away.id);
  if (existing) cancelSite(world, existing);
  away.foodWarning = false;
  Object.assign(awayStore.total, { wood: 0, stone: 5, food: 24 });
  homeStore.total.wood = 24;
  const site = planSite(world, away, 'house', away.x + 4, away.y);
  assert.ok(site);
  assert.equal(reserveMaterials(world, site, awayStore), false);
  updateFoodAid(world);
  assert.equal(away.materialAid.quantity, 8);
  assert.equal(homeStore.total.wood, 16);
  assert.equal(awayStore.total.wood, 0);

  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const destination = saved.settlements[1];
  const store = saved.stockpiles[1];
  saved.worldTimeTick = destination.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  updateFoodAid(saved);
  assert.equal(destination.materialAid, undefined);
  assert.equal(store.total.wood, 8);
  assert.equal(saved.events.filter(e => e.type === 'materialAidDelivered').length, 1);
  assert.equal(reserveMaterials(saved, saved.constructionSites.find(item => item.id === site.id), store), true);
  assert.equal(store.reserved.wood, 8);
  const builtSite = saved.constructionSites.find(item => item.id === site.id);
  const carrier = saved.citizens.find(c => c.alive && c.settlementId === destination.id);
  for (const reservation of saved.reservations.filter(r => r.siteId === builtSite.id)) {
    const cargo = pickUpMaterials(saved, reservation, carrier);
    assert.ok(cargo);
    assert.equal(deliverMaterials(saved, cargo, carrier), true);
  }
  assert.equal(buildAtSite(saved, builtSite, TIME_TICKS_PER_DAY)?.kind, 'house');

});

test('friendly emergency aid survives saving but turns back when relations break during transit', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const awayStore = world.stockpiles[1];
  awayStore.total.food = 0;
  away.foodWarning = true;
  invader.relations[defender.id] = 60;
  defender.relations[invader.id] = 59;
  updateFoodAid(world);
  assert.equal(away.foodAid, undefined);
  defender.relations[invader.id] = 60;
  updateFoodAid(world);
  assert.equal(away.foodAid.recipientNationId, defender.id);
  assert.equal(homeStore.total.food, 46);

  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  saved.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  assert.equal(saved.stockpiles[1].total.food, 6);
  assert.deepEqual(saved.events.find(e => e.type === 'foreignFoodAidDelivered').nationIds, [invader.id, defender.id]);

  defender.relations[invader.id] = -60;
  world.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  assert.equal(away.foodAid.returning, true);
  world.worldTimeTick = away.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(world);
  assert.equal(awayStore.total.food, 0);
  assert.equal(homeStore.total.food, 52);
  assert.equal(away.foodAid, undefined);
});

test('peaceful nation relations can reach friendship through reachable capitals', () => {
  const { world, invader, defender, away } = twoNations();
  invader.relations[defender.id] = defender.relations[invader.id] = 0;
  invader.createdAt = defender.createdAt = 1000 * TIME_TICKS_PER_DAY;
  for (const citizen of world.citizens.filter(c => c.nationId === defender.id)) {
    citizen.lastKnownSafeTile = { x: away.x, y: away.y };
  }
  for (let day = 10; day <= 60; day += 10) {
    world.worldTimeTick = day * TIME_TICKS_PER_DAY;
    updateNations(world, 1);
  }
  assert.equal(invader.relations[defender.id], 60);
  assert.equal(defender.relations[invader.id], 60);
  assert.equal(world.events.filter(e => e.type === 'friendshipReached').length, 1);
});

test('barter delivers both loads exactly once or returns both after hostilities', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const awayStore = world.stockpiles[1];
  Object.assign(homeStore.total, { wood: 20, stone: 0 });
  Object.assign(awayStore.total, { wood: 0, stone: 10 });
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  const home = world.settlements[0];
  assert.equal(home.trade.outgoing, 'wood');
  assert.equal(home.trade.incoming, 'stone');
  assert.equal(homeStore.total.wood, 18);
  assert.equal(awayStore.total.stone, 8);

  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  saved.worldTimeTick = home.trade.arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(saved);
  updateTrade(saved);
  assert.equal(saved.stockpiles[0].total.stone, 2);
  assert.equal(saved.stockpiles[1].total.wood, 2);
  assert.equal(saved.events.filter(e => e.type === 'internationalTradeCompleted').length, 1);

  invader.relations[defender.id] = defender.relations[invader.id] = -60;
  world.worldTimeTick = home.trade.arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade.returning, true);
  world.worldTimeTick = home.trade.arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade, undefined);
  assert.equal(homeStore.total.wood, 20);
  assert.equal(awayStore.total.stone, 10);
  assert.equal(away.nationId, defender.id);
});

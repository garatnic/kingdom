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
  const world = createWorld('war', { alliedIntervention: false });
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

test('opt-in allied intervention uses an ordinary front and withdraws when the pact ends', async () => {
  const { world, invader, defender, away, homeStore } = twoNations();
  const home = { id: nextId(world, 'settlement'), x: 37, y: 32 };
  const ally = { ...defender, id: nextId(world, 'nation'), name: 'East', capitalId: home.id,
    settlementIds: [home.id], leaderId: null, relations: { [defender.id]: 60 }, alliances: { [defender.id]: 0 } };
  defender.relations[ally.id] = 60;
  defender.alliances = { [ally.id]: 0 };
  home.nationId = ally.id;
  world.nations.push(ally);
  world.settlements.push(home);
  const reserve = { ...structuredClone(homeStore), id: nextId(world, 'stockpile'), settlementId: home.id, x: 37, y: 32 };
  world.stockpiles.push(reserve);
  world.buildings.push({ id: nextId(world, 'building'), kind: 'barracks', settlementId: home.id, x: 39, y: 32 });
  for (const citizen of world.citizens.slice(5, 9)) {
    Object.assign(citizen, { nationId: ally.id, settlementId: home.id, homeBuildingId: null });
  }
  updateWar(world);
  const [siege] = world.campaigns;
  for (const citizen of world.citizens.filter(c => siege.memberIds.includes(c.id))) {
    citizen.lastKnownSafeTile = { x: siege.x, y: siege.y };
  }
  siege.arrivedIds = [...siege.memberIds];
  siege.status = 'siege';
  assert.equal(siege.settlementId, away.id);
  updateWar(world);
  assert.equal(world.campaigns.length, 1);

  world.settings.alliedIntervention = true;
  ally.relations[invader.id] = invader.relations[ally.id] = 60;
  updateWar(world);
  assert.equal(world.campaigns.length, 1);
  ally.relations[invader.id] = invader.relations[ally.id] = 0;
  siege.occupationDays = 0;
  updateWar(world);
  const [, relief] = world.campaigns;
  assert.equal(relief.attackerId, ally.id);
  assert.equal(relief.defenderId, invader.id);
  assert.equal(relief.supportsCampaignId, siege.id);
  assert.equal(reserve.total.food, 28);
  assert.deepEqual(world.events.find(e => e.type === 'alliedDefenseMobilized').nationIds, [ally.id, invader.id, defender.id]);

  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.nations.find(n => n.id === defender.id).relations[ally.id] = 0;
  updateWar(restored);
  assert.equal(restored.campaigns.length, 2);
  assert.equal(restored.campaigns[1].cancelled, true);
  assert.equal(restored.stockpiles.find(s => s.settlementId === home.id).total.food, 52);
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
  const peace = world.events.find(event => event.type === 'peaceAgreed');
  assert.equal(world.events.find(event => event.id === peace?.causeEventId)?.type, 'siegeRepelled');
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
  const { planSite, reserveMaterials, pickUpMaterials, deliverMaterials } = await import('../simulation/Construction.js');
  const captured = activeSave.settlements.find(s => s.id === incoming.settlementId);
  const depotBefore = activeSave.stockpiles.find(s => s.settlementId === captured.id);
  const localCarrier = activeSave.citizens.find(c => c.alive && c.settlementId === captured.id &&
    !outbound.memberIds.includes(c.id));
  depotBefore.total.wood = 12;
  depotBefore.capacity += 20;
  const site = planSite(activeSave, captured, 'farm', captured.x + 5, captured.y);
  assert.ok(site && localCarrier);
  assert.ok(reserveMaterials(activeSave, site, depotBefore));
  const cargo = pickUpMaterials(activeSave, activeSave.reservations.find(r => r.siteId === site.id), localCarrier);
  assert.ok(cargo);
  updateWar(activeSave);
  assert.equal(incoming.status, 'occupied');
  assert.equal(localCarrier.nationId, multiEast.id);
  const capturedSave = await readSnapshot(JSON.stringify(await createSnapshot(activeSave)));
  assert.ok(deliverMaterials(capturedSave, capturedSave.inTransit.find(item => item.id === cargo.id),
    capturedSave.citizens.find(c => c.id === localCarrier.id)));
  assert.equal(capturedSave.constructionSites.find(item => item.id === site.id).delivered.wood, 2);
  assert.equal(capturedSave.stockpiles.find(s => s.id === depotBefore.id).total.wood, 10);
  assert.equal(outbound.status, 'repelled');
  assert.equal(outbound.rations, 0);
  const recovered = activeSave.events.find(event => event.type === 'campaignRationsRecovered' && event.sourceTransactionId === outbound.id);
  assert.equal(recovered.food + recovered.dropped, 24);
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
  assert.equal(world.events.find(e => e.type === 'aidReturning').reason, 'ownership');
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
  assert.deepEqual(world.events.filter(e => e.type === 'aidReturned').map(e => e.quantity), [6]);
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
  const returning = world.events.find(e => e.type === 'aidReturning');
  assert.equal(returning.reason, 'relations');
  assert.deepEqual(returning.nationIds, [invader.id, defender.id]);
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
  const returnEvents = world.events.filter(e => e.type === 'internationalTradeReturning');
  assert.equal(returnEvents.length, 1);
  assert.equal(returnEvents[0].reason, 'conditions');
  world.worldTimeTick = home.trade.arrivalDay * TIME_TICKS_PER_DAY;
  const originalCapacity = homeStore.capacity;
  homeStore.capacity = Object.values(homeStore.total).reduce((sum, quantity) => sum + quantity, 0);
  updateTrade(world);
  assert.equal(home.trade.outgoingQuantity, 2);
  assert.equal(home.trade.incomingQuantity, 0);
  assert.equal(awayStore.total.stone, 10);
  const returned = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const returnedHome = returned.settlements[0];
  const returnedStore = returned.stockpiles[0];
  returnedStore.capacity = originalCapacity;
  returned.worldTimeTick += TIME_TICKS_PER_DAY;
  updateTrade(returned);
  updateTrade(returned);
  assert.equal(returnedHome.trade, undefined);
  assert.equal(returnedStore.total.wood, 20);
  assert.deepEqual(returned.events.filter(e => e.type === 'internationalTradeReturned')
    .map(e => [e.resource, e.quantity, e.settlementId]), [['stone', 2, away.id], ['wood', 2, home.id]]);
  assert.equal(returned.stockpiles[1].total.stone, 10);
  assert.equal(away.nationId, defender.id);
});

test('barter sees shortages above normal reserve when a capital has unreserved construction', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { planSite } = await import('../simulation/Construction.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const home = world.settlements[0];
  Object.assign(homeStore.total, { food: 36, wood: 20, stone: 7, iron: 3 });
  Object.assign(world.stockpiles[1].total, { wood: 4, stone: 16 });
  assert.ok(planSite(world, home, 'barracks', home.x + 4, home.y));
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade.incoming, 'stone');
  assert.equal(home.trade.partnerId, away.id);
  assert.equal(home.trade.incomingQuantity, 2);
});

test('a capital can exchange surplus reserves for a scarce good even if its partner meets ordinary targets', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { world, invader, defender, homeStore } = twoNations();
  const other = world.stockpiles[1];
  Object.assign(homeStore.total, { food: 36, wood: 20, stone: 10, iron: 7, manaStone: 0 });
  Object.assign(other.total, { food: 30, wood: 16, stone: 10, iron: 7, manaStone: 9 });
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  const trade = world.settlements[0].trade;
  assert.deepEqual([trade.outgoing, trade.incoming, trade.outgoingQuantity], ['wood', 'manaStone', 2]);
});

test('friendly envoy visits can form a defense pact without cargo when intervention is enabled', async () => {
  const { updateAlliances, alliedNations, allianceProgress } = await import('../simulation/Diplomacy.js');
  const { world, invader, defender, away } = twoNations();
  for (const c of world.citizens.filter(c => c.nationId === defender.id)) {
    c.lastKnownSafeTile = { x: away.x, y: away.y };
    Object.assign(c, { x: away.x + 0.5, y: away.y + 0.5 });
  }
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  const tick = (state, day) => {
    state.worldTimeTick = day * TIME_TICKS_PER_DAY;
    updateNations(state, 12);
    updateAlliances(state);
  };
  tick(world, 10);
  assert.ok(!world.events.some(e => e.type === 'pactEnvoyArrived'));
  world.settings.alliedIntervention = true;
  tick(world, 20);
  tick(world, 30);
  assert.equal(alliedNations(world, invader, defender), false);
  assert.deepEqual(allianceProgress(world)(invader, defender), {
    exchanges: 0, requiredExchanges: 2, envoyVisits: 2, requiredEnvoys: 3, cooldownDays: 0
  });
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  tick(saved, 40);
  const [ally, partner] = saved.nations;
  assert.equal(alliedNations(saved, ally, partner), true);
  assert.equal(saved.events.find(e => e.type === 'allianceFormed')?.basis, 'envoys');
  assert.equal(saved.events.filter(e => e.type === 'pactEnvoyArrived').length, 3);

  const interrupted = structuredClone(world);
  const { emitOnce } = await import('../systems/History.js');
  interrupted.worldTimeTick = 35 * TIME_TICKS_PER_DAY;
  emitOnce(interrupted, 'interrupted-contact', 'borderFriction', { nationIds: [invader.id, defender.id] });
  tick(interrupted, 40);
  tick(interrupted, 50);
  assert.equal(alliedNations(interrupted, ...interrupted.nations), false);
  assert.equal(allianceProgress(interrupted)(...interrupted.nations).envoyVisits, 2);
  tick(interrupted, 60);
  assert.equal(alliedNations(interrupted, ...interrupted.nations), true);
});

test('an alliance survives reload, supplies a besieged partner and dissolves if friendship breaks', async () => {
  const { updateAlliances, alliedNations, allianceProgress } = await import('../simulation/Diplomacy.js');
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { emitOnce } = await import('../systems/History.js');
  const { world, invader, defender, away } = twoNations();
  world.stockpiles[1].total.food = 2;
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  const pair = { nationIds: [invader.id, defender.id] };
  emitOnce(world, 'first exchange', 'internationalTradeCompleted', pair);
  updateAlliances(world);
  assert.equal(alliedNations(world, invader, defender), false);
  world.worldTimeTick = TIME_TICKS_PER_DAY;
  emitOnce(world, 'second exchange', 'foreignFoodAidDelivered', pair);
  updateAlliances(world);
  updateAlliances(world);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const [ally, partner] = saved.nations;
  assert.equal(alliedNations(saved, ally, partner), true);
  assert.equal(saved.events.filter(e => e.type === 'allianceFormed').length, 1);

  saved.campaigns = [{ attackerId: 'nation:3', defenderId: partner.id, settlementId: away.id, status: 'siege' }];
  updateFoodAid(saved);
  const target = saved.settlements[1];
  assert.equal(target.foodAid.allianceRelief, true);
  assert.equal(target.foodAid.food, 4);
  saved.worldTimeTick = target.foodAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  assert.equal(saved.stockpiles[1].total.food, 6);
  assert.equal(saved.events.find(e => e.type === 'foreignFoodAidDelivered' && e.allianceRelief)?.food, 4);

  partner.relations[ally.id] = 59;
  updateAlliances(saved);
  assert.equal(alliedNations(saved, ally, partner), false);
  assert.equal(saved.events.filter(e => e.type === 'allianceEnded').length, 1);
  assert.equal(allianceProgress(saved)(ally, partner).cooldownDays, 90);
  assert.equal(allianceProgress(saved)(ally, partner).requiredEnvoys, null);
  partner.relations[ally.id] = 60;
  updateAlliances(saved);
  assert.equal(alliedNations(saved, ally, partner), false);
});

test('a threat that appears after trade dispatch makes the shipment wait for its two escorts to arrive and return after reload', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { claimAdventure, continueAdventure, spawnMonster, updateAdventureWorld } = await import('../simulation/Adventure.js');
  const { findPath } = await import('../simulation/path.js');
  const { world, invader, defender, homeStore } = twoNations();
  const home = world.settlements[0];
  const awayStore = world.stockpiles[1];
  Object.assign(homeStore.total, { wood: 20, stone: 0 });
  Object.assign(awayStore.total, { wood: 0, stone: 10 });
  world.buildings.push({ id: nextId(world, 'building'), kind: 'guild', settlementId: home.id,
    x: homeStore.x + 4, y: homeStore.y, width: 1, height: 1 });
  const team = world.citizens.filter(c => c.settlementId === home.id && c.id !== invader.leaderId).slice(0, 2);
  for (const c of team) c.profession = 'adventurer';
  const path = findPath(world, homeStore, awayStore);
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade.escortQuestId, undefined);
  home.trade.arrivalDay += 2;
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const [from, to] = saved.stockpiles;
  const shipment = saved.settlements[0].trade;
  saved.worldTimeTick = (shipment.arrivalDay - 1) * TIME_TICKS_PER_DAY;
  const enemy = spawnMonster(saved, 'goblin', path[Math.floor(path.length / 2)]);
  assert.ok(enemy);
  updateTrade(saved);
  updateTrade(saved);
  const persisted = saved.quests.find(q => q.id === shipment.escortQuestId);
  assert.equal(persisted.kind, 'escort_trade');
  assert.equal(saved.quests.filter(q => q.kind === 'escort_trade').length, 1);
  assert.equal(to.total.wood, 0);
  assert.ok(claimAdventure(saved, saved.citizens.find(c => c.id === team[0].id), from, () => true));
  for (const id of [persisted.escortId, persisted.claimedBy]) {
    const citizen = saved.citizens.find(c => c.id === id);
    citizen.lastKnownSafeTile = { x: enemy.x, y: enemy.y };
  }
  const { ensureResearch } = await import('../simulation/Research.js');
  const { TECH } = await import('../data/technologies.js');
  for (const binding of [false, true]) {
    const magicWorld = structuredClone(saved);
    const spellQuest = magicWorld.quests.find(q => q.id === persisted.id);
    const caster = magicWorld.citizens.find(c => c.id === spellQuest.claimedBy);
    const magicEnemy = magicWorld.monsters.find(m => m.id === enemy.id);
    ensureResearch(magicWorld, magicWorld.nations[0], binding ? ['magic_1', 'binding_1'] : ['magic_1']);
    caster.skills.magic = 1;
    caster.mp = TECH.spellMp;
    updateAdventureWorld(magicWorld, 1);
    assert.equal(spellQuest.escortSpell?.casterId, caster.id);
    assert.equal(caster.mp, TECH.spellMp);

    const spellSaved = await readSnapshot(JSON.stringify(await createSnapshot(magicWorld)));
    const loadedQuest = spellSaved.quests.find(q => q.id === spellQuest.id);
    spellSaved.worldTimeTick = loadedQuest.escortSpell.readyAt;
    updateAdventureWorld(spellSaved, 1);
    updateAdventureWorld(spellSaved, 1);
    assert.equal(loadedQuest.escortSpell, undefined);
    const loadedCaster = spellSaved.citizens.find(c => c.id === caster.id);
    assert.equal(loadedCaster.mp, 0);
    assert.equal(spellSaved.events.filter(e => e.type === 'tradeEscortSpell').length, 1);
    assert.equal(spellSaved.events.filter(e => e.type === 'monsterBound').length, Number(binding));
    const loadedEnemy = spellSaved.monsters.find(m => m.id === magicEnemy.id);
    assert.ok(loadedEnemy.hp < magicEnemy.hp);
    if (binding) assert.equal(loadedCaster.hp, caster.hp);
  }
  const regrouping = structuredClone(saved);
  const regroupQuest = regrouping.quests.find(q => q.id === persisted.id);
  const regroupStore = regrouping.stockpiles[0];
  const scout = regrouping.citizens.find(c => c.id === regroupQuest.claimedBy);
  regroupQuest.escortWaypoint = { ...scout.lastKnownSafeTile };
  regroupQuest.waypointVisitors = [];
  const moveScout = tile => { scout.lastKnownSafeTile = { x: tile.x, y: tile.y }; return true; };
  continueAdventure(regrouping, scout, regroupQuest, regroupStore, regroupStore, moveScout);
  assert.deepEqual(regroupQuest.waypointVisitors, [scout.id]);
  assert.deepEqual(scout.lastKnownSafeTile, regroupQuest.escortWaypoint);

  const reloaded = await readSnapshot(JSON.stringify(await createSnapshot(regrouping)));
  const restoredQuest = reloaded.quests.find(q => q.id === persisted.id);
  const restoredStore = reloaded.stockpiles[0];
  const wing = reloaded.citizens.find(c => c.id === restoredQuest.escortId);
  const moveWing = tile => { wing.lastKnownSafeTile = { x: tile.x, y: tile.y }; return true; };
  continueAdventure(reloaded, wing, restoredQuest, restoredStore, restoredStore, moveWing);
  assert.deepEqual(restoredQuest.waypointVisitors, [scout.id, wing.id]);
  assert.deepEqual(wing.lastKnownSafeTile, restoredQuest.escortGoal);
  const unarmored = structuredClone(saved);
  const baselineEnemy = unarmored.monsters.find(m => m.id === enemy.id);
  updateAdventureWorld(unarmored, 1);
  saved.citizens.find(c => c.id === persisted.claimedBy).gearId = 'arcane';
  const health = enemy.hp;
  updateAdventureWorld(saved, 1);
  assert.ok(enemy.hp < baselineEnemy.hp);
  assert.ok(enemy.hp < health);
  const afterClash = enemy.hp;
  updateAdventureWorld(saved, 1);
  assert.equal(enemy.hp, afterClash);
  assert.equal(saved.events.filter(e => e.type === 'tradeEscortClash').length, 1);
  for (let i = 0; i < 4; i++) {
    for (const id of [persisted.escortId, persisted.claimedBy]) {
      const citizen = saved.citizens.find(c => c.id === id);
      continueAdventure(saved, citizen, persisted, from, from, tile => {
        citizen.lastKnownSafeTile = { x: tile.x, y: tile.y };
        return true;
      });
    }
  }
  assert.equal(persisted.status, 'completed');
  updateTrade(saved);
  assert.equal(to.total.wood, 0);
  saved.worldTimeTick = shipment.arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(saved);
  assert.equal(to.total.wood, 2);
  assert.equal(saved.events.filter(e => e.type === 'tradeEscortReturned').length, 1);
});

test('a destination guild can escort a longer trade when the originating guild is absent', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { spawnMonster } = await import('../simulation/Adventure.js');
  const { findPath } = await import('../simulation/path.js');
  const { world, invader, defender, homeStore, away } = twoNations();
  const other = world.stockpiles[1];
  away.x = other.x = 95;
  Object.assign(homeStore.total, { wood: 20, stone: 0 });
  Object.assign(other.total, { wood: 0, stone: 10 });
  world.buildings.push({ id: nextId(world, 'building'), kind: 'guild', settlementId: away.id,
    x: away.x + 3, y: away.y });
  for (const citizen of world.citizens.filter(c => c.settlementId === away.id)) citizen.profession = 'adventurer';
  const path = findPath(world, homeStore, other);
  assert.ok(path.length > 48 && path.length <= 96);
  assert.ok(spawnMonster(world, 'goblin', path[Math.floor(path.length / 2)]));
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const quest = saved.quests.find(q => q.id === saved.settlements[0].trade.escortQuestId);
  assert.equal(quest.settlementId, away.id);
  assert.equal(quest.partnerId, saved.settlements[0].id);
  assert.deepEqual(quest.escortGoal, { x: homeStore.x, y: homeStore.y });
});

test('a destination guild escorts only the threatened segment on a trade longer than 96 steps', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { claimAdventure, continueAdventure, spawnMonster } = await import('../simulation/Adventure.js');
  const { findPath } = await import('../simulation/path.js');
  const { world, invader, defender, homeStore, away } = twoNations();
  const other = world.stockpiles[1];
  away.x = other.x = 155;
  Object.assign(homeStore.total, { wood: 20, stone: 0 });
  Object.assign(other.total, { wood: 0, stone: 10 });
  world.buildings.push({ id: nextId(world, 'building'), kind: 'guild', settlementId: away.id,
    x: away.x + 3, y: away.y });
  for (const citizen of world.citizens.filter(c => c.settlementId === away.id)) citizen.profession = 'adventurer';
  const path = findPath(world, homeStore, other);
  assert.ok(path.length > 96);
  assert.ok(spawnMonster(world, 'goblin', path[path.length - 20]));
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const quest = saved.quests.find(q => q.id === saved.settlements[0].trade.escortQuestId);
  assert.equal(quest.settlementId, away.id);
  assert.equal(quest.partnerId, saved.settlements[0].id);
  const reversePath = findPath(saved, other, homeStore);
  const goalIndex = reversePath.findIndex(tile => tile.x === quest.escortGoal.x && tile.y === quest.escortGoal.y);
  assert.ok(goalIndex >= 0 && goalIndex < 96);
  assert.notDeepEqual(quest.escortGoal, { x: homeStore.x, y: homeStore.y });
  const destination = saved.stockpiles[1];
  const arrivalDay = saved.settlements[0].trade.arrivalDay;
  const lead = saved.citizens.find(c => c.id === defender.leaderId);
  assert.ok(claimAdventure(saved, lead, destination, () => true));
  for (let step = 0; step < 4; step++) {
    for (const id of [quest.escortId, quest.claimedBy]) {
      const member = saved.citizens.find(c => c.id === id);
      continueAdventure(saved, member, quest, destination, destination, tile => {
        member.lastKnownSafeTile = { x: tile.x, y: tile.y };
        return true;
      });
    }
  }
  assert.equal(quest.status, 'completed');
  updateTrade(saved);
  assert.equal(destination.total.wood, 0);
  saved.worldTimeTick = arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(saved);
  updateTrade(saved);
  assert.equal(destination.total.wood, 2);
  assert.equal(saved.events.filter(event => event.type === 'internationalTradeCompleted' && event.questId === quest.id).length, 1);
});

test('a veteran receives domestic mana stone and equips arcane gear after cargo reload', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { prepareArcaneGear } = await import('../simulation/Industry.js');
  const { ensureResearch } = await import('../simulation/Research.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const store = world.stockpiles[1];
  away.nationId = invader.id;
  invader.settlementIds.push(away.id);
  Object.assign(defender, { capitalId: null, settlementIds: [], fallenAt: 0 });
  const veterans = world.citizens.filter(c => c.settlementId === away.id);
  for (const citizen of veterans) citizen.nationId = invader.id;
  const veteran = veterans[0];
  veteran.profession = 'adventurer';
  veteran.skills.combat = 5;
  world.buildings.push({ id: nextId(world, 'building'), kind: 'smithy', settlementId: away.id,
    x: 2, y: 2, width: 2, height: 2 });
  ensureResearch(world, invader, ['magic_2']);
  Object.assign(store.total, { iron: 3, manaStone: 5, food: 8 });
  homeStore.capacity += 20;
  homeStore.total.manaStone = 6;
  updateFoodAid(world);
  assert.equal(away.materialAid.resource, 'manaStone');
  assert.equal(homeStore.total.manaStone, 5);

  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  saved.worldTimeTick = saved.settlements[1].materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  prepareArcaneGear(saved);
  assert.equal(saved.citizens.find(c => c.id === veteran.id).gearId, 'arcane');
  assert.equal(saved.stockpiles[1].total.manaStone, 5);
  assert.equal(saved.events.filter(e => e.type === 'materialAidDelivered').length, 1);
});

test('friendly trade buys the last mana stone needed by a capital smithy', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { ensureResearch } = await import('../simulation/Research.js');
  const { world, invader, defender, homeStore } = twoNations();
  const home = world.settlements[0];
  const other = world.stockpiles[1];
  const veteran = world.citizens.find(c => c.settlementId === home.id && c.id !== invader.leaderId);
  veteran.profession = 'adventurer';
  veteran.skills.combat = 5;
  world.buildings.push({ id: nextId(world, 'building'), kind: 'smithy', settlementId: home.id,
    x: 2, y: 2, width: 2, height: 2 });
  ensureResearch(world, invader, ['magic_2']);
  homeStore.capacity += 30;
  other.capacity += 30;
  Object.assign(homeStore.total, { wood: 20, iron: 3, manaStone: 5 });
  Object.assign(other.total, { wood: 0, manaStone: 7 });
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade?.incoming, 'manaStone');
  assert.equal(home.trade.incomingQuantity, 1);
  assert.equal(other.total.manaStone, 6);
});

test('steel tools ship from a smithy, survive reload, and equip once or return after a change of ownership', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { produceMiningTools } = await import('../simulation/Industry.js');
  const { ensureResearch } = await import('../simulation/Research.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  const home = world.settlements[0];
  away.nationId = invader.id;
  invader.settlementIds.push(away.id);
  Object.assign(defender, { capitalId: null, settlementIds: [], fallenAt: 0 });
  for (const citizen of world.citizens) {
    citizen.nationId = invader.id;
    if (citizen.settlementId === home.id && citizen.profession === 'miner') citizen.steelMiningTools = true;
  }
  const recipient = world.citizens.find(c => c.settlementId === away.id);
  recipient.profession = 'miner';
  world.buildings.push({ id: nextId(world, 'building'), kind: 'smithy', settlementId: home.id,
    x: 2, y: 2, width: 2, height: 2, completedAt: 0 });
  ensureResearch(world, invader, ['steel_1']);
  homeStore.capacity += 20;
  homeStore.total.iron = 5;
  updateFoodAid(world);
  assert.equal(away.materialAid?.resource, 'steelTools');
  assert.equal(homeStore.total.iron, 3);

  const serialized = JSON.stringify(await createSnapshot(world));
  const delivered = await readSnapshot(serialized);
  const destination = delivered.settlements[1];
  delivered.worldTimeTick = destination.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(delivered);
  assert.equal(delivered.stockpiles[1].steelTools, 1);
  produceMiningTools(delivered);
  produceMiningTools(delivered);
  assert.equal(delivered.citizens.find(c => c.id === recipient.id).steelMiningTools, true);
  assert.equal(delivered.stockpiles[1].steelTools, undefined);
  assert.equal(delivered.events.filter(event => event.type === 'miningToolsIssued').length, 1);

  const returning = await readSnapshot(serialized);
  const target = returning.settlements[1];
  returning.nations[0].settlementIds = [home.id];
  Object.assign(returning.nations[1], { capitalId: target.id, settlementIds: [target.id] });
  delete returning.nations[1].fallenAt;
  target.nationId = defender.id;
  for (const citizen of returning.citizens.filter(c => c.settlementId === target.id)) citizen.nationId = defender.id;
  returning.worldTimeTick = target.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(returning);
  assert.equal(target.materialAid.returning, true);
  returning.worldTimeTick = target.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(returning);
  assert.equal(target.materialAid, undefined);
  assert.equal(returning.stockpiles[0].steelTools, 1);
  assert.equal(returning.stockpiles[0].total.iron, 3);
  assert.equal(returning.stockpiles[1].steelTools, undefined);
});

test('a guild receives missing domestic inputs to install arcane irrigation', async () => {
  const { updateFoodAid } = await import('../simulation/FoodAid.js');
  const { installArcaneIrrigation } = await import('../simulation/Industry.js');
  const { ensureResearch } = await import('../simulation/Research.js');
  const { world, invader, defender, away, homeStore } = twoNations();
  away.nationId = invader.id;
  invader.settlementIds.push(away.id);
  Object.assign(defender, { capitalId: null, settlementIds: [], fallenAt: 0 });
  for (const citizen of world.citizens.filter(c => c.settlementId === away.id)) citizen.nationId = invader.id;
  const store = world.stockpiles[1];
  store.capacity += 20;
  Object.assign(store.total, { food: 8, stone: 0, manaStone: 5 });
  homeStore.capacity += 20;
  Object.assign(homeStore.total, { stone: 16, manaStone: 6 });
  const field = { id: nextId(world, 'building'), kind: 'farm', settlementId: away.id,
    x: 16, y: 16, width: 2, height: 2, completedAt: 0 };
  world.buildings.push(field, { id: nextId(world, 'building'), kind: 'guild', settlementId: away.id,
    x: 19, y: 16, width: 2, height: 2, completedAt: 0 });
  ensureResearch(world, invader, ['magic_2', 'irrigation_1']);
  installArcaneIrrigation(world);
  assert.equal(field.arcaneIrrigation, undefined);

  updateFoodAid(world);
  assert.equal(away.materialAid.resource, 'stone');
  const saved = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  const destination = saved.settlements[1];
  saved.worldTimeTick = destination.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  assert.equal(destination.materialAid.resource, 'manaStone');
  saved.worldTimeTick = destination.materialAid.arrivalDay * TIME_TICKS_PER_DAY;
  updateFoodAid(saved);
  installArcaneIrrigation(saved);
  installArcaneIrrigation(saved);
  assert.equal(saved.buildings.find(b => b.id === field.id).arcaneIrrigation, true);
  assert.equal(saved.stockpiles[1].total.manaStone, 5);
  assert.equal(saved.events.filter(event => event.type === 'arcaneIrrigationInstalled').length, 1);
});

test('a friendly capital buys the missing mana stone needed for weather-resistant irrigation', async () => {
  const { updateTrade } = await import('../simulation/Trade.js');
  const { ensureResearch } = await import('../simulation/Research.js');
  const { installArcaneIrrigation } = await import('../simulation/Industry.js');
  const { world, invader, defender, homeStore } = twoNations();
  const home = world.settlements[0];
  const other = world.stockpiles[1];
  const field = { id: nextId(world, 'building'), kind: 'farm', settlementId: home.id,
    x: 36, y: 36, width: 2, height: 2, completedAt: 0 };
  world.buildings.push(field, { id: nextId(world, 'building'), kind: 'guild', settlementId: home.id,
    x: 40, y: 36, width: 2, height: 2, completedAt: 0 });
  ensureResearch(world, invader, ['magic_2', 'irrigation_1']);
  homeStore.capacity += 30;
  other.capacity += 30;
  Object.assign(homeStore.total, { wood: 20, stone: 5, manaStone: 5 });
  Object.assign(other.total, { wood: 0, manaStone: 7 });
  invader.relations[defender.id] = defender.relations[invader.id] = 60;
  world.worldTimeTick = 5 * TIME_TICKS_PER_DAY;
  updateTrade(world);
  assert.equal(home.trade?.incoming, 'manaStone');
  assert.equal(home.trade.incomingQuantity, 1);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = restored.settlements[0].trade.arrivalDay * TIME_TICKS_PER_DAY;
  updateTrade(restored);
  installArcaneIrrigation(restored);
  assert.equal(restored.buildings.find(item => item.id === field.id).arcaneIrrigation, true);
  assert.equal(restored.stockpiles[0].total.manaStone, 5);
});

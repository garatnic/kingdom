import { RECORD_DAYS } from '../simulation/SettlementRecords.js';
import { FAR_MOVEMENT_STEPS, batchesMovement } from '../simulation/DetailLevel.js';
import { resources } from '../simulation/Economy.js';
import { NATIONS } from '../data/nations.js';
import { gear, monsters } from '../data/combat.js';
import { technologies } from '../data/technologies.js';
import { buildings, footprint } from '../data/buildings.js';
import { migrateFixedMap, validSurveyDimension, validWorldDimension } from '../engine/Expansion.js';
import { SIZE, SPEEDS, REAL_STEP_MS, TERRAIN_COST, LIFESPAN_YEARS, MIN_ZOOM, MAX_ZOOM, WALK_TICKS, TICKS_PER_STEP_AT_1X, TIME_TICKS_PER_DAY } from '../data/balance.js';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const inside = (value, limit) => Number.isFinite(value) && value >= 0 && value < limit;
const idOrder = (a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]);
const coreEntityLists = ['citizens', 'settlements', 'nations', 'buildings', 'resourceNodes', 'stockpiles',
  'constructionSites', 'events', 'reservations', 'inTransit', 'monsters', 'quests', 'researchStates'];

const entityLists = world => [...coreEntityLists, ...['expeditions', 'campaigns'].filter(key => world[key] !== undefined)];

function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('保存データに無効な値があります。');
}

function validate(world) {
  const map = world?.map;
  const camera = world?.settings?.camera;
  const validTile = tile => tile && integer(tile.x, 0, map.width - 1) && integer(tile.y, 0, map.height - 1);
  const terrainAt = tile => map.terrain[tile.y * map.width + tile.x];
  if (typeof world?.seed !== 'string' || !integer(world.worldTimeTick, 0) ||
      !SPEEDS.includes(world.gameSpeed) || !inside(world.tickRemainder, REAL_STEP_MS) ||
      !Array.isArray(world.rngState) || world.rngState.length !== 4 ||
      !world.rngState.every(n => integer(n, 0, 0xffffffff)) || !world.rngState.some(Boolean) ||
      !validWorldDimension(map?.width) || !validWorldDimension(map.height) || !integer(map.navigationVersion, 0) ||
      ((map.width === SIZE || map.height === SIZE) && (map.width !== SIZE || map.height !== SIZE ||
        !validSurveyDimension(map.surveyedWidth) || !validSurveyDimension(map.surveyedHeight))) ||
      !Array.isArray(map.terrain) || map.terrain.length !== map.width * map.height ||
      !map.terrain.every(t => Object.hasOwn(TERRAIN_COST, t)) ||
      !world.idCounters || !entityLists(world).every(key => Array.isArray(world[key])) ||
      world.settlements.length < 1 || world.nations.filter(n => n?.fallenAt === undefined).length > NATIONS.limit ||
      !world.settings || (camera && (!['free', 'manualOverride', 'autoEvent', 'followCitizen', 'followNation'].includes(camera.mode) ||
        !Number.isFinite(camera.x) || camera.x < 0 || camera.x > map.width ||
        !Number.isFinite(camera.y) || camera.y < 0 || camera.y > map.height ||
        !Number.isFinite(camera.zoom) || camera.zoom < MIN_ZOOM || camera.zoom > MAX_ZOOM))) {
    throw new Error('保存データの世界設定が無効です。');
  }
  const ids = new Set();
  for (const key of entityLists(world)) {
    for (const entity of world[key]) {
      const id = entity?.id;
      const match = typeof id === 'string' && /^([a-zA-Z]+):([1-9][0-9]*)$/.exec(id);
      if (!match || ids.has(id) || !integer(world.idCounters[match[1]], Number(match[2]) + 1)) {
        throw new Error('保存データのIDが無効です。');
      }
      ids.add(id);
    }
  }
  const settlements = new Map(world.settlements.map(s => [s.id, s]));
  if (world.territory !== undefined && (!world.territory || Object.getPrototypeOf(world.territory) !== Object.prototype ||
      Object.entries(world.territory).some(([index, id]) => !/^(0|[1-9][0-9]*)$/.test(index) ||
        !integer(Number(index), 0, map.width * map.height - 1) || !settlements.get(id)?.nationId))) {
    throw new Error('保存データの領土が無効です。');
  }
  const nations = new Map(world.nations.map(n => [n.id, n]));
  const expeditions = new Map((world.expeditions ?? []).map(e => [e.id, e]));
  const passable = tile => validTile(tile) && terrainAt(tile) !== 'water' &&
    !world.buildings.some(building => footprint(building, tile));
  const validAid = (aid, destinationId) => aid && aid.sourceId !== destinationId &&
    settlements.has(aid.sourceId) && nations.has(aid.nationId) &&
    integer(aid.travelDays, 1, map.width * map.height) && integer(aid.arrivalDay, 1) &&
    typeof aid.returning === 'boolean';
  const tradeGoods = ['wood', 'stone', 'iron', 'manaStone'];
  const validTrade = (trade, id) => trade && trade.partnerId !== id && settlements.has(trade.partnerId) &&
    nations.has(trade.firstNationId) && nations.has(trade.secondNationId) && trade.firstNationId !== trade.secondNationId &&
    tradeGoods.includes(trade.outgoing) && tradeGoods.includes(trade.incoming) && trade.outgoing !== trade.incoming &&
    integer(trade.outgoingQuantity, 0, 2) && integer(trade.incomingQuantity, 0, 2) &&
    (trade.returning ? trade.outgoingQuantity + trade.incomingQuantity > 0 :
      trade.outgoingQuantity > 0 && trade.outgoingQuantity === trade.incomingQuantity) &&
    integer(trade.arrivalDay, 1) && integer(trade.travelDays, 1, map.width * map.height) &&
    typeof trade.returning === 'boolean' &&
    (trade.escortQuestId === undefined || world.quests.some(q => q.id === trade.escortQuestId &&
      q.kind === 'escort_trade' && ((q.settlementId === id && q.partnerId === trade.partnerId) ||
        (q.settlementId === trade.partnerId && q.partnerId === id))));
  if (!world.settlements.every(s => validTile(s) && (s.nationId === null || nations.has(s.nationId)) &&
        (s.trade === undefined || validTrade(s.trade, s.id)) &&
        (s.lastGuildLessonDay === undefined || integer(s.lastGuildLessonDay, 0, Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY))) &&
        (s.foodWarning === undefined || typeof s.foodWarning === 'boolean') &&
        (s.foodAid === undefined || (validAid(s.foodAid, s.id) && integer(s.foodAid.food, 1) &&
          (s.foodAid.allianceRelief === undefined || (s.foodAid.allianceRelief === true && s.foodAid.recipientNationId)) &&
          (s.foodAid.recipientNationId === undefined || (s.foodAid.recipientNationId !== s.foodAid.nationId &&
            nations.has(s.foodAid.recipientNationId))))) &&
        (s.materialAid === undefined || (validAid(s.materialAid, s.id) &&
          (s.materialAid.resource === 'steelTools' ? s.materialAid.quantity === 1 :
            ['wood', 'stone', 'iron', 'manaStone'].includes(s.materialAid.resource) && integer(s.materialAid.quantity, 1)))) &&
        (s.dailyRecords === undefined || (Array.isArray(s.dailyRecords) && s.dailyRecords.length <= RECORD_DAYS &&
          s.dailyRecords.every((r, i, records) => r && integer(r.day, (records[i - 1]?.day ?? 0) + 1,
              Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY)) &&
            integer(r.population, 0) && integer(r.hungry, 0, r.population) && integer(r.food, 0) &&
            integer(r.waitingCargo, 0))))) ||
      !world.nations.every(n => n.fallenAt !== undefined
        ? integer(n.fallenAt, 0, world.worldTimeTick) && n.capitalId === null && n.settlementIds.length === 0
        : settlements.get(n.capitalId)?.nationId === n.id &&
          n.settlementIds.every(id => settlements.get(id)?.nationId === n.id)) ||
      !world.nations.every(n => n.alliances === undefined || (n.alliances &&
        Object.getPrototypeOf(n.alliances) === Object.prototype &&
        Object.entries(n.alliances).every(([id, since]) => id !== n.id &&
          integer(since, 0, world.worldTimeTick) && nations.get(id)?.alliances?.[n.id] === since))) ||
      !world.buildings.every(b => validTile(b) && settlements.has(b.settlementId) &&
        (b.arcaneIrrigation === undefined || (b.kind === 'farm' && typeof b.arcaneIrrigation === 'boolean')) &&
        (b.fertilityCommandId === undefined || (b.kind === 'farm' && integer(b.harvestAt, 0, world.worldTimeTick) &&
          typeof b.fertilityCommandId === 'string' && b.fertilityCommandId.length > 0 && b.fertilityCommandId.length <= 80)) &&
        (b.droughtCommandId === undefined || (b.kind === 'farm' && integer(b.harvestAt, 0) &&
          typeof b.droughtCommandId === 'string' && b.droughtCommandId.length > 0))) ||
      !world.resourceNodes.every(n => passable(n) && resources.includes(n.resource) && integer(n.quantity, 0) &&
        (n.frostCommandId === undefined || (typeof n.frostCommandId === 'string' && n.frostCommandId.length > 0 &&
          n.resource === 'food' && !n.dropped && n.quantity === 0 && integer(n.renewAt, 0)))) ||
      world.stockpiles.length !== settlements.size ||
      new Set(world.stockpiles.map(p => p.settlementId)).size !== settlements.size ||
      !world.stockpiles.every(p => settlements.has(p.settlementId) && p.total && p.reserved &&
        integer(p.capacity, 0) && (p.steelTools === undefined || integer(p.steelTools, 1)) && (p.x === undefined || passable(p)) &&
        resources.every(key => integer(p.total[key], 0) && integer(p.reserved[key], 0, p.total[key])) &&
        resources.reduce((sum, key) => sum + p.total[key], 0) <= p.capacity)) {
    throw new Error('保存データの集落・資源が無効です。');
  }
  const people = new Map(world.citizens.map(c => [c.id, c]));
  if (world.settings.mixedFamilies !== undefined && typeof world.settings.mixedFamilies !== 'boolean') {
    throw new Error('異種族家族の設定が無効です。');
  }
  if (world.settings.alliedIntervention !== undefined && typeof world.settings.alliedIntervention !== 'boolean') {
    throw new Error('防衛協定による参戦の設定が無効です。');
  }
  const favorites = world.settings.favoriteCitizenIds;
  if (favorites !== undefined && (!Array.isArray(favorites) || new Set(favorites).size !== favorites.length ||
      !favorites.every(id => people.has(id)))) throw new Error('保存データの注目人物が無効です。');
  const campaigns = new Map((world.campaigns ?? []).map(c => [c.id, c]));
  if (world.campaigns?.some(c => !['marching', 'siege', 'occupied', 'repelled'].includes(c.status) ||
      !nations.has(c.attackerId) || !nations.has(c.defenderId) || !settlements.has(c.settlementId) ||
      (['marching', 'siege'].includes(c.status) &&
        [c.attackerId, c.defenderId].some(id => nations.get(id).fallenAt !== undefined)) ||
      (c.supportsCampaignId !== undefined && (!campaigns.has(c.supportsCampaignId) ||
        campaigns.get(c.supportsCampaignId).supportsCampaignId !== undefined ||
        campaigns.get(c.supportsCampaignId).attackerId !== c.defenderId ||
        campaigns.get(c.supportsCampaignId).defenderId === c.attackerId)) ||
      !validTile(c) || !integer(c.rations, 0) || !Array.isArray(c.memberIds) || !c.memberIds.every(id => people.has(id)) ||
      !Array.isArray(c.arrivedIds) || !c.arrivedIds.every(id => c.memberIds.includes(id)))) {
    throw new Error('保存データの遠征が無効です。');
  }
  const sites = new Set(world.constructionSites.map(site => site.id));
  const stores = new Set(world.stockpiles.map(store => store.id));
  const constructionReservations = new Map(world.reservations.map(r => [r.id, r]));
  const shippedReservations = new Set(world.inTransit.map(item => item.reservationId));
  const targets = new Set(world.monsters.map(monster => monster.id));
  const techIds = new Set(technologies.map(technology => technology.id));
  const surveyTargets = new Set(world.resourceNodes.filter(node => !node.dropped).map(node => node.id));
  const dropIds = new Set(world.resourceNodes.filter(node => node.dropped).map(node => node.id));
  const accounts = new Set(world.researchStates.map(state => state.ownerId));
  if (!world.constructionSites.every(site => Object.hasOwn(buildings, site.kind) && validTile(site) &&
        settlements.has(site.settlementId) && integer(site.progress, 0) && site.delivered) ||
      !world.reservations.every(r => sites.has(r.siteId) && stores.has(r.sourceId) && resources.includes(r.resource) &&
        integer(r.quantity, 1) && ['reserved', 'inTransit', 'delivered'].includes(r.state) &&
        shippedReservations.has(r.id) === (r.state === 'inTransit')) ||
      shippedReservations.size !== world.inTransit.length ||
      !world.inTransit.every(item => {
        const reservation = constructionReservations.get(item.reservationId);
        return reservation?.state === 'inTransit' && reservation.siteId === item.destinationId &&
          reservation.sourceId === item.sourceId && reservation.quantity === item.quantity &&
          reservation.resource === item.resource &&
          (item.carrierId === null ? validTile(item) : people.get(item.carrierId)?.alive);
      }) ||
      !world.monsters.every(m => Object.hasOwn(monsters, m.species) && validTile(m) && validTile(m.homeTile) &&
        (m.relocating === undefined || typeof m.relocating === 'boolean') &&
        typeof m.alive === 'boolean' && integer(m.hp, 0, monsters[m.species].hp)) ||
      !world.quests.every(q => (q.kind === 'recover_supplies'
        ? dropIds.has(q.targetId) && (q.claimedBy === null || (people.has(q.escortId) &&
          integer(q.pickupAmount, 1) && q.recoveredBy && Object.getPrototypeOf(q.recoveredBy) === Object.prototype &&
          Object.entries(q.recoveredBy).every(([id, quantity]) =>
            [q.claimedBy, q.escortId].includes(id) && integer(quantity, 0, q.pickupAmount))))
        : q.kind === 'survey_resources' || q.kind === 'escort_trade'
          ? (q.kind === 'escort_trade' ? q.partnerId !== q.settlementId && settlements.has(q.partnerId) && validTile(q.escortGoal)
            : q.prospectTile ? q.targetId === undefined && validTile(q.prospectTile) : surveyTargets.has(q.targetId)) && (q.claimedBy === null || (people.has(q.escortId) &&
            Array.isArray(q.surveyVisitors) && new Set(q.surveyVisitors).size === q.surveyVisitors.length &&
            q.surveyVisitors.every(id => [q.claimedBy, q.escortId].includes(id)))) &&
            (q.surveyQuantity === undefined ? q.status !== 'completed' : integer(q.surveyQuantity, 0)) &&
            (q.discoveredNodeId === undefined || (q.status === 'completed' && surveyTargets.has(q.discoveredNodeId)))
          : targets.has(q.targetId)) && settlements.has(q.settlementId) &&
        (q.claimedBy === null || people.has(q.claimedBy)) &&
        (q.escortId === undefined || (people.has(q.escortId) && q.escortId !== q.claimedBy)) &&
        (q.kind !== 'clear_nest' || (validTile(q.nestTile) && Object.hasOwn(monsters, q.species))) &&
        (q.boundTargetId === undefined || (targets.has(q.boundTargetId) && targets.has(q.targetId))) &&
        Array.isArray(q.lootIds) && q.lootIds.every(id => ids.has(id))) ||
      accounts.size !== world.researchStates.length ||
      !world.researchStates.every(state => (settlements.has(state.ownerId) || nations.has(state.ownerId)) &&
        Array.isArray(state.unlockedIds) && state.unlockedIds.every(id => techIds.has(id)) &&
        new Set(state.unlockedIds).size === state.unlockedIds.length && state.progressById &&
        integer(state.knowledgePoints, 0))) {
    throw new Error('保存データの行動・建築・研究が無効です。');
  }

  for (const c of world.citizens) {
    const action = c.action;
    if (!inside(c.x, map.width) || !inside(c.y, map.height) || (c.settlementId === null
          ? c.nationId !== null || (c.alive && c.expeditionId && !expeditions.get(c.expeditionId)?.memberIds.includes(c.id))
          : !settlements.has(c.settlementId) || settlements.get(c.settlementId).nationId !== c.nationId) || typeof c.alive !== 'boolean' || !Object.hasOwn(LIFESPAN_YEARS, c.race) ||
        !c.inventory || !resources.every(key => integer(c.inventory[key], 0)) ||
        !c.traits || !['diligence', 'bravery', 'curiosity', 'magicAffinity'].every(key =>
          Number.isFinite(c.traits[key]) && c.traits[key] >= 0 && c.traits[key] <= 1) ||
        !Number.isFinite(c.hp) || c.hp < 0 || c.hp > 100 ||
        (c.steelMiningTools !== undefined && typeof c.steelMiningTools !== 'boolean') ||
        (c.gearId !== undefined && !Object.hasOwn(gear, c.gearId)) ||
        (c.adventuresCompleted !== undefined && !integer(c.adventuresCompleted, 0)) ||
        (c.combatXp !== undefined && !integer(c.combatXp, 0)) ||
        !Number.isSafeInteger(c.birthWorldTimeTick) || c.birthWorldTimeTick > world.worldTimeTick ||
        !Array.isArray(c.parentIds) || !Array.isArray(c.childIds) ||
        c.parentIds.some(id => !people.get(id)?.childIds?.includes(c.id) ||
          people.get(id).birthWorldTimeTick >= c.birthWorldTimeTick) ||
        c.childIds.some(id => id === c.id || !people.get(id)?.parentIds?.includes(c.id)) ||
        (c.alive && c.partnerId !== null && people.get(c.partnerId)?.partnerId !== c.id) ||
        (c.nextBirthCheckTick !== undefined && !integer(c.nextBirthCheckTick, 1)) ||
        (c.homeBuildingId !== null && !world.buildings.some(b => b.id === c.homeBuildingId)) ||
        !integer(c.decisionAt, 0) || !(c.alive ? passable(c.lastKnownSafeTile) : validTile(c.lastKnownSafeTile)) ||
        !action || !['plan', 'travel', 'perform'].includes(action.phase) ||
        (action.droughtForageId !== undefined && (action.kind !== 'gather' ||
          typeof action.droughtForageId !== 'string' || !action.droughtForageId.length || action.droughtForageId.length > 80)) ||
        (action.phase === 'travel' && !validRoute(c, passable, terrainAt, map.navigationVersion))) {
      throw new Error('保存データの住民・経路が無効です。');
    }
  }
}

function validRoute(citizen, passable, terrainAt, navigationVersion) {
  const { action } = citizen;
  if (action.deferredMovement !== undefined &&
      (!batchesMovement(action.kind) || !integer(action.deferredMovement, 0, FAR_MOVEMENT_STEPS * TICKS_PER_STEP_AT_1X - 1))) return false;
  if (Number.isInteger(action.navigationVersion) && action.navigationVersion < navigationVersion) {
    // The next simulation step replans from the saved safe tile before advancing.
    return Number.isInteger(action.goal?.x) && Number.isInteger(action.goal?.y);
  }
  if (action.navigationVersion !== navigationVersion || !Array.isArray(action.path) || !action.path.length ||
      !passable(action.goal)) return false;
  let previous = citizen.lastKnownSafeTile;
  for (const tile of action.path) {
    if (!passable(tile) || Math.abs(tile.x - previous.x) + Math.abs(tile.y - previous.y) !== 1) return false;
    previous = tile;
  }
  const [first] = action.path;
  const max = TERRAIN_COST[terrainAt(first)] * WALK_TICKS;
  return previous.x === action.goal.x && previous.y === action.goal.y &&
    Number.isInteger(action.progress) && inside(action.progress, max);
}

const payloadBytes = payload => new TextEncoder().encode(canonical(payload));

async function checksum(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSnapshot(world, camera) {
  const copy = structuredClone(world);
  if (camera) copy.settings.camera = structuredClone(camera);
  validate(copy);
  for (const key of entityLists(copy).filter(key => key !== 'events')) copy[key].sort(idOrder);
  const payload = {
    schemaVersion: VERSION, saveId: 'save:' + crypto.randomUUID(),
    createdAtIso: new Date().toISOString(), world: copy
  };
  const bytes = payloadBytes(payload);
  // The exported file adds this field and the 64 hexadecimal hash digits.
  const checksumFieldBytes = ',"checksum":"sha256:"'.length + 64;
  if (bytes.length + checksumFieldBytes > MAX_BYTES) throw new Error('保存ファイルが大きすぎます。');
  return { ...payload, checksum: await checksum(bytes) };
}

export async function readSnapshot(json) {
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('保存ファイルが大きすぎます。');
  const { checksum: expected, ...payload } = JSON.parse(json);
  if (payload.schemaVersion !== VERSION) throw new Error('未対応の保存形式です。');
  if (typeof payload.saveId !== 'string' || !Number.isFinite(Date.parse(payload.createdAtIso)) ||
      expected !== await checksum(payloadBytes(payload))) throw new Error('保存ファイルの整合性を確認できません。');
  validate(payload.world);
  migrateFixedMap(payload.world);
  for (const key of entityLists(payload.world).filter(key => key !== 'events')) payload.world[key].sort(idOrder);
  return payload.world;
}

import { NATIONS } from '../data/nations.js';
import { footprint } from '../data/buildings.js';
import { SIZE, SPEEDS, REAL_STEP_MS, TERRAIN_COST, LIFESPAN_YEARS, MIN_ZOOM, MAX_ZOOM, WALK_TICKS } from '../data/balance.js';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const inside = (value, limit) => Number.isFinite(value) && value >= 0 && value < limit;
const idOrder = (a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]);
const coreEntityLists = ['citizens', 'settlements', 'nations', 'buildings', 'resourceNodes', 'stockpiles',
  'constructionSites', 'events', 'reservations', 'inTransit', 'monsters', 'quests', 'researchStates'];

const entityLists = world => world.expeditions === undefined ? coreEntityLists : [...coreEntityLists, 'expeditions'];

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
  const validTile = tile => tile && integer(tile.x, 0, SIZE - 1) && integer(tile.y, 0, SIZE - 1);
  const terrainAt = tile => map.terrain[tile.y * SIZE + tile.x];
  if (typeof world?.seed !== 'string' || !integer(world.worldTimeTick, 0) ||
      !SPEEDS.includes(world.gameSpeed) || !inside(world.tickRemainder, REAL_STEP_MS) ||
      !Array.isArray(world.rngState) || world.rngState.length !== 4 ||
      !world.rngState.every(n => integer(n, 0, 0xffffffff)) || !world.rngState.some(Boolean) ||
      map?.width !== SIZE || map.height !== SIZE || !integer(map.navigationVersion, 0) ||
      !Array.isArray(map.terrain) || map.terrain.length !== SIZE ** 2 ||
      !map.terrain.every(t => Object.hasOwn(TERRAIN_COST, t)) ||
      !world.idCounters || !entityLists(world).every(key => Array.isArray(world[key])) ||
      world.settlements.length < 1 || world.settlements.length > NATIONS.limit || world.nations.length > NATIONS.limit ||
      !world.settings || (camera && (!['free', 'manualOverride', 'autoEvent', 'followCitizen', 'followNation'].includes(camera.mode) ||
        !inside(camera.x, SIZE + Number.EPSILON * SIZE) || !inside(camera.y, SIZE + Number.EPSILON * SIZE) ||
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
  const nations = new Map(world.nations.map(n => [n.id, n]));
  const expeditions = new Map((world.expeditions ?? []).map(e => [e.id, e]));
  const passable = tile => validTile(tile) && terrainAt(tile) !== 'water' &&
    !world.buildings.some(building => footprint(building, tile));
  if (!world.settlements.every(s => validTile(s) && (s.nationId === null || nations.has(s.nationId))) ||
      !world.nations.every(n => settlements.get(n.capitalId)?.nationId === n.id &&
        n.settlementIds.every(id => settlements.get(id)?.nationId === n.id)) ||
      !world.buildings.every(b => validTile(b) && settlements.has(b.settlementId)) ||
      !world.resourceNodes.every(n => passable(n) && integer(n.quantity, 0)) ||
      !world.stockpiles.every(p => settlements.has(p.settlementId) && p.total && p.reserved &&
        Object.entries(p.total).every(([key, total]) => integer(total, 0) && integer(p.reserved[key], 0, total)))) {
    throw new Error('保存データの集落・資源が無効です。');
  }
  const people = new Map(world.citizens.map(c => [c.id, c]));
  for (const c of world.citizens) {
    const action = c.action;
    if (!inside(c.x, SIZE) || !inside(c.y, SIZE) || (c.settlementId === null
          ? c.nationId !== null || (c.alive && c.expeditionId && !expeditions.get(c.expeditionId)?.memberIds.includes(c.id))
          : !settlements.has(c.settlementId) || settlements.get(c.settlementId).nationId !== c.nationId) || typeof c.alive !== 'boolean' || !Object.hasOwn(LIFESPAN_YEARS, c.race) ||
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
        (action.phase === 'travel' && !validRoute(c, passable, terrainAt, map.navigationVersion))) {
      throw new Error('保存データの住民・経路が無効です。');
    }
  }
}

function validRoute(citizen, passable, terrainAt, navigationVersion) {
  const { action } = citizen;
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

async function checksum(value) {
  const bytes = new TextEncoder().encode(canonical(value));
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
  return { ...payload, checksum: await checksum(payload) };
}

export async function readSnapshot(json) {
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('保存ファイルが大きすぎます。');
  const { checksum: expected, ...payload } = JSON.parse(json);
  if (payload.schemaVersion !== VERSION) throw new Error('未対応の保存形式です。');
  if (typeof payload.saveId !== 'string' || !Number.isFinite(Date.parse(payload.createdAtIso)) ||
      expected !== await checksum(payload)) throw new Error('保存ファイルの整合性を確認できません。');
  validate(payload.world);
  for (const key of entityLists(payload.world).filter(key => key !== 'events')) payload.world[key].sort(idOrder);
  return payload.world;
}

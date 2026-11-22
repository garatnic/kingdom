import { monsters } from './data/combat.js';
import { TILE, citizenRaces } from './data/balance.js';
import { applyGodCommand } from './systems/GodPowers.js';
import { openSaveStorage, readLatestGeneration, writeGeneration } from './systems/SaveStorage.js';
import { observation } from './ui/Observation.js';
import { activeNations } from './simulation/War.js';
import { createWorld } from './engine/World.js';
import { advanceFrame, calendar, setSpeed } from './engine/GameLoop.js';
import { createCamera, pan, zoomAt } from './engine/Camera.js';
import { WorldOverview } from './ui/WorldOverview.js';
import { Renderer } from './engine/Renderer.js';
import { createSnapshot, readSnapshot } from './systems/SaveManager.js';

const get = id => document.getElementById(id);
const canvas = get('map');
const renderer = new Renderer(canvas);
let world = createWorld(get('seed').value);
let camera = createCamera(world);
let lastTime = null;
let lastSpeed = 1;
let loadRequest = 0;
let lastBackup = 0;
let saveQueue = Promise.resolve();
let godQueue = [];
let terrainSpeed = null;
const storage = openSaveStorage().then(database => ({ database }), error => ({ error }));
const viewer = observation(() => world, () => camera, (target, mode) => {
  camera.x = target.x;
  camera.y = target.y;
  camera.mode = mode;
});

const overview = new WorldOverview(get('overview'), get('overview-toggle'), canvas, () => world, () => camera, (x, y) => {
  viewer.markManual();
  camera.x = Math.max(0.5, Math.min(world.map.width - 0.5, x));
  camera.y = Math.max(0.5, Math.min(world.map.height - 0.5, y));
  camera.mode = 'manualOverride';
});

function keepGeneration(snapshot) {
  const writing = Promise.all([saveQueue, storage, snapshot]).then(async ([, { database, error }, record]) => {
    if (error) throw error;
    await writeGeneration(database, record);
  });
  saveQueue = writing.catch(() => {});
  return writing;
}

function showReadouts() {
  const time = calendar(world.worldTimeTick);
  if (get('clock').textContent !== time) get('clock').textContent = time;
  const population = `住民 ${world.citizens.filter(c => c.alive).length}人`;
  if (get('population').textContent !== population) get('population').textContent = population;
  const food = `食料 ${world.stockpiles.reduce((sum, store) => sum + store.total.food - store.reserved.food, 0)}`;
  if (get('food').textContent !== food) get('food').textContent = food;
  const active = activeNations(world);
  const campaigns = world.campaigns ?? [];
  const marching = campaigns.filter(c => c.status === 'marching').length;
  const siege = campaigns.filter(c => c.status === 'siege').length;
  const conflict = (marching ? ` · 進軍 ${marching}件` : '') + (siege ? ` · 包囲 ${siege}件` : '');
  const nations = `国家 ${active.length}${conflict}`;
  if (get('nations').textContent !== nations) get('nations').textContent = nations;
}

function showState() {
  showReadouts();
  for (const button of get('speeds').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === world.gameSpeed));
  }
}

function frame(now) {
  const elapsed = lastTime === null ? 0 : now - lastTime;
  if (!document.hidden && godQueue.length) {
    for (const command of godQueue) {
      const error = applyGodCommand(world, command);
      get('god-status').textContent = error ? `実行できません（${error}）` : '介入を適用しました';
    }
    godQueue = [];
    endTerrainEdit();
  }
  advanceFrame(world, elapsed, document.hidden, camera);
  lastTime = now;
  showReadouts();
  viewer.render();
  viewer.updateCamera(now, elapsed);
  if (!document.hidden && now - lastBackup >= 60000) {
    lastBackup = now;
    keepGeneration(createSnapshot(world, camera)).catch(error => {
      get('status').textContent = `自動保存失敗：${error.message}。手動でJSONを保存できます。`;
    });
  }
  for (const [id, max] of [['god-x', world.map.width - 1], ['god-y', world.map.height - 1]]) {
    const coordinate = get(id);
    if (Number(coordinate.max) !== max) coordinate.max = max;
  }
  renderer.draw(world, camera);
  overview.draw();
  requestAnimationFrame(frame);
}

function selectSpeed(speed) {
  if (speed) lastSpeed = speed;
  setSpeed(world, speed);
  lastTime = null;
  showState();
}

function replaceWorld(next) {
  world = next;
  godQueue = [];
  terrainSpeed = null;
  viewer.reset();
  camera = next.settings.camera ? { ...next.settings.camera } : createCamera(next);
  lastSpeed = next.gameSpeed || 1;
  lastTime = null;
  get('seed').value = world.seed;
  showState();
}

get('speeds').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) selectSpeed(Number(button.dataset.speed));
});
get('new-world').addEventListener('submit', event => {
  event.preventDefault();
  loadRequest++;
  replaceWorld(createWorld(get('seed').value));
  get('status').textContent = '新しい世界を生成しました';
});
document.addEventListener('visibilitychange', () => { lastTime = null; });
document.addEventListener('keydown', event => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
      event.target.closest('input, button, textarea, select, [contenteditable]')) return;
  const speed = { Space: world.gameSpeed ? 0 : lastSpeed, Digit1: 1, Digit2: 5, Digit3: 20 }[event.code];
  if (speed === undefined) return;
  event.preventDefault();
  selectSpeed(speed);
});

function zoom(factor, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const dx = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2;
  const dy = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2;
  viewer.markManual();
  zoomAt(camera, factor, dx, dy, world.map);
}
get('zoom-out').onclick = () => zoom(0.8);
get('zoom-in').onclick = () => zoom(1.25);
get('center').onclick = () => { camera = createCamera(world); };
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
}, { passive: false });

const pointers = new Map();
let tapStart = null;
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointers.size >= 2) return;
  canvas.setPointerCapture(event.pointerId);
  tapStart = pointers.size === 0 ? { x: event.clientX, y: event.clientY } : null;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});
canvas.addEventListener('pointermove', event => {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const next = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, next);
  if (pointers.size === 1) {
    viewer.markManual();
    pan(camera, next.x - previous.x, next.y - previous.y, world.map);
  } else {
    const other = [...pointers.values()].find(point => point !== next);
    const oldMid = midpoint(previous, other);
    const newMid = midpoint(next, other);
    pan(camera, newMid.x - oldMid.x, newMid.y - oldMid.y, world.map);
    zoom(Math.max(1, distance(next, other)) / Math.max(1, distance(previous, other)), newMid.x, newMid.y);
  }
});
canvas.addEventListener('pointerup', event => {
  if (tapStart && pointers.size === 1 && distance(tapStart, { x: event.clientX, y: event.clientY }) < 5) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(camera.x + (event.clientX - rect.left - rect.width / 2) / (TILE * camera.zoom));
    const y = Math.floor(camera.y + (event.clientY - rect.top - rect.height / 2) / (TILE * camera.zoom));
    if (x >= 0 && y >= 0 && x < world.map.width && y < world.map.height) {
      get('god-x').value = x;
      get('god-y').value = y;
      viewer.inspectTile(x, y);
    }
  }
  tapStart = null;
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, event => pointers.delete(event.pointerId));
}

get('save').addEventListener('click', async () => {
  try {
    const snapshot = await createSnapshot(world, camera);
    const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), { href, download: 'kingdom-observer.json' });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    get('status').textContent = 'セーブをダウンロードしました';
    keepGeneration(snapshot).catch(error => {
      get('status').textContent = `JSONを保存しました。ブラウザ内保存失敗：${error.message}`;
    });
  } catch (error) {
    get('status').textContent = `保存失敗：${error.message}`;
  }
});
get('open').onclick = () => get('file').click();
get('file').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const request = ++loadRequest;
  try {
    const next = await readSnapshot(await file.text());
    if (request !== loadRequest) return;
    replaceWorld(next);
    get('status').textContent = 'セーブを読み込みました';
  } catch (error) {
    if (request === loadRequest) get('status').textContent = `読込失敗：${error.message}`;
  }
});

const godOptions = {
  disaster: { drought: '干ばつ（周囲5タイル）', frost: '霜害（周囲5タイル）' },
  blessing: { recovery: '回復（周囲3タイル）', fertility: '豊穣（周囲5タイル）' },
  life: Object.fromEntries(Object.entries(citizenRaces).map(([id, race]) => [id, race.label])),
  resource: { food: '食料', wood: '木材', stone: '石材', iron: '鉄', manaStone: '魔石' },
  terrain: { grass: '草原', forest: '森', mountain: '山', water: '水', undo: 'この地点の直前の地形編集を戻す' },
  monster: Object.fromEntries(Object.entries(monsters).map(([id, config]) => [id, config.label]))
};
function showGodOptions() {
  const kind = get('god-kind').value;
  get('god-value').replaceChildren(...Object.entries(godOptions[kind]).map(([id, name]) => new Option(name, id)));
  const max = { life: 10, resource: 100, monster: 5 }[kind];
  get('god-amount').hidden = max === undefined;
  get('god-quantity').disabled = max === undefined;
  if (max !== undefined) get('god-quantity').max = max;
  if (kind === 'terrain' && get('god-form').parentElement.open) {
    terrainSpeed ??= world.gameSpeed;
    selectSpeed(0);
  } else {
    endTerrainEdit();
  }
}
function endTerrainEdit() {
  if (terrainSpeed === null) return;
  const previous = terrainSpeed;
  terrainSpeed = null;
  selectSpeed(previous);
}
get('god-kind').onchange = showGodOptions;
get('god-form').parentElement.ontoggle = showGodOptions;
get('god-form').onsubmit = event => {
  event.preventDefault();
  const kind = get('god-kind').value;
  godQueue.push({ commandId: crypto.randomUUID(), kind, issuedAtRealTime: Date.now(),
    payload: { value: get('god-value').value, quantity: get('god-quantity').valueAsNumber,
      x: get('god-x').valueAsNumber, y: get('god-y').valueAsNumber } });
};
const startupLoad = loadRequest;
storage.then(async ({ database }) => {
  if (!database) return;
  let recovered = false;
  const saved = await readLatestGeneration(database, { onRecovery: () => { recovered = true; } });
  if (saved && startupLoad === loadRequest) {
    replaceWorld(saved);
    get('status').textContent = recovered
      ? '最新のセーブが破損していたため、以前の自動保存から復元しました'
      : 'ブラウザのセーブを復元しました';
  }
}).catch(error => {
  if (startupLoad === loadRequest) get('status').textContent = `ブラウザ内の読込失敗：${error.message}`;
});

showGodOptions();
showState();
requestAnimationFrame(frame);

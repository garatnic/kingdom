import { createWorld } from './engine/World.js';
import { advanceFrame, calendar, setSpeed } from './engine/GameLoop.js';
import { createCamera, pan, zoomAt } from './engine/Camera.js';
import { Renderer } from './engine/Renderer.js';
import { createSnapshot, readSnapshot } from './systems/SaveManager.js';

const get = id => document.getElementById(id);
const canvas = get('map');
const renderer = new Renderer(canvas);
let world = createWorld(get('seed').value);
let camera = createCamera(world);
let lastTime = null;
let lastSpeed = 1;

function showReadouts() {
  const time = calendar(world.worldTimeTick);
  if (get('clock').textContent !== time) get('clock').textContent = time;
  const population = `住民 ${world.citizens.filter(c => c.alive).length}人`;
  if (get('population').textContent !== population) get('population').textContent = population;
  const food = `食料 ${world.stockpiles.reduce((sum, store) => sum + store.total.food - store.reserved.food, 0)}`;
  if (get('food').textContent !== food) get('food').textContent = food;
}

function showState() {
  showReadouts();
  get('nations').textContent = `国家 ${world.nations.length}`;
  for (const button of get('speeds').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === world.gameSpeed));
  }
}

function frame(now) {
  advanceFrame(world, lastTime === null ? 0 : now - lastTime, document.hidden);
  lastTime = now;
  showReadouts();
  renderer.draw(world, camera);
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
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointers.size >= 2) return;
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});
canvas.addEventListener('pointermove', event => {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const next = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, next);
  if (pointers.size === 1) {
    pan(camera, next.x - previous.x, next.y - previous.y, world.map);
  } else {
    const other = [...pointers.values()].find(point => point !== next);
    const oldMid = midpoint(previous, other);
    const newMid = midpoint(next, other);
    pan(camera, newMid.x - oldMid.x, newMid.y - oldMid.y, world.map);
    zoom(Math.max(1, distance(next, other)) / Math.max(1, distance(previous, other)), newMid.x, newMid.y);
  }
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
  } catch (error) {
    get('status').textContent = `保存失敗：${error.message}`;
  }
});
get('open').onclick = () => get('file').click();
let loadRequest = 0;
get('new-world').addEventListener('submit', () => { loadRequest++; });
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

showState();
requestAnimationFrame(frame);

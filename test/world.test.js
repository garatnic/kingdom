import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { advanceFrame, calendar, setSpeed } from '../engine/GameLoop.js';
import { createCamera, pan, zoomAt } from '../engine/Camera.js';
import { findPath } from '../simulation/path.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';

test('three seeds reproduce map, resources, adults, IDs and PRNG', () => {
  const worlds = ['world-tree', '障害地形', '0'].map(seed => {
    const world = createWorld(seed);
    assert.deepEqual(world, createWorld(seed));
    assert.equal(world.map.terrain.length, 256 ** 2);
    assert.equal(world.citizens.length, 12);
    assert.equal(new Set(world.citizens.map(c => c.id)).size, 12);
    assert.equal(world.idCounters.citizen, 13);
    assert.equal(new Set(world.citizens.map(c => c.race)).size, 3);
    assert.ok(world.citizens.every(c => c.birthWorldTimeTick <= -16 * 432000 && c.nationId === null));
    assert.ok(world.citizens.some(c => c.traits.magicAffinity >= 0.7));
    const origin = world.citizens[0].lastKnownSafeTile;
    for (const node of world.resourceNodes) assert.ok(findPath(world, origin, node));
    return world;
  });
  assert.notDeepEqual(worlds[0].map.terrain, worlds[1].map.terrain);
});

test('weighted A* avoids water and houses and reports unreachable goals', () => {
  const world = {
    map: { width: 5, height: 3, terrain: [
      'grass', 'grass', 'grass', 'grass', 'grass',
      'grass', 'mountain', 'mountain', 'grass', 'grass',
      'grass', 'water', 'grass', 'grass', 'grass'
    ] },
    buildings: [{ x: 3, y: 1 }]
  };
  const start = { x: 0, y: 1 };
  assert.deepEqual(findPath(world, start, { x: 4, y: 1 }), [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
    { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }
  ]);
  assert.equal(findPath(world, start, { x: 3, y: 1 }), null);
  assert.equal(findPath(world, start, { x: 1, y: 2 }), null);
  world.map.terrain[1] = world.map.terrain[6] = 'water';
  assert.equal(findPath(world, start, { x: 4, y: 1 }), null);
});

test('all residents move autonomously without entering an obstacle', () => {
  for (const seed of ['world-tree', '障害地形', '0']) {
    const world = createWorld(seed);
    const moved = new Set();
    setSpeed(world, 20);
    for (let step = 0; step < 100; step++) {
      const before = world.citizens.map(({ x, y }) => [x, y]);
      advanceFrame(world, 100);
      for (const [i, c] of world.citizens.entries()) {
        const x = Math.floor(c.x);
        const y = Math.floor(c.y);
        assert.notEqual(world.map.terrain[y * world.map.width + x], 'water');
        assert.ok(world.buildings.every(b => b.x !== x || b.y !== y));
        if (before[i][0] !== c.x || before[i][1] !== c.y) moved.add(c.id);
      }
    }
    assert.equal(moved.size, 12, seed);
  }
});

test('fixed time, calendar and stop/resume are independent of render cadence', () => {
  const normal = createWorld('clock');
  for (let i = 0; i < 1200; i++) advanceFrame(normal, 100);
  assert.equal(normal.worldTimeTick, 14400);
  assert.equal(calendar(normal.worldTimeTick), '第1年 春 第2日 00:00');
  assert.equal(calendar(8 * 14400), '第1年 夏 第9日 00:00');
  assert.equal(calendar(29 * 14400), '第1年 冬 第30日 00:00');
  assert.equal(calendar(432000), '第2年 春 第1日 00:00');

  for (const speed of [5, 20]) {
    const fast = createWorld('clock');
    setSpeed(fast, speed);
    for (let i = 0; i < 1200 / speed; i++) {
      advanceFrame(fast, 16);
      advanceFrame(fast, 84);
    }
    setSpeed(fast, 1);
    assert.deepEqual(fast, normal);
  }
  const before = structuredClone(normal);
  setSpeed(normal, 0);
  advanceFrame(normal, 100);
  setSpeed(normal, 1);
  advanceFrame(normal, 30_000, true);
  assert.deepEqual(normal, before);
  advanceFrame(normal, 100);
  assert.equal(normal.worldTimeTick, 14412);
});

test('camera pans and preserves the zoom anchor within its limits', () => {
  const world = createWorld('camera');
  const camera = createCamera(world);
  const anchor = camera.x + 160 / 32;
  zoomAt(camera, 2, 160, 0, world.map);
  assert.equal(camera.x + 160 / (32 * camera.zoom), anchor);
  pan(camera, 64, 0, world.map);
  assert.equal(camera.mode, 'manualOverride');
  zoomAt(camera, 100, 0, 0, world.map);
  assert.equal(camera.zoom, 3);
  zoomAt(camera, 0.01, 0, 0, world.map);
  assert.equal(camera.zoom, 0.5);
});

test('snapshot restores mid-movement and reproduces future state; rejects corruption', async () => {
  const world = createWorld('save');
  for (let i = 0; i < 20; i++) advanceFrame(world, 137);
  assert.ok(world.citizens.some(c => c.action.progress > 0));
  const snapshot = await createSnapshot(world);
  const next = await readSnapshot(JSON.stringify(snapshot));
  assert.deepEqual(next, world);
  for (let i = 0; i < 100; i++) {
    advanceFrame(next, 100);
    advanceFrame(world, 100);
  }
  assert.deepEqual(next, world);
  await assert.rejects(readSnapshot('{'));
  await assert.rejects(readSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 999 })));
  snapshot.world.worldTimeTick++;
  await assert.rejects(readSnapshot(JSON.stringify(snapshot)), /整合性/);
  world.citizens[0].x = NaN;
  await assert.rejects(createSnapshot(world));
});

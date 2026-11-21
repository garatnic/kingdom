import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { advanceFrame } from '../engine/GameLoop.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { findPath } from '../simulation/path.js';

test('legacy terrain and coordinates migrate to a fixed map without consuming simulation randomness', async () => {
  const world = createWorld('world-tree');
  const terrain = Array.from({ length: 64 }, (_, y) => world.map.terrain.slice(y * 256, y * 256 + 64)).flat();
  world.map = { ...world.map, width: 64, height: 64, terrain };
  delete world.map.surveyedWidth;
  delete world.map.surveyedHeight;
  const migrated = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  assert.equal(migrated.map.width, 256);
  assert.equal(migrated.map.height, 256);
  assert.equal(migrated.map.surveyedWidth, 64);
  for (let y = 0; y < 64; y++) {
    assert.deepEqual(migrated.map.terrain.slice(y * 256, y * 256 + 64), terrain.slice(y * 64, y * 64 + 64));
  }
  assert.deepEqual(migrated.citizens, world.citizens);
  assert.deepEqual(migrated.rngState, world.rngState);
  assert.deepEqual(migrated.resourceNodes, world.resourceNodes);
});

test('adventurers discover resources within the fixed map and can save after surveying', async () => {
  const world = createWorld('world-tree');
  world.gameSpeed = 20;
  for (let i = 0; i < 400 && !world.events.some(event => event.type === 'frontierDiscovered'); i++) {
    advanceFrame(world, 100);
  }
  const discovery = world.events.find(event => event.type === 'frontierDiscovered');
  assert.ok(discovery);
  assert.equal(world.map.width, 256);
  assert.equal(world.map.height, 256);
  assert.ok(world.map.surveyedWidth > 64 || world.map.surveyedHeight > 64);
  assert.ok(world.resourceNodes.some(node => (node.x >= 64 || node.y >= 64) && findPath(world, discovery, node)));
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
  assert.equal(discoverFrontier(world, discovery, discovery.width > 64 ? 'east' : 'south', discovery.citizenId), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier } from '../engine/Expansion.js';
import { advanceFrame } from '../engine/GameLoop.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { findPath } from '../simulation/path.js';

test('frontier discovery preserves the old map, resource IDs and RNG and is save-compatible', async () => {
  const world = createWorld('world-tree');
  const edge = { x: 63, y: 20 };
  world.map.terrain[20 * 64 + 63] = 'grass';
  const original = structuredClone(world);
  const oldSave = await createSnapshot(original);
  assert.deepEqual(await readSnapshot(JSON.stringify(oldSave)), original);
  assert.ok(discoverFrontier(world, edge, 'east', world.citizens[0].id));
  assert.equal(world.map.width, 96);
  assert.equal(world.map.height, 64);
  for (let y = 0; y < 64; y++) {
    assert.deepEqual(world.map.terrain.slice(y * 96, y * 96 + 64), original.map.terrain.slice(y * 64, y * 64 + 64));
  }
  assert.deepEqual(world.rngState, original.rngState);
  assert.deepEqual(world.resourceNodes.slice(0, original.resourceNodes.length), original.resourceNodes);
  assert.ok(findPath(world, edge, world.resourceNodes.at(-1)));
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
  assert.equal(discoverFrontier(world, edge, 'east', world.citizens[0].id), false);
  discoverFrontier(original, edge, 'east', original.citizens[0].id);
  assert.deepEqual(world, original);
});

test('an adventurer reveals a new region by reaching the map edge', () => {
  const world = createWorld('world-tree');
  world.gameSpeed = 20;
  for (let i = 0; i < 300 && world.map.width === 64 && world.map.height === 64; i++) advanceFrame(world, 100);
  assert.ok(world.map.width > 64 || world.map.height > 64);
  assert.ok(world.events.some(event => event.type === 'frontierDiscovered'));
});

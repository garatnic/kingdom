import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { discoverFrontier, surveyRoute } from '../engine/Expansion.js';
import { advanceFrame } from '../engine/GameLoop.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { findPath } from '../simulation/path.js';
import { TIME_TICKS_PER_DAY } from '../data/balance.js';

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

test('frontier surveys reveal reachable ore and old exhausted iron workings reopen', async () => {
  const { NODE_RENEWAL_TICKS } = await import('../data/balance.js');
  const { renewNodes } = await import('../simulation/Economy.js');
  const world = createWorld('ore-frontier');
  world.map.terrain.fill('mountain');
  const tile = { x: world.map.surveyedWidth - 1, y: 32 };
  assert.equal(discoverFrontier(world, tile, 'east', world.citizens[0].id), true);
  for (const resource of ['iron', 'manaStone']) {
    const found = world.resourceNodes.find(n => n.x > tile.x && n.resource === resource);
    assert.ok(found && findPath(world, tile, found));
  }

  const iron = world.resourceNodes.find(n => n.resource === 'iron');
  const quantity = iron.quantity;
  iron.quantity = 0;
  renewNodes(world);
  assert.equal(iron.quantity, 0);
  assert.equal(iron.renewAt, NODE_RENEWAL_TICKS.iron);

  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  restored.worldTimeTick = NODE_RENEWAL_TICKS.iron;
  renewNodes(restored);
  const reopened = restored.resourceNodes.find(n => n.id === iron.id);
  assert.equal(reopened.quantity, quantity);
  assert.equal(reopened.renewAt, undefined);
});

test('surveys advance the shorter discovered axis and can fall back around a blocked edge', () => {
  const world = createWorld('balanced-frontier');
  const { map } = world;
  map.terrain.fill('grass');
  map.surveyedWidth = 96;
  world.worldTimeTick = 2 * TIME_TICKS_PER_DAY;
  const scout = world.citizens.find(c => c.profession === 'adventurer');
  scout.lastKnownSafeTile = { x: 92, y: 10 };
  assert.equal(surveyRoute(world, scout).goal.direction, 'south');

  for (let x = 0; x < map.surveyedWidth; x++) {
    map.terrain[(map.surveyedHeight - 1) * map.width + x] = 'water';
  }
  assert.equal(surveyRoute(world, scout).goal.direction, 'east');
});

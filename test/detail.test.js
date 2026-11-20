import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../engine/World.js';
import { updateCitizens } from '../simulation/CitizenAI.js';
import { createSnapshot, readSnapshot } from '../systems/SaveManager.js';
import { applyGodCommand } from '../systems/GodPowers.js';

test('distant idle walking batches ticks and flushes them when the camera returns after save/load', async () => {
  const world = createWorld('distance');
  const citizen = world.citizens[0];
  world.citizens = [citizen];
  Object.assign(citizen, { x: 1.5, y: 1.5, lastKnownSafeTile: { x: 1, y: 1 } });
  world.map.terrain[65] = world.map.terrain[66] = 'grass';
  citizen.action = { kind: 'explore', phase: 'travel', goal: { x: 2, y: 1 },
    path: [{ x: 2, y: 1 }], progress: 0, navigationVersion: world.map.navigationVersion };
  updateCitizens(world, 12, { x: 64, y: 64 });
  assert.equal(citizen.x, 1.5);
  assert.equal(citizen.action.deferredMovement, 12);
  const restored = await readSnapshot(JSON.stringify(await createSnapshot(world)));
  updateCitizens(restored, 12, { x: 1, y: 1 });
  assert.equal(restored.citizens[0].action.progress, 24);
  assert.equal(restored.citizens[0].action.deferredMovement, undefined);
});

test('the world creates, updates and restores three hundred individual residents', async () => {
  const world = createWorld('population');
  world.map.terrain.fill('grass');
  for (let i = 0; i < 29; i++) {
    const quantity = Math.min(10, 300 - world.citizens.length);
    assert.equal(applyGodCommand(world, {
      commandId: 'populate-' + i, kind: 'life',
      payload: { x: 3 + 7 * (i % 8), y: 3 + 7 * Math.floor(i / 8), value: 'human', quantity }
    }), null);
  }
  for (let i = 0; i < 40; i++) {
    world.worldTimeTick += 12;
    updateCitizens(world, 12, { x: 63, y: 63 });
  }
  assert.equal(world.citizens.filter(c => c.alive).length, 300);
  assert.equal(new Set(world.citizens.map(c => c.id)).size, 300);
  assert.deepEqual(await readSnapshot(JSON.stringify(await createSnapshot(world))), world);
});

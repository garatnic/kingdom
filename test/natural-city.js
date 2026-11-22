import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createWorld } from '../engine/World.js';
import { advanceFrame, setSpeed } from '../engine/GameLoop.js';
import { REAL_STEP_MS, TIME_TICKS_PER_YEAR } from '../data/balance.js';
import { createSnapshot } from '../systems/SaveManager.js';

const path = process.argv[2];
assert.ok(path, 'A destination for the test snapshot is required');
const world = createWorld('world-tree');
setSpeed(world, 20);
for (let year = 1; year <= 16; year++) {
  const camera = year % 2 ? { x: 32, y: 32 } : { x: 230, y: 230 };
  while (world.worldTimeTick < year * TIME_TICKS_PER_YEAR) {
    advanceFrame(world, REAL_STEP_MS, false, camera);
  }
}
const population = world.citizens.filter(citizen => citizen.alive).length;
assert.ok(population >= 300, `Expected at least 300 residents, got ${population}`);
assert.ok(world.nations.filter(nation => nation.fallenAt === undefined).length >= 2);
setSpeed(world, 0);
await writeFile(path, JSON.stringify(await createSnapshot(world)));
console.log(JSON.stringify({ population, history: world.events.length, tick: world.worldTimeTick }));

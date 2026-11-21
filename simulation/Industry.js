import { ADULT_AGE } from '../data/balance.js';
import { TECH } from '../data/technologies.js';
import { emitOnce } from '../systems/History.js';
import { available, storeTile } from './Economy.js';
import { ageYears } from './Identity.js';
import { unlocked } from './Research.js';
import { findPath } from './path.js';

export function produceMiningTools(world) {
  const equippedSettlements = new Set();
  for (const smithy of world.buildings) {
    const id = smithy.settlementId;
    if (smithy.kind !== 'smithy' || equippedSettlements.has(id) || !unlocked(world, id, 'steel_1')) continue;
    const store = world.stockpiles.find(s => s.settlementId === id);
    if (!store || available(store, 'iron') < TECH.miningToolIron + TECH.miningToolIronReserve) continue;
    const depot = storeTile(world, store);
    const miner = world.citizens.find(c => c.alive && c.settlementId === id && c.profession === 'miner' &&
      !c.steelMiningTools && ageYears(world, c) >= ADULT_AGE &&
      findPath(world, c.lastKnownSafeTile, depot) !== null);
    if (!miner) continue;

    store.total.iron -= TECH.miningToolIron;
    miner.steelMiningTools = true;
    equippedSettlements.add(id);
    emitOnce(world, miner.id, 'miningToolsForged', {
      citizenId: miner.id, settlementId: id, nationId: miner.nationId, x: smithy.x, y: smithy.y
    });
  }
}

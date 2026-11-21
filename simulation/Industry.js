import { ADULT_AGE } from '../data/balance.js';
import { gear } from '../data/combat.js';
import { commissionGear } from './AdventurerGrowth.js';
import { TECH } from '../data/technologies.js';
import { emitOnce } from '../systems/History.js';
import { available, storeTile } from './Economy.js';
import { ageYears } from './Identity.js';
import { unlocked } from './Research.js';
import { workTile } from './Construction.js';
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

export function installArcaneIrrigation(world) {
  for (const settlement of world.settlements) {
    const id = settlement.id;
    if (!unlocked(world, id, 'magic_2') || !unlocked(world, id, 'irrigation_1') ||
        !world.buildings.some(b => b.kind === 'guild' && b.settlementId === id)) continue;
    const store = world.stockpiles.find(s => s.settlementId === id);
    if (!store || available(store, 'stone') < TECH.arcaneIrrigationStone ||
        available(store, 'manaStone') < TECH.arcaneIrrigationMana + TECH.arcaneIrrigationReserve) continue;
    const depot = storeTile(world, store);
    const farm = world.buildings.find(b => b.kind === 'farm' && b.settlementId === id &&
      !b.arcaneIrrigation && workTile(world, depot, b));
    if (!farm) continue;
    store.total.stone -= TECH.arcaneIrrigationStone;
    store.total.manaStone -= TECH.arcaneIrrigationMana;
    farm.arcaneIrrigation = true;
    emitOnce(world, farm.id, 'arcaneIrrigationInstalled', {
      settlementId: id, nationId: settlement.nationId, x: farm.x, y: farm.y
    });
  }
}


export function prepareArcaneGear(world) {
  for (const settlement of world.settlements) {
    const id = settlement.id;
    if (!unlocked(world, id, gear.arcane.technology)) continue;
    const store = world.stockpiles.find(s => s.settlementId === id);
    if (!store || available(store, 'iron') < gear.arcane.iron ||
        available(store, 'manaStone') < gear.arcane.manaStone + gear.arcane.manaStoneReserve) continue;
    const depot = storeTile(world, store);
    const candidate = world.citizens.find(c => c.alive && c.settlementId === id &&
      c.profession === 'adventurer' && c.skills.combat >= gear.arcane.requiredLevel &&
      c.gearId !== 'arcane' && ageYears(world, c) >= ADULT_AGE && !c.expeditionId &&
      !world.quests.some(q => q.status === 'claimed' && (q.claimedBy === c.id || q.escortId === c.id)) &&
      findPath(world, c.lastKnownSafeTile, depot) !== null);
    if (candidate) commissionGear(world, candidate, store, 'arcane');
  }
}

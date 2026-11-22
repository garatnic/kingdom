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

export const STEEL_TOOLS = 'steelTools';

export function miningToolRecipient(world, store) {
  const depot = storeTile(world, store);
  return world.citizens.find(c => c.alive && c.settlementId === store.settlementId && c.profession === 'miner' &&
    !c.steelMiningTools && ageYears(world, c) >= ADULT_AGE &&
    findPath(world, c.lastKnownSafeTile, depot) !== null);
}

export function forgeMiningTools(world, store, smithy) {
  if (!smithy || !unlocked(world, store.settlementId, 'steel_1') ||
      available(store, 'iron') < TECH.miningToolIron + TECH.miningToolIronReserve) return false;
  store.total.iron -= TECH.miningToolIron;
  store.steelTools = (store.steelTools ?? 0) + 1;
  return true;
}

export function produceMiningTools(world) {
  for (const store of world.stockpiles) {
    const id = store.settlementId;
    const smithy = world.buildings.find(b => b.kind === 'smithy' && b.settlementId === id);
    if (!store.steelTools && (!smithy || !unlocked(world, id, 'steel_1'))) continue;
    const miner = miningToolRecipient(world, store);
    if (!miner) continue;

    const forgedLocally = !store.steelTools;
    if (forgedLocally && !forgeMiningTools(world, store, smithy)) continue;
    if (--store.steelTools === 0) delete store.steelTools;
    miner.steelMiningTools = true;
    emitOnce(world, miner.id, forgedLocally ? 'miningToolsForged' : 'miningToolsIssued', {
      citizenId: miner.id, settlementId: id, nationId: miner.nationId,
      ...(forgedLocally ? { x: smithy.x, y: smithy.y } : storeTile(world, store))
    });
  }
}

function irrigableFarm(world, store) {
  const id = store.settlementId;
  if (!unlocked(world, id, 'magic_2') || !unlocked(world, id, 'irrigation_1') ||
      !world.buildings.some(b => b.kind === 'guild' && b.settlementId === id)) return;
  const depot = storeTile(world, store);
  return world.buildings.find(b => b.kind === 'farm' && b.settlementId === id &&
    !b.arcaneIrrigation && workTile(world, depot, b));
}

const irrigationInputs = {
  stone: TECH.arcaneIrrigationStone,
  manaStone: TECH.arcaneIrrigationMana + TECH.arcaneIrrigationReserve
};

export function arcaneIrrigationDemand(world, store) {
  return irrigableFarm(world, store) ? irrigationInputs : {};
}

export function installArcaneIrrigation(world) {
  for (const settlement of world.settlements) {
    const id = settlement.id;
    const store = world.stockpiles.find(s => s.settlementId === id);
    if (!store || available(store, 'stone') < irrigationInputs.stone ||
        available(store, 'manaStone') < irrigationInputs.manaStone) continue;
    const farm = irrigableFarm(world, store);
    if (!farm) continue;
    store.total.stone -= TECH.arcaneIrrigationStone;
    store.total.manaStone -= TECH.arcaneIrrigationMana;
    farm.arcaneIrrigation = true;
    emitOnce(world, farm.id, 'arcaneIrrigationInstalled', {
      settlementId: id, nationId: settlement.nationId, x: farm.x, y: farm.y
    });
  }
}


function arcaneGearCandidate(world, id, depot) {
  return world.citizens.find(c => c.alive && c.settlementId === id &&
    c.profession === 'adventurer' && c.skills.combat >= gear.arcane.requiredLevel &&
    c.gearId !== 'arcane' && ageYears(world, c) >= ADULT_AGE && !c.expeditionId &&
    !world.quests.some(q => q.status === 'claimed' && (q.claimedBy === c.id || q.escortId === c.id)) &&
    findPath(world, c.lastKnownSafeTile, depot) !== null);
}

export function arcaneGearDemand(world, store) {
  const id = store.settlementId;
  if (!unlocked(world, id, gear.arcane.technology) ||
      !world.buildings.some(b => b.kind === 'smithy' && b.settlementId === id) ||
      !arcaneGearCandidate(world, id, storeTile(world, store))) return {};
  return { iron: gear.arcane.iron, manaStone: gear.arcane.manaStone + gear.arcane.manaStoneReserve };
}

export function prepareArcaneGear(world) {
  for (const settlement of world.settlements) {
    const id = settlement.id;
    if (!unlocked(world, id, gear.arcane.technology)) continue;
    const store = world.stockpiles.find(s => s.settlementId === id);
    if (!store || available(store, 'iron') < gear.arcane.iron ||
        available(store, 'manaStone') < gear.arcane.manaStone + gear.arcane.manaStoneReserve) continue;
    const depot = storeTile(world, store);
    const candidate = arcaneGearCandidate(world, id, depot);
    if (candidate) commissionGear(world, candidate, store, 'arcane');
  }
}

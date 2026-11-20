import { COMBAT, gear } from '../data/combat.js';
import { emitOnce } from '../systems/History.js';
import { available } from './Economy.js';
import { unlocked } from './Research.js';

export function adventurerRank(citizen) {
  const victories = citizen.adventuresCompleted ?? 0;
  return victories >= 20 ? 'hero' : victories >= 5 ? 'veteran' : victories ? 'explorer' : 'novice';
}

export function trainCombat(world, citizen, quest, experience) {
  let points = (citizen.combatXp ?? 0) + experience;
  while (citizen.skills.combat < COMBAT.maxLevel) {
    const threshold = COMBAT.xpPerLevel * (citizen.skills.combat + 1);
    if (points < threshold) break;
    points -= threshold;
    citizen.skills.combat++;
    emitOnce(world, citizen.id + '/' + citizen.skills.combat, 'combatLevelUp', {
      citizenId: citizen.id, questId: quest.id, level: citizen.skills.combat, ...citizen.lastKnownSafeTile
    });
  }
  citizen.combatXp = citizen.skills.combat < COMBAT.maxLevel ? points : 0;
}

export function recordAdventureSuccess(world, citizen, quest) {
  const previous = adventurerRank(citizen);
  citizen.adventuresCompleted = (citizen.adventuresCompleted ?? 0) + 1;
  trainCombat(world, citizen, quest, 4);
  const rank = adventurerRank(citizen);
  if (previous !== rank) {
    emitOnce(world, citizen.id + '/' + rank, 'adventurerRankUp', {
      citizenId: citizen.id, questId: quest.id, rank, ...citizen.lastKnownSafeTile
    });
  }
}

export function commissionGear(world, citizen, store) {
  if (!world.buildings.some(b => b.kind === 'smithy' && b.settlementId === citizen.settlementId)) return;
  for (const [id, item] of Object.entries(gear)) {
    if ((gear[citizen.gearId]?.attack ?? 0) >= item.attack ||
        citizen.skills.combat < item.requiredLevel ||
        !unlocked(world, citizen.settlementId, item.technology) ||
        available(store, 'iron') < item.iron) continue;
    store.total.iron -= item.iron;
    citizen.gearId = id;
    emitOnce(world, citizen.id + '/' + id, 'adventurerEquipped', { citizenId: citizen.id, gearId: id,
      ...citizen.lastKnownSafeTile });
    return;
  }
}

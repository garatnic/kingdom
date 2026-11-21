import { ADULT_AGE, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { ageYears } from './Identity.js';
import { campaignFor } from './War.js';
import { workTile } from './Construction.js';
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
      citizenId: citizen.id, ...(quest ? { questId: quest.id } : {}), level: citizen.skills.combat, ...citizen.lastKnownSafeTile
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

export function commissionGear(world, citizen, store, only = null) {
  if (!world.buildings.some(b => b.kind === 'smithy' && b.settlementId === citizen.settlementId)) return;
  for (const [id, item] of Object.entries(gear)) {
    if ((only && id !== only) || (gear[citizen.gearId]?.attack ?? 0) >= item.attack ||
        citizen.skills.combat < item.requiredLevel ||
        !unlocked(world, citizen.settlementId, item.technology) ||
        available(store, 'iron') < item.iron ||
        (item.manaStone && available(store, 'manaStone') < item.manaStone + item.manaStoneReserve)) continue;
    store.total.iron -= item.iron;
    if (item.manaStone) store.total.manaStone -= item.manaStone;
    citizen.gearId = id;
    emitOnce(world, citizen.id + '/' + id, 'adventurerEquipped', { citizenId: citizen.id, gearId: id,
      ...citizen.lastKnownSafeTile });
    return;
  }
}

export function trainGuildApprentices(world) {
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  const assigned = new Set(world.quests.filter(q => q.status === 'claimed')
    .flatMap(q => [q.claimedBy, q.escortId]));
  for (const guild of world.buildings) {
    const id = guild.settlementId;
    if (guild.kind !== 'guild') continue;
    const home = world.settlements.find(s => s.id === id);
    if (!home || home.foodWarning || home.lastGuildLessonDay === day) continue;
    const local = world.citizens.filter(c => c.alive && c.settlementId === id && c.profession === 'adventurer' &&
      ageYears(world, c) >= ADULT_AGE && c.hp > COMBAT.retreatHp && c.hunger < NEEDS.eat &&
      c.fatigue < NEEDS.sleep && c.action.kind === 'idle' && !assigned.has(c.id) && !c.expeditionId &&
      !campaignFor(world, c) &&
      Math.abs(c.lastKnownSafeTile.x - guild.x) + Math.abs(c.lastKnownSafeTile.y - guild.y) <= 8);
    const mentor = local.find(c => c.skills.combat >= 2 && (c.adventuresCompleted ?? 0) >= 5 &&
      workTile(world, c.lastKnownSafeTile, guild));
    if (!mentor) continue;
    const apprentice = local.find(c => c.skills.combat < Math.min(mentor.skills.combat, 4) &&
      workTile(world, c.lastKnownSafeTile, guild));
    if (!apprentice) continue;

    const previousLevel = apprentice.skills.combat;
    trainCombat(world, apprentice, null, 4);
    if (apprentice.skills.combat > previousLevel) {
      emitOnce(world, apprentice.id + '/' + apprentice.skills.combat, 'guildApprenticeAdvanced', {
        citizenId: apprentice.id, actorIds: [mentor.id, apprentice.id], settlementId: id,
        level: apprentice.skills.combat, x: guild.x, y: guild.y
      });
    }
    home.lastGuildLessonDay = day;
  }
}

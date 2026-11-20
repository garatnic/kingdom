import { NEED_HOUR_TICKS, TIME_TICKS_PER_DAY, TIME_TICKS_PER_MINUTE } from './balance.js';

export const monsters = {
  slime: { cap: 8, hp: 30, attack: 5, defense: 1, sight: 5, stepTicks: 125, xp: 5, loot: [['food', 0.5], ['manaStone', 0.1]] },
  goblin: { cap: 4, hp: 45, attack: 9, defense: 3, sight: 7, stepTicks: 91, xp: 10, loot: [['wood', 0.5], ['iron', 0.2]] }
};
export const COMBAT = {
  attack: 10, defense: 3, rangedDistance: 1, retreatHp: 35, braveRetreatHp: 20,
  fearRetreat: 80, dangerMultiplier: 1.5, interval: 10 * TIME_TICKS_PER_MINUTE,
  strikeDelay: 2 * TIME_TICKS_PER_MINUTE, xpPerLevel: 20, maxLevel: 10,
  spawnDistance: 10, residentSafety: 5, wanderRadius: 8, spawnInterval: 6 * NEED_HOUR_TICKS,
  questLimit: 2, questDuration: 2 * TIME_TICKS_PER_DAY, rewardFood: 1
};

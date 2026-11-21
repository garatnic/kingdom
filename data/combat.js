import { NEED_HOUR_TICKS, TIME_TICKS_PER_DAY, TIME_TICKS_PER_MINUTE } from './balance.js';

export const monsters = {
  slime: { label: 'スライム', color: '#9da75d', habitat: ['grass', 'forest'], cap: 8, hp: 30, attack: 5, defense: 1, sight: 5, stepTicks: 125, xp: 5, loot: [['food', 0.5], ['manaStone', 0.1]] },
  goblin: { label: 'ゴブリン', color: '#b66d54', habitat: ['forest', 'mountain'], cap: 4, hp: 45, attack: 9, defense: 3, sight: 7, stepTicks: 91, xp: 10, loot: [['wood', 0.5], ['iron', 0.2]] },
  wisp: { label: 'ウィスプ', color: '#9bd5ef', habitat: ['forest'], requiresExpansion: true,
    prey: 'slime', huntDamage: 10, cap: 3, hp: 28, attack: 12, defense: 1, sight: 7, stepTicks: 85, xp: 14, loot: [['manaStone', 0.65]] }
};
export const COMBAT = {
  attack: 10, defense: 3, rangedDistance: 1, retreatHp: 35, braveRetreatHp: 20,
  fearRetreat: 80, dangerMultiplier: 1.5, interval: 10 * TIME_TICKS_PER_MINUTE,
  strikeDelay: 2 * TIME_TICKS_PER_MINUTE, xpPerLevel: 20, maxLevel: 10,
  spawnDistance: 10, residentSafety: 5, wanderRadius: 8, spawnInterval: 6 * NEED_HOUR_TICKS,
  questLimit: 2, questRadius: 48, questDuration: 2 * TIME_TICKS_PER_DAY, rewardFood: 1
};

export const gear = {
  steel: { label: '鋼鉄装備', attack: 3, defense: 2, iron: 3, requiredLevel: 5, technology: 'steel_1' },
  iron: { label: '鉄製装備', attack: 1, defense: 1, iron: 2, requiredLevel: 2, technology: 'weapons_1' }
};

export const adventurerRanks = { novice: '駆け出し', explorer: '探索者', veteran: '熟練者', hero: '英雄' };

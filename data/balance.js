export const TIME_TICKS_PER_MINUTE = 10;
export const TIME_TICKS_PER_DAY = 14400;
export const TIME_TICKS_PER_YEAR = 432000;
export const REAL_STEP_MS = 100;
export const TICKS_PER_STEP_AT_1X = 12;
export const FOOD_HUNGER_PER_HOUR = 3;
export const FOOD_HUNGER_RESTORED = 40;
export const FOOD_PER_MEAL = 1;
export const FOOD_TARGET_PER_PERSON = 4;
export const FOOD_EMERGENCY_PER_PERSON = 2;
export const FOOD_BIRTH_PER_PERSON = 3;
export const LARGE_SETTLEMENT_POPULATION = 32;
export const CONSTRUCTION_STORAGE_RESERVE = { wood: 10, stone: 5 };
export const BIRTH_CHECK_INTERVAL_TICKS = TIME_TICKS_PER_YEAR;
export const BIRTH_PROBABILITY_PER_YEAR = 0.35;
export const MAGIC_AFFINITY_THRESHOLD = 0.7;
export const INITIAL_MAGIC_AFFINITY_MIN_COUNT = 1;
export const INITIAL_IRON_NODE_MIN_QTY = 6;
export const INITIAL_MANA_NODE_MIN_QTY = 2;

export const SIZE = 64;
export const TILE = 32;
export const POPULATION = 12;
export const SPEEDS = [0, 1, 5, 20];
export const SEASONS = [['春', 8], ['夏', 7], ['秋', 8], ['冬', 7]];
export const TERRAIN_COST = Object.freeze({ grass: 1, forest: 1.5, mountain: 3, water: Infinity });
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const MAX_FRAME_MS = 250;
export const MAX_FRAME_STEPS = 5;
export const DECISION_TICKS = 30 * TIME_TICKS_PER_MINUTE;
export const WALK_TICKS = 30;
export const WANDER_RADIUS = 8;
export const LAYOUT = {
  spawnRadius: 2,
  age: [16, 28],
  noiseSpacing: 8,
  thresholds: [0.33, 0.53, 0.72],
  provisions: { food: 24, wood: 20, stone: 10, iron: 0, manaStone: 0 },
  stockpileCapacity: 100,
  houseCapacity: 4,
  nodes: [
    ['food', 'grass', 12, -3, 0],
    ['wood', 'forest', 20, 3, 0],
    ['stone', 'mountain', 30, 0, -3],
    ['iron', 'mountain', INITIAL_IRON_NODE_MIN_QTY, 3, -3],
    ['manaStone', 'mountain', INITIAL_MANA_NODE_MIN_QTY, -3, -3],
    ['stone', 'mountain', 30, -3, 3]
  ]
};

export const GATHER_BATCH = 2;
export const GATHER_TICKS = 60;
export const NEED_HOUR_TICKS = 60 * TIME_TICKS_PER_MINUTE;
export const NEEDS = { eat: 80, sleep: 85, fatiguePerHour: 2, restPerHour: 12, starvationDamage: 3, healingPerHour: 4, recoveryHp: 75 };
export const NODE_RENEWAL_TICKS = { food: 8 * NEED_HOUR_TICKS, wood: TIME_TICKS_PER_DAY, stone: 20 * TIME_TICKS_PER_DAY };

export const ADULT_AGE = 16;
export const citizenRaces = {
  human: { label: '人間', color: '#e2b56b', lifespan: [30, 45] },
  elf: { label: 'エルフ', color: '#a9d592', lifespan: [50, 80] },
  dwarf: { label: 'ドワーフ', color: '#dd9979', lifespan: [40, 60] },
  orc: { label: 'オーク', color: '#9ccc70', lifespan: [35, 55] },
  halfling: { label: 'ハーフリング', color: '#edc68f', lifespan: [45, 65] },
  fairy: { label: '妖精', color: '#ed9cde', lifespan: [60, 95], minMagicAffinity: 0.75 }
};
export const LIFESPAN_YEARS = Object.fromEntries(
  Object.entries(citizenRaces).map(([id, race]) => [id, race.lifespan])
);
export const FAMILY = { relationshipPerDay: 10, marriageThreshold: 60, maxAgeGap: 20, birthSpacingYears: 2 };

export const FRONTIER = { dx: -14, dy: 0, clearingRadius: 3,
  resources: [['food', 'grass', 12, -2, 0], ['wood', 'forest', 20, -2, -2], ['stone', 'mountain', 30, -2, 2]] };

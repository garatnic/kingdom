export const technologies = [
  { id: 'farming_1', cost: 100, population: 4 },
  { id: 'building_1', cost: 120, building: 'house' },
  { id: 'weapons_1', cost: 180, building: 'smithy', resources: { iron: 2 } },
  { id: 'magic_1', cost: 200, requiresAffinity: true, resources: { manaStone: 1 } },
  { id: 'steel_1', cost: 1200, era: 'iron', requires: 'weapons_1', building: 'smithy', resources: { iron: 2 } },
  { id: 'irrigation_1', cost: 900, era: 'iron', requires: 'farming_1', building: 'farm', resources: { stone: 8 } },
  { id: 'magic_2', cost: 1800, era: 'kingdom', requires: 'magic_1', requiresAffinity: true,
    building: 'guild', resources: { manaStone: 2 } },
  { id: 'restoration_1', cost: 850, era: 'kingdom', requires: 'magic_1', requiresAffinity: true,
    building: 'guild', resources: { manaStone: 1 } },
  { id: 'verdant_1', cost: 3000, era: 'arcane', requires: 'irrigation_1', requiresAffinity: true,
    building: 'guild', resources: { manaStone: 5 } }
];

export const TECH = {
  farmYieldMultiplier: 1.25, buildingWorkPercent: 120, weaponBonus: 2,
  arcaneIrrigationStone: 2, arcaneIrrigationMana: 1, arcaneIrrigationReserve: 5, arcaneIrrigationYield: 1,
  miningToolIron: 2, miningToolIronReserve: 2, miningToolBonus: 1,
  steelWeaponBonus: 2, irrigationBonus: 0.25, verdantBonus: 0.5, arcaneSpellBonus: 4,
  farmEraDays: 3, farmEraFarms: 2, farmEraPopulation: 8,
  spellRange: 3, spellAttack: 8, spellMp: 10, maxMp: 30, mpRecovery: 5,
  spellCastTicks: 100, spellCooldownTicks: 300, restorationHp: 12, restorationMp: 10
};


export const civilizationNames = {
  primitive: '原始時代', agrarian: '農耕時代', iron: '鉄器時代', kingdom: '王国時代', arcane: '魔導時代', mythic: '神話時代'
};

export const civilizationTransitions = {
  primitive: { to: 'agrarian', technology: 'farming_1', population: TECH.farmEraPopulation,
    buildings: { farm: TECH.farmEraFarms }, days: TECH.farmEraDays },
  agrarian: { to: 'iron', technology: 'weapons_1', population: 8, buildings: { smithy: 1 }, resources: { iron: 2 }, days: 10 },
  iron: { to: 'kingdom', technology: 'steel_1', population: 16, buildings: { guild: 1, warehouse: 1 },
    foodPerResident: 2, requiresNation: true, days: 12 },
  kingdom: { to: 'arcane', technology: 'magic_2', population: 16, buildings: { guild: 1 },
    resources: { manaStone: 2 }, days: 20 },
  arcane: { to: 'mythic', technology: 'verdant_1', population: 20, buildings: { guild: 1, farm: 3 },
    resources: { manaStone: 5 }, foodPerResident: 3, requiresNation: true, days: 30 }
};

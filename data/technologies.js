export const technologies = [
  { id: 'farming_1', cost: 100, population: 4 },
  { id: 'building_1', cost: 120, building: 'house' },
  { id: 'weapons_1', cost: 180, building: 'smithy', resources: { iron: 2 } },
  { id: 'magic_1', cost: 200, requiresAffinity: true, resources: { manaStone: 1 } }
];

export const TECH = {
  farmYieldMultiplier: 1.25, buildingWorkPercent: 120, weaponBonus: 2,
  farmEraDays: 3, farmEraFarms: 2, farmEraPopulation: 8,
  spellRange: 3, spellAttack: 8, spellMp: 10, maxMp: 30, mpRecovery: 5,
  spellCastTicks: 100, spellCooldownTicks: 300
};

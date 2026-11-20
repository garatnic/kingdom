import { NEED_HOUR_TICKS, TIME_TICKS_PER_MINUTE } from './balance.js';

export const buildings = {
  house: { width: 2, height: 2, cost: { wood: 8, stone: 2 }, workMinutes: 120, capacity: 4 },
  farm: { width: 2, height: 2, cost: { wood: 2 }, workMinutes: 60 },
  warehouse: { width: 3, height: 2, cost: { wood: 10, stone: 5 }, workMinutes: 120, capacity: 100 },
  smithy: { width: 2, height: 2, cost: { wood: 8, stone: 10, iron: 2 }, workMinutes: 120 },
  guild: { width: 3, height: 3, cost: { wood: 12, stone: 8 }, workMinutes: 180 },
  barracks: { width: 3, height: 3, cost: { wood: 10, stone: 12, iron: 2 }, workMinutes: 180 }
};

export const workTicks = kind => buildings[kind].workMinutes * TIME_TICKS_PER_MINUTE;
export const FARM_HARVEST_TICKS = 8 * NEED_HOUR_TICKS;
export const FARM_YIELD = 8;

export function footprint(building, tile) {
  return tile.x >= building.x && tile.x < building.x + (building.width ?? 1) &&
    tile.y >= building.y && tile.y < building.y + (building.height ?? 1);
}

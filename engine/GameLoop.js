import {
  REAL_STEP_MS, TICKS_PER_STEP_AT_1X, MAX_FRAME_MS, MAX_FRAME_STEPS,
  NEED_HOUR_TICKS, TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR, TIME_TICKS_PER_MINUTE, SEASONS, SPEEDS
} from '../data/balance.js';
import { trimHistory } from '../systems/History.js';
import { trainGuildApprentices } from '../simulation/AdventurerGrowth.js';
import { updateAdventureWorld } from '../simulation/Adventure.js';
import { updateCitizens } from '../simulation/CitizenAI.js';
import { updateNations } from '../simulation/Nations.js';
import { updateResearch } from '../simulation/Research.js';
import { installArcaneIrrigation, prepareArcaneGear, produceMiningTools } from '../simulation/Industry.js';
import { updateFoodAid } from '../simulation/FoodAid.js';
import { updateAlliances } from '../simulation/Diplomacy.js';
import { updateTrade } from '../simulation/Trade.js';
import { recordSettlements } from '../simulation/SettlementRecords.js';
import { updatePopulation } from '../simulation/Population.js';

export function advanceFrame(world, elapsedMs, hidden = false, camera) {
  if (hidden || !world.gameSpeed) return;
  world.tickRemainder += Math.min(MAX_FRAME_MS, Math.max(0, elapsedMs));
  let steps = 0;
  while (world.tickRemainder >= REAL_STEP_MS && steps < MAX_FRAME_STEPS) {
    world.tickRemainder -= REAL_STEP_MS;
    steps++;
    // Faster playback executes the same ordered logical updates.
    for (let i = 0; i < world.gameSpeed; i++) {
      world.worldTimeTick += TICKS_PER_STEP_AT_1X;
      updateAdventureWorld(world, TICKS_PER_STEP_AT_1X);
      updateCitizens(world, TICKS_PER_STEP_AT_1X, camera);
      updatePopulation(world, TICKS_PER_STEP_AT_1X);
      updateNations(world, TICKS_PER_STEP_AT_1X);
      updateResearch(world, TICKS_PER_STEP_AT_1X);
      if (world.worldTimeTick % NEED_HOUR_TICKS === 0) trainGuildApprentices(world);
      if (world.worldTimeTick % TIME_TICKS_PER_DAY === 0) {
        produceMiningTools(world);
        prepareArcaneGear(world);
        installArcaneIrrigation(world);
        recordSettlements(world);
        updateAlliances(world);
        updateFoodAid(world);
        updateTrade(world);
        trimHistory(world);
      }
    }
  }
  world.tickRemainder %= REAL_STEP_MS;
}

export function setSpeed(world, speed) {
  if (!SPEEDS.includes(speed)) throw new RangeError('Invalid speed');
  world.gameSpeed = speed;
}

export function calendar(tick) {
  const year = Math.floor(tick / TIME_TICKS_PER_YEAR) + 1;
  const day = Math.floor((tick % TIME_TICKS_PER_YEAR) / TIME_TICKS_PER_DAY) + 1;
  let seasonDay = day;
  for (const [season, days] of SEASONS) {
    if (seasonDay <= days) {
      const minutes = Math.floor((tick % TIME_TICKS_PER_DAY) / TIME_TICKS_PER_MINUTE);
      const pad = number => String(number).padStart(2, '0');
      return `第${year}年 ${season} 第${day}日 ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    }
    seasonDay -= days;
  }
}

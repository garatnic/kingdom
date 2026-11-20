import {
  REAL_STEP_MS, TICKS_PER_STEP_AT_1X, MAX_FRAME_MS, MAX_FRAME_STEPS,
  TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR, TIME_TICKS_PER_MINUTE, SEASONS, SPEEDS
} from '../data/balance.js';
import { updateCitizens } from '../simulation/CitizenAI.js';
import { updatePopulation } from '../simulation/Population.js';

export function advanceFrame(world, elapsedMs, hidden = false) {
  if (hidden || !world.gameSpeed) return;
  world.tickRemainder += Math.min(MAX_FRAME_MS, Math.max(0, elapsedMs));
  let steps = 0;
  while (world.tickRemainder >= REAL_STEP_MS && steps < MAX_FRAME_STEPS) {
    world.tickRemainder -= REAL_STEP_MS;
    steps++;
    // Faster playback executes the same ordered logical updates.
    for (let i = 0; i < world.gameSpeed; i++) {
      world.worldTimeTick += TICKS_PER_STEP_AT_1X;
      updateCitizens(world, TICKS_PER_STEP_AT_1X);
      updatePopulation(world, TICKS_PER_STEP_AT_1X);
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

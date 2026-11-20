import { LIFESPAN_YEARS, TIME_TICKS_PER_YEAR } from '../data/balance.js';
import { random } from '../engine/random.js';

export function nextId(world, kind) {
  const next = world.idCounters[kind] ?? 1;
  world.idCounters[kind] = next + 1;
  return `${kind}:${next}`;
}

export const professions = ['farmer', 'farmer', 'woodcutter', 'miner', 'builder', 'adventurer'];
export const ageYears = (world, citizen) =>
  Math.floor((world.worldTimeTick - citizen.birthWorldTimeTick) / TIME_TICKS_PER_YEAR);

export function lifespan(world, race) {
  const [min, max] = LIFESPAN_YEARS[race];
  return min + Math.floor(random(world.rngState) * (max - min + 1));
}

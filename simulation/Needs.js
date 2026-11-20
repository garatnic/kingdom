import { FOOD_HUNGER_PER_HOUR, FOOD_HUNGER_RESTORED, FOOD_PER_MEAL, NEEDS, NEED_HOUR_TICKS } from '../data/balance.js';
import { available } from './Economy.js';

export function updateNeeds(world, citizen, ticks) {
  if (Math.floor(world.worldTimeTick / NEED_HOUR_TICKS) ===
      Math.floor((world.worldTimeTick - ticks) / NEED_HOUR_TICKS)) return;
  citizen.hunger = Math.min(100, citizen.hunger + FOOD_HUNGER_PER_HOUR);
  const resting = citizen.action.kind === 'sleep';
  const delta = resting ? -NEEDS.restPerHour : NEEDS.fatiguePerHour;
  citizen.fatigue = Math.max(0, Math.min(100, citizen.fatigue + delta));
  if (citizen.hunger === 100) citizen.hp = Math.max(0, citizen.hp - NEEDS.starvationDamage);
}

export function eat(citizen, store) {
  if (citizen.hunger < NEEDS.eat || available(store, 'food') < FOOD_PER_MEAL) return false;
  store.total.food -= FOOD_PER_MEAL;
  citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
  return true;
}

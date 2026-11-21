import { FOOD_HUNGER_PER_HOUR, FOOD_HUNGER_RESTORED, FOOD_PER_MEAL, NEEDS, NEED_HOUR_TICKS } from '../data/balance.js';
import { available } from './Economy.js';

export function updateNeeds(world, citizen, ticks) {
  if (Math.floor(world.worldTimeTick / NEED_HOUR_TICKS) ===
      Math.floor((world.worldTimeTick - ticks) / NEED_HOUR_TICKS)) return;
  citizen.hunger = Math.min(100, citizen.hunger + FOOD_HUNGER_PER_HOUR);
  const resting = citizen.action.kind === 'sleep';
  const delta = resting ? -NEEDS.restPerHour : NEEDS.fatiguePerHour;
  citizen.fatigue = Math.max(0, Math.min(100, citizen.fatigue + delta));
  if (resting && citizen.hunger < NEEDS.eat) {
    citizen.hp = Math.min(100, citizen.hp + NEEDS.healingPerHour);
  }
  if (citizen.hunger === 100) citizen.hp = Math.max(0, citizen.hp - NEEDS.starvationDamage);
}

export function eat(citizen, store) {
  if (citizen.hunger < NEEDS.eat || available(store, 'food') < FOOD_PER_MEAL) return false;
  store.total.food -= FOOD_PER_MEAL;
  citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
  return true;
}

export function shareEmergencyMeals(world) {
  const shortages = new Set(world.settlements.filter(settlement => settlement.foodWarning).map(s => s.id));
  if (!shortages.size) return;
  const availableDonors = world.citizens.filter(c => c.alive && c.hp > 0 && shortages.has(c.settlementId) &&
    c.profession === 'farmer' && c.inventory.food >= 2 * FOOD_PER_MEAL &&
    (c.action.kind === 'idle' || c.action.kind === 'haul'));
  if (!availableDonors.length) return;
  const hungry = world.citizens.filter(c => c.alive && c.hp > 0 && shortages.has(c.settlementId) &&
    c.hunger >= 95 && c.inventory.food < FOOD_PER_MEAL);
  hungry.sort((a, b) => b.hunger - a.hunger || a.hp - b.hp);
  for (const citizen of hungry) {
    const { x, y } = citizen.lastKnownSafeTile;
    const donor = availableDonors.find(other => other.settlementId === citizen.settlementId &&
      other.inventory.food >= 2 * FOOD_PER_MEAL &&
      Math.abs(x - other.lastKnownSafeTile.x) + Math.abs(y - other.lastKnownSafeTile.y) <= 1);
    if (!donor) continue;
    donor.inventory.food -= FOOD_PER_MEAL;
    citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
  }
}

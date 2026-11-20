import { TICKS_PER_STEP_AT_1X } from '../data/balance.js';

export const FAR_DISTANCE = 48;
export const FAR_MOVEMENT_STEPS = 4;
export const LIFE_CREATION_LIMIT = 300;

export function batchesMovement(kind) {
  return kind === 'explore' || kind === 'haul' || kind === 'gather';
}

export function movementBudget(citizen, camera, work) {
  const { action } = citizen;
  const previous = action.deferredMovement ?? 0;
  const budget = previous + work;
  const far = camera && Math.max(Math.abs(citizen.x - camera.x), Math.abs(citizen.y - camera.y)) > FAR_DISTANCE;
  if (far && batchesMovement(action.kind) && (action.kind === 'explore' || action.path.length > 1) && budget < TICKS_PER_STEP_AT_1X * FAR_MOVEMENT_STEPS) {
    action.deferredMovement = budget;
    return 0;
  }
  if (previous) delete action.deferredMovement;
  return budget;
}

import { DECISION_TICKS, WALK_TICKS, WANDER_RADIUS, TERRAIN_COST } from '../data/balance.js';
import { random } from '../engine/random.js';
import { findPath } from './path.js';

const tileOf = citizen => ({ x: Math.floor(citizen.x), y: Math.floor(citizen.y) });
const idle = tick => ({ kind: 'idle', phase: 'plan', targetId: null, startedAt: tick, progress: 0 });

function chooseRoute(world, citizen) {
  const { x, y } = world.settlements[0];
  const offset = () => Math.floor(random(world.rngState) * (2 * WANDER_RADIUS + 1)) - WANDER_RADIUS;
  const goal = { x: x + offset(), y: y + offset() };
  const path = findPath(world, tileOf(citizen), goal);
  citizen.decisionAt += DECISION_TICKS;
  if (path?.length) {
    citizen.action = { kind: 'explore', phase: 'travel', targetId: null,
      startedAt: world.worldTimeTick, progress: 0, path, goal,
      navigationVersion: world.map.navigationVersion };
  }
}

export function updateCitizens(world, ticks) {
  for (const citizen of world.citizens) {
    if (!citizen.alive) continue;
    if (citizen.action.phase === 'travel' &&
        citizen.action.navigationVersion !== world.map.navigationVersion) {
      const safe = citizen.lastKnownSafeTile;
      citizen.x = safe.x + 0.5;
      citizen.y = safe.y + 0.5;
      const path = findPath(world, safe, citizen.action.goal);
      if (path?.length) {
        Object.assign(citizen.action, { path, progress: 0, navigationVersion: world.map.navigationVersion });
      } else {
        citizen.action = idle(world.worldTimeTick);
      }
    }

    if (world.worldTimeTick >= citizen.decisionAt && citizen.action.phase === 'plan') {
      citizen.decisionAt = world.worldTimeTick + (citizen.decisionAt - world.worldTimeTick) % DECISION_TICKS;
      chooseRoute(world, citizen);
    }

    let remaining = ticks;
    while (remaining > 0 && citizen.action.phase === 'travel') {
      const action = citizen.action;
      const [target] = action.path;
      const safe = citizen.lastKnownSafeTile;
      const cost = TERRAIN_COST[world.map.terrain[target.y * world.map.width + target.x]];
      const duration = cost * WALK_TICKS;
      const used = Math.min(remaining, duration - action.progress);
      action.progress += used;
      remaining -= used;
      const fraction = action.progress / duration;
      citizen.x = safe.x + 0.5 + (target.x - safe.x) * fraction;
      citizen.y = safe.y + 0.5 + (target.y - safe.y) * fraction;
      if (action.progress === duration) {
        citizen.lastKnownSafeTile = action.path.shift();
        action.progress = 0;
        if (!action.path.length) citizen.action = idle(world.worldTimeTick);
      }
    }
  }
}

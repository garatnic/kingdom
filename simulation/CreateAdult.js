import { LAYOUT, citizenRaces, TIME_TICKS_PER_YEAR } from '../data/balance.js';
import { random } from '../engine/random.js';
import { resources } from './Economy.js';
import { lifespan, nextId, professions } from './Identity.js';

export function createAdult(world, race, tile, settlement) {
  const id = nextId(world, 'citizen');
  const number = Number(id.split(':')[1]);
  const [min, max] = LAYOUT.age;
  const age = min + Math.floor(random(world.rngState) * (max - min + 1));
  const stats = ['diligence', 'bravery', 'curiosity', 'magicAffinity'];
  const traits = Object.fromEntries(stats.map(stat => [stat, random(world.rngState)]));
  traits.magicAffinity = Math.max(traits.magicAffinity, citizenRaces[race].minMagicAffinity ?? 0);
  const skills = Object.fromEntries(['farming', 'woodcutting', 'mining', 'building', 'combat', 'magic'].map(key => [key, 0]));
  return {
    id, name: `住民 ${number}`, race, birthWorldTimeTick: world.worldTimeTick - age * TIME_TICKS_PER_YEAR,
    lifespanYears: lifespan(world, race), alive: true, sex: 'unspecified', settlementId: settlement?.id ?? null,
    nationId: settlement?.nationId ?? null, homeBuildingId: null, familyId: null, parentIds: [], childIds: [],
    partnerId: null, relationships: {}, x: tile.x + 0.5, y: tile.y + 0.5, hp: 100, hunger: 20,
    fatigue: 10, fear: 0, traits, skills, profession: professions[(number - 1) % professions.length],
    inventory: Object.fromEntries(resources.map(key => [key, 0])), lastKnownSafeTile: tile,
    action: { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 },
    decisionAt: world.worldTimeTick, failedTargets: {}
  };
}

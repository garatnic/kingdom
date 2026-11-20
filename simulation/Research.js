import { emitOnce } from '../systems/History.js';
import { technologies, TECH, civilizationNames, civilizationTransitions } from '../data/technologies.js';
import { ADULT_AGE, NEEDS, MAGIC_AFFINITY_THRESHOLD, NEED_HOUR_TICKS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { available } from './Economy.js';
import { ageYears, nextId } from './Identity.js';

const civilizationOrder = Object.keys(civilizationNames);
const crosses = (now, ticks, duration) => Math.floor(now / duration) > Math.floor((now - ticks) / duration);

export function researchOwner(world, settlement) {
  const id = settlement.researchOwnerId ?? settlement.nationId ?? settlement.id;
  return world.nations.find(n => n.id === id) ?? settlement;
}

export function getResearch(world, owner) {
  return world.researchStates.find(state => state.ownerId === owner.id);
}

export function ensureResearch(world, owner, unlockedIds = []) {
  const existing = getResearch(world, owner);
  if (existing) return existing;
  const state = { id: nextId(world, 'research'), ownerId: owner.id, unlockedIds: [...unlockedIds],
    activeTechId: null, progressById: {}, knowledgePoints: 0, civilization: 'primitive',
    civilizationDays: 0, lastUpdateAt: world.worldTimeTick };
  world.researchStates.push(state);
  return state;
}

export function unlocked(world, settlementId, technology) {
  const settlement = world.settlements.find(s => s.id === settlementId);
  return Boolean(settlement && getResearch(world, researchOwner(world, settlement))?.unlockedIds.includes(technology));
}

function localContext(world, owner) {
  const settlements = world.settlements.filter(s => researchOwner(world, s).id === owner.id);
  const ids = new Set(settlements.map(s => s.id));
  const citizens = world.citizens.filter(c => c.alive && ids.has(c.settlementId));
  return { settlements, citizens, affinity: citizens.filter(c => c.traits.magicAffinity >= MAGIC_AFFINITY_THRESHOLD),
    adults: citizens.filter(c => ageYears(world, c) >= ADULT_AGE).length,
    buildings: world.buildings.filter(b => ids.has(b.settlementId)),
    stores: world.stockpiles.filter(s => ids.has(s.settlementId)) };
}

function hasResources(context, requirements) {
  return Object.entries(requirements ?? {}).every(([resource, amount]) =>
    context.stores.reduce((total, store) => total + available(store, resource), 0) >= amount);
}

function eligible(technology, context, state) {
  return (!technology.era || civilizationOrder.indexOf(technology.era) <= civilizationOrder.indexOf(state.civilization)) &&
    (!technology.requires || state.unlockedIds.includes(technology.requires)) &&
    context.citizens.length >= (technology.population ?? 0) &&
    (!technology.building || context.buildings.some(b => b.kind === technology.building)) &&
    (!technology.requiresAffinity || context.affinity.length > 0) &&
    hasResources(context, technology.resources);
}

function advanceCivilization(world, owner, state, context) {
  const rule = civilizationTransitions[state.civilization];
  if (!rule) return;
  const requirements = { ...rule.resources };
  if (rule.foodPerResident) requirements.food = context.citizens.length * rule.foodPerResident;
  const qualifies = state.unlockedIds.includes(rule.technology) &&
    context.citizens.length >= rule.population &&
    (!rule.requiresNation || world.nations.some(nation => nation.id === owner.id)) &&
    Object.entries(rule.buildings).every(([kind, count]) =>
      context.buildings.filter(building => building.kind === kind).length >= count) &&
    hasResources(context, requirements);
  const days = state.civilization === 'primitive' || state.civilizationTarget === rule.to ? state.civilizationDays : 0;
  state.civilizationTarget = rule.to;
  state.civilizationDays = qualifies ? days + 1 : 0;
  if (state.civilizationDays < rule.days) return;

  const previous = state.civilization;
  state.civilization = rule.to;
  state.civilizationDays = 0;
  delete state.civilizationTarget;
  emitOnce(world, state.id + '/' + rule.to, 'civilizationAdvanced', {
    ownerId: owner.id, researchId: state.id, previous, civilization: rule.to
  });
}

const canReceiveHealing = c => c.action.kind === 'sleep' && c.action.phase === 'perform' &&
  c.hunger < NEEDS.eat && c.hp < NEEDS.recoveryHp;

function restoreResidents(context) {
  const patients = context.citizens.filter(canReceiveHealing).sort((a, b) => a.hp - b.hp);
  const treated = new Set();
  for (const caster of context.affinity) {
    if (caster.mp < TECH.restorationMp || caster.action.kind !== 'sleep' ||
        caster.action.phase !== 'perform' || caster.hunger >= NEEDS.eat) continue;
    const target = canReceiveHealing(caster) && !treated.has(caster.id) ? caster :
      patients.find(patient => !treated.has(patient.id) && patient.settlementId === caster.settlementId &&
        Math.abs(patient.lastKnownSafeTile.x - caster.lastKnownSafeTile.x) +
        Math.abs(patient.lastKnownSafeTile.y - caster.lastKnownSafeTile.y) <= 3);
    if (!target) continue;
    caster.mp -= TECH.restorationMp;
    target.hp = Math.min(100, target.hp + TECH.restorationHp);
    treated.add(target.id);
  }
}

function updateOwner(world, owner, state, context, daily) {
  const tech = technologies.find(t => t.id === state.activeTechId && eligible(t, context, state)) ??
    technologies.find(t => !state.unlockedIds.includes(t.id) && eligible(t, context, state));
  state.activeTechId = tech?.id ?? null;
  const scholarBonus = tech?.requiresAffinity && context.affinity.length ? 1 : 0;
  const policyBonus = owner.policy?.primary === 'research' ? 1 : 0;
  state.knowledgePoints += 1 + Math.floor(context.adults / 6) + scholarBonus + policyBonus;
  state.lastUpdateAt = world.worldTimeTick;
  if (tech) {
    const progress = state.progressById[tech.id] ?? 0;
    const applied = Math.min(state.knowledgePoints, tech.cost - progress);
    state.knowledgePoints -= applied;
    state.progressById[tech.id] = progress + applied;
    if (state.progressById[tech.id] === tech.cost) {
      state.unlockedIds.push(tech.id);
      state.activeTechId = null;
      emitOnce(world, state.id + '/' + tech.id, 'research_unlocked', {
        ownerId: owner.id, researchId: state.id, technologyId: tech.id
      });
    }
  }
  if (state.unlockedIds.includes('magic_1')) {
    for (const citizen of context.affinity) {
      citizen.skills.magic = Math.max(1, citizen.skills.magic);
      citizen.mp = Math.min(TECH.maxMp, (citizen.mp ?? TECH.maxMp) + TECH.mpRecovery);
    }
    if (state.unlockedIds.includes('restoration_1')) restoreResidents(context);
  }
  if (daily) advanceCivilization(world, owner, state, context);
}

export function updateResearch(world, ticks) {
  if (!crosses(world.worldTimeTick, ticks, NEED_HOUR_TICKS)) return;
  const owners = new Map(world.settlements.map(s => {
    const owner = researchOwner(world, s);
    return [owner.id, owner];
  }));
  const daily = crosses(world.worldTimeTick, ticks, TIME_TICKS_PER_DAY);
  for (const owner of owners.values()) {
    const context = localContext(world, owner);
    if (context.citizens.length) updateOwner(world, owner, ensureResearch(world, owner), context, daily);
  }
}

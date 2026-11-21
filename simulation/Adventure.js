import { emitOnce } from '../systems/History.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { commissionGear, recordAdventureSuccess, trainCombat } from './AdventurerGrowth.js';
import { COMBAT, gear, monsters } from '../data/combat.js';
import { ADULT_AGE, START_REGION_SIZE, FOOD_HUNGER_RESTORED, FOOD_TARGET_PER_PERSON, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { random } from '../engine/random.js';
import { ageYears, nextId } from './Identity.js';
import { available, deposit, storeTile } from './Economy.js';
import { recordDeath } from './Population.js';
import { campaignFor } from './War.js';
import { findPath, reachableTiles } from './path.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tileOf = citizen => citizen.lastKnownSafeTile;
const tileKey = ({ x, y }) => x + ',' + y;

function emit(world, type, quest, tile, extra = {}) {
  emitOnce(world, quest.id, type, { questId: quest.id, settlementId: quest.settlementId,
    x: tile.x, y: tile.y, ...extra });
}

export function spawnMonster(world, species, tile) {
  const config = monsters[species];
  if (!config || world.monsters.filter(m => m.alive && m.species === species).length >= config.cap ||
      !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 ||
      tile.x >= world.map.width || tile.y >= world.map.height ||
      findPath(world, tile, tile) === null ||
      world.monsters.some(m => m.alive && m.x === tile.x && m.y === tile.y)) return null;
  const monster = { id: nextId(world, 'monster'), species, x: tile.x, y: tile.y, alive: true,
    homeTile: { x: tile.x, y: tile.y }, hp: config.hp, maxHp: config.hp, attackAt: 0, moveAt: world.worldTimeTick + config.stepTicks };
  world.monsters.push(monster);
  return monster;
}

function spawnZones(world) {
  const forbidden = new Set();
  const protect = (origin, radius) => {
    for (let dy = 1 - radius; dy < radius; dy++) {
      for (let dx = 1 - radius; dx < radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < radius) {
          forbidden.add(tileKey({ x: origin.x + dx, y: origin.y + dy }));
        }
      }
    }
  };
  for (const settlement of world.settlements) protect(settlement, COMBAT.spawnDistance);
  for (const citizen of world.citizens) {
    if (citizen.alive) protect(tileOf(citizen), COMBAT.residentSafety);
  }
  return forbidden;
}

function spawnAway(world, species, forbidden, habitatOnly = false) {
  const candidates = [];
  const occupied = new Set(world.monsters.filter(m => m.alive).map(tileKey));
  for (let y = 0; y < (world.map.surveyedHeight ?? world.map.height); y++) {
    for (let x = 0; x < (world.map.surveyedWidth ?? world.map.width); x++) {
      const tile = { x, y };
      const terrain = world.map.terrain[y * world.map.width + x];
      const key = tileKey(tile);
      if (!forbidden.has(key) && !occupied.has(key) && terrain !== 'water' &&
          (!habitatOnly || monsters[species].habitat.includes(terrain)) &&
          (!monsters[species].requiresExpansion || x >= START_REGION_SIZE || y >= START_REGION_SIZE)) {
        candidates.push(tile);
      }
    }
  }
  while (candidates.length) {
    const index = Math.floor(random(world.rngState) * candidates.length);
    const monster = spawnMonster(world, species, candidates[index]);
    if (monster) return monster;
    candidates.splice(index, 1);
  }
  return null;
}

function replenishSpecies(world, species, forbidden) {
  const config = monsters[species];
  const population = world.monsters.filter(m => m.alive && m.species === species);
  for (const parent of population) {
    const home = parent.homeTile;
    const homeTerrain = world.map.terrain[home.y * world.map.width + home.x];
    if (world.worldTimeTick < (parent.nextBreedAt ?? 0) || distance(parent, home) > 4 ||
        !config.habitat.includes(homeTerrain) || findPath(world, home, home) === null) continue;
    const colony = population.filter(m => distance(m.homeTile, home) <= 6).length;
    if (colony >= 3 || nestQuestFor(world, parent)?.status === 'claimed') continue;
    const candidates = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tile = { x: home.x + dx, y: home.y + dy };
        if (tile.x < 0 || tile.x >= world.map.width || tile.y < 0 || tile.y >= world.map.height ||
            forbidden.has(tileKey(tile)) ||
            !config.habitat.includes(world.map.terrain[tile.y * world.map.width + tile.x])) continue;
        candidates.push(tile);
      }
    }
    while (candidates.length) {
      const index = Math.floor(random(world.rngState) * candidates.length);
      const newborn = spawnMonster(world, species, candidates.splice(index, 1)[0]);
      if (!newborn) continue;
      newborn.parentMonsterId = parent.id;
      newborn.homeTile = { ...home };
      newborn.hasNest = parent.hasNest = true;
      emitOnce(world, species + '/nest/' + tileKey(home), 'monsterNestFounded', { ...home, species });
      newborn.nextBreedAt = parent.nextBreedAt = world.worldTimeTick + TIME_TICKS_PER_DAY;
      return true;
    }
  }
  // Immigration restores a locally extinct species after a quiet day.
  const lastDeath = world.monsters.reduce((time, m) =>
    m.species === species && !m.alive ? Math.max(time, m.diedAt ?? 0) : time, 0);
  return !population.length && world.worldTimeTick - lastDeath >= TIME_TICKS_PER_DAY &&
    Boolean(spawnAway(world, species, forbidden, true));
}

const activeQuest = quest => quest.status === 'open' || quest.status === 'claimed';
const sameNest = (a, b) => a.species === b.species && distance(a.homeTile, b.homeTile) === 0;

export function assignedAdventure(world, citizen) {
  return world.quests.find(q => q.status === 'claimed' && (q.claimedBy === citizen.id || q.escortId === citizen.id));
}

function nestQuestFor(world, monster) {
  return world.quests.find(q => activeQuest(q) && q.kind === 'clear_nest' &&
    q.species === monster.species && distance(q.nestTile, monster.homeTile) === 0);
}

export function issueQuest(world, settlement, target, allowNest = true) {
  if (!target?.alive || nestQuestFor(world, target) ||
      world.quests.some(q => q.targetId === target.id && activeQuest(q))) {
    return null;
  }
  const quest = { id: nextId(world, 'quest'), kind: 'clear_monsters', settlementId: settlement.id,
    targetId: target.id, rewardFood: COMBAT.rewardFood, status: 'open', claimedBy: null,
    createdAt: world.worldTimeTick, expiresAt: world.worldTimeTick + COMBAT.questDuration, lootIds: [] };
  if (allowNest && target.hasNest && !world.quests.some(q => activeQuest(q) &&
      world.monsters.some(m => m.id === q.targetId && sameNest(m, target)))) {
    Object.assign(quest, { kind: 'clear_nest', species: target.species, nestTile: { ...target.homeTile },
      expiresAt: world.worldTimeTick + COMBAT.questDuration * 2, rewardFood: COMBAT.rewardFood * 2 });
  }
  world.quests.push(quest);
  return quest;
}

function moveMonsters(world) {
  const reserved = new Set(world.monsters.filter(m => m.alive).map(tileKey));
  for (const monster of world.monsters) {
    if (!monster.alive || world.worldTimeTick < monster.moveAt) continue;
    const config = monsters[monster.species];
    monster.moveAt = world.worldTimeTick + config.stepTicks;
    const quest = world.quests.find(q => q.status === 'claimed' && q.targetId === monster.id && q.stage === 'fight');
    const opponent = quest && world.citizens.find(c => c.alive && c.id === quest.claimedBy);
    const distanceToOpponent = opponent ? distance(monster, tileOf(opponent)) : Infinity;
    if (distanceToOpponent <= COMBAT.rangedDistance) continue;
    let tile;
    if (distanceToOpponent <= config.sight) {
      tile = findPath(world, monster, tileOf(opponent))?.[0];
    } else if (distance(monster, monster.homeTile) >= COMBAT.wanderRadius) {
      tile = findPath(world, monster, monster.homeTile)?.[0];
    } else {
      const offsets = [[0, -1], [-1, 0], [1, 0], [0, 1], [0, 0]];
      const [dx, dy] = offsets[Math.floor(random(world.rngState) * offsets.length)];
      const goal = { x: monster.x + dx, y: monster.y + dy };
      tile = findPath(world, goal, goal) === null ? null : goal;
    }
    if (!tile || reserved.has(tileKey(tile)) ||
        world.settlements.some(s => distance(s, tile) < COMBAT.residentSafety)) continue;
    reserved.delete(tileKey(monster));
    Object.assign(monster, tile);
    reserved.add(tileKey(monster));
  }
}

function huntPrey(world) {
  const protectedTargets = new Set(world.quests.filter(q => q.status === 'claimed').map(q => q.targetId));
  for (const predator of world.monsters) {
    const { prey, huntDamage } = monsters[predator.species];
    if (!predator.alive || !prey || protectedTargets.has(predator.id)) continue;
    const target = world.monsters.find(m => m.alive && m.species === prey &&
      !protectedTargets.has(m.id) && nestQuestFor(world, m)?.status !== 'claimed' && distance(predator, m) === 1);
    if (!target) continue;
    target.hp = Math.max(0, target.hp - huntDamage);
    if (target.hp > 0) continue;
    target.alive = false;
    target.diedAt = world.worldTimeTick;
    for (const quest of world.quests) {
      if (quest.targetId !== target.id || quest.status !== 'open') continue;
      const replacement = quest.kind === 'clear_nest' && world.monsters.find(m => m.alive && sameNest(m, target));
      if (replacement) quest.targetId = replacement.id;
      else quest.status = 'expired';
    }
    emitOnce(world, target.id + '/predation', 'monsterPredation', {
      monsterId: target.id, predatorId: predator.id, x: target.x, y: target.y
    });
  }
}

export function updateAdventureWorld(world, ticks) {
  const now = world.worldTimeTick;
  const first = world.nextMonsterSpawnTick === undefined;
  if (first) {
    const forbidden = spawnZones(world);
    for (const [species, config] of Object.entries(monsters)) {
      if (config.requiresExpansion) continue;
      for (let i = 0; i < config.cap; i++) {
        if (world.monsters.filter(m => m.alive && m.species === species).length >= config.cap) break;
        if (!spawnAway(world, species, forbidden)) break;
      }
    }
    world.nextMonsterSpawnTick = now + COMBAT.spawnInterval;
  } else if (now >= world.nextMonsterSpawnTick) {
    world.nextMonsterSpawnTick += COMBAT.spawnInterval;
    const expanded = (world.map.surveyedWidth ?? world.map.width) > START_REGION_SIZE ||
      (world.map.surveyedHeight ?? world.map.height) > START_REGION_SIZE;
    const candidates = Object.keys(monsters).filter(key => {
      const config = monsters[key];
      return (!config.requiresExpansion || expanded) && world.monsters.filter(m => m.alive && m.species === key).length < config.cap;
    });
    if (candidates.length) {
      const forbidden = spawnZones(world);
      candidates.some(species => replenishSpecies(world, species, forbidden));
    }
  }

  for (const quest of world.quests) {
    if (quest.status === 'open' && now >= quest.expiresAt) quest.status = 'expired';
    if (quest.status !== 'claimed') continue;
    const citizen = world.citizens.find(c => c.alive && c.id === quest.claimedBy);
    if (!citizen) {
      quest.status = 'failed';
    } else if (now >= quest.expiresAt && quest.stage !== 'return') {
      quest.stage = 'return';
      quest.retreated = true;
      citizen.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: now, progress: 0 };
      citizen.x = citizen.lastKnownSafeTile.x + 0.5;
      citizen.y = citizen.lastKnownSafeTile.y + 0.5;
      citizen.decisionAt = now;
    } else if (now >= quest.expiresAt + TIME_TICKS_PER_DAY) {
      quest.status = 'failed';
    }
  }
  moveMonsters(world);
  const day = Math.floor(now / TIME_TICKS_PER_DAY) > Math.floor((now - ticks) / TIME_TICKS_PER_DAY);
  if (day) huntPrey(world);
  if (!first && !day) return;
  for (const settlement of world.settlements) {
    let slots = COMBAT.questLimit - world.quests.filter(q => q.settlementId === settlement.id && activeQuest(q)).length;
    if (slots <= 0) continue;
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    const origin = store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;
    const nearby = world.monsters.filter(m => m.alive && distance(m, settlement) <= COMBAT.questRadius);
    if (!nearby.length) continue;
    const connected = reachableTiles(world, origin, undefined, nearby.map(m => m.y * world.map.width + m.x));
    const enemies = nearby.filter(m => connected[m.y * world.map.width + m.x] === 1)
      .sort((a, b) => distance(a, settlement) - distance(b, settlement));
    const raidsAvailable = world.buildings.some(b => b.kind === 'guild' && b.settlementId === settlement.id) &&
      world.citizens.filter(c => c.alive && c.settlementId === settlement.id).length >= 16;
    for (const enemy of enemies) {
      if (slots <= 0) break;
      if (issueQuest(world, settlement, enemy, raidsAvailable)) slots--;
    }
  }
}

function approach(world, citizen, monster) {
  const current = tileOf(citizen);
  if (distance(current, monster) <= COMBAT.rangedDistance) return current;
  const tiles = [{ x: monster.x - 1, y: monster.y }, { x: monster.x + 1, y: monster.y },
    { x: monster.x, y: monster.y - 1 }, { x: monster.x, y: monster.y + 1 }];
  let best = null;
  let length = Infinity;
  for (const goal of tiles) {
    const path = findPath(world, current, goal);
    if (path !== null && path.length < length) {
      best = goal;
      length = path.length;
    }
  }
  return best;
}

export function claimAdventure(world, citizen, store, travel) {
  if (citizen.profession !== 'adventurer' || assignedAdventure(world, citizen) ||
      campaignFor(world, citizen) || ageYears(world, citizen) < ADULT_AGE ||
      citizen.hp <= COMBAT.retreatHp || citizen.hunger >= NEEDS.eat ||
      citizen.fatigue >= NEEDS.sleep || available(store, 'food') < 1) return false;
  for (const quest of world.quests) {
    if (quest.status !== 'open' || quest.settlementId !== citizen.settlementId) continue;
    const monster = world.monsters.find(m => m.id === quest.targetId && m.alive);
    if (!monster || distance(storeTile(world, store), monster) > COMBAT.questRadius) continue;
    const goal = approach(world, citizen, monster);
    if (!goal || !travel(goal, 'adventure', quest.id)) continue;
    commissionGear(world, citizen, store);
    store.total.food--;
    citizen.inventory.food++;
    quest.status = 'claimed';
    quest.claimedBy = citizen.id;
    quest.stage = 'fight';
    quest.strikeAt = null;
    quest.provision = 1;
    if (quest.kind === 'clear_nest' && available(store, 'food') >= 1) {
      const escort = world.citizens.find(c => c !== citizen && c.alive && c.settlementId === citizen.settlementId &&
        ageYears(world, c) >= ADULT_AGE && c.profession === 'adventurer' && c.action.kind === 'idle' && c.hp >= 70 &&
        c.hunger < NEEDS.eat && c.fatigue < NEEDS.sleep && !c.expeditionId &&
        c.id !== world.nations.find(n => n.id === c.nationId)?.leaderId &&
        !world.inTransit.some(item => item.carrierId === c.id) &&
        !assignedAdventure(world, c) && !campaignFor(world, c) && approach(world, c, monster));
      if (escort) {
        quest.escortId = escort.id;
        store.total.food--;
        escort.inventory.food++;
        emit(world, 'cooperativeExpedition', quest, tileOf(citizen), { actorIds: [citizen.id, escort.id] });
      }
    }
    emit(world, 'adventureDeparted', quest, tileOf(citizen), { citizenId: citizen.id });
    return true;
  }
  return false;
}

function damage(world, attack, defense) {
  return Math.max(1, Math.floor(attack * (0.9 + random(world.rngState) * 0.2) - defense * 0.5));
}

function defeat(world, citizen, quest, monster) {
  const config = monsters[monster.species];
  monster.alive = false;
  monster.diedAt = world.worldTimeTick;
  trainCombat(world, citizen, quest, config.xp);
  for (const [resource, chance] of config.loot) {
    if (random(world.rngState) >= chance) continue;
    const node = { id: nextId(world, 'node'), resource, quantity: 1, x: monster.x, y: monster.y, dropped: true, questId: quest.id };
    world.resourceNodes.push(node);
    quest.lootIds.push(node.id);
  }
  quest.stage = 'loot';
  emitOnce(world, quest.id + '/' + monster.id, 'monsterDefeated', { questId: quest.id,
    settlementId: quest.settlementId, x: monster.x, y: monster.y, citizenId: citizen.id, monsterId: monster.id });
}

export function continueAdventure(world, citizen, quest, store, origin, travel) {
  if (quest?.status !== 'claimed' || !store) return false;
  const monster = world.monsters.find(m => m.id === quest.targetId);
  const position = tileOf(citizen);
  if (quest.escortId === citizen.id) {
    if (citizen.hp <= COMBAT.retreatHp || citizen.fear >= COMBAT.fearRetreat || citizen.hunger >= NEEDS.eat ||
        (monster?.alive && distance(origin, monster) > COMBAT.questRadius)) quest.escortRetreated = true;
    if (quest.escortRetreated || quest.stage === 'return') {
      if (distance(position, origin) > 0) return travel(origin, 'adventure', quest.id);
      if (!quest.escortReturned && !quest.escortAteProvision && citizen.inventory.food > 0) {
        citizen.inventory.food--;
        citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
      }
      quest.escortReturned = true;
      deposit(citizen, store, world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length * FOOD_TARGET_PER_PERSON);
      return true;
    }
    if (quest.stage !== 'fight' || !monster?.alive || distance(position, monster) <= COMBAT.rangedDistance) return true;
    const goal = approach(world, citizen, monster);
    return Boolean(goal && travel(goal, 'adventure', quest.id));
  }
  if (quest.claimedBy !== citizen.id) return false;
  const escort = quest.escortId && world.citizens.find(c => c.id === quest.escortId && c.alive);
  const canCast = citizen.skills.magic > 0 && (citizen.mp ?? 0) >= TECH.spellMp &&
    world.worldTimeTick >= (citizen.spellReadyAt ?? 0) && unlocked(world, citizen.settlementId, 'magic_1');
  const spell = quest.casting === true || canCast;
  const range = spell ? TECH.spellRange : COMBAT.rangedDistance;
  if (quest.stage === 'fight') {
    const cutoff = COMBAT.retreatHp - (COMBAT.retreatHp - COMBAT.braveRetreatHp) * citizen.traits.bravery;
    if (citizen.hp <= cutoff || citizen.fear >= COMBAT.fearRetreat || citizen.hunger >= NEEDS.eat ||
        !monster?.alive || distance(origin, monster) > COMBAT.questRadius) {
      quest.stage = 'return';
      quest.retreated = true;
    } else if (distance(position, monster) > range) {
      quest.casting = false;
      quest.strikeAt = null;
      const goal = approach(world, citizen, monster);
      if (goal && travel(goal, 'adventure', quest.id)) return true;
      quest.stage = 'return';
      quest.retreated = true;
    } else {
      const config = monsters[monster.species];
      if (quest.strikeAt === null) {
        quest.casting = spell;
        quest.strikeAt = world.worldTimeTick + (spell ? TECH.spellCastTicks : COMBAT.strikeDelay);
      }
      if (world.worldTimeTick >= quest.strikeAt) {
        if (quest.casting) {
          citizen.mp -= TECH.spellMp;
          citizen.spellReadyAt = world.worldTimeTick + TECH.spellCooldownTicks;
        }
        const weapon = unlocked(world, citizen.settlementId, 'weapons_1') ? TECH.weaponBonus : 0;
        const steel = !quest.casting && unlocked(world, citizen.settlementId, 'steel_1') ? TECH.steelWeaponBonus : 0;
        const arcane = quest.casting && unlocked(world, citizen.settlementId, 'magic_2') ? TECH.arcaneSpellBonus : 0;
        const attack = quest.casting ? TECH.spellAttack + arcane : COMBAT.attack + citizen.skills.combat + weapon + steel + (gear[citizen.gearId]?.attack ?? 0);
        if (quest.casting || distance(position, monster) <= COMBAT.rangedDistance) {
          const support = escort && !quest.escortRetreated && escort.hp > COMBAT.retreatHp &&
            distance(tileOf(escort), monster) <= COMBAT.rangedDistance;
          const bonus = support ? Math.floor(COMBAT.attack / 2) + escort.skills.combat : 0;
          if (support) quest.escortContributed = true;
          monster.hp = Math.max(0, monster.hp - damage(world, attack + bonus, config.defense));
        }
        quest.casting = false;
        quest.strikeAt = world.worldTimeTick + COMBAT.interval;
        if (monster.hp === 0) defeat(world, citizen, quest, monster);
      }
      if (monster.alive && distance(position, monster) <= COMBAT.rangedDistance && world.worldTimeTick >= monster.attackAt) {
        citizen.hp = Math.max(0, citizen.hp - damage(world, config.attack, COMBAT.defense + (gear[citizen.gearId]?.defense ?? 0)));
        monster.attackAt = world.worldTimeTick + COMBAT.interval;
        if (!citizen.hp) {
          recordDeath(world, citizen, 'combat');
          quest.status = 'failed';
          return false;
        }
      }
      if (quest.stage === 'fight') return true;
    }
  }
  if (quest.stage === 'loot') {
    const remains = world.resourceNodes.filter(node => quest.lootIds.includes(node.id) && node.quantity > 0);
    const node = remains[0];
    if (node && distance(position, node) > 0 && travel(node, 'adventure', quest.id)) return true;
    for (const item of remains) {
      if (distance(position, item) > 0) continue;
      citizen.inventory[item.resource] += item.quantity;
      item.quantity = 0;
    }
    const next = quest.kind === 'clear_nest' && world.monsters.find(m => m.alive && sameNest(m, monster));
    if (next) {
      quest.targetId = next.id;
      quest.stage = 'fight';
      quest.strikeAt = null;
      return true;
    }
    if (quest.kind === 'clear_nest') {
      emit(world, 'monsterNestCleared', quest, quest.nestTile, { citizenId: citizen.id, species: quest.species });
    }
    quest.stage = 'return';
  }
  if (distance(position, origin) > 0) return travel(origin, 'adventure', quest.id);
  if (escort && !quest.escortReturned && world.worldTimeTick < quest.expiresAt + TIME_TICKS_PER_DAY / 2) return true;
  const hasProvision = quest.provision && citizen.inventory.food > 0;
  if (hasProvision) {
    citizen.inventory.food--;
    citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
    quest.provision = 0;
  }
  const population = world.citizens.filter(c => c.alive && c.settlementId === citizen.settlementId).length;
  deposit(citizen, store, population * FOOD_TARGET_PER_PERSON);
  if (!quest.retreated && available(store, 'food') >= quest.rewardFood) {
    store.total.food -= quest.rewardFood;
    citizen.inventory.food += quest.rewardFood;
  } else if (!quest.retreated) {
    quest.unpaidFood = quest.rewardFood;
  }
  quest.status = quest.retreated ? 'retreated' : 'completed';
  if (!quest.retreated) {
    recordAdventureSuccess(world, citizen, quest);
    if (escort && quest.escortReturned && quest.escortContributed && !quest.escortRetreated) recordAdventureSuccess(world, escort, quest);
  }
  emit(world, 'adventureReturned', quest, origin, { citizenId: citizen.id, retreated: Boolean(quest.retreated) });
  return false;
}

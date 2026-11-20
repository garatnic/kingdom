import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { COMBAT, monsters } from '../data/combat.js';
import { ADULT_AGE, FOOD_HUNGER_RESTORED, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { random } from '../engine/random.js';
import { ageYears, nextId } from './Identity.js';
import { available, deposit } from './Economy.js';
import { recordDeath } from './Population.js';
import { findPath } from './path.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tileOf = citizen => citizen.lastKnownSafeTile;
const tileKey = ({ x, y }) => x + ',' + y;

function emit(world, type, quest, tile, extra = {}) {
  world.events.push({ id: nextId(world, 'event'), type, questId: quest.id,
    worldTimeTick: world.worldTimeTick, x: tile.x, y: tile.y, ...extra });
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

function spawnAway(world, species) {
  const candidates = [];
  const occupied = new Set(world.monsters.filter(m => m.alive).map(tileKey));
  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      const tile = { x, y };
      const safe = world.settlements.every(s => distance(s, tile) >= COMBAT.spawnDistance) &&
        world.citizens.every(c => !c.alive || distance(tileOf(c), tile) >= COMBAT.residentSafety);
      if (safe && !occupied.has(tileKey(tile)) && world.map.terrain[y * world.map.width + x] !== 'water') {
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

export function issueQuest(world, settlement, target) {
  if (!target?.alive || world.quests.some(q => q.targetId === target.id && ['open', 'claimed'].includes(q.status))) {
    return null;
  }
  const quest = { id: nextId(world, 'quest'), kind: 'clear_monsters', settlementId: settlement.id,
    targetId: target.id, rewardFood: COMBAT.rewardFood, status: 'open', claimedBy: null,
    createdAt: world.worldTimeTick, expiresAt: world.worldTimeTick + COMBAT.questDuration, lootIds: [] };
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

export function updateAdventureWorld(world, ticks) {
  const now = world.worldTimeTick;
  const first = world.nextMonsterSpawnTick === undefined;
  if (first) {
    for (const [species, config] of Object.entries(monsters)) {
      for (let i = 0; i < config.cap; i++) {
        if (world.monsters.filter(m => m.alive && m.species === species).length >= config.cap) break;
        if (!spawnAway(world, species)) break;
      }
    }
    world.nextMonsterSpawnTick = now + COMBAT.spawnInterval;
  } else if (now >= world.nextMonsterSpawnTick) {
    world.nextMonsterSpawnTick += COMBAT.spawnInterval;
    const species = Object.keys(monsters).find(key => world.monsters.filter(m => m.alive && m.species === key).length < monsters[key].cap);
    if (species) spawnAway(world, species);
  }

  for (const quest of world.quests) {
    if (quest.status === 'open' && now >= quest.expiresAt) quest.status = 'expired';
    if (quest.status === 'claimed' && !world.citizens.some(c => c.alive && c.id === quest.claimedBy)) {
      quest.status = 'failed';
    }
  }
  moveMonsters(world);
  const day = Math.floor(now / TIME_TICKS_PER_DAY) > Math.floor((now - ticks) / TIME_TICKS_PER_DAY);
  if (!first && !day) return;
  for (const settlement of world.settlements) {
    const store = world.stockpiles.find(s => s.settlementId === settlement.id);
    const origin = store?.x === undefined ? { x: settlement.x + 1, y: settlement.y } : store;
    const enemies = world.monsters.filter(m => m.alive && findPath(world, origin, m) !== null)
      .sort((a, b) => distance(a, settlement) - distance(b, settlement));
    let slots = COMBAT.questLimit - world.quests.filter(q => q.settlementId === settlement.id &&
      ['open', 'claimed'].includes(q.status)).length;
    for (const enemy of enemies) {
      if (slots <= 0) break;
      if (issueQuest(world, settlement, enemy)) slots--;
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
  if (citizen.profession !== 'adventurer' || ageYears(world, citizen) < ADULT_AGE ||
      citizen.hp <= COMBAT.retreatHp || citizen.hunger >= NEEDS.eat ||
      citizen.fatigue >= NEEDS.sleep || available(store, 'food') < 1) return false;
  for (const quest of world.quests) {
    if (quest.status !== 'open' || quest.settlementId !== citizen.settlementId) continue;
    const monster = world.monsters.find(m => m.id === quest.targetId && m.alive);
    const goal = monster && approach(world, citizen, monster);
    if (!goal || !travel(goal, 'adventure', quest.id)) continue;
    store.total.food--;
    citizen.inventory.food++;
    quest.status = 'claimed';
    quest.claimedBy = citizen.id;
    quest.stage = 'fight';
    quest.strikeAt = null;
    quest.provision = 1;
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
  const bonus = (citizen.combatXp ?? 0) + config.xp;
  const nextLevel = citizen.skills.combat + 1;
  if (nextLevel <= COMBAT.maxLevel && bonus >= COMBAT.xpPerLevel * nextLevel) {
    citizen.skills.combat = nextLevel;
    citizen.combatXp = bonus - COMBAT.xpPerLevel * nextLevel;
  } else {
    citizen.combatXp = bonus;
  }
  for (const [resource, chance] of config.loot) {
    if (random(world.rngState) >= chance) continue;
    const node = { id: nextId(world, 'node'), resource, quantity: 1, x: monster.x, y: monster.y, dropped: true };
    world.resourceNodes.push(node);
    quest.lootIds.push(node.id);
  }
  quest.stage = 'loot';
  emit(world, 'monsterDefeated', quest, monster, { citizenId: citizen.id, monsterId: monster.id });
}

export function continueAdventure(world, citizen, quest, store, origin, travel) {
  if (quest?.status !== 'claimed' || quest.claimedBy !== citizen.id || !store) return false;
  const monster = world.monsters.find(m => m.id === quest.targetId);
  const position = tileOf(citizen);
  const canCast = citizen.skills.magic > 0 && (citizen.mp ?? 0) >= TECH.spellMp &&
    world.worldTimeTick >= (citizen.spellReadyAt ?? 0) && unlocked(world, citizen.settlementId, 'magic_1');
  const spell = quest.casting === true || canCast;
  const range = spell ? TECH.spellRange : COMBAT.rangedDistance;
  if (quest.stage === 'fight') {
    const cutoff = COMBAT.retreatHp - (COMBAT.retreatHp - COMBAT.braveRetreatHp) * citizen.traits.bravery;
    if (citizen.hp <= cutoff || citizen.fear >= COMBAT.fearRetreat || !monster?.alive) {
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
        const attack = quest.casting ? TECH.spellAttack : COMBAT.attack + citizen.skills.combat + weapon;
        if (quest.casting || distance(position, monster) <= COMBAT.rangedDistance) {
          monster.hp = Math.max(0, monster.hp - damage(world, attack, config.defense));
        }
        quest.casting = false;
        quest.strikeAt = world.worldTimeTick + COMBAT.interval;
        if (monster.hp === 0) defeat(world, citizen, quest, monster);
      }
      if (monster.alive && distance(position, monster) <= COMBAT.rangedDistance && world.worldTimeTick >= monster.attackAt) {
        citizen.hp = Math.max(0, citizen.hp - damage(world, config.attack, COMBAT.defense));
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
    quest.stage = 'return';
  }
  if (distance(position, origin) > 0) return travel(origin, 'adventure', quest.id);
  const hasProvision = quest.provision && citizen.inventory.food > 0;
  if (hasProvision) {
    citizen.inventory.food--;
    citizen.hunger = Math.max(0, citizen.hunger - FOOD_HUNGER_RESTORED);
    quest.provision = 0;
  }
  deposit(citizen, store);
  if (!quest.retreated && available(store, 'food') >= quest.rewardFood) {
    store.total.food -= quest.rewardFood;
    citizen.inventory.food += quest.rewardFood;
  } else if (!quest.retreated) {
    quest.unpaidFood = quest.rewardFood;
  }
  quest.status = quest.retreated ? 'retreated' : 'completed';
  emit(world, 'adventureReturned', quest, origin, { citizenId: citizen.id, retreated: Boolean(quest.retreated) });
  return false;
}

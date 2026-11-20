import { citizenRaces } from '../data/balance.js';
import { adventurerRanks, gear } from '../data/combat.js';
import { adventurerRank } from '../simulation/AdventurerGrowth.js';
import { civilizationNames } from '../data/technologies.js';
import { calendar } from '../engine/GameLoop.js';
import { ageYears } from '../simulation/Identity.js';
import { eventImportance, historyFor } from '../systems/History.js';

const events = {
  terrainCorrection: '地形の生成補正', adventureDeparted: '討伐に出発', adventureReturned: '討伐から帰還',
  constructionCompleted: '施設が完成', monsterDefeated: '魔物を討伐', borderFriction: '国境摩擦',
  marriage: '婚姻', birth: '誕生', independentExpedition: '独立開拓に出発',
  settlementFounded: '集落が成立', god_intervention: '神の介入', founding: '建国',
  adventurerRankUp: '冒険者の称号を獲得', combatLevelUp: '戦闘技能が上昇', adventurerEquipped: '冒険者の装備を新調',
  warDeclared: '開戦', siegeStarted: '包囲開始', territoryOccupied: '集落を占領', siegeRepelled: '侵攻を撃退', nationFallen: '国家が滅亡',
  frontierDiscovered: '新しい土地を発見', research_unlocked: '研究を解禁', death: '死亡', civilizationAdvanced: '文明時代が進展'
};
const jobs = { farmer: '農民', woodcutter: '木こり', miner: '鉱夫', builder: '建築家', adventurer: '冒険者' };
const actions = {
  idle: '待機', explore: '探索', survey: '境界を調査', warMarch: '遠征隊で進軍', eat: '食事', sleep: '睡眠', gather: '採集', haul: '運搬',
  farm: '収穫', build: '建築', pickUpMaterials: '資材引取', deliverMaterials: '資材搬入',
  recoverMaterials: '資材回収', adventure: '冒険', expedition: '開拓'
};
const resources = { food: '食料', wood: '木材', stone: '石材', iron: '鉄', manaStone: '魔石' };

export function eventLocation(world, event) {
  if (Number.isFinite(event.x) && Number.isFinite(event.y)) return { x: event.x + 0.5, y: event.y + 0.5 };
  const nation = world.nations.find(n => n.id === (event.nationId ?? event.ownerId));
  const settlement = world.settlements.find(s => s.id === (nation?.capitalId ?? event.settlementId ?? event.ownerId));
  if (settlement) return { x: settlement.x + 0.5, y: settlement.y + 0.5 };
  return world.citizens.find(c => c.id === (event.citizenId ?? event.actorIds?.[0]));
}

const get = id => document.getElementById(id);
const add = (target, element, text) => {
  const node = document.createElement(element);
  node.textContent = text;
  target.append(node);
  return node;
};

export function observation(getWorld, getCamera, focus) {
  const tab = get('history-tab');
  const subjects = get('history-subject');
  const body = get('history-body');
  let previousRender = '';
  let observedEvent = '';
  let eventAt = -Infinity;
  let currentEvent = null;
  let suspendedAt = null;
  const seen = new Set();

  function render(force = false) {
    const world = getWorld();
    const mode = tab.value;
    const cutoff = Math.floor(world.worldTimeTick / 120);
    const key = [mode, subjects.value, cutoff, world.events.at(-1)?.id, world.citizens.length, world.nations.length].join('/');
    if (!force && key === previousRender) return;
    previousRender = key;
    const citizenMode = mode === 'citizen' || mode === 'family';
    const choices = citizenMode ? world.citizens : mode === 'nation' ? world.nations : [];
    const selected = subjects.value;
    subjects.replaceChildren(...choices.map(c => new Option(c.name, c.id)));
    subjects.hidden = choices.length === 0;
    if (choices.some(c => c.id === selected)) subjects.value = selected;
    get('follow').hidden = !subjects.value;
    body.replaceChildren();
    if (mode === 'world') {
      const list = historyFor(world, 'world').slice(-20).reverse();
      if (!list.length) add(body, 'p', '出来事はまだありません。');
      for (const event of list) showEvent(world, event);
      return;
    }

    const person = world.citizens.find(c => c.id === subjects.value);
    const nation = world.nations.find(n => n.id === subjects.value);
    if (person) {
      add(body, 'h3', person.name);
      add(body, 'p', `${citizenRaces[person.race]?.label} · ${ageYears(world, person)}歳 · ${person.alive ? jobs[person.profession] ?? '未成年' : '死亡'}`);
      const settlement = world.settlements.find(s => s.id === person.settlementId);
      if (settlement) add(body, 'p', `集落 ${settlement.id} / ${world.nations.find(n => n.id === person.nationId)?.name ?? '国家未所属'}`);
      add(body, 'p', `HP ${person.hp} / 空腹 ${person.hunger} / 疲労 ${person.fatigue} · ${actions[person.action.kind] ?? '待機'}`);
      if (person.profession === 'adventurer' || person.adventuresCompleted) {
        add(body, 'p', `${adventurerRanks[adventurerRank(person)]} · 戦闘 Lv.${person.skills.combat} · 討伐達成 ${person.adventuresCompleted ?? 0}回`);
        if (person.gearId) add(body, 'p', gear[person.gearId]?.label ?? person.gearId);
      }
      const inventory = Object.entries(person.inventory).filter(([, qty]) => qty > 0);
      if (inventory.length) add(body, 'p', inventory.map(([key, qty]) => `${resources[key]} ${qty}`).join(' / '));
      if (mode === 'family') {
        const fields = [['親', person.parentIds], ['子', person.childIds], ['配偶者', [person.partnerId].filter(Boolean)]];
        for (const [label, ids] of fields) {
          add(body, 'h4', label);
          if (!ids.length) add(body, 'p', '記録なし');
          for (const id of ids) {
            const member = world.citizens.find(c => c.id === id);
            const button = add(body, 'button', member?.name ?? id);
            button.onclick = () => { subjects.value = id; render(true); };
          }
        }
      } else {
        for (const event of historyFor(world, 'citizen', person.id).slice(-10).reverse()) showEvent(world, event);
      }
    } else if (nation) {
      add(body, 'h3', nation.name + (nation.fallenAt === undefined ? '' : '（滅亡）'));
      add(body, 'p', `人口 ${world.citizens.filter(c => c.alive && c.nationId === nation.id).length}人`);
      const leader = world.citizens.find(c => c.id === nation.leaderId);
      if (leader) add(body, 'p', `指導者 ${leader.name}`);
      const priorities = { food: '農業', housing: '住宅', defense: '防衛', research: '研究', exploration: '探索' };
      add(body, 'p', `主要方針 ${priorities[nation.policy.primary] ?? '選択中'}`);
      const state = world.researchStates.find(item => item.ownerId === nation.id);
      const tech = { farming_1: '農業', building_1: '建築', weapons_1: '武器', magic_1: '魔法', steel_1: '鋼鉄鍛造', irrigation_1: '灌漑', magic_2: '魔法増幅', restoration_1: '治癒術' };
      if (state) add(body, 'p', civilizationNames[state.civilization] ?? state.civilization);
      if (state) add(body, 'p', `解禁研究 ${state.unlockedIds.map(id => tech[id]).join('・') || 'なし'}`);
      for (const event of historyFor(world, 'nation', nation.id).slice(-10).reverse()) showEvent(world, event);
    } else add(body, 'p', '対象がまだありません。');
  }

  function showEvent(world, event) {
    const title = event.type === 'civilizationAdvanced' ? civilizationNames[event.civilization] + 'へ進展' : events[event.type] ?? event.type;
    const label = `${title} · ${calendar(event.worldTimeTick)}`;
    const target = eventLocation(world, event);
    if (!target) { add(body, 'p', label); return; }
    const button = add(body, 'button', label);
    button.onclick = () => {
      markManual();
      focus(target, 'manualOverride');
    };
  }

  tab.onchange = () => render(true);
  subjects.onchange = () => render(true);
  get('follow').onclick = () => {
    const camera = getCamera();
    camera.subjectId = subjects.value;
    suspendedAt = null;
    camera.mode = tab.value === 'nation' ? 'followNation' : 'followCitizen';
  };
  get('auto-camera').onchange = event => {
    const camera = getCamera();
    suspendedAt = null;
    camera.mode = event.target.checked ? 'autoEvent' : 'free';
  };

  get('auto-resume').onchange = event => { getCamera().autoResume = event.target.checked; };

  function markManual() {
    const camera = getCamera();
    if (camera.mode === 'autoEvent' || suspendedAt !== null) suspendedAt = performance.now();
  }

  return {
    render,
    markManual,
    inspectTile(x, y) {
      const citizen = getWorld().citizens.find(c => c.alive && Math.floor(c.x) === x && Math.floor(c.y) === y);
      if (!citizen) return;
      tab.value = 'citizen';
      render(true);
      subjects.value = citizen.id;
      render(true);
    },
    updateCamera(now, elapsed) {
      const world = getWorld();
      const camera = getCamera();
      if (camera.mode === 'manualOverride' && camera.autoResume && suspendedAt !== null &&
          now - suspendedAt >= 60000) {
        camera.mode = 'autoEvent';
        suspendedAt = null;
      }
      get('auto-camera').checked = camera.mode === 'autoEvent';
      get('auto-resume').checked = Boolean(camera.autoResume);
      let target;
      if (camera.mode === 'followCitizen') {
        target = world.citizens.find(c => c.id === camera.subjectId);
        if (!target?.alive) {
          camera.mode = 'free';
          tab.value = 'citizen';
          render(true);
          subjects.value = target?.id ?? '';
          render(true);
          return;
        }
      }
      if (camera.mode === 'followNation') {
        const nation = world.nations.find(n => n.id === camera.subjectId);
        const seat = world.settlements.find(s => s.id === nation?.capitalId);
        if (seat) target = { x: seat.x + 0.5, y: seat.y + 0.5 };
      }
      if (camera.mode === 'autoEvent') {
        const score = event => eventImportance(event) * 10 + 5 +
          (event.citizenId === camera.subjectId ? 8 : 0) - (event.type === currentEvent?.type ? 10 : 0);
        const candidates = world.events.slice(-40).reverse().filter(e =>
          eventImportance(e) >= 4 && !seen.has(e.id) && eventLocation(world, e));
        const candidate = candidates.sort((a, b) => score(b) - score(a))[0];
        if (candidate && candidate.id !== observedEvent &&
            (now - eventAt >= 30000 || eventImportance(candidate) >= 5)) {
          observedEvent = candidate.id;
          seen.add(candidate.id);
          eventAt = now;
          currentEvent = candidate;
        }
        if (currentEvent) target = eventLocation(world, currentEvent);
      }
      if (!target) return;
      const weight = Math.min(1, elapsed / 190);
      camera.x += (target.x - camera.x) * weight;
      camera.y += (target.y - camera.y) * weight;
    },
    reset() {
      previousRender = '';
      observedEvent = '';
      eventAt = -Infinity;
      currentEvent = null;
      suspendedAt = null;
      seen.clear();
    }
  };
}

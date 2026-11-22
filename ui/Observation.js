import { alliedNations, allianceProgress, friendlyNations } from '../simulation/Diplomacy.js';
import { buildings, footprint, workTicks } from '../data/buildings.js';
import { available, freeCapacity } from '../simulation/Economy.js';
import { citizenRaces, MAGIC_AFFINITY_THRESHOLD, FOOD_EMERGENCY_PER_PERSON, FOOD_TARGET_PER_PERSON, NEEDS, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { adventurerRanks, gear, monsters } from '../data/combat.js';
import { adventurerRank } from '../simulation/AdventurerGrowth.js';
import { civilizationNames, TECH, technologies } from '../data/technologies.js';
import { calendar } from '../engine/GameLoop.js';
import { relationLabel } from '../simulation/Nations.js';
import { activeNations, truceBetween } from '../simulation/War.js';
import { civilizationProgress, getResearch, researchOwner } from '../simulation/Research.js';
import { ageYears } from '../simulation/Identity.js';
import { eventImportance, historyFor, involvesCitizen } from '../systems/History.js';

const events = {
  tradeEscortClash: '護衛隊が街道で交戦', tradeEscortDeparted: '交易品の護衛に出発', tradeEscortReturned: '交易品の護衛から帰還',
  allianceFormed: '防衛協定を締結', allianceEnded: '防衛協定を解消',
  internationalTradeCompleted: '友好国間で物資を交換', internationalTradeReturning: '国際交易の荷を返送',
  internationalTradeReturned: '国際交易の荷が発送元へ戻った',
  pactEnvoyArrived: '友好国の使節が到着',
  friendshipReached: '国家間の友好が成立',
  aidReturning: '援助物資の返送を開始', aidReturned: '援助物資が発送元へ戻った',
  foreignFoodAidDelivered: '友好国から食料援助が到着',
  materialAidDelivered: '同じ国の集落から資材が到着',
  manaVeinDiscovered: '協力調査で魔石鉱脈を発見', resourceSurveyDeparted: '資源調査に出発', resourceSurveyReturned: '資源調査を報告',
  terrainCorrection: '地形の生成補正', adventureDeparted: '討伐に出発', adventureReturned: '討伐から帰還',
  healingReceived: '治癒術で住民を治療',
  monsterBound: '拘束魔法で魔物の動きを止めた',
  guildApprenticeAdvanced: 'ギルドの指導で戦闘技能が向上',
  arcaneIrrigationInstalled: '農地に魔導灌漑を設置',
  constructionCompleted: '施設が完成', foodShortage: '集落で食料難', foodRecovered: '集落の食料備蓄が回復', foodAidDelivered: '同じ国の集落から食料が到着', monsterDefeated: '魔物を討伐', monsterThreat: '集落に魔物が接近', monsterPredation: '魔物が別の魔物を捕食', monsterNestFounded: '魔物の巣ができた', monsterNestRelocated: '魔物の群れが巣を移した', monsterNestCleared: '魔物の巣を攻略', cooperativeExpedition: '協力遠征に出発', supplyRecoveryDeparted: '物資回収に出発', supplyRecoveryReturned: '物資回収隊が帰還', borderFriction: '国境摩擦',
  marriage: '婚姻', birth: '誕生', migrantArrived: '集落に移住', independentExpedition: '独立開拓に出発',
  settlementFounded: '集落が成立', god_intervention: '神の介入', frostRecovered: '霜害から野生食料が再生', blessedFarmHarvested: '豊穣の祝福を受けた畑で収穫', droughtHarvestRecovered: '干ばつ後に収穫を再開', droughtFoodForaged: '干ばつに備えて野生食料を採集', founding: '建国', leaderSucceeded: '指導者が交代',
  miningToolsForged: '鍛冶場で鋼鉄の採掘道具を製作', adventurerRankUp: '冒険者の称号を獲得', combatLevelUp: '戦闘技能が上昇', adventurerEquipped: '冒険者の装備を新調',
  alliedDefenseMobilized: '防衛協定により同盟国が参戦', warDeclared: '開戦', fieldBattle: '野戦で両軍が交戦', siegeStarted: '包囲開始', territoryOccupied: '集落を占領', siegeRepelled: '侵攻を撃退', campaignCancelled: '戦線が解消', truceAgreed: '休戦を締結', peaceAgreed: '講和が成立', nationFallen: '国家が滅亡',
  campaignRationsRecovered: '遠征の残り兵糧を回収',
  frontierDiscovered: '新しい土地を発見', research_unlocked: '研究を解禁', death: '死亡', civilizationAdvanced: '文明時代が進展'
};
const eventGroups = {
  nations: ['founding', 'leaderSucceeded', 'friendshipReached', 'pactEnvoyArrived', 'allianceFormed', 'allianceEnded', 'internationalTradeCompleted', 'internationalTradeReturning', 'internationalTradeReturned', 'borderFriction', 'warDeclared', 'alliedDefenseMobilized', 'fieldBattle', 'siegeStarted',
    'territoryOccupied', 'siegeRepelled', 'campaignCancelled', 'campaignRationsRecovered', 'truceAgreed', 'peaceAgreed', 'nationFallen'],
  people: ['marriage', 'birth', 'death', 'migrantArrived', 'independentExpedition', 'settlementFounded', 'constructionCompleted', 'miningToolsForged', 'foodShortage', 'foodRecovered', 'foodAidDelivered', 'foreignFoodAidDelivered', 'materialAidDelivered', 'aidReturning', 'aidReturned'],
  adventure: ['monsterBound', 'guildApprenticeAdvanced', 'adventureReturned', 'monsterDefeated', 'monsterPredation', 'monsterThreat', 'monsterNestFounded', 'monsterNestRelocated', 'monsterNestCleared',
    'cooperativeExpedition', 'supplyRecoveryReturned', 'resourceSurveyReturned', 'tradeEscortReturned', 'tradeEscortClash', 'manaVeinDiscovered', 'adventurerRankUp', 'combatLevelUp', 'adventurerEquipped', 'frontierDiscovered'],
  science: ['research_unlocked', 'civilizationAdvanced'],
  god: ['god_intervention', 'blessedFarmHarvested', 'frostRecovered', 'droughtHarvestRecovered', 'droughtFoodForaged']
};
const relatedEventKey = event => event.questId ??
  (event.sourceTransactionId?.startsWith('campaign:') ? event.sourceTransactionId : undefined);
const eventNumber = event => Number(event.id.split(':')[1]);
const jobs = { farmer: '農民', woodcutter: '木こり', miner: '鉱夫', builder: '建築家', adventurer: '冒険者' };
const actions = {
  idle: '待機', explore: '探索', survey: '境界を調査', warMarch: '遠征隊で進軍', eat: '食事', sleep: '睡眠', gather: '採集', forage: '非常食を採集', haul: '運搬',
  farm: '収穫', build: '建築', pickUpMaterials: '資材引取', deliverMaterials: '資材搬入',
  recoverMaterials: '資材回収', adventure: '冒険', expedition: '開拓'
};
const facilityNames = { house: '住宅', farm: '畑', warehouse: '倉庫', smithy: '鍛冶場', barracks: '兵舎', guild: 'ギルド' };
const settlementName = settlement => '集落 ' + settlement.id.split(':').at(-1);
const resources = { food: '食料', wood: '木材', stone: '石材', iron: '鉄', manaStone: '魔石' };

const techNames = { farming_1: '農業', building_1: '建築', weapons_1: '武器', magic_1: '魔法',
  steel_1: '鋼鉄鍛造', irrigation_1: '灌漑', magic_2: '魔法増幅', restoration_1: '治癒術', verdant_1: '豊穣魔法', binding_1: '拘束魔法' };

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
  const search = get('history-search');
  const favoriteOnly = get('favorite-only');
  const eventFilter = get('event-filter');
  const previousPages = [];
  const body = get('history-body');
  let previousRender = '';
  let subjectListKey = '';
  let recordsOpenFor = null;
  let observedEvent = '';
  let eventAt = -Infinity;
  let currentEvent = null;
  let suspendedAt = null;
  const seen = new Set();
  let openRelatedEventId;
  let indexedEvents;
  let indexedCount = 0;
  const eventsById = new Map();
  const resultsByCause = new Map();
  const relatedByType = new Map();
  const cameraEvents = [];

  function indexHistory(events) {
    if (indexedEvents !== events) {
      indexedEvents = events;
      indexedCount = 0;
      eventsById.clear();
      resultsByCause.clear();
      relatedByType.clear();
      cameraEvents.length = 0;
    }
    for (; indexedCount < events.length; indexedCount++) {
      const event = events[indexedCount];
      eventsById.set(event.id, event);
      if (eventImportance(event) >= 4) {
        cameraEvents.push(event);
        if (cameraEvents.length > 40) seen.delete(cameraEvents.shift().id);
      }
      if (event.causeEventId) {
        if (!resultsByCause.has(event.causeEventId)) resultsByCause.set(event.causeEventId, new Map());
        resultsByCause.get(event.causeEventId).set(event.type, event);
      }
      const key = relatedEventKey(event);
      if (!key) continue;
      if (!relatedByType.has(key)) relatedByType.set(key, new Map());
      relatedByType.get(key).set(event.type, event);
    }
  }

  function render(force = false) {
    const world = getWorld();
    const mode = tab.value;
    const cutoff = mode === 'world' ? 0 : Math.floor(world.worldTimeTick / 120);
    const query = search.value.normalize('NFKC').trim().toLowerCase();
    const key = [mode, subjects.value, query, cutoff, world.events.at(-1)?.id, world.citizens.length, world.nations.length, world.settlements.length].join('/');
    if (!force && key === previousRender) return;
    previousRender = key;
    const citizenMode = mode === 'citizen' || mode === 'family';
    get('favorite-filter').hidden = !citizenMode;
    const favorites = world.settings.favoriteCitizenIds ?? [];
    search.hidden = mode === 'world' || mode === 'ecology';
    const listKey = [mode, query, world.citizens.length, world.nations.length, world.settlements.length,
      citizenMode && favoriteOnly.checked ? favorites.join(',') : '*'].join('/');
    if (listKey !== subjectListKey) {
      subjectListKey = listKey;
      const candidates = citizenMode ? (favoriteOnly.checked ? world.citizens.filter(c => favorites.includes(c.id)) : world.citizens) :
        mode === 'nation' ? world.nations : mode === 'settlement' ? world.settlements : [];
      const choices = query ? candidates.filter(entry =>
        [entry.id, mode === 'settlement' ? settlementName(entry) : entry.name, citizenRaces[entry.race]?.label]
          .some(value => value?.normalize('NFKC').toLowerCase().includes(query))) : candidates;
      const selected = subjects.value;
      subjects.replaceChildren(...choices.map(c => new Option(mode === 'settlement' ? settlementName(c) : c.name, c.id)));
      subjects.hidden = choices.length === 0;
      if (choices.some(c => c.id === selected)) subjects.value = selected;
    }
    get('follow').hidden = !subjects.value || mode === 'settlement';
    body.replaceChildren();
    eventFilter.hidden = mode !== 'world';
    if (mode === 'world') {
      const group = eventGroups[eventFilter.value];
      const before = previousPages.at(-1) ?? Infinity;
      const list = [];
      for (let i = world.events.length - 1; i >= 0 && list.length < 21; i--) {
        const event = world.events[i];
        if (eventNumber(event) < before && eventImportance(event) >= 2 && (!group || group.includes(event.type))) {
          list.push(event);
        }
      }
      if (!list.length) add(body, 'p', '該当する出来事はありません。');
      for (const event of list.slice(0, 20)) showEvent(world, event);
      if (previousPages.length) {
        const newer = add(body, 'button', '新しい出来事');
        newer.onclick = () => { previousPages.pop(); render(true); };
      }
      if (list.length > 20) {
        const older = add(body, 'button', '古い出来事');
        older.onclick = () => { previousPages.push(eventNumber(list[19])); render(true); };
      }
      return;
    }

    if (mode === 'ecology') {
      const surveyed = tile => tile.x < (world.map.surveyedWidth ?? world.map.width) &&
        tile.y < (world.map.surveyedHeight ?? world.map.height);
      const living = world.monsters.filter(monster => monster.alive && surveyed(monster));
      const habitats = { grass: '草地', forest: '森林', mountain: '山地' };
      add(body, 'h3', '探索済み領域の魔物');
      for (const [species, config] of Object.entries(monsters)) {
        const population = living.filter(monster => monster.species === species);
        add(body, 'p', `${config.label} ${population.length}体 · 生息地 ${config.habitat.map(tile => habitats[tile]).join('・')}`);
        const nests = new Map();
        for (const monster of population) {
          if (!monster.hasNest || !surveyed(monster.homeTile)) continue;
          const tile = monster.homeTile;
          nests.set(`${tile.x}, ${tile.y}`, tile);
        }
        for (const [coordinates, tile] of nests) {
          const button = add(body, 'button', `${config.label}の巣（${coordinates}）`);
          button.onclick = () => {
            markManual();
            focus({ x: tile.x + 0.5, y: tile.y + 0.5 }, 'manualOverride');
          };
        }
      }
      return;
    }

    if (mode === 'settlement' && subjects.value) {
      const settlement = world.settlements.find(s => s.id === subjects.value);
      const residents = world.citizens.filter(c => c.alive && c.settlementId === settlement.id);
      const facilities = world.buildings.filter(b => b.settlementId === settlement.id);
      const store = world.stockpiles.find(s => s.settlementId === settlement.id);
      const beds = facilities.filter(b => b.kind === 'house').reduce((sum, b) => sum + b.capacity, 0);
      const housed = residents.filter(c => c.homeBuildingId).length;
      const site = world.constructionSites.find(s => s.settlementId === settlement.id);
      add(body, 'h3', settlementName(settlement));
      add(body, 'p', `人口 ${residents.length}人 · 住宅 ${housed}/${beds}床`);
      showDemographics(residents);
      showResearch(world, researchOwner(world, settlement));
      add(body, 'p', Object.entries(jobs).map(([role, label]) =>
        `${label} ${residents.filter(c => c.profession === role).length}`).join(' / '));
      const irrigated = facilities.filter(b => b.kind === 'farm' && b.arcaneIrrigation).length;
      if (irrigated) add(body, 'p', `魔導灌漑 ${irrigated}か所（収穫量が増加）`);
      const equippedMiners = residents.filter(c => c.profession === 'miner' && c.steelMiningTools).length;
      if (equippedMiners) add(body, 'p', `鋼鉄の採掘道具 ${equippedMiners}人（鉄・魔石の採掘量が増加）`);
      if (store) {
        add(body, 'p', `倉庫 ${store.capacity - freeCapacity(store)}/${store.capacity}`);
        add(body, 'p', Object.entries(resources).map(([key, label]) =>
          `${label} ${available(store, key)}`).join(' / '));
        const food = available(store, 'food');
        const hungry = residents.filter(c => c.hunger >= NEEDS.eat).length;
        if (residents.length) {
          const shortage = food < residents.length * FOOD_EMERGENCY_PER_PERSON ? ' · 備蓄不足' : '';
          add(body, 'p', `食料備蓄 ${food}/${residents.length * FOOD_TARGET_PER_PERSON}（目標） · 空腹 ${hungry}人${shortage}`);
        }
      }
      showShipments(world, settlement);
      const recent = settlement.dailyRecords?.slice(-7);
      if (recent?.length) {
        const last = recent.at(-1);
        const shortageDays = recent.filter(day => day.population > 0 &&
          day.food < day.population * FOOD_EMERGENCY_PER_PERSON).length;
        add(body, 'p', `直近${recent.length}日の備蓄不足 ${shortageDays}日 · 最終日 空腹 ${last.hungry}人 / 回収待ち資材 ${last.waitingCargo}`);
        const open = recordsOpenFor === settlement.id;
        const toggle = add(body, 'button', open ? '日別記録を閉じる' : '日別記録を開く');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.onclick = () => {
          recordsOpenFor = open ? null : settlement.id;
          render(true);
          document.querySelector('#history-body [aria-expanded]')?.focus();
        };
        if (open) {
          const table = add(body, 'table', '');
          table.className = 'settlement-records';
          add(table, 'caption', '集落の日別記録');
          const header = add(table.createTHead(), 'tr', '');
          for (const label of ['日', '備蓄', '空腹', '回収待ち']) {
            add(header, 'th', label).scope = 'col';
          }
          const rows = table.createTBody();
          for (const day of settlement.dailyRecords.slice().reverse()) {
            const row = rows.insertRow();
            add(row, 'th', String(day.day)).scope = 'row';
            add(row, 'td', String(day.food));
            add(row, 'td', `${day.hungry}/${day.population}`);
            add(row, 'td', String(day.waitingCargo));
          }
        }
      }
      if (site) {
        add(body, 'p', `建設中 ${facilityNames[site.kind] ?? site.kind} ${Math.floor(100 * site.progress / workTicks(site.kind))}%`);
        const shipments = world.inTransit.filter(item => item.destinationId === site.id);
        for (const [key, required] of Object.entries(buildings[site.kind].cost)) {
          const delivered = site.delivered[key] ?? 0;
          const moving = shipments.filter(item => item.resource === key && item.carrierId !== null)
            .reduce((sum, item) => sum + item.quantity, 0);
          const dropped = shipments.filter(item => item.resource === key && item.carrierId === null)
            .reduce((sum, item) => sum + item.quantity, 0);
          if (delivered < required) add(body, 'p',
            `${resources[key]} ${delivered}/${required} 搬入済み · 運搬中 ${moving} · 回収待ち ${dropped}`);
        }
      }
      const quests = world.quests.filter(q => q.settlementId === settlement.id && ['open', 'claimed'].includes(q.status));
      if (quests.length) add(body, 'h4', '依頼');
      for (const quest of quests) {
        const recovery = quest.kind === 'recover_supplies';
        const survey = quest.kind === 'survey_resources';
        const target = quest.escortGoal ?? quest.prospectTile ??
          (recovery || survey ? world.resourceNodes : world.monsters).find(item => item.id === quest.targetId);
        const type = quest.kind === 'escort_trade' ? '交易品の護衛' : recovery ? '物資回収' : quest.prospectTile ? '魔石探鉱' : survey ? '資源調査' : quest.kind === 'clear_nest' ? '巣の攻略' : '魔物討伐';
        const status = quest.status === 'open' ? '募集中' : quest.stage === 'return' ? '帰還中' : '進行中';
        const cargo = (recovery || survey) && target?.resource ? ` · ${resources[target.resource]}` : '';
        const details = add(body, target ? 'button' : 'p', `${type} · ${status}${cargo}`);
        if (target) details.onclick = () => {
          markManual();
          focus({ x: target.x + 0.5, y: target.y + 0.5 }, 'manualOverride');
        };
      }
      const reports = world.events.filter(event => event.type === 'resourceSurveyReturned' &&
        event.settlementId === settlement.id).slice(-3).reverse();
      if (reports.length) {
        add(body, 'h4', '最近の資源調査');
        for (const report of reports) showEvent(world, report);
      }
      const responses = world.events.filter(event => (event.type === 'blessedFarmHarvested' ||
        event.type === 'droughtHarvestRecovered' || event.type === 'droughtFoodForaged') && event.settlementId === settlement.id).slice(-3).reverse();
      if (responses.length) {
        add(body, 'h4', '神の介入後の食料調達');
        for (const response of responses) showEvent(world, response);
      }
      const center = add(body, 'button', '地図で見る');
      center.onclick = () => {
        markManual();
        focus({ x: settlement.x + 0.5, y: settlement.y + 0.5 }, 'manualOverride');
      };
      return;
    }

    if (!subjects.options.length && (query || citizenMode && favoriteOnly.checked)) {
      add(body, 'p', query ? '検索に一致する対象はありません。' : '注目人物はまだいません。');
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
      if (person.steelMiningTools) add(body, 'p', '鋼鉄の採掘道具');
      const affinity = person.traits.magicAffinity;
      const affinityLabel = affinity >= MAGIC_AFFINITY_THRESHOLD ? '適性あり' : '適性未達';
      const magic = person.skills.magic > 0 ? ` · 魔法 Lv.${person.skills.magic} · MP ${person.mp ?? 0}/${TECH.maxMp}` : '';
      add(body, 'p', `魔力適性 ${Math.round(affinity * 100)}%（${affinityLabel}）${magic}`);
      const inventory = Object.entries(person.inventory).filter(([, qty]) => qty > 0);
      if (inventory.length) add(body, 'p', inventory.map(([key, qty]) => `${resources[key]} ${qty}`).join(' / '));
      const starred = favorites.includes(person.id);
      const favorite = add(body, 'button', starred ? '注目人物から外す' : '注目人物に登録');
      favorite.id = 'favorite-citizen';
      favorite.setAttribute('aria-pressed', String(starred));
      favorite.onclick = () => {
        world.settings.favoriteCitizenIds = starred ? favorites.filter(id => id !== person.id) : [...favorites, person.id];
        render(true);
        get('favorite-citizen')?.focus();
      };
      if (mode === 'family') {
        showFamily(world, person);
      } else {
        for (const event of historyFor(world, 'citizen', person.id).slice(-10).reverse()) showEvent(world, event);
      }
    } else if (nation) {
      add(body, 'h3', nation.name + (nation.fallenAt === undefined ? '' : '（滅亡）'));
      const residents = world.citizens.filter(c => c.alive && c.nationId === nation.id);
      add(body, 'p', `人口 ${residents.length}人`);
      showDemographics(residents);
      const leader = world.citizens.find(c => c.id === nation.leaderId);
      if (leader) add(body, 'p', `指導者 ${leader.name}`);
      else if (nation.fallenAt === undefined) add(body, 'p', '指導者 空席');
      const priorities = { food: '農業', housing: '住宅', defense: '防衛', research: '研究', exploration: '探索' };
      add(body, 'p', `主要方針 ${priorities[nation.policy.primary] ?? '選択中'}`);
      showResearch(world, nation);
      showFronts(world, nation);
      const rivals = nation.fallenAt === undefined ? activeNations(world).filter(other => other.id !== nation.id) : [];
      if (rivals.length) {
        add(body, 'h4', '外交');
        const labels = { friendly: '友好', neutral: '中立', hostile: '敵対' };
        const progressFor = allianceProgress(world);
        for (const rival of rivals) {
          const value = nation.relations[rival.id] ?? 0;
          const truce = truceBetween(world, nation, rival);
          const campaign = world.campaigns?.find(c =>
            ((c.attackerId === nation.id && c.defenderId === rival.id) ||
              (c.defenderId === nation.id && c.attackerId === rival.id)) &&
            (c.status === 'marching' || c.status === 'siege'));
          const pact = alliedNations(world, nation, rival);
          const status = campaign ? (campaign.status === 'marching' ? ' · 進軍中' : ' · 包囲中') :
            truce ? ' · 休戦中' : pact ? ' · 防衛協定' : '';
          const relation = `${rival.name} ${labels[relationLabel(value)]}（${value}）${status}`;
          const capital = world.settlements.find(settlement => settlement.id === rival.capitalId);
          if (!capital || !addEventLocation(body, world, capital, relation)) add(body, 'p', relation);
          if (!pact && friendlyNations(world, nation, rival)) {
            const progress = progressFor(nation, rival);
            const visits = progress.requiredEnvoys === null ? '' : ` · 使節 ${progress.envoyVisits}/${progress.requiredEnvoys}`;
            const cooldown = progress.cooldownDays ? ` · 再締結まで ${progress.cooldownDays}ゲーム日` : '';
            add(body, 'p', `協定条件（90ゲーム日以内） · 交易・援助 ${progress.exchanges}/${progress.requiredExchanges}${visits}${cooldown}`);
          }
        }
      }
      for (const event of historyFor(world, 'nation', nation.id).slice(-10).reverse()) showEvent(world, event);
    } else add(body, 'p', '対象がまだありません。');
  }

  function showFamily(world, person) {
    const members = new Map(world.citizens.map(citizen => [citizen.id, citizen]));
    const relatives = (ids, field) => [...new Set(ids.flatMap(id => members.get(id)?.[field] ?? []))];
    const partner = members.get(person.partnerId);
    const current = person.alive && partner?.alive && partner.partnerId === person.id ? partner.id : null;
    const previous = new Set();
    for (let i = world.events.length - 1; i >= 0; i--) {
      const event = world.events[i];
      if (event.type !== 'marriage' || !event.citizenIds?.includes(person.id)) continue;
      for (const id of event.citizenIds) {
        if (id !== person.id && id !== current) previous.add(id);
      }
    }
    if (partner && partner.id !== current) previous.add(partner.id);
    for (const member of members.values()) {
      if (!member.alive && member.partnerId === person.id) previous.add(member.id);
    }
    const fields = [
      ['祖父母', relatives(person.parentIds, 'parentIds')],
      ['親', person.parentIds],
      ['兄弟姉妹', relatives(person.parentIds, 'childIds').filter(id => id !== person.id)],
      ['配偶者', current ? [current] : []],
      ['過去の配偶者', [...previous]],
      ['子', person.childIds],
      ['孫', relatives(person.childIds, 'childIds')]
    ];
    for (const [label, ids] of fields) {
      add(body, 'h4', label);
      if (!ids.length) add(body, 'p', '記録なし');
      for (const id of ids) {
        const member = members.get(id);
        const name = member ? member.name + (member.alive ? '' : '（死亡）') : id;
        add(body, 'button', name).onclick = () => selectCitizen(id);
      }
    }
  }

  function showShipments(world, settlement) {
    const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
    const stock = (resource, amount) => `${resources[resource]} ${amount}`;
    const route = (label, from, to, shipment) => {
      const origin = settlementName(shipment.returning ? to : from);
      const destination = settlementName(shipment.returning ? from : to);
      const due = shipment.arrivalDay > day ? `あと${shipment.arrivalDay - day}ゲーム日` : '予定日到達';
      const other = from === settlement ? to : from;
      addEventLocation(body, world, other,
        `${label} · ${shipment.returning ? '返送中' : '輸送中'} ${origin} → ${destination} · ${due}`);
    };
    const source = settlement.trade ? settlement : world.settlements.find(other => other.trade?.partnerId === settlement.id);
    if (source?.trade) {
      const trade = source.trade;
      const partner = world.settlements.find(other => other.id === trade.partnerId);
      if (partner) {
        const loads = [];
        if (trade.outgoingQuantity) loads.push(`${settlementName(source)}発 ${stock(trade.outgoing, trade.outgoingQuantity)}`);
        if (trade.incomingQuantity) loads.push(`${settlementName(partner)}発 ${stock(trade.incoming, trade.incomingQuantity)}`);
        const due = trade.arrivalDay > day ? `あと${trade.arrivalDay - day}ゲーム日` : '予定日到達';
        addEventLocation(body, world, source === settlement ? partner : source,
          `交易 ${trade.returning ? '返送中' : '輸送中'} · ${loads.join(' / ')} · ${due}`);
      }
    }
    for (const receiver of world.settlements) {
      for (const field of ['foodAid', 'materialAid']) {
        const aid = receiver[field];
        if (!aid || (receiver !== settlement && aid.sourceId !== settlement.id)) continue;
        const sender = world.settlements.find(other => other.id === aid.sourceId);
        if (!sender) continue;
        const label = field === 'materialAid' ? `資材融通 ${stock(aid.resource, aid.quantity)}` :
          `${aid.allianceRelief ? '同盟の防衛補給' : aid.recipientNationId ? '国際食料援助' : '食料援助'} ${stock('food', aid.food)}`;
        route(label, sender, receiver, aid);
      }
    }
  }

  function showFronts(world, nation) {
    const fronts = (world.campaigns ?? []).filter(c => (c.attackerId === nation.id || c.defenderId === nation.id) &&
      (c.status === 'marching' || c.status === 'siege'));
    if (!fronts.length) return;
    add(body, 'h4', '進行中の戦線');
    for (const campaign of fronts) {
      const offensive = campaign.attackerId === nation.id;
      const target = world.settlements.find(settlement => settlement.id === campaign.settlementId);
      const rival = world.nations.find(other => other.id === (offensive ? campaign.defenderId : campaign.attackerId));
      const team = world.citizens.filter(c => c.alive && c.nationId === campaign.attackerId && campaign.memberIds.includes(c.id));
      const arrived = team.filter(c => campaign.arrivedIds.includes(c.id)).length;
      const status = campaign.status === 'siege' ? `包囲中（${campaign.siegeDays}日）` : '進軍中';
      addEventLocation(body, world, campaign,
        `${offensive ? '攻勢' : '防衛'}${campaign.supportsCampaignId ? '（協定参戦）' : ''} · ${rival.name} · ${settlementName(target)} · ${status} · 部隊 ${team.length}人（到着 ${arrived}人） · 兵糧 ${campaign.rations}`);
    }
  }

  function showDemographics(residents) {
    if (!residents.length) return;
    const counts = new Map();
    let affinityCount = 0;
    for (const citizen of residents) {
      counts.set(citizen.race, (counts.get(citizen.race) ?? 0) + 1);
      if (citizen.traits.magicAffinity >= MAGIC_AFFINITY_THRESHOLD) affinityCount++;
    }
    const breakdown = Object.entries(citizenRaces).filter(([race]) => counts.has(race))
      .map(([race, config]) => `${config.label} ${counts.get(race)}人`).join(' / ');
    add(body, 'p', `種族別人口 ${breakdown}`);
    add(body, 'p', `魔法の適性者 ${affinityCount}人`);
  }

  function showResearch(world, owner) {
    const state = getResearch(world, owner);
    if (!state) return;
    add(body, 'p', civilizationNames[state.civilization] ?? state.civilization);
    add(body, 'p', `解禁研究 ${state.unlockedIds.map(id => techNames[id] ?? id).join('・') || 'なし'}`);
    if (owner.fallenAt !== undefined) return;
    const active = technologies.find(t => t.id === state.activeTechId);
    if (active) add(body, 'p', `研究中 ${techNames[active.id]} ${state.progressById[active.id] ?? 0}/${active.cost}`);
    const progress = civilizationProgress(world, owner, state);
    if (!progress) return;
    add(body, 'p', `次の時代 ${civilizationNames[progress.target]} · 条件を満たした日数 ${progress.days}/${progress.neededDays}`);
    const labels = { population: '人口', nation: '国家の成立' };
    for (const condition of progress.unmet) {
      const label = labels[condition.kind] ?? techNames[condition.id] ?? facilityNames[condition.id] ?? resources[condition.id];
      add(body, 'p', `進化条件 ${label} ${condition.current}/${condition.needed}`);
    }
  }

  function showEvent(world, event) {
    let title = events[event.type] ?? event.type;
    if (event.type === 'leaderSucceeded') {
      const leader = world.citizens.find(c => c.id === event.leaderId);
      if (leader) title += '（' + leader.name + '）';
    }
    if (event.type === 'fieldBattle') {
      const winner = world.nations.find(n => n.id === event.winnerId);
      if (winner) title += '（勝利 ' + winner.name + '）';
    }
    if (event.type === 'civilizationAdvanced') title = civilizationNames[event.civilization] + 'へ進展';
    if (event.type === 'god_intervention' && event.kind === 'blessing') {
      title = event.value === 'fertility' ? `豊穣の祝福（畑${event.quantity}棟）` : `回復の祝福（${event.quantity}人）`;
    }
    if (event.type === 'god_intervention' && event.kind === 'terrain' && event.value === 'undo') title = '地形編集を取り消し';
    if (event.type === 'god_intervention' && event.kind === 'disaster') title = event.value === 'frost'
      ? '霜害（野生食料' + event.quantity + 'か所）' : '干ばつ（畑' + event.quantity + '棟）';
    if (['supplyRecoveryReturned', 'resourceSurveyReturned'].includes(event.type)) title += `（${resources[event.resource]} ${event.quantity}）`;
    if (event.type === 'materialAidDelivered') title += `（${resources[event.resource]} ${event.quantity}）`;
    if (['foodAidDelivered', 'foreignFoodAidDelivered'].includes(event.type)) title += `（食料 ${event.food}）`;
    if (['aidReturning', 'aidReturned', 'internationalTradeReturned'].includes(event.type)) {
      const reasons = { ownership: '所属国が変わった', relations: '外交上の援助条件が崩れた',
        population: '受取先に住民がいない', route: '道が通れない', capacity: '受取先の倉庫に収まらない' };
      const reason = reasons[event.reason];
      title += `（${resources[event.resource]} ${event.quantity}${reason ? '・' + reason : ''}）`;
    }
    if (event.type === 'internationalTradeReturning') {
      const reasons = { conditions: '交易条件が崩れた', route: '道が通れない', timeout: '護衛が期限に間に合わない', escort: '護衛を完了できない' };
      if (reasons[event.reason]) title += `（${reasons[event.reason]}）`;
    }
    if (event.type === 'droughtHarvestRecovered') {
      const stock = event.foodBeforeHarvest;
      const baseline = event.foodBeforeDrought;
      title += `（収穫 ${event.quantity}${stock === undefined ? '' : baseline === undefined
        ? '・収穫前の備蓄 ' + stock : `・備蓄 ${baseline} → ${stock}（干ばつ時 → 収穫前）`}）`;
    }
    if (event.type === 'foodShortage' || event.type === 'foodRecovered') {
      const stock = event.foodAtShortage === undefined ? event.food : `${event.foodAtShortage} → ${event.food}`;
      if (stock !== undefined) title += `（備蓄 ${stock}）`;
    }
    if (event.type === 'allianceFormed' && event.basis === 'envoys') title += '（使節交流）';
    if (event.type === 'campaignRationsRecovered') {
      title += `（倉庫 ${event.food}・地面 ${event.dropped}）`;
    }
    if (event.type === 'healingReceived') title += `（HP +${event.quantity}）`;
    if (['blessedFarmHarvested', 'droughtFoodForaged'].includes(event.type)) title += `（食料 ${event.quantity}）`;
    if (event.type === 'frostRecovered') title += `（${event.quantity}か所）`;
    const label = `${title} · ${calendar(event.worldTimeTick)}`;
    if (!addEventLocation(body, world, event, label)) add(body, 'p', label);

    indexHistory(world.events);
    const cause = eventsById.get(event.causeEventId);
    if (cause) {
      const origin = cause.type === 'foodShortage' ? '食料難が発生した集落' :
        cause.kind === 'blessing' ? '祝福を行った地点' : '災害の発生地点';
      addEventLocation(body, world, cause, `${origin} · ${calendar(cause.worldTimeTick)}`);
    }
    for (const recovery of resultsByCause.get(event.id)?.values() ?? []) {
      const result = recovery.type === 'foodRecovered' ? `備蓄が回復した集落（備蓄 ${recovery.food}）` :
        recovery.type === 'blessedFarmHarvested' ? '祝福後に収穫した畑' :
        recovery.type === 'droughtFoodForaged' ? '代わりの食料を採集した地点' : '直近の復旧地点';
      addEventLocation(body, world, recovery, `${result} · ${calendar(recovery.worldTimeTick)}`);
    }

    const group = relatedByType.get(relatedEventKey(event));
    const linked = group ? [...group.values()].filter(entry => entry.type !== event.type && eventLocation(world, entry)) : [];
    const personIds = new Set([event.citizenId, event.leaderId, ...(event.citizenIds ?? []),
      ...(event.parentIds ?? []), ...(event.actorIds ?? []), ...(event.affectedCitizenIds ?? [])]);
    const nationIds = new Set([event.nationId, event.ownerId, ...(event.nationIds ?? [])]);
    personIds.delete(undefined);
    nationIds.delete(undefined);
    const people = personIds.size ? world.citizens.filter(person => personIds.has(person.id)) : [];
    const nations = nationIds.size ? world.nations.filter(nation => nationIds.has(nation.id)) : [];
    if (!linked.length && !people.length && !nations.length) return;
    const details = add(body, 'details', '');
    details.open = openRelatedEventId === event.id;
    const summary = add(details, 'summary', linked.length ? '関連する出来事' : '関係者・国家');
    summary.onclick = () => { openRelatedEventId = details.open ? undefined : event.id; };
    linked.sort((a, b) => eventNumber(a) - eventNumber(b));
    for (const entry of linked) {
      addEventLocation(details, world, entry, `${events[entry.type] ?? entry.type} · ${calendar(entry.worldTimeTick)}`);
    }
    addEventSubjects(details, '関係者の人物伝', people, id => {
      tab.value = 'citizen';
      selectCitizen(id);
    });
    addEventSubjects(details, '関係国の国家史', nations, id => {
      tab.value = 'nation';
      search.value = '';
      render(true);
      subjects.value = id;
      render(true);
    });
  }

  function addEventSubjects(container, label, entries, selectSubject) {
    if (!entries.length) return;
    const select = add(container, 'select', '');
    select.setAttribute('aria-label', label);
    select.append(new Option(label, ''), ...entries.map(entry => new Option(entry.name, entry.id)));
    select.onchange = () => { if (select.value) selectSubject(select.value); };
  }

  function addEventLocation(container, world, event, label) {
    const target = eventLocation(world, event);
    if (!target) return false;
    add(container, 'button', label).onclick = () => {
      markManual();
      focus(target, 'manualOverride');
    };
    return true;
  }

  tab.onchange = () => { search.value = ''; previousPages.length = 0; render(true); };
  eventFilter.onchange = () => { previousPages.length = 0; render(true); };
  search.oninput = () => render(true);
  favoriteOnly.onchange = () => render(true);
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

  function selectCitizen(id) {
    search.value = '';
    if (!getWorld().settings.favoriteCitizenIds?.includes(id)) favoriteOnly.checked = false;
    render(true);
    subjects.value = id;
    render(true);
  }

  function markManual() {
    const camera = getCamera();
    if (camera.mode === 'autoEvent' || suspendedAt !== null) suspendedAt = performance.now();
  }

  return {
    render,
    markManual,
    inspectTile(x, y) {
      const world = getWorld();
      const citizen = world.citizens.find(c => c.alive && Math.floor(c.x) === x && Math.floor(c.y) === y);
      if (citizen) {
        tab.value = 'citizen';
        selectCitizen(citizen.id);
        return;
      }
      const structure = [...world.buildings, ...world.constructionSites].find(b => footprint(b, { x, y }));
      const depot = world.stockpiles.find(s => s.x === x && s.y === y);
      const settlementId = structure?.settlementId ?? depot?.settlementId;
      if (!settlementId) return;
      tab.value = 'settlement';
      search.value = '';
      render(true);
      subjects.value = settlementId;
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
          selectCitizen(target?.id ?? '');
          return;
        }
      }
      if (camera.mode === 'followNation') {
        const nation = world.nations.find(n => n.id === camera.subjectId);
        const seat = world.settlements.find(s => s.id === nation?.capitalId);
        if (seat) target = { x: seat.x + 0.5, y: seat.y + 0.5 };
      }
      if (camera.mode === 'autoEvent') {
        const favorites = world.settings.favoriteCitizenIds ?? [];
        const score = event => eventImportance(event) * 10 + 5 +
          (favorites.some(id => involvesCitizen(event, id)) ? 8 : 0) - (event.type === currentEvent?.type ? 10 : 0);
        indexHistory(world.events);
        const candidates = cameraEvents.slice().reverse().filter(e => !seen.has(e.id) && eventLocation(world, e));
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
      favoriteOnly.checked = false;
      recordsOpenFor = null;
      openRelatedEventId = undefined;
      previousPages.length = 0;
      previousRender = '';
      subjectListKey = '';
      observedEvent = '';
      eventAt = -Infinity;
      currentEvent = null;
      suspendedAt = null;
      seen.clear();
    }
  };
}

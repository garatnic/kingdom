import { arcaneGearDemand, forgeMiningTools, miningToolRecipient, STEEL_TOOLS } from './Industry.js';
import { gear } from '../data/combat.js';
import { CONSTRUCTION_STORAGE_RESERVE, FOOD_BIRTH_PER_PERSON, FOOD_TARGET_PER_PERSON, TIME_TICKS_PER_DAY } from '../data/balance.js';
import { alliedNations, friendlyNations } from './Diplomacy.js';
import { buildings } from '../data/buildings.js';
import { TECH } from '../data/technologies.js';
import { unlocked } from './Research.js';
import { emitOnce } from '../systems/History.js';
import { available, storageRoom, storeTile } from './Economy.js';
import { findPath } from './path.js';

export function updateFoodAid(world) {
  if (!world.settlements.some(settlement => settlement.foodAid || settlement.materialAid || settlement.nationId)) return;
  const day = Math.floor(world.worldTimeTick / TIME_TICKS_PER_DAY);
  const stores = new Map(world.stockpiles.map(store => [store.settlementId, store]));
  const settlements = new Map(world.settlements.map(settlement => [settlement.id, settlement]));
  const population = new Map();
  for (const citizen of world.citizens) {
    if (citizen.alive) population.set(citizen.settlementId, (population.get(citizen.settlementId) ?? 0) + 1);
  }

  function route(from, to) {
    return findPath(world, storeTile(world, from), storeTile(world, to));
  }

  const nations = new Map(world.nations.map(nation => [nation.id, nation]));
  const friendly = (from, to) => friendlyNations(world, nations.get(from), nations.get(to));

  const room = (store, resource, target) =>
    resource === STEEL_TOOLS ? Math.max(0, 1 - (store.steelTools ?? 0)) : storageRoom(store, resource, target);

  function receive(store, resource, quantity) {
    if (resource === STEEL_TOOLS) store.steelTools = (store.steelTools ?? 0) + quantity;
    else store.total[resource] += quantity;
  }

  function settle(destination, field, resource, quantityKey) {
    const aid = destination[field];
    if (!aid || day < aid.arrivalDay) return;
    const source = settlements.get(aid.sourceId);
    const from = stores.get(aid.sourceId);
    const to = stores.get(destination.id);
    const residents = population.get(destination.id) ?? 0;
    const ownershipMatches = source.nationId === aid.nationId &&
      destination.nationId === (aid.recipientNationId ?? aid.nationId);
    const relationsAllowAid = (!aid.recipientNationId || friendly(aid.nationId, aid.recipientNationId)) &&
      (!aid.allianceRelief || alliedNations(world, nations.get(aid.nationId), nations.get(aid.recipientNationId)));
    const eventKey = `${destination.id}/${field}/${day}`;
    const participants = {
      settlementId: destination.id, sourceSettlementId: source.id, nationId: aid.nationId,
      ...(aid.recipientNationId ? { nationIds: [aid.nationId, aid.recipientNationId] } : {})
    };
    const deliveryRoute = !aid.returning && ownershipMatches && relationsAllowAid && residents && route(from, to);
    if (deliveryRoute) {
      const delivered = Math.min(aid[quantityKey], room(to, resource, residents * FOOD_TARGET_PER_PERSON));
      if (delivered) {
        receive(to, resource, delivered);
        aid[quantityKey] -= delivered;
        const food = resource === 'food';
        emitOnce(world, eventKey, food ? (aid.recipientNationId ? 'foreignFoodAidDelivered' : 'foodAidDelivered') : 'materialAidDelivered', {
          settlementId: destination.id, nationId: destination.nationId, sourceSettlementId: source.id,
          x: destination.x, y: destination.y, ...(food ? { food: delivered } : { resource, quantity: delivered }),
          ...(aid.recipientNationId ? { nationIds: [aid.nationId, aid.recipientNationId] } : {}),
          ...(aid.allianceRelief ? { allianceRelief: true } : {})
        });
      }
    }
    if (!aid[quantityKey]) {
      delete destination[field];
    } else if (!aid.returning) {
      const reason = !ownershipMatches ? 'ownership' : !relationsAllowAid ? 'relations' :
        !residents ? 'population' : !deliveryRoute ? 'route' : 'capacity';
      emitOnce(world, eventKey, 'aidReturning', {
        ...participants, reason, resource, quantity: aid[quantityKey], x: destination.x, y: destination.y
      });
      aid.returning = true;
      aid.arrivalDay = day + aid.travelDays;
    } else if (route(to, from)) {
      const returned = resource === STEEL_TOOLS ? aid[quantityKey] : Math.min(aid[quantityKey], room(from, resource));
      if (returned) receive(from, resource, returned);
      aid[quantityKey] -= returned;
      if (returned) {
        emitOnce(world, eventKey, 'aidReturned', {
          ...participants, resource, quantity: returned, x: source.x, y: source.y
        });
      }
      if (!aid[quantityKey]) delete destination[field];
    }
  }

  for (const destination of world.settlements) {
    settle(destination, 'foodAid', 'food', 'food');
    settle(destination, 'materialAid', destination.materialAid?.resource, 'quantity');
  }

  const defended = new Set((world.campaigns ?? []).filter(c => c.status === 'siege').map(c => c.settlementId));
  const recipients = world.settlements.filter(settlement => (settlement.foodWarning || defended.has(settlement.id)) &&
    settlement.nationId && population.get(settlement.id) && !settlement.foodAid);
  const foodPerResident = settlement => available(stores.get(settlement.id), 'food') / population.get(settlement.id);
  recipients.sort((a, b) => foodPerResident(a) - foodPerResident(b));
  for (const destination of recipients) {
    const residents = population.get(destination.id);
    const to = stores.get(destination.id);
    const needed = Math.min(residents * FOOD_BIRTH_PER_PERSON - available(to, 'food'),
      storageRoom(to, 'food', residents * FOOD_TARGET_PER_PERSON));
    if (needed <= 0) continue;
    const allies = source => alliedNations(world, nations.get(source.nationId), nations.get(destination.nationId));
    const sources = world.settlements.filter(source => source !== destination && !source.foodWarning &&
      (destination.foodWarning && source.nationId === destination.nationId ||
        allies(source) || destination.foodWarning && friendly(source.nationId, destination.nationId)));
    const priority = source => source.nationId === destination.nationId ? 2 : allies(source) ? 1 : 0;
    sources.sort((a, b) => priority(b) - priority(a));
    for (const source of sources) {
      const adultsAndChildren = population.get(source.id);
      if (!adultsAndChildren) continue;
      const from = stores.get(source.id);
      const food = Math.min(needed, adultsAndChildren, available(from, 'food') - adultsAndChildren * FOOD_BIRTH_PER_PERSON);
      if (food <= 0) continue;
      const path = route(from, to);
      if (!path) continue;
      const travelDays = Math.max(1, Math.ceil(path.length / 32));
      from.total.food -= food;
      destination.foodAid = { sourceId: source.id, nationId: source.nationId,
        food, travelDays, arrivalDay: day + travelDays, returning: false };
      if (source.nationId !== destination.nationId) destination.foodAid.recipientNationId = destination.nationId;
      if (!destination.foodWarning) destination.foodAid.allianceRelief = true;
      break;
    }
  }

  const steelDemandForTools = TECH.miningToolIron + TECH.miningToolIronReserve;
  const smithies = new Map(world.buildings.filter(b => b.kind === 'smithy').map(b => [b.settlementId, b]));
  for (const destination of world.settlements) {
    const to = stores.get(destination.id);
    if (!destination.nationId || destination.foodWarning || destination.materialAid || to.steelTools ||
        smithies.has(destination.id) || !unlocked(world, destination.id, 'steel_1') ||
        !miningToolRecipient(world, to)) continue;
    for (const source of world.settlements) {
      if (source === destination || source.nationId !== destination.nationId || source.foodWarning ||
          !population.has(source.id)) continue;
      const from = stores.get(source.id);
      const smithy = smithies.get(source.id);
      if ((!from.steelTools && (!smithy || available(from, 'iron') < steelDemandForTools)) ||
          miningToolRecipient(world, from)) continue;
      const path = route(from, to);
      if (!path) continue;
      const forged = !from.steelTools;
      if (forged && !forgeMiningTools(world, from, smithy)) continue;
      if (--from.steelTools === 0) delete from.steelTools;
      const travelDays = Math.max(1, Math.ceil(path.length / 32));
      destination.materialAid = { sourceId: source.id, nationId: source.nationId,
        resource: STEEL_TOOLS, quantity: 1, travelDays, arrivalDay: day + travelDays, returning: false };
      emitOnce(world, `${source.id}/${destination.id}/${day}`, 'miningToolsDispatched', {
        settlementId: source.id, recipientSettlementId: destination.id, nationId: source.nationId,
        forged, ...(forged ? { x: smithy.x, y: smithy.y } : storeTile(world, from))
      });
      break;
    }
  }

  const projectNeeds = new Map(world.constructionSites.map(site => [site.settlementId,
    world.reservations.some(r => r.siteId === site.id) ? {} : buildings[site.kind].cost]));
  const industrialNeeds = new Map();
  for (const smithy of world.buildings.filter(b => b.kind === 'smithy')) {
    const id = smithy.settlementId;
    if (unlocked(world, id, 'steel_1') && world.citizens.some(c =>
        c.alive && c.settlementId === id && c.profession === 'miner' && !c.steelMiningTools)) {
      industrialNeeds.set(id, steelDemandForTools);
    }
  }

  const arcaneNeeds = new Map(world.stockpiles.map(store => [store.settlementId, arcaneGearDemand(world, store)]));
  for (const destination of world.settlements) {
    const residents = population.get(destination.id);
    if (!residents || destination.foodWarning || !destination.nationId || destination.materialAid) continue;
    const to = stores.get(destination.id);
    const demand = { ...projectNeeds.get(destination.id) };
    demand.iron = Math.max(demand.iron ?? 0, industrialNeeds.get(destination.id) ?? 0, arcaneNeeds.get(destination.id).iron ?? 0);
    demand.manaStone = arcaneNeeds.get(destination.id).manaStone ?? 0;
    for (const [resource, target] of Object.entries(demand)) {
      const needed = Math.min(target - available(to, resource), storageRoom(to, resource, residents * FOOD_TARGET_PER_PERSON));
      if (needed <= 0) continue;
      for (const source of world.settlements) {
        if (source === destination || source.nationId !== destination.nationId || source.foodWarning ||
            !population.has(source.id)) continue;
        const from = stores.get(source.id);
        const reserve = Math.max(CONSTRUCTION_STORAGE_RESERVE[resource] ?? (resource === 'manaStone' ? gear.arcane.manaStoneReserve : TECH.miningToolIronReserve),
          arcaneNeeds.get(source.id)[resource] ?? 0,
          projectNeeds.get(source.id)?.[resource] ?? 0, resource === 'iron' ? industrialNeeds.get(source.id) ?? 0 : 0);
        const quantity = Math.min(needed, available(from, resource) - reserve);
        if (quantity <= 0) continue;
        const path = route(from, to);
        if (!path) continue;
        const travelDays = Math.max(1, Math.ceil(path.length / 32));
        from.total[resource] -= quantity;
        destination.materialAid = { sourceId: source.id, nationId: source.nationId,
          resource, quantity, travelDays, arrivalDay: day + travelDays, returning: false };
        break;
      }
      if (destination.materialAid) break;
    }
  }
}

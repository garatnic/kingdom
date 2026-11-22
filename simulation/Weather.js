import { TIME_TICKS_PER_DAY, TIME_TICKS_PER_YEAR } from '../data/balance.js';
import { FARM_HARVEST_TICKS } from '../data/buildings.js';
import { seedState } from '../engine/random.js';
import { emitOnce } from '../systems/History.js';
import { available } from './Economy.js';

export function updateWeather(world) {
  const now = world.worldTimeTick;
  const year = Math.floor(now / TIME_TICKS_PER_YEAR);
  if (year === 0 || now % TIME_TICKS_PER_YEAR !== 18 * TIME_TICKS_PER_DAY) return;
  const [season, location] = seedState(JSON.stringify([world.seed, year, 'summer-drought']));
  if (season % 3 !== 0) return;

  const farms = world.buildings.filter(farm => farm.kind === 'farm' && !farm.arcaneIrrigation &&
    !farm.droughtCommandId && !farm.fertilityCommandId &&
    (farm.harvestAt ?? farm.completedAt + FARM_HARVEST_TICKS) < now + FARM_HARVEST_TICKS);
  if (!farms.length) return;
  const farm = farms[location % farms.length];
  const settlement = world.settlements.find(item => item.id === farm.settlementId);
  const store = world.stockpiles.find(item => item.settlementId === farm.settlementId);
  const eventKey = 'summer-drought/' + year;
  if (!emitOnce(world, eventKey, 'seasonalDrought', {
    x: farm.x, y: farm.y, settlementId: farm.settlementId, nationId: settlement?.nationId,
    affectedBuildingIds: [farm.id], foodBeforeDrought: store ? { [farm.settlementId]: available(store, 'food') } : {}
  })) return;
  farm.harvestAt = now + FARM_HARVEST_TICKS;
  farm.droughtCommandId = eventKey;
}

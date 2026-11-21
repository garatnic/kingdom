import { NATIONS } from '../data/nations.js';

export const tileDistance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function buildingDistance(a, b) {
  const gap = (start, length, otherStart, otherLength) =>
    Math.max(0, start - otherStart - otherLength + 1, otherStart - start - length + 1);
  return gap(a.x, a.width ?? 1, b.x, b.width ?? 1) +
    gap(a.y, a.height ?? 1, b.y, b.height ?? 1);
}

function claim(world, settlement, anchor, replace) {
  const { width, height } = world.map;
  const radius = NATIONS.territoryRadius;
  for (let y = Math.max(0, anchor.y - radius); y < Math.min(height, anchor.y + (anchor.height ?? 1) + radius); y++) {
    for (let x = Math.max(0, anchor.x - radius); x < Math.min(width, anchor.x + (anchor.width ?? 1) + radius); x++) {
      const index = y * width + x;
      const owner = world.territory[index];
      if (buildingDistance(anchor, { x, y }) <= radius && (!owner || replace?.(owner, { x, y }))) {
        world.territory[index] = settlement.id;
      }
    }
  }
}

export function initializeTerritory(world) {
  if (world.territory) return;
  world.territory = {};
  const founded = world.settlements.filter(s => s.nationId)
    .sort((a, b) => Number(a.nationId.split(':')[1]) - Number(b.nationId.split(':')[1]));
  const byId = new Map(founded.map(s => [s.id, s]));
  // Preserve the old nearest-center borders before extending claims from existing buildings.
  for (const settlement of founded) {
    claim(world, settlement, settlement, (owner, tile) => tileDistance(settlement, tile) < tileDistance(byId.get(owner), tile));
  }
  for (const building of world.buildings.slice().sort((a, b) =>
    (a.completedAt ?? 0) - (b.completedAt ?? 0) || Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]))) {
    const settlement = byId.get(building.settlementId);
    if (settlement) claim(world, settlement, building);
  }
}

export function claimSettlement(world, settlement) {
  claim(world, settlement, settlement);
  for (const building of world.buildings) {
    if (building.settlementId === settlement.id) claim(world, settlement, building);
  }
}

export function claimBuilding(world, building) {
  const settlement = world.settlements.find(s => s.id === building.settlementId);
  if (!settlement?.nationId) return;
  initializeTerritory(world);
  claim(world, settlement, building);
}

export function territoryAt(world, tile) {
  const { width, height } = world.map;
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
      tile.x < 0 || tile.x >= width || tile.y < 0 || tile.y >= height) return null;
  initializeTerritory(world);
  const owner = world.territory[tile.y * width + tile.x];
  return world.settlements.find(s => s.id === owner)?.nationId ?? null;
}

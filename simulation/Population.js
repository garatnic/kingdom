import { nextId } from '../engine/World.js';
import { resources } from './Economy.js';

export function recordDeath(world, citizen, cause) {
  if (!citizen.alive) return;
  citizen.alive = false;
  citizen.hp = 0;
  citizen.action = { kind: 'idle', phase: 'plan', targetId: null, startedAt: world.worldTimeTick, progress: 0 };
  citizen.homeBuildingId = null;
  const partner = world.citizens.find(person => person.id === citizen.partnerId);
  if (partner?.alive) {
    partner.partnerId = null;
    delete partner.nextBirthCheckTick;
  }
  delete citizen.nextBirthCheckTick;
  for (const shipment of world.inTransit.filter(item => item.carrierId === citizen.id)) {
    Object.assign(shipment, citizen.lastKnownSafeTile, { carrierId: null });
  }
  for (const resource of resources) {
    const quantity = citizen.inventory[resource];
    if (!quantity) continue;
    world.resourceNodes.push({
      id: nextId(world, 'node'), resource, quantity, ...citizen.lastKnownSafeTile, dropped: true
    });
    citizen.inventory[resource] = 0;
  }
  world.events.push({
    id: nextId(world, 'event'), type: 'death', cause,
    citizenId: citizen.id, worldTimeTick: world.worldTimeTick, ...citizen.lastKnownSafeTile
  });
}

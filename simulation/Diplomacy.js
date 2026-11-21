import { NATIONS } from '../data/nations.js';

export function friendlyNations(world, source, destination) {
  return source && destination && source.id !== destination.id && source.fallenAt === undefined && destination.fallenAt === undefined &&
    (source.relations?.[destination.id] ?? 0) >= NATIONS.friendly &&
    (destination.relations?.[source.id] ?? 0) >= NATIONS.friendly &&
    !world.campaigns?.some(c => (c.status === 'marching' || c.status === 'siege') &&
    ((c.attackerId === source.id && c.defenderId === destination.id) ||
      (c.attackerId === destination.id && c.defenderId === source.id)));
}

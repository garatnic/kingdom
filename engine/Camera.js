import { TILE, MIN_ZOOM, MAX_ZOOM } from '../data/balance.js';

export function createCamera(world) {
  return { mode: 'free', x: world.settlements[0].x + 0.5, y: world.settlements[0].y + 0.5, zoom: 1 };
}

export function pan(camera, dx, dy, map) {
  camera.x = Math.min(map.width, Math.max(0, camera.x - dx / (camera.zoom * TILE)));
  camera.y = Math.min(map.height, Math.max(0, camera.y - dy / (camera.zoom * TILE)));
  camera.mode = 'manualOverride';
}

export function zoomAt(camera, factor, dx, dy, map) {
  const previous = camera.zoom;
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, previous * factor));
  pan(camera, dx * (1 - camera.zoom / previous), dy * (1 - camera.zoom / previous), map);
}

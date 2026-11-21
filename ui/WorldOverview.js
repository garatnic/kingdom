import { TILE } from '../data/balance.js';
import { nationColor, terrainColors } from '../engine/Renderer.js';

export class WorldOverview {
  constructor(canvas, toggle, mapCanvas, getWorld, getCamera, move) {
    this.canvas = canvas;
    this.mapCanvas = mapCanvas;
    this.getWorld = getWorld;
    this.getCamera = getCamera;
    this.layer = document.createElement('canvas');
    toggle.onclick = () => {
      canvas.hidden = !canvas.hidden;
      toggle.setAttribute('aria-pressed', String(!canvas.hidden));
    };
    canvas.onclick = event => {
      const rect = canvas.getBoundingClientRect();
      const { width, height } = getWorld().map;
      move((event.clientX - rect.left) / rect.width * width, (event.clientY - rect.top) / rect.height * height);
    };
    canvas.onkeydown = event => {
      const offset = { ArrowUp: [0, -12], ArrowDown: [0, 12], ArrowLeft: [-12, 0], ArrowRight: [12, 0] }[event.key];
      if (!offset) return;
      event.preventDefault();
      const camera = getCamera();
      move(camera.x + offset[0], camera.y + offset[1]);
    };
  }

  draw() {
    const { canvas, layer } = this;
    if (canvas.hidden) return;
    const world = this.getWorld();
    const camera = this.getCamera();
    const { width, height, terrain } = world.map;
    if (canvas.width !== width || canvas.height !== height || this.terrain !== terrain) {
      canvas.width = layer.width = width;
      canvas.height = layer.height = height;
      this.terrain = terrain;
      const background = layer.getContext('2d');
      for (let index = 0; index < terrain.length; index++) {
        background.fillStyle = terrainColors[terrain[index]];
        background.fillRect(index % width, Math.floor(index / width), 1, 1);
      }
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(layer, 0, 0);
    for (const settlement of world.settlements) {
      ctx.fillStyle = settlement.nationId ? nationColor(settlement.nationId) : '#fff3c3';
      ctx.fillRect(settlement.x - 2, settlement.y - 2, 5, 5);
      ctx.strokeStyle = '#172d28';
      ctx.strokeRect(settlement.x - 2, settlement.y - 2, 5, 5);
    }
    const rect = this.mapCanvas.getBoundingClientRect();
    const viewWidth = rect.width / (TILE * camera.zoom);
    const viewHeight = rect.height / (TILE * camera.zoom);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(camera.x - viewWidth / 2, camera.y - viewHeight / 2, viewWidth, viewHeight);
  }
}

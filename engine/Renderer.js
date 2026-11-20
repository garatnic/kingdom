import { monsters } from '../data/combat.js';
import { TILE, citizenRaces } from '../data/balance.js';

const colors = { grass: '#577d4c', forest: '#365a43', mountain: '#77786a', water: '#346075' };
const resourceColors = { food: '#d88479', wood: '#99bb72', stone: '#bbc5c1', iron: '#db926b', manaStone: '#c6a7e8' };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  draw(world, camera) {
    const { canvas, ctx } = this;
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const scale = TILE * camera.zoom;
    const left = camera.x - width / (2 * scale);
    const top = camera.y - height / (2 * scale);
    const right = left + width / scale;
    const bottom = top + height / scale;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#142b29';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(-left * scale, -top * scale);
    ctx.scale(scale / TILE, scale / TILE);
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(world.map.height, bottom); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(world.map.width, right); x++) {
        const terrain = world.map.terrain[y * world.map.width + x];
        this.tile(x, y, terrain);
      }
    }

    const visible = ({ x, y }) => x >= left - 1 && x <= right + 1 && y >= top - 1 && y <= bottom + 1;
    for (const site of world.constructionSites.filter(visible)) {
      ctx.strokeStyle = '#dfbc81';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(site.x * TILE + 2, site.y * TILE + 2, site.width * TILE - 4, site.height * TILE - 4);
      ctx.setLineDash([]);
    }
    for (const building of world.buildings.filter(visible)) {
      const x = building.x * TILE;
      const y = building.y * TILE;
      if (building.kind === 'farm') {
        ctx.fillStyle = '#735e3c';
        ctx.fillRect(x + 2, y + 2, building.width * TILE - 4, building.height * TILE - 4);
        ctx.fillStyle = '#a5a25b';
        for (let row = 7; row < building.height * TILE - 4; row += 8) {
          ctx.fillRect(x + 6, y + row, building.width * TILE - 12, 3);
        }
        continue;
      }
      ctx.fillStyle = '#354233';
      ctx.fillRect(x + 3, y + 20, 26, 11);
      ctx.fillStyle = '#c8a574';
      ctx.fillRect(x + 6, y + 12, 20, 16);
      ctx.fillStyle = '#9d563e';
      ctx.fillRect(x + 3, y + 8, 26, 9);
      ctx.fillRect(x + 8, y + 4, 16, 4);
      ctx.fillStyle = '#473932';
      ctx.fillRect(x + 14, y + 20, 5, 8);
    }
    for (const node of world.resourceNodes.filter(visible)) {
      const x = node.x * TILE + 16;
      const y = node.y * TILE + 21;
      ctx.fillStyle = '#233a32';
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.fillStyle = resourceColors[node.resource];
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }

    for (const monster of world.monsters.filter(m => m.alive && visible(m))) {
      const x = monster.x * TILE + 16;
      const y = monster.y * TILE + 16;
      ctx.fillStyle = monsters[monster.species]?.color ?? '#b66d54';
      ctx.fillRect(x - 6, y - 4, 12, 9);
      ctx.fillRect(x - 3, y - 7, 6, 3);
      ctx.fillStyle = '#233a32';
      ctx.fillRect(x - 3, y - 3, 2, 2);
      ctx.fillRect(x + 2, y - 3, 2, 2);
    }
    const citizens = world.citizens.filter(c => c.alive && visible(c)).sort((a, b) => a.y - b.y);
    for (const c of citizens) {
      if (camera.zoom <= 0.65) {
        ctx.fillStyle = citizenRaces[c.race]?.color;
        ctx.fillRect(c.x * TILE - 3, c.y * TILE - 3, 6, 6);
      } else {
        const quest = c.action.kind === 'adventure' ? world.quests.find(q => q.id === c.action.targetId) : undefined;
        this.citizen(c, world.worldTimeTick, quest);
      }
    }
  }

  tile(x, y, terrain) {
    const { ctx } = this;
    const px = x * TILE;
    const py = y * TILE;
    const pattern = ((x * 37) ^ (y * 53)) & 15;
    ctx.fillStyle = colors[terrain];
    ctx.fillRect(px, py, TILE, TILE);
    if (terrain === 'forest') {
      ctx.fillStyle = '#294d3a';
      ctx.fillRect(px + 7, py + 17, 21, 12);
      ctx.fillStyle = '#497654';
      ctx.fillRect(px + 8 + pattern % 4, py + 5, 12, 17);
      ctx.fillRect(px + 5 + pattern % 4, py + 12, 18, 8);
      ctx.fillStyle = '#6e925e';
      ctx.fillRect(px + 11 + pattern % 4, py + 6, 5, 4);
    } else if (terrain === 'mountain') {
      ctx.fillStyle = '#575f57';
      ctx.fillRect(px + 5, py + 19, 25, 10);
      ctx.fillStyle = '#98998a';
      ctx.fillRect(px + 10, py + 11, 15, 10);
      ctx.fillRect(px + 14, py + 6, 7, 5);
    } else {
      ctx.fillStyle = terrain === 'water' ? '#467689' : '#638959';
      ctx.fillRect(px + 3 + pattern, py + 7 + pattern, terrain === 'water' ? 9 : 4, 2);
    }
  }

  citizen(citizen, tick, quest) {
    const { ctx } = this;
    const x = Math.round(citizen.x * TILE);
    const y = Math.round(citizen.y * TILE);
    const foot = citizen.action.phase === 'travel' ? Math.floor(tick / 6) % 4 : 0;
    ctx.fillStyle = '#263e34';
    ctx.fillRect(x - 7, y + 1, 14, 4);
    ctx.fillRect(x - 6, y - 14, 12, 15);
    ctx.fillRect(x - 4, y - 19, 8, 6);
    ctx.fillStyle = citizenRaces[citizen.race]?.color;
    ctx.fillRect(x - 5, y - 11, 10, 9);
    ctx.fillStyle = '#ebc7a5';
    ctx.fillRect(x - 3, y - 17, 6, 6);
    ctx.fillStyle = '#2c3736';
    ctx.fillRect(x - 4, y - 2, 3, 4 + (foot === 1 ? 2 : 0));
    ctx.fillRect(x + 1, y - 2, 3, 4 + (foot === 3 ? 2 : 0));
    if (citizen.action.phase === 'perform') {
      const effect = { gather: '#e9d28e', farm: '#b4d881', build: '#d9b37d',
        adventure: quest?.casting ? '#c6a7e8' : '#e8c1a1' }[citizen.action.kind];
      if (effect) {
        ctx.fillStyle = effect;
        const shift = Math.floor(tick / 12) % 4;
        ctx.fillRect(x + 7 + shift, y - 8 - shift, 3, 7);
      }
    }
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function poll(fn, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Browser condition timed out');
}

const realtimeMinutes = Number(process.env.KINGDOM_REALTIME_MINUTES ?? 0);

test('Chromium renders the map and runs pause, speed, camera and JSON controls', { timeout: 480_000 + realtimeMinutes * 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kingdom-chromium-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['serve.js'], { env: { ...process.env, PORT: '0' } });
  const browser = spawn(process.env.CHROMIUM ?? 'chromium', [
    '--headless', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-gpu',
    ...(process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : []),
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserError = '';
  browser.stderr.on('data', data => { browserError = (browserError + data.toString()).slice(-4000); });
  let socket;
  try {
    const [[address]] = await Promise.all([
      once(server.stdout, 'data'),
      new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); })
    ]);
    const url = address.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const page = await poll(async () => {
      if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(browserError || 'Chromium exited');
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return tabs.find(tab => tab.type === 'page');
      } catch {
        return null;
      }
    }, 1000).catch(error => { throw new Error(browserError || error.message); });
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    const waiting = new Map();
    const errors = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      const callback = waiting.get(message.id);
      if (callback) {
        waiting.delete(message.id);
        callback(message);
      }
    });
    async function send(method, params = {}) {
      const message = await new Promise(resolve => {
        waiting.set(++id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
      if (message.error) throw new Error(JSON.stringify(message.error));
      return message.result;
    }
    async function evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      });
      assert.equal(exceptionDetails, undefined);
      return result.value;
    }
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    await poll(() => evaluate("document.querySelector('#population')?.textContent === '住民 12人'"));
    const canvasImage = "document.querySelector('#map').toDataURL()";
    const initialImage = await evaluate(canvasImage);
    const initialTime = await evaluate("document.querySelector('#clock').textContent");
    await evaluate("document.querySelector('[data-speed=\"20\"]').click()");
    await poll(async () => (await evaluate("document.querySelector('#clock').textContent")) !== initialTime);
    await evaluate("document.querySelector('[data-speed=\"0\"]').click()");
    const paused = await evaluate("document.querySelector('#clock').textContent");
    await delay(350);
    assert.equal(await evaluate("document.querySelector('#clock').textContent"), paused);
    const beforeZoom = await evaluate(canvasImage);
    assert.notEqual(beforeZoom, initialImage);
    await evaluate("document.querySelector('#zoom-in').click()");
    await poll(async () => (await evaluate(canvasImage)) !== beforeZoom);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 220, y: 250, button: 'left', clickCount: 1 });
    const beforePan = await evaluate(canvasImage);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 290, y: 270, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 290, y: 270, button: 'left', clickCount: 1 });
    await poll(async () => (await evaluate(canvasImage)) !== beforePan);

    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });
    await evaluate("document.querySelector('#save').click()");
    const savePath = join(profile, 'kingdom-observer.json');
    const snapshot = await poll(async () => {
      try { return JSON.parse(await readFile(savePath, 'utf8')); }
      catch { return null; }
    });
    assert.equal(snapshot.world.gameSpeed, 0);
    assert.equal(snapshot.world.citizens.length, 12);
    assert.equal(snapshot.world.settings.camera.zoom, 1.25);
    assert.ok(snapshot.world.settings.camera.x < 32.5);
    await evaluate("document.querySelector('#overview-toggle').click()");
    await poll(() => evaluate("!document.querySelector('#overview').hidden && document.querySelector('#overview').width === 256"));
    const beforeOverviewJump = await evaluate(canvasImage);
    await evaluate(`(() => {
      const map = document.querySelector('#overview');
      const box = map.getBoundingClientRect();
      map.dispatchEvent(new MouseEvent('click', { clientX: box.left + box.width * 0.75, clientY: box.top + box.height * 0.75 }));
    })()`);
    await poll(async () => (await evaluate(canvasImage)) !== beforeOverviewJump);
    await evaluate("document.querySelector('#overview-toggle').click()");

    await evaluate(`(async () => {
      const { createWorld } = await import('/engine/World.js');
      const { createSnapshot } = await import('/systems/SaveManager.js');
      const { openSaveStorage, writeGeneration } = await import('/systems/SaveStorage.js');
      const database = await openSaveStorage();
      try {
        await writeGeneration(database, await createSnapshot(createWorld('previous-browser-save')));
      } finally {
        database.close();
      }
    })()`);
    await evaluate("document.querySelector('#seed').value = 'new-seed'; document.querySelector('form').requestSubmit()");
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [savePath] });
    await poll(() => evaluate("document.querySelector('#status').textContent === 'セーブを読み込みました'"));
    assert.equal(await evaluate("document.querySelector('#clock').textContent"), paused);
    assert.equal(await evaluate("document.querySelector('#seed').value"), 'world-tree');
    await send('Page.reload');
    await poll(() => evaluate("document.querySelector('#status')?.textContent === 'ブラウザのセーブを復元しました'"));
    assert.equal(await evaluate("document.querySelector('#seed').value"), 'world-tree');
    assert.equal(await evaluate("document.querySelector('#clock').textContent"), paused);

    const generations = await evaluate(`(async () => {
      const { createSnapshot } = await import('/systems/SaveManager.js');
      const { openSaveStorage, readLatestGeneration, writeGeneration } = await import('/systems/SaveStorage.js');
      const { createWorld } = await import('/engine/World.js');
      const database = await openSaveStorage();
      for (const seed of ['one', 'two', 'three', 'four']) {
        await writeGeneration(database, await createSnapshot(createWorld(seed)));
      }
      const readKeys = () => new Promise((resolve, reject) => {
        const request = database.transaction('snapshots').objectStore('snapshots').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const before = await readKeys();
      const aborted = await new Promise(resolve => {
        const tx = database.transaction('snapshots', 'readwrite');
        tx.onabort = () => resolve(true);
        tx.oncomplete = () => resolve(false);
        tx.objectStore('snapshots').add({ incomplete: true });
        tx.abort();
      });
      const after = await readKeys();
      const restoredAfterAbort = await readLatestGeneration(database);
      await writeGeneration(database, { corrupt: true });
      const count = (await readKeys()).length;
      const latest = await readLatestGeneration(database);
      database.close();
      return { before, after, count, seedAfterCorruption: latest.seed, seedAfterAbort: restoredAfterAbort.seed, aborted };
    })()`);
    assert.equal(generations.aborted, true);
    assert.equal(generations.before.length, 3);
    assert.deepEqual(generations.after, generations.before);
    assert.equal(generations.seedAfterAbort, 'four');
    assert.equal(generations.count, 3);
    assert.equal(generations.seedAfterCorruption, 'four');
    await evaluate(`(() => {
      document.querySelector('#god-kind').value = 'resource';
      document.querySelector('#god-kind').dispatchEvent(new Event('change'));
      document.querySelector('#god-x').value = '31';
      document.querySelector('#god-y').value = '32';
      document.querySelector('#god-form').requestSubmit();
    })()`);
    await poll(() => evaluate("document.querySelector('#god-status').textContent === '介入を適用しました'"));
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('神の介入')"));
    await evaluate(`(() => {
      const filter = document.querySelector('#event-filter');
      filter.value = 'god';
      filter.dispatchEvent(new Event('change'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('神の介入')"));

    await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'ecology';
      tab.dispatchEvent(new Event('change'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('探索済み領域の魔物') && document.querySelector('#history-body').textContent.includes('スライム')"));

    await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'citizen';
      tab.dispatchEvent(new Event('change'));
      document.querySelector('#follow').click();
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('アルディン')"));
    await evaluate(`(() => {
      const search = document.querySelector('#history-search');
      search.value = 'ミラ';
      search.dispatchEvent(new Event('input'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-subject').options.length === 1 && document.querySelector('#history-body').textContent.includes('ミラ')"));
    await evaluate(`(() => {
      document.querySelector('#favorite-citizen').click();
      const search = document.querySelector('#history-search');
      search.value = '';
      search.dispatchEvent(new Event('input'));
      document.querySelector('#favorite-only').click();
    })()`);
    await poll(() => evaluate("document.querySelector('#history-subject').options.length === 1 && document.querySelector('#favorite-citizen').getAttribute('aria-pressed') === 'true'"));
    await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'family';
      tab.dispatchEvent(new Event('change'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('配偶者')"));
    await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'nation';
      tab.dispatchEvent(new Event('change'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('対象がまだありません')"));
    await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'settlement';
      tab.dispatchEvent(new Event('change'));
    })()`);
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('住宅') && document.querySelector('#history-body').textContent.includes('倉庫')"));
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await poll(() => evaluate("innerWidth === 390 && document.documentElement.scrollWidth === 390"));
    const button = await evaluate(`(() => {
      const rect = document.querySelector('[data-speed="5"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [button] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await poll(() => evaluate(`document.querySelector('[data-speed="5"]').getAttribute('aria-pressed') === 'true'`));
    assert.deepEqual(errors, []);
    await send('Emulation.clearDeviceMetricsOverride');
    const cityPath = join(profile, 'natural-city.json');
    const generator = spawn(process.execPath, ['test/natural-city.js', cityPath], { stdio: 'inherit' });
    const [generationCode] = await once(generator, 'exit');
    assert.equal(generationCode, 0);
    const city = JSON.parse(await readFile(cityPath, 'utf8')).world;
    const residents = city.citizens.filter(citizen => citizen.alive).length;
    const { root: cityRoot } = await send('DOM.getDocument');
    const { nodeId: cityInput } = await send('DOM.querySelector', { nodeId: cityRoot.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId: cityInput, files: [cityPath] });
    await poll(() => evaluate(`document.querySelector('#population').textContent === '住民 ${residents}人' &&
      document.querySelector('#status').textContent === 'セーブを読み込みました'`));
    await send('Page.bringToFront');
    const clock = () => evaluate("document.querySelector('#clock').textContent");
    const gameMinutes = label => {
      const [, year, day, hour, minute] = /第([0-9]+)年 .*? 第([0-9]+)日 ([0-9]+):([0-9]+)/.exec(label).map(Number);
      return ((year - 1) * 30 + day - 1) * 1440 + hour * 60 + minute;
    };
    const measureFps = () => evaluate(`new Promise(resolve => {
      let frames = 0;
      const start = performance.now();
      function sample(now) {
        frames++;
        if (now - start >= 2000) resolve(Math.round(frames * 1000 / (now - start)));
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`);
    const initialFps = await measureFps();
    const startMinutes = gameMinutes(await clock());
    await evaluate("document.querySelector('[data-speed=\"1\"]').click()");
    const begin = performance.now();
    const duration = realtimeMinutes ? realtimeMinutes * 60_000 : 65_000;
    console.log(`Starting ${duration / 1000}-second natural-city stability check`);
    await delay(duration);
    const elapsed = performance.now() - begin;
    const minutes = gameMinutes(await clock()) - startMinutes;
    const expectedMinutes = elapsed * 12 / 1000;
    assert.ok(Math.abs(minutes - expectedMinutes) / expectedMinutes <= 0.03,
      `Observed ${minutes} game minutes, expected ${expectedMinutes.toFixed(1)}`);
    const finalFps = await measureFps();
    const savedTick = await evaluate(`(async () => {
      const { openSaveStorage, readLatestGeneration } = await import('/systems/SaveStorage.js');
      const database = await openSaveStorage();
      try {
        const saved = await readLatestGeneration(database);
        return saved.seed === 'world-tree' ? saved.worldTimeTick : 0;
      } finally {
        database.close();
      }
    })()`);
    assert.ok(savedTick > city.worldTimeTick, 'The running city must be automatically saved');
    await send('Page.reload');
    await poll(() => evaluate("document.querySelector('#status')?.textContent === 'ブラウザのセーブを復元しました'"));
    assert.ok(Math.abs(gameMinutes(await clock()) - savedTick / 10) <= 12);
    await evaluate(`(async () => {
      const { openSaveStorage, writeGeneration } = await import('/systems/SaveStorage.js');
      const database = await openSaveStorage();
      try {
        await writeGeneration(database, { corrupt: true });
      } finally {
        database.close();
      }
    })()`);
    await send('Page.reload');
    await poll(() => evaluate("document.querySelector('#status')?.textContent.includes('以前の自動保存から復元しました')"));
    assert.ok(Math.abs(gameMinutes(await clock()) - savedTick / 10) <= 12);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await poll(() => evaluate("innerWidth === 390 && document.documentElement.scrollWidth === 390"));
    const pauseButton = await evaluate(`(() => {
      const rect = document.querySelector('[data-speed="0"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pauseButton] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await poll(() => evaluate(`document.querySelector('[data-speed="0"]').getAttribute('aria-pressed') === 'true'`));
    console.log(JSON.stringify({ naturalPopulation: residents, realtimeElapsedMs: Math.round(elapsed),
      approximateGameMinutes: minutes, javascriptExceptions: errors.length, initialFps, finalFps, savedTick }));
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.bringToFront');
    await evaluate(`(async () => {
      const { createWorld } = await import('/engine/World.js');
      const { createAdult } = await import('/simulation/CreateAdult.js');
      const { createSnapshot } = await import('/systems/SaveManager.js');
      const { emitOnce, trimHistory } = await import('/systems/History.js');
      const world = createWorld('dense-browser-test');
      for (let i = 0; i < 2100; i++) emitOnce(world, 'construction:' + i, 'constructionCompleted', { x: 31, y: 31 });
      emitOnce(world, 'campaign:1', 'warDeclared', { x: 18, y: 18, actorIds: [world.citizens[0].id] });
      emitOnce(world, 'campaign:1', 'fieldBattle', { x: 50, y: 50, nationIds: [] });
      emitOnce(world, 'quest:1', 'tradeEscortDeparted', { questId: 'quest:1', x: 21, y: 21 });
      emitOnce(world, 'quest:1/monster:1', 'tradeEscortClash', { questId: 'quest:1', x: 44, y: 44 });
      emitOnce(world, 'settlement:1/settlement:2/trade/1', 'internationalTradeCompleted', { questId: 'quest:1', x: 24, y: 24 });
      emitOnce(world, 'settlement:1/food/1', 'foodShortage', { x: 30, y: 30, food: 0 });
      const shortage = world.events.at(-1);
      emitOnce(world, 'settlement:1/food/3', 'foodRecovered', {
        x: 30, y: 30, food: 36, foodAtShortage: 0, causeEventId: shortage.id
      });
      for (let i = 0; i < 45; i++) emitOnce(world, 'background:' + i, 'adventureDeparted', { x: 31, y: 31 });
      trimHistory(world);
      world.map.terrain.fill('grass');
      const settlement = world.settlements[0];
      for (let i = 0; i < 288; i++) {
        const tile = { x: 16 + i % 16, y: 24 + Math.floor(i / 16) };
        world.citizens.push(createAdult(world, 'human', tile, settlement));
      }
      const snapshot = await createSnapshot(world);
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(snapshot)], 'dense-test.json', { type: 'application/json' }));
      const file = document.querySelector('#file');
      file.files = transfer.files;
      file.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await poll(() => evaluate("document.querySelector('#population').textContent === '住民 300人'"));
    const denseClock = await evaluate("document.querySelector('#clock').textContent");
    const denseFps = await evaluate(`new Promise(resolve => {
      const start = performance.now();
      let frames = 0;
      function sample(now) {
        frames++;
        if (now - start >= 2000) resolve(Math.round(frames * 1000 / (now - start)));
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`);
    assert.notEqual(await evaluate("document.querySelector('#clock').textContent"), denseClock);
    console.log(JSON.stringify({ syntheticPopulation: 300, sampleMs: 2000, observedFps: denseFps }));
    await evaluate(`(() => {
      document.querySelector('[data-speed="0"]').click();
      const tab = document.querySelector('#history-tab');
      tab.value = 'world';
      document.querySelector('#event-filter').selectedIndex = 0;
      tab.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await evaluate(`document.querySelector('#history-body').textContent.includes('備蓄 0 → 36') &&
      document.querySelector('#history-body').textContent.includes('食料難が発生した集落')`), true);
    const relatedLocation = (record, related) => `(() => {
      const recordButton = [...document.querySelectorAll('#history-body > button')].find(button =>
        button.textContent.startsWith(${JSON.stringify(record)}));
      const details = recordButton?.nextElementSibling;
      if (details?.tagName !== 'DETAILS') return false;
      details.querySelector('summary').click();
      const button = [...details.querySelectorAll('button')].find(entry =>
        entry.textContent.startsWith(${JSON.stringify(related)}));
      if (!button) return false;
      button.click();
      return true;
    })()`;
    const beforeBattleLink = await evaluate(canvasImage);
    assert.equal(await evaluate(relatedLocation('開戦', '野戦で両軍が交戦')), true);
    await poll(async () => (await evaluate(canvasImage)) !== beforeBattleLink);
    const beforeTradeLink = await evaluate(canvasImage);
    assert.equal(await evaluate(relatedLocation('友好国間で物資を交換', '交易品の護衛に出発')), true);
    await poll(async () => (await evaluate(canvasImage)) !== beforeTradeLink);
    const beforeExchangeLink = await evaluate(canvasImage);
    assert.equal(await evaluate(relatedLocation('護衛隊が街道で交戦', '友好国間で物資を交換')), true);
    await poll(async () => (await evaluate(canvasImage)) !== beforeExchangeLink);
    const beforeAutoCamera = await evaluate(canvasImage);
    await evaluate("document.querySelector('#auto-camera').click()");
    await poll(async () => (await evaluate(canvasImage)) !== beforeAutoCamera);
    assert.equal(await evaluate(relatedLocation('護衛隊が街道で交戦', '友好国間で物資を交換')), true);
    await poll(() => evaluate("!document.querySelector('#auto-camera').checked"));
    const participantName = await evaluate(`(() => {
      const declaration = [...document.querySelectorAll('#history-body > button')]
        .find(button => button.textContent.startsWith('開戦'));
      const details = declaration.nextElementSibling;
      if (!details.open) details.querySelector('summary').click();
      const select = details.querySelector('select[aria-label="関係者の人物伝"]');
      select.selectedIndex = 1;
      const name = select.selectedOptions[0].textContent;
      select.dispatchEvent(new Event('change'));
      return name;
    })()`);
    assert.equal(await evaluate("document.querySelector('#history-tab').value"), 'citizen');
    assert.equal(await evaluate("document.querySelector('#history-body h3').textContent"), participantName);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const eventButton = await evaluate(`(() => {
      const tab = document.querySelector('#history-tab');
      tab.value = 'world';
      tab.dispatchEvent(new Event('change'));
      const button = [...document.querySelectorAll('#history-body > button')]
        .find(entry => entry.textContent.startsWith('開戦'));
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await poll(() => evaluate("document.querySelector('#map').getBoundingClientRect().bottom <= 0"));
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [eventButton] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await poll(() => evaluate(`(() => {
      const bounds = document.querySelector('#map').getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < innerHeight;
    })()`));
    assert.deepEqual(errors, []);
  } finally {
    socket?.close();
    const exited = browser.exitCode === null && browser.signalCode === null && browser.pid ? once(browser, 'exit') : undefined;
    browser.kill();
    server.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

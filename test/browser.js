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

test('Chromium renders the map and runs pause, speed, camera and JSON controls', { timeout: 90_000 + realtimeMinutes * 60_000 }, async () => {
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

    await evaluate("document.querySelector('#seed').value = 'new-seed'; document.querySelector('form').requestSubmit()");
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [savePath] });
    await poll(() => evaluate("document.querySelector('#status').textContent === 'セーブを読み込みました'"));
    assert.equal(await evaluate("document.querySelector('#clock').textContent"), paused);
    assert.equal(await evaluate("document.querySelector('#seed').value"), 'world-tree');

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
    if (realtimeMinutes) {
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate("document.querySelector('#seed').value = 'world-tree'; document.querySelector('form').requestSubmit()");
      await send('Page.bringToFront');
      const clock = () => evaluate("document.querySelector('#clock').textContent");
      const gameMinutes = label => {
        const match = /第([0-9]+)日 ([0-9]+):([0-9]+)/.exec(label);
        return (Number(match[1]) - 1) * 1440 + Number(match[2]) * 60 + Number(match[3]);
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
      const started = gameMinutes(await clock());
      const begin = performance.now();
      console.log(`Starting ${realtimeMinutes}-minute foreground stability check`);
      await delay(realtimeMinutes * 60_000);
      const elapsed = performance.now() - begin;
      const minutes = gameMinutes(await clock()) - started;
      const expectedMinutes = elapsed * 12 / 1000;
      assert.ok(Math.abs(minutes - expectedMinutes) / expectedMinutes <= 0.01,
        `Observed ${minutes} game minutes, expected ${expectedMinutes.toFixed(1)}`);
      assert.equal(await evaluate("document.querySelector('#population').textContent.startsWith('住民 ')"), true);
      assert.equal(await evaluate(`(async () => {
        const { openSaveStorage, readLatestGeneration } = await import('/systems/SaveStorage.js');
        const database = await openSaveStorage();
        const saved = await readLatestGeneration(database);
        database.close();
        return saved.seed === 'world-tree' && saved.worldTimeTick > 0;
      })()`), true);
      console.log(JSON.stringify({ seed: 'world-tree', realtimeElapsedMs: Math.round(elapsed), approximateGameMinutes: minutes,
        javascriptExceptions: errors.length, speed: 1, initialFps, finalFps: await measureFps() }));
    }
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

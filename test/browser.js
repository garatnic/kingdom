import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function poll(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Browser condition timed out');
}

test('Chromium renders the map and runs pause, speed, camera and JSON controls', { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kingdom-chromium-'));
  const server = spawn(process.execPath, ['serve.js'], { env: { ...process.env, PORT: '0' } });
  const browser = spawn(process.env.CHROMIUM ?? 'chromium', [
    '--headless', '--disable-dev-shm-usage',
    ...(process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'
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
    const port = await poll(async () => {
      try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch {
        if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(browserError || 'Chromium exited');
        return null;
      }
    }).catch(error => { throw new Error(browserError || error.message); });
    const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
      await writeGeneration(database, { corrupt: true });
      const count = await new Promise((resolve, reject) => {
        const request = database.transaction('snapshots').objectStore('snapshots').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const latest = await readLatestGeneration(database);
      database.close();
      return [count, latest.seed];
    })()`);
    assert.deepEqual(generations, [3, 'four']);
    await evaluate(`(() => {
      document.querySelector('#god-kind').value = 'resource';
      document.querySelector('#god-kind').dispatchEvent(new Event('change'));
      document.querySelector('#god-x').value = '31';
      document.querySelector('#god-y').value = '32';
      document.querySelector('#god-form').requestSubmit();
    })()`);
    await poll(() => evaluate("document.querySelector('#god-status').textContent === '介入を適用しました'"));
    await poll(() => evaluate("document.querySelector('#history-body').textContent.includes('神の介入')"));
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
  } finally {
    socket?.close();
    const exited = browser.exitCode === null && browser.signalCode === null && browser.pid ? once(browser, 'exit') : undefined;
    browser.kill();
    server.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

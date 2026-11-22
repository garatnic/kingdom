import { readSnapshot } from './SaveManager.js';

const STORE = 'snapshots';
const GENERATIONS = 3;

export function openSaveStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kingdom-observer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブがセーブを使用中です。'));
  });
}

export function writeGeneration(database, snapshot) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.add(snapshot);
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result.slice(0, -GENERATIONS)) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存処理が中断されました。'));
  });
}

export async function readLatestGeneration(database, { onRecovery } = {}) {
  const latest = await readStore(database, store => store.openCursor(null, 'prev'), cursor => cursor?.value);
  if (latest === undefined) return null;
  try {
    return await readSnapshot(JSON.stringify(latest));
  } catch {
    // Read the remaining generations together when the newest one is damaged.
    const saves = await readStore(database, store => store.getAll());
    for (const [index, snapshot] of saves.reverse().entries()) {
      let world;
      try {
        world = await readSnapshot(JSON.stringify(snapshot));
      } catch {
        continue;
      }
      if (index > 0) onRecovery?.();
      return world;
    }
    throw new Error('読み込める保存世代がありません。');
  }
}

function readStore(database, read, value = result => result) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const request = read(tx.objectStore(STORE));
    request.onsuccess = () => resolve(value(request.result));
    request.onerror = () => reject(request.error);
  });
}

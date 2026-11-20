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

export async function readLatestGeneration(database) {
  const saves = await new Promise((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const snapshot of saves.reverse()) {
    try {
      return await readSnapshot(JSON.stringify(snapshot));
    } catch {
      // A damaged newest generation does not prevent opening a valid older one.
    }
  }
  if (saves.length) throw new Error('読み込める保存世代がありません。');
  return null;
}

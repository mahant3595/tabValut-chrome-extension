// TabVault — minimal IndexedDB blob store for logos and wallpapers.
// Large images must NOT be duplicated as Base64 inside chrome.storage; blobs
// live in IndexedDB and are referenced by key from settings/collections.

const DB_NAME = 'tabvault-media';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this context.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open media database.'));
  });
  return dbPromise;
}

function runTx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const out = fn(store);
        tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        tx.onerror = () => reject(tx.error || new Error('Media transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('Media transaction aborted.'));
      })
  );
}

export function mediaKey(prefix = 'img') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function putBlob(key, blob) {
  await runTx('readwrite', (store) => store.put({ key, blob, createdAt: Date.now() }));
  return key;
}

export async function getBlob(key) {
  if (!key) return null;
  const rec = await runTx('readonly', (store) => store.get(key));
  return rec && rec.blob ? rec.blob : null;
}

export async function deleteBlob(key) {
  if (!key) return;
  await runTx('readwrite', (store) => store.delete(key));
}

/** Create an object URL for a stored blob. Caller must revoke it when done. */
export async function blobUrl(key) {
  const blob = await getBlob(key);
  if (!blob || typeof URL === 'undefined' || !URL.createObjectURL) return null;
  return URL.createObjectURL(blob);
}

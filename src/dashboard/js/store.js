// TabVault dashboard — storage / messaging bridge. All library writes go
// through the service worker so the popup and dashboard never race each other.

import { normalizeSettings, mergeSettings } from '../../lib/settings.js';

export function send(msg) {
  return chrome.runtime.sendMessage(msg).then(
    (res) => {
      if (!res || res.ok !== true) {
        const err = new Error((res && res.error) || 'Request failed.');
        err.response = res;
        throw err;
      }
      return res;
    },
    (err) => {
      throw err;
    }
  );
}

export async function getSettings() {
  const res = await send({ type: 'tv:settings:get' });
  return normalizeSettings(res.settings);
}

export async function updateSettings(patch) {
  const res = await send({ type: 'tv:settings:update', patch });
  return normalizeSettings(res.settings);
}

export async function mergeAndSave(patch) {
  const current = await getSettings();
  const next = mergeSettings(current, patch);
  return updateSettings(next);
}

export const collections = {
  list: async () => (await send({ type: 'tv:collections:list' })).collections,
  get: async (id) => (await send({ type: 'tv:collections:get', id })).collection,
  create: async (name, description = '', extra = {}) =>
    (await send({ type: 'tv:collections:create', name, description, ...extra })).collection,
  update: async (id, patch) => (await send({ type: 'tv:collections:update', id, patch })).collection,
  remove: async (id) => (await send({ type: 'tv:collections:delete', id })).result,
  addTabs: async (id, tabs) => (await send({ type: 'tv:collections:addTabs', id, tabs })).result,
  removeTab: async (id, tabId) => (await send({ type: 'tv:collections:removeTab', id, tabId })).result,
  updateTab: async (id, tabId, patch) => (await send({ type: 'tv:collections:updateTab', id, tabId, patch })).tab,
  import: async (imported) => (await send({ type: 'tv:collections:import', collections: imported })).result
};

export async function restoreCollection(collection) {
  // Restoring OPENS new tabs; it never touches existing ones and never
  // creates a Chrome tab group (Chrome would persist it to the Google
  // account, which no extension can undo).
  const urls = collection.tabs.map((t) => t.url).filter(Boolean);
  let created = 0;
  for (const url of urls) {
    // eslint-disable-next-line no-await-in-loop -- sequential to preserve order
    await chrome.tabs.create({ url, active: false });
    created += 1;
  }
  return { created, groupId: null };
}

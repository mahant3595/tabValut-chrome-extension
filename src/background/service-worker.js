// TabVault — MV3 service worker.
// Owns the TabVault library (collections) so the popup and dashboard never
// race each other on read-modify-write of shared storage, and drives the
// lazy vault window (first tab loads, every other tab stays unloaded until
// the user enters it).
//
// TabVault never closes, discards or unloads tabs on its own — that is left
// to Chrome and to whatever unloader extension the user runs.
//
// INVARIANT: nothing in this worker ever calls tabs.remove.

import { createVaultWindow } from './vault-window-core.js';
import { normalizeSettings, mergeSettings } from '../lib/settings.js';
import { normalizeUrlForCompare, domainOf } from '../lib/urls.js';
import { loadFolderLink, gatherAndSync } from '../lib/folder-sync.js';

const COLLECTIONS_KEY = 'collections';
const SETTINGS_KEY = 'settings';

// ---------------------------------------------------------------- vault window

const vaultWindow = createVaultWindow({
  tabs: chrome.tabs,
  windows: chrome.windows,
  storage: chrome.storage.session,
  getURL: (path) => chrome.runtime.getURL(path)
});

// ---------------------------------------------------------------- collections

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadCollections() {
  try {
    const got = await chrome.storage.local.get(COLLECTIONS_KEY);
    const list = got ? got[COLLECTIONS_KEY] : null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveCollections(collections) {
  await chrome.storage.local.set({ [COLLECTIONS_KEY]: collections });
  scheduleFolderBackup();
  return collections;
}

function sanitizeIncomingTab(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url.trim()) return null;
  const url = raw.url.trim();
  const normalized = normalizeUrlForCompare(url);
  if (!normalized || !/^https?:\/\//i.test(normalized)) return null;
  return {
    id: genId(),
    url,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 500) : url,
    favIconUrl: typeof raw.favIconUrl === 'string' ? raw.favIconUrl.slice(0, 2000) : '',
    domain: domainOf(url),
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : '',
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 40)
      : [],
    addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : now
  };
}

const collectionsApi = {
  async list() {
    return loadCollections();
  },
  async create({ name, description = '', tags = [], vaultFolder = false, sourceGroupId = null } = {}) {
    const list = await loadCollections();
    const t = Date.now();
    const collection = {
      id: genId(),
      name: String(name || 'Untitled collection').trim().slice(0, 120) || 'Untitled collection',
      description: String(description || '').slice(0, 2000),
      tags: Array.isArray(tags) ? tags.map((t2) => String(t2).trim().toLowerCase()).filter(Boolean).slice(0, 40) : [],
      vaultFolder: Boolean(vaultFolder),
      sourceGroupId: Number.isInteger(Number(sourceGroupId)) && Number(sourceGroupId) > 0 ? Number(sourceGroupId) : null,
      logo: null,
      wallpaper: null,
      createdAt: t,
      updatedAt: t,
      tabs: []
    };
    list.push(collection);
    await saveCollections(list);
    return collection;
  },
  async update({ id, patch = {} } = {}) {
    const list = await loadCollections();
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error('Collection not found.');
    if (typeof patch.name === 'string' && patch.name.trim()) c.name = patch.name.trim().slice(0, 120);
    if (typeof patch.description === 'string') c.description = patch.description.slice(0, 2000);
    if (Array.isArray(patch.tags)) c.tags = patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 40);
    if (patch.logo !== undefined) c.logo = patch.logo;
    if (patch.wallpaper !== undefined) c.wallpaper = patch.wallpaper;
    if (patch.vaultFolder !== undefined) c.vaultFolder = Boolean(patch.vaultFolder);
    if (patch.sourceGroupId !== undefined) {
      c.sourceGroupId = Number.isInteger(Number(patch.sourceGroupId)) && Number(patch.sourceGroupId) > 0 ? Number(patch.sourceGroupId) : null;
    }
    c.updatedAt = Date.now();
    await saveCollections(list);
    return c;
  },
  async get(id) {
    const list = await loadCollections();
    return list.find((x) => x.id === id) || null;
  },
  async remove({ id } = {}) {
    // Deleting a saved collection never touches live tabs or bookmarks.
    const list = await loadCollections();
    const next = list.filter((x) => x.id !== id);
    await saveCollections(next);
    return { removed: next.length !== list.length };
  },
  async addTabs({ id, tabs = [] } = {}) {
    const list = await loadCollections();
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error('Collection not found.');
    const existing = new Set(c.tabs.map((t) => normalizeUrlForCompare(t.url)).filter(Boolean));
    let added = 0;
    let duplicates = 0;
    const t = Date.now();
    for (const raw of tabs) {
      const tab = sanitizeIncomingTab(raw, t);
      if (!tab) continue;
      const key = normalizeUrlForCompare(tab.url);
      if (key && existing.has(key)) {
        duplicates += 1;
        continue;
      }
      if (key) existing.add(key);
      c.tabs.push(tab);
      added += 1;
    }
    c.updatedAt = t;
    await saveCollections(list);
    return { added, duplicates };
  },
  async removeTab({ id, tabId } = {}) {
    const list = await loadCollections();
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error('Collection not found.');
    const before = c.tabs.length;
    c.tabs = c.tabs.filter((t) => t.id !== tabId);
    c.updatedAt = Date.now();
    await saveCollections(list);
    return { removed: before - c.tabs.length };
  },
  async updateTab({ id, tabId, patch = {} } = {}) {
    const list = await loadCollections();
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error('Collection not found.');
    const tab = c.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error('Saved tab not found.');
    if (typeof patch.title === 'string') tab.title = patch.title.trim().slice(0, 500) || tab.url;
    if (typeof patch.notes === 'string') tab.notes = patch.notes.slice(0, 2000);
    if (Array.isArray(patch.tags)) tab.tags = patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 40);
    c.updatedAt = Date.now();
    await saveCollections(list);
    return tab;
  },
  async importCollections({ collections = [] } = {}) {
    let imported = 0;
    for (const raw of collections) {
      if (!raw || typeof raw !== 'object') continue;
      const t = Date.now();
      const collection = {
        id: genId(),
        name: String(raw.name || 'Imported collection').slice(0, 120),
        description: String(raw.description || '').slice(0, 2000),
        tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 40) : [],
        logo: raw.logo && typeof raw.logo === 'object' ? raw.logo : null,
        wallpaper: raw.wallpaper && typeof raw.wallpaper === 'object' ? raw.wallpaper : null,
        createdAt: Number(raw.createdAt) || t,
        updatedAt: t,
        tabs: []
      };
      // Persist the empty collection first so addTabs() finds it.
      const list = await loadCollections();
      list.push(collection);
      await saveCollections(list);
      await collectionsApi.addTabs({ id: collection.id, tabs: Array.isArray(raw.tabs) ? raw.tabs : [] });
      imported += 1;
    }
    return { imported };
  }
};

// ---------------------------------------------------------------- settings

async function readSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(got ? got[SETTINGS_KEY] : null);
  } catch {
    return normalizeSettings(null);
  }
}

async function writeSettings(patch) {
  // Merge the patch onto the latest stored copy so appearance/library changes
  // never clobber each other.
  const next = mergeSettings(await readSettings(), patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ---------------------------------------------------------- folder backup
// Best-effort mirroring into the folder the user linked: every collection,
// bookmark and tab-group change is written out as plain files that outlive
// the extension. Writes only happen while Chrome grants file access; when it
// does not (permission resets to "prompt" after a restart), backupPending is
// flagged so the dashboard can re-grant from a user gesture and catch up.

let backupTimer = 0;
function scheduleFolderBackup() {
  if (backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = 0;
    runFolderBackup();
  }, 1500);
}

async function runFolderBackup() {
  try {
    const handle = await loadFolderLink();
    if (!handle) return; // nothing linked — zero cost
    await gatherAndSync({
      handle,
      storage: chrome.storage.local,
      bookmarks: chrome.bookmarks,
      tabGroups: chrome.tabGroups,
      tabs: chrome.tabs
    });
  } catch {
    /* best-effort — the dashboard surfaces the pending state */
  }
}

// ---------------------------------------------------------------- messaging

async function handleMessage(msg, sender = null) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'Malformed message.' };
  }
  switch (msg.type) {
    case 'tv:openDashboard': {
      const route = typeof msg.route === 'string' && /^[a-z][a-z-]*$/.test(msg.route) ? `#/${msg.route}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/index.html${route}`), active: true });
      return { ok: true };
    }
    case 'tv:vaultWindow:open':
      return { ok: true, result: await vaultWindow.open(msg) };
    case 'tv:vault:placeholderInfo':
      return { ok: true, entry: sender && sender.tab ? await vaultWindow.placeholderInfo(sender.tab.id) : null };
    case 'tv:vault:loadTab': {
      if (sender && sender.tab) await vaultWindow.loadTab(sender.tab.id);
      return { ok: true };
    }
    case 'tv:collections:get':
      return { ok: true, collection: await collectionsApi.get(msg.id) };
    case 'tv:collections:list':
      return { ok: true, collections: await collectionsApi.list() };
    case 'tv:collections:create':
      return { ok: true, collection: await collectionsApi.create(msg) };
    case 'tv:collections:update':
      return { ok: true, collection: await collectionsApi.update(msg) };
    case 'tv:collections:delete':
      return { ok: true, result: await collectionsApi.remove(msg) };
    case 'tv:collections:addTabs':
      return { ok: true, result: await collectionsApi.addTabs(msg) };
    case 'tv:collections:removeTab':
      return { ok: true, result: await collectionsApi.removeTab(msg) };
    case 'tv:collections:updateTab':
      return { ok: true, tab: await collectionsApi.updateTab(msg) };
    case 'tv:collections:import':
      return { ok: true, result: await collectionsApi.importCollections(msg) };
    case 'tv:settings:get':
      return { ok: true, settings: await readSettings() };
    case 'tv:settings:update':
      return { ok: true, settings: await writeSettings(msg.patch || {}) };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // async response
});

// ---------------------------------------------------------------- events

chrome.tabs.onActivated.addListener((activeInfo) => {
  // Vault placeholders load their stored URL on user entry.
  vaultWindow.onTabActivated(activeInfo && activeInfo.tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  vaultWindow.onTabRemoved(tabId).catch(() => {});
});

// Folder backup: react to native changes wherever they happen (popup,
// dashboard, Chrome's own bookmark manager / group UI).
chrome.bookmarks.onCreated.addListener(scheduleFolderBackup);
chrome.bookmarks.onChanged.addListener(scheduleFolderBackup);
chrome.bookmarks.onRemoved.addListener(scheduleFolderBackup);
chrome.bookmarks.onMoved.addListener(scheduleFolderBackup);
chrome.bookmarks.onChildrenReordered.addListener(scheduleFolderBackup);
chrome.tabGroups.onCreated.addListener(scheduleFolderBackup);
chrome.tabGroups.onUpdated.addListener(scheduleFolderBackup);
chrome.tabGroups.onRemoved.addListener(scheduleFolderBackup);
// Tab-to-group membership changes do NOT fire tabGroups.* events — dragging a
// tab into a group (or dropping one out) only surfaces as a tabs event. Listen
// to those too so the folder backup captures tabs added to a group by drag.
chrome.tabs.onCreated.addListener(scheduleFolderBackup);
chrome.tabs.onRemoved.addListener(scheduleFolderBackup);
chrome.tabs.onMoved.addListener(scheduleFolderBackup);
chrome.tabs.onAttached.addListener(scheduleFolderBackup);
chrome.tabs.onDetached.addListener(scheduleFolderBackup);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // A drag into/out of a group shows up as a groupId change on the tab.
  if (changeInfo && changeInfo.groupId !== undefined) scheduleFolderBackup();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings').then((got) => {
    if (!got || !got.settings) {
      return chrome.storage.local.set({ settings: normalizeSettings(null) });
    }
  }).catch(() => {});
});

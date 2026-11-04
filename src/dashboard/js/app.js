// TabVault dashboard — app shell and hash router.

import { getSettings, updateSettings } from './store.js';
import { applyAppearance } from '../../lib/themes.js';
import { blobUrl } from '../../lib/idb.js';

import * as home from './views/home.js';
import * as collectionsView from './views/collections.js';
import * as bookmarks from './views/bookmarks.js';
import * as groups from './views/groups.js';
import * as duplicates from './views/duplicates.js';
import * as vault from './views/vault.js';
import * as saveTabs from './views/save-tabs.js';
import * as backup from './views/backup.js';
import * as appearance from './views/appearance.js';

const ROUTES = {
  home,
  collections: collectionsView,
  bookmarks,
  groups,
  duplicates,
  vault,
  'save-tabs': saveTabs,
  backup,
  appearance
};

const state = {
  settings: null,
  route: 'home',
  params: {}
};

let wallpaperObjectUrl = null;

async function applyWallpaper(settings) {
  const wp = settings.appearance.wallpaper;
  if (wallpaperObjectUrl) {
    URL.revokeObjectURL(wallpaperObjectUrl);
    wallpaperObjectUrl = null;
  }
  let resources = {};
  if (wp && wp.kind === 'image' && wp.value) {
    try {
      wallpaperObjectUrl = await blobUrl(wp.value);
      if (wallpaperObjectUrl) resources = { imageCssUrl: wallpaperObjectUrl };
    } catch {
      /* fall back to no wallpaper */
    }
  }
  applyAppearance(document, settings.appearance, resources);
}

export const ctx = {
  get settings() {
    return state.settings;
  },
  async applySettings(patch) {
    state.settings = await updateSettings(patch);
    await applyWallpaper(state.settings);
    return state.settings;
  },
  async reloadSettings() {
    state.settings = await getSettings();
    await applyWallpaper(state.settings);
    return state.settings;
  },
  navigate(route, params = {}) {
    if (!ROUTES[route]) route = 'home';
    state.route = route;
    state.params = params;
    location.hash = `#/${route}`;
    render();
  },
  refresh: () => render()
};

async function render() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const view = ROUTES[state.route] || ROUTES.home;
  try {
    await view.render(main, ctx, state.params);
  } catch (err) {
    main.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = `Something went wrong: ${err && err.message ? err.message : err}`;
    main.appendChild(div);
  }
}

function wireNav() {
  const nav = document.getElementById('nav');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-route]');
    if (!btn) return;
    ctx.navigate(btn.dataset.route);
  });
}

function syncNav() {
  for (const btn of document.querySelectorAll('#nav button')) {
    btn.classList.toggle('active', btn.dataset.route === state.route);
  }
}

function routeFromHash() {
  const m = location.hash.match(/^#\/([a-z]+)/i);
  const route = m && ROUTES[m[1]] ? m[1] : 'home';
  state.route = route;
}

async function main() {
  wireNav();
  window.addEventListener('hashchange', () => {
    routeFromHash();
    syncNav();
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      state.settings = getSettingsSafely(changes.settings.newValue);
      applyWallpaper(state.settings).then(() => {
        if (state.route === 'appearance') render();
      });
    }
    if (changes.collections && state.route !== 'appearance') render();
  });
  await ctx.reloadSettings();
  routeFromHash();
  syncNav();
  await render();
  updateSidebarStats().catch(() => {});
}

function getSettingsSafely(raw) {
  // Minimal local normalization for change events; the SW keeps the canonical
  // normalized copy in storage.
  const base = state.settings || { appearance: {}, library: {} };
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    appearance: { ...base.appearance, ...(raw.appearance || {}) },
    library: { ...base.library, ...(raw.library || {}) }
  };
}

async function updateSidebarStats() {
  const tabs = await chrome.tabs.query({});
  const loaded = tabs.filter((t) => !t.discarded).length;
  document.getElementById('sidebar-stats').textContent = `${tabs.length} tabs · ${loaded} loaded · local-first`;
}

main();

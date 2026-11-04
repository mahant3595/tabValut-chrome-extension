// TabVault — Vault Browser window.
// A dedicated, self-contained browser window. Beyond browsing what is stored
// in the vault, it has a real ADDRESS BAR: type any URL and it opens INSIDE
// this window's viewer frame. Sites are embedded inline: the extension's
// declarativeNetRequest ruleset (rules.json) strips the X-Frame-Options /
// CSP frame-ancestors headers that used to refuse framing, so sites like
// Gmail, GitHub and YouTube load in the preview. Nothing ever auto-opens a
// real tab — that only happens on an explicit button click.
//
// Nothing done here is written to browser history: the iframe viewer never
// navigates the top frame, and real-tab opens scrub their history entry.
//
// Routes (location.hash):
//   #/group/<chrome-group-id>       live Chrome tab group
//   #/collection/<collection-id>    saved TabVault collection / vault folder

import { send } from '../dashboard/js/store.js';
import { openWithoutHistory, openManyWithoutHistory } from '../lib/vault-open.js';
import { applyAppearance } from '../lib/themes.js';

const $ = (id) => document.getElementById(id);

// How long to wait for the frame to prove it loaded before showing the
// manual fallback panel (only rare JS frame-busters reach it).
const EMBED_GRACE_MS = 4000;

const state = {
  kind: null, // 'group' | 'collection'
  id: null,
  title: '',
  entries: [], // stored entries: {key,url,title,favIconUrl,discarded,tabId}
  session: [], // address-bar / browsed entries: {key,url,title,favIconUrl,tabId,refused}
  selectedIndex: -1, // index into state.entries (-1 = a session entry is shown)
  selectedSessionKey: null,
  filter: '',
  history: [], // [{kind,key,url}] for back/forward within this window
  historyIndex: -1
};

function isEmbeddable(url) {
  return /^https?:\/\//i.test(url || '');
}

function faviconNode(entry) {
  if (entry.favIconUrl) {
    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = entry.favIconUrl;
    img.alt = '';
    return img;
  }
  const span = document.createElement('span');
  span.className = 'favicon';
  return span;
}

// ---------------------------------------------------------------- address bar

/** Turn what the user typed into a URL. Bare domains get https://. */
function normalizeInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  // A single token with no spaces that looks like a domain (has a dot, no
  // scheme) → open it as https. Anything else is treated the same way; the
  // worst case is a search-less navigation error, never a crash.
  if (!/\s/.test(text)) {
    const candidate = text.replace(/^[a-z]+:\/\//i, '');
    return `https://${candidate}`;
  }
  return null; // multi-word input is not a URL; we don't guess search engines
}

/** Find an existing session entry for this URL, or create one. */
function touchSession(url) {
  const existing = state.session.find((e) => e.url === url);
  if (existing) return existing;
  let title = url;
  try {
    title = new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    /* keep full url as title */
  }
  const entry = { key: `session-${Date.now()}-${state.session.length}`, url, title, favIconUrl: '', tabId: null, refused: false };
  state.session.unshift(entry);
  return entry;
}

async function navigateTo(url, { pushHistory = true } = {}) {
  if (!url) return;
  const entry = touchSession(url);
  state.selectedIndex = -1;
  state.selectedSessionKey = entry.key;
  if (pushHistory) {
    // Truncate any forward history, then record this hop.
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({ kind: 'session', key: entry.key, url });
    state.historyIndex = state.history.length - 1;
  }
  renderList();
  updateNavButtons();
  await showEntry(entry);
}

function updateNavButtons() {
  $('vb-back').disabled = state.historyIndex <= 0;
  $('vb-fwd').disabled = state.historyIndex >= state.history.length - 1;
}

async function goHistory(delta) {
  const next = state.historyIndex + delta;
  if (next < 0 || next >= state.history.length) return;
  state.historyIndex = next;
  const hop = state.history[next];
  updateNavButtons();
  if (hop.kind === 'session') {
    const entry = state.session.find((e) => e.key === hop.key);
    if (entry) {
      state.selectedIndex = -1;
      state.selectedSessionKey = entry.key;
      renderList();
      await showEntry(entry);
    }
  } else {
    const idx = state.entries.findIndex((e) => e.key === hop.key);
    if (idx >= 0) select(idx, { pushHistory: false });
  }
}

// ---------------------------------------------------------------- list render

function renderList() {
  renderGroup('vb-session', 'vb-session-wrap', state.session, 'session');
  renderGroup('vb-list', null, state.entries, 'stored');
  const total = state.entries.length + state.session.length;
  $('vb-count').textContent = `${total} tab${total === 1 ? '' : 's'}`;
}

function renderGroup(listId, wrapId, source, kind) {
  const list = $(listId);
  list.innerHTML = '';
  const q = state.filter.trim().toLowerCase();
  const entries = source.filter(
    (e) => !q || (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q)
  );
  if (wrapId) {
    const emptySource = source.length === 0;
    $(wrapId).classList.toggle('hidden', emptySource);
    if (emptySource) return;
    $(wrapId).querySelector('.vb-group-head .muted').textContent = `${source.length}`;
  }
  if (entries.length === 0) {
    const div = document.createElement('div');
    div.className = 'vb-empty';
    div.textContent = source.length === 0 ? (kind === 'stored' ? 'Nothing stored here yet.' : '') : 'No tabs match.';
    if (div.textContent) list.appendChild(div);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement('div');
    const isSel = kind === 'session' ? entry.key === state.selectedSessionKey : state.entries.indexOf(entry) === state.selectedIndex;
    item.className = `vb-item ${isSel ? 'selected' : ''}`;
    item.appendChild(faviconNode(entry));
    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = entry.title || entry.url;
    const sub = document.createElement('div');
    sub.className = 'sub';
    try {
      sub.textContent = new URL(entry.url).hostname;
    } catch {
      sub.textContent = entry.url;
    }
    grow.append(title, sub);
    item.appendChild(grow);
    const badge = document.createElement('span');
    badge.className = 'vb-state';
    badge.textContent = entry.refused ? 'tab' : entry.discarded ? 'unloaded' : entry.tabId ? 'live' : 'saved';
    item.appendChild(badge);
    item.addEventListener('click', () => {
      if (kind === 'session') {
        state.selectedSessionKey = entry.key;
        state.selectedIndex = -1;
        renderList();
        showEntry(entry);
      } else {
        select(state.entries.indexOf(entry));
      }
    });
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------- frame view

function select(index, { pushHistory = true } = {}) {
  state.selectedIndex = index;
  state.selectedSessionKey = null;
  renderList();
  const entry = state.entries[index];
  if (!entry) return;
  if (pushHistory) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({ kind: 'stored', key: entry.key, url: entry.url });
    state.historyIndex = state.history.length - 1;
    updateNavButtons();
  }
  showEntry(entry);
}

// Sites that used to refuse framing (Gmail, GitHub, YouTube, Google…) did it
// only through the X-Frame-Options / CSP frame-ancestors response headers —
// and the declarativeNetRequest ruleset (rules.json) removes exactly those
// headers from sub_frame responses, so they load right here in the preview.
// What can still fail is rare: a site that refuses embedding via JavaScript,
// or a link that can never be embedded (chrome://, file://…). A parent page
// can't detect either case itself, so the frame gets a grace period: if it is
// still on about:blank afterwards, show the MANUAL fallback panel. Never open
// a tab automatically — the user decides.
let activeFrame = null; // { entry, settled }

/** Backstop heuristic: is this frame still a blank (never-navigated) doc? */
function frameRefused(frame) {
  try {
    const href = frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href;
    // Readable location ⇒ never left our origin ⇒ still blank / blocked.
    return typeof href !== 'string' || href === '' || href === 'about:blank' || href === 'about:srcdoc';
  } catch {
    return false; // cross-origin read refused ⇒ real content loaded
  }
}

const REFUSED_MSG = 'This site blocked the preview (it is one of the few that refuse embedding via JavaScript), so it can’t be shown inside the window.';

/** Show an entry in the viewer frame; fall back to the manual panel, never a tab. */
async function showEntry(entry) {
  $('vb-url').value = entry.url;
  const fallback = $('vb-frame-fallback');
  if (activeFrame) {
    clearTimeout(activeFrame.timer);
    clearTimeout(activeFrame.inspectTimer);
  }

  if (!isEmbeddable(entry.url)) {
    // Non-http(s) (chrome://, file://, …) can never be embedded in a frame at
    // all. Show the manual panel — the user may open it in a tab explicitly.
    showFallbackPanel(entry, 'This kind of link can’t be embedded in the window at all (browser page or local file).');
    return;
  }

  fallback.classList.add('hidden');
  $('vb-loading').classList.remove('hidden');
  const frame = $('vb-frame');
  const af = { entry, settled: false, timer: 0, inspectTimer: 0 };
  activeFrame = af;

  const settle = (loaded) => {
    if (af.settled) return;
    af.settled = true;
    clearTimeout(af.timer);
    clearTimeout(af.inspectTimer);
    $('vb-loading').classList.add('hidden');
    if (!loaded) showFallbackPanel(entry, REFUSED_MSG);
  };

  frame.removeEventListener('load', frame._vbLoad || (() => {}));
  const onLoad = () => {
    // Give a redirect a beat, then inspect whether the frame is still blank.
    clearTimeout(af.inspectTimer);
    af.inspectTimer = setTimeout(() => settle(!frameRefused(frame)), 250);
  };
  frame._vbLoad = onLoad;
  frame.addEventListener('load', onLoad);
  frame.src = entry.url;

  // Backstop timer: if the frame never confirms a load and is still blank.
  af.timer = setTimeout(() => {
    if (!af.settled && frameRefused(frame)) settle(false);
  }, EMBED_GRACE_MS);
}

/** Open the entry in a real history-free tab and surface it in the Session. */
async function openInRealTab(entry, message) {
  if (entry.tabId) {
    // Already open — just focus it.
    try {
      await chrome.tabs.update(entry.tabId, { active: true });
    } catch {
      entry.tabId = null;
    }
    showFallbackPanel(entry, message);
    return;
  }
  try {
    const tab = await openWithoutHistory(entry.url, { active: true });
    entry.tabId = tab.id;
    entry.refused = true;
    if (!state.session.includes(entry)) state.session.unshift(entry);
    renderList();
    showFallbackPanel(entry, message);
  } catch (err) {
    $('vb-hint').textContent = String(err.message || err);
  }
}

function showFallbackPanel(entry, message) {
  $('vb-loading').classList.add('hidden');
  $('vb-frame').src = 'about:blank';
  $('vb-fallback-msg').textContent = message || 'This site can’t be shown inside the window.';
  $('vb-fallback-focus').classList.toggle('hidden', !entry.tabId);
  $('vb-frame-fallback').classList.remove('hidden');
  $('vb-hint').textContent = entry.tabId
    ? `${entry.url} is open in a real tab (no history written) and listed in this window’s Session. ` +
      'Everything stays under this browser — click “Focus its tab” to jump to it.'
    : 'Nothing was opened on its own — this window previews only. Use the button above if you want this site in a real history-free tab.';
}

// ---------------------------------------------------------------- stored data

async function loadEntries() {
  if (state.kind === 'group') {
    const groupId = Number(state.id);
    const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({ groupId })]);
    const group = groups.find((g) => g.id === groupId);
    state.title = group ? `Group: ${group.title || 'Untitled group'}` : 'Tab group';
    state.entries = tabs.map((t) => ({
      key: `tab-${t.id}`,
      url: t.url || '',
      title: t.title || '',
      favIconUrl: t.favIconUrl || '',
      discarded: Boolean(t.discarded),
      tabId: t.id
    }));
  } else if (state.id) {
    const res = await send({ type: 'tv:collections:get', id: state.id });
    const collection = res.collection;
    if (!collection) {
      state.title = 'Collection not found';
      state.entries = [];
    } else {
      state.title = `${collection.vaultFolder ? 'Vault folder' : 'Collection'}: ${collection.name}`;
      state.entries = collection.tabs.map((t) => ({
        key: `saved-${t.id}`,
        url: t.url,
        title: t.title,
        favIconUrl: t.favIconUrl || '',
        discarded: false,
        tabId: null
      }));
    }
  } else {
    // No route: a plain browser window with an address bar and saved tabs.
    state.title = 'Vault Browser';
    const res = await send({ type: 'tv:collections:list' });
    const list = (res && res.collections) || [];
    state.entries = list.flatMap((c) =>
      c.tabs.map((t) => ({
        key: `saved-${t.id}`,
        url: t.url,
        title: t.title,
        favIconUrl: t.favIconUrl || '',
        discarded: false,
        tabId: null
      }))
    );
  }
  document.title = `Vault — ${state.title}`;
  $('vb-title').textContent = state.title;
  $('vb-stored-head').textContent = state.kind ? 'Stored' : 'All saved tabs';
  renderList();
}

async function openCurrent() {
  const entry = state.selectedIndex >= 0 ? state.entries[state.selectedIndex] : state.session.find((e) => e.key === state.selectedSessionKey);
  if (!entry) return;
  await openInRealTab(entry, 'Opened in a real tab (no history written).');
}

async function openAll() {
  const urls = state.entries.map((e) => e.url).filter(isEmbeddable);
  if (urls.length === 0) return;
  const opened = await openManyWithoutHistory(urls);
  $('vb-hint').textContent = `Opened ${opened} tabs — none of them were written to browser history.`;
}

async function openAsVaultWindow() {
  const source = state.selectedIndex >= 0 ? state.entries : state.session;
  const urls = source
    .filter((e) => isEmbeddable(e.url))
    .map((e) => ({ url: e.url, title: e.title, favIconUrl: e.favIconUrl }));
  if (urls.length === 0) return;
  try {
    const res = await send({
      type: 'tv:vaultWindow:open',
      name: state.title.replace(/^[^:]+:\s*/, ''),
      urls
    });
    $('vb-hint').textContent =
      `Vault window opened: the first tab loaded, ${res.result.lazy} tab(s) stay unloaded and load only when you click them. No tab group is created.`;
  } catch (err) {
    $('vb-hint').textContent = String(err.message || err);
  }
}

function parseRoute() {
  const m = (location.hash || '').match(/^#\/(group|collection)\/(.+)$/);
  if (m) {
    state.kind = m[1];
    state.id = m[2];
  } else {
    state.kind = null;
    state.id = null;
  }
}

async function main() {
  // Apply the shared dashboard theme so this window matches the rest of the
  // extension (falls back to the built-in dark-neon palette on any error).
  try {
    const res = await send({ type: 'tv:settings:get' });
    if (res && res.ok && res.settings && res.settings.appearance) {
      applyAppearance(document, res.settings.appearance);
    }
  } catch {
    /* defaults are fine */
  }

  parseRoute();
  $('vb-search').addEventListener('input', () => {
    state.filter = $('vb-search').value;
    renderList();
  });
  $('vb-open').addEventListener('click', openCurrent);
  $('vb-lazy').addEventListener('click', openAsVaultWindow);
  $('vb-fallback-open').addEventListener('click', openCurrent);
  $('vb-fallback-focus').addEventListener('click', () => {
    const entry = state.session.find((e) => e.key === state.selectedSessionKey) || state.session.find((e) => e.tabId);
    if (entry && entry.tabId) chrome.tabs.update(entry.tabId, { active: true });
  });
  $('vb-open-all').addEventListener('click', openAll);

  // Address bar: Enter or Go opens the typed URL inside this window.
  const submitAddress = () => {
    const url = normalizeInput($('vb-url').value);
    if (!url) {
      $('vb-hint').textContent = 'Enter a web address (for example example.com) to open it in this window.';
      return;
    }
    navigateTo(url);
  };
  $('vb-go').addEventListener('click', submitAddress);
  $('vb-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddress();
  });
  $('vb-back').addEventListener('click', () => goHistory(-1));
  $('vb-fwd').addEventListener('click', () => goHistory(1));
  $('vb-reload').addEventListener('click', () => {
    const entry = state.selectedIndex >= 0 ? state.entries[state.selectedIndex] : state.session.find((e) => e.key === state.selectedSessionKey);
    if (entry && isEmbeddable(entry.url)) {
      $('vb-frame').src = 'about:blank';
      requestAnimationFrame(() => showEntry(entry));
    }
  });

  await loadEntries();
  if (state.entries.length > 0) select(0, { pushHistory: true });

  // Live group tracking: keep the list in sync as tabs open/close.
  if (state.kind === 'group') {
    const groupId = Number(state.id);
    const refreshSoon = () => {
      clearTimeout(refreshSoon._t);
      refreshSoon._t = setTimeout(() => loadEntries(), 250);
    };
    chrome.tabs.onRemoved.addListener(refreshSoon);
    chrome.tabs.onCreated.addListener(refreshSoon);
    chrome.tabs.onUpdated.addListener((_tabId, info) => {
      if (info && (info.title || info.discarded !== undefined || info.status === 'complete')) refreshSoon();
    });
  }
}

main();

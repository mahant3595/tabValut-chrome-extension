// TabVault — lazy vault window core.
//
// Opening a collection/group in the vault creates a REAL Chrome window whose
// tabs are lazy: the FIRST tab loads immediately, every other tab is created
// UNLOADED as a local placeholder page (real title/URL/favicon, zero network).
// When the user activates a placeholder, the service worker navigates it to its
// stored URL ("load on user enter"). TabVault never discards, sweeps or
// unloads anything on its own — unloading is left to Chrome or to whatever
// unloader extension the user runs.
//
// INVARIANT: nothing in this module ever calls tabs.remove.
//
// Every chrome.* surface is injected, so the whole flow can be simulated in
// tools/simulate.mjs without a browser.

export const PLACEHOLDER_PAGE = 'src/vault-browser/placeholder.html';
const VAULT_TABS_KEY = 'vaultSessionTabs'; // storage.session: tabId -> {url,title,favIconUrl}

/** Local, zero-network page shown inside an unloaded vault tab. */
export function buildPlaceholderUrl(getURL, entry) {
  const u = new URL(getURL(PLACEHOLDER_PAGE));
  u.searchParams.set('url', entry.url);
  if (entry.title) u.searchParams.set('title', String(entry.title).slice(0, 200));
  if (entry.favIconUrl) u.searchParams.set('favicon', String(entry.favIconUrl).slice(0, 1500));
  return u.href;
}

export function createVaultWindow({ tabs, windows, storage, getURL }) {
  async function loadSessionTabs() {
    try {
      const got = await storage.get(VAULT_TABS_KEY);
      const raw = got ? got[VAULT_TABS_KEY] : null;
      return raw && typeof raw === 'object' ? { ...raw } : {};
    } catch {
      return {};
    }
  }

  async function saveSessionTabs(map) {
    try {
      await storage.set({ [VAULT_TABS_KEY]: map });
    } catch {
      /* best-effort */
    }
  }

  function placeholderUrl(entry) {
    return buildPlaceholderUrl(getURL, entry);
  }

  /** User entered a tab: a placeholder (or a discarded copy of one) loads its stored URL now. */
  async function onTabActivated(tabId) {
    if (!Number.isInteger(tabId)) return;
    const map = await loadSessionTabs();
    const entry = map[tabId];
    const url = typeof entry === 'string' ? entry : entry && entry.url;
    if (!url) return;
    let tab = null;
    try {
      tab = await tabs.get(tabId);
    } catch {
      delete map[tabId];
      await saveSessionTabs(map);
      return;
    }
    // A placeholder page (or a discarded tab) means: not loaded yet → load the
    // real site now. Anything else is already loaded (or the user navigated
    // somewhere deliberately — never fight that).
    const isPlaceholder = typeof tab.url === 'string' && tab.url.includes(PLACEHOLDER_PAGE);
    const hasRealUrl = Boolean(tab.url) && tab.url !== 'about:blank' && !isPlaceholder;
    if (!isPlaceholder && !tab.discarded && hasRealUrl) return;
    try {
      await tabs.update(tabId, { url });
    } catch {
      /* best-effort */
    }
  }

  /** Tab closed: forget its stored URL. */
  async function onTabRemoved(tabId) {
    const map = await loadSessionTabs();
    if (!map[tabId]) return;
    delete map[tabId];
    await saveSessionTabs(map);
  }

  /** A placeholder page asks what it is really about (title/URL/favicon). */
  async function placeholderInfo(tabId) {
    const map = await loadSessionTabs();
    const entry = map[tabId];
    return entry || null;
  }

  /** A placeholder's "Load" button (or the user entering the tab) asks for the real site. */
  async function loadTab(tabId) {
    const map = await loadSessionTabs();
    const entry = map[tabId];
    const target = typeof entry === 'string' ? entry : entry && entry.url;
    if (!target) return false;
    try {
      await tabs.update(tabId, { url: target });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open {name, urls} as a lazy vault window. Returns {windowId, groupId: null, created, lazy}.
   *
   * This NEVER creates a Chrome tab group. Chrome persistently SAVES any tab
   * group it creates ("saved groups", synced to the Google account) and no
   * extension API can detect, prevent or undo that — so a restored window
   * leaves nothing Chrome could persist. Group management stays an explicit,
   * user-initiated action (popup "Group", the Tab Groups dashboard), never a
   * side effect of opening saved tabs.
   */
  async function open({ name, urls } = {}) {
    const clean = (Array.isArray(urls) ? urls : [])
      .map((u) => (typeof u === 'string' ? { url: u } : u))
      .filter((e) => e && /^https?:\/\//i.test(String(e.url || '')));
    if (clean.length === 0) throw new Error('No http(s) tabs to open.');
    const win = await windows.create({ url: clean[0].url, focused: true });
    const map = await loadSessionTabs();
    const restIds = [];
    for (const entry of clean.slice(1)) {
      // Lazy tab: a local placeholder page carrying the real title/URL/
      // favicon. It performs zero network activity — the site loads only
      // when the user enters the tab (onTabActivated navigates it).
      // eslint-disable-next-line no-await-in-loop -- order-preserving creation
      const t = await tabs.create({
        windowId: win ? win.id : undefined,
        active: false,
        url: placeholderUrl(entry)
      });
      restIds.push(t.id);
      map[t.id] = {
        url: entry.url,
        title: String(entry.title || '').slice(0, 500),
        favIconUrl: String(entry.favIconUrl || '').slice(0, 2000)
      };
    }
    await saveSessionTabs(map);
    // No Chrome tab group is ever created here — see the doc comment above.
    return { windowId: win ? win.id : null, groupId: null, created: 1 + restIds.length, lazy: restIds.length };
  }

  return { open, onTabActivated, onTabRemoved, placeholderInfo, loadTab, placeholderUrl, loadSessionTabs };
}

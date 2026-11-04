// TabVault — simulation harness.
// Runs the REAL lazy vault window core (src/background/vault-window-core.js)
// against a mocked chrome.* environment, covering:
//   1. lazy open: first tab loads, every other tab is an unloaded placeholder
//   2. zero network before user entry (no real URL is ever navigated to)
//   3. activation loads a placeholder's stored URL
//   4. already-loaded tabs are never re-navigated
//   5. placeholder info (title/url/favicon round-trip)
//   6. explicit loadTab navigation
//   7. closed-tab cleanup of the session map
//   8. grouping, validation and single-tab edge cases
//   9. the extension never closes or discards tabs
//
// Usage: node tools/simulate.mjs   (exit 0 = all scenarios pass)

import { createVaultWindow, PLACEHOLDER_PAGE, buildPlaceholderUrl } from '../src/background/vault-window-core.js';
import { buildFiles, writeFiles, gatherAndSync, BACKUP_FILES } from '../src/lib/folder-sync.js';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${!cond && detail ? ` — ${detail}` : ''}`);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------- mock chrome

function createMockChrome(initialTabs = []) {
  const events = []; // every network-visible action, in order
  const tabs = new Map();
  let nextTabId = 1;
  let nextWindowId = 1;
  let nextGroupId = 1;

  for (const spec of initialTabs) {
    const id = spec.id ?? nextTabId++;
    nextTabId = Math.max(nextTabId, id + 1);
    tabs.set(id, {
      id,
      windowId: spec.windowId ?? 1,
      index: spec.index ?? tabs.size,
      url: spec.url ?? `https://site.example/page${id}`,
      title: spec.title ?? `Tab ${id}`,
      groupId: spec.groupId ?? -1,
      discarded: Boolean(spec.discarded),
      active: Boolean(spec.active),
      pinned: Boolean(spec.pinned),
      audible: Boolean(spec.audible)
    });
  }

  const groups = new Map();
  const session = {}; // storage.session backing store

  const chromeLike = {
    events,
    tabs: {
      async query(q = {}) {
        let list = [...tabs.values()];
        if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
        if (q.groupId !== undefined) list = list.filter((t) => t.groupId === q.groupId);
        if (q.active !== undefined) list = list.filter((t) => t.active === q.active);
        return clone(list);
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return clone(t);
      },
      async create(props = {}) {
        const id = nextTabId++;
        const tab = {
          id,
          windowId: props.windowId ?? 1,
          index: tabs.size,
          url: props.url ?? 'about:blank',
          title: `Tab ${id}`,
          groupId: -1,
          discarded: false,
          active: Boolean(props.active),
          pinned: false,
          audible: false
        };
        tabs.set(id, tab);
        events.push(`create:${id}:${tab.url}`);
        return clone(tab);
      },
      async update(id, props = {}) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        if (props.url !== undefined) {
          tab.url = props.url;
          events.push(`navigate:${id}:${props.url}`);
        }
        if (props.active !== undefined) tab.active = Boolean(props.active);
        return clone(tab);
      },
      async group({ tabIds = [] } = {}) {
        const id = nextGroupId++;
        groups.set(id, { id, title: '', collapsed: true, tabIds: [...tabIds] });
        for (const tId of tabIds) {
          const t = tabs.get(tId);
          if (!t) throw new Error(`No tab with id: ${tId}`);
          t.groupId = id;
        }
        events.push(`group:${id}:${tabIds.join(',')}`);
        return id;
      },
      // Deliberately absent: remove/discard. If the core ever calls them the
      // simulation crashes with "not a function".
      remove: undefined,
      discard: undefined
    },
    windows: {
      async create(props = {}) {
        const id = nextWindowId++;
        const created = [];
        const urls = Array.isArray(props.url) ? props.url : [props.url ?? 'about:blank'];
        for (const url of urls) {
          const tabId = nextTabId++;
          const tab = {
            id: tabId,
            windowId: id,
            index: created.length,
            url,
            title: `Tab ${tabId}`,
            groupId: -1,
            discarded: false,
            active: created.length === 0,
            pinned: false,
            audible: false
          };
          tabs.set(tabId, tab);
          created.push(tab);
          events.push(`create:${tabId}:${url}`);
        }
        return { id, tabs: created.map(clone) };
      }
    },
    tabGroups: {
      async update(id, props = {}) {
        const g = groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}`);
        Object.assign(g, props);
        return clone(g);
      },
      get: async (id) => clone(groups.get(id))
    },
    storage: {
      session: {
        async get(key) {
          return { [key]: clone(session[key]) };
        },
        async set(obj) {
          Object.assign(session, clone(obj));
        }
      }
    },
    runtime: {
      getURL: (path) => `chrome-extension://tabvault/${path}`
    },
    _session: session,
    _groups: groups,
    _tabs: tabs
  };

  return chromeLike;
}

function makeVault(mock) {
  return createVaultWindow({
    tabs: mock.tabs,
    windows: mock.windows,
    tabGroups: mock.tabGroups,
    storage: mock.storage.session,
    getURL: mock.runtime.getURL
  });
}

function isPlaceholderUrl(url) {
  return typeof url === 'string' && url.includes(PLACEHOLDER_PAGE);
}

// ---------------------------------------------------------------- scenarios

async function scenarioLazyOpen() {
  console.log('\n— scenario: lazy open (first tab loads, the rest are placeholders) —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  const res = await vault.open({
    name: 'Research',
    urls: [
      { url: 'https://a.example/one', title: 'One', favIconUrl: 'https://a.example/one.ico' },
      { url: 'https://b.example/two', title: 'Two', favIconUrl: '' },
      { url: 'https://c.example/three', title: 'Three', favIconUrl: '' }
    ]
  });

  check('window created', Number.isInteger(res.windowId));
  check('three tabs created', res.created === 3, `created=${res.created}`);
  check('two tabs are lazy', res.lazy === 2, `lazy=${res.lazy}`);
  const all = [...mock._groups.values()];
  const list = await mock.tabs.query({});
  const first = list.find((t) => t.id === list[0].id);
  check('first tab has the real URL', first.url === 'https://a.example/one', first.url);
  const lazyTabs = list.filter((t) => isPlaceholderUrl(t.url));
  check('lazy tabs point at the local placeholder page', lazyTabs.length === 2);
  check(
    'lazy tabs never navigate to the real URL before entry',
    lazyTabs.every((t) => !/^https?:\/\/[abc]\.example/.test(t.url))
  );
  // No Chrome tab group by default: Chrome natively saves groups (synced to
  // the Google account) and no extension API can undo that, so the default
  // open must create nothing Chrome could persist.
  check('default open creates NO tab group', res.groupId === null, `groupId=${res.groupId}`);
  check('no group was ever registered in the mock', all.length === 0);
  check('no group event was emitted', mock.events.filter((e) => e.startsWith('group:')).length === 0);
  check('every tab stays ungrouped', (await mock.tabs.query({})).every((t) => !(t.groupId > 0)));
}

async function scenarioNeverCreatesTabGroup() {
  console.log('\n— scenario: opening saved tabs NEVER creates a Chrome tab group —');
  // Chrome persistently SAVES any tab group it creates ("saved groups", synced
  // to the Google account) and no extension API can undo that. So the vault
  // window must create no group at all — even for an untrusted message that
  // passes group:true, which is now ignored entirely.
  const mock = createMockChrome();
  const vault = makeVault(mock);

  const res = await vault.open({
    name: 'Research',
    group: true, // must be ignored — no flow may create a group
    urls: [
      { url: 'https://a.example/one', title: 'One' },
      { url: 'https://b.example/two', title: 'Two' }
    ]
  });
  check('group:true is ignored — groupId is always null', res.groupId === null, `groupId=${res.groupId}`);
  check('no group registered in the mock', mock._groups.size === 0);
  check('no group event emitted', mock.events.filter((e) => e.startsWith('group:')).length === 0);
  check('every tab stays ungrouped', (await mock.tabs.query({})).every((t) => !(t.groupId > 0)));
  check('tabs still opened correctly', res.created === 2 && res.lazy === 1);

  // A truthy-string group value must also never create a group.
  const mock2 = createMockChrome();
  const res2 = await makeVault(mock2).open({
    name: 'X',
    group: 'true',
    urls: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }]
  });
  check('group="true" (string) does not create a group', res2.groupId === null && mock2._groups.size === 0);
}

async function scenarioZeroNetworkBeforeEntry() {
  console.log('\n— scenario: zero network before the user enters a tab —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  await vault.open({
    name: 'Quiet',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      { url: 'https://second.example/', title: 'Second' },
      { url: 'https://third.example/', title: 'Third' }
    ]
  });

  // Everything that happened so far: creating the first tab (a real load) and
  // two placeholder tabs. No lazy tab may have been navigated anywhere.
  const navigations = mock.events.filter((e) => e.startsWith('navigate:'));
  check('only the first tab ever navigated', navigations.length === 0, navigations.join(' | '));

  const placeholderEvents = mock.events.filter((e) => e.startsWith('create:') && e.includes(PLACEHOLDER_PAGE));
  check('two placeholder tabs created (local page)', placeholderEvents.length === 2);
  const realCreates = mock.events.filter(
    (e) => e.startsWith('create:') && /^create:\d+:https?:\/\//.test(e)
  );
  check('only one real web create event', realCreates.length === 1, realCreates.join(' | '));
}

async function scenarioActivationLoads() {
  console.log('\n— scenario: entering a placeholder loads its stored URL —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  const res = await vault.open({
    name: 'LoadOnEnter',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      { url: 'https://second.example/', title: 'Second' },
      { url: 'https://third.example/', title: 'Third' }
    ]
  });
  const list = await mock.tabs.query({});
  const lazyTab = list[list.length - 1];

  await vault.onTabActivated(lazyTab.id);
  const after = await mock.tabs.get(lazyTab.id);
  check('activating a placeholder navigates to its real URL', after.url === 'https://third.example/', after.url);
  check('the activation produced exactly one navigation', mock.events.filter((e) => e.startsWith('navigate:')).length === 1);

  // Re-entering the now-loaded tab must not reload/fight it.
  mock.events.length = 0;
  await vault.onTabActivated(lazyTab.id);
  check('a loaded tab is never re-navigated on activation', mock.events.filter((e) => e.startsWith('navigate:')).length === 0);

  // The user navigated somewhere else deliberately — never fight that.
  await mock.tabs.update(lazyTab.id, { url: 'https://elsewhere.example/' });
  mock.events.length = 0;
  await vault.onTabActivated(lazyTab.id);
  check('a deliberate navigation is never overwritten', (await mock.tabs.get(lazyTab.id)).url === 'https://elsewhere.example/');

  check('open returned the lazy count', res.lazy === 2);
}

async function scenarioDiscardedPlaceholderReloads() {
  console.log('\n— scenario: a discarded (unloaded by Chrome/another ext) vault tab reloads on entry —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  await vault.open({
    name: 'Discardable',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      { url: 'https://second.example/', title: 'Second' }
    ]
  });
  const list = await mock.tabs.query({});
  const lazyTab = list[list.length - 1];

  // Load it once for real, then simulate a discard by Chrome's memory saver
  // (or the user's own unloader extension): the URL is kept, the flag is set.
  await vault.onTabActivated(lazyTab.id);
  mock._tabs.get(lazyTab.id).discarded = true;

  mock.events.length = 0;
  await vault.onTabActivated(lazyTab.id);
  check('re-entering a discarded vault tab reloads it', mock.events.filter((e) => e.startsWith('navigate:')).length === 1);
}

async function scenarioPlaceholderInfo() {
  console.log('\n— scenario: placeholder info round-trip —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  await vault.open({
    name: 'Info',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      {
        url: 'https://second.example/deep?x=1',
        title: 'Second — a title longer than two hundred characters would be truncated by the core so the URL stays a reasonable size',
        favIconUrl: 'data:image/png;base64,AAAA'
      }
    ]
  });
  const list = await mock.tabs.query({});
  const lazyTab = list[list.length - 1];

  const info = await vault.placeholderInfo(lazyTab.id);
  check('placeholder knows its real URL', info && info.url === 'https://second.example/deep?x=1');
  check('placeholder carries its stored title', info && info.title.startsWith('Second — a title'));
  check('placeholder carries its stored favicon', info && info.favIconUrl === 'data:image/png;base64,AAAA');

  const unknown = await vault.placeholderInfo(9999);
  check('unknown tabs report no entry', unknown === null);

  const url = vault.placeholderUrl(info);
  check('placeholder URL is extension-local', url.startsWith('chrome-extension://tabvault/' + PLACEHOLDER_PAGE));
  const parsed = new URL(url);
  check('placeholder URL carries the target in a query param', parsed.searchParams.get('url') === 'https://second.example/deep?x=1');
  check('placeholder URL preserves the query string intact', parsed.searchParams.get('url').includes('?x=1'));
}

async function scenarioExplicitLoadTab() {
  console.log('\n— scenario: the placeholder “Load” button navigates via the core —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  await vault.open({
    name: 'LoadButton',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      { url: 'https://second.example/', title: 'Second' }
    ]
  });
  const list = await mock.tabs.query({});
  const lazyTab = list[list.length - 1];

  const ok = await vault.loadTab(lazyTab.id);
  check('loadTab reports success', ok === true);
  check('loadTab navigated to the stored URL', (await mock.tabs.get(lazyTab.id)).url === 'https://second.example/');
  check('loadTab on an unknown tab fails cleanly', (await vault.loadTab(9999)) === false);
}

async function scenarioRemovedTabCleanup() {
  console.log('\n— scenario: closing a lazy tab forgets its stored URL —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  await vault.open({
    name: 'Cleanup',
    urls: [
      { url: 'https://first.example/', title: 'First' },
      { url: 'https://second.example/', title: 'Second' },
      { url: 'https://third.example/', title: 'Third' }
    ]
  });
  const list = await mock.tabs.query({});
  const lazyTab = list[list.length - 1];

  await vault.onTabRemoved(lazyTab.id);
  const map = await vault.loadSessionTabs();
  check('closed tab removed from the session map', map[lazyTab.id] === undefined);
  check('other lazy tabs still tracked', Object.keys(map).length === 1);
  mock.events.length = 0;
  await vault.onTabActivated(lazyTab.id);
  check('activation of a forgotten tab is a no-op', mock.events.filter((e) => e.startsWith('navigate:')).length === 0);
}

async function scenarioValidationAndEdges() {
  console.log('\n— scenario: validation & edge cases —');
  const mock = createMockChrome();
  const vault = makeVault(mock);

  let threw = false;
  try {
    await vault.open({ name: 'Empty', urls: [] });
  } catch {
    threw = true;
  }
  check('opening nothing throws a clear error', threw);

  threw = false;
  try {
    await vault.open({ name: 'Bad', urls: ['javascript:alert(1)', 'chrome://settings/', 'ftp://x.example/'] });
  } catch {
    threw = true;
  }
  check('non-http(s) URLs are rejected', threw);

  const single = await vault.open({ name: 'Single', urls: [{ url: 'https://solo.example/', title: 'Solo' }] });
  check('single tab: one created, zero lazy', single.created === 1 && single.lazy === 0);
  check('single tab: no group is created', single.groupId === null);

  const mixed = await vault.open({
    name: 'Mixed',
    urls: ['https://ok.example/', 42, null, { url: 'https://also.example/' }]
  });
  check('garbage entries are dropped, valid ones kept', mixed.created === 2 && mixed.lazy === 1);

  // buildPlaceholderUrl is the pure helper — truncation guarantees.
  const long = buildPlaceholderUrl(mock.runtime.getURL, {
    url: 'https://t.example/',
    title: 'x'.repeat(500),
    favIconUrl: 'y'.repeat(5000)
  });
  const p = new URL(long);
  check('title is truncated for the placeholder URL', p.searchParams.get('title').length === 200);
  check('favicon is truncated for the placeholder URL', p.searchParams.get('favicon').length === 1500);
}

async function scenarioNeverClosesOrDiscards() {
  console.log('\n— scenario: the extension never closes or discards tabs —');
  const mock = createMockChrome([{ id: 1, url: 'https://existing.example/' }]);
  const vault = makeVault(mock);

  await vault.open({
    name: 'Gentle',
    urls: [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ]
  });
  await vault.onTabActivated(2);
  await vault.onTabRemoved(999); // unknown id must not throw

  const list = await mock.tabs.query({});
  check('pre-existing tabs survive every operation', list.some((t) => t.id === 1));
  check('no remove/discard calls exist in the mock API', mock.tabs.remove === undefined && mock.tabs.discard === undefined);
  check('every created tab still exists', list.length === 3, `tabs=${list.length}`);
}

// --------------------------------------------------------- folder backup

function makeFakeDir(name = 'Backups') {
  const files = new Map();
  return {
    name,
    files,
    permission: 'granted',
    async queryPermission() {
      return this.permission;
    },
    async getFileHandle(fname, opts = {}) {
      if (!files.has(fname) && !(opts && opts.create)) throw new Error(`NotFound: ${fname}`);
      return {
        async getFile() {
          const text = files.get(fname);
          return { text: async () => text };
        },
        async createWritable() {
          let buf = '';
          return {
            async write(chunk) {
              buf += String(chunk);
            },
            async close() {
              files.set(fname, buf);
            }
          };
        }
      };
    },
    async removeEntry(fname) {
      if (!files.has(fname)) throw new Error(`NotFound: ${fname}`);
      files.delete(fname);
    }
  };
}

function makeFakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === 'string') return key in data ? { [key]: data[key] } : {};
      const out = {};
      for (const k of key) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) {
      Object.assign(data, obj);
    }
  };
}

async function scenarioFolderBackup() {
  console.log('\n— scenario: linked-folder backup mirrors data as plain files —');
  const collections = [
    { id: 'c1', name: 'Saved', description: '', tags: [], logo: null, wallpaper: null, createdAt: 1, updatedAt: 1,
      tabs: [{ id: 't1', url: 'https://x.example/', title: 'X', favIconUrl: '', domain: 'x.example', notes: '', tags: [], addedAt: 1 }] }
  ];
  const storage = makeFakeStorage({ collections });
  const deps = {
    storage,
    bookmarks: { getTree: async () => [{ id: '0', children: [{ id: '1', title: 'Bar', children: [{ id: '2', title: 'Doc', url: 'https://doc.example/' }] }] }] },
    tabGroups: { query: async () => [{ id: 3, title: 'Trip', color: 'blue', collapsed: false, windowId: 1 }] },
    tabs: { query: async () => [{ groupId: 3, url: 'https://in-group.example/', title: 'IG' }] }
  };

  // Unlinked: fails cleanly, writes nothing.
  let res = await gatherAndSync({ handle: null, ...deps });
  check('unlinked folder: clean failure', res.ok === false && /No folder is linked/.test(res.error || ''));

  // Linked + granted: default (readable) format writes four human-readable files.
  const dir = makeFakeDir('VaultBackup');
  dir.files.set('my-own-file.txt', 'hands off');
  res = await gatherAndSync({ handle: dir, ...deps, now: 1700000000000 });
  check('linked folder: default format writes four files', res.ok === true && res.written.length === 4, res.error || '');
  check('default format is readable Markdown, not JSON',
    res.format === 'readable' && dir.files.has(BACKUP_FILES.libraryMd) && !dir.files.has(BACKUP_FILES.library));
  const md = dir.files.get(BACKUP_FILES.libraryMd) || '';
  check('Markdown library has real content',
    md.startsWith('# TabVault library') && md.includes('## Saved') && md.includes('[X](https://x.example/)'));
  const gmd = dir.files.get(BACKUP_FILES.groupsMd) || '';
  check('Markdown groups mirror the live group',
    gmd.includes('## Trip — blue') && gmd.includes('[IG](https://in-group.example/)'));
  const html = dir.files.get(BACKUP_FILES.bookmarks) || '';
  check('HTML backup contains collections, groups and bookmarks',
    html.includes('TabVault collections') && html.includes('Trip') && html.includes('https://doc.example/') && html.includes('https://in-group.example/'));
  check('status recorded with format, pending cleared',
    storage.data.folderBackup && storage.data.folderBackup.folderName === 'VaultBackup' &&
    storage.data.folderBackup.format === 'readable' && storage.data.backupPending === false);

  // Re-sync is a no-op on disk: identical content is skipped, nothing grows.
  const resync = await gatherAndSync({ handle: dir, ...deps, now: 1700000001000 });
  check('re-sync skips unchanged files, folder does not grow',
    resync.skipped === 4 && dir.files.size === 5 && dir.files.get('my-own-file.txt') === 'hands off');

  // Switching to JSON rewrites the folder and prunes the old Markdown files
  // — but only TabVault's own files, never anything else in the folder.
  res = await gatherAndSync({ handle: dir, ...deps, format: 'json', now: 1700000002000 });
  check('switch to JSON: six → four files, Markdown pruned',
    res.ok === true && res.format === 'json' && !dir.files.has(BACKUP_FILES.libraryMd) && !dir.files.has(BACKUP_FILES.groupsMd));
  const gdoc = JSON.parse(dir.files.get(BACKUP_FILES.groups) || '{}');
  check('groups JSON mirrors the live group', gdoc.groups && gdoc.groups.length === 1 && gdoc.groups[0].title === 'Trip');
  check('switching format never touches other files', dir.files.get('my-own-file.txt') === 'hands off');

  // Permission lost → flagged for the dashboard, nothing written.
  const locked = makeFakeDir('Locked');
  locked.permission = 'prompt';
  res = await gatherAndSync({ handle: locked, ...deps });
  check('permission prompt: reported, pending flagged, zero files',
    res.needsPermission === true && storage.data.backupPending === true && locked.files.size === 0);

  // Build-level guarantee: each format writes exactly its documented set.
  const readable = buildFiles({ collections }).map((f) => f.name);
  const json = buildFiles({ collections, format: 'json' }).map((f) => f.name);
  const both = buildFiles({ collections, format: 'both' }).map((f) => f.name);
  check('readable format filenames match the documented set',
    readable.join(',') === [BACKUP_FILES.libraryMd, BACKUP_FILES.groupsMd, BACKUP_FILES.bookmarks, BACKUP_FILES.readme].join(','));
  check('json format filenames match the documented set',
    json.join(',') === [BACKUP_FILES.library, BACKUP_FILES.groups, BACKUP_FILES.bookmarks, BACKUP_FILES.readme].join(','));
  check('both format writes every documented file exactly once',
    both.length === 6 && new Set(both).size === 6 &&
    [...readable, ...json].every((n) => both.includes(n)));

  // writeFiles without a real handle throws a clear error.
  let threw = false;
  try {
    await writeFiles({}, []);
  } catch (e) {
    threw = /No folder is linked/.test(e.message);
  }
  check('writeFiles rejects an invalid handle', threw);
}

async function main() {
  const started = Date.now();
  await scenarioLazyOpen();
  await scenarioNeverCreatesTabGroup();
  await scenarioZeroNetworkBeforeEntry();
  await scenarioActivationLoads();
  await scenarioDiscardedPlaceholderReloads();
  await scenarioPlaceholderInfo();
  await scenarioExplicitLoadTab();
  await scenarioRemovedTabCleanup();
  await scenarioValidationAndEdges();
  await scenarioNeverClosesOrDiscards();
  await scenarioFolderBackup();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Date.now() - started}ms.`);
  if (failed.length > 0) {
    console.error('Failed checks:');
    for (const f of failed) console.error(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});

// Unit tests for the linked-folder backup module (src/lib/folder-sync.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_FILES,
  FORMAT_KEY,
  DEFAULT_FORMAT,
  normalizeFormat,
  formatFileNames,
  buildFiles,
  buildBookmarksHtml,
  buildGroupsDoc,
  buildReadableLibrary,
  buildGroupsMarkdown,
  writeFiles,
  gatherAndSync,
  saveFolderLink,
  loadFolderLink,
  clearFolderLink
} from '../src/lib/folder-sync.js';
import { parseImport } from '../src/lib/export.js';

// --------------------------------------------------------------- fixtures

const collections = [
  {
    id: 'c1',
    name: 'Research <tabs>',
    description: '',
    tags: ['work'],
    logo: null,
    wallpaper: null,
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      { id: 't1', url: 'https://a.example/page?q=1&x=2', title: 'A & B', favIconUrl: '', domain: 'a.example', notes: '', tags: [], addedAt: 1 },
      { id: 't2', url: 'https://b.example/', title: 'B', favIconUrl: '', domain: 'b.example', notes: '', tags: [], addedAt: 2 }
    ]
  },
  {
    id: 'c2',
    name: 'Empty one',
    description: '',
    tags: [],
    logo: null,
    wallpaper: null,
    createdAt: 1,
    updatedAt: 1,
    tabs: []
  }
];

const bookmarkTree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [{ id: '3', title: 'Docs', url: 'https://docs.example/' }]
      },
      { id: '2', title: 'Other bookmarks', children: [] }
    ]
  }
];

const groups = [
  { id: 7, title: 'Plan "trip"', color: 'blue', collapsed: true, windowId: 1 },
  { id: 9, title: '', color: 'red', collapsed: false, windowId: 2 }
];

const tabs = [
  { groupId: 7, url: 'https://g1.example/', title: 'G1' },
  { groupId: 7, url: 'https://g2.example/', title: 'G2' },
  { groupId: -1, url: 'https://loose.example/', title: 'Loose' }
];

function fakeStorage(initial = {}) {
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

/** In-memory FileSystemDirectoryHandle stand-in. */
function fakeDir(name = 'Backups') {
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

// ------------------------------------------------------------ formats

test('normalizeFormat accepts known values and falls back to the default', () => {
  assert.equal(normalizeFormat('readable'), 'readable');
  assert.equal(normalizeFormat('json'), 'json');
  assert.equal(normalizeFormat('both'), 'both');
  assert.equal(normalizeFormat('xml'), DEFAULT_FORMAT);
  assert.equal(normalizeFormat(undefined), DEFAULT_FORMAT);
  assert.equal(DEFAULT_FORMAT, 'readable');
});

test('formatFileNames lists exactly the names each format writes', () => {
  assert.deepEqual(formatFileNames('readable'), [BACKUP_FILES.libraryMd, BACKUP_FILES.groupsMd, BACKUP_FILES.bookmarks, BACKUP_FILES.readme]);
  assert.deepEqual(formatFileNames('json'), [BACKUP_FILES.library, BACKUP_FILES.groups, BACKUP_FILES.bookmarks, BACKUP_FILES.readme]);
  assert.equal(formatFileNames('both').length, 6);
  assert.equal(new Set(formatFileNames('both')).size, 6);
});

// ------------------------------------------------------------ buildFiles

test('buildFiles default format is readable Markdown, not JSON', () => {
  const files = buildFiles({ collections, bookmarkTree, groups, tabs, now: 1700000000000 });
  assert.deepEqual(
    files.map((f) => f.name),
    formatFileNames(DEFAULT_FORMAT)
  );
  assert.ok(!files.some((f) => f.name.endsWith('.json')), 'no JSON file in the default format');
  for (const f of files) assert.equal(typeof f.text, 'string');
});

test('buildFiles json and both formats include the re-importable library', () => {
  for (const format of ['json', 'both']) {
    const files = buildFiles({ collections, bookmarkTree, groups, tabs, now: 1700000000000, format });
    assert.deepEqual(files.map((f) => f.name), formatFileNames(format), format);
  }
});

test('library file round-trips through parseImport (re-install restore path)', () => {
  const files = buildFiles({ collections, bookmarkTree, groups, tabs, now: 1700000000000, format: 'json' });
  const library = files.find((f) => f.name === BACKUP_FILES.library);
  const parsed = parseImport(library.text);
  assert.equal(parsed.ok, true, parsed.errors ? parsed.errors.join('; ') : '');
  assert.equal(parsed.collections.length, 2);
  assert.equal(parsed.collections[0].name, 'Research <tabs>');
  assert.equal(parsed.collections[0].tabs.length, 2);
  assert.equal(parsed.collections[0].tabs[0].url, 'https://a.example/page?q=1&x=2');
});

test('groups file is readable JSON with only grouped tabs', () => {
  const files = buildFiles({ collections, bookmarkTree, groups, tabs, now: 1700000000000, format: 'json' });
  const doc = JSON.parse(files.find((f) => f.name === BACKUP_FILES.groups).text);
  assert.equal(doc.kind, 'tabvault.tabGroups');
  assert.equal(doc.groups.length, 2);
  assert.equal(doc.groups[0].title, 'Plan "trip"');
  assert.deepEqual(
    doc.groups[0].tabs.map((t) => t.url),
    ['https://g1.example/', 'https://g2.example/']
  );
  assert.deepEqual(doc.groups[1].tabs, []); // group 9 has no tabs; ungrouped tab excluded
  assert.equal(doc.exportedAt, new Date(1700000000000).toISOString());
});

// --------------------------------------------------- readable Markdown

test('readable library document has headings, links and per-collection sections', () => {
  const md = buildReadableLibrary({ collections, now: 1700000000000 });
  assert.ok(md.startsWith('# TabVault library'));
  assert.ok(md.includes('## Research <tabs>'));
  assert.ok(md.includes('Tags: work'));
  assert.ok(md.includes('[A & B](https://a.example/page?q=1&x=2)'));
  assert.ok(md.includes('- https://b.example/') === false); // title exists → link form
  assert.ok(md.includes('## Empty one'));
  assert.ok(md.includes('_No tabs._'));
  assert.ok(!md.includes('```'), 'no accidental code fences');
});

test('readable library escapes brackets in titles so links stay valid', () => {
  const md = buildReadableLibrary({
    collections: [{ name: 'Weird [name]', tabs: [{ url: 'https://w.example/', title: 'see [this] and [that]' }] }]
  });
  assert.ok(md.includes('## Weird [name]'), 'heading keeps plain brackets (valid Markdown)');
  assert.ok(md.includes('see \\[this\\] and \\[that\\]'), 'link text brackets are escaped');
});

test('readable library handles empty input and multiline text', () => {
  const md = buildReadableLibrary({ collections: [] });
  assert.ok(md.startsWith('# TabVault library'));
  assert.ok(md.includes('_No collections yet._'));
  const messy = buildReadableLibrary({
    collections: [{ name: 'Line\nbreak', description: 'multi\nline\ndesc', tabs: [{ url: 'https://m.example/', title: 'New\nline' }] }]
  });
  assert.ok(messy.includes('## Line break'));
  assert.ok(messy.includes('multi line desc'));
  assert.ok(messy.includes('[New line](https://m.example/)'));
});

test('groups Markdown shows color/collapsed meta and only grouped tabs', () => {
  const md = buildGroupsMarkdown({ groups, tabs, now: 1700000000000 });
  assert.ok(md.startsWith('# Chrome tab groups'));
  assert.ok(md.includes('## Plan "trip" — blue, collapsed'));
  assert.ok(md.includes('[G1](https://g1.example/)'));
  assert.ok(md.includes('[G2](https://g2.example/)'));
  assert.ok(md.includes('## Untitled group'));
  assert.ok(!md.includes('https://loose.example/'));
});

// ---------------------------------------------------- buildBookmarksHtml

test('bookmarks HTML is a valid Netscape document with escaped content', () => {
  const html = buildBookmarksHtml({ collections, bookmarkTree, groups, tabs });
  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert.ok(html.includes('<DT><H3>TabVault collections</H3>'));
  assert.ok(html.includes('<DT><H3>Chrome tab groups</H3>'));
  assert.ok(html.includes('<DT><H3>Chrome bookmarks</H3>'));
  // Collection tabs present with escaping applied to & in both attr and text.
  assert.ok(html.includes('HREF="https://a.example/page?q=1&amp;x=2"'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(html.includes('Research &lt;tabs&gt;'));
  // Group folder title escaping, group tabs, bookmark tree.
  assert.ok(html.includes('Plan &quot;trip&quot;'));
  assert.ok(html.includes('HREF="https://g1.example/"'));
  assert.ok(html.includes('HREF="https://docs.example/"'));
  // Synthetic root node itself must not become a folder.
  assert.ok(!html.includes('<DT><H3></H3>'));
  // Balanced DL structure.
  const opens = (html.match(/<DL>/g) || []).length;
  const closes = (html.match(/<\/DL>/g) || []).length;
  assert.equal(opens, closes);
  // The ungrouped tab must not leak into any group folder.
  assert.ok(!html.includes('https://loose.example/'));
});

test('bookmarks HTML handles empty inputs without crashing', () => {
  const html = buildBookmarksHtml();
  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert.equal((html.match(/<DL>/g) || []).length, (html.match(/<\/DL>/g) || []).length);
});

// -------------------------------------------------------- writeFiles

test('writeFiles creates/overwrites every file via the directory handle', async () => {
  const dir = fakeDir();
  const files = buildFiles({ collections, bookmarkTree, groups, tabs });
  const { written, skipped } = await writeFiles(dir, files);
  assert.deepEqual(written, files.map((f) => f.name));
  assert.equal(skipped, 0);
  assert.equal(dir.files.size, files.length);
  for (const f of files) assert.equal(dir.files.get(f.name), f.text);
  // Second run with identical content skips every write.
  const again = await writeFiles(dir, files);
  assert.equal(again.skipped, files.length);
  assert.equal(dir.files.size, files.length);
  // Changed content is rewritten in place, not appended.
  const changed = files.map((f) => (f.name === BACKUP_FILES.libraryMd ? { ...f, text: f.text + '\nmore' } : f));
  const third = await writeFiles(dir, changed);
  assert.equal(third.skipped, files.length - 1);
  assert.equal(dir.files.get(BACKUP_FILES.libraryMd), changed.find((f) => f.name === BACKUP_FILES.libraryMd).text);
});

test('writeFiles rejects a missing/invalid handle', async () => {
  await assert.rejects(() => writeFiles(null, []), /No folder is linked/);
  await assert.rejects(() => writeFiles({}, []), /No folder is linked/);
});

// -------------------------------------------------------- gatherAndSync

test('gatherAndSync with no handle fails cleanly', async () => {
  const storage = fakeStorage();
  const res = await gatherAndSync({
    handle: null,
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /No folder is linked/);
});

test('gatherAndSync writes files and records status', async () => {
  const dir = fakeDir('MyBackup');
  const storage = fakeStorage({ collections, [FORMAT_KEY]: 'json' });
  const res = await gatherAndSync({
    handle: dir,
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs },
    now: 1700000000000
  });
  assert.equal(res.ok, true);
  assert.equal(res.written.length, 4);
  assert.equal(res.skipped, 0);
  assert.equal(res.format, 'json');
  // Data actually came from storage.
  const lib = JSON.parse(dir.files.get(BACKUP_FILES.library));
  assert.equal(lib.collections.length, 2);
  // Status recorded + pending cleared + format persisted.
  assert.equal(storage.data.folderBackup.folderName, 'MyBackup');
  assert.equal(storage.data.folderBackup.lastSyncAt, 1700000000000);
  assert.equal(storage.data.folderBackup.format, 'json');
  assert.equal(storage.data.backupPending, false);
  assert.equal(storage.data[FORMAT_KEY], 'json');
});

test('gatherAndSync defaults to the readable format and stores the choice', async () => {
  const dir = fakeDir();
  const storage = fakeStorage({ collections });
  const res = await gatherAndSync({
    handle: dir,
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  });
  assert.equal(res.ok, true);
  assert.equal(res.format, DEFAULT_FORMAT);
  assert.ok(dir.files.has(BACKUP_FILES.libraryMd));
  assert.ok(!dir.files.has(BACKUP_FILES.library));
  assert.equal(storage.data[FORMAT_KEY], DEFAULT_FORMAT);
});

test('gatherAndSync honors an explicit format over the stored one', async () => {
  const dir = fakeDir();
  const storage = fakeStorage({ collections, [FORMAT_KEY]: 'readable' });
  const res = await gatherAndSync({
    handle: dir,
    format: 'both',
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  });
  assert.equal(res.format, 'both');
  assert.equal(res.written.length, 6);
  assert.equal(dir.files.size, 6);
  assert.equal(storage.data[FORMAT_KEY], 'both');
});

test('switching format prunes only TabVault-owned files from the old format', async () => {
  const dir = fakeDir();
  const deps = {
    storage: fakeStorage({ collections }),
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  };
  dir.files.set('my-own-file.txt', 'hands off');
  await gatherAndSync({ ...deps, handle: dir, format: 'both' });
  assert.equal(dir.files.size, 7); // 6 backup files + the user's file
  const res = await gatherAndSync({ ...deps, handle: dir, format: 'readable' });
  assert.equal(res.ok, true);
  assert.ok(!dir.files.has(BACKUP_FILES.library));
  assert.ok(!dir.files.has(BACKUP_FILES.groups));
  assert.ok(dir.files.has(BACKUP_FILES.libraryMd));
  assert.ok(dir.files.has('my-own-file.txt'), 'files not written by TabVault are never touched');
});

test('gatherAndSync reports needsPermission and flags pending when access is "prompt"', async () => {
  const dir = fakeDir();
  dir.permission = 'prompt';
  const storage = fakeStorage({ collections });
  const res = await gatherAndSync({
    handle: dir,
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  });
  assert.equal(res.ok, false);
  assert.equal(res.needsPermission, true);
  assert.equal(storage.data.backupPending, true);
  assert.equal(dir.files.size, 0); // nothing written without access
});

test('gatherAndSync flags pending on write failure and surfaces the error', async () => {
  const dir = fakeDir();
  dir.getFileHandle = async () => {
    throw new Error('NotAllowedError: permission denied');
  };
  const storage = fakeStorage({ collections });
  const res = await gatherAndSync({
    handle: dir,
    storage,
    bookmarks: { getTree: async () => bookmarkTree },
    tabGroups: { query: async () => groups },
    tabs: { query: async () => tabs }
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /permission denied/);
  assert.equal(storage.data.backupPending, true);
});

// -------------------------------------------------- handle persistence

test('saveFolderLink rejects non-handles', async () => {
  await assert.rejects(() => saveFolderLink(null), /Not a directory handle/);
  await assert.rejects(() => saveFolderLink({}), /Not a directory handle/);
});

test('loadFolderLink returns null when IndexedDB is unavailable (never throws)', async () => {
  // Node has no indexedDB — the module must degrade to "not linked".
  const handle = await loadFolderLink();
  assert.equal(handle, null);
  await clearFolderLink(); // must also not throw
});

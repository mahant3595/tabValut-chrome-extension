// TabVault — linked-folder backup.
//
// The user links a system folder once (File System Access API, from an
// extension page). From then on TabVault mirrors its data into that folder as
// PLAIN files, so the data outlives the extension: if TabVault is removed,
// chrome.storage goes with it, but the files stay on disk and can be opened
// or re-imported without any extension.
//
// The user picks the format (chrome.storage.local `folderBackupFormat`):
//
//   readable (default)             readable Markdown — open in any editor
//   json                           compact JSON for scripts/re-import
//   both                           the six files below, all together
//
//   TabVault-library.md       collections as Markdown sections with links
//   TabVault-tab-groups.md    live Chrome tab groups as Markdown
//   TabVault-library.json     collections — re-import via Import in TabVault
//   TabVault-tab-groups.json  live Chrome tab groups with their tabs
//   TabVault-bookmarks.html   collections + tab groups + Chrome bookmarks as
//                             one Netscape HTML file any browser can import
//   TabVault-README.txt       explains the files actually written
//
// Unchanged files are not rewritten (no pointless disk churn for sync tools),
// and switching format removes the files the old format used to write.
//
// All environment surfaces (storage, bookmarks, tabGroups, tabs, the
// directory handle) are injected, so the whole flow runs in
// tools/simulate.mjs and test/folder-sync.test.mjs without a browser.

import { serializeCollections, parseImport } from './export.js';
import { putBlob, getBlob, deleteBlob } from './idb.js';

const LINK_KEY = 'folder-link'; // IDB key holding the FileSystemDirectoryHandle
export const FORMAT_KEY = 'folderBackupFormat';

export const BACKUP_FILES = {
  libraryMd: 'TabVault-library.md',
  groupsMd: 'TabVault-tab-groups.md',
  library: 'TabVault-library.json',
  groups: 'TabVault-tab-groups.json',
  bookmarks: 'TabVault-bookmarks.html',
  readme: 'TabVault-README.txt'
};

/** Every name TabVault ever writes — the only names pruning may delete. */
export const ALL_BACKUP_NAMES = Object.values(BACKUP_FILES);

export const FORMAT_OPTIONS = [
  {
    value: 'readable',
    label: 'Readable files (Markdown)',
    blurb: 'Open in any text editor: one section per collection or tab group, every tab a clickable link.'
  },
  {
    value: 'json',
    label: 'JSON files',
    blurb: 'Compact machine format — re-imports into TabVault with one click; best for scripts.'
  },
  {
    value: 'both',
    label: 'Both formats',
    blurb: 'Readable Markdown plus the JSON files, kept in sync side by side.'
  }
];

export const DEFAULT_FORMAT = 'readable';

const GROUPS_KIND = 'tabvault.tabGroups';

/** Accept only known format names; anything else falls back to the default. */
export function normalizeFormat(value) {
  return FORMAT_OPTIONS.some((o) => o.value === value) ? value : DEFAULT_FORMAT;
}

// ------------------------------------------------------- handle persistence

/** Persist the linked directory handle (structured-cloneable) in IndexedDB. */
export async function saveFolderLink(handle) {
  if (!handle || typeof handle.getFileHandle !== 'function') {
    throw new Error('Not a directory handle.');
  }
  await putBlob(LINK_KEY, handle);
  return handle;
}

/** Load the linked handle, or null (never throws — IDB may be unavailable). */
export async function loadFolderLink() {
  try {
    const handle = await getBlob(LINK_KEY);
    return handle && typeof handle.getFileHandle === 'function' ? handle : null;
  } catch {
    return null;
  }
}

/** Forget the link. Files already written to disk are never touched. */
export async function clearFolderLink() {
  try {
    await deleteBlob(LINK_KEY);
  } catch {
    /* best-effort */
  }
}

// ------------------------------------------------------------ content build

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(depth) {
  return '  '.repeat(depth);
}

/** One-line plain text for Markdown bodies (headings, list labels). */
function mdLine(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Escape a title used as Markdown link text: [ ] and line breaks. */
function mdLinkText(value) {
  return (
    mdLine(value)
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
  ) || '(untitled)';
}

/** Markdown bullet for one tab/bookmark: clickable when a title exists. */
function mdLink(item) {
  const url = mdLine(item && item.url);
  if (!url) return null;
  const title = mdLine(item && item.title);
  return title ? `- [${mdLinkText(title)}](${url})` : `- ${url}`;
}

/** Netscape Bookmark File Format — importable by every browser. */
export function buildBookmarksHtml({ collections = [], bookmarkTree = [], groups = [], tabs = [] } = {}) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>TabVault backup</TITLE>',
    '<H1>TabVault backup</H1>',
    '<DL><p>'
  ];
  const link = (depth, item) => {
    lines.push(`${pad(depth)}<DT><A HREF="${esc(item.url)}">${esc(item.title || item.url)}</A>`);
  };
  const open = (depth, title) => {
    lines.push(`${pad(depth)}<DT><H3>${esc(title)}</H3>`);
    lines.push(`${pad(depth)}<DL><p>`);
  };
  const close = (depth) => lines.push(`${pad(depth)}</DL><p>`);

  // Collections (TabVault groups) with every saved tab.
  open(1, 'TabVault collections');
  for (const c of collections) {
    open(2, (c && c.name) || 'Untitled');
    for (const t of (c && c.tabs) || []) {
      if (t && t.url) link(3, t);
    }
    close(2);
  }
  close(1);

  // Live Chrome tab groups with their tabs.
  open(1, 'Chrome tab groups');
  for (const g of groups) {
    open(2, (g && g.title) || 'Untitled group');
    for (const t of tabs) {
      if (t.groupId === g.id && t.url) link(3, t);
    }
    close(2);
  }
  close(1);

  // The real Chrome bookmark tree (skip the synthetic root node).
  open(1, 'Chrome bookmarks');
  const roots =
    bookmarkTree.length === 1 && Array.isArray(bookmarkTree[0].children) ? bookmarkTree[0].children : bookmarkTree;
  const renderNodes = (nodes, depth) => {
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.url) link(depth, node);
      else if (Array.isArray(node.children)) {
        open(depth, node.title || 'Folder');
        renderNodes(node.children, depth + 1);
        close(depth);
      }
    }
  };
  renderNodes(roots, 2);
  close(1);

  lines.push('</DL><p>');
  return lines.join('\n');
}

/** Collections as a human-readable Markdown document. */
export function buildReadableLibrary({ collections = [], now = Date.now() } = {}) {
  const total = collections.reduce((n, c) => n + ((c && c.tabs) || []).length, 0);
  const lines = [
    '# TabVault library',
    '',
    `Written ${new Date(now).toISOString()} — ${collections.length} collection(s), ${total} tab(s).`,
    '',
    'Plain-text copy of your saved collections: each collection is a section,',
    'each bullet one saved tab (title links to the page). Written by the',
    'TabVault extension; it stays here even if the extension is removed.',
    ''
  ];
  if (!collections.length) {
    lines.push('_No collections yet._', '');
  }
  for (const c of collections) {
    lines.push(`## ${mdLine((c && c.name) || 'Untitled')}`, '');
    const desc = mdLine(c && c.description);
    if (desc) lines.push(desc, '');
    if (c && Array.isArray(c.tags) && c.tags.length) {
      lines.push(`Tags: ${c.tags.map(mdLine).filter(Boolean).join(', ')}`, '');
    }
    const tabs = ((c && c.tabs) || []).filter((t) => t && t.url);
    if (!tabs.length) {
      lines.push('_No tabs._', '');
      continue;
    }
    for (const t of tabs) {
      const bullet = mdLink(t);
      if (bullet) lines.push(bullet);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Live Chrome tab groups as a human-readable Markdown document. */
export function buildGroupsMarkdown({ groups = [], tabs = [], now = Date.now() } = {}) {
  const lines = [
    '# Chrome tab groups',
    '',
    `Written ${new Date(now).toISOString()} — ${groups.length} group(s), open in Chrome right now.`,
    ''
  ];
  if (!groups.length) {
    lines.push('_No tab groups open._', '');
  }
  for (const g of groups) {
    const meta = [mdLine(g && g.color), g && g.collapsed ? 'collapsed' : null].filter(Boolean).join(', ');
    lines.push(`## ${mdLine((g && g.title) || 'Untitled group')}${meta ? ` — ${meta}` : ''}`, '');
    const grouped = tabs.filter((t) => t.groupId === g.id && t.url);
    if (!grouped.length) {
      lines.push('_No tabs._', '');
      continue;
    }
    for (const t of grouped) {
      const bullet = mdLink(t);
      if (bullet) lines.push(bullet);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Live Chrome tab groups as readable JSON. */
export function buildGroupsDoc({ groups = [], tabs = [], now = Date.now() } = {}) {
  return JSON.stringify(
    {
      app: 'tabvault',
      kind: GROUPS_KIND,
      version: 1,
      exportedAt: new Date(now).toISOString(),
      groups: (groups || []).map((g) => ({
        title: String((g && g.title) || '').slice(0, 500),
        color: String((g && g.color) || '').slice(0, 40),
        collapsed: Boolean(g && g.collapsed),
        windowId: g && Number.isInteger(g.windowId) ? g.windowId : null,
        tabs: (tabs || [])
          .filter((t) => t.groupId === g.id && t.url)
          .map((t) => ({ url: t.url, title: String(t.title || '').slice(0, 500) }))
      }))
    },
    null,
    2
  );
}

/** Names written for a format, in write order. */
export function formatFileNames(format) {
  const f = normalizeFormat(format);
  if (f === 'json') {
    return [BACKUP_FILES.library, BACKUP_FILES.groups, BACKUP_FILES.bookmarks, BACKUP_FILES.readme];
  }
  if (f === 'both') {
    return [
      BACKUP_FILES.libraryMd,
      BACKUP_FILES.groupsMd,
      BACKUP_FILES.library,
      BACKUP_FILES.groups,
      BACKUP_FILES.bookmarks,
      BACKUP_FILES.readme
    ];
  }
  return [BACKUP_FILES.libraryMd, BACKUP_FILES.groupsMd, BACKUP_FILES.bookmarks, BACKUP_FILES.readme];
}

const README_HELP = {
  [BACKUP_FILES.libraryMd]:
    'Your collections as Markdown — readable in any text editor, one section per collection, each tab a clickable link.',
  [BACKUP_FILES.groupsMd]: 'The Chrome tab groups that are open right now, as Markdown.',
  [BACKUP_FILES.library]:
    'All TabVault collections with their saved tabs — re-import with the Import button on the Collections page.',
  [BACKUP_FILES.groups]: 'Snapshot of the live Chrome tab groups and their tabs (JSON).',
  [BACKUP_FILES.bookmarks]:
    'Collections, Chrome tab groups and Chrome bookmarks in one file every browser can import.',
  [BACKUP_FILES.readme]: 'What each file is and how to restore everything without the extension.'
};

function buildReadme(now, format) {
  const names = formatFileNames(format);
  const lines = [
    'TabVault folder backup',
    '======================',
    '',
    'These files were written by the TabVault browser extension and stay here',
    'even if TabVault is removed — nothing else can delete them.',
    ''
  ];
  for (const name of names) {
    lines.push(name, `  ${README_HELP[name]}`, '');
  }
  lines.push(
    `Format: ${normalizeFormat(format)}. To change it, open the TabVault`,
    'dashboard -> Folder backup and pick another format; files from the old',
    'format are removed on the next sync.',
    '',
    `Last written: ${new Date(now).toISOString()}`
  );
  return lines.join('\n');
}

/**
 * Build the backup files for a format from current data.
 * Pure function — covered by test/folder-sync.test.mjs.
 */
export function buildFiles({ collections = [], bookmarkTree = [], groups = [], tabs = [], now = Date.now(), format } = {}) {
  const f = normalizeFormat(format);
  const content = {
    [BACKUP_FILES.libraryMd]: () => buildReadableLibrary({ collections, now }),
    [BACKUP_FILES.groupsMd]: () => buildGroupsMarkdown({ groups, tabs, now }),
    [BACKUP_FILES.library]: () => serializeCollections(collections, now),
    [BACKUP_FILES.groups]: () => buildGroupsDoc({ groups, tabs, now }),
    [BACKUP_FILES.bookmarks]: () => buildBookmarksHtml({ collections, bookmarkTree, groups, tabs }),
    [BACKUP_FILES.readme]: () => buildReadme(now, f)
  };
  return formatFileNames(f).map((name) => ({ name, text: content[name]() }));
}

// ------------------------------------------------------------------ writing

/**
 * Write files into a FileSystemDirectoryHandle (create or overwrite).
 * A file whose content already matches is NOT rewritten — the folder is
 * mirrored with minimal disk churn, so file-sync tools see no fake changes.
 * @returns {Promise<{written: string[], skipped: number}>}
 */
export async function writeFiles(dirHandle, files) {
  if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') {
    throw new Error('No folder is linked.');
  }
  const written = [];
  let skipped = 0;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential writes keep folder order stable
    let existing = null;
    try {
      const fh = await dirHandle.getFileHandle(file.name);
      existing = await fh.getFile();
    } catch {
      /* missing or unreadable — fall through to a normal write */
    }
    if (existing && typeof existing.text === 'function' && (await existing.text()) === file.text) {
      skipped += 1;
      written.push(file.name);
      continue;
    }
    const fh = await dirHandle.getFileHandle(file.name, { create: true });
    const writer = await fh.createWritable();
    await writer.write(file.text);
    await writer.close();
    written.push(file.name);
  }
  return { written, skipped };
}

/**
 * Delete TabVault-owned backup files that the current format no longer
 * writes (e.g. the JSON files after switching to Markdown-only). Only the
 * names in ALL_BACKUP_NAMES are ever removed — nothing else in the folder.
 */
async function pruneOtherFormatFiles(dirHandle, keepNames) {
  if (!dirHandle || typeof dirHandle.removeEntry !== 'function') return 0;
  let removed = 0;
  for (const name of ALL_BACKUP_NAMES) {
    if (keepNames.includes(name)) continue;
    // eslint-disable-next-line no-await-in-loop -- order is irrelevant, kept simple
    try {
      await dirHandle.removeEntry(name);
      removed += 1;
    } catch {
      /* not present (the common case) or not removable — leave it alone */
    }
  }
  return removed;
}

// ----------------------------------------------------------------- syncing

/** Tiny FNV-1a hash — only used to detect "same data, new sync tick". */
function signatureOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Gather current data and mirror it into the linked folder.
 *
 * Storage results and failure state are recorded so the dashboard can show
 * status and catch up after Chrome drops file access (permission resets to
 * "prompt" after a restart; requestPermission needs a user gesture in a page,
 * so the service worker only ever reports `needsPermission`).
 *
 * @param {object} deps
 * @param {FileSystemDirectoryHandle|null} deps.handle
 * @param {{get: Function, set: Function}} deps.storage chrome.storage.local-like
 * @param {{getTree: Function}} deps.bookmarks
 * @param {{query: Function}} deps.tabGroups
 * @param {{query: Function}} deps.tabs
 * @param {'readable'|'json'|'both'} [deps.format] overrides the stored choice
 * @param {boolean} [deps.force] rewrite files even if the data signature is unchanged
 * @param {number} [deps.now]
 * @returns {Promise<{ok: boolean, written?: string[], skipped?: number, unchanged?: boolean, format?: string, error?: string, needsPermission?: boolean}>}
 */
export async function gatherAndSync({ handle, storage, bookmarks, tabGroups, tabs, format, force = false, now = Date.now() }) {
  if (!handle) return { ok: false, error: 'No folder is linked.' };
  if (typeof handle.queryPermission === 'function') {
    let state = 'granted';
    try {
      state = await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      state = 'prompt';
    }
    if (state !== 'granted') {
      try {
        await storage.set({ backupPending: true });
      } catch {
        /* best-effort */
      }
      return { ok: false, needsPermission: true };
    }
  }
  try {
    const got = await storage.get(['collections', FORMAT_KEY, 'folderBackup']);
    const collections = got && Array.isArray(got.collections) ? got.collections : [];
    const chosen = normalizeFormat(format !== undefined ? format : got && got[FORMAT_KEY]);
    const bookmarkTree = await bookmarks.getTree();
    const groups = await tabGroups.query({});
    const allTabs = await tabs.query({});

    // Nothing on disk to restore from — a sync must always write once.
    const prev = got && got.folderBackup;
    const firstSync = !prev || !Array.isArray(prev.files) || prev.files.length === 0;
    // Skip the disk entirely when the underlying data (and format) did not
    // change: the docs embed the sync time, so comparing texts would always
    // differ — compare a signature of the data itself instead. Manual
    // "Sync now" passes force=true and always rewrites.
    const signature = signatureOf({ collections, bookmarkTree, groups, allTabs, format: chosen });
    if (!force && !firstSync && prev.signature === signature && prev.format === chosen) {
      try {
        await storage.set({ folderBackup: { ...prev, lastSyncAt: now }, backupPending: false });
      } catch {
        /* best-effort */
      }
      return { ok: true, written: prev.files, skipped: prev.files.length, unchanged: true, format: chosen };
    }

    const files = buildFiles({ collections, bookmarkTree, groups, tabs: allTabs, now, format: chosen });
    const { written, skipped } = await writeFiles(handle, files);
    await pruneOtherFormatFiles(handle, written);
    try {
      await storage.set({
        folderBackup: {
          folderName: String(handle.name || 'linked folder'),
          lastSyncAt: now,
          format: chosen,
          signature,
          files: written
        },
        [FORMAT_KEY]: chosen,
        backupPending: false
      });
    } catch {
      /* best-effort */
    }
    return { ok: true, written, skipped, format: chosen };
  } catch (err) {
    const error = String((err && err.message) || err);
    try {
      await storage.set({ backupPending: true });
    } catch {
      /* best-effort */
    }
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------- restoring
// The backup files outlive the extension. After a reinstall (or on a new
// machine) the user can point TabVault at an old backup folder and get their
// collections — and any captured tab groups — back. Nothing here writes to
// storage or to disk: it only builds a plan the caller previews then imports.

/** Read a named file's text from a directory handle, or null if absent. */
async function readTextFromDir(dirHandle, name) {
  try {
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    return typeof file.text === 'function' ? await file.text() : null;
  } catch {
    return null;
  }
}

/**
 * Parse one of TabVault's own Markdown backups back into collection-shaped
 * objects. Handles both the library and groups documents (headers there carry
 * a ` — color, collapsed` suffix that `stripMeta` removes).
 */
export function parseBackupMarkdown(text, { stripMeta = false } = {}) {
  const collections = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      let name = line.slice(3).trim() || 'Untitled';
      if (stripMeta) name = name.split(' — ')[0].trim() || 'Untitled group';
      current = { name, description: '', tags: [], tabs: [] };
      collections.push(current);
      continue;
    }
    if (!current) continue; // file preamble / headings before the first section
    if (line === '_No tabs._' || line === '_No collections yet._' || line === '_No tab groups open._') continue;
    if (line.startsWith('Tags:')) {
      current.tags = line
        .slice(5)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 40);
      continue;
    }
    const md = /^-\s+\[(.*)\]\((\S+)\)$/.exec(line);
    if (md) {
      current.tabs.push({ url: md[2].trim(), title: md[1].replace(/\\(.)/g, '$1').trim() || md[2].trim() });
      continue;
    }
    if (line.startsWith('- ')) {
      const url = line.slice(2).trim();
      current.tabs.push({ url, title: url });
      continue;
    }
    if (line && !line.startsWith('#') && !current.description) current.description = line;
  }
  return collections.filter((c) => c.tabs.length > 0);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Pull TabVault collections back out of the Netscape bookmarks HTML backup.
 * This file is written in every format, so it is the last-resort source when
 * the JSON/Markdown library files are missing or empty.
 */
export function parseBookmarksHtml(html) {
  const collections = [];
  let inCollections = false;
  let current = null;
  for (const raw of String(html || '').split(/\r?\n/)) {
    const line = raw.trim();
    const h3 = /<H3>([\s\S]*?)<\/H3>/i.exec(line);
    if (h3) {
      const title = decodeEntities(h3[1]).trim();
      if (title === 'TabVault collections') {
        inCollections = true;
        current = null;
        continue;
      }
      if (inCollections && (title === 'Chrome tab groups' || title === 'Chrome bookmarks')) {
        inCollections = false;
        current = null;
        continue;
      }
      if (inCollections) {
        current = { name: title || 'Restored collection', description: '', tags: [], tabs: [] };
        collections.push(current);
      }
      continue;
    }
    if (!inCollections || !current) continue;
    const a = /<A\s+[^>]*HREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>/i.exec(line);
    if (a) {
      const url = decodeEntities(a[1]).trim();
      const title = decodeEntities(a[2]).trim();
      if (url) current.tabs.push({ url, title: title || url });
    }
  }
  return collections.filter((c) => c.tabs.length > 0);
}

/** Turn a snapshot of live Chrome tab groups into importable collections. */
export function groupsToCollections(groups, exportedAt = null) {
  const createdAt = exportedAt ? Date.parse(exportedAt) || undefined : undefined;
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => Array.isArray(g && g.tabs) && g.tabs.length > 0)
    .map((g) => ({
      name: `Tab group: ${String((g && g.title) || 'Untitled').slice(0, 100)}`,
      description: 'Restored from a TabVault tab-group backup.',
      tags: ['restored', 'tab-group'],
      createdAt,
      tabs: g.tabs
        .filter((t) => t && typeof t.url === 'string' && t.url.trim())
        .map((t) => ({ url: String(t.url).trim(), title: String(t.title || t.url).slice(0, 500) }))
    }))
    .filter((c) => c.tabs.length > 0);
}

/**
 * Build a restore plan from an existing backup folder. Reads whichever
 * backup files it can find — the collections JSON (lossless) or, when the
 * default Markdown format was used, the Markdown library — plus any captured
 * tab groups (JSON or Markdown, converted into collections).
 *
 * @returns {Promise<{found: string[], empty: string[], collections: object[], warnings: string[]}>}
 */
export async function restorePlanFromFolder(dirHandle) {
  const plan = { found: [], empty: [], collections: [], warnings: [] };
  if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') {
    plan.warnings.push('That is not a folder.');
    return plan;
  }

  // 1. Collections JSON — the canonical, lossless restore.
  const libJson = await readTextFromDir(dirHandle, BACKUP_FILES.library);
  if (libJson) {
    const parsed = parseImport(libJson);
    if (parsed.ok && parsed.collections.length) {
      plan.collections.push(...parsed.collections);
      plan.warnings.push(...parsed.warnings);
      plan.found.push(BACKUP_FILES.library);
    } else {
      plan.empty.push(BACKUP_FILES.library);
      plan.warnings.push(...(parsed.errors || []));
    }
  }

  // 2. Collections Markdown — covers the default (readable) format.
  if (!plan.collections.length) {
    const libMd = await readTextFromDir(dirHandle, BACKUP_FILES.libraryMd);
    if (libMd) {
      const cols = parseBackupMarkdown(libMd);
      if (cols.length) {
        plan.collections.push(...cols);
        plan.found.push(BACKUP_FILES.libraryMd);
      } else {
        plan.empty.push(BACKUP_FILES.libraryMd);
      }
    }
  }

  // 3. Tab groups JSON → collections.
  const grpJson = await readTextFromDir(dirHandle, BACKUP_FILES.groups);
  if (grpJson) {
    try {
      const doc = JSON.parse(grpJson);
      if (doc && doc.kind === GROUPS_KIND && Array.isArray(doc.groups)) {
        const cols = groupsToCollections(doc.groups, doc.exportedAt);
        if (cols.length) {
          plan.collections.push(...cols);
          plan.found.push(BACKUP_FILES.groups);
        }
      }
    } catch {
      plan.warnings.push(`${BACKUP_FILES.groups} isn’t valid JSON — skipped.`);
    }
  } else {
    // 4. Tab groups Markdown — default (readable) format.
    const grpMd = await readTextFromDir(dirHandle, BACKUP_FILES.groupsMd);
    if (grpMd) {
      const cols = parseBackupMarkdown(grpMd, { stripMeta: true }).map((c) => ({
        ...c,
        name: `Tab group: ${c.name}`,
        description: 'Restored from a TabVault tab-group backup.',
        tags: ['restored', 'tab-group']
      }));
      if (cols.length) {
        plan.collections.push(...cols);
        plan.found.push(BACKUP_FILES.groupsMd);
      } else {
        plan.empty.push(BACKUP_FILES.groupsMd);
      }
    }
  }

  // 5. Bookmarks HTML — written in every format, so the last-resort source
  // when the JSON/Markdown library files are missing or empty.
  if (!plan.collections.length) {
    const html = await readTextFromDir(dirHandle, BACKUP_FILES.bookmarks);
    if (html) {
      const cols = parseBookmarksHtml(html);
      if (cols.length) {
        plan.collections.push(...cols);
        plan.found.push(BACKUP_FILES.bookmarks);
      } else {
        plan.empty.push(BACKUP_FILES.bookmarks);
      }
    }
  }

  return plan;
}

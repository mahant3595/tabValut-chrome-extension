// TabVault dashboard — Folder backup.
// Link a system folder once; TabVault mirrors collections, bookmarks and tab
// groups into it as plain files that survive extension removal. The service
// worker does the automatic syncing; this page links/unlinks the folder,
// re-grants access after Chrome resets it (needs a user gesture), and runs a
// manual sync.

import { el, clear, toast, formatDate, confirmModal } from '../ui.js';
import { collections as collectionsStore } from '../store.js';
import {
  BACKUP_FILES,
  FORMAT_KEY,
  FORMAT_OPTIONS,
  normalizeFormat,
  formatFileNames,
  saveFolderLink,
  loadFolderLink,
  clearFolderLink,
  gatherAndSync,
  restorePlanFromFolder
} from '../../../lib/folder-sync.js';

const FILE_HELP = {
  [BACKUP_FILES.libraryMd]: 'Your collections as Markdown — readable in any text editor, one section per collection, each tab a clickable link.',
  [BACKUP_FILES.groupsMd]: 'The Chrome tab groups that are open right now, as Markdown.',
  [BACKUP_FILES.library]: 'All collections with their saved tabs — re-import with the Import button on the Collections page.',
  [BACKUP_FILES.groups]: 'Snapshot of the live Chrome tab groups and their tabs (JSON).',
  [BACKUP_FILES.bookmarks]: 'Collections, Chrome tab groups and Chrome bookmarks in one file every browser can import.',
  [BACKUP_FILES.readme]: 'What each file is and how to restore everything without the extension.'
};

function syncDeps() {
  return {
    storage: chrome.storage.local,
    bookmarks: chrome.bookmarks,
    tabGroups: chrome.tabGroups,
    tabs: chrome.tabs
  };
}

async function status() {
  const handle = await loadFolderLink();
  let permission = null;
  if (handle && typeof handle.queryPermission === 'function') {
    try {
      permission = await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      permission = 'prompt';
    }
  }
  const got = await chrome.storage.local.get(['folderBackup', 'backupPending', FORMAT_KEY]);
  return {
    handle,
    permission,
    folderBackup: (got && got.folderBackup) || null,
    pending: Boolean(got && got.backupPending),
    format: normalizeFormat(got && got[FORMAT_KEY])
  };
}

async function setFormat(container, ctx, value) {
  const format = normalizeFormat(value);
  try {
    await chrome.storage.local.set({ [FORMAT_KEY]: format });
    toast(`Backup format set to “${FORMAT_OPTIONS.find((o) => o.value === format).label}”.`, 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  }
  const st = await status();
  if (st.handle) await doSync(container, ctx); // rewrite the folder right away
  else render(container, ctx);
}

async function doSync(container, ctx) {
  try {
    const st = await status();
    if (!st.handle) {
      toast('No folder linked yet.', 'err');
      return;
    }
    if (st.permission !== 'granted') {
      // requestPermission needs this user gesture.
      try {
        await st.handle.requestPermission({ mode: 'readwrite' });
      } catch {
        /* user cancelled — status() re-reads below */
      }
    }
    const res = await gatherAndSync({ handle: st.handle, force: true, ...syncDeps() });
    if (res.ok) {
      const detail = res.skipped ? `${res.written.length - res.skipped} changed, ${res.skipped} already up to date` : `${res.written.length} files`;
      toast(`Synced “${st.handle.name}” — ${detail}.`, 'ok');
    } else if (res.needsPermission) toast('Chrome has not granted folder access — click Sync now to allow it.', 'err');
    else toast(String(res.error || 'Sync failed.'), 'err');
  } catch (err) {
    toast(String(err.message || err), 'err');
  }
  render(container, ctx);
}

async function doLink(container, ctx) {
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('This browser does not support folder linking.', 'err');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveFolderLink(handle);
    await chrome.storage.local.set({ folderBackup: null, backupPending: false });
    toast(`Linked “${handle.name}”.`, 'ok');
    const res = await gatherAndSync({ handle, ...syncDeps() });
    if (res.ok) toast(`Initial sync wrote ${res.written.length} files.`, 'ok');
    else if (res.needsPermission) toast('Folder linked — click Sync now to allow access.', 'ok');
    else toast(String(res.error || 'Initial sync failed.'), 'err');
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the picker
    toast(String(err.message || err), 'err');
  }
  render(container, ctx);
}

async function doUnlink(container, ctx) {
  const ok = await confirmModal({
    title: 'Unlink this folder?',
    body: 'TabVault will stop writing backups there. The files already written are NOT deleted — they stay on disk.',
    confirmLabel: 'Unlink',
    danger: false
  });
  if (!ok) return;
  await clearFolderLink();
  await chrome.storage.local.set({ folderBackup: null, backupPending: false });
  toast('Folder unlinked. Files already written stay on disk.', 'ok');
  render(container, ctx);
}

async function doRestore(container, ctx) {
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('This browser does not support reading a folder.', 'err');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the picker
    toast(String(err.message || err), 'err');
    return;
  }
  if (!handle) return;

  let plan;
  try {
    plan = await restorePlanFromFolder(handle);
  } catch (err) {
    toast(String(err.message || err), 'err');
    return;
  }

  const totalTabs = plan.collections.reduce((n, c) => n + ((c && c.tabs) || []).length, 0);
  if (!plan.collections.length) {
    if (plan.empty.length) {
      toast(
        `Found ${plan.empty.join(', ')} in “${handle.name}”, but they hold no collections — this backup was last synced while the library was empty.`,
        'err'
      );
    } else {
      toast(`No backup files found in “${handle.name}”. Look for ${BACKUP_FILES.library}, ${BACKUP_FILES.libraryMd} or ${BACKUP_FILES.bookmarks}.`, 'err');
    }
    return;
  }
  const ok = await confirmModal({
    title: `Restore from “${handle.name}”?`,
    body:
      `Found ${plan.collections.length} collection(s) holding ${totalTabs} tab(s) in ${plan.found.join(', ')}. ` +
      'They will be added to TabVault; collections already here are kept and the files on disk are not changed.',
    confirmLabel: 'Restore',
    danger: false
  });
  if (!ok) return;

  try {
    const res = await collectionsStore.import(plan.collections);
    const warn = plan.warnings.length ? ` — ${plan.warnings.length} skipped` : '';
    toast(`Restored ${res.imported} collection(s) from “${handle.name}”${warn}.`, 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
    return;
  }
  render(container, ctx);
}

export async function render(container, ctx) {
  const st = await status();

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', {}, 'Folder backup'),
      el(
        'div',
        { class: 'muted' },
        'Link a folder on this computer. Every collection, bookmark or tab-group change is written there as plain files — so your links survive even if TabVault is removed.'
      )
    ),
    el('button', { class: 'ghost', onclick: () => render(container, ctx) }, '↻ Refresh')
  );

  const body = el('div', {});

  // ------------------------------------------------------------- link state
  const statePanel = el('div', { class: 'panel', style: { marginBottom: '14px' } });
  if (st.handle) {
    statePanel.appendChild(
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        el('div', { style: { flex: 1, minWidth: '200px' } },
          el('div', { style: { fontWeight: 700 } }, `📁 ${st.handle.name || 'Linked folder'}`),
          el('div', { class: 'muted', style: { fontSize: '12px' } },
            `Access: ${st.permission === 'granted' ? 'granted' : 'needs re-allowing (Chrome may ask again after a restart)'}`)
        ),
        el('button', { class: 'primary', onclick: () => doSync(container, ctx) }, 'Sync now'),
        el('button', { onclick: () => doLink(container, ctx) }, 'Change folder'),
        el('button', { class: 'ghost', onclick: () => doUnlink(container, ctx) }, 'Unlink')
      )
    );
    const last = st.folderBackup && st.folderBackup.lastSyncAt;
    statePanel.appendChild(
      el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        last ? `Last sync: ${formatDate(last)}` : 'Not synced yet — click Sync now.')
    );
    if (st.pending) {
      statePanel.appendChild(
        el('div', { style: { marginTop: '8px', color: '#f59e0b', fontSize: '13px' } },
          '⚠ Changes are waiting to sync — click Sync now and allow folder access if asked.')
      );
    }
  } else {
    statePanel.appendChild(
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        el('div', { style: { flex: 1, minWidth: '200px' } },
          el('div', { style: { fontWeight: 700 } }, 'No folder linked'),
          el('div', { class: 'muted', style: { fontSize: '12px' } },
            'Pick an empty folder on this computer (a dedicated one is best). Nothing is uploaded anywhere — files are written straight to disk.')
        ),
        el('button', { class: 'primary', onclick: () => doLink(container, ctx) }, 'Link a folder…')
      )
    );
  }
  body.appendChild(statePanel);

  // ------------------------------------------------------------- restore
  body.appendChild(el('div', { class: 'section-title' }, 'Restore from a backup'));
  const restorePanel = el('div', { class: 'panel', style: { marginBottom: '14px' } });
  restorePanel.append(
    el(
      'div',
      { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
      'Reinstalled TabVault, or moving to a new computer? Pick an old backup folder and its collections (and any captured tab groups) are added straight back into the extension. Nothing already in TabVault is deleted, and the files on disk are never touched.'
    ),
    el('button', { onclick: () => doRestore(container, ctx) }, 'Restore from a folder…')
  );
  body.appendChild(restorePanel);

  // ------------------------------------------------------------- format
  body.appendChild(el('div', { class: 'section-title' }, 'Backup format'));
  const formatPanel = el('div', { class: 'panel', style: { marginBottom: '14px' } });
  const formatSel = el('select', {
    onchange: () => setFormat(container, ctx, formatSel.value)
  });
  for (const opt of FORMAT_OPTIONS) {
    formatSel.appendChild(el('option', { value: opt.value }, opt.label));
  }
  formatSel.value = st.format;
  formatPanel.appendChild(
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      el('label', { class: 'muted', style: { fontSize: '12px' } }, 'Files to write:'),
      formatSel,
      el('span', { class: 'muted', style: { fontSize: '12px', flex: 1, minWidth: '200px' } },
        (FORMAT_OPTIONS.find((o) => o.value === st.format) || FORMAT_OPTIONS[0]).blurb)
    )
  );
  body.appendChild(formatPanel);

  // ------------------------------------------------------------- file list
  body.appendChild(el('div', { class: 'section-title' }, 'What gets written'));
  const list = el('div', { class: 'panel', style: { marginBottom: '14px' } });
  for (const name of formatFileNames(st.format)) {
    const help = FILE_HELP[name];
    list.appendChild(
      el('div', { style: { padding: '6px 0' } },
        el('code', { style: { fontWeight: 700 } }, name),
        el('div', { class: 'muted', style: { fontSize: '12px' } }, help)
      )
    );
  }
  body.appendChild(list);

  // ------------------------------------------------------------- honesty note
  body.appendChild(
    el('div', { class: 'muted', style: { fontSize: '12px' } },
      'Sync runs automatically after every change (collections, bookmarks, tab groups) while the extension is running, plus manually with Sync now. Files that did not change are left untouched on disk. Switching the format above rewrites the folder and removes the files the old format used. Chrome resets folder access after a restart — that is normal: open this page and click Sync now once. The linked folder is remembered between restarts.')
  );

  clear(container).append(head, body);
}

// TabVault dashboard — Bookmark manager.
// All bookmark operations use the chrome.bookmarks API directly; TabVault
// never closes tabs, and bookmark deletion always asks for confirmation.

import { el, clear, toast, confirmModal, promptModal, faviconImg, downloadText, formatDate } from '../ui.js';
import { collections } from '../store.js';
import { openWithoutHistory, openManyWithoutHistory } from '../../../lib/vault-open.js';
import { findDuplicateClusters, normalizeUrlForCompare } from '../../../lib/urls.js';

const BOOKMARK_FOLDER = 'TabVault';

export async function render(container, ctx) {
  const tree = await chrome.bookmarks.getTree();
  const roots = (tree[0] && tree[0].children) || [];

  let selectedId = 'root';
  let vaultSel = null; // selected vault folder (TabVault-only collection)
  let query = '';

  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', {}, 'Bookmarks'),
    el(
      'div',
      { class: 'toolbar', style: { margin: 0 } },
      el('button', { class: 'ghost', onclick: onCreateFolder }, '＋ New folder'),
      el('button', { class: 'primary', onclick: onSaveOpenTabs }, 'Save open tabs as bookmarks…'),
      el('button', { onclick: onExport }, 'Export bookmarks')
    )
  );

  const search = el('input', { type: 'search', placeholder: 'Search all bookmarks…', style: { width: '100%', marginBottom: '10px' } });
  search.addEventListener('input', () => {
    query = search.value.trim();
    paintRight();
  });

  const split = el('div', { class: 'split' });
  const left = el('div', { class: 'panel' });
  const right = el('div', { class: 'panel' });
  split.append(left, right);
  clear(container).append(head, search, split);

  // duplicate marking across ALL bookmarks
  const allItems = flattenBookmarks(roots);
  const urlCounts = new Map();
  for (const item of allItems) {
    const key = normalizeUrlForCompare(item.url);
    if (!key) continue;
    urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
  }

  async function paintLeft() {
    clear(left);

    // Vault folders — bookmark folders that live ONLY inside TabVault and are
    // never written to Chrome's bookmark store.
    const vaultFolders = (await collections.list()).filter((c) => c.vaultFolder);
    left.appendChild(el('div', { class: 'section-title', style: { marginTop: 0 } }, 'Vault folders (not in Chrome)'));
    const vaultListEl = el('div', { class: 'list' });
    for (const c of vaultFolders) {
      vaultListEl.appendChild(
        el(
          'div',
          {
            class: `list-item ${vaultSel === c.id ? 'selected' : ''}`,
            onclick: () => {
              vaultSel = c.id;
              paintLeft();
              paintRight();
            }
          },
          el('span', {}, '🗄'),
          el('div', { class: 'grow' }, el('div', { class: 'title' }, c.name), el('div', { class: 'sub' }, `${c.tabs.length} bookmarks`))
        )
      );
    }
    if (vaultFolders.length === 0) {
      vaultListEl.appendChild(
        el('div', { class: 'muted', style: { fontSize: '12px' } }, 'None yet — create one to keep bookmark folders inside the vault only.')
      );
    }
    left.appendChild(vaultListEl);
    left.appendChild(el('div', { class: 'toolbar' }, el('button', { class: 'small', onclick: onNewVaultFolder }, '＋ New vault folder')));

    left.appendChild(el('div', { class: 'section-title' }, 'Chrome bookmarks'));
    left.appendChild(
      el(
        'div',
        {
          class: `list-item ${!vaultSel && selectedId === 'root' ? 'selected' : ''}`,
          onclick: () => {
            vaultSel = null;
            selectedId = 'root';
            paintLeft();
            paintRight();
          }
        },
        el('span', {}, '🔖'),
        el('div', { class: 'grow' }, el('div', { class: 'title' }, 'All bookmarks'))
      )
    );
    const listEl = el('div', { class: 'list' });
    for (const folder of roots) paintFolder(listEl, folder, 0);
    left.appendChild(listEl);
  }

  async function onNewVaultFolder() {
    const values = await promptModal({
      title: 'New vault folder',
      fields: [{ key: 'name', label: 'Folder name', placeholder: 'Research queue' }],
      submitLabel: 'Create'
    });
    if (!values || !values.name.trim()) return;
    const created = await collections.create(values.name.trim(), '', { vaultFolder: true });
    vaultSel = created.id;
    toast('Vault folder created — it lives only inside TabVault.', 'ok');
    paintLeft();
    paintRight();
  }

  function paintFolder(parent, node, depth) {
    if (!node.children) return;
    const item = el(
      'div',
      {
        class: `list-item ${selectedId === node.id ? 'selected' : ''}`,
        style: { paddingLeft: `${10 + depth * 14}px` },
        onclick: () => {
          vaultSel = null;
          selectedId = node.id;
          paintLeft();
          paintRight();
        }
      },
      el('span', {}, '📁'),
      el('div', { class: 'grow' }, el('div', { class: 'title' }, node.title || 'Folder'))
    );
    parent.appendChild(item);
    for (const child of node.children) paintFolder(parent, child, depth + 1);
  }

  async function paintRight() {
    clear(right);
    if (vaultSel) {
      await paintVaultFolder();
      return;
    }
    let items;
    if (query) {
      items = flattenBookmarks(await chrome.bookmarks.search(query));
    } else if (selectedId === 'root') {
      items = allItems;
    } else {
      const node = await chrome.bookmarks.get(selectedId);
      items = node && node[0] ? flattenBookmarks([node[0]]) : [];
    }
    right.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el(
          'button',
          {
            class: 'small',
            disabled: items.length === 0,
            onclick: () => openAsTabs(items)
          },
          `Open ${items.length} bookmark${items.length === 1 ? '' : 's'} as tabs`
        ),
        query ? el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Results across all folders') : null
      )
    );
    if (items.length === 0) {
      right.appendChild(el('div', { class: 'empty' }, query ? 'No bookmarks match your search.' : 'This folder is empty.'));
      return;
    }
    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, el('tr', {}, ...['Bookmark', 'Folder', 'Duplicate', ''].map((h) => el('th', {}, h)))));
    const body = el('tbody', {});
    for (const item of items) {
      const key = normalizeUrlForCompare(item.url);
      const dupCount = key ? urlCounts.get(key) || 0 : 0;
      body.appendChild(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              faviconImg(faviconUrl(item.url)),
              el(
                'div',
                {},
                el('div', { style: { fontWeight: 600 } }, item.title || item.url),
                el('div', { class: 'muted', style: { fontSize: '11px' } }, item.url)
              )
            )
          ),
          el('td', { class: 'muted' }, folderNameOf(item)),
          el('td', {}, dupCount > 1 ? el('span', { class: 'badge warn' }, `${dupCount}×`) : el('span', { class: 'muted' }, '—')),
          el(
            'td',
            { class: 'actions' },
            el('button', { class: 'small', onclick: () => chrome.tabs.create({ url: item.url, active: true }) }, 'Open'),
            ' ',
            el('button', { class: 'small ghost', onclick: () => onRename(item) }, 'Rename'),
            ' ',
            el('button', { class: 'small ghost', onclick: () => onEditUrl(item) }, 'Edit URL'),
            ' ',
            el(
              'button',
              {
                class: 'small danger',
                onclick: async () => {
                  const ok = await confirmModal({
                    title: 'Delete bookmark?',
                    body: `“${item.title || item.url}” will be deleted from Chrome bookmarks. Open tabs are not affected.`,
                    confirmLabel: 'Delete bookmark'
                  });
                  if (!ok) return;
                  await chrome.bookmarks.remove(item.id);
                  toast('Bookmark deleted.', 'ok');
                  refresh();
                }
              },
              'Delete'
            )
          )
        )
      );
    }
    table.appendChild(body);
    right.appendChild(table);
  }

  async function paintVaultFolder() {
    const c = (await collections.list()).find((x) => x.id === vaultSel);
    if (!c) {
      vaultSel = null;
      await paintRight();
      return;
    }
    right.appendChild(
      el(
        'div',
        { class: 'detail-head' },
        el(
          'div',
          { style: { flex: 1 } },
          el('h2', {}, c.name),
          el('div', { class: 'muted' }, `${c.tabs.length} bookmarks · vault-only folder (never written to Chrome)`)
        ),
        el(
          'div',
          { class: 'toolbar', style: { margin: 0 } },
          el(
            'button',
            {
              class: 'small primary',
              disabled: c.tabs.length === 0,
              onclick: async () => {
                const urls = c.tabs.map((t) => t.url).filter((u) => /^https?:\/\//i.test(u || ''));
                const n = await openManyWithoutHistory(urls);
                toast(`Opened ${n} tabs — nothing was written to browser history.`, 'ok');
              }
            },
            'Open all (no history)'
          ),
          el('button', { class: 'small', onclick: () => onAddOpenTabs(c) }, '＋ Add open tabs…'),
          el('button', { class: 'small ghost', onclick: () => onRenameVaultFolder(c) }, 'Rename'),
          el(
            'button',
            {
              class: 'small danger',
              onclick: async () => {
                const ok = await confirmModal({
                  title: `Delete vault folder “${c.name}”?`,
                  body: 'The folder and its saved bookmarks are removed from TabVault. Chrome bookmarks and open tabs are not affected.',
                  confirmLabel: 'Delete folder'
                });
                if (!ok) return;
                await collections.remove(c.id);
                vaultSel = null;
                toast('Vault folder deleted.', 'ok');
                paintLeft();
                paintRight();
              }
            },
            'Delete folder'
          )
        )
      )
    );
    if (c.tabs.length === 0) {
      right.appendChild(el('div', { class: 'empty' }, 'This vault folder is empty. Add open tabs or save into it from the popup.'));
      return;
    }
    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, el('tr', {}, ...['Bookmark', 'Added', ''].map((h) => el('th', {}, h)))));
    const body = el('tbody', {});
    for (const t of c.tabs) {
      body.appendChild(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              faviconImg(t.favIconUrl),
              el(
                'div',
                {},
                el('div', { style: { fontWeight: 600 } }, t.title || t.url),
                el('div', { class: 'muted', style: { fontSize: '11px' } }, t.url)
              )
            )
          ),
          el('td', { class: 'muted' }, formatDate(t.addedAt)),
          el(
            'td',
            { class: 'actions' },
            el(
              'button',
              {
                class: 'small',
                onclick: () =>
                  openWithoutHistory(t.url, { active: true }).catch((err) => toast(String(err.message || err), 'err'))
              },
              'Open (no history)'
            ),
            ' ',
            el(
              'button',
              {
                class: 'small danger',
                onclick: async () => {
                  const ok = await confirmModal({
                    title: 'Remove from vault folder?',
                    body: 'Only the vault copy is removed; Chrome bookmarks and open tabs are unaffected.',
                    confirmLabel: 'Remove'
                  });
                  if (!ok) return;
                  await collections.removeTab(c.id, t.id);
                  paintVaultFolder();
                }
              },
              'Remove'
            )
          )
        )
      );
    }
    table.appendChild(body);
    right.appendChild(table);
  }

  async function onAddOpenTabs(c) {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:\/\//i.test(t.url || ''));
    if (tabs.length === 0) {
      toast('No http(s) tabs open.', 'err');
      return;
    }
    const res = await collections.addTabs(
      c.id,
      tabs.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
    );
    toast(`Added ${res.added} (${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} skipped).`, 'ok');
    paintVaultFolder();
  }

  async function onRenameVaultFolder(c) {
    const values = await promptModal({
      title: 'Rename vault folder',
      fields: [{ key: 'name', label: 'Folder name', value: c.name }],
      submitLabel: 'Rename'
    });
    if (!values || !values.name.trim()) return;
    await collections.update(c.id, { name: values.name.trim() });
    paintLeft();
    paintVaultFolder();
  }

  function refresh() {
    paintLeft();
    paintRight();
  }
  refresh();

  async function onCreateFolder() {
    const values = await promptModal({
      title: 'New bookmark folder',
      fields: [{ key: 'name', label: 'Folder name', placeholder: 'Reading list' }],
      submitLabel: 'Create'
    });
    if (!values || !values.name.trim()) return;
    const parentId = selectedId === 'root' ? await defaultFolderId() : selectedId;
    await chrome.bookmarks.create({ title: values.name.trim(), parentId });
    toast('Folder created.', 'ok');
    const fresh = await chrome.bookmarks.getTree();
    roots.length = 0;
    roots.push(...((fresh[0] && fresh[0].children) || []));
    refresh();
  }

  async function onSaveOpenTabs() {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:\/\//i.test(t.url || ''));
    if (tabs.length === 0) {
      toast('No http(s) tabs to bookmark.', 'err');
      return;
    }
    const folders = collectFolders(roots);
    const values = await promptModal({
      title: `Save ${tabs.length} open tab(s) as bookmarks`,
      fields: [
        {
          key: 'folder',
          label: 'Destination folder',
          type: 'select',
          options: [
            { value: 'tabvault', label: 'TabVault folder (created if missing)' },
            ...folders.map((f) => ({ value: f.id, label: f.title || 'Folder' }))
          ]
        }
      ],
      submitLabel: 'Save bookmarks'
    });
    if (!values) return;
    const parentId = values.folder === 'tabvault' ? await defaultFolderId() : values.folder;
    let saved = 0;
    for (const tab of tabs) {
      // eslint-disable-next-line no-await-in-loop -- sequential create is fine
      await chrome.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url });
      saved += 1;
    }
    toast(`Saved ${saved} bookmarks (no tabs were closed).`, 'ok');
    refresh();
  }

  async function openAsTabs(items) {
    if (items.length > 10) {
      const ok = await confirmModal({
        title: `Open ${items.length} tabs?`,
        body: 'All of these bookmarks will be opened in background tabs. Nothing is closed or modified.',
        confirmLabel: 'Open them',
        danger: false
      });
      if (!ok) return;
    }
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop -- order-preserving open
      await chrome.tabs.create({ url: item.url, active: false });
    }
    toast(`Opened ${items.length} tabs.`, 'ok');
  }

  async function onExport() {
    const html = netscapeExport(allItems);
    downloadText(`tabvault-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html');
    toast(`Exported ${allItems.length} bookmarks (Netscape format).`, 'ok');
  }

  async function defaultFolderId() {
    const searchResults = await chrome.bookmarks.search(BOOKMARK_FOLDER);
    const folder = searchResults.find((r) => !r.url && r.title === BOOKMARK_FOLDER);
    if (folder) return folder.id;
    const bar = await chrome.bookmarks.get('bookmarks_bar').catch(() => null);
    const parentId = bar && bar[0] ? bar[0].id : (await chrome.bookmarks.getTree())[0].id;
    const created = await chrome.bookmarks.create({ title: BOOKMARK_FOLDER, parentId });
    return created.id;
  }

  async function onRename(item) {
    const values = await promptModal({
      title: 'Rename bookmark',
      fields: [{ key: 'title', label: 'Title', value: item.title }],
      submitLabel: 'Rename'
    });
    if (!values) return;
    await chrome.bookmarks.update(item.id, { title: values.title });
    toast('Renamed.', 'ok');
    refresh();
  }

  async function onEditUrl(item) {
    const values = await promptModal({
      title: 'Edit URL',
      fields: [{ key: 'url', label: 'URL', value: item.url }],
      submitLabel: 'Update'
    });
    if (!values || !/^https?:\/\//i.test(values.url.trim())) {
      if (values) toast('URL must start with http(s)://', 'err');
      return;
    }
    await chrome.bookmarks.update(item.id, { url: values.url.trim() });
    toast('URL updated.', 'ok');
    refresh();
  }
}

function faviconUrl(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  } catch {
    return '';
  }
}

function collectFolders(nodes, out = []) {
  for (const node of nodes || []) {
    if (!node.url && node.children) {
      out.push(node);
      collectFolders(node.children, out);
    }
  }
  return out;
}

/** Netscape Bookmark File Format — importable by every browser. */
function netscapeExport(items) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  for (const item of items) {
    lines.push(`    <DT><A HREF="${esc(item.url)}">${esc(item.title)}</A>`);
  }
  lines.push('</DL><p>');
  return lines.join('\n');
}

function folderNameOf(item) {
  return item.parentId === 'bookmarks_bar' ? 'Bookmarks bar' : item.parentId === 'other' ? 'Other bookmarks' : item.parentId || '';
}

export function flattenBookmarks(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.url) {
      out.push(node);
    } else if (node.children) {
      flattenBookmarks(node.children, out);
    }
  }
  return out;
}

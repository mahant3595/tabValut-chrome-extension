// TabVault dashboard — multi-tab saver.
// Select many open tabs at once and store them into a TabVault collection, a
// vault-only folder, Chrome bookmarks, or a Chrome tab group. Saving is
// strictly non-destructive: no tab is ever closed, removed or reloaded.

import { el, clear, toast, faviconImg, promptModal } from '../ui.js';
import { collections } from '../store.js';

const BOOKMARK_FOLDER = 'TabVault';

export async function render(container, ctx) {
  const [allTabs, groups, list, currentWindow] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    collections.list(),
    chrome.windows.getCurrent()
  ]);
  const groupTitle = new Map(groups.map((g) => [g.id, g.title || 'Untitled group']));
  const selected = new Set();
  let windowScope = 'current'; // 'current' | 'all'
  let searchTerm = '';

  function candidatesNow() {
    const scoped = windowScope === 'current' ? allTabs.filter((t) => t.windowId === currentWindow.id) : allTabs;
    const http = scoped.filter((t) => /^https?:\/\//i.test(t.url || ''));
    if (!searchTerm) return http;
    const q = searchTerm.toLowerCase();
    return http.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q));
  }
  // Default selection: everything in the current window (the common case).
  for (const t of candidatesNow()) selected.add(t.id);

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', {}, 'Save many tabs'),
      el('div', { class: 'muted' }, 'Select multiple open tabs and store them anywhere in the vault. Nothing is closed.')
    ),
    el('button', { class: 'ghost', onclick: () => render(container, ctx) }, '↻ Refresh list')
  );

  const destSel = el('select', {});
  const destinations = [
    { value: 'folder:NEW', label: '＋ New vault folder (vault-only)' },
    { value: 'collection:NEW', label: '＋ New collection' },
    ...list.map((c) => ({ value: `collection:${c.id}`, label: `${c.name} (${c.tabs.length} tabs)${c.vaultFolder ? ' · folder' : ''}` })),
    { value: 'bookmarks', label: 'Chrome bookmark folder (TabVault)' },
    { value: 'group:NEW', label: '＋ New Chrome tab group' },
    ...groups.map((g) => ({ value: `group:${g.id}`, label: `Tab group: ${g.title || 'Untitled'} (${g.color})` }))
  ];
  for (const d of destinations) destSel.appendChild(el('option', { value: d.value }, d.label));

  const countLabel = el('span', { class: 'muted' });
  const saveBtn = el('button', { class: 'primary', onclick: onSave }, 'Save selected');

  const scopeSel = el(
    'select',
    {},
    el('option', { value: 'current' }, 'This window'),
    el('option', { value: 'all' }, 'All windows')
  );
  scopeSel.addEventListener('change', () => {
    windowScope = scopeSel.value;
    selected.clear();
    for (const t of candidatesNow()) selected.add(t.id);
    paint();
  });
  const searchInput = el('input', { type: 'search', placeholder: 'Filter tabs…' });
  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.trim();
    paint();
  });

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    scopeSel,
    searchInput,
    el('button', { class: 'small', onclick: () => setAll(true) }, 'Select all'),
    el('button', { class: 'small', onclick: () => setAll(false) }, 'Select none'),
    countLabel,
    destSel,
    saveBtn
  );

  const listEl = el('div', { class: 'list', style: { maxHeight: '64vh' } });
  clear(container).append(head, toolbar, listEl);

  function updateCount() {
    const total = candidatesNow().length;
    countLabel.textContent = `${selected.size} of ${total} selected`;
    saveBtn.disabled = selected.size === 0;
  }

  function paint() {
    clear(listEl);
    const candidates = candidatesNow();
    if (candidates.length === 0) {
      listEl.appendChild(el('div', { class: 'empty' }, 'No matching http(s) tabs.'));
      updateCount();
      return;
    }
    for (const tab of candidates) {
      const box = el('input', { type: 'checkbox' });
      box.checked = selected.has(tab.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(tab.id);
        else selected.delete(tab.id);
        updateCount();
      });
      listEl.appendChild(
        el(
          'div',
          { class: 'list-item' },
          box,
          faviconImg(tab.favIconUrl),
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'title' }, tab.title || tab.url),
            el('div', { class: 'sub' }, tab.url)
          ),
          tab.groupId > 0 ? el('span', { class: 'badge' }, groupTitle.get(tab.groupId) || 'group') : null,
          tab.discarded ? el('span', { class: 'badge' }, 'unloaded') : null
        )
      );
    }
    updateCount();
  }

  function setAll(on) {
    selected.clear();
    if (on) for (const tab of candidatesNow()) selected.add(tab.id);
    paint();
  }

  async function onSave() {
    const chosen = candidatesNow().filter((t) => selected.has(t.id));
    if (chosen.length === 0) {
      toast('Select at least one tab first.', 'err');
      return;
    }
    const dest = destSel.value;
    try {
      await saveChosen(chosen, dest);
    } catch (err) {
      toast(`Could not save: ${err && err.message ? err.message : err}`, 'err');
    }
  }

  async function saveChosen(chosen, dest) {

    if (dest.startsWith('collection:')) {
      let collectionId = dest.slice('collection:'.length);
      if (collectionId === 'NEW') {
        const values = await promptModal({
          title: `New collection for ${chosen.length} tabs`,
          fields: [{ key: 'name', label: 'Collection name', value: `${chosen.length} tabs` }],
          submitLabel: 'Create & save'
        });
        if (!values) return;
        const created = await collections.create(values.name || 'New collection');
        collectionId = created.id;
      }
      const res = await collections.addTabs(
        collectionId,
        chosen.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
      );
      toast(`Saved ${res.added} tab(s) (${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} skipped). Tabs stay open.`, 'ok');
      render(container, ctx);
      return;
    }

    if (dest === 'folder:NEW') {
      const values = await promptModal({
        title: `New vault folder for ${chosen.length} tabs`,
        fields: [{ key: 'name', label: 'Folder name', value: `${chosen.length} tabs` }],
        submitLabel: 'Create & save'
      });
      if (!values) return;
      const created = await collections.create(values.name || 'Vault folder', '', { vaultFolder: true });
      const res = await collections.addTabs(
        created.id,
        chosen.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
      );
      toast(`Vault folder created with ${res.added} bookmark(s) — never written to Chrome.`, 'ok');
      render(container, ctx);
      return;
    }

    if (dest === 'bookmarks') {
      const parentId = await ensureBookmarkFolder();
      let saved = 0;
      for (const tab of chosen) {
        // eslint-disable-next-line no-await-in-loop -- sequential create
        await chrome.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url });
        saved += 1;
      }
      toast(`Saved ${saved} bookmarks into the “${BOOKMARK_FOLDER}” folder (no tabs were closed).`, 'ok');
      return;
    }

    if (dest.startsWith('group:')) {
      const tabIds = chosen.map((t) => t.id);
      const windowId = chosen[0].windowId;
      if (chosen.some((t) => t.windowId !== windowId)) {
        toast('Tabs from different windows cannot join one group — select tabs from a single window.', 'err');
        return;
      }
      try {
        let groupId = dest.slice('group:'.length);
        if (groupId === 'NEW') {
          groupId = String(await chrome.tabs.group({ tabIds }));
          await chrome.tabGroups.update(Number(groupId), { title: `TabVault ${new Date().toLocaleString()}`, color: 'blue' });
        } else {
          await chrome.tabs.group({ tabIds, groupId: Number(groupId) });
        }
        toast(`Moved ${tabIds.length} tab(s) into the group (nothing was closed).`, 'ok');
        render(container, ctx);
      } catch (err) {
        toast(`Could not group tabs: ${err && err.message ? err.message : err}`, 'err');
      }
      return;
    }
  }

  async function ensureBookmarkFolder() {
    const results = await chrome.bookmarks.search(BOOKMARK_FOLDER);
    const folder = results.find((r) => !r.url && r.title === BOOKMARK_FOLDER);
    if (folder) return folder.id;
    const tree = await chrome.bookmarks.getTree();
    const bar = (tree[0] && tree[0].children && tree[0].children.find((c) => c.id === 'bookmarks_bar')) || tree[0];
    const created = await chrome.bookmarks.create({ title: BOOKMARK_FOLDER, parentId: bar.id });
    return created.id;
  }

  paint();
}

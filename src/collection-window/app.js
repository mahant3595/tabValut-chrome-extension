// TabVault — collection manager window.
// A medium-size popup listing every tab in a collection with checkboxes:
// select one or many, then SAVE them into another collection/folder (copy),
// SEND them (move) to another collection/folder, open them history-free, or
// open the selection as a lazy vault window (only the first tab loads).
// Nothing here ever closes or reloads existing tabs.

import { el, clear, toast, promptModal, faviconImg, formatDate } from '../dashboard/js/ui.js';
import { collections, send } from '../dashboard/js/store.js';
import { openManyWithoutHistory } from '../lib/vault-open.js';

const $ = (id) => document.getElementById(id);

const state = {
  id: null,
  collection: null,
  selected: new Set(), // saved-tab ids
  filter: ''
};

function selectedEntries() {
  if (!state.collection) return [];
  return state.collection.tabs.filter((t) => state.selected.has(t.id));
}

function renderList() {
  const list = $('cw-list');
  clear(list);
  const c = state.collection;
  if (!c) return;
  const q = state.filter.trim().toLowerCase();
  const tabs = c.tabs.filter(
    (t) => !q || (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)
  );
  if (tabs.length === 0) {
    list.appendChild(el('div', { class: 'empty' }, c.tabs.length === 0 ? 'This collection is empty.' : 'No tabs match.'));
    return;
  }
  for (const t of tabs) {
    const box = el('input', { type: 'checkbox' });
    box.checked = state.selected.has(t.id);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(t.id);
      else state.selected.delete(t.id);
      updateCount();
    });
    list.appendChild(
      el(
        'div',
        { class: 'cw-row' },
        box,
        faviconImg(t.favIconUrl),
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'title' }, t.title || t.url),
          el('div', { class: 'sub' }, `${t.domain || ''} ${t.domain ? '·' : ''} ${t.url}`)
        ),
        el('span', { class: 'muted', style: { fontSize: '11px' } }, formatDate(t.addedAt))
      )
    );
  }
  updateCount();
}

function updateCount() {
  const c = state.collection;
  if (!c) return;
  $('cw-count').textContent = `${state.selected.size} of ${c.tabs.length} selected`;
  const disabled = state.selected.size === 0;
  for (const id of ['cw-save', 'cw-send', 'cw-open', 'cw-vault']) {
    $(id).disabled = disabled;
  }
}

async function pickTarget(excludeId, { newLabel = '＋ New collection' } = {}) {
  const list = await collections.list();
  const others = list.filter((c) => c.id !== excludeId);
  const values = await promptModal({
    title: 'Choose destination',
    fields: [
      {
        key: 'target',
        label: 'Destination',
        type: 'select',
        options: [
          { value: '__new__', label: newLabel },
          ...others.map((c) => ({ value: c.id, label: `${c.vaultFolder ? '🗄' : '📁'} ${c.name} (${c.tabs.length} tabs)` }))
        ]
      }
    ],
    submitLabel: 'Continue'
  });
  if (!values) return null;
  if (values.target === '__new__') {
    const name = await promptModal({
      title: 'New collection name',
      fields: [{ key: 'name', label: 'Name', value: `${state.collection ? state.collection.name : 'Collection'} (copy)` }],
      submitLabel: 'Create'
    });
    if (!name || !name.name.trim()) return null;
    return collections.create(name.name.trim(), '', { vaultFolder: newLabel.includes('folder') });
  }
  return (await collections.list()).find((c) => c.id === values.target) || null;
}

async function copySelected() {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  const target = await pickTarget(state.id, { newLabel: '＋ New collection' });
  if (!target) return;
  const res = await collections.addTabs(
    target.id,
    entries.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, notes: t.notes, tags: t.tags, addedAt: t.addedAt }))
  );
  toast(`Saved ${res.added} tab(s) to “${target.name}” (${res.duplicates} duplicate skipped).`, 'ok');
}

async function sendSelected() {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  const target = await pickTarget(state.id, { newLabel: '＋ New vault folder' });
  if (!target) return;
  const res = await collections.addTabs(
    target.id,
    entries.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, notes: t.notes, tags: t.tags, addedAt: t.addedAt }))
  );
  if (res.added === 0) {
    toast('All selected tabs already exist in the destination — nothing sent.', 'err');
    return;
  }
  for (const t of entries) {
    // eslint-disable-next-line no-await-in-loop -- sequential move
    await collections.removeTab(state.id, t.id);
  }
  state.selected.clear();
  await load();
  toast(`Sent ${res.added} tab(s) to “${target.name}” (${res.duplicates} already there).`, 'ok');
}

async function openSelectedHistoryFree() {
  const entries = selectedEntries();
  const urls = entries.map((t) => t.url).filter((u) => /^https?:\/\//i.test(u || ''));
  if (urls.length === 0) return;
  const opened = await openManyWithoutHistory(urls);
  toast(`Opened ${opened} tabs — nothing was written to browser history.`, 'ok');
}

async function openSelectedVaultWindow() {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  try {
    const res = await send({
      type: 'tv:vaultWindow:open',
      name: state.collection.name,
      urls: entries.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
    });
    toast(`Vault window opened: first tab loaded, ${res.result.lazy} stay unloaded until you click them.`, 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  }
}

async function load() {
  const m = (location.hash || '').match(/^#\/collection\/(.+)$/);
  state.id = m ? m[1] : null;
  state.collection = state.id ? await collections.get(state.id) : null;
  if (!state.collection) {
    $('cw-title').textContent = 'Collection not found';
    return;
  }
  document.title = `${state.collection.name} — TabVault`;
  $('cw-title').textContent = `${state.collection.vaultFolder ? '🗄' : '📁'} ${state.collection.name}`;
  // Drop selections that no longer exist.
  for (const id of [...state.selected]) {
    if (!state.collection.tabs.some((t) => t.id === id)) state.selected.delete(id);
  }
  renderList();
}

function wire() {
  $('cw-search').addEventListener('input', () => {
    state.filter = $('cw-search').value;
    renderList();
  });
  $('cw-all').addEventListener('click', () => {
    if (!state.collection) return;
    for (const t of state.collection.tabs) state.selected.add(t.id);
    renderList();
  });
  $('cw-none').addEventListener('click', () => {
    state.selected.clear();
    renderList();
  });
  $('cw-save').addEventListener('click', () => copySelected().catch((e) => toast(String(e && e.message), 'err')));
  $('cw-send').addEventListener('click', () => sendSelected().catch((e) => toast(String(e && e.message), 'err')));
  $('cw-open').addEventListener('click', () => openSelectedHistoryFree().catch((e) => toast(String(e && e.message), 'err')));
  $('cw-vault').addEventListener('click', () => openSelectedVaultWindow().catch((e) => toast(String(e && e.message), 'err')));
}

async function main() {
  wire();
  await load();
}

main();

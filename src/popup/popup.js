// TabVault — popup logic.
// Saving is strictly non-destructive: saving to a group, bookmark or
// collection never closes or removes the source tab. Unloading is NOT part
// of TabVault — use Chrome's own memory saver or a dedicated unloader
// extension for that.

import { applyAppearance } from '../lib/themes.js';

const $ = (id) => document.getElementById(id);

let currentTab = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function setHint(el, text, cls = '') {
  el.textContent = text;
  el.className = `hint ${cls}`.trim();
}

// ---------------------------------------------------------------- appearance

async function loadAppearance() {
  try {
    const res = await send({ type: 'tv:settings:get' });
    if (res && res.ok) applyAppearance(document, res.settings.appearance);
  } catch {
    /* defaults are fine */
  }
}

// ---------------------------------------------------------------- render

function renderCurrentTab() {
  if (!currentTab) {
    $('tab-title').textContent = 'No active tab';
    return;
  }
  $('tab-title').textContent = currentTab.title || currentTab.url || 'Current tab';
  let host = '';
  try {
    host = new URL(currentTab.url).hostname;
  } catch {
    host = currentTab.url || '';
  }
  const groupBadge = currentTab.groupId > 0 ? ' · grouped' : '';
  $('tab-meta').textContent = `${host}${currentTab.discarded ? ' · unloaded' : ''}${groupBadge}`;
  if (currentTab.favIconUrl) $('tab-favicon').src = currentTab.favIconUrl;
  else $('tab-favicon').removeAttribute('src');
}

// ---------------------------------------------------------------- actions

async function loadCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0] || null;
  renderCurrentTab();
}

async function doGroup() {
  if (!currentTab) return;
  try {
    let groupId = currentTab.groupId;
    if (!(groupId > 0)) {
      groupId = await chrome.tabs.group({ tabIds: [currentTab.id] });
      let name = 'TabVault';
      try {
        name = new URL(currentTab.url).hostname.replace(/^www\./, '');
      } catch {
        /* keep default */
      }
      await chrome.tabGroups.update(groupId, { title: name, color: 'cyan' });
    } else {
      await chrome.tabGroups.update(groupId, { collapsed: false });
    }
    await loadCurrentTab();
  } catch (err) {
    setHint($('tab-reasons'), `Group failed: ${err.message}`, 'err');
  }
}

async function ensureBookmarkFolder() {
  const roots = await chrome.bookmarks.getTree();
  const bar = roots[0].children.find((c) => c.id === 'bookmarks_bar') || roots[0];
  const existing = bar.children ? bar.children.find((c) => c.title === 'TabVault' && !c.url) : null;
  if (existing) return existing.id;
  const folder = await chrome.bookmarks.create({ title: 'TabVault', parentId: bar.id });
  return folder.id;
}

async function doBookmark() {
  if (!currentTab || !currentTab.url) return;
  try {
    const parentId = await ensureBookmarkFolder();
    const bm = await chrome.bookmarks.create({
      parentId,
      title: currentTab.title || currentTab.url,
      url: currentTab.url
    });
    setHint($('tab-reasons'), 'Saved as bookmark (tab stays open).', 'ok');
    return bm;
  } catch (err) {
    setHint($('tab-reasons'), `Bookmark failed: ${err.message}`, 'err');
    return null;
  }
}

async function loadCollectionPicker() {
  const res = await send({ type: 'tv:collections:list' });
  const list = res && res.ok ? res.collections : [];
  const select = $('collection-select');
  select.innerHTML = '';
  const folderOpt = document.createElement('option');
  folderOpt.value = '';
  folderOpt.textContent = '— collection or vault folder —';
  select.appendChild(folderOpt);
  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.vaultFolder ? '🗄' : '📁'} ${c.name} (${c.tabs.length})`;
    select.appendChild(opt);
  }
  return list;
}

async function toggleCollectionPicker() {
  const picker = $('collection-picker');
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }
  await loadCollectionPicker();
  picker.classList.remove('hidden');
}

async function doSaveToCollection() {
  if (!currentTab || !currentTab.url) return;
  const select = $('collection-select');
  let collectionId = select.value;
  if (!collectionId) {
    const name = prompt('New collection or vault folder name:', new URL(currentTab.url).hostname.replace(/^www\./, ''));
    if (!name) return;
    const created = await send({ type: 'tv:collections:create', name });
    if (!created || !created.ok) return;
    collectionId = created.collection.id;
  }
  const res = await send({
    type: 'tv:collections:addTabs',
    id: collectionId,
    tabs: [{ url: currentTab.url, title: currentTab.title, favIconUrl: currentTab.favIconUrl }]
  });
  if (res && res.ok) {
    const { added, duplicates } = res.result;
    setHint(
      $('tab-reasons'),
      duplicates > 0 ? `Saved (${added} new, ${duplicates} duplicate skipped).` : 'Saved to collection (tab stays open).',
      'ok'
    );
  }
  $('collection-picker').classList.add('hidden');
}

// ---------------------------------------------------------------- wire up

function wire() {
  $('open-dashboard').addEventListener('click', () => send({ type: 'tv:openDashboard' }));
  $('btn-group').addEventListener('click', doGroup);
  $('btn-bookmark').addEventListener('click', doBookmark);
  $('btn-collection').addEventListener('click', toggleCollectionPicker);
  $('collection-save').addEventListener('click', doSaveToCollection);
  $('collection-new').addEventListener('click', async () => {
    const name = prompt('New collection name:', 'New collection');
    if (!name) return;
    const created = await send({ type: 'tv:collections:create', name });
    if (created && created.ok) {
      await loadCollectionPicker();
      $('collection-select').value = created.collection.id;
    }
  });
  $('btn-save-many').addEventListener('click', () => send({ type: 'tv:openDashboard', route: 'save-tabs' }));
  $('btn-vault').addEventListener('click', () => send({ type: 'tv:openDashboard', route: 'vault' }));
}

async function main() {
  wire();
  await loadAppearance();
  await loadCurrentTab();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      applyAppearance(document, changes.settings.newValue.appearance);
    }
  });
}

main();

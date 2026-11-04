// TabVault dashboard — home view: quick stats and collection cards.

import { el, clear, logoCellNode, fmtCount, formatDate } from '../ui.js';
import { collections } from '../store.js';
import { scanDuplicates } from './duplicates.js';

export async function render(container, ctx, params = {}) {
  const [tabs, list, dupes] = await Promise.all([
    chrome.tabs.query({}),
    collections.list(),
    scanDuplicates()
  ]);
  const loaded = tabs.filter((t) => !t.discarded).length;
  const discarded = tabs.length - loaded;
  const grouped = tabs.filter((t) => t.groupId > 0).length;
  const savedTabs = list.reduce((sum, c) => sum + c.tabs.length, 0);

  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', {}, 'Dashboard'),
    el(
      'div',
      { class: 'toolbar', style: { margin: 0 } },
      el('button', { class: 'ghost', onclick: () => ctx.navigate('duplicates') }, `Scan duplicates (${dupes.length})`),
      el('button', { class: 'ghost', onclick: () => ctx.navigate('appearance') }, 'Appearance Studio'),
      el('button', { class: 'primary', onclick: () => ctx.navigate('collections', { create: true }) }, '＋ New collection')
    )
  );

  const stats = el(
    'div',
    { class: 'grid stats' },
    statCard(tabs.length, 'open tabs'),
    statCard(loaded, 'loaded'),
    statCard(discarded, 'unloaded (memory saved)'),
    statCard(grouped, 'in tab groups'),
    statCard(list.length, 'collections'),
    statCard(savedTabs, 'saved tabs'),
    statCard(dupes.length, 'duplicate clusters')
  );

  const cards = el('div', { class: 'grid cards' });
  if (list.length === 0) {
    cards.appendChild(
      el(
        'div',
        { class: 'empty' },
        'No collections yet. Save tabs from the popup, or create one here. Saving never closes tabs.'
      )
    );
  }
  for (const c of list) {
    const card = el(
      'div',
      { class: 'card', onclick: () => ctx.navigate('collections', { collectionId: c.id }) },
      el('div', { class: 'row' }, await logoCellNode(c, 36), el('h3', {}, c.name)),
      el('div', { class: 'muted' }, `${c.tabs.length} tabs · updated ${formatDate(c.updatedAt)}`),
      c.description ? el('div', { class: 'muted' }, c.description.slice(0, 120)) : null
    );
    cards.appendChild(card);
  }

  clear(container).append(head, stats, el('div', { class: 'section-title' }, 'Collections'), cards);
}

function statCard(value, label) {
  return el('div', { class: 'panel stat-card' }, el('div', { class: 'value' }, fmtCount(value)), el('div', { class: 'label' }, label));
}

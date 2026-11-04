// TabVault dashboard — duplicate finder.
// Scans open tabs, tab groups, Chrome bookmarks and the TabVault library,
// clustering items whose URLs are equal after normalization (tracking params,
// fragments, default ports, trailing slashes and case are ignored).
//
// NOTE: TabVault never closes tabs. Duplicate *bookmarks* can be deleted with
// confirmation; for tabs the finder only reports and offers navigation.

import { el, clear, toast, confirmModal, faviconImg } from '../ui.js';
import { findDuplicateClusters, normalizeUrlForCompare } from '../../../lib/urls.js';
import { collections } from '../store.js';

// ---------------------------------------------------------------- per-collection check

async function collectionCheckPanel() {
  const list = await collections.list();
  const panel = el('div', { class: 'panel', style: { marginBottom: '16px' } });
  if (list.length === 0) {
    panel.appendChild(el('div', { class: 'muted' }, 'No collections yet — save some tabs first.'));
    return panel;
  }
  const sel = el(
    'select',
    {},
    ...list.map((c) => el('option', { value: c.id }, `${c.vaultFolder ? '🗄' : '📁'} ${c.name} (${c.tabs.length} tabs)`))
  );
  const results = el('div', {});
  const btn = el('button', { class: 'primary', onclick: () => runCheck() }, 'Check duplicates');
  panel.append(
    el(
      'div',
      { class: 'toolbar', style: { marginBottom: '8px' } },
      el('span', { style: { fontWeight: 700 } }, 'Check a collection'),
      sel,
      btn,
      el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Looks only inside the selected collection; nothing outside the vault is touched.')
    ),
    results
  );

  async function runCheck() {
    const collection = (await collections.list()).find((c) => c.id === sel.value);
    clear(results);
    if (!collection) return;
    const clusters = findDuplicateClusters(collection.tabs);
    if (clusters.length === 0) {
      results.appendChild(el('div', { class: 'muted' }, `No duplicates inside “${collection.name}”.`));
      return;
    }
    const removable = [];
    for (const cluster of clusters) {
      // Keep the first (oldest) copy, offer the rest for removal.
      for (const member of cluster.members.slice(1)) removable.push(member);
      const row = el('div', { class: 'list-item', style: { cursor: 'default' } },
        faviconImg(cluster.members[0].favIconUrl),
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, cluster.members[0].title || cluster.key),
          el('div', { class: 'sub' }, cluster.key)),
        el('span', { class: 'badge warn' }, `${cluster.count} copies`));
      results.appendChild(row);
      for (const member of cluster.members.slice(1)) {
        results.appendChild(
          el('div', { class: 'list-item', style: { cursor: 'default' } },
            el('span', { class: 'badge' }, 'duplicate'),
            el('div', { class: 'grow' }, el('div', { class: 'sub' }, member.title || member.url)),
            el('button', {
              class: 'small danger',
              onclick: async () => {
                await collections.removeTab(collection.id, member.id);
                toast('Duplicate removed from the collection.', 'ok');
                runCheck();
              }
            }, 'Remove'))
        );
      }
    }
    results.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el(
          'button',
          {
            class: 'danger',
            onclick: async () => {
              const ok = await confirmModal({
                title: `Remove ${removable.length} duplicate tab(s)?`,
                body: `Only duplicate SAVED TABS inside “${collection.name}” are removed (one copy is always kept). Open tabs and Chrome bookmarks are not affected.`,
                confirmLabel: `Remove ${removable.length}`
              });
              if (!ok) return;
              for (const member of removable) {
                // eslint-disable-next-line no-await-in-loop -- sequential removal
                await collections.removeTab(collection.id, member.id);
              }
              toast(`Removed ${removable.length} duplicate saved tab(s).`, 'ok');
              runCheck();
            }
          },
          `Remove duplicates (keep one copy)`
        )
      )
    );
  }

  return panel;
}
import { flattenBookmarks } from './bookmarks.js';

export async function scanDuplicates() {
  const [tabs, groups, bookmarkTree, list] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.bookmarks.getTree(),
    collections.list()
  ]);
  const groupTitle = new Map(groups.map((g) => [g.id, g.title || 'Untitled group']));

  const items = [];
  for (const tab of tabs) {
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) continue;
    items.push({
      url: tab.url,
      title: tab.title || tab.url,
      source: tab.groupId > 0 ? 'group' : 'open-tab',
      sourceDetail: tab.groupId > 0 ? groupTitle.get(tab.groupId) : `window ${tab.windowId}`,
      tabId: tab.id,
      discarded: Boolean(tab.discarded)
    });
  }
  for (const bm of flattenBookmarks(bookmarkTree)) {
    if (!bm.url || !/^https?:\/\//i.test(bm.url)) continue;
    items.push({
      url: bm.url,
      title: bm.title || bm.url,
      source: 'bookmark',
      sourceDetail: bm.parentId || '',
      bookmarkId: bm.id
    });
  }
  for (const collection of list) {
    for (const saved of collection.tabs) {
      if (!saved.url || !/^https?:\/\//i.test(saved.url)) continue;
      items.push({
        url: saved.url,
        title: saved.title || saved.url,
        source: 'library',
        sourceDetail: collection.name,
        collectionId: collection.id,
        tabId: saved.id
      });
    }
  }
  return findDuplicateClusters(items);
}

const SOURCE_LABEL = {
  'open-tab': 'Open tab',
  group: 'Tab group',
  bookmark: 'Bookmark',
  library: 'Library'
};

export async function render(container, ctx) {
  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', {}, 'Duplicates'),
    el('button', { class: 'primary', onclick: () => render(container, ctx) }, '↻ Scan now')
  );
  const body = el('div', {});
  clear(container).append(head, body);

  // Per-collection duplicate check (vault-only; asks before removing).
  body.appendChild(await collectionCheckPanel());
  body.appendChild(el('div', { class: 'section-title' }, 'Browser-wide scan'));
  body.appendChild(el('div', { class: 'muted', style: { marginBottom: '12px' } }, 'Scanning open tabs, groups, bookmarks and the library…'));

  const clusters = await scanDuplicates();

  const totalDupes = clusters.reduce((sum, c) => sum + (c.count - 1), 0);
  body.appendChild(
    el(
      'div',
      { class: 'grid stats' },
      el('div', { class: 'panel stat-card' }, el('div', { class: 'value' }, String(clusters.length)), el('div', { class: 'label' }, 'duplicate clusters')),
      el('div', { class: 'panel stat-card' }, el('div', { class: 'value' }, String(totalDupes)), el('div', { class: 'label' }, 'redundant copies')),
      el('div', { class: 'panel stat-card' }, el('div', { class: 'label' }, 'TabVault never closes tabs automatically. Duplicate bookmarks can be removed with confirmation; duplicate tabs are only listed so you can decide.'))
    )
  );

  if (clusters.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No duplicates found — nice.'));
    return;
  }

  for (const cluster of clusters) {
    const panel = el('div', { class: 'panel', style: { marginBottom: '12px' } });
    const first = cluster.members[0];
    panel.appendChild(
      el(
        'div',
        { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '8px' } },
        faviconImg(first.url),
        el(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { fontWeight: 700 } }, first.title || cluster.key),
          el('div', { class: 'muted', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' } }, cluster.key)
        ),
        el('span', { class: 'badge warn' }, `${cluster.count} copies`)
      )
    );
    const listEl = el('div', { class: 'list' });
    for (const member of cluster.members) {
      listEl.appendChild(
        el(
          'div',
          { class: 'list-item' },
          el('span', { class: 'badge' }, SOURCE_LABEL[member.source] || member.source),
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'title' }, member.title),
            el('div', { class: 'sub' }, member.sourceDetail || '')
          ),
          member.source === 'bookmark'
            ? el(
                'button',
                {
                  class: 'small danger',
                  onclick: async () => {
                    const ok = await confirmModal({
                      title: 'Delete duplicate bookmark?',
                      body: 'Only this bookmark is removed. Open tabs are not affected.',
                      confirmLabel: 'Delete bookmark'
                    });
                    if (!ok) return;
                    await chrome.bookmarks.remove(member.bookmarkId);
                    toast('Bookmark removed.', 'ok');
                    render(container, ctx);
                  }
                },
                'Remove bookmark'
              )
            : member.source === 'library'
              ? el(
                  'button',
                  {
                    class: 'small',
                    onclick: () => ctx.navigate('collections', { collectionId: member.collectionId })
                  },
                  'Open collection'
                )
              : el(
                  'button',
                  {
                    class: 'small',
                    onclick: () => chrome.tabs.update(member.tabId, { active: true }).catch(() => toast('Tab is gone.', 'err'))
                  },
                  'Focus tab'
                )
        )
      );
    }
    panel.appendChild(listEl);
    body.appendChild(panel);
  }
}

export { normalizeUrlForCompare };

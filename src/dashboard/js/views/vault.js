// TabVault dashboard — Vault Browser launcher.
// Pick a Chrome tab group or a saved collection/folder and open it in a
// dedicated browser-window-like shell (src/vault-browser) where its tabs can
// be viewed and opened WITHOUT writing to browser history.

import { el, clear, toast } from '../ui.js';
import { collections, send } from '../store.js';

export async function render(container, ctx) {
  const [groups, allTabs, list] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    collections.list()
  ]);

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', {}, 'Vault Browser'),
      el(
        'div',
        { class: 'muted' },
        'Open a group or collection inside the vault and browse its tabs like a window — without saving browser history.'
      )
    ),
    el('button', { class: 'ghost', onclick: () => render(container, ctx) }, '↻ Refresh')
  );
  const body = el('div', {});
  clear(container).append(head, body);

  // ---------------------------------------------------- Chrome tab groups
  body.appendChild(el('div', { class: 'section-title' }, 'Chrome tab groups'));
  if (groups.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No tab groups right now. Group tabs from the popup or the Tab Groups view.'));
  }
  for (const group of groups) {
    const tabs = allTabs.filter((t) => t.groupId === group.id);
    body.appendChild(
      el(
        'div',
        { class: 'panel', style: { marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '12px' } },
        el(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { fontWeight: 700 } }, group.title || 'Untitled group'),
          el(
            'div',
            { class: 'muted', style: { fontSize: '12px' } },
            `${tabs.length} tabs · ${tabs.filter((t) => t.discarded).length} unloaded · ${group.collapsed ? 'collapsed' : 'expanded'}`
          )
        ),
        el(
          'button',
          {
            class: 'small primary',
            onclick: async () => {
              try {
                const res = await send({
                  type: 'tv:vaultWindow:open',
                  name: group.title || 'Tab group',
                  urls: tabs.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
                });
                toast(
                  `Vault window opened: first tab loaded, ${res.result.lazy} tab(s) unloaded until you enter them. No tab group is created, so Chrome saves nothing.`,
                  'ok'
                );
              } catch (err) {
                toast(String(err.message || err), 'err');
              }
            }
          },
          'Open in Vault'
        )
      )
    );
  }

  // ---------------------------------------------------- collections / folders
  body.appendChild(el('div', { class: 'section-title' }, 'Saved collections & vault folders'));
  if (list.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'Nothing saved yet — use the popup’s “Save…” or “Save many tabs”.'));
  }
  const grid = el('div', { class: 'grid cards' });
  for (const c of list) {
    grid.appendChild(
      el(
        'div',
        { class: 'panel card' },
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          el('span', {}, c.vaultFolder ? '🗄' : '🗂'),
          el('h3', { style: { margin: 0, fontSize: '15px' } }, c.name)),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          `${c.tabs.length} tabs${c.vaultFolder ? ' · vault folder' : ''}${c.sourceGroupId ? ' · from a tab group' : ''}`),
        el(
          'div',
          { class: 'toolbar', style: { margin: 0 } },
          el(
            'button',
            {
              class: 'small primary',
              disabled: c.tabs.length === 0,
              onclick: async () => {
                try {
                  const res = await send({
                    type: 'tv:vaultWindow:open',
                    name: c.name,
                    urls: c.tabs.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
                  });
                  toast(
                    `Vault window opened: first tab loaded, ${res.result.lazy} tab(s) will load only when you enter them. No tab group is created, so Chrome saves nothing.`,
                    'ok'
                  );
                } catch (err) {
                  toast(String(err.message || err), 'err');
                }
              }
            },
            'Open in Vault'
          ),
          el(
            'button',
            {
              class: 'small ghost',
              disabled: c.tabs.length === 0,
              title: 'Embedded preview window (many sites refuse embedding)',
              onclick: () => openPreviewWindow(`#/collection/${c.id}`)
            },
            'Preview (frame)'
          )
        )
      )
    );
  }
  body.appendChild(grid);

  body.appendChild(
    el(
      'div',
      { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
      '“Open in Vault” opens a real browser window: only the FIRST tab loads — every other tab is created unloaded and loads the moment you click it. It deliberately creates NO Chrome tab group, because Chrome can save any group natively (synced to your Google account) and no extension can undo that. “Preview (frame)” embeds pages inside TabVault; many sites (chatgpt.com, google, …) refuse embedding and show an error — use Open in Vault for those.'
    )
  );

  function openPreviewWindow(hash) {
    const url = chrome.runtime.getURL('src/vault-browser/index.html') + hash;
    chrome.windows.create({ url, type: 'popup', width: 1280, height: 860 });
  }
}

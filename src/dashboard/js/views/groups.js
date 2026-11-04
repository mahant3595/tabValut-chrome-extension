// TabVault dashboard — native Chrome tab group management.
// Group colors/titles/collapse state are Chrome-native. Custom logos are a
// TabVault-library concept: saving a group stores it as a TabVault
// collection, where a logo and wallpaper can be assigned.

import { el, clear, toast, confirmModal, promptModal, faviconImg, formatDate, downloadText } from '../ui.js';
import { collections } from '../store.js';

const GROUP_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'
];

export async function render(container, ctx) {
  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', {}, 'Tab Groups'),
    el(
      'div',
      { class: 'toolbar', style: { margin: 0 } },
      el('button', { class: 'ghost', onclick: () => render(container, ctx) }, '↻ Refresh'),
      el('button', { class: 'primary', onclick: onGroupCurrentWindow }, '＋ Group this window’s tabs')
    )
  );
  const body = el('div', {});
  clear(container).append(head, body);

  const groups = await chrome.tabGroups.query({});
  const allTabs = await chrome.tabs.query({});

  if (groups.length === 0) {
    body.appendChild(
      el(
        'div',
        { class: 'empty' },
        'No tab groups in this window right now. Use the popup’s “Group” button, or group this window’s tabs.'
      )
    );
    return;
  }

  for (const group of groups) {
    const tabs = allTabs.filter((t) => t.groupId === group.id);
    body.appendChild(await groupPanel(group, tabs, ctx));
  }

  async function onGroupCurrentWindow() {
    const win = await chrome.windows.getCurrent();
    const tabs = (await chrome.tabs.query({ windowId: win.id })).filter((t) => !t.pinned);
    if (tabs.length === 0) {
      toast('No tabs to group.', 'err');
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
    await chrome.tabGroups.update(groupId, { title: 'TabVault group', color: 'purple' });
    toast(`Grouped ${tabs.length} tabs (none were closed).`, 'ok');
    render(container, ctx);
  }
}

async function groupPanel(group, tabs, ctx) {
  const colorSel = el(
    'select',
    {},
    ...GROUP_COLORS.map((c) => el('option', { value: c }, c))
  );
  colorSel.value = group.color;
  colorSel.addEventListener('change', async () => {
    await chrome.tabGroups.update(group.id, { color: colorSel.value });
    toast('Group color updated.', 'ok');
  });

  const panel = el(
    'div',
    { class: 'panel', style: { marginBottom: '14px' } },
    el(
      'div',
      { class: 'detail-head' },
      el(
        'span',
        {
          style: {
            width: '16px',
            height: '16px',
            borderRadius: '5px',
            background: `var(--group-${group.color}, #777)`,
            border: '1px solid rgb(var(--border))'
          }
        },
        ''
      ),
      el(
        'div',
        { style: { flex: 1 } },
        el('h2', {}, group.title || 'Untitled group'),
        el('div', { class: 'muted' }, `${tabs.length} tabs · ${group.collapsed ? 'collapsed' : 'expanded'}`)
      ),
      el(
        'div',
        { class: 'toolbar', style: { margin: 0 } },
        colorSel,
        el('button', { class: 'small ghost', onclick: onRename }, 'Rename'),
        el('button', { class: 'small', onclick: onToggleCollapse }, group.collapsed ? 'Expand' : 'Collapse'),
        el('button', { class: 'small ghost', onclick: onUngroup }, 'Ungroup'),
        el('button', { class: 'small primary', onclick: onSaveToLibrary }, 'Save to library')
      )
    )
  );

  const list = el('table', { class: 'data' });
  const body = el('tbody', {});
  for (const tab of tabs) {
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
            faviconImg(tab.favIconUrl),
            el(
              'div',
              {},
              el('div', { style: { fontWeight: 600 } }, tab.title || tab.url),
              el('div', { class: 'muted', style: { fontSize: '11px' } }, tab.url || '')
            ),
            tab.discarded ? el('span', { class: 'badge' }, 'unloaded') : null
          )
        ),
        el(
          'td',
          { class: 'actions' },
          el(
            'button',
            {
              class: 'small',
              onclick: async () => {
                await chrome.tabs.update(tab.id, { active: true });
              }
            },
            'Focus'
          ),
          ' ',
          el(
            'button',
            {
              class: 'small ghost',
              title: 'Remove this tab from the group (it stays open)',
              onclick: async () => {
                await chrome.tabs.ungroup(tab.id);
                toast('Tab removed from group (still open).', 'ok');
                renderRefresh();
              }
            },
            'Ungroup tab'
          ),
          ' ',
          el(
            'button',
            {
              class: 'small ghost',
              title: 'Reorder within the window',
              onclick: async () => {
                await chrome.tabs.move(tab.id, { index: Math.max(0, tab.index - 1) });
                renderRefresh();
              }
            },
            '◀'
          ),
          el(
            'button',
            {
              class: 'small ghost',
              title: 'Reorder within the window',
              onclick: async () => {
                await chrome.tabs.move(tab.id, { index: tab.index + 1 });
                renderRefresh();
              }
            },
            '▶'
          ),
          ' ',
          el('button', { class: 'small ghost', onclick: () => onMoveToGroup(tab) }, 'Move to group…')
        )
      )
    );
  }
  list.appendChild(body);
  panel.appendChild(list);

  function renderRefresh() {
    const btn = document.querySelector('#nav button.active');
    if (btn) btn.click();
  }

  async function onRename() {
    const values = await promptModal({
      title: 'Rename group',
      fields: [{ key: 'title', label: 'Group title', value: group.title || '' }],
      submitLabel: 'Rename'
    });
    if (!values) return;
    await chrome.tabGroups.update(group.id, { title: values.title });
    toast('Group renamed.', 'ok');
    renderRefresh();
  }

  async function onToggleCollapse() {
    await chrome.tabGroups.update(group.id, { collapsed: !group.collapsed });
    renderRefresh();
  }

  async function onUngroup() {
    const ok = await confirmModal({
      title: 'Ungroup this group?',
      body: `The ${tabs.length} tabs stay open — they are only removed from the group.`,
      confirmLabel: 'Ungroup',
      danger: false
    });
    if (!ok) return;
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
    toast('Ungrouped — no tabs were closed.', 'ok');
    renderRefresh();
  }

  async function onMoveToGroup(tab) {
    const allGroups = await chrome.tabGroups.query({});
    const others = allGroups.filter((g) => g.id !== group.id);
    const fields =
      others.length > 0
        ? [
            {
              key: 'target',
              label: 'Destination group',
              type: 'select',
              options: others.map((g) => ({ value: String(g.id), label: g.title || 'Untitled group' }))
            }
          ]
        : [{ key: 'newName', label: 'No other groups yet — name a new one', value: 'New group' }];
    const values = await promptModal({ title: 'Move tab to another group', fields, submitLabel: 'Move' });
    if (!values) return;
    if (values.target) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: Number(values.target) });
    } else if (values.newName && values.newName.trim()) {
      const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(newGroupId, { title: values.newName.trim() });
    } else {
      return;
    }
    toast('Tab moved between groups (it stayed open).', 'ok');
    renderRefresh();
  }

  async function onSaveToLibrary() {
    const name = group.title || 'Tab group';
    const created = await collections.create(name, `Saved from Chrome tab group on ${formatDate(Date.now())}`, {
      sourceGroupId: group.id
    });
    if (tabs.length) {
      await collections.addTabs(
        created.id,
        tabs.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
      );
    }
    toast(`Saved group “${name}” to the TabVault library.`, 'ok');
    renderRefresh();
  }

  return panel;
}

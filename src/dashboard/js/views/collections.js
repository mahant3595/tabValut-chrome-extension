// TabVault dashboard — Collections (the independent TabVault library).
// Saved collections persist in chrome.storage.local; logos/wallpapers are
// blobs in IndexedDB referenced by key. Deleting a collection or a saved tab
// never touches live tabs or Chrome bookmarks.

import {
  el,
  clear,
  toast,
  confirmModal,
  promptModal,
  downloadText,
  pickImageFile,
  pickImportFile,
  logoCellNode,
  faviconImg,
  formatDate,
  sliderRow,
  formatBytes,
  BUILTIN_ICONS
} from '../ui.js';
import { collections, restoreCollection, send } from '../store.js';
import { serializeCollections, parseImport } from '../../../lib/export.js';
import { validateImageFile, ACCEPT_ATTRIBUTE, normalizeLogoRef, LOGO_SHAPES, NO_IMAGE_LIMIT } from '../../../lib/images.js';
import { putBlob, deleteBlob, mediaKey, blobUrl } from '../../../lib/idb.js';
import { domainOf } from '../../../lib/urls.js';
import { PRESET_WALLPAPERS } from '../../../lib/themes.js';

const SORTS = {
  'added-desc': (a, b) => b.addedAt - a.addedAt,
  'added-asc': (a, b) => a.addedAt - b.addedAt,
  'title-asc': (a, b) => a.title.localeCompare(b.title),
  'title-desc': (a, b) => b.title.localeCompare(a.title),
  'domain-asc': (a, b) => (a.domain || '').localeCompare(b.domain || '')
};

const ui = { query: '', sort: 'added-desc' };

export async function render(container, ctx, params = {}) {
  let list = await collections.list();
  let selectedId = params.collectionId || (list[0] && list[0].id) || null;

  if (params.create) {
    const created = await collections.create('New collection');
    list = await collections.list();
    selectedId = created.id;
    ctx.navigate('collections', { collectionId: created.id });
    return;
  }

  const wrap = el('div', {});
  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', {}, 'Collections'),
    el(
      'div',
      { class: 'toolbar', style: { margin: 0 } },
      el('button', { class: 'primary', onclick: onCreate }, '＋ New collection'),
      el('button', { onclick: onImport }, 'Import…'),
      el('button', { onclick: onExportAll, disabled: list.length === 0 }, 'Export all')
    )
  );

  const split = el('div', { class: 'split' });
  const left = el('div', { class: 'panel' });
  const right = el('div', { class: 'panel' });
  split.append(left, right);
  clear(container).append(head, split);

  function paintList() {
    clear(left);
    const search = el('input', { type: 'search', placeholder: 'Filter collections…', style: { width: '100%', marginBottom: '8px' } });
    search.addEventListener('input', () => {
      ui.query = search.value.trim().toLowerCase();
      paintItems();
    });
    left.append(search);
    const items = el('div', { class: 'list' });
    left.appendChild(items);
    paintItems();

    function paintItems() {
      clear(items);
      const filtered = list.filter((c) => !ui.query || c.name.toLowerCase().includes(ui.query));
      if (filtered.length === 0) {
        items.appendChild(el('div', { class: 'muted' }, 'No collections match.'));
        return;
      }
      for (const c of filtered) {
        items.appendChild(
          el(
            'div',
            {
              class: `list-item ${c.id === selectedId ? 'selected' : ''}`,
              onclick: () => {
                selectedId = c.id;
                paintItems();
                paintDetail();
              }
            },
            el('span', {}, c.logo && c.logo.kind === 'icon' ? c.logo.icon : '🗂'),
            el(
              'div',
              { class: 'grow' },
              el('div', { class: 'title' }, c.name),
              el('div', { class: 'sub' }, `${c.tabs.length} tabs`)
            )
          )
        );
      }
    }
  }

  async function paintDetail() {
    clear(right);
    const collection = (await collections.list()).find((c) => c.id === selectedId);
    if (!collection) {
      right.appendChild(el('div', { class: 'empty' }, 'Select or create a collection.'));
      return;
    }
    right.appendChild(await detailNode(collection, ctx, () => paintDetail(), () => paintList()));
    list = await collections.list();
  }

  paintList();
  await paintDetail();

  async function onCreate() {
    const values = await promptModal({
      title: 'New collection',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'Research, Design inspo…' },
        { key: 'description', label: 'Description (optional)', type: 'textarea' }
      ],
      submitLabel: 'Create'
    });
    if (!values) return;
    const created = await collections.create(values.name || 'Untitled collection', values.description || '');
    list = await collections.list();
    selectedId = created.id;
    paintList();
    await paintDetail();
    toast(`Created “${created.name}”.`, 'ok');
  }

  async function onExportAll() {
    downloadText(`tabvault-backup-${new Date().toISOString().slice(0, 10)}.json`, serializeCollections(list));
    toast('Backup exported.', 'ok');
  }

  async function onImport() {
    const text = await pickImportFile();
    if (!text) return;
    const parsed = parseImport(text);
    if (!parsed.ok) {
      toast(parsed.errors.join(' '), 'err');
      return;
    }
    const res = await collections.import(parsed.collections);
    list = await collections.list();
    paintList();
    toast(`Imported ${res.imported} collection(s).`, 'ok');
  }
}

// ---------------------------------------------------- per-collection wallpaper
// The collection wallpaper is stored exactly like the global one (see
// lib/themes.js) but was previously write-only — the editor saved it and
// nothing displayed it. This renders it behind the detail pane's content:
// image wallpapers are read from IndexedDB as an object URL, revoked on
// every repaint; brightness/overlay/fit/position all mirror applyAppearance.
let detailWallpaperUrl = null;

async function wallpaperLayerNode(wp) {
  if (detailWallpaperUrl) {
    URL.revokeObjectURL(detailWallpaperUrl);
    detailWallpaperUrl = null;
  }
  if (!wp || typeof wp !== 'object') return null;
  let css = null;
  let size = null;
  if (wp.kind === 'preset') {
    const preset = PRESET_WALLPAPERS.find((p) => p.id === wp.value);
    if (preset) {
      css = preset.css;
      size = preset.cssSize || null;
    }
  } else if (wp.kind === 'solid') {
    css = wp.value || '#0b1020';
  } else if (wp.kind === 'gradient') {
    css = wp.value || 'linear-gradient(135deg,#0b1020,#1b2a4a)';
  } else if (wp.kind === 'image') {
    detailWallpaperUrl = await blobUrl(wp.value);
    if (!detailWallpaperUrl) return null; // blob deleted
    css = `url("${detailWallpaperUrl}")`;
  }
  if (!css) return null;

  const layer = el('div', { class: 'detail-wallpaper' });
  const bg = el('div', { class: 'layer' });
  bg.style.backgroundImage = css;
  bg.style.backgroundSize = size || (wp.kind === 'image' ? wp.fit || 'cover' : 'cover');
  bg.style.backgroundPosition = wp.position || 'center';
  bg.style.backgroundRepeat = wp.fit === 'repeat' || wp.kind === 'solid' ? 'repeat' : 'no-repeat';
  if (typeof wp.brightness === 'number' && wp.brightness !== 1) bg.style.filter = `brightness(${wp.brightness})`;
  layer.appendChild(bg);
  if (typeof wp.overlay === 'number' && wp.overlay > 0) {
    layer.appendChild(el('div', { class: 'shade', style: { background: `rgba(0,0,0,${wp.overlay})` } }));
  }
  return layer;
}

// ---------------------------------------------------------------- detail

async function detailNode(collection, ctx, reloadDetail, reloadList) {
  const c = collection;
  const wrap = el('div', { class: 'detail-wallpaper-host' });
  const wallLayer = await wallpaperLayerNode(c.wallpaper);
  if (wallLayer) wrap.appendChild(wallLayer);

  // Header with logo.
  const head = el(
    'div',
    { class: 'detail-head' },
    await logoCellNode(c, 48),
    el(
      'div',
      { style: { flex: 1 } },
      el('h2', {}, c.name),
      el(
        'div',
        { class: 'muted' },
        `${c.tabs.length} tabs · created ${formatDate(c.createdAt)} · updated ${formatDate(c.updatedAt)}`
      ),
      c.description ? el('div', { class: 'muted' }, c.description) : null
    ),
    el(
      'div',
      { class: 'toolbar', style: { margin: 0 } },
      el('button', { class: 'ghost small', onclick: () => editMeta(c, ctx, reloadDetail) }, 'Edit'),
      el('button', { class: 'danger small', onclick: () => deleteCollection(c, ctx, reloadList) }, 'Delete')
    )
  );
  wrap.appendChild(head);

  // Restore row — always opens NEW tabs, never replaces existing ones.
  // The lazy options load ONLY the first tab; the rest are unloaded
  // placeholders that load when the user clicks them.
  wrap.appendChild(
    el(
      'div',
      { class: 'toolbar' },
      el(
        'button',
        {
          class: 'primary',
          title: 'Medium window with all tabs, checkboxes to select one or many, Save / Send to another collection',
          disabled: c.tabs.length === 0,
          onclick: () => openManagerWindow(c)
        },
        'Open (manager window)'
      ),
      el(
        'button',
        {
          disabled: c.tabs.length === 0,
          title: 'Opens a vault window: first tab loads, the rest stay unloaded until you click them. Creates NO Chrome tab group, so nothing is saved to your Google account.',
          onclick: () => openLazyGroup(c)
        },
        'Open in Vault (lazy)'
      ),
      el(
        'button',
        {
          class: 'ghost',
          disabled: c.tabs.length === 0,
          title: 'Plain restore: opens every tab and loads all of them',
          onclick: async () => {
            const res = await restoreCollection(c);
            toast(`Opened ${res.created} tabs (all loaded).`, 'ok');
          }
        },
        'Open all (loads everything)'
      ),
      el(
        'button',
        { class: 'ghost', onclick: () => downloadText(`${slug(c.name)}.json`, serializeCollections([c])) },
        'Export'
      )
    )
  );

  // Logo editor.
  wrap.appendChild(el('div', { class: 'section-title' }, 'Custom logo'));
  wrap.appendChild(await logoEditor(c, ctx, reloadDetail));

  // Wallpaper editor.
  wrap.appendChild(el('div', { class: 'section-title' }, 'Collection wallpaper'));
  wrap.appendChild(await wallpaperEditor(c, ctx, reloadDetail));

  // Saved tabs.
  wrap.appendChild(el('div', { class: 'section-title' }, 'Saved tabs'));
  const sortSel = el(
    'select',
    {},
    ...Object.keys(SORTS).map((key) => {
      const opt = el('option', { value: key }, key.replace('-', ' '));
      return opt;
    })
  );
  sortSel.value = ui.sort;
  const tabSearch = el('input', { type: 'search', placeholder: 'Search saved tabs…', style: { flex: 1 } });
  sortSel.addEventListener('change', () => {
    ui.sort = sortSel.value;
    paintTabs();
  });
  tabSearch.addEventListener('input', paintTabs);
  wrap.appendChild(el('div', { class: 'toolbar' }, tabSearch, sortSel));

  const table = el('div', {});
  wrap.appendChild(table);

  function paintTabs() {
    clear(table);
    let tabs = [...c.tabs];
    const q = tabSearch.value.trim().toLowerCase();
    if (q) {
      tabs = tabs.filter(
        (t) =>
          (t.title || '').toLowerCase().includes(q) ||
          (t.url || '').toLowerCase().includes(q) ||
          (t.notes || '').toLowerCase().includes(q) ||
          (t.tags || []).some((tag) => tag.includes(q))
      );
    }
    tabs.sort(SORTS[ui.sort] || SORTS['added-desc']);
    if (tabs.length === 0) {
      table.appendChild(el('div', { class: 'empty' }, 'No saved tabs here yet.'));
      return;
    }
    const body = el('tbody', {});
    for (const t of tabs) {
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
          el('td', {}, t.domain || domainOf(t.url) || '—'),
          el('td', { class: 'muted' }, formatDate(t.addedAt)),
          el(
            'td',
            {},
            el('div', { class: 'muted', style: { fontSize: '12px' } }, (t.notes || '').slice(0, 80)),
            el('div', { class: 'tags' }, ...(t.tags || []).map((tag) => el('span', { class: 'tag' }, tag)))
          ),
          el(
            'td',
            { class: 'actions' },
            el(
              'button',
              {
                class: 'small',
                title: 'Open in a new tab',
                onclick: () => chrome.tabs.create({ url: t.url, active: false })
              },
              'Open'
            ),
            ' ',
            el('button', { class: 'small ghost', onclick: () => editTab(c, t, ctx, reloadDetail) }, 'Edit'),
            ' ',
            el('button', { class: 'small ghost', onclick: () => onMoveTab(c, t) }, 'Move…'),
            ' ',
            el(
              'button',
              {
                class: 'small danger',
                onclick: async () => {
                  const ok = await confirmModal({
                    title: 'Remove saved tab?',
                    body: `“${t.title || t.url}” will be removed from “${c.name}”. Live tabs and bookmarks are not affected.`,
                    confirmLabel: 'Remove'
                  });
                  if (!ok) return;
                  await collections.removeTab(c.id, t.id);
                  toast('Saved tab removed.', 'ok');
                  reloadDetail();
                }
              },
              'Remove'
            )
          )
        )
      );
    }
    const tableEl = el('table', { class: 'data' });
    tableEl.appendChild(el('thead', {}, el('tr', {}, ...['Tab', 'Domain', 'Saved', 'Notes / tags', ''].map((h) => el('th', {}, h)))));
    tableEl.appendChild(body);
    table.appendChild(tableEl);
  }
  paintTabs();

  async function onMoveTab(c2, t) {
    const others = (await collections.list()).filter((x) => x.id !== c2.id);
    if (others.length === 0) {
      toast('Create another collection first — there is nowhere to move to.', 'err');
      return;
    }
    const values = await promptModal({
      title: `Move “${(t.title || t.url).slice(0, 60)}”`,
      fields: [
        {
          key: 'target',
          label: 'Destination collection',
          type: 'select',
          options: others.map((o) => ({ value: o.id, label: `${o.name} (${o.tabs.length} tabs)` }))
        }
      ],
      submitLabel: 'Move'
    });
    if (!values) return;
    const res = await collections.addTabs(values.target, [
      { url: t.url, title: t.title, favIconUrl: t.favIconUrl, notes: t.notes, tags: t.tags, addedAt: t.addedAt }
    ]);
    if (res.added === 0) {
      toast('That URL already exists in the destination collection.', 'err');
      return;
    }
    await collections.removeTab(c2.id, t.id);
    toast('Saved tab moved — live tabs and bookmarks were not touched.', 'ok');
    reloadDetail();
  }

  return wrap;
}

function openManagerWindow(c) {
  const url = chrome.runtime.getURL('src/collection-window/index.html') + `#/collection/${c.id}`;
  chrome.windows.create({ url, type: 'popup', width: 940, height: 700 });
}

async function openLazyGroup(c) {
  try {
    const res = await send({
      type: 'tv:vaultWindow:open',
      name: c.name,
      urls: c.tabs.map((t) => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
    });
    toast(
      `Opened in a vault window: first tab loaded, ${res.result.lazy} tab(s) stay unloaded until you click them. No tab group is created, so Chrome saves nothing.`,
      'ok'
    );
  } catch (err) {
    toast(String(err.message || err), 'err');
  }
}

async function editMeta(c, ctx, reload) {
  const values = await promptModal({
    title: 'Edit collection',
    fields: [
      { key: 'name', label: 'Name', value: c.name },
      { key: 'description', label: 'Description', type: 'textarea', value: c.description },
      { key: 'tags', label: 'Tags (comma separated)', value: (c.tags || []).join(', ') }
    ]
  });
  if (!values) return;
  await collections.update(c.id, {
    name: values.name,
    description: values.description,
    tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean)
  });
  toast('Collection updated.', 'ok');
  reload();
}

async function deleteCollection(c, ctx, reloadList) {
  const ok = await confirmModal({
    title: `Delete “${c.name}”?`,
    body: `This removes the saved collection and its ${c.tabs.length} saved tabs from TabVault. Open tabs and Chrome bookmarks are NOT affected.`,
    confirmLabel: 'Delete collection'
  });
  if (!ok) return;
  const logoKey = c.logo && c.logo.kind === 'image' ? c.logo.key : null;
  await collections.remove(c.id);
  if (logoKey) deleteBlob(logoKey).catch(() => {});
  toast('Collection deleted.', 'ok');
  reloadList();
  ctx.navigate('collections', {});
}

async function editTab(c, t, ctx, reload) {
  const values = await promptModal({
    title: 'Edit saved tab',
    fields: [
      { key: 'title', label: 'Title', value: t.title },
      { key: 'url', label: 'URL (read-only reference)', value: t.url, type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea', value: t.notes },
      { key: 'tags', label: 'Tags (comma separated)', value: (t.tags || []).join(', ') }
    ]
  });
  if (!values) return;
  await collections.updateTab(c.id, t.id, {
    title: values.title,
    notes: values.notes,
    tags: values.tags.split(',').map((x) => x.trim()).filter(Boolean)
  });
  toast('Saved tab updated.', 'ok');
  reload();
}

// ---------------------------------------------------------------- logo editor

async function logoEditor(c, ctx, reload) {
  const box = el('div', { class: 'panel' });
  const preview = await logoCellNode(c, 44);

  const shapeSel = el(
    'select',
    {},
    ...LOGO_SHAPES.map((s) => el('option', { value: s }, s))
  );
  shapeSel.value = (c.logo && c.logo.shape) || 'rounded';
  shapeSel.addEventListener('change', async () => {
    const logo = normalizeLogoRef({ ...(c.logo || { kind: 'icon', icon: '📁' }), shape: shapeSel.value });
    await collections.update(c.id, { logo });
    reload();
  });

  const iconGrid = el('div', { class: 'swatches' });
  for (const icon of BUILTIN_ICONS) {
    iconGrid.appendChild(
      el(
        'button',
        {
          class: 'small',
          title: `Use ${icon}`,
          onclick: async () => {
            await collections.update(c.id, {
              logo: normalizeLogoRef({ kind: 'icon', icon, shape: shapeSel.value })
            });
            reload();
          }
        },
        icon
      )
    );
  }

  box.append(
    el(
      'div',
      { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '10px' } },
      preview,
      el(
        'div',
        {},
        el('div', { class: 'muted', style: { fontSize: '12px' } }, 'Shown on cards, lists and headers. Chrome’s native group bar does not support custom images.'),
        el('div', { class: 'toolbar', style: { marginTop: '8px', marginBottom: 0 } },
          el('button', { class: 'small', onclick: onUpload }, 'Upload image…'),
          el('button', { class: 'small ghost', onclick: onRemoveImage, disabled: !(c.logo && c.logo.kind === 'image') }, 'Remove image')
        )
      )
    ),
    el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, 'Shape:'), shapeSel),
    el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, 'Built-in icons:'),
    iconGrid
  );

  async function onUpload() {
    const file = await pickImageFile(ACCEPT_ATTRIBUTE);
    if (!file) return;
    const check = await validateImageFile(file);
    if (!check.ok) {
      toast(check.error, 'err');
      return;
    }
    const key = mediaKey('logo');
    await putBlob(key, file);
    const oldKey = c.logo && c.logo.kind === 'image' ? c.logo.key : null;
    await collections.update(c.id, { logo: normalizeLogoRef({ kind: 'image', key, shape: shapeSel.value }) });
    if (oldKey && oldKey !== key) deleteBlob(oldKey).catch(() => {});
    toast('Logo updated.', 'ok');
    reload();
  }

  async function onRemoveImage() {
    await collections.update(c.id, { logo: normalizeLogoRef({ kind: 'icon', icon: '📁', shape: shapeSel.value }) });
    toast('Custom logo removed (fallback icon in use).', 'ok');
    reload();
  }

  return box;
}

// ---------------------------------------------------------------- wallpaper editor

async function wallpaperEditor(c, ctx, reload) {
  const box = el('div', { class: 'panel' });
  const wp = c.wallpaper && typeof c.wallpaper === 'object' ? c.wallpaper : null;

  const kindSel = el(
    'select',
    {},
    el('option', { value: 'none' }, 'none'),
    el('option', { value: 'preset' }, 'built-in preset'),
    el('option', { value: 'solid' }, 'solid color'),
    el('option', { value: 'image' }, 'uploaded image')
  );
  kindSel.value = wp ? wp.kind : 'none';

  const controls = el('div', {});
  box.append(el('div', { class: 'toolbar', style: { marginBottom: '6px' } }, el('span', { class: 'muted' }, 'Wallpaper:'), kindSel), controls);

  function paintControls() {
    clear(controls);
    const kind = kindSel.value;
    if (kind === 'none') {
      controls.appendChild(el('div', { class: 'muted' }, 'No wallpaper — plain background.'));
      return;
    }
    if (kind === 'preset') {
      const grid = el('div', { class: 'preset-grid' });
      for (const preset of PRESET_WALLPAPERS) {
        grid.appendChild(
          el(
            'div',
            {
              class: `preset ${wp && wp.kind === 'preset' && wp.value === preset.id ? 'selected' : ''}`,
              onclick: async () => {
                await collections.update(c.id, {
                  wallpaper: { kind: 'preset', value: preset.id, fit: 'cover', position: 'center', brightness: 1, overlay: 0.25 }
                });
                reload();
              }
            },
            el('div', { class: 'swatch', style: { background: preset.css } }),
            el('div', { class: 'muted', style: { fontSize: '12px' } }, preset.name)
          )
        );
      }
      controls.appendChild(grid);
      return;
    }
    if (kind === 'solid') {
      const color = el('input', { type: 'color', value: wp && wp.kind === 'solid' ? wp.value : '#0b1020' });
      color.addEventListener('change', async () => {
        await collections.update(c.id, {
          wallpaper: { kind: 'solid', value: color.value, fit: 'cover', position: 'center', brightness: 1, overlay: 0 }
        });
        reload();
      });
      controls.appendChild(el('div', { class: 'toolbar' }, color));
      return;
    }
    if (kind === 'image') {
      controls.appendChild(
        el(
          'div',
          { class: 'toolbar' },
          el('button', { class: 'small', onclick: onUploadWallpaper }, 'Upload image…'),
          el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Any size — stored locally in IndexedDB.')
        )
      );
      if (wp && wp.kind === 'image') {
        controls.appendChild(
          sliderRow({
            label: 'Brightness',
            min: 0.2,
            max: 1.5,
            step: 0.05,
            value: wp.brightness ?? 1,
            onInput: debounceSave({ ...wp })
          })
        );
        controls.appendChild(
          sliderRow({
            label: 'Readability overlay',
            min: 0,
            max: 0.9,
            step: 0.05,
            value: wp.overlay ?? 0.25,
            onInput: debounceSave({ ...wp }, 'overlay')
          })
        );
      }
    }
  }

  function debounceSave(nextWp, field = 'brightness') {
    let timer = null;
    return (value) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await collections.update(c.id, { wallpaper: { ...nextWp, [field]: value } });
      }, 250);
    };
  }

  async function onUploadWallpaper() {
    const file = await pickImageFile(ACCEPT_ATTRIBUTE);
    if (!file) return;
    const check = await validateImageFile(file, NO_IMAGE_LIMIT);
    if (!check.ok) {
      toast(check.error, 'err');
      return;
    }
    const key = mediaKey('wallpaper');
    await putBlob(key, file);
    const oldKey = wp && wp.kind === 'image' ? wp.value : null;
    await collections.update(c.id, {
      wallpaper: { kind: 'image', value: key, fit: 'cover', position: 'center', brightness: 0.9, overlay: 0.3 }
    });
    if (oldKey && oldKey !== key) deleteBlob(oldKey).catch(() => {});
    toast(`Wallpaper updated (${formatBytes(file.size)}).`, 'ok');
    reload();
  }

  kindSel.addEventListener('change', async () => {
    const kind = kindSel.value;
    if (kind === 'none') {
      await collections.update(c.id, { wallpaper: null });
      reload();
      return;
    }
    if (kind === 'preset') {
      await collections.update(c.id, {
        wallpaper: { kind: 'preset', value: PRESET_WALLPAPERS[0].id, fit: 'cover', position: 'center', brightness: 1, overlay: 0.25 }
      });
      reload();
      return;
    }
    if (kind === 'solid') {
      await collections.update(c.id, {
        wallpaper: { kind: 'solid', value: '#0b1020', fit: 'cover', position: 'center', brightness: 1, overlay: 0 }
      });
      reload();
      return;
    }
    paintControls(); // image: wait for upload
  });

  paintControls();

  if (wp && wp.kind === 'image') {
    box.appendChild(
      el('div', { class: 'muted', style: { fontSize: '12px' } }, 'Re-upload to replace the current image.')
    );
  }
  return box;
}

function slug(name) {
  return (
    String(name || 'collection')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'collection'
  );
}

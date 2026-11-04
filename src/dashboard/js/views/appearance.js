// TabVault dashboard — Appearance Studio.
// Every change is applied live (CSS custom properties on the document root)
// and persisted to settings.appearance. Themes cover: Dark Neon, High
// Contrast, Transparent Glass, Minimal Light, Minimal Dark, Wallpaper and
// iPhone Glass. Each preset carries its own swatch so the grid is data-driven.

import { el, clear, toast, pickImageFile, sliderRow, toggleField, formatBytes } from '../ui.js';
import { THEME_PRESETS, PRESET_WALLPAPERS, themeById } from '../../../lib/themes.js';
import { validateImageFile, ACCEPT_ATTRIBUTE, NO_IMAGE_LIMIT } from '../../../lib/images.js';
import { putBlob, deleteBlob, mediaKey } from '../../../lib/idb.js';

const ACCENT_SWATCHES = ['#22d3ee', '#38bdf8', '#a855f7', '#ec4899', '#34d399', '#fbbf24', '#f87171', '#f4f4f5'];

export async function render(container, ctx) {
  await ctx.reloadSettings();
  const settings = ctx.settings;
  const appearance = settings.appearance;

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', {}, 'Appearance Studio'),
      el('div', { class: 'muted' }, 'Choose a complete design or tune individual settings. Changes apply instantly.')
    ),
    el(
      'button',
      {
        class: 'ghost',
        onclick: async () => {
          await ctx.applySettings({
            appearance: {
              theme: 'dark-neon',
              accent: '#22d3ee',
              glow: true,
              fontScale: 1,
              glassOpacity: 0.55,
              panelOpacity: 0.85,
              wallpaper: null
            }
          });
          toast('Appearance reset to defaults.', 'ok');
          render(container, ctx);
        }
      },
      'Reset all'
    )
  );

  const body = el('div', {});
  clear(container).append(head, body);

  // ------------------------------------------------------- presets
  body.appendChild(el('div', { class: 'section-title' }, 'Theme presets'));
  const presetGrid = el('div', { class: 'preset-grid' });
  for (const preset of THEME_PRESETS) {
    presetGrid.appendChild(
      el(
        'div',
        {
          class: `panel preset ${appearance.theme === preset.id ? 'selected' : ''}`,
          onclick: async () => {
            await ctx.applySettings({
              appearance: {
                theme: preset.id,
                accent: preset.accent,
                glow: preset.glow,
                glassOpacity: preset.glassOpacity,
                panelOpacity: preset.panelOpacity
              }
            });
            render(container, ctx);
          }
        },
        el('div', {
          class: 'swatch',
          style: { background: preset.swatch || `linear-gradient(135deg, #07080d, ${preset.accent})` }
        }, ''),
        el('div', { style: { fontWeight: 700 } }, preset.name),
        el('div', { class: 'muted', style: { fontSize: '12px' } }, preset.description)
      )
    );
  }
  body.appendChild(presetGrid);

  // ------------------------------------------------------- accent + glow
  body.appendChild(el('div', { class: 'section-title' }, `Accent & effects — ${themeById(appearance.theme).name}`));
  const accentPanel = el('div', { class: 'panel' });
  const swatches = el('div', { class: 'swatches' });
  for (const color of ACCENT_SWATCHES) {
    swatches.appendChild(
      el('div', {
        class: `swatch-dot ${appearance.accent === color ? 'selected' : ''}`,
        style: { background: color },
        title: color,
        onclick: async () => {
          await ctx.applySettings({ appearance: { accent: color } });
          render(container, ctx);
        }
      })
    );
  }
  const colorInput = el('input', { type: 'color', value: appearance.accent });
  colorInput.addEventListener('change', async () => {
    await ctx.applySettings({ appearance: { accent: colorInput.value } });
    render(container, ctx);
  });
  const glassApply = debounceApply(ctx);
  const panelApply = debounceApply(ctx);
  const fontApply = debounceApply(ctx);
  accentPanel.append(
    el('div', { class: 'toolbar', style: { marginBottom: '10px' } }, swatches, colorInput),
    toggleField({
      label: 'Animated neon glow (respects reduced-motion)',
      checked: appearance.glow,
      onChange: (v) => ctx.applySettings({ appearance: { glow: v } })
    }),
    sliderRow({
      label: 'Glass transparency',
      min: 0.15,
      max: 1,
      step: 0.05,
      value: appearance.glassOpacity,
      onInput: (v) => glassApply({ glassOpacity: v })
    }),
    sliderRow({
      label: 'Panel opacity',
      min: 0.2,
      max: 1,
      step: 0.05,
      value: appearance.panelOpacity,
      onInput: (v) => panelApply({ panelOpacity: v })
    }),
    sliderRow({
      label: 'Font scale',
      min: 0.85,
      max: 1.3,
      step: 0.05,
      value: appearance.fontScale,
      onInput: (v) => fontApply({ fontScale: v })
    })
  );
  body.appendChild(accentPanel);

  // ------------------------------------------------------- wallpaper
  body.appendChild(el('div', { class: 'section-title' }, 'Wallpaper'));
  body.appendChild(await wallpaperPanel(ctx, appearance, () => render(container, ctx)));
}

function debounceApply(ctx) {
  let timer = null;
  return (patch) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ctx.applySettings({ appearance: patch }).catch(() => {});
    }, 120);
  };
}

async function wallpaperPanel(ctx, appearance, rerender) {
  const panel = el('div', { class: 'panel' });
  const wp = appearance.wallpaper;

  const kindSel = el(
    'select',
    {},
    el('option', { value: 'none' }, 'none'),
    el('option', { value: 'preset' }, 'built-in gallery'),
    el('option', { value: 'solid' }, 'solid color'),
    el('option', { value: 'image' }, 'uploaded image')
  );
  kindSel.value = wp ? wp.kind : 'none';

  panel.append(el('div', { class: 'toolbar', style: { marginBottom: '8px' } }, el('span', { class: 'muted' }, 'Background:'), kindSel));

  const controls = el('div', {});
  panel.appendChild(controls);

  function paint() {
    clear(controls);
    const kind = kindSel.value;
    if (kind === 'none') {
      controls.appendChild(el('div', { class: 'muted' }, 'Plain theme background (no wallpaper).'));
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
                await ctx.applySettings({
                  appearance: {
                    wallpaper: { kind: 'preset', value: preset.id, fit: 'cover', position: 'center', brightness: 1, overlay: 0.3 }
                  }
                });
                rerender();
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
        await ctx.applySettings({
          appearance: { wallpaper: { kind: 'solid', value: color.value, fit: 'cover', position: 'center', brightness: 1, overlay: 0 } }
        });
      });
      controls.appendChild(el('div', { class: 'toolbar' }, color));
      return;
    }
    // image
    controls.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el('button', { class: 'small', onclick: onUpload }, 'Upload image…'),
        wp && wp.kind === 'image'
          ? el('button', { class: 'small danger', onclick: onRemove }, 'Remove wallpaper')
          : el('span', { class: 'muted', style: { fontSize: '12px' } }, 'PNG, JPG or WebP — any size, no limit. Stored locally.')
      )
    );
    if (wp && wp.kind === 'image') {
      const apply = debounceApply(ctx, {});
      controls.append(
        sliderRow({
          label: 'Brightness',
          min: 0.2,
          max: 1.5,
          step: 0.05,
          value: wp.brightness ?? 0.9,
          onInput: (v) => apply({ wallpaper: { ...wp, brightness: v } })
        }),
        sliderRow({
          label: 'Readability overlay',
          min: 0,
          max: 0.9,
          step: 0.05,
          value: wp.overlay ?? 0.3,
          onInput: (v) => apply({ wallpaper: { ...wp, overlay: v } })
        }),
        el(
          'div',
          { class: 'toolbar' },
          el('span', { class: 'muted' }, 'Position:'),
          positionSelect(wp.position || 'center', apply),
          el('span', { class: 'muted' }, 'Fit:'),
          fitSelect(wp.fit || 'cover', apply)
        )
      );
    }
  }

  function positionSelect(value, apply) {
    const sel = el(
      'select',
      {},
      ...['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'].map((p) =>
        el('option', { value: p }, p)
      )
    );
    sel.value = value;
    sel.addEventListener('change', () => apply({ wallpaper: { ...wp, position: sel.value } }));
    return sel;
  }

  function fitSelect(value, apply) {
    const sel = el('select', {}, ...['cover', 'contain', 'repeat'].map((p) => el('option', { value: p }, p)));
    sel.value = value;
    sel.addEventListener('change', () => apply({ wallpaper: { ...wp, fit: sel.value } }));
    return sel;
  }

  async function onUpload() {
    const file = await pickImageFile(ACCEPT_ATTRIBUTE);
    if (!file) return;
    const check = await validateImageFile(file, NO_IMAGE_LIMIT);
    if (!check.ok) {
      toast(check.error, 'err');
      return;
    }
    const key = mediaKey('bg');
    await putBlob(key, file);
    const oldKey = wp && wp.kind === 'image' ? wp.value : null;
    await ctx.applySettings({
      appearance: { wallpaper: { kind: 'image', value: key, fit: 'cover', position: 'center', brightness: 0.9, overlay: 0.35 } }
    });
    if (oldKey && oldKey !== key) deleteBlob(oldKey).catch(() => {});
    toast(`Wallpaper applied (${formatBytes(file.size)}).`, 'ok');
    rerender();
  }

  async function onRemove() {
    const oldKey = wp && wp.kind === 'image' ? wp.value : null;
    await ctx.applySettings({ appearance: { wallpaper: null } });
    if (oldKey) deleteBlob(oldKey).catch(() => {});
    toast('Wallpaper removed.', 'ok');
    rerender();
  }

  kindSel.addEventListener('change', async () => {
    const kind = kindSel.value;
    if (kind === 'none') {
      await ctx.applySettings({ appearance: { wallpaper: null } });
      paint();
      return;
    }
    if (kind === 'preset') {
      await ctx.applySettings({
        appearance: {
          wallpaper: { kind: 'preset', value: PRESET_WALLPAPERS[0].id, fit: 'cover', position: 'center', brightness: 1, overlay: 0.3 }
        }
      });
      paint();
      return;
    }
    if (kind === 'solid') {
      await ctx.applySettings({
        appearance: { wallpaper: { kind: 'solid', value: '#0b1020', fit: 'cover', position: 'center', brightness: 1, overlay: 0 } }
      });
      paint();
      return;
    }
    paint();
  });

  paint();
  return panel;
}

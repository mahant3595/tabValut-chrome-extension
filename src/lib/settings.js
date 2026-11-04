// TabVault — settings schema, defaults and defensive normalization.
// Everything that touches persisted settings MUST pass through normalizeSettings():
// chrome.storage.local can contain garbage, partial data or values written by
// older/newer versions of the extension.

export const THEME_IDS = [
  'dark-neon',
  'high-contrast',
  'glass',
  'minimal-light',
  'minimal-dark',
  'wallpaper',
  'iphone'
];

export const WALLPAPER_FITS = ['cover', 'contain', 'repeat'];
export const WALLPAPER_POSITIONS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top left',
  'top right',
  'bottom left',
  'bottom right'
];

export const LIMITS = {
  glassOpacity: { min: 0.15, max: 1, def: 0.55 },
  panelOpacity: { min: 0.2, max: 1, def: 0.85 },
  brightness: { min: 0.2, max: 1.5, def: 0.9 },
  overlay: { min: 0, max: 0.9, def: 0.3 },
  fontScale: { min: 0.85, max: 1.3, def: 1 }
};

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  appearance: {
    theme: 'dark-neon',
    accent: '#22d3ee',
    glow: true,
    fontScale: LIMITS.fontScale.def,
    glassOpacity: LIMITS.glassOpacity.def,
    panelOpacity: LIMITS.panelOpacity.def,
    // wallpaper: null | { kind: 'preset'|'image'|'solid'|'gradient', value, fit, position, brightness, overlay }
    wallpaper: null
  },
  library: {
    defaultSort: 'added-desc'
  }
});

function clampNumber(value, limit, fallback = limit.def) {
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(limit.max, Math.max(limit.min, n));
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function toStr(value, fallback, maxLength = 120) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function normalizeHexColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const m = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  return m ? value.trim().toLowerCase() : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeWallpaper(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = oneOf(value.kind, ['preset', 'image', 'solid', 'gradient'], null);
  if (!kind) return null;
  const wp = {
    kind,
    // preset id, css gradient string, solid color or an IndexedDB blob key.
    value:
      kind === 'image'
        ? toStr(value.value, '', 200)
        : toStr(value.value, kind === 'solid' ? '#0b1020' : '', 400),
    fit: oneOf(value.fit, WALLPAPER_FITS, 'cover'),
    position: oneOf(value.position, WALLPAPER_POSITIONS, 'center'),
    brightness: clampNumber(value.brightness, LIMITS.brightness),
    overlay: clampNumber(value.overlay, LIMITS.overlay),
    repeatSize: clampNumber(value.repeatSize, { min: 100, max: 1200, def: 400 })
  };
  if (kind === 'image' && !wp.value) return null;
  return wp;
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const a = src.appearance && typeof src.appearance === 'object' ? src.appearance : {};
  const l = src.library && typeof src.library === 'object' ? src.library : {};

  return {
    version: 1,
    appearance: {
      theme: oneOf(a.theme, THEME_IDS, DEFAULT_SETTINGS.appearance.theme),
      accent: normalizeHexColor(a.accent, DEFAULT_SETTINGS.appearance.accent),
      glow: toBool(a.glow, DEFAULT_SETTINGS.appearance.glow),
      fontScale: clampNumber(a.fontScale, LIMITS.fontScale),
      glassOpacity: clampNumber(a.glassOpacity, LIMITS.glassOpacity),
      panelOpacity: clampNumber(a.panelOpacity, LIMITS.panelOpacity),
      wallpaper: normalizeWallpaper(a.wallpaper)
    },
    library: {
      defaultSort: oneOf(
        l.defaultSort,
        ['added-desc', 'added-asc', 'title-asc', 'title-desc', 'domain-asc'],
        DEFAULT_SETTINGS.library.defaultSort
      )
    }
  };
}

/** Deep-merge a patch onto an existing (normalized) settings object, then re-normalize. */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current);
  if (!patch || typeof patch !== 'object') return base;
  return normalizeSettings({
    ...base,
    ...patch,
    appearance: { ...base.appearance, ...(patch.appearance || {}) },
    library: { ...base.library, ...(patch.library || {}) }
  });
}

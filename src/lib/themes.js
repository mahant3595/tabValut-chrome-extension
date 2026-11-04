// TabVault — theme presets and appearance application.
// The Appearance Studio mutates CSS custom properties at runtime on top of the
// preset selected via the root [data-theme] attribute.

export const THEME_PRESETS = [
  {
    id: 'dark-neon',
    name: 'Dark Neon',
    description: 'Futuristic cyber look: near-black surfaces, neon accents, subtle glow.',
    accent: '#22d3ee',
    glow: true,
    glassOpacity: 0.55,
    panelOpacity: 0.85,
    swatch: 'linear-gradient(135deg,#07080d,#12324f)'
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    description: 'Strong separation, obvious states, maximum readability.',
    accent: '#ffd400',
    glow: false,
    glassOpacity: 1,
    panelOpacity: 1,
    swatch: 'linear-gradient(135deg,#000,#333)'
  },
  {
    id: 'glass',
    name: 'Transparent Glass',
    description: 'Glassmorphism: translucent panels, blur, layered depth.',
    accent: '#7dd3fc',
    glow: false,
    glassOpacity: 0.4,
    panelOpacity: 0.55,
    swatch: 'linear-gradient(135deg,#1e293bdd,#7dd3fc55)'
  },
  {
    id: 'minimal-light',
    name: 'Minimal Light',
    description: 'Clean white surfaces, restrained accent, productivity-first.',
    accent: '#2563eb',
    glow: false,
    glassOpacity: 1,
    panelOpacity: 1,
    swatch: 'linear-gradient(135deg,#f6f7f9,#dbe2ee)'
  },
  {
    id: 'minimal-dark',
    name: 'Minimal Dark',
    description: 'Charcoal surfaces, subtle borders, comfortable contrast.',
    accent: '#60a5fa',
    glow: false,
    glassOpacity: 1,
    panelOpacity: 1,
    swatch: 'linear-gradient(135deg,#14161a,#2a2f3a)'
  },
  {
    id: 'wallpaper',
    name: 'Wallpaper',
    description: 'Your image, gradient or solid color behind adjustable panels.',
    accent: '#a78bfa',
    glow: false,
    glassOpacity: 0.5,
    panelOpacity: 0.75,
    swatch: 'linear-gradient(135deg,#2b1055,#7597de)'
  },
  {
    id: 'iphone',
    name: 'iPhone Glass',
    description: 'iOS-style frosted glass: SF blur, system-blue accent, light airy panels.',
    accent: '#007aff',
    glow: false,
    glassOpacity: 0.7,
    panelOpacity: 0.8,
    swatch: 'linear-gradient(135deg,#f2f4f8 0%,#dbe4ff 55%,#b9d0ff 100%)'
  }
];

/** Built-in wallpaper gallery (pure CSS, no binary assets needed). */
export const PRESET_WALLPAPERS = [
  { id: 'aurora', name: 'Aurora', css: 'linear-gradient(135deg,#0b1020 0%,#12324f 35%,#1b6f6a 65%,#0b1020 100%)' },
  { id: 'neon-grid', name: 'Neon Grid', css: 'linear-gradient(#0ff 1px,transparent 1px),linear-gradient(90deg,#0ff 1px,transparent 1px),linear-gradient(160deg,#05060d,#12082a)', cssSize: '44px 44px,44px 44px,cover' },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(180deg,#2b1055 0%,#7597de 55%,#ffb88c 100%)' },
  { id: 'forest', name: 'Forest', css: 'linear-gradient(160deg,#041a12 0%,#0d3b2a 50%,#1f7a52 100%)' },
  { id: 'slate', name: 'Slate', css: 'linear-gradient(145deg,#111418 0%,#232a33 60%,#0d1117 100%)' },
  { id: 'paper', name: 'Paper', css: 'linear-gradient(180deg,#f6f4ef 0%,#e8e4da 100%)' }
];

export function presetById(id) {
  return PRESET_WALLPAPERS.find((p) => p.id === id) || null;
}

export function themeById(id) {
  return THEME_PRESETS.find((t) => t.id === id) || THEME_PRESETS[0];
}

/**
 * Apply an appearance config to a document.
 * @param {Document} doc
 * @param {object} appearance normalized settings.appearance
 * @param {{imageCssUrl?: string|null}} [resources] object URL for an image wallpaper
 */
export function applyAppearance(doc, appearance, resources = {}) {
  const root = doc.documentElement;
  const theme = themeById(appearance.theme);
  root.setAttribute('data-theme', appearance.theme);
  root.style.setProperty('--tv-accent', appearance.accent || theme.accent);
  root.style.setProperty('--tv-font-scale', String(appearance.fontScale ?? 1));
  root.style.setProperty('--tv-glass-opacity', String(appearance.glassOpacity ?? 0.55));
  root.style.setProperty('--tv-panel-opacity', String(appearance.panelOpacity ?? 0.85));
  root.style.setProperty('--tv-glow', appearance.glow ? '1' : '0');
  root.classList.toggle('glow-on', Boolean(appearance.glow));

  const wp = appearance.wallpaper;
  const body = doc.body;
  if (!body) return;

  // Reset.
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundRepeat = '';
  root.style.setProperty('--tv-wallpaper-filter', 'none');
  root.style.setProperty('--tv-wallpaper-overlay', 'transparent');
  body.classList.toggle('has-wallpaper', Boolean(wp));

  if (!wp) return;

  let css = null;
  let size = null;
  if (wp.kind === 'preset') {
    const preset = presetById(wp.value);
    if (preset) {
      css = preset.css;
      size = preset.cssSize || null;
    }
  } else if (wp.kind === 'solid') {
    css = wp.value || '#0b1020';
  } else if (wp.kind === 'gradient') {
    css = wp.value || 'linear-gradient(135deg,#0b1020,#1b2a4a)';
  } else if (wp.kind === 'image') {
    if (resources.imageCssUrl) css = `url("${resources.imageCssUrl}")`;
  }
  if (!css) return;

  body.style.backgroundImage = css;
  body.style.backgroundSize = size || (wp.kind === 'image' ? wp.fit || 'cover' : 'cover');
  body.style.backgroundPosition = wp.position || 'center';
  body.style.backgroundRepeat = wp.fit === 'repeat' || wp.kind === 'solid' ? 'repeat' : 'no-repeat';
  body.style.backgroundAttachment = 'fixed';
  if (typeof wp.brightness === 'number' && wp.brightness !== 1) {
    root.style.setProperty('--tv-wallpaper-filter', `brightness(${wp.brightness})`);
  }
  if (typeof wp.overlay === 'number' && wp.overlay > 0) {
    root.style.setProperty('--tv-wallpaper-overlay', `rgba(0,0,0,${wp.overlay})`);
  }
}

// TabVault dashboard — shared UI helpers (no framework, no dependencies).

import { blobUrl } from '../../lib/idb.js';

/** Hyperscript-style element builder. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Human-readable size for upload feedback (no upload limit is enforced). */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const item = el('div', { class: `toast ${kind}`.trim() }, message);
  root.appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

/** Promise-based confirmation for destructive actions. */
export function confirmModal({ title, body, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (value) => {
      clear(root);
      resolve(value);
    };
    const backdrop = el(
      'div',
      { class: 'backdrop' },
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', {}, title),
        el('div', { class: 'muted' }, body),
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { class: 'ghost', onclick: () => close(false) }, 'Cancel'),
          el(
            'button',
            { class: danger ? 'danger' : 'primary', onclick: () => close(true) },
            confirmLabel
          )
        )
      )
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    clear(root).appendChild(backdrop);
  });
}

/** Promise-based form modal. fields: [{key,label,value,placeholder,type}] */
export function promptModal({ title, fields = [], submitLabel = 'Save' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const inputs = new Map();
    const close = (value) => {
      clear(root);
      resolve(value);
    };
    const form = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = el('select', {}, ...(f.options || []).map((o) => el('option', { value: o.value }, o.label)));
        if (f.value !== undefined) input.value = f.value;
      } else if (f.type === 'textarea') {
        input = el('textarea', { rows: f.rows || 3, placeholder: f.placeholder || '' }, f.value || '');
      } else {
        input = el('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' });
      }
      inputs.set(f.key, input);
      return el('label', { class: 'field' }, f.label, input);
    });
    const backdrop = el(
      'div',
      { class: 'backdrop' },
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', {}, title),
        ...form,
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { class: 'ghost', onclick: () => close(null) }, 'Cancel'),
          el(
            'button',
            {
              class: 'primary',
              onclick: () => {
                const out = {};
                for (const [key, input] of inputs) out[key] = input.value;
                close(out);
              }
            },
            submitLabel
          )
        )
      )
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    const formEl = el('form', {}, backdrop);
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [key, input] of inputs) out[key] = input.value;
      close(out);
    });
    clear(root).appendChild(backdrop);
    const first = inputs.values().next().value;
    if (first && typeof first.focus === 'function') first.focus();
  });
}

export function formatDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pickImageFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    input.click();
  });
}

/** Pick a .json file and resolve its text (null when cancelled). */
export function pickImportFile() {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve, () => resolve(null));
    });
    input.click();
  });
}

const BUILTIN_ICONS = ['📁', '⚡', '📚', '🧪', '🚀', '💼', '🎨', '🔧', '🌐', '🔒', '☕', '🎯'];
export { BUILTIN_ICONS };

const logoUrlCache = new Map(); // key -> object URL

export function revokeLogoUrls() {
  for (const url of logoUrlCache.values()) URL.revokeObjectURL(url);
  logoUrlCache.clear();
}

/** Render a collection/group logo cell (image blob or built-in icon). */
export async function logoCellNode(collection, size = 40) {
  const logo = collection && collection.logo;
  const shape = logo && logo.shape ? logo.shape : 'rounded';
  const cell = el('div', { class: `logo-cell ${shape}`, style: { width: `${size}px`, height: `${size}px` } });
  if (logo && logo.kind === 'image' && logo.key) {
    try {
      let url = logoUrlCache.get(logo.key);
      if (!url) {
        url = await blobUrl(logo.key);
        if (url) logoUrlCache.set(logo.key, url);
      }
      if (url) {
        cell.appendChild(el('img', { src: url, alt: '' }));
        return cell;
      }
    } catch {
      /* fall through to text */
    }
  }
  if (logo && logo.kind === 'icon' && logo.icon) {
    cell.textContent = logo.icon;
    return cell;
  }
  cell.textContent = (collection.name || '?').trim().charAt(0).toUpperCase();
  return cell;
}

export function faviconImg(url) {
  return url ? el('img', { class: 'favicon', src: url, alt: '' }) : el('span', { class: 'favicon' });
}

export function fmtCount(n) {
  return Number(n || 0).toLocaleString();
}

/** Slider row with live value label. */
export function sliderRow({ label, min, max, step, value, onInput }) {
  const out = el('span', { class: 'value' }, String(value));
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onInput(Number(input.value));
  });
  return el('div', { class: 'slider-row' }, el('span', {}, label), input, out);
}

export function toggleField({ label, checked, onChange }) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'inline' }, input, label);
}

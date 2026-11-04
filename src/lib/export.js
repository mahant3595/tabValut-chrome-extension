// TabVault — collection export / import (backup format v1).
//
// The export is a single JSON document containing collections and their saved
// tabs. Internal ids are stripped on export and regenerated on import so a
// backup can be merged into any TabVault install without collisions.
// TabVault never touches live tabs or bookmarks during import.

import { normalizeUrlForCompare, domainOf } from './urls.js';

export const EXPORT_KIND = 'tabvault.collections';
export const EXPORT_VERSION = 1;

export const IMPORT_LIMITS = {
  maxCollections: 500,
  maxTabsPerCollection: 5000,
  maxTextLength: 2000,
  maxNameLength: 120
};

function cleanText(value, maxLength = IMPORT_LIMITS.maxTextLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+$/g, '').slice(0, maxLength);
}

function cleanName(value) {
  const name = cleanText(value, IMPORT_LIMITS.maxNameLength).trim();
  return name || 'Imported collection';
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const t of value) {
    const tag = cleanText(t, 60).trim().toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 40) break;
  }
  return out;
}

function cleanDate(value, fallback = 0) {
  const n = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function serializeTab(tab) {
  return {
    url: tab.url,
    title: cleanText(tab.title, 500),
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl.slice(0, 2000) : '',
    domain: tab.domain || domainOf(tab.url),
    notes: cleanText(tab.notes),
    tags: cleanTags(tab.tags),
    addedAt: cleanDate(tab.addedAt)
  };
}

function serializeCollection(collection) {
  return {
    id: collection.id,
    name: cleanName(collection.name),
    description: cleanText(collection.description),
    tags: cleanTags(collection.tags),
    logo: collection.logo && typeof collection.logo === 'object' ? { ...collection.logo } : null,
    wallpaper: collection.wallpaper && typeof collection.wallpaper === 'object' ? { ...collection.wallpaper } : null,
    createdAt: cleanDate(collection.createdAt),
    updatedAt: cleanDate(collection.updatedAt),
    tabs: Array.isArray(collection.tabs) ? collection.tabs.map(serializeTab) : []
  };
}

export function exportPayload(collections, now = Date.now()) {
  return {
    app: 'tabvault',
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    collections: (Array.isArray(collections) ? collections : []).map(serializeCollection)
  };
}

export function serializeCollections(collections, now = Date.now()) {
  return JSON.stringify(exportPayload(collections, now), null, 2);
}

/**
 * Parse + validate an import document.
 * @returns {{ok: true, collections: object[], warnings: string[]} | {ok: false, errors: string[]}}
 */
export function parseImport(text, { idFactory = defaultId, now = Date.now() } = {}) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, errors: ['Not valid JSON.'] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['Not a TabVault export document.'] };
  }
  if (doc.kind !== EXPORT_KIND) {
    return { ok: false, errors: [`Unrecognized document kind: ${String(doc.kind).slice(0, 60)}`] };
  }
  const version = Number(doc.version);
  if (!Number.isFinite(version) || version < 1 || version > EXPORT_VERSION) {
    return { ok: false, errors: [`Unsupported export version: ${String(doc.version).slice(0, 20)}`] };
  }
  if (!Array.isArray(doc.collections)) {
    return { ok: false, errors: ['Export has no collections array.'] };
  }
  const errors = [];
  const warnings = [];
  const collections = [];
  for (const raw of doc.collections) {
    if (collections.length >= IMPORT_LIMITS.maxCollections) {
      warnings.push(`Stopped after ${IMPORT_LIMITS.maxCollections} collections.`);
      break;
    }
    if (!raw || typeof raw !== 'object') {
      errors.push('Skipped a collection that was not an object.');
      continue;
    }
    if (!Array.isArray(raw.tabs)) {
      warnings.push(`Collection "${cleanName(raw.name)}" has no tabs array; imported empty.`);
    }
    const tabs = [];
    const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
    for (const rt of rawTabs) {
      if (tabs.length >= IMPORT_LIMITS.maxTabsPerCollection) break;
      if (!rt || typeof rt !== 'object' || typeof rt.url !== 'string' || !rt.url.trim()) continue;
      const normalized = normalizeUrlForCompare(rt.url);
      if (!normalized || !/^https?:\/\//i.test(normalized)) continue;
      tabs.push({
        id: idFactory(),
        url: rt.url.trim(),
        title: cleanText(rt.title, 500) || rt.url.trim(),
        favIconUrl: typeof rt.favIconUrl === 'string' ? rt.favIconUrl.slice(0, 2000) : '',
        domain: domainOf(rt.url),
        notes: cleanText(rt.notes),
        tags: cleanTags(rt.tags),
        addedAt: cleanDate(rt.addedAt, now)
      });
    }
    const createdAt = cleanDate(raw.createdAt, now);
    collections.push({
      id: idFactory(),
      name: cleanName(raw.name),
      description: cleanText(raw.description),
      tags: cleanTags(raw.tags),
      logo: raw.logo && typeof raw.logo === 'object' ? { ...raw.logo } : null,
      wallpaper: raw.wallpaper && typeof raw.wallpaper === 'object' ? { ...raw.wallpaper } : null,
      createdAt,
      updatedAt: cleanDate(raw.updatedAt, createdAt),
      tabs
    });
  }
  if (collections.length === 0 && errors.length === 0) {
    errors.push('The document contains no importable collections.');
  }
  if (errors.length > 0 && collections.length === 0) return { ok: false, errors };
  return { ok: true, collections, warnings: [...warnings, ...errors] };
}

function defaultId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

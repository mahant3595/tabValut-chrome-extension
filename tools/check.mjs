// TabVault — static checks: syntax, manifest integrity and hard project rules.
// Exit 0 = clean. Any failure prints the offending file/line and exits 1.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, 'src'));
const toolFiles = walk(join(ROOT, 'tools'));
const testDir = join(ROOT, 'test');
const testFiles = existsSync(testDir) ? walk(testDir) : [];
const jsFiles = [...srcFiles, ...toolFiles, ...testFiles].filter((f) => /\.m?js$/.test(f));

// ---------------------------------------------------------------- 1. syntax
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures.push(`SYNTAX ${file.replace(ROOT, '.')}\n${(res.stderr || '').trim()}`);
  }
}
console.log(`syntax: checked ${jsFiles.length} files`);

// ---------------------------------------------------------------- 2. manifest
const manifestPath = join(ROOT, 'manifest.json');
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const need = (cond, msg) => {
    if (!cond) failures.push(`MANIFEST ${msg}`);
  };
  need(manifest.manifest_version === 3, 'must be manifest_version 3');
  need(Array.isArray(manifest.permissions), 'permissions array missing');
  for (const perm of ['tabs', 'tabGroups', 'bookmarks', 'storage']) {
    need(manifest.permissions.includes(perm), `missing permission: ${perm}`);
  }
  need(manifest.background && manifest.background.service_worker, 'background service worker missing');
  need(existsSync(join(ROOT, manifest.background.service_worker)), 'service worker file does not exist');
  need(manifest.background.type === 'module', 'service worker must be an ES module');
  need(manifest.action && manifest.action.default_popup, 'action popup missing');
  need(existsSync(join(ROOT, manifest.action.default_popup)), 'popup file does not exist');
  const optionPage = manifest.options_ui && manifest.options_ui.page;
  need(optionPage && existsSync(join(ROOT, optionPage)), 'options page does not exist');
  const manifestText = JSON.stringify(manifest);
  need(!/https?:\/\//.test(manifestText.replace(/minimum_chrome_version/, '')) || !/"content_security_policy"/.test(manifestText), 'no remote code allowed');
  for (const icon of Object.values(manifest.icons || {})) {
    need(existsSync(join(ROOT, icon)), `icon missing: ${icon}`);
  }
  console.log('manifest: validated');
} catch (err) {
  failures.push(`MANIFEST could not be parsed: ${err.message}`);
}

// ---------------------------------------------------------------- 3. hard rules
const RULES = [
  { pattern: /tabs\s*\.\s*remove/, message: 'tabs.remove is forbidden — TabVault never closes tabs' },
  { pattern: /\bsetInterval\s*\(/, message: 'setInterval is forbidden — event-driven + alarms only' },
  { pattern: /\beval\s*\(/, message: 'eval is forbidden' },
  { pattern: /new\s+Function\s*\(/, message: 'new Function is forbidden' }
];
const BACKGROUND_TIMER_RULE = /setTimeout\s*\([^,]+,\s*(\d{5,})\s*\)/;

/** Strip comments (preserving line numbers) so prose can't trip the rules. */
function stripComments(text) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'sq';
      } else if (ch === '"') {
        state = 'dq';
      } else if (ch === '`') {
        state = 'tpl';
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // inside a string literal
    if (ch === '\\') {
      out += ch + (next || '');
      i += 2;
      continue;
    }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
      state = 'code';
    }
    out += ch;
    i += 1;
  }
  return out;
}

let ruleHits = 0;
for (const file of srcFiles.filter((f) => /\.m?js$/.test(f))) {
  const raw = readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const rel = file.replace(ROOT, '.');
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`RULE ${rel}:${line} — ${rule.message}`);
      ruleHits += 1;
    }
  }
  const longTimer = text.match(BACKGROUND_TIMER_RULE);
  if (longTimer && Number(longTimer[1]) > 60_000) {
    const line = text.slice(0, longTimer.index).split('\n').length;
    failures.push(`RULE ${rel}:${line} — long-lived setTimeout (${longTimer[1]}ms); use chrome.alarms`);
    ruleHits += 1;
  }
}
console.log(`rules: scanned ${srcFiles.length} source files (${ruleHits} violation(s))`);

// ---------------------------------------------------------------- 4. wiring sanity
const swText = readFileSync(join(ROOT, 'src/background/service-worker.js'), 'utf8');
const coreText = readFileSync(join(ROOT, 'src/background/vault-window-core.js'), 'utf8');
const backupText = readFileSync(join(ROOT, 'src/lib/folder-sync.js'), 'utf8');
const backupViewText = readFileSync(join(ROOT, 'src/dashboard/js/views/backup.js'), 'utf8');
if (!swText.includes('vault-window-core.js')) failures.push('WIRING service worker does not import the vault window core');
if (!swText.includes('folder-sync.js')) failures.push('WIRING service worker does not import the folder backup module');
if (!backupText.includes('BACKUP_FILES')) failures.push('WIRING folder backup module does not define its file set');
if (!backupText.includes('FORMAT_OPTIONS')) failures.push('WIRING folder backup module does not offer backup formats');
if (!backupViewText.includes('FORMAT_OPTIONS')) failures.push('WIRING folder backup page does not expose the format picker');
if (!coreText.includes('PLACEHOLDER_PAGE')) failures.push('WIRING core does not build placeholder tabs');
if (/tabs\s*\.\s*discard/.test(stripComments(swText + coreText))) {
  failures.push('WIRING unloader was removed — nothing may call tabs.discard');
}
console.log('wiring: service worker ↔ vault window core import verified');

// ---------------------------------------------------------------- 5. chrome event names
// A reference to a chrome.* event that does not exist evaluates to undefined,
// so `.addListener` throws at the top level and the MV3 service worker fails
// to register (status 15) — a runtime-only failure that syntax checks and a
// mocked Node import both miss. Validate every event used against the real
// API surface so a typo or a non-existent event fails the build instead.
const CHROME_EVENTS = {
  tabs: new Set([
    'onCreated', 'onUpdated', 'onMoved', 'onActivated', 'onAttached',
    'onDetached', 'onRemoved', 'onReplaced', 'onHighlightChanged', 'onSelectionChanged'
  ]),
  tabGroups: new Set(['onCreated', 'onUpdated', 'onRemoved']),
  bookmarks: new Set([
    'onCreated', 'onRemoved', 'onChanged', 'onMoved',
    'onChildrenReordered', 'onImportBegan', 'onImportEnd'
  ]),
  storage: new Set(['onChanged']),
  history: new Set(['onVisited', 'onVisitRemoved']),
  windows: new Set(['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']),
  runtime: new Set([
    'onInstalled', 'onStartup', 'onMessage', 'onConnect', 'onConnectExternal',
    'onMessageExternal', 'onRestartRequired', 'onSuspend', 'onUpdateAvailable'
  ])
};

let eventHits = 0;
for (const file of srcFiles.filter((f) => /\.m?js$/.test(f))) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const rel = file.replace(ROOT, '.');
  const eventRe = /\bchrome\.([a-zA-Z]+)\.(on[A-Za-z]+)\b/g;
  let m;
  while ((m = eventRe.exec(text)) !== null) {
    const [, ns, evt] = m;
    const known = CHROME_EVENTS[ns];
    // Only enforce on namespaces we track; unknown namespaces are left alone.
    if (known && !known.has(evt)) {
      const line = text.slice(0, m.index).split('\n').length;
      failures.push(`EVENT ${rel}:${line} — chrome.${ns}.${evt} is not a real Chrome event (undefined → .addListener throws, service worker fails to register)`);
      eventHits += 1;
    }
  }
}
console.log(`events: validated chrome.* event names (${eventHits} invalid)`);

// ---------------------------------------------------------------- result
if (failures.length > 0) {
  console.error('\ncheck FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\ncheck OK');

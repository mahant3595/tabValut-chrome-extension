// TabVault — local preview server (development aid, NOT part of the extension).
//
// The dashboard is a Chrome extension page: it talks to `chrome.*` APIs that
// do not exist in a plain browser tab. This zero-dependency server serves the
// project statically and, for the dashboard page only, injects a tiny `chrome`
// shim (empty storage, empty tab/group lists, canned message responses) so the
// UI can be reviewed visually without loading the extension unpacked.
//
// Usage: node tools/preview-server.mjs   (then open http://127.0.0.1:8090/)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8090;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Injected before the dashboard's module script. Everything is empty/canned:
// this is a *visual* preview, not a functional extension host.
const CHROME_SHIM = `
<script>
window.__bootErrs = [];
window.addEventListener('error', function (e) { window.__bootErrs.push('E:' + e.message); });
window.addEventListener('unhandledrejection', function (e) { window.__bootErrs.push('R:' + String(e.reason && e.reason.stack || e.reason).slice(0, 300)); });
(function () {
  var settings = {
    version: 1,
    appearance: {
      theme: 'dark-neon', accent: '#22d3ee', glow: true, fontScale: 1,
      glassOpacity: 0.55, panelOpacity: 0.85, wallpaper: null
    },
    library: { defaultSort: 'added-desc' }
  };
  // In-memory storage so get/set actually round-trip (lets the Folder backup
  // format picker be exercised in preview). Not persisted across reloads.
  var store = {};
  function lsGet(keys) {
    var out = {};
    if (keys == null) return Promise.resolve(Object.assign(out, store));
    var list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    for (var i = 0; i < list.length; i++) if (list[i] in store) out[list[i]] = store[list[i]];
    return Promise.resolve(out);
  }
  function lsSet(obj) { for (var k in obj) store[k] = obj[k]; return Promise.resolve(); }
  window.chrome = {
    runtime: {
      getURL: function (p) { return '/' + p; },
      sendMessage: function (msg) {
        return Promise.resolve(
          msg && msg.type === 'tv:settings:get' ? { ok: true, settings: settings } :
          msg && msg.type === 'tv:collections:list' ? { ok: true, collections: [] } :
          msg && msg.type === 'tv:settings:update' ? { ok: true, settings: settings } :
          { ok: true, result: {}, collections: [] }
        );
      },
      onMessage: { addListener: function () {} },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} }
    },
    storage: {
      local: {
        get: function (keys) { return lsGet(keys); },
        set: lsSet,
        onChanged: { addListener: function () {} }
      },
      session: {
        get: function () { return Promise.resolve({}); },
        set: function () { return Promise.resolve(); }
      },
      onChanged: { addListener: function () {} }
    },
    tabs: {
      query: function () { return Promise.resolve([]); },
      create: function () { return Promise.resolve({ id: 1 }); },
      group: function () { return Promise.resolve(1); },
      update: function () { return Promise.resolve({}); },
      onActivated: { addListener: function () {} },
      onRemoved: { addListener: function () {} },
      onUpdated: { addListener: function () {} }
    },
    tabGroups: {
      query: function () { return Promise.resolve([]); },
      update: function () { return Promise.resolve({}); },
      onUpdated: { addListener: function () {} }
    },
    bookmarks: {
      getTree: function () { return Promise.resolve([{ id: '0', children: [] }]); },
      create: function () { return Promise.resolve({ id: 'x' }); },
      getChildren: function () { return Promise.resolve([]); },
      search: function () { return Promise.resolve([]); },
      remove: function () { return Promise.resolve(); },
      update: function () { return Promise.resolve(); },
      get: function () { return Promise.resolve([]); }
    },
    windows: {
      create: function () { return Promise.resolve({ id: 1, tabs: [] }); },
      getCurrent: function () { return Promise.resolve({ id: 1 }); }
    },
    history: { deleteUrl: function () { return Promise.resolve(); } }
  };
})();
</script>
`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    // Redirect "/" to the real dashboard path so the page's RELATIVE asset
    // URLs (styles.css, js/app.js) resolve — serving the HTML at "/" makes
    // them 404 and the preview renders unstyled without its app code.
    if (pathname === '/') {
      res.writeHead(302, { Location: '/src/dashboard/index.html' + url.search });
      res.end();
      return;
    }

    // Guard against path traversal.
    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(normalize(ROOT))) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let body = await readFile(target);
    let type = MIME[extname(target)] || 'application/octet-stream';

    // Dashboard page: inject the chrome shim before its module script.
    if (pathname.endsWith('/src/dashboard/index.html')) {
      let html = body.toString('utf8');
      html = html.replace('<script type="module"', CHROME_SHIM + '\n    <script type="module"');
      // Fallback: if the app's own boot didn't paint (some awaits depend on
      // real chrome.* behavior the mock can't reproduce), mount the real home
      // view directly so the preview is always visible.
      html = html.replace(
        '</body>',
        `<script type="module">
          import { render as renderHome } from '/src/dashboard/js/views/home.js';
          import { applyAppearance } from '/src/lib/themes.js';
          setTimeout(async () => {
            try {
              applyAppearance(document, {
                theme: 'dark-neon', accent: '#22d3ee', glow: true, fontScale: 1,
                glassOpacity: 0.55, panelOpacity: 0.85, wallpaper: null
              });
            } catch (e) { /* theme is cosmetic */ }
            const main = document.getElementById('main');
            if (main && main.children.length === 0) {
              try {
                await renderHome(main, {
                  get settings() { return { appearance: {}, library: {} }; },
                  navigate() {}, applySettings() {}, reloadSettings() {}, refresh() {}
                }, {});
              } catch (e) { main.textContent = 'Preview: ' + (e && e.message || e); }
            }
          }, 400);
        </script>`
      );
      // Preview-only banner so nobody mistakes this for the real extension.
      html = html.replace(
        '</body>',
        '<div style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);' +
          'background:#f59e0b;color:#111;padding:6px 14px;border-radius:8px;' +
          'font:12px system-ui;z-index:9999;box-shadow:0 2px 10px rgba(0,0,0,.4)">' +
          'PREVIEW MODE — chrome.* APIs are mocked (empty data). Load the extension unpacked for the real thing.' +
          '</div></body>'
      );
      body = Buffer.from(html, 'utf8');
      type = MIME['.html'];
    }

    // Vault Browser page: same shim so the address bar + session logic boots.
    if (pathname.endsWith('/src/vault-browser/index.html')) {
      let html = body.toString('utf8');
      html = html.replace('<script type="module"', CHROME_SHIM + '\n    <script type="module"');
      html = html.replace(
        '</body>',
        '<div style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);' +
          'background:#f59e0b;color:#111;padding:6px 14px;border-radius:8px;' +
          'font:12px system-ui;z-index:9999;box-shadow:0 2px 10px rgba(0,0,0,.4)">' +
          'PREVIEW MODE — chrome.* APIs are mocked (empty data). Load the extension unpacked for the real thing.' +
          '</div></body>'
      );
      body = Buffer.from(html, 'utf8');
      type = MIME['.html'];
    }

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TabVault preview: http://127.0.0.1:${PORT}/ (Ctrl+C to stop)`);
});

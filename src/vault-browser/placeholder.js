// TabVault — unloaded placeholder tab.
// Shown inside lazy vault tabs instead of a blank "New Tab": it displays the
// stored title, URL and favicon (so the tab strip looks right) but performs
// ZERO network activity. The real site loads only when the user switches to
// the tab (the service worker navigates it) or presses "Load this tab now".

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);

function applyInfo({ url, title, favIconUrl }) {
  if (title) {
    document.title = title;
    $('ph-title').textContent = title;
  }
  if (url) {
    $('ph-url').textContent = url;
  }
  if (favIconUrl) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = favIconUrl;
    document.head.appendChild(link);
  }
}

async function main() {
  // Fallback data from the URL parameters (instant paint)…
  applyInfo({
    url: params.get('url') || '',
    title: params.get('title') || 'Unloaded vault tab',
    favIconUrl: params.get('favicon') || ''
  });

  // …authoritative data from the worker (works even after redirects).
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tv:vault:placeholderInfo' });
    if (res && res.ok && res.entry) {
      applyInfo(res.entry);
    }
  } catch {
    /* parameter fallback is enough */
  }

  $('ph-load').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'tv:vault:loadTab' }).catch(() => {});
  });
}

main();

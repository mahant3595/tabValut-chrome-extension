// TabVault — history-free opening.
// Opening a stored site from the vault must not leave browser-history traces.
// Strategy: open the tab, then delete its history entry once the navigation
// commits (and again for the final redirected URL). Requires the "history"
// permission. Chrome records the visit briefly before it is scrubbed — there
// is no MV3 API to navigate without recording at all; the vault browser
// window (iframe viewer) is the fully history-free path for embeddable sites.

/**
 * Open a URL in a tab and scrub it from browser history.
 * @param {string} url
 * @param {{active?: boolean}} [opts]
 */
export async function openWithoutHistory(url, { active = true } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('Only http(s) URLs can be opened from the vault.');
  }
  const tab = await chrome.tabs.create({ url, active });

  let removed = false;
  const scrub = async () => {
    if (removed) return;
    removed = true;
    chrome.tabs.onUpdated.removeListener(scrub);
    try {
      await chrome.history.deleteUrl({ url });
    } catch {
      /* best-effort */
    }
    try {
      const fresh = await chrome.tabs.get(tab.id);
      if (fresh && fresh.url && fresh.url !== url) {
        await chrome.history.deleteUrl({ url: fresh.url });
      }
    } catch {
      /* tab may be gone */
    }
  };

  const listener = (tabId, changeInfo) => {
    if (tabId === tab.id && changeInfo && changeInfo.status === 'complete') scrub();
  };
  chrome.tabs.onUpdated.addListener(listener);
  // Safety valve so the listener can never leak.
  setTimeout(() => {
    chrome.tabs.onUpdated.removeListener(listener);
    chrome.tabs.onUpdated.removeListener(scrub);
  }, 60_000);
  return tab;
}

/**
 * Open a set of stored URLs history-free, in order, in background tabs.
 * Returns the number opened.
 */
export async function openManyWithoutHistory(urls) {
  let opened = 0;
  for (const url of urls) {
    // eslint-disable-next-line no-await-in-loop -- order-preserving open
    await openWithoutHistory(url, { active: false });
    opened += 1;
  }
  return opened;
}

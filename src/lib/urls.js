// TabVault — URL normalization and duplicate detection helpers.
// Used by the duplicate finder (dashboard) and unit tests.

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|msclkid$|mc_eid$|mc_cid$|igshid$|yclid$|_ga$|ref_src$|ref_url$|spm$|vero_id$)/i;

/**
 * Normalize a URL for *comparison* purposes:
 *  - lowercases scheme + host, strips a default port
 *  - removes the fragment
 *  - drops common tracking parameters and sorts what remains
 *  - strips a trailing slash from the path
 * Returns null when the URL cannot be parsed.
 */
export function normalizeUrlForCompare(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase() || null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  }
  const host = u.hostname.toLowerCase();
  const port =
    u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
      ? `:${u.port}`
      : '';
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = params.length
    ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  return `${u.protocol}//${host}${port}${path}${qs}`.toLowerCase();
}

export function domainOf(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Group items by their normalized URL. Only clusters with 2+ members are
 * returned, sorted by cluster size then domain.
 * @param {Array<{url: string}>} items
 * @param {(item:any)=>string|null} [keyOf]
 */
export function findDuplicateClusters(items, keyOf = (it) => normalizeUrlForCompare(it.url)) {
  const byKey = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyOf(item);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const clusters = [];
  for (const [key, members] of byKey) {
    if (members.length > 1) clusters.push({ key, members, count: members.length });
  }
  clusters.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return clusters;
}

/** Human-readable source label used by the duplicate finder. */
export const SOURCE_LABELS = {
  'open-tab': 'Open tab',
  group: 'Tab group',
  bookmark: 'Bookmark',
  library: 'TabVault library'
};

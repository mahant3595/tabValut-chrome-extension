// TabVault — image upload validation for custom group logos / wallpapers.
//
// Security stance:
//  - Only PNG, JPEG and WebP are accepted. SVG is deliberately NOT accepted:
//    it can carry scripts, and there is no sanitization we would trust enough
//    to render untrusted SVG markup inside the extension. ("Support SVG only
//    when it can be handled safely through a validated, sanitized
//    implementation" — we chose the safe end of that trade-off.)
//  - Files are never executed; they are stored as opaque blobs in IndexedDB
//    and rendered via object URLs (or CSS background-image), never inlined
//    into the DOM as markup.

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap for LOGOS only
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_IMAGE_DIMENSION = 8;
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');
// Wallpapers have NO size / dimension limit — modern photos and 4K/8K art are
// well over the logo cap, and they live as blobs in IndexedDB where they cost
// nothing until rendered. Format validation (PNG/JPG/WebP, decodable, ≥ 8px)
// still applies. Pass this to the validators instead of the defaults.
export const NO_IMAGE_LIMIT = { maxBytes: Infinity, maxDimension: Infinity };

/** Synchronous type/size validation. Returns {ok, error?}. */
export function validateImageMeta(file, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!file || typeof file !== 'object') return { ok: false, error: 'No file selected.' };
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return { ok: false, error: 'Only PNG, JPG/JPEG and WebP images are supported.' };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'The selected file is empty.' };
  if (size > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `Image is too large (limit ${mb} MB).` };
  }
  return { ok: true };
}

/**
 * Full validation including dimension checks (async; uses createImageBitmap
 * where available, e.g. Chrome extension pages).
 * @returns {Promise<{ok: boolean, error?: string, width?: number, height?: number}>}
 */
export async function validateImageFile(file, limits = {}) {
  const meta = validateImageMeta(file, limits);
  const { maxDimension = MAX_IMAGE_DIMENSION } = limits;
  if (!meta.ok) return meta;
  if (typeof createImageBitmap !== 'function') return { ok: true }; // no bitmap API — type+size already checked
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: 'The file could not be decoded as an image.' };
  }
  const { width, height } = bitmap;
  if (typeof bitmap.close === 'function') bitmap.close();
  if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
    return { ok: false, error: `Image is too small (min ${MIN_IMAGE_DIMENSION}×${MIN_IMAGE_DIMENSION}).` };
  }
  if (width > maxDimension || height > maxDimension) {
    return {
      ok: false,
      error: `Image dimensions exceed ${maxDimension}×${maxDimension} px.`
    };
  }
  return { ok: true, width, height };
}

/** Shapes supported for logo presentation. */
export const LOGO_SHAPES = ['square', 'rounded', 'circle'];

export function normalizeLogoRef(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = value.kind === 'image' ? 'image' : value.kind === 'icon' ? 'icon' : null;
  if (!kind) return null;
  return {
    kind,
    // IndexedDB blob key (image) or a built-in icon id (icon).
    key: typeof value.key === 'string' ? value.key.slice(0, 200) : '',
    icon: typeof value.icon === 'string' ? value.icon.slice(0, 60) : '',
    shape: LOGO_SHAPES.includes(value.shape) ? value.shape : 'rounded'
  };
}

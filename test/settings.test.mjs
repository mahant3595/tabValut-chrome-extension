import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, mergeSettings, THEME_IDS } from '../src/lib/settings.js';

test('normalizeSettings returns defaults for null/garbage input', () => {
  for (const input of [null, undefined, 42, 'x', [], true]) {
    const s = normalizeSettings(input);
    assert.equal(s.appearance.theme, 'dark-neon');
    assert.equal(s.appearance.accent, '#22d3ee');
    assert.equal(s.library.defaultSort, 'added-desc');
    assert.equal(s.version, 1);
  }
});

test('normalizeSettings never exposes an unloader section (unloader was removed)', () => {
  const s = normalizeSettings({ unloader: { inactivityMs: 120000, paused: true } });
  assert.equal(s.unloader, undefined);
  assert.equal('unloader' in s, false);
});

test('normalizeSettings validates the theme id', () => {
  assert.equal(normalizeSettings({ appearance: { theme: 'glass' } }).appearance.theme, 'glass');
  assert.equal(normalizeSettings({ appearance: { theme: 'rainbow-exotic' } }).appearance.theme, 'dark-neon');
  for (const id of THEME_IDS) {
    assert.equal(normalizeSettings({ appearance: { theme: id } }).appearance.theme, id);
  }
});

test('normalizeSettings validates accent color and wallpaper shape', () => {
  const s = normalizeSettings({
    appearance: {
      accent: '#ABCDEF',
      wallpaper: { kind: 'image', value: 'key-1', fit: 'weird', position: 'middle', brightness: 99, overlay: -5 }
    }
  });
  assert.equal(s.appearance.accent, '#abcdef');
  assert.equal(normalizeSettings({ appearance: { accent: 'red-ish' } }).appearance.accent, '#22d3ee');
  assert.equal(s.appearance.wallpaper.fit, 'cover');
  assert.equal(s.appearance.wallpaper.position, 'center');
  assert.equal(s.appearance.wallpaper.brightness, 1.5);
  assert.equal(s.appearance.wallpaper.overlay, 0);
});

test('normalizeSettings drops an image wallpaper without a value', () => {
  const s = normalizeSettings({ appearance: { wallpaper: { kind: 'image', value: '' } } });
  assert.equal(s.appearance.wallpaper, null);
  assert.equal(normalizeSettings({ appearance: { wallpaper: { kind: 'nonsense' } } }).appearance.wallpaper, null);
});

test('normalizeSettings clamps opacity and font scale to limits', () => {
  const s = normalizeSettings({
    appearance: { fontScale: 99, glassOpacity: 0, panelOpacity: -3 }
  });
  assert.equal(s.appearance.fontScale, 1.3); // clamped to max
  assert.equal(s.appearance.glassOpacity, 0.15);
  assert.equal(s.appearance.panelOpacity, 0.2);
});

test('normalizeSettings validates the library sort order', () => {
  assert.equal(normalizeSettings({ library: { defaultSort: 'title-asc' } }).library.defaultSort, 'title-asc');
  assert.equal(normalizeSettings({ library: { defaultSort: 'nonsense' } }).library.defaultSort, 'added-desc');
});

test('mergeSettings deep-merges patches without losing sibling keys', () => {
  const base = normalizeSettings({ appearance: { theme: 'glass' }, library: { defaultSort: 'domain-asc' } });
  const merged = mergeSettings(base, { appearance: { accent: '#ff0000' } });
  assert.equal(merged.appearance.theme, 'glass'); // sibling key survives
  assert.equal(merged.appearance.accent, '#ff0000');
  assert.equal(merged.library.defaultSort, 'domain-asc');
});

test('mergeSettings with a garbage patch returns the normalized base', () => {
  const base = normalizeSettings({ appearance: { theme: 'minimal-light' } });
  assert.equal(mergeSettings(base, null).appearance.theme, 'minimal-light');
  assert.equal(mergeSettings(base, 'nope').appearance.theme, 'minimal-light');
});

test('settings survive a garbage round-trip through JSON', () => {
  const s = normalizeSettings(
    JSON.parse('{"unloader":{"inactivityMs":"NaN"},"appearance":{"theme":null,"accent":"not-a-color"}}')
  );
  assert.equal(s.appearance.theme, 'dark-neon');
  assert.equal(s.appearance.accent, '#22d3ee');
  assert.equal(s.unloader, undefined);
});

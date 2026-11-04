import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlForCompare, domainOf, findDuplicateClusters } from '../src/lib/urls.js';

test('normalization strips fragments, default ports, trailing slashes and case', () => {
  const a = normalizeUrlForCompare('HTTPS://Example.COM:443/Path/');
  const b = normalizeUrlForCompare('https://example.com/Path#section');
  assert.equal(a, b);
});

test('normalization removes tracking parameters and sorts the rest', () => {
  const a = normalizeUrlForCompare('https://x.example/p?utm_source=tw&b=2&a=1');
  const b = normalizeUrlForCompare('https://x.example/p?a=1&b=2&fbclid=abc');
  assert.equal(a, b);
  assert.equal(normalizeUrlForCompare('https://x.example/p?a=1'), 'https://x.example/p?a=1');
});

test('normalization keeps meaningful query differences', () => {
  assert.notEqual(normalizeUrlForCompare('https://x.example/p?id=1'), normalizeUrlForCompare('https://x.example/p?id=2'));
});

test('normalization keeps non-default ports', () => {
  assert.equal(normalizeUrlForCompare('https://x.example:8443/a'), 'https://x.example:8443/a');
});

test('normalization returns null for empty input and lowercases junk for unparseable input', () => {
  assert.equal(normalizeUrlForCompare(''), null);
  assert.equal(normalizeUrlForCompare('   '), null);
  assert.equal(normalizeUrlForCompare('NOT A URL'), 'not a url');
});

test('domainOf extracts and strips www', () => {
  assert.equal(domainOf('https://www.Example.com/x'), 'example.com');
  assert.equal(domainOf('garbage'), '');
});

test('findDuplicateClusters groups by normalized URL and drops singletons', () => {
  const clusters = findDuplicateClusters([
    { url: 'https://x.example/p?utm_source=a', tag: '1' },
    { url: 'https://x.example/p#frag', tag: '2' },
    { url: 'https://y.example/only', tag: '3' },
    { url: 'https://x.example/p', tag: '4' }
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 3);
  assert.deepEqual(clusters[0].members.map((m) => m.tag).sort(), ['1', '2', '4']);
});

test('findDuplicateClusters tolerates garbage input', () => {
  assert.deepEqual(findDuplicateClusters([]), []);
  assert.deepEqual(findDuplicateClusters(null), []);
  const clusters = findDuplicateClusters([{ url: null }, { url: 'bad url?' }, { url: 'bad url?' }]);
  assert.equal(clusters.length, 1); // unparseable but identical strings still cluster
});

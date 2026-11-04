import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeCollections, parseImport, exportPayload, EXPORT_KIND } from '../src/lib/export.js';

const SAMPLE = [
  {
    id: 'c1',
    name: 'Research',
    description: 'stuff',
    tags: ['AI'],
    logo: { kind: 'icon', icon: '📚', shape: 'rounded' },
    wallpaper: null,
    createdAt: 1700000000000,
    updatedAt: 1700000100000,
    tabs: [
      {
        id: 't1',
        url: 'https://a.example/one',
        title: 'One',
        favIconUrl: '',
        domain: 'a.example',
        notes: 'note',
        tags: ['x'],
        addedAt: 1700000000000
      }
    ]
  }
];

test('export → import round-trip preserves content but regenerates ids', () => {
  const json = serializeCollections(SAMPLE);
  const parsed = parseImport(json, { idFactory: (() => { let n = 0; return () => `gen-${++n}`; })() });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.collections.length, 1);
  const c = parsed.collections[0];
  assert.equal(c.name, 'Research');
  assert.equal(c.tabs.length, 1);
  assert.equal(c.tabs[0].url, 'https://a.example/one');
  assert.notEqual(c.id, 'c1'); // fresh id for collision-free merging
  assert.notEqual(c.tabs[0].id, 't1');
  assert.equal(c.tabs[0].domain, 'a.example');
});

test('parseImport rejects non-JSON and wrong kinds', () => {
  assert.equal(parseImport('{oops').ok, false);
  assert.equal(parseImport('[1,2]').ok, false);
  assert.equal(parseImport(JSON.stringify({ kind: 'other.app', version: 1, collections: [] })).ok, false);
  assert.equal(parseImport(JSON.stringify({ kind: EXPORT_KIND, version: 99, collections: [] })).ok, false);
});

test('parseImport drops tabs without valid http(s) URLs', () => {
  const doc = exportPayload([
    {
      id: 'c',
      name: 'C',
      tabs: [
        { url: 'https://ok.example/' },
        { url: 'javascript:alert(1)' },
        { url: 'chrome://settings/' },
        { title: 'no url' },
        'not-an-object'
      ]
    }
  ]);
  const parsed = parseImport(JSON.stringify(doc));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.collections[0].tabs.length, 1);
  assert.equal(parsed.collections[0].tabs[0].url, 'https://ok.example/');
});

test('parseImport sanitizes names and tags', () => {
  const doc = {
    app: 'tabvault',
    kind: EXPORT_KIND,
    version: 1,
    collections: [{ name: '', tags: ['A', 'a', ' ', 5], tabs: [] }]
  };
  const parsed = parseImport(JSON.stringify(doc));
  assert.equal(parsed.ok, true);
  const c = parsed.collections[0];
  assert.equal(c.name, 'Imported collection');
  assert.deepEqual(c.tags, ['a']); // deduped, non-string tags dropped
});

test('parseImport fails cleanly when nothing is importable', () => {
  const parsed = parseImport(JSON.stringify({ app: 'tabvault', kind: EXPORT_KIND, version: 1, collections: 'nope' }));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.length > 0);
});

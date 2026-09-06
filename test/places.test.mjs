import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeTile, tileAt } from '../js/mvt.js';
import { extractPlaces, normalize, matchTier, tilesAround, PlaceIndex, editDistance } from '../js/places.js';

const tile = { z: 14, x: 4412, y: 6199 };
const bytes = readFileSync(new URL('./fixtures/tile-14-4412-6199.pbf', import.meta.url));

test('MVT decoder reads layers, properties and geometry in lon/lat', () => {
  const layers = decodeTile(bytes, tile);
  assert.ok(layers.poi.features.length > 300);
  const wc = layers.poi.features.find((f) => f.properties.name === 'White Castle');
  assert.equal(wc.type, 1);
  const [lon, lat] = wc.geometry[0];
  assert.ok(lat > 40.0 && lat < 40.1 && lon > -83.1 && lon < -83.0, `${lat},${lon}`);
  assert.deepEqual(tileAt(lat, lon, 14), tile, 'point projects back into its own tile');
  const park = layers.park.features.find((f) => f.properties.name);
  assert.ok(park && (park.type === 3 || park.type === 1));
});

test('extractPlaces yields named places of several kinds', () => {
  const places = extractPlaces(decodeTile(bytes, tile));
  assert.ok(places.length > 200);
  const kinds = new Set(places.map((p) => p.kind));
  assert.ok(kinds.has('fast food') && kinds.has('park') && kinds.has('neighbourhood') && kinds.has('road'));
  for (const p of places) assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.name);
});

test('normalize is accent-, case- and apostrophe-blind', () => {
  assert.equal(normalize("Whit’s Frozen Custard"), 'whits frozen custard');
  assert.equal(normalize("St. Mary's-on-the-Hill"), 'st marys on the hill');
  assert.equal(normalize('Café Ólé'), 'cafe ole');
});

test('matchTier: prefix, token prefixes, fuzzy, none', () => {
  const q = (s) => [normalize(s), normalize(s).split(' ')];
  assert.equal(matchTier('whits frozen custard', ...q('whits')), 1);
  assert.equal(matchTier('whits frozen custard', ...q("Whit's")), 1);
  assert.equal(matchTier('glen echo park', ...q('echo park')), 2);
  assert.equal(matchTier('goodale park', ...q('goodal park')), 2, 'a truncated token is a prefix');
  assert.equal(matchTier('goodale park', ...q('goodalr park')), 3, 'one-letter typo on a 7-letter token');
  assert.equal(matchTier('graeters ice cream', ...q('greaters')), 3, 'transposition');
  assert.equal(matchTier('white castle', ...q('whits')), 3, 'one substitution away: fuzzy fallback only');
  assert.equal(matchTier('whetstone park', ...q('whi')), 0, 'very short tokens get no fuzz');
  assert.equal(matchTier('kroger', ...q('target')), 0);
  assert.equal(matchTier('kroger', ...q('troger')), 0, 'first-letter typos are not tolerated');
  assert.equal(matchTier('kroger', ...q('krogre')), 3);
});

test('tilesAround covers the radius', () => {
  const tiles = tilesAround({ lat: 40.0566, lon: -83.0386 }, 5000);
  assert.ok(tiles.length >= 20 && tiles.length <= 60, `${tiles.length}`);
  assert.ok(tiles.some((t) => t.x === 4412 && t.y === 6199));
});

test('PlaceIndex builds from tiles and searches nearest-first within tiers', async () => {
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const idx = new PlaceIndex({ tileUrl: 'x/{z}/{x}/{y}', fetchImpl });
  const center = { lat: 40.0566, lon: -83.0386 };
  const n = await idx.build(center, { radius: 600 });
  assert.ok(n > 100);
  assert.ok(idx.covers(center));
  assert.ok(!idx.covers({ lat: 40.2, lon: -83.0 }));
  const hits = idx.search('white', center);
  assert.ok(hits.length > 0 && hits[0].label.toLowerCase().startsWith('white'));
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1];
    const b = hits[i];
    assert.ok(a.tier < b.tier || (a.tier === b.tier && (a.osm !== b.osm || a.distance <= b.distance + 0.01)), `order at ${i}`);
  }
  assert.deepEqual(idx.search('x', center), [], 'too short');
  const fuzzy = idx.search('wite castle', center);
  assert.ok(fuzzy.some((h) => h.label === 'White Castle'));
});

test('editDistance handles substitutions, insertions and transpositions', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('graeters', 'greaters'), 1);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', 'abcdef', 1), 2, 'capped');
});

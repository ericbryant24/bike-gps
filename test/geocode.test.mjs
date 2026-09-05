import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellingVariants, parseLatLon } from '../js/geocode.js';

test('spelling variants cover straight and curly apostrophes', () => {
  assert.deepEqual(spellingVariants('whits'), ["whit's", 'whit\u2019s']);
  assert.deepEqual(spellingVariants("Whit's"), ['Whit\u2019s', 'Whits']);
  assert.deepEqual(spellingVariants('Whit\u2019s'), ["Whit's", 'Whits']);
  assert.deepEqual(spellingVariants('kroger'), []);
  assert.deepEqual(spellingVariants('bus'), []);
});

test('coordinate parsing', () => {
  assert.deepEqual(parseLatLon('39.96, -83.00'), { lat: 39.96, lon: -83 });
  assert.equal(parseLatLon('Glen Echo'), null);
});

test('Mapbox results normalise to our shape', async () => {
  const { formatMapbox, mapboxSuggest, mapboxForward, MapboxAuthError } = await import('../js/geocode.js');
  const sug = formatMapbox({ name: "Whit's Frozen Custard", mapbox_id: 'abc', feature_type: 'poi', poi_category: ['ice_cream_shop', 'food'], place_formatted: 'Columbus, Ohio', distance: 3500 });
  assert.equal(sug.label, "Whit's Frozen Custard");
  assert.equal(sug.kind, 'ice cream shop');
  assert.equal(sug.distance, 3500);
  assert.equal(sug.lat, undefined);
  const full = formatMapbox({ name: 'X', feature_type: 'address' }, { longitude: -83, latitude: 40 });
  assert.deepEqual([full.lat, full.lon, full.kind], [40, -83, 'address']);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/suggest?')) return { ok: true, status: 200, json: async () => ({ suggestions: [{ name: 'A', mapbox_id: '1', distance: 10 }] }) };
    if (url.includes('/forward?')) return { ok: true, status: 200, json: async () => ({ features: [{ geometry: { coordinates: [-83, 40] }, properties: { name: 'B' } }] }) };
    return { ok: false, status: 401 };
  };
  const s = await mapboxSuggest('a', { token: 'pk.t', session: 's1', near: { lat: 40, lon: -83 }, fetchImpl });
  assert.equal(s[0].mapboxId, '1');
  assert.ok(calls[0].includes('proximity=-83.00000%2C40.00000') && calls[0].includes('session_token=s1') && calls[0].includes('access_token=pk.t'));
  const f = await mapboxForward('b', { token: 'pk.t', bounds: { minLon: -84, minLat: 39, maxLon: -82, maxLat: 41 }, fetchImpl });
  assert.equal(f[0].lat, 40);
  assert.ok(calls[1].includes('bbox=-84%2C39%2C-82%2C41'));
  await assert.rejects(mapboxSuggest('x', { token: 'bad', session: 's', fetchImpl: async () => ({ ok: false, status: 401 }) }), MapboxAuthError);
});

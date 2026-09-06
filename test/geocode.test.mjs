import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellingVariants, parseLatLon, geocodeAddress, search } from '../js/geocode.js';

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

test('geocodeAddress prefers Nominatim and only trusts Photon with a matching house number', async () => {
  const nom = [{ lat: '40.0874016', lon: '-83.0182767', name: '', display_name: '663, North High Street, Worthington, Ohio', address: { road: 'North High Street', city: 'Worthington', state: 'Ohio' }, type: 'house', class: 'place' }];
  const fetchNom = async (url) => (/nominatim/.test(url) ? { ok: true, status: 200, json: async () => nom } : { ok: false, status: 500 });
  const a = await geocodeAddress('663 N High St, Worthington, OH 43085', { fetchImpl: fetchNom });
  assert.equal(a.lat, 40.0874016);
  const photon = { features: [
    { properties: { name: 'Bus stop', housenumber: '', street: 'North High Street', osm_key: 'highway', osm_value: 'bus_stop' }, geometry: { coordinates: [-83.01, 40.09] } },
    { properties: { housenumber: '663', street: 'North High Street', city: 'Worthington', osm_key: 'building', osm_value: 'yes' }, geometry: { coordinates: [-83.0183, 40.0874] } },
  ] };
  const fetchPhoton = async (url) => (/nominatim/.test(url) ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => photon });
  const b = await geocodeAddress('663 N High St, Worthington, OH 43085', { fetchImpl: fetchPhoton });
  assert.equal(b.lon, -83.0183);
  assert.equal(await geocodeAddress('1 Nowhere Rd', { fetchImpl: async () => ({ ok: false, status: 503 }) }), null);
});

test('search: nearby hits beat far ones; addresses go to Nominatim first; far hits only when nothing is near', async () => {
  const near = { lat: 40.05, lon: -83.03 };
  const photonFar = { features: [
    { properties: { name: 'Rosemary Avenue', osm_key: 'highway', osm_value: 'residential', city: 'Southington', state: 'Ohio' }, geometry: { coordinates: [-80.9654, 41.297] } },
    { properties: { name: 'Rosemarie Court', osm_key: 'highway', osm_value: 'residential', city: 'Concord', state: 'Ohio' }, geometry: { coordinates: [-81.2455, 41.6868] } },
  ] };
  const nomHouse = [{ lat: '40.0525243', lon: '-83.0225989', display_name: '4457, Rosemary Parkway, Whetstone, Columbus, Ohio', address: { house_number: '4457', road: 'Rosemary Parkway', suburb: 'Clintonville', city: 'Columbus', state: 'Ohio' }, type: 'house', class: 'place' }];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(/nominatim/.test(url) ? 'nominatim' : 'photon');
    if (/nominatim/.test(url)) return { ok: true, status: 200, json: async () => nomHouse };
    return { ok: true, status: 200, json: async () => photonFar };
  };
  const r = await search('4457 Rosemary pkwy', { near, fetchImpl });
  assert.equal(calls[0], 'nominatim');
  assert.equal(r.length, 1);
  assert.equal(r[0].label, '4457 Rosemary Parkway');
  assert.equal(r[0].address, 'Clintonville, Columbus, Ohio');

  // A name query: Photon first, its far-only hits are held back while Nominatim looks nearby.
  const calls2 = [];
  const fetch2 = async (url) => {
    calls2.push(/nominatim/.test(url) ? 'nominatim' : 'photon');
    if (/nominatim/.test(url)) return { ok: true, status: 200, json: async () => [{ lat: '40.052', lon: '-83.022', name: 'Rosemary Parkway', display_name: 'Rosemary Parkway, Columbus', address: { city: 'Columbus', state: 'Ohio' }, type: 'residential', class: 'highway' }] };
    return { ok: true, status: 200, json: async () => photonFar };
  };
  const r2 = await search('rosemary', { near, fetchImpl: fetch2 });
  assert.equal(calls2[0], 'photon');
  assert.deepEqual(r2.map((x) => x.label), ['Rosemary Parkway']);

  // Nominatim jsonv2 says "category": road segments collapse to one per state and a matching far city is kept.
  const segs = ['Forest Park, Columbus', 'North Linden, Clinton Township', 'Columbus'].map((s, i) => ({ lat: String(40.06 + i / 100), lon: '-82.98', name: 'Cleveland Avenue', display_name: `Cleveland Avenue, ${s}, Ohio`, address: { suburb: s.split(',')[0], city: s.split(',').at(-1).trim(), state: 'Ohio' }, category: 'highway', type: i ? 'primary' : 'secondary' }));
  const city = { lat: '41.5', lon: '-81.7', name: 'Cleveland', display_name: 'Cleveland, Cuyahoga County, Ohio', address: { state: 'Ohio' }, category: 'place', type: 'city' };
  const fetch4 = async (url) => (/nominatim/.test(url) ? { ok: true, status: 200, json: async () => [...segs, city] } : { ok: false, status: 503 });
  const r4 = await search('cleveland', { near, fetchImpl: fetch4 });
  assert.deepEqual(r4.map((x) => `${x.label}|${x.kind}|${x.osm}`), ['Cleveland Avenue|road|highway=secondary', 'Cleveland|city|place=city']);

  // Nothing anywhere near: a few far matches are still offered.
  const fetch3 = async (url) => (/nominatim/.test(url) ? { ok: true, status: 200, json: async () => [] } : { ok: true, status: 200, json: async () => photonFar });
  const r3 = await search('rosemary avenue southington', { near, fetchImpl: fetch3 });
  assert.equal(r3.length, 2);
});

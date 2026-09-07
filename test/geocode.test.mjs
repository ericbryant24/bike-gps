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

test('TomTom results normalise to our shape; far hits drop when something is near; 403 raises TomTomUnavailable', async () => {
  const { formatTomTom, tomtomSearch, TomTomUnavailable } = await import('../js/geocode.js');
  const poi = formatTomTom({ type: 'POI', poi: { name: 'Worthington Tavern', categories: ['restaurant'], classifications: [{ code: 'RESTAURANT', names: [{ nameLocale: 'en-US', name: 'restaurant' }] }] }, address: { freeformAddress: '671 N High St, Worthington, OH 43085', municipality: 'Worthington', countrySubdivision: 'OH' }, position: { lat: 40.0876, lon: -83.0183 } }, 0);
  assert.equal(poi.label, 'Worthington Tavern');
  assert.equal(poi.kind, 'restaurant');
  assert.equal(poi.address, '671 N High St, Worthington, OH 43085');
  assert.equal(poi.tier, 1);
  assert.equal(formatTomTom({ type: 'POI', poi: { name: 'Kroger', classifications: [{ code: 'PETROL_STATION', names: [{ nameLocale: 'en-US', name: 'petrol station' }] }] }, address: {}, position: { lat: 40, lon: -83 } }).kind, 'gas station');
  const addr = formatTomTom({ type: 'Point Address', address: { streetNumber: '4457', streetName: 'Rosemary Parkway', municipality: 'Columbus', countrySubdivision: 'OH', freeformAddress: '4457 Rosemary Parkway, Columbus, OH 43214' }, position: { lat: 40.0525, lon: -83.0226 } }, 4);
  assert.equal(addr.label, '4457 Rosemary Parkway');
  assert.equal(addr.kind, 'address');
  assert.equal(addr.address, 'Columbus, OH');
  assert.equal(addr.tier, 2);
  const city = formatTomTom({ type: 'Geography', entityType: 'Municipality', address: { municipality: 'Cleveland', countrySubdivision: 'OH', freeformAddress: 'Cleveland, OH' }, position: { lat: 41.5, lon: -81.7 } }, 1);
  assert.equal(city.label, 'Cleveland');
  assert.equal(city.kind, 'city');

  const near = { lat: 40.05, lon: -83.03 };
  const body = { results: [
    { type: 'POI', poi: { name: 'Kroger' }, address: { freeformAddress: 'Columbus' }, position: { lat: 40.06, lon: -83.03 }, dist: 1100 },
    { type: 'POI', poi: { name: 'Kroger' }, address: { freeformAddress: 'Denver' }, position: { lat: 39.7, lon: -104.9 }, dist: 1900000 },
    { type: 'Geography', entityType: 'Municipality', address: { municipality: 'Krogerville' }, position: { lat: 35, lon: -90 }, dist: 800000 },
  ] };
  let url = '';
  const fetchImpl = async (u) => { url = u; return { ok: true, status: 200, json: async () => body }; };
  const hits = await tomtomSearch('kroger', { key: 'k', near, typeahead: true, fetchImpl });
  assert.ok(/typeahead=true/.test(url) && /lat=40\.05000/.test(url));
  assert.deepEqual(hits.map((h) => h.address || h.label), ['Columbus', 'Krogerville']);
  assert.equal(hits[0].distance, 1100);
  await assert.rejects(() => tomtomSearch('x', { key: 'k', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ detailedError: { message: 'Request contains an invalid Referer header' } }) }) }), TomTomUnavailable);
  assert.deepEqual(await tomtomSearch('', { key: 'k', fetchImpl }), []);
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

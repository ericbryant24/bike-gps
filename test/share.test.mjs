import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../js/router.js';
import { encodePolyline, decodePolyline, shareUrl, parseSharedRoute, toGpx } from '../js/share.js';
import { distance } from '../js/geo.js';

const route = parseRoute(readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8'));

test('polyline round-trip is exact to 5 decimals', () => {
  const pts = [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }];
  assert.equal(encodePolyline(pts), '_p~iF~ps|U_ulLnnqC_mqNvxq`@'); // Google's reference example
  const back = decodePolyline(encodePolyline(route.points));
  assert.equal(back.length, route.points.length);
  for (let i = 0; i < back.length; i++) assert.ok(distance(back[i], route.points[i]) < 1.2);
});

test('share URL is compact and parses back into a navigable route', () => {
  const url = shareUrl(route, { label: 'Goodale Park', baseUrl: 'https://example.test/bike-gps/' });
  assert.ok(url.length < 1200, `url is ${url.length} chars`);
  const shared = parseSharedRoute(new URL(url).hash);
  assert.ok(shared.shared);
  assert.equal(shared.label, 'Goodale Park');
  assert.ok(Math.abs(shared.length - route.length) < 30, `${shared.length} vs ${route.length}`);
  assert.ok(distance(shared.to, route.to) < 2);
  assert.equal(parseSharedRoute('#foo=bar'), null);
  assert.equal(parseSharedRoute('#r=%%%'), null);
});

test('GPX export contains every point', () => {
  const gpx = toGpx(route, { name: 'Test <ride>' });
  assert.ok(gpx.startsWith('<?xml'));
  assert.equal((gpx.match(/<trkpt /g) || []).length, route.points.length);
  assert.ok(gpx.includes('Test &lt;ride&gt;'));
});

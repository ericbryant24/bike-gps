import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRouteUrl, parseRoute, fetchRoute } from '../js/router.js';

const fixture = readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8');

test('buildRouteUrl produces a BRouter GET url with raw separators', () => {
  const url = buildRouteUrl({ from: { lat: 39.9612, lon: -83.0007 }, to: { lat: 39.98, lon: -83.018 }, profile: 'fastbike', nogos: '-83,39,30', polylines: '1,2,3,4|5,6,7,8' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://brouter.de/brouter');
  assert.equal(u.searchParams.get('lonlats'), '-83.0007,39.9612|-83.018,39.98');
  assert.equal(u.searchParams.get('profile'), 'fastbike');
  assert.equal(u.searchParams.get('nogos'), '-83,39,30');
  assert.equal(u.searchParams.get('polylines'), '1,2,3,4|5,6,7,8');
  assert.equal(u.searchParams.get('timode'), '2');
  assert.equal(u.searchParams.get('format'), 'geojson');
  assert.ok(!url.includes('%2C') && !url.includes('%7C'));
});

test('parseRoute extracts geometry, stats and hints', () => {
  const r = parseRoute(fixture, { profile: 'trekking' });
  assert.equal(r.points.length, 127);
  assert.equal(r.length, 3413);
  assert.equal(r.time, 520);
  assert.equal(r.profile, 'trekking');
  assert.ok(Math.abs(r.cum.at(-1) - 3413) < 30);
});

test('parseRoute turns BRouter text errors into friendly messages', () => {
  assert.throws(() => parseRoute('target island detected for section 0'), /unreachable/);
  assert.throws(() => parseRoute('no track found'), /No route found/);
  assert.throws(() => parseRoute('{"type":"FeatureCollection","features":[]}'), /No route found/);
});

test('fetchRoute uses the injected fetch and passes meta through', async () => {
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, text: async () => fixture };
  };
  const r = await fetchRoute({ from: { lat: 39.9612, lon: -83.0007 }, to: { lat: 39.98, lon: -83.018 }, nogoIds: ['a'] }, { fetchImpl });
  assert.ok(calledUrl.startsWith('https://brouter.de/brouter?lonlats='));
  assert.deepEqual(r.nogoIds, ['a']);
  await assert.rejects(
    fetchRoute({ from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } }, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'operation killed by thread priority watchdog' }) }),
    /busy/
  );
});

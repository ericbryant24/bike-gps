import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRouteUrl, parseRoute, fetchRoute, countHalts, haltsAlong, SIGNAL_WAIT_S, STOP_WAIT_S, PACES } from '../js/router.js';

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
  assert.equal(u.searchParams.get('alternativeidx'), '0');
  assert.ok(!url.includes('%2C') && !url.includes('%7C'));
  assert.equal(new URL(buildRouteUrl({ from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, alternative: 2 })).searchParams.get('alternativeidx'), '2');
  // Rider power override goes through with a raw colon, and never for "shortest".
  const pw = buildRouteUrl({ from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, profile: 'trekking', bikerPower: 85 });
  assert.ok(pw.includes('&profile:bikerPower=85'), pw);
  assert.ok(!buildRouteUrl({ from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, profile: 'shortest', bikerPower: 85 }).includes('bikerPower'));
});

test('parseRoute extracts geometry, stats and hints', () => {
  const r = parseRoute(fixture, { profile: 'trekking' });
  assert.equal(r.points.length, 127);
  assert.equal(r.length, 3413);
  assert.equal(r.rideTime, 520); // BRouter's moving time
  const halts = countHalts(r.segments);
  assert.deepEqual(r.halts, halts);
  // 36 raw signal/stop nodes cluster into the real intersections.
  assert.deepEqual(halts, { signals: 10, stops: 6 });
  const clustered = haltsAlong([
    { along1: 100, nodeTags: 'crossing=traffic_signals' },
    { along1: 112, nodeTags: 'highway=traffic_signals' },
    { along1: 125, nodeTags: 'crossing=traffic_signals' },
    { along1: 300, nodeTags: 'highway=stop' },
    { along1: 327, nodeTags: 'highway=stop' },
    { along1: 900, nodeTags: 'highway=stop' },
    { along1: 930, nodeTags: 'highway=traffic_signals' },
  ]);
  assert.deepEqual(clustered.map((h) => h.kind), ['signal', 'stop', 'signal']);
  assert.equal(r.stopTime, halts.signals * SIGNAL_WAIT_S + halts.stops * STOP_WAIT_S);
  assert.equal(r.time, r.rideTime + r.stopTime);
  assert.equal(r.profile, 'trekking');
  // "shortest" has no speed model: riding time comes from the pace.
  const sh = parseRoute(fixture, { profile: 'shortest', bikerPower: PACES.brisk.power });
  assert.equal(Math.round(sh.rideTime), Math.round(3413 / PACES.brisk.mps));
  assert.equal(sh.stopTime, r.stopTime);
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
  const r = await fetchRoute({ from: { lat: 39.9612, lon: -83.0007 }, to: { lat: 39.98, lon: -83.018 }, nogoIds: ['a'], alternative: 1 }, { fetchImpl });
  assert.ok(calledUrl.startsWith('https://brouter.de/brouter?lonlats='));
  assert.ok(calledUrl.includes('alternativeidx=1'));
  assert.deepEqual(r.nogoIds, ['a']);
  assert.equal(r.alternative, 1);
  await assert.rejects(
    fetchRoute({ from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } }, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'operation killed by thread priority watchdog' }) }),
    /busy/
  );
});

test('routing errors carry a code so callers can soften blocks on "no route"', () => {
  for (const text of ['no track found at pass=0', 'target island detected for section 0']) {
    try {
      parseRoute(text);
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.code, 'no-route', text);
    }
  }
  try {
    parseRoute('operation killed by thread priority watchdog');
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, undefined);
  }
});

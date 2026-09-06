import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../js/router.js';
import { cumulativeDistances, destination } from '../js/geo.js';
import { overlapFraction, sameRoute, dedupeRoutes, exposure, compareAlternatives } from '../js/alternatives.js';

const route = parseRoute(readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8'));

/** A copy of the route with the middle third pushed `metres` sideways. */
function detoured(base, metres) {
  const n = base.points.length;
  const points = base.points.map((p, i) => (i > n / 3 && i < (2 * n) / 3 ? destination(p, 90, metres) : { ...p }));
  const cum = cumulativeDistances(points);
  return { ...base, points, cum, length: cum[cum.length - 1] };
}

test('a route fully overlaps itself and a small wobble still counts as the same route', () => {
  assert.equal(overlapFraction(route, route), 1);
  const wobble = { ...route, points: route.points.map((p) => destination(p, 45, 5)) };
  wobble.cum = cumulativeDistances(wobble.points);
  assert.ok(sameRoute(route, wobble));
});

test('a real detour is a distinct route', () => {
  const alt = detoured(route, 250);
  const overlap = overlapFraction(route, alt);
  assert.ok(overlap > 0.5 && overlap < 0.75, `overlap ${overlap}`);
  assert.ok(!sameRoute(route, alt));
  const deduped = dedupeRoutes([route, { ...route }, alt, detoured(route, 260), null]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0], route);
  assert.equal(deduped[1], alt);
});

test('exposure reports busy-road metres from the segment grades', () => {
  const e = exposure(route);
  assert.ok(Math.abs(e.total - route.cum.at(-1)) < 1);
  assert.equal(e.busy, e.byGrade.D + e.byGrade.E);
  assert.ok(e.busyShare >= 0 && e.busyShare <= 1);
});

test('badges go to the clear winner on traffic, time and distance', () => {
  const quiet = { ...route, time: route.time + 120, length: route.length + 400, segments: route.segments.map((s) => ({ ...s, tags: 'highway=residential' })) };
  const busy = { ...route, segments: route.segments.map((s) => ({ ...s, tags: 'highway=primary' })) };
  const rows = compareAlternatives([busy, quiet]);
  assert.deepEqual(rows[0].badges, ['Fastest', 'Shortest']);
  assert.deepEqual(rows[1].badges, ['Least traffic']);
  assert.ok(rows[1].exposure.busy < rows[0].exposure.busy);
  // A single route earns no badges; ties earn none either.
  assert.deepEqual(compareAlternatives([route])[0].badges, []);
  const tie = compareAlternatives([busy, { ...busy }]);
  assert.deepEqual(tie.map((r) => r.badges), [[], []]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../js/geo.js';

const A = { lat: 39.9612, lon: -83.0007 };
const B = { lat: 39.98, lon: -83.018 };

test('distance and bearing agree with known values', () => {
  assert.ok(Math.abs(g.distance(A, B) - 2558) < 5);
  assert.ok(Math.abs(g.bearing(A, B) - 324.8) < 0.5);
  assert.equal(g.distance(A, A), 0);
});

test('destination inverts distance/bearing', () => {
  const p = g.destination(A, 45, 1000);
  assert.ok(Math.abs(g.distance(A, p) - 1000) < 0.01);
  assert.ok(Math.abs(g.bearing(A, p) - 45) < 0.01);
});

test('angleDiff is signed and wraps', () => {
  assert.equal(g.angleDiff(10, 350), -20);
  assert.equal(g.angleDiff(350, 10), 20);
  assert.equal(g.angleDiff(0, 180), 180);
  assert.equal(g.angleDiff(90, 90), 0);
});

test('snapToPath finds the nearest segment and along-distance', () => {
  const line = [A, g.destination(A, 0, 500), g.destination(A, 90, 500)];
  const cum = g.cumulativeDistances(line);
  const p = g.destination(g.destination(A, 0, 250), 90, 20); // 20 m east of the first leg's midpoint
  const s = g.snapToPath(p, line, cum);
  assert.equal(s.index, 0);
  assert.ok(Math.abs(s.along - 250) < 1);
  assert.ok(Math.abs(s.dist - 20) < 0.5);
});

test('snapToPath prefers the hinted part of a self-overlapping route', () => {
  const up = [A, g.destination(A, 0, 300), g.destination(A, 0, 600)];
  const back = [g.destination(A, 0, 300), A];
  const line = [...up, ...back];
  const cum = g.cumulativeDistances(line);
  const p = g.destination(A, 0, 150);
  const early = g.snapToPath(p, line, cum, 0);
  const late = g.snapToPath(p, line, cum, 3);
  assert.equal(early.index, 0);
  assert.equal(late.index, 3);
});

test('pointAtDistance interpolates and clamps', () => {
  const line = [A, g.destination(A, 90, 1000)];
  const cum = g.cumulativeDistances(line);
  const mid = g.pointAtDistance(line, cum, 500).point;
  assert.ok(Math.abs(g.distance(A, mid) - 500) < 1);
  assert.deepEqual(g.pointAtDistance(line, cum, -5).point, A);
  assert.deepEqual(g.pointAtDistance(line, cum, 5000).point, line[1]);
});

test('simplify removes collinear points but keeps corners', () => {
  const line = [A, g.destination(A, 0, 100), g.destination(A, 0, 200), g.destination(A, 0, 300)];
  assert.equal(g.simplify(line, 1).length, 2);
  const corner = [A, g.destination(A, 0, 300), g.destination(g.destination(A, 0, 300), 90, 300)];
  assert.equal(g.simplify(corner, 1).length, 3);
});

test('slicePath returns the stretch between two off-line points', () => {
  const line = [A, g.destination(A, 0, 200), g.destination(A, 0, 400), g.destination(A, 0, 600)];
  const from = g.destination(g.destination(A, 0, 100), 90, 5);
  const to = g.destination(g.destination(A, 0, 500), 90, 5);
  const s = g.slicePath(line, to, from); // order-insensitive
  assert.ok(Math.abs(g.pathLength(s) - 400) < 1);
  assert.equal(s.length, 4);
});

test('bbox padding and intersection', () => {
  const b = g.bbox([A], 1000);
  assert.ok(g.bboxIntersects(b, g.bbox([g.destination(A, 45, 1200)])));
  assert.ok(!g.bboxIntersects(b, g.bbox([g.destination(A, 45, 3000)])));
});

test('formatting', () => {
  assert.equal(g.formatDistance(2543), '2.5 km');
  assert.equal(g.formatDistance(2543, 'imperial'), '1.6 mi');
  assert.equal(g.formatDistance(87), '90 m');
  assert.equal(g.formatDuration(520), '9 min');
  assert.equal(g.formatDuration(3720), '1 h 02 min');
  assert.equal(g.compassName(324.8), 'northwest');
  assert.equal(g.speakDistance(480, 'imperial'), 'a quarter mile');
});

test('cameraShouldMove skips GPS jitter while stationary but follows real movement', () => {
  const p = { lat: 40.0, lon: -83.0, heading: 90 };
  assert.equal(g.cameraShouldMove(null, p), true);
  assert.equal(g.cameraShouldMove(p, { lat: 40.00001, lon: -83.00001, heading: 91 }), false); // ~1.4 m, 1°
  assert.equal(g.cameraShouldMove(p, { lat: 40.00005, lon: -83.0, heading: 90 }), true); // ~5.5 m
  assert.equal(g.cameraShouldMove(p, { lat: 40.0, lon: -83.0, heading: 100 }), true); // turned 10°
  assert.equal(g.cameraShouldMove(p, { lat: 40.0, lon: -83.0, heading: null }), true); // heading lost
  assert.equal(g.cameraShouldMove({ lat: 40, lon: -83, heading: null }, { lat: 40, lon: -83, heading: null }), false);
  assert.equal(g.cameraShouldMove(p, { lat: 40.00001, lon: -83.0, heading: 92 }, { minTurn: 1 }), true);
});

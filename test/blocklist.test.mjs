import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../js/geo.js';
import * as bl from '../js/blocklist.js';

const A = { lat: 39.9612, lon: -83.0007 };
const road = [A, g.destination(A, 90, 100), g.destination(A, 90, 200), g.destination(A, 90, 300)];

test('gates are perpendicular, centred on the road, and spaced along it', () => {
  const gates = bl.gatesForLine(road);
  assert.ok(gates.length >= 8 && gates.length <= 12, `got ${gates.length}`);
  const cum = g.cumulativeDistances(road);
  for (const [p, q] of gates) {
    assert.ok(Math.abs(g.distance(p, q) - 2 * bl.GATE_HALF_WIDTH) < 0.05);
    const mid = g.interpolate(p, q, 0.5);
    assert.ok(g.snapToPath(mid, road, cum, 0, road.length).dist < 0.05);
    assert.ok(Math.abs(Math.abs(g.angleDiff(g.bearing(p, q), 90)) - 90) < 1, 'gate is perpendicular to the road');
  }
});

test('with junctions known, gates sit between junctions and away from them', () => {
  const junctions = [g.destination(A, 90, 100), g.destination(A, 90, 200)];
  const gates = bl.gatesForLine(road, { junctions });
  assert.equal(gates.length, 3); // one per 100 m run
  for (const [p, q] of gates) {
    const mid = g.interpolate(p, q, 0.5);
    for (const j of [A, ...junctions, road.at(-1)]) assert.ok(g.distance(mid, j) > 40);
  }
});

test('short runs between close junctions get no gate rather than a bad one', () => {
  const junctions = [g.destination(A, 90, 2), g.destination(A, 90, 6)];
  const gates = bl.gatesForLine([A, g.destination(A, 90, 8)], { junctions });
  assert.equal(gates.length, 0);
});

test('toNogoParams formats circles and gates, filters by bbox, tracks used ids', () => {
  const point = bl.createPoint(A, { radius: 30, name: 'pothole' });
  const stretch = bl.createStretch(road, { name: 'Main St' });
  const far = bl.createPoint(g.destination(A, 0, 50000), { radius: 30 });
  const off = { ...bl.createPoint(A), enabled: false };
  const params = bl.toNogoParams([point, stretch, far, off], g.bbox([A, g.destination(A, 90, 300)], 1000));
  assert.match(params.nogos, /^-83\.0007,39\.9612,30$/);
  const gates = params.polylines.split('|');
  assert.ok(gates.length >= 8);
  for (const gate of gates) assert.equal(gate.split(',').length, 4);
  assert.deepEqual(params.used, [point.id, stretch.id]);
  assert.equal(params.truncated, false);
});

test('toNogoParams respects the point budget and reports truncation', () => {
  const stretch = bl.createStretch(road, { name: 'Main St' });
  const params = bl.toNogoParams([stretch], null, { maxPoints: 4 });
  assert.equal(params.polylines, '');
  assert.equal(params.truncated, true);
});

test('normalizeEntry recovers stored entries and rejects junk', () => {
  const stored = JSON.parse(JSON.stringify(bl.createRoad([road], { name: 'Main St' })));
  delete stored.length;
  const e = bl.normalizeEntry(stored);
  assert.equal(e.kind, 'road');
  assert.ok(Math.abs(e.length - 300) < 1);
  assert.equal(bl.normalizeEntry({ id: 'x', kind: 'point' }), null);
  assert.equal(bl.normalizeEntry(null), null);
  assert.equal(bl.normalizeEntry({ id: 'x', kind: 'road', lines: [] }), null);
});

test('distanceToEntry', () => {
  const point = bl.createPoint(A, { radius: 30 });
  assert.equal(bl.distanceToEntry(point, A), 0);
  assert.ok(Math.abs(bl.distanceToEntry(point, g.destination(A, 0, 100)) - 70) < 0.5);
  const stretch = bl.createStretch(road);
  assert.ok(Math.abs(bl.distanceToEntry(stretch, g.destination(g.destination(A, 90, 150), 0, 40)) - 40) < 0.5);
});

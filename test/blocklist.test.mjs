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

test('toNogoParams packs a byte budget nearest the focus line first, never dropping an entry wholesale', () => {
  const longRoad = [A, g.destination(A, 90, 2000)];
  const stretch = bl.createStretch(longRoad, { name: 'Long St' });
  const full = bl.toNogoParams([stretch], null);
  assert.ok(full.polylines.split('|').length > 40);
  // Focus on the western end: only gates near it should survive a tiny budget.
  const focus = [g.destination(A, 0, 100), g.destination(A, 180, 100)];
  const tight = bl.toNogoParams([stretch], null, { maxBytes: 300, focus });
  assert.equal(tight.truncated, true);
  assert.ok(tight.dropped > 0 && tight.total === full.polylines.split('|').length);
  assert.deepEqual(tight.used, [stretch.id], 'the entry is still used, just thinned');
  for (const gate of tight.polylines.split('|')) {
    const [lon, lat] = gate.split(',').map(Number);
    assert.ok(g.distance(A, { lat, lon }) < 400, `kept gate should be near the focus, was ${Math.round(g.distance(A, { lat, lon }))} m away`);
  }
});

test('toNogoParams can soften blocks into weighted penalties', () => {
  const stretch = bl.createStretch(road, { name: 'Main St', junctions: [g.destination(A, 90, 100)] });
  const soft = bl.toNogoParams([stretch], null, { weight: bl.SOFT_WEIGHT });
  for (const gate of soft.polylines.split('|')) assert.equal(gate.split(',').length, 5);
  for (const c of soft.nogos.split('|')) assert.match(c, /,100$/);
});

test('entriesUsedByRoute reports how far a route rides along a blocked road', () => {
  const stretch = bl.createStretch(road, { name: 'Main St' });
  const along = { points: [g.destination(A, 90, 50), g.destination(A, 90, 250)] };
  along.cum = g.cumulativeDistances(along.points);
  const used = bl.entriesUsedByRoute(along, [stretch]);
  assert.equal(used.length, 1);
  assert.ok(Math.abs(used[0].meters - 200) < 30, `${used[0].meters}`);
  const parallel = { points: [g.destination(A, 0, 60), g.destination(g.destination(A, 90, 300), 0, 60)] };
  parallel.cum = g.cumulativeDistances(parallel.points);
  assert.equal(bl.entriesUsedByRoute(parallel, [stretch]).length, 0);
  const crossing = { points: [g.destination(g.destination(A, 90, 150), 0, 100), g.destination(g.destination(A, 90, 150), 180, 100)] };
  crossing.cum = g.cumulativeDistances(crossing.points);
  assert.equal(bl.entriesUsedByRoute(crossing, [stretch]).length, 0, 'merely crossing is not using');
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

test('blocks next to the start/destination are relaxed so the rider can leave or reach them', () => {
  const stretch = bl.createStretch(road, { name: 'Main St' });
  const all = bl.toNogoParams([stretch], null).polylines.split('|').length;
  const relaxed = bl.toNogoParams([stretch], null, { relaxAround: [{ point: A }] });
  const kept = relaxed.polylines.split('|').filter(Boolean).length;
  assert.ok(kept > 0 && kept < all, `${kept} of ${all} gates kept`);
  for (const gate of relaxed.polylines.split('|')) {
    const [lon, lat] = gate.split(',').map(Number);
    assert.ok(g.distance(A, { lat, lon }) > bl.RELAX_RADIUS);
  }
  // A spot block containing the start is skipped entirely.
  const spot = bl.createPoint(g.destination(A, 0, 40), { radius: 30 });
  assert.equal(bl.toNogoParams([spot], null, { relaxAround: [{ point: A }] }).nogos, '');
  assert.notEqual(bl.toNogoParams([spot], null).nogos, '');
});

test('crossable junctions: interior ones count, T-ends do not, split ways are joined', () => {
  const j1 = g.destination(A, 90, 100); // interior vertex of a single way
  const end = g.destination(A, 90, 300); // the road ends here (T)
  const single = bl.createRoad([road], { junctions: [A, j1, end] });
  assert.deepEqual(bl.crossableJunctions(single), [j1]);
  // Same road split into two OSM ways at j1: still interior.
  const split = bl.createRoad([[A, j1], [j1, g.destination(A, 90, 200), end]], { junctions: [A, j1, end] });
  assert.deepEqual(bl.crossableJunctions(split), [j1]);
});

test("'signals' rule closes unsignalled junctions with small circles; 'all' does not", () => {
  const j1 = g.destination(A, 90, 100);
  const j2 = g.destination(A, 90, 200);
  const lit = bl.createRoad([road], { junctions: [j1, j2], signals: [g.destination(j2, 0, 10)] });
  const blocks = bl.junctionBlocksForEntry(lit);
  assert.equal(blocks.length, 1);
  assert.ok(g.distance(blocks[0], j1) < 0.01, 'only the junction without a light is closed');
  const params = bl.toNogoParams([lit], null);
  assert.equal(params.nogos.split('|').length, 1);
  assert.match(params.nogos, new RegExp(`,${bl.JUNCTION_BLOCK_RADIUS}$`));
  const open = bl.createRoad([road], { junctions: [j1, j2], crossing: 'all' });
  assert.equal(bl.junctionBlocksForEntry(open).length, 0);
  assert.equal(bl.toNogoParams([open], null).nogos, '');
});

test('crossing rule and signals survive storage round-trips; unknown rules fall back', () => {
  const e = bl.createRoad([road], { junctions: [g.destination(A, 90, 100)], signals: [A], crossing: 'all' });
  const back = bl.normalizeEntry(JSON.parse(JSON.stringify(e)));
  assert.equal(back.crossing, 'all');
  assert.equal(back.signals.length, 1);
  assert.equal(bl.normalizeEntry({ ...JSON.parse(JSON.stringify(e)), crossing: 'bogus' }).crossing, bl.DEFAULT_CROSSING);
  assert.equal(bl.createStretch(road).crossing, 'signals');
});

test('without traffic-light data the signals rule leaves junctions open; wide gates for tile geometry', () => {
  const j1 = g.destination(A, 90, 100);
  const unknown = bl.createRoad([road], { junctions: [j1], signalsKnown: false, gateHalfWidth: 10, source: 'tiles' });
  assert.equal(bl.junctionBlocksForEntry(unknown).length, 0);
  const gate = bl.toNogoParams([unknown], null).polylines.split('|')[0].split(',').map(Number);
  assert.ok(Math.abs(g.distance({ lon: gate[0], lat: gate[1] }, { lon: gate[2], lat: gate[3] }) - 20) < 0.1, 'gate is 2×10 m wide');
  const back = bl.normalizeEntry(JSON.parse(JSON.stringify(unknown)));
  assert.equal(back.signalsKnown, false);
  assert.equal(back.gateHalfWidth, 10);
  // Legacy entries (no flag) are treated as known.
  const legacy = bl.normalizeEntry({ ...JSON.parse(JSON.stringify(unknown)), signalsKnown: undefined });
  assert.equal(legacy.signalsKnown, true);
});

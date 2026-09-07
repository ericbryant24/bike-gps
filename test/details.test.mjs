import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRing, ringArea, formatArea, parkRings, amenitiesIn, describeAmenities, formatHours, pickWikiTitle } from '../js/details.js';

// A ~200 m × 100 m rectangle near Columbus (lon spans 200 m, lat spans 100 m).
const dLon = 200 / (111320 * Math.cos((40 * Math.PI) / 180));
const dLat = 100 / 111320;
const RECT = [[-83.0, 40.0], [-83.0 + dLon, 40.0], [-83.0 + dLon, 40.0 + dLat], [-83.0, 40.0 + dLat], [-83.0, 40.0]];

test('point-in-ring and ring area', () => {
  assert.equal(pointInRing({ lat: 40.0 + dLat / 2, lon: -83.0 + dLon / 2 }, RECT), true);
  assert.equal(pointInRing({ lat: 40.0 + dLat * 2, lon: -83.0 + dLon / 2 }, RECT), false);
  const a = ringArea(RECT);
  assert.ok(Math.abs(a - 20000) < 200, `area ${a}`);
  assert.equal(formatArea(20000, 'imperial'), '4.9 acres');
  assert.equal(formatArea(20000, 'metric'), '2.0 ha');
  assert.equal(formatArea(0), '');
});

test('park rings by name or containment; amenities inside, counted and described', () => {
  const hole = [[-83.0 + dLon * 0.4, 40.0 + dLat * 0.4], [-83.0 + dLon * 0.5, 40.0 + dLat * 0.4], [-83.0 + dLon * 0.5, 40.0 + dLat * 0.5], [-83.0 + dLon * 0.4, 40.0 + dLat * 0.5], [-83.0 + dLon * 0.4, 40.0 + dLat * 0.4]];
  const layers = {
    landcover: { features: [
      { type: 3, properties: { class: 'grass', subclass: 'park' }, geometry: [RECT, hole] },
      { type: 3, properties: { class: 'grass', subclass: 'park' }, geometry: [[[-82.9, 40.1], [-82.89, 40.1], [-82.89, 40.11], [-82.9, 40.11], [-82.9, 40.1]]] },
    ] },
    park: { features: [{ type: 1, properties: { name: 'Glen Echo Park', class: 'park' }, geometry: [[-83.0 + dLon * 0.5, 40.0 + dLat * 0.2]] }] },
    poi: { features: [
      { type: 1, properties: { class: 'playground', subclass: 'playground' }, geometry: [[-83.0 + dLon * 0.2, 40.0 + dLat * 0.2]] },
      { type: 1, properties: { class: 'playground', subclass: 'playground' }, geometry: [[-83.0 + dLon * 0.8, 40.0 + dLat * 0.8]] },
      { type: 1, properties: { class: 'toilets', subclass: 'toilets' }, geometry: [[-83.0 + dLon * 0.6, 40.0 + dLat * 0.6]] },
      { type: 1, properties: { class: 'bicycle_parking', subclass: 'bicycle_parking' }, geometry: [[-83.0 + dLon * 0.1, 40.0 + dLat * 0.9]] },
      { type: 1, properties: { class: 'waste_basket', subclass: 'waste_basket' }, geometry: [[-83.0 + dLon * 0.3, 40.0 + dLat * 0.3]] },
      { type: 1, properties: { class: 'playground', subclass: 'playground' }, geometry: [[-82.5, 40.5]] }, // outside
    ] },
    water_name: { features: [{ type: 1, properties: { class: 'pond', name: 'Duck Pond' }, geometry: [[-83.0 + dLon * 0.7, 40.0 + dLat * 0.3]] }] },
  };
  const byName = parkRings(layers, { lat: 40.5, lon: -82.5 }, 'Glen Echo Park'); // point outside: found via the label inside
  assert.equal(byName.rings.length, 2);
  const byPoint = parkRings(layers, { lat: 40.0 + dLat / 2, lon: -83.0 + dLon / 2 }, 'Something Else');
  assert.equal(byPoint.rings.length, 2);
  assert.equal(parkRings(layers, { lat: 41, lon: -84 }, 'Nowhere'), null);
  const am = amenitiesIn(layers, byName.rings);
  assert.deepEqual(am.map((a) => [a.label, a.count]), [['playground', 2], ['bike racks', 1], ['Duck Pond (pond)', 1], ['restrooms', 1]]);
  assert.equal(describeAmenities(am), '2 playgrounds, bike racks, Duck Pond (pond), restrooms');
});

test('TomTom opening hours → today, open/closed now, closes/opens', () => {
  const oh = { mode: 'nextSevenDays', timeRanges: [
    { startTime: { date: '2026-09-08', hour: 16, minute: 0 }, endTime: { date: '2026-09-08', hour: 22, minute: 0 } },
    { startTime: { date: '2026-09-09', hour: 11, minute: 0 }, endTime: { date: '2026-09-09', hour: 14, minute: 30 } },
    { startTime: { date: '2026-09-09', hour: 17, minute: 0 }, endTime: { date: '2026-09-10', hour: 0, minute: 0 } },
  ] };
  const open = formatHours(oh, new Date('2026-09-08T18:00:00'), 'en-US');
  assert.equal(open.openNow, true);
  assert.equal(open.today, '4 PM – 10 PM');
  assert.equal(open.closesAt, '10 PM');
  const closed = formatHours(oh, new Date('2026-09-08T09:00:00'), 'en-US');
  assert.equal(closed.openNow, false);
  assert.equal(closed.opensAt, '4 PM');
  const split = formatHours(oh, new Date('2026-09-09T15:00:00'), 'en-US');
  assert.equal(split.today, '11 AM – 2:30 PM, 5 PM – 12 AM');
  assert.equal(split.openNow, false);
  assert.equal(split.opensAt, '5 PM');
  assert.equal(formatHours(oh, new Date('2026-09-11T12:00:00'), 'en-US').today, 'Closed today');
  assert.equal(formatHours(null), null);
});

test('Wikipedia title matching: same place only, nearby only', () => {
  const hits = [
    { title: 'Gilbert H. Hamilton House', dist: 286 },
    { title: 'Glen Echo (Columbus, Ohio)', dist: 699 },
    { title: 'Goodale Park', dist: 40 },
    { title: 'Goodale Park Music Series', dist: 60 },
  ];
  assert.equal(pickWikiTitle('Goodale Park', hits).title, 'Goodale Park');
  assert.equal(pickWikiTitle('Glen Echo Park', hits), null); // the neighbourhood article is 700 m off and not the park
  assert.equal(pickWikiTitle('Glen Echo Park', [{ title: 'Glen Echo Park (Columbus, Ohio)', dist: 120 }]).title, 'Glen Echo Park (Columbus, Ohio)');
  assert.equal(pickWikiTitle("Whit's Frozen Custard", hits), null);
});

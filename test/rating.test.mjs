import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../js/router.js';
import { stepsFromVoiceHints, announceableSteps } from '../js/instructions.js';
import { rateTags, rateSegments, routeComposition, rateSteps, gradeRuns, parseTags } from '../js/rating.js';

const route = parseRoute(readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8'));

test('segments map onto the track and cover its whole length', () => {
  assert.ok(route.segments.length > 10);
  const covered = route.segments.reduce((a, s) => a + s.distance, 0);
  assert.ok(Math.abs(covered - route.cum.at(-1)) < 1, `${covered} vs ${route.cum.at(-1)}`);
  for (let i = 1; i < route.segments.length; i++) assert.equal(route.segments[i].i0, route.segments[i - 1].i1, 'segments are contiguous');
  assert.equal(route.segments[0].i0, 0);
  assert.equal(route.segments.at(-1).i1, route.points.length - 1);
});

test('tag grading', () => {
  assert.equal(rateTags('highway=cycleway surface=asphalt').grade, 'A');
  assert.equal(rateTags('highway=residential').grade, 'B');
  assert.equal(rateTags('highway=tertiary').grade, 'C');
  assert.equal(rateTags('highway=secondary').grade, 'D');
  assert.equal(rateTags('highway=primary').grade, 'E');
  const laned = rateTags('highway=primary cycleway=lane');
  assert.equal(laned.grade, 'D');
  assert.ok(laned.notes.includes('painted bike lane'));
  const protectedLane = rateTags('highway=secondary cycleway:right=track');
  assert.equal(protectedLane.grade, 'A');
  const fast = rateTags('highway=secondary maxspeed=45 mph');
  assert.ok(fast.score < rateTags('highway=secondary').score);
  assert.equal(rateTags('highway=residential cycleway=shared_lane route_bicycle_lcn=yes maxspeed=20 mph').grade, 'B', 'a street never grades A without separation');
  const slow = rateTags('highway=residential maxspeed=20 mph');
  assert.ok(slow.notes.includes('low speed limit'));
  const gravel = rateTags('highway=track surface=gravel');
  assert.ok(gravel.notes.includes('unpaved'));
  assert.ok(rateTags('highway=footway').notes.includes('walk your bike'));
  assert.deepEqual(parseTags('a=1 b=x=y maxspeed=45 mph'), { a: '1', b: 'x=y', maxspeed: '45 mph' });
});

test('route composition and per-step ratings from the fixture', () => {
  const rated = rateSegments(route);
  const comp = routeComposition(rated);
  assert.ok(Math.abs(comp.total - route.cum.at(-1)) < 1);
  assert.ok(comp.score > 0 && comp.score <= 100);
  assert.ok(['A', 'B', 'C', 'D', 'E'].includes(comp.grade));
  const steps = announceableSteps(stepsFromVoiceHints(route.voicehints, route.points, route.cum));
  rateSteps(steps, rated);
  const withRating = steps.filter((s) => s.rating);
  assert.ok(withRating.length >= steps.length - 1, 'every step except arrival has a rating');
  for (const s of withRating) {
    assert.ok(s.rating.kind);
    const sum = Object.values(s.rating.byGrade).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - s.distToNext) < 1, `step coverage ${sum} vs ${s.distToNext}`);
  }
  const runs = gradeRuns(route, rated);
  assert.ok(runs.length >= 1);
  assert.equal(runs[0].i0, 0);
  assert.equal(runs.at(-1).i1, route.points.length - 1);
  for (let i = 1; i < runs.length; i++) assert.notEqual(runs[i].grade, runs[i - 1].grade);
});

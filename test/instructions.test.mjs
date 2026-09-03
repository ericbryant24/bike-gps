import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../js/router.js';
import { stepsFromVoiceHints, stepsFromGeometry, applyNames, announceableSteps, classifyAngle, stepText } from '../js/instructions.js';

const fixture = readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8');
const route = parseRoute(fixture);

test('fixture parses with voicehints', () => {
  assert.equal(route.length, 3413);
  assert.equal(route.points.length, 127);
  assert.ok(route.voicehints.length > 5);
});

test('voicehint steps start with depart, end with arrive, increase monotonically', () => {
  const steps = stepsFromVoiceHints(route.voicehints, route.points, route.cum);
  assert.equal(steps[0].kind, 'depart');
  assert.equal(steps.at(-1).kind, 'arrive');
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].along >= steps[i - 1].along);
  const sum = steps.reduce((acc, s) => acc + s.distToNext, 0);
  assert.ok(Math.abs(sum - route.cum.at(-1)) < 1);
  // First hint in the fixture is a left turn (command 2, angle -89).
  assert.equal(steps[1].kind, 'turn');
  assert.equal(steps[1].modifier, 'left');
  assert.equal(steps[1].text, 'Turn left');
});

test('unnamed continue steps are filtered from announcements; named ones kept', () => {
  const steps = stepsFromVoiceHints(route.voicehints, route.points, route.cum);
  const before = announceableSteps(steps).length;
  assert.ok(before < steps.length, 'fixture contains straight-through hints that should be dropped');
  applyNames(steps, (s) => (s.kind === 'continue' ? 'New Road' : null));
  const after = announceableSteps(steps);
  assert.ok(after.length > before);
  assert.ok(after.some((s) => s.text === 'Continue onto New Road'));
});

test('applyNames drops the name when it does not change', () => {
  const steps = stepsFromVoiceHints(route.voicehints, route.points, route.cum);
  applyNames(steps, () => 'Same Street');
  assert.equal(steps[0].text, 'Head northwest on Same Street'.replace('northwest', steps[0].text.split(' ')[1]));
  assert.equal(steps[1].name, null);
  assert.equal(steps[1].text, 'Turn left');
});

test('geometric fallback finds the same major turns as BRouter', () => {
  const hints = stepsFromVoiceHints(route.voicehints, route.points, route.cum).filter((s) => s.kind === 'turn' && !s.modifier.startsWith('slight'));
  const geo = stepsFromGeometry(route.points, route.cum).filter((s) => s.kind === 'turn');
  // Every real turn should have a geometric turn within 30 m.
  for (const h of hints) assert.ok(geo.some((s) => Math.abs(s.along - h.along) < 30), `missing turn at ${h.along}`);
});

test('classifyAngle thresholds', () => {
  assert.equal(classifyAngle(5), 'straight');
  assert.equal(classifyAngle(-35), 'slight-left');
  assert.equal(classifyAngle(90), 'right');
  assert.equal(classifyAngle(-140), 'sharp-left');
  assert.equal(classifyAngle(175), 'uturn');
});

test('stepText variants', () => {
  assert.equal(stepText({ kind: 'roundabout', exit: 2, name: 'High St' }), 'At the roundabout, take the 2nd exit onto High St');
  assert.equal(stepText({ kind: 'keep', modifier: 'left' }), 'Keep left');
  assert.equal(stepText({ kind: 'turn', modifier: 'sharp-right', name: 'Elm' }), 'Turn sharp right onto Elm');
  assert.equal(stepText({ kind: 'arrive' }), 'Arrive at your destination');
});

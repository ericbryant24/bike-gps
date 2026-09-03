import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../js/router.js';
import { stepsFromVoiceHints, announceableSteps } from '../js/instructions.js';
import { Navigator } from '../js/navigator.js';
import { destination, pointAtDistance } from '../js/geo.js';

const route = parseRoute(readFileSync(new URL('./fixtures/route.json', import.meta.url), 'utf8'));
const steps = announceableSteps(stepsFromVoiceHints(route.voicehints, route.points, route.cum));

function ride(nav, { step = 6, offsetAt = null, offsetM = 0 } = {}) {
  const spoken = [];
  const events = { offroute: 0, arrive: 0 };
  nav.on('speak', (s) => spoken.push(s.text));
  nav.on('offroute', () => events.offroute++);
  nav.on('arrive', () => events.arrive++);
  nav.start();
  let t = 0;
  for (let d = 0; d <= route.length; d += step) {
    let { point } = pointAtDistance(route.points, route.cum, d);
    if (offsetAt && d >= offsetAt[0] && d <= offsetAt[1]) point = destination(point, 90, offsetM);
    nav.update({ ...point, accuracy: 6, heading: null, speed: 6, timestamp: (t += 1000) });
  }
  return { spoken, events, state: nav.state };
}

test('a clean ride announces departure, every turn, and arrival exactly once', () => {
  const nav = new Navigator({ route, steps, units: 'metric' });
  const { spoken, events, state } = ride(nav);
  assert.ok(spoken[0].startsWith('Head '), spoken[0]);
  const turns = steps.filter((s) => s.kind !== 'depart' && s.kind !== 'arrive');
  for (const s of turns) assert.ok(spoken.some((x) => x.includes(s.text.charAt(0).toLowerCase() + s.text.slice(1)) || x.includes(s.text)), `never spoke: ${s.text}`);
  assert.equal(spoken.filter((x) => x.startsWith('You have arrived')).length, 1);
  assert.equal(events.arrive, 1);
  assert.equal(events.offroute, 0);
  assert.ok(state.arrived);
  assert.ok(state.remaining < 25);
});

test('early warnings come before the immediate prompt for long legs', () => {
  const nav = new Navigator({ route, steps, units: 'metric' });
  const { spoken } = ride(nav);
  const longLeg = steps.find((s, i) => i > 0 && s.along - steps[i - 1].along > 400 && s.kind !== 'arrive');
  assert.ok(longLeg, 'fixture has a long leg');
  const lowered = longLeg.text.charAt(0).toLowerCase() + longLeg.text.slice(1);
  const early = spoken.findIndex((x) => x.startsWith('In ') && x.endsWith(lowered));
  const now = spoken.findIndex((x, i) => i > early && x.startsWith(longLeg.text));
  assert.ok(early >= 0, 'early warning spoken');
  assert.ok(now > early, 'immediate prompt after early warning');
});

test('off-route is declared after several consecutive far fixes, then clears', () => {
  const nav = new Navigator({ route, steps, units: 'metric', offRouteMeters: 40 });
  const { events, spoken, state } = ride(nav, { offsetAt: [800, 1000], offsetM: 90 });
  assert.equal(events.offroute, 1);
  assert.ok(spoken.includes('Off route. Recalculating.'));
  assert.ok(!state.offRoute, 'back on route by the end');
  assert.ok(state.arrived);
});

test('a single GPS glitch does not trigger off-route', () => {
  const nav = new Navigator({ route, steps, units: 'metric', offRouteMeters: 40 });
  const { events } = ride(nav, { offsetAt: [800, 806], offsetM: 200 });
  assert.equal(events.offroute, 0);
});

test('setRoute resets announcements so a reroute speaks again', () => {
  const nav = new Navigator({ route, steps, units: 'metric' });
  ride(nav);
  nav.setRoute(route, steps);
  const spoken = [];
  nav.on('speak', (s) => spoken.push(s.text));
  nav.start();
  assert.ok(spoken.length === 1 && spoken[0].startsWith('Head '));
});

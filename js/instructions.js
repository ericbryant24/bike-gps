// Turn-by-turn maneuver synthesis.
//
// Primary source: BRouter's `voicehints` (junction-aware, produced by the
// routing engine). Fallback: geometric detection from bearing changes when
// hints are missing. Both produce the same step shape:
//
//   { index, at, along, kind, modifier, exit, angle, name, text, distToNext }
//
// `along` is metres from route start; `distToNext` metres to the next step.

import { angleDiff, bearing, compassName, distance } from './geo.js';

// BRouter VoiceHint command codes.
const BROUTER_COMMANDS = {
  1: { kind: 'continue', modifier: 'straight' },
  2: { kind: 'turn', modifier: 'left' },
  3: { kind: 'turn', modifier: 'slight-left' },
  4: { kind: 'turn', modifier: 'sharp-left' },
  5: { kind: 'turn', modifier: 'right' },
  6: { kind: 'turn', modifier: 'slight-right' },
  7: { kind: 'turn', modifier: 'sharp-right' },
  8: { kind: 'keep', modifier: 'left' },
  9: { kind: 'keep', modifier: 'right' },
  10: { kind: 'uturn', modifier: 'left' },
  11: { kind: 'uturn', modifier: 'uturn' },
  12: { kind: 'uturn', modifier: 'right' },
  13: null, // off-route marker; not a maneuver
  14: { kind: 'roundabout', modifier: 'right' },
  15: { kind: 'roundabout', modifier: 'left' },
  16: { kind: 'continue', modifier: 'straight' }, // beeline
  17: { kind: 'arrive', modifier: 'straight' },
};

export const MODIFIER_LABEL = {
  straight: 'Continue straight',
  left: 'Turn left',
  right: 'Turn right',
  'slight-left': 'Bear left',
  'slight-right': 'Bear right',
  'sharp-left': 'Turn sharp left',
  'sharp-right': 'Turn sharp right',
  uturn: 'Make a U-turn',
};

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** Build the spoken/displayed text for a step (regenerated when a name arrives). */
export function stepText(step) {
  const onto = step.name ? ` onto ${step.name}` : '';
  switch (step.kind) {
    case 'depart':
      return `Head ${compassName(step.angle)}${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return step.name ? `Arrive at ${step.name}` : 'Arrive at your destination';
    case 'continue':
      return step.name ? `Continue onto ${step.name}` : 'Continue straight';
    case 'keep':
      return `Keep ${step.modifier}${onto}`;
    case 'uturn':
      return `Make a U-turn${onto}`;
    case 'roundabout': {
      const ex = step.exit > 0 && step.exit < ORDINALS.length ? `take the ${ORDINALS[step.exit]} exit` : 'take the exit';
      return `At the roundabout, ${ex}${onto}`;
    }
    default:
      return `${MODIFIER_LABEL[step.modifier] || 'Turn'}${onto}`;
  }
}

/** Bearing of the path a short distance after `index`, used for depart text. */
function bearingAfter(points, index, lookAhead = 25) {
  let acc = 0;
  let j = index;
  while (j < points.length - 1 && acc < lookAhead) {
    acc += distance(points[j], points[j + 1]);
    j++;
  }
  return bearing(points[index], points[Math.max(index + 1, j)] || points[points.length - 1]);
}

function finalize(steps, points, cum) {
  const total = cum[cum.length - 1];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    s.along = cum[s.index];
    s.distToNext = i + 1 < steps.length ? cum[steps[i + 1].index] - s.along : total - s.along;
    s.text = stepText(s);
  }
  return steps;
}

/**
 * Convert BRouter voicehints into steps. `hints` rows are
 * [trackIndex, command, roundaboutExit, distanceToNext, angle].
 */
export function stepsFromVoiceHints(hints, points, cum) {
  const steps = [];
  const last = points.length - 1;
  steps.push({ index: 0, at: points[0], kind: 'depart', modifier: 'straight', angle: bearingAfter(points, 0), exit: 0 });
  for (const h of hints || []) {
    const [idx, cmd, exit, , angle] = h;
    const def = BROUTER_COMMANDS[cmd];
    if (!def || idx <= 0 || idx >= last) continue;
    // Beeline / straight hints only earn a step if they later get a name.
    steps.push({ index: idx, at: points[idx], kind: def.kind, modifier: def.modifier, exit: exit || 0, angle: angle || 0 });
  }
  steps.push({ index: last, at: points[last], kind: 'arrive', modifier: 'straight', angle: 0, exit: 0 });
  // Deduplicate identical indices (keep the later, more specific one).
  const dedup = [];
  for (const s of steps) {
    if (dedup.length && dedup[dedup.length - 1].index === s.index && s.kind !== 'arrive') dedup.pop();
    dedup.push(s);
  }
  return finalize(dedup, points, cum);
}

/** Classify a signed turn angle (negative = left) into a modifier. */
export function classifyAngle(angle) {
  const a = Math.abs(angle);
  const side = angle < 0 ? 'left' : 'right';
  if (a < 25) return 'straight';
  if (a < 50) return `slight-${side}`;
  if (a < 125) return side;
  if (a < 160) return `sharp-${side}`;
  return 'uturn';
}

/**
 * Geometric fallback: detect turns from bearing changes measured over a
 * smoothing window so dense vertices on curves don't register as turns.
 */
export function stepsFromGeometry(points, cum, { window = 15, minAngle = 30, mergeWithin = 20 } = {}) {
  const last = points.length - 1;
  const steps = [{ index: 0, at: points[0], kind: 'depart', modifier: 'straight', angle: bearingAfter(points, 0), exit: 0 }];
  if (last < 2) {
    steps.push({ index: last, at: points[last], kind: 'arrive', modifier: 'straight', angle: 0, exit: 0 });
    return finalize(steps, points, cum);
  }
  const back = (i) => {
    let j = i;
    while (j > 0 && cum[i] - cum[j] < window) j--;
    return points[j];
  };
  const fwd = (i) => {
    let j = i;
    while (j < last && cum[j] - cum[i] < window) j++;
    return points[j];
  };
  const smoothed = (i) => angleDiff(bearing(back(i), points[i]), bearing(points[i], fwd(i)));
  // Every vertex within the smoothing window of a corner "sees" that corner,
  // so turning vertices are grouped into regions and the maneuver angle is
  // the total bearing change across the region, not a sum of overlapping
  // per-vertex angles. Two bends close together thus merge into one turn.
  let i = 1;
  while (i < last) {
    const a = smoothed(i);
    if (Math.abs(a) < minAngle) {
      i++;
      continue;
    }
    let start = i;
    let end = i;
    let peak = i;
    let peakAbs = Math.abs(a);
    let j = i + 1;
    while (j < last && cum[j] - cum[end] <= mergeWithin) {
      const aj = smoothed(j);
      if (Math.abs(aj) >= minAngle) {
        end = j;
        if (Math.abs(aj) > peakAbs) {
          peak = j;
          peakAbs = Math.abs(aj);
        }
      }
      j++;
    }
    const total = angleDiff(bearing(back(start), points[start]), bearing(points[end], fwd(end)));
    if (Math.abs(total) >= minAngle) {
      const modifier = classifyAngle(total);
      steps.push({ index: peak, at: points[peak], kind: modifier === 'uturn' ? 'uturn' : 'turn', modifier, angle: total, exit: 0 });
    }
    i = j;
  }
  steps.push({ index: last, at: points[last], kind: 'arrive', modifier: 'straight', angle: 0, exit: 0 });
  return finalize(steps, points, cum);
}

/**
 * Attach road names. `nameAt(step)` returns the name of the road the route is
 * ON just after the maneuver (or null). Regenerates text and demotes
 * "continue" steps where the name doesn't change (they'd be noise).
 */
export function applyNames(steps, nameAt) {
  let prevName = null;
  for (const s of steps) {
    const name = nameAt(s) || null;
    if (s.kind === 'depart') {
      s.name = name;
      prevName = name;
      s.text = stepText(s);
      continue;
    }
    if (s.kind === 'arrive') {
      s.text = stepText(s);
      continue;
    }
    s.name = name && name !== prevName ? name : null;
    if (name) prevName = name;
    s.text = stepText(s);
  }
  return steps;
}

/**
 * Steps worth announcing / listing: drop unnamed "continue straight" filler.
 * distToNext is recomputed so it measures to the next *kept* step.
 */
export function announceableSteps(steps) {
  const kept = steps.filter((s) => !(s.kind === 'continue' && !s.name));
  const total = steps.length ? steps[steps.length - 1].along : 0;
  for (let i = 0; i < kept.length; i++) kept[i].distToNext = i + 1 < kept.length ? kept[i + 1].along - kept[i].along : total - kept[i].along;
  return kept;
}

/** Direction arrow glyph used in the UI for a step. */
export function stepIcon(step) {
  switch (step.kind) {
    case 'depart':
      return '⬆';
    case 'arrive':
      return '⚑';
    case 'roundabout':
      return '↻';
    case 'uturn':
      return '↶';
    case 'keep':
      return step.modifier === 'left' ? '↖' : '↗';
  }
  return (
    {
      straight: '⬆',
      left: '⬅',
      right: '➡',
      'slight-left': '↖',
      'slight-right': '↗',
      'sharp-left': '↙',
      'sharp-right': '↘',
      uturn: '↶',
    }[step.modifier] || '⬆'
  );
}

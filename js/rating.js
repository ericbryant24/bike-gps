// Bike-friendliness grading of route segments from the OpenStreetMap way tags
// BRouter returns with each route. Pure functions; unit-tested in Node.
//
// Grades: A separated path · B quiet street · C moderate traffic ·
//         D busy road · E major road. Scores run 0–100 and are bucketed.

export const GRADES = {
  A: { label: 'Bike path / separated', color: '#16a34a', min: 85 },
  B: { label: 'Quiet street', color: '#84cc16', min: 70 },
  C: { label: 'Moderate traffic', color: '#f59e0b', min: 50 },
  D: { label: 'Busy road', color: '#ea580c', min: 30 },
  E: { label: 'Major road', color: '#dc2626', min: -Infinity },
};
export const GRADE_ORDER = ['A', 'B', 'C', 'D', 'E'];

const BASE = {
  cycleway: [95, 'Bike path'],
  path: [88, 'Path'],
  track: [82, 'Track'],
  pedestrian: [85, 'Pedestrian street'],
  footway: [80, 'Footpath'],
  bridleway: [75, 'Bridleway'],
  steps: [35, 'Steps'],
  living_street: [88, 'Living street'],
  residential: [80, 'Residential street'],
  service: [78, 'Service road'],
  unclassified: [68, 'Minor road'],
  tertiary: [55, 'Local road'],
  tertiary_link: [55, 'Local road'],
  secondary: [40, 'Busy road'],
  secondary_link: [40, 'Busy road'],
  primary: [25, 'Major road'],
  primary_link: [25, 'Major road'],
  trunk: [10, 'Highway'],
  trunk_link: [10, 'Highway'],
  motorway: [0, 'Motorway'],
  motorway_link: [0, 'Motorway'],
  ferry: [70, 'Ferry'],
};
const UNPAVED = new Set(['gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'sand', 'grass', 'mud', 'unpaved', 'compacted', 'pebblestone', 'woodchips', 'cobblestone', 'sett', 'unhewn_cobblestone']);

export function parseTags(str) {
  const out = {};
  if (!str) return out;
  let lastKey = null;
  for (const kv of String(str).trim().split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) {
      lastKey = kv.slice(0, i);
      out[lastKey] = kv.slice(i + 1);
    } else if (lastKey) out[lastKey] += ` ${kv}`; // values with spaces, e.g. "maxspeed=45 mph"
  }
  return out;
}

function maxspeedKmh(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+)(?:\s*(mph))?/);
  if (!m) return null;
  return m[2] ? Number(m[1]) * 1.609 : Number(m[1]);
}

export function gradeFor(score) {
  for (const g of GRADE_ORDER) if (score >= GRADES[g].min) return g;
  return 'E';
}

/** Rate one stretch of road from its tags. */
export function rateTags(tagsOrString) {
  const t = typeof tagsOrString === 'string' ? parseTags(tagsOrString) : tagsOrString || {};
  const hw = t.highway || 'unclassified';
  let [score, kind] = BASE[hw] || [65, hw.replace(/_/g, ' ')];
  const notes = [];

  const cw = [t.cycleway, t['cycleway:both'], t['cycleway:left'], t['cycleway:right']].filter(Boolean).join(' ');
  const isRoad = !['cycleway', 'path', 'track', 'footway', 'pedestrian', 'bridleway', 'steps'].includes(hw);
  if (isRoad) {
    if (/track|separate/.test(cw)) {
      score = Math.max(score + 35, 86);
      notes.push('protected bike lane');
    } else if (/\blane\b/.test(cw)) {
      score += 18;
      notes.push('painted bike lane');
    } else if (/shared_lane|sharrow/.test(cw)) {
      score += 5;
      notes.push('sharrows');
    } else if (/opposite/.test(cw)) {
      score += 8;
      notes.push('contraflow lane');
    }
  } else if (hw === 'footway' && t.bicycle !== 'yes' && t.bicycle !== 'designated') {
    notes.push('walk your bike');
    score -= 15;
  }
  if (['yes', 'designated'].includes(t.bicycle) && isRoad) score += 4;
  if (/yes/.test(`${t.route_bicycle_lcn} ${t.route_bicycle_rcn} ${t.route_bicycle_ncn} ${t.route_bicycle_icn}`)) {
    score += 6;
    notes.push('signed bike route');
  }
  const kmh = maxspeedKmh(t.maxspeed);
  if (kmh != null && isRoad) {
    if (kmh <= 33) {
      score += 8;
      notes.push('low speed limit');
    } else if (kmh >= 70) {
      score -= 15;
      notes.push('fast traffic');
    } else if (kmh >= 55) score -= 6;
  }
  if (t.surface && UNPAVED.has(t.surface)) {
    score -= hw === 'track' || hw === 'path' ? 6 : 12;
    notes.push('unpaved');
  }
  if (t.smoothness && /bad|horrible|impassable/.test(t.smoothness)) {
    score -= 10;
    notes.push('rough surface');
  }
  if (t.lit === 'no') notes.push('unlit');
  // Only physically separated infrastructure earns an A; a pleasant street tops out at B.
  if (isRoad && !/track|separate/.test(cw)) score = Math.min(score, GRADES.A.min - 1);
  score = Math.max(0, Math.min(100, score));
  return { score, grade: gradeFor(score), kind, notes, highway: hw };
}

/** Attach ratings to a route's segments (see router.parseRoute). */
export function rateSegments(route) {
  return (route.segments || []).map((s) => ({ ...s, rating: rateTags(s.tags) }));
}

/** Length per grade, the length-weighted score and overall grade. */
export function routeComposition(rated) {
  const byGrade = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let total = 0;
  let weighted = 0;
  for (const s of rated) {
    byGrade[s.rating.grade] += s.distance;
    total += s.distance;
    weighted += s.rating.score * s.distance;
  }
  const score = total ? weighted / total : 0;
  return { byGrade, total, score, grade: gradeFor(score), friendlyShare: total ? (byGrade.A + byGrade.B) / total : 0 };
}

/**
 * Rating per maneuver step: the road between this step and the next.
 * Adds { grade, score, kind, notes, byGrade, signals, stops } to each step.
 */
export function rateSteps(steps, rated) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const from = s.along;
    const to = steps[i + 1]?.along ?? Infinity;
    const byGrade = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const kinds = new Map();
    let weighted = 0;
    let total = 0;
    let signals = 0;
    let stops = 0;
    for (const seg of rated) {
      const overlap = Math.min(seg.along1, to) - Math.max(seg.along0, from);
      if (overlap <= 0) continue;
      byGrade[seg.rating.grade] += overlap;
      weighted += seg.rating.score * overlap;
      total += overlap;
      const key = `${seg.rating.kind}|${seg.rating.notes.filter((n) => n !== 'unlit').join(', ')}`;
      kinds.set(key, (kinds.get(key) || 0) + overlap);
      if (seg.along1 > from && seg.along1 <= to && seg.nodeTags) {
        if (/highway=traffic_signals|crossing=traffic_signals/.test(seg.nodeTags)) signals += 1;
        if (/highway=stop/.test(seg.nodeTags)) stops += 1;
      }
    }
    if (!total) {
      s.rating = null;
      continue;
    }
    const score = weighted / total;
    const [dominant] = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    const [kind, notes] = dominant.split('|');
    s.rating = { grade: gradeFor(score), score, kind, notes: notes ? notes.split(', ') : [], byGrade, signals, stops };
  }
  return steps;
}

/** Contiguous same-grade runs of route geometry, for colouring the line. */
export function gradeRuns(route, rated) {
  const runs = [];
  for (const seg of rated) {
    const pts = route.points.slice(seg.i0, seg.i1 + 1);
    if (pts.length < 2) continue;
    const last = runs[runs.length - 1];
    if (last && last.grade === seg.rating.grade && last.i1 === seg.i0) {
      last.points.push(...pts.slice(1));
      last.i1 = seg.i1;
    } else runs.push({ grade: seg.rating.grade, points: pts, i0: seg.i0, i1: seg.i1 });
  }
  return runs;
}

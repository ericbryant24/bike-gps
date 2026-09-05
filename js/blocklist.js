// Blocklist model: user-defined places the router must never send them.
//
// Three kinds of entry, all reduced to BRouter "nogo" parameters:
//
//   point    – a circle (radius in metres). Hard-blocks everything inside,
//              including crossings. "Avoid this intersection / pothole."
//   stretch  – a piece of a road between two chosen points.
//   road     – one or more OSM ways sharing a name near where the user tapped.
//
// Roads and stretches are NOT blocked with polylines along the centreline:
// BRouter treats any way segment touching a nogo polyline as blocked, which
// would also forbid *crossing* the road at junctions. Instead we lay short
// perpendicular "gates" across the roadway between junctions. Riding along
// the road must pass through a gate; crossing at a junction never does.
//
// Each road/stretch has a crossing rule:
//   'signals' (default) – crossing is only allowed at junctions with traffic
//                         lights; every other junction along the road gets a
//                         small no-go circle so it can't be crossed either.
//   'all'               – crossing is allowed at every junction.

import {
  bbox,
  bboxIntersects,
  bearing,
  cumulativeDistances,
  destination,
  distance,
  interpolate,
  pointAtDistance,
  simplify,
  snapToPath,
} from './geo.js';

export const DEFAULT_POINT_RADIUS = 30;
export const GATE_HALF_WIDTH = 6; // metres either side of the centreline
export const GATE_SPACING_KNOWN_JUNCTIONS = 60; // metres between gates within a run
export const GATE_SPACING_UNKNOWN = 30; // denser when we don't know junction positions
export const GATE_MIN_RUN = 6; // runs shorter than this can't take a gate safely
export const JUNCTION_BLOCK_RADIUS = 5; // metres: circle that closes an unsignalled junction
export const SIGNAL_MATCH_DISTANCE = 25; // a traffic-signal node this close counts for the junction
export const CROSSING_RULES = { signals: 'Only at traffic lights', all: 'At any intersection' };
export const DEFAULT_CROSSING = 'signals';
export const MAX_NOGO_BYTES = 20000; // brouter.de rejects URLs somewhere above ~25 KB (HTTP 414)
export const SOFT_WEIGHT = 100; // penalty weight used when no route can avoid every block

let counter = 0;
export function newId() {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createPoint(center, { radius = DEFAULT_POINT_RADIUS, name = '' } = {}) {
  return {
    id: newId(),
    kind: 'point',
    name: name || 'Avoid this spot',
    enabled: true,
    createdAt: Date.now(),
    center: { lat: center.lat, lon: center.lon },
    radius,
  };
}

export function createStretch(line, { name = '', junctions = [], signals = [], crossing = DEFAULT_CROSSING } = {}) {
  return withLines({ kind: 'stretch', name: name || 'Blocked stretch', lines: [line], junctions, signals, crossing });
}

export function createRoad(lines, { name = '', junctions = [], signals = [], crossing = DEFAULT_CROSSING } = {}) {
  return withLines({ kind: 'road', name: name || 'Blocked road', lines, junctions, signals, crossing });
}

const pt = (p) => ({ lat: p.lat, lon: p.lon });

function withLines({ kind, name, lines, junctions, signals, crossing }) {
  const clean = lines.filter((l) => l && l.length >= 2).map((l) => l.map(pt));
  const all = clean.flat();
  return {
    id: newId(),
    kind,
    name,
    enabled: true,
    createdAt: Date.now(),
    lines: clean,
    junctions: (junctions || []).map(pt),
    signals: (signals || []).map(pt),
    crossing: CROSSING_RULES[crossing] ? crossing : DEFAULT_CROSSING,
    bbox: all.length ? bbox(all) : null,
    length: clean.reduce((acc, l) => acc + cumulativeDistances(l).at(-1), 0),
  };
}

/**
 * Junctions where the blocked road continues on both sides ("interior"):
 * these are the ones a rider could cross. Where the road merely ends at
 * another street (a T), there is nothing to cross, so it is left alone.
 */
export function crossableJunctions(entry, tol = 1.5) {
  const out = [];
  for (const j of entry.junctions || []) {
    let touches = 0;
    let endpointTouches = 0;
    for (const line of entry.lines) {
      let hit = false;
      let atEnd = false;
      for (let i = 0; i < line.length; i++) {
        if (distance(line[i], j) <= tol) {
          hit = true;
          if (i === 0 || i === line.length - 1) atEnd = true;
        }
      }
      if (hit) {
        touches += 1;
        if (atEnd) endpointTouches += 1;
      }
    }
    if (touches >= 2 || (touches === 1 && endpointTouches === 0)) out.push(j);
  }
  return out;
}

export function isSignalled(junction, signals) {
  return (signals || []).some((s) => distance(s, junction) <= SIGNAL_MATCH_DISTANCE);
}

/** Circles that close unsignalled junctions under the 'signals' crossing rule. */
export function junctionBlocksForEntry(entry) {
  if (entry.kind === 'point' || (entry.crossing || DEFAULT_CROSSING) !== 'signals') return [];
  return crossableJunctions(entry).filter((j) => !isSignalled(j, entry.signals));
}

export function entryBBox(entry) {
  if (entry.kind === 'point') return bbox([entry.center], entry.radius);
  if (entry.bbox) return entry.bbox;
  return entry.lines?.length ? bbox(entry.lines.flat()) : null;
}

/**
 * Along-distances on `line` where junction nodes sit (within `tol` metres).
 * Ends of the line always count as run boundaries.
 */
export function junctionPositions(line, cum, junctions, tol = 1.5) {
  const total = cum[cum.length - 1];
  const pos = new Set([0, total]);
  for (const j of junctions || []) {
    const s = snapToPath(j, line, cum, 0, line.length);
    if (s && s.dist <= tol) pos.add(Math.round(s.along * 100) / 100);
  }
  return [...pos].sort((a, b) => a - b);
}

/**
 * Gates for a single polyline. Each gate is a 2-point polyline perpendicular
 * to the road. Returns an array of [{lat,lon},{lat,lon}].
 */
export function gatesForLine(line, { junctions = [], halfWidth = GATE_HALF_WIDTH } = {}) {
  if (!line || line.length < 2) return [];
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1];
  if (total < 1) return [];

  const hasJunctions = junctions && junctions.length > 0;
  const spacing = hasJunctions ? GATE_SPACING_KNOWN_JUNCTIONS : GATE_SPACING_UNKNOWN;
  const bounds = hasJunctions ? junctionPositions(line, cum, junctions) : [0, total];

  const positions = [];
  for (let r = 0; r < bounds.length - 1; r++) {
    const start = bounds[r];
    const len = bounds[r + 1] - start;
    if (len < GATE_MIN_RUN) continue;
    const n = Math.max(1, Math.floor(len / spacing));
    for (let k = 0; k < n; k++) positions.push(start + (len * (k + 0.5)) / n);
  }

  const gates = [];
  for (const d of positions) {
    const { point, index } = pointAtDistance(line, cum, d);
    const a = line[index];
    const b = line[Math.min(index + 1, line.length - 1)];
    const brg = bearing(a, b);
    gates.push([destination(point, brg - 90, halfWidth), destination(point, brg + 90, halfWidth)]);
  }
  return gates;
}

export function gatesForEntry(entry) {
  if (entry.kind === 'point' || !entry.lines) return [];
  const out = [];
  for (const line of entry.lines) {
    // Light simplification so densely-noded curves don't produce a gate per metre.
    out.push(...gatesForLine(simplify(line, 0.5), { junctions: entry.junctions }));
  }
  return out;
}

const f6 = (n) => n.toFixed(6).replace(/\.?0+$/, '');

/**
 * Build BRouter `nogos` and `polylines` parameter values from the enabled
 * entries that could plausibly affect a route inside `routeBBox`.
 * Returns { nogos, polylines, used, truncated }.
 */
export const RELAX_RADIUS = 150; // metres around start/destination where blocks are lifted

/**
 * Build BRouter `nogos` and `polylines` parameter values.
 *
 * Every gate and circle becomes an item. Items are ranked by how close they
 * are to `focus` (the straight line start→destination, or a previous route)
 * and packed into a byte budget nearest-first, so when there is more blocked
 * road than fits in one request the parts that matter most are always sent
 * and nothing is dropped wholesale. `weight` softens blocks into penalties.
 *
 * Returns { nogos, polylines, used, truncated, dropped, total }.
 */
export function toNogoParams(entries, routeBBox, { maxBytes = MAX_NOGO_BYTES, relaxAround = [], focus = null, weight = null } = {}) {
  // A rider standing on a blocked road must be able to ride off it (and reach
  // a destination on one), so gates and circles right next to the trip's end
  // points are dropped for that request.
  const relaxed = (p, extra = 0) => relaxAround.some((z) => distance(z.point, p) <= (z.radius ?? RELAX_RADIUS) + extra);
  const suffix = weight == null ? '' : `,${Math.round(weight)}`;
  const items = [];

  for (const e of entries) {
    if (!e.enabled) continue;
    const eb = entryBBox(e);
    if (!eb || (routeBBox && !bboxIntersects(eb, routeBBox))) continue;
    if (e.kind === 'point') {
      if (relaxed(e.center, e.radius)) continue;
      items.push({ id: e.id, kind: 'circle', pos: e.center, str: `${f6(e.center.lon)},${f6(e.center.lat)},${Math.round(e.radius)}${suffix}` });
      continue;
    }
    for (const g of gatesForEntry(e)) {
      if (relaxed(g[0]) || relaxed(g[1])) continue;
      items.push({ id: e.id, kind: 'gate', pos: interpolate(g[0], g[1], 0.5), str: `${f6(g[0].lon)},${f6(g[0].lat)},${f6(g[1].lon)},${f6(g[1].lat)}${suffix}` });
    }
    for (const j of junctionBlocksForEntry(e)) {
      if (relaxed(j, JUNCTION_BLOCK_RADIUS)) continue;
      items.push({ id: e.id, kind: 'circle', pos: j, str: `${f6(j.lon)},${f6(j.lat)},${JUNCTION_BLOCK_RADIUS}${suffix}` });
    }
  }

  if (focus && focus.length) {
    const cum = focus.length > 1 ? cumulativeDistances(focus) : null;
    for (const it of items) it.rel = cum ? snapToPath(it.pos, focus, cum, 0, focus.length).dist : distance(it.pos, focus[0]);
    items.sort((a, b) => a.rel - b.rel);
  }

  const circles = [];
  const lines = [];
  const used = new Set();
  let bytes = 0;
  let dropped = 0;
  for (const it of items) {
    if (bytes + it.str.length + 1 > maxBytes) {
      dropped += 1;
      continue;
    }
    bytes += it.str.length + 1;
    (it.kind === 'circle' ? circles : lines).push(it.str);
    used.add(it.id);
  }
  return { nogos: circles.join('|'), polylines: lines.join('|'), used: [...used], truncated: dropped > 0, dropped, total: items.length };
}

/**
 * Which blocked roads a route actually travels along, and for how far.
 * Returns [{ entry, meters }] sorted by distance travelled, longest first.
 */
export function entriesUsedByRoute(route, entries, { step = 15, maxDist = 8, minMeters = 40 } = {}) {
  const active = entries.filter((e) => e.enabled && e.kind !== 'point' && e.lines?.length);
  if (!active.length || !route?.points?.length) return [];
  const rb = bbox(route.points, 20);
  const candidates = active.filter((e) => bboxIntersects(entryBBox(e), rb)).map((e) => ({ e, lines: e.lines.map((l) => ({ l, cum: cumulativeDistances(l) })), meters: 0 }));
  if (!candidates.length) return [];
  const cum = route.cum || cumulativeDistances(route.points);
  const total = cum[cum.length - 1];
  for (let d = 0; d <= total; d += step) {
    const p = pointAtDistance(route.points, cum, d).point;
    for (const c of candidates) {
      if (c.lines.some(({ l, cum: lc }) => snapToPath(p, l, lc, 0, l.length).dist < maxDist)) c.meters += step;
    }
  }
  return candidates
    .filter((c) => c.meters >= minMeters)
    .sort((a, b) => b.meters - a.meters)
    .map((c) => ({ entry: c.e, meters: c.meters }));
}

/** Distance from a point to the nearest part of an entry (metres). */
export function distanceToEntry(entry, p) {
  if (entry.kind === 'point') return Math.max(0, distance(entry.center, p) - entry.radius);
  let best = Infinity;
  for (const line of entry.lines || []) {
    const s = snapToPath(p, line, cumulativeDistances(line), 0, line.length);
    if (s && s.dist < best) best = s.dist;
  }
  return best;
}

/** Validate/normalise an entry loaded from storage; returns null if unusable. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  if (raw.kind === 'point') {
    if (!raw.center || !Number.isFinite(raw.center.lat) || !Number.isFinite(raw.center.lon)) return null;
    return { ...raw, enabled: raw.enabled !== false, radius: Number(raw.radius) || DEFAULT_POINT_RADIUS };
  }
  if (raw.kind === 'road' || raw.kind === 'stretch') {
    if (!Array.isArray(raw.lines) || !raw.lines.length) return null;
    const e = withLines({ kind: raw.kind, name: raw.name, lines: raw.lines, junctions: raw.junctions, signals: raw.signals, crossing: raw.crossing });
    return { ...e, id: raw.id, enabled: raw.enabled !== false, createdAt: raw.createdAt || e.createdAt };
  }
  return null;
}

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

import {
  bbox,
  bboxIntersects,
  bearing,
  cumulativeDistances,
  destination,
  distance,
  pointAtDistance,
  simplify,
  snapToPath,
} from './geo.js';

export const DEFAULT_POINT_RADIUS = 30;
export const GATE_HALF_WIDTH = 6; // metres either side of the centreline
export const GATE_SPACING_KNOWN_JUNCTIONS = 60; // metres between gates within a run
export const GATE_SPACING_UNKNOWN = 30; // denser when we don't know junction positions
export const GATE_MIN_RUN = 6; // runs shorter than this can't take a gate safely
export const MAX_NOGO_POINTS = 1400; // keeps the GET URL comfortably under limits

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

export function createStretch(line, { name = '', junctions = [] } = {}) {
  return withLines({ kind: 'stretch', name: name || 'Blocked stretch', lines: [line], junctions });
}

export function createRoad(lines, { name = '', junctions = [] } = {}) {
  return withLines({ kind: 'road', name: name || 'Blocked road', lines, junctions });
}

function withLines({ kind, name, lines, junctions }) {
  const clean = lines.filter((l) => l && l.length >= 2).map((l) => l.map((p) => ({ lat: p.lat, lon: p.lon })));
  const all = clean.flat();
  return {
    id: newId(),
    kind,
    name,
    enabled: true,
    createdAt: Date.now(),
    lines: clean,
    junctions: (junctions || []).map((p) => ({ lat: p.lat, lon: p.lon })),
    bbox: all.length ? bbox(all) : null,
    length: clean.reduce((acc, l) => acc + cumulativeDistances(l).at(-1), 0),
  };
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
export function toNogoParams(entries, routeBBox, { maxPoints = MAX_NOGO_POINTS } = {}) {
  const circles = [];
  const lines = [];
  const used = [];
  let truncated = false;
  let pointBudget = maxPoints;

  for (const e of entries) {
    if (!e.enabled) continue;
    const eb = entryBBox(e);
    if (!eb || (routeBBox && !bboxIntersects(eb, routeBBox))) continue;
    if (e.kind === 'point') {
      if (pointBudget < 1) {
        truncated = true;
        continue;
      }
      circles.push(`${f6(e.center.lon)},${f6(e.center.lat)},${Math.round(e.radius)}`);
      pointBudget -= 1;
      used.push(e.id);
      continue;
    }
    const gates = gatesForEntry(e);
    if (gates.length * 2 > pointBudget) {
      truncated = true;
      continue;
    }
    for (const g of gates) lines.push(`${f6(g[0].lon)},${f6(g[0].lat)},${f6(g[1].lon)},${f6(g[1].lat)}`);
    pointBudget -= gates.length * 2;
    used.push(e.id);
  }
  return { nogos: circles.join('|'), polylines: lines.join('|'), used, truncated };
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
    const e = withLines({ kind: raw.kind, name: raw.name, lines: raw.lines, junctions: raw.junctions });
    return { ...e, id: raw.id, enabled: raw.enabled !== false, createdAt: raw.createdAt || e.createdAt };
  }
  return null;
}

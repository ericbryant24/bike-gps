// Pure geometry helpers. No DOM access so these can be unit-tested in Node.
// Coordinates are always `{ lat, lon }` objects internally; conversions to
// MapLibre's [lng, lat] and GeoJSON's [lon, lat] happen at the edges.

export const EARTH_RADIUS = 6371008.8;

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest rotation from bearing a to bearing b, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Point reached travelling `dist` metres from `a` on `brg` degrees. */
export function destination(a, brg, dist) {
  const δ = dist / EARTH_RADIUS;
  const θ = toRad(brg);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

export function interpolate(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Cumulative distance along a path; result[i] is metres from start to points[i]. */
export function cumulativeDistances(points) {
  const out = new Array(points.length);
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) acc += distance(points[i - 1], points[i]);
    out[i] = acc;
  }
  return out;
}

export function pathLength(points) {
  let acc = 0;
  for (let i = 1; i < points.length; i++) acc += distance(points[i - 1], points[i]);
  return acc;
}

// Local equirectangular projection: accurate to well under a metre at the
// scales we snap over (tens to hundreds of metres), and cheap.
function project(p, cosRef) {
  return { x: toRad(p.lon) * cosRef * EARTH_RADIUS, y: toRad(p.lat) * EARTH_RADIUS };
}

/**
 * Nearest point on segment a→b to p.
 * Returns { point, t, dist } where t∈[0,1] is the fraction along the segment.
 */
export function nearestOnSegment(p, a, b) {
  const cosRef = Math.cos(toRad(p.lat));
  const P = project(p, cosRef);
  const A = project(a, cosRef);
  const B = project(b, cosRef);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  const point = interpolate(a, b, t);
  return { point, t, dist: distance(p, point) };
}

/**
 * Snap `p` onto a path. `hint` is the segment index from the previous snap,
 * used to search a window around it first so we stay on the right part of a
 * self-overlapping route; the whole path is searched if nothing nearby fits.
 *
 * Returns { index, t, point, dist, along } where `along` is metres from the
 * start of the path to the snapped point and `dist` is the cross-track error.
 */
export function snapToPath(p, points, cum, hint = 0, window = 12, maxLocalDist = 60) {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return { index: 0, t: 0, point: points[0], dist: distance(p, points[0]), along: 0 };
  }
  // Near-ties (within `tie` metres) go to the segment closest to the hint, so
  // an out-and-back route keeps snapping to the leg we're actually on.
  const search = (from, to, tie = 0) => {
    let best = null;
    for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++) {
      const r = nearestOnSegment(p, points[i], points[i + 1]);
      if (!best || r.dist < best.dist - tie || (r.dist <= best.dist + tie && Math.abs(i - hint) < Math.abs(best.index - hint))) {
        best = { index: i, ...r };
      }
    }
    return best;
  };
  let best = search(hint - window, hint + window, 1.5);
  if (!best || best.dist > maxLocalDist) {
    const global = search(0, points.length - 1);
    if (global && (!best || global.dist < best.dist)) best = global;
  }
  const segLen = cum[best.index + 1] - cum[best.index];
  best.along = cum[best.index] + segLen * best.t;
  return best;
}

/** Position `d` metres along a path (clamped to the path's extent). */
export function pointAtDistance(points, cum, d) {
  if (points.length === 0) return null;
  const total = cum[cum.length - 1];
  if (d <= 0) return { point: points[0], index: 0 };
  if (d >= total) return { point: points[points.length - 1], index: points.length - 2 };
  // Binary search for the segment containing d.
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (d - cum[lo]) / segLen : 0;
  return { point: interpolate(points[lo], points[hi], t), index: lo };
}

/** Axis-aligned bounding box, optionally padded by `padMetres`. */
export function bbox(points, padMetres = 0) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  if (padMetres > 0) {
    const dLat = toDeg(padMetres / EARTH_RADIUS);
    const midLat = (minLat + maxLat) / 2;
    const dLon = dLat / Math.max(0.05, Math.cos(toRad(midLat)));
    minLat -= dLat;
    maxLat += dLat;
    minLon -= dLon;
    maxLon += dLon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

export function bboxIntersects(a, b) {
  return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);
}

/** Douglas–Peucker simplification with a tolerance in metres. */
export function simplify(points, toleranceM) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = nearestOnSegment(points[i], points[s], points[e]).dist;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Slice a path between the two points on it nearest to `from` and `to`.
 * Used to turn "block this stretch between here and there" into geometry.
 */
export function slicePath(points, from, to) {
  const cum = cumulativeDistances(points);
  let a = snapToPath(from, points, cum, 0, points.length);
  let b = snapToPath(to, points, cum, 0, points.length);
  if (a.along > b.along) [a, b] = [b, a];
  const out = [a.point];
  for (let i = a.index + 1; i <= b.index; i++) out.push(points[i]);
  out.push(b.point);
  return out;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compassName(brg) {
  return COMPASS[Math.round((((brg % 360) + 360) % 360) / 45) % 8];
}

/** Human-friendly distance. units: 'metric' | 'imperial'. */
export function formatDistance(m, units = 'metric') {
  if (!Number.isFinite(m)) return '—';
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
    const mi = m / 1609.344;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)} m`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Distance phrasing for speech ("in 200 metres", "in a quarter mile"). */
export function speakDistance(m, units = 'metric') {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 150) return `${Math.round(ft / 10) * 10} feet`;
    if (ft < 900) return `${Math.round(ft / 50) * 50} feet`;
    const mi = m / 1609.344;
    if (mi < 0.3) return 'a quarter mile';
    if (mi < 0.6) return 'half a mile';
    if (mi < 1.2) return 'one mile';
    return `${mi.toFixed(1)} miles`;
  }
  if (m < 100) return `${Math.round(m / 10) * 10} metres`;
  if (m < 1000) return `${Math.round(m / 50) * 50} metres`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} kilometres` : `${Math.round(km)} kilometres`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

export function formatSpeed(mps, units = 'metric') {
  if (!Number.isFinite(mps) || mps < 0) return '—';
  return units === 'imperial' ? `${(mps * 2.23694).toFixed(0)} mph` : `${(mps * 3.6).toFixed(0)} km/h`;
}

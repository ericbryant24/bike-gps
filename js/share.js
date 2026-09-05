// Route sharing: the route's own geometry travels in the link, so the
// recipient sees exactly the path the sender chose regardless of their own
// blocklist. Encoded with the Google polyline algorithm (5 decimals ≈ 1 m).

import { cumulativeDistances, pathLength, simplify } from './geo.js';

export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * f);
    const lon = Math.round(p.lon * f);
    enc(lat - prevLat);
    enc(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const dec = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (i >= str.length) throw new Error('bad polyline');
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lon += dec();
    out.push({ lat: lat / f, lon: lon / f });
  }
  return out;
}

/** URL for a route. Geometry is simplified to ~2 m so long routes stay shareable. */
export function shareUrl(route, { label = '', baseUrl } = {}) {
  const pts = simplify(route.points, 2);
  const params = new URLSearchParams();
  params.set('r', encodePolyline(pts));
  if (label) params.set('d', label.slice(0, 80));
  const base = baseUrl || `${location.origin}${location.pathname}`;
  return `${base}#${params.toString()}`;
}

/** Parse a shared route from a URL hash; null if there isn't one. */
export function parseSharedRoute(hash) {
  if (!hash || !hash.includes('r=')) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const poly = params.get('r');
  if (!poly) return null;
  let points;
  try {
    points = decodePolyline(poly);
  } catch {
    return null;
  }
  if (points.length < 2 || points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) return null;
  const cum = cumulativeDistances(points);
  const length = pathLength(points);
  return {
    points,
    cum,
    length,
    time: Math.round(length / 4.5), // rough: 16 km/h
    ascend: 0,
    cost: 0,
    voicehints: null,
    segments: [],
    profile: null,
    from: points[0],
    to: points[points.length - 1],
    nogoIds: [],
    shared: true,
    createdAt: Date.now(),
    label: params.get('d') || '',
  };
}

/** GPX 1.1 track for the route (opens in Garmin, Komoot, Strava…). */
export function toGpx(route, { name = 'Bike GPS route' } = {}) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const pts = route.points.map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike GPS" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

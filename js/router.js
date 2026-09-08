// BRouter client. Pure URL building and response parsing, with the fetch
// implementation injectable so it can be tested without a network.

import { cumulativeDistances } from './geo.js';

/**
 * Riding paces: the rider power BRouter's time model assumes, and the moving
 * average that power produces on a typical city route (measured against
 * brouter.de: 100 W → 11.5 mph, 70 W → 9.1 mph).
 */
export const PACES = Object.freeze({
  relaxed: { power: 65, mps: 3.9, mph: 8.7, kmh: 14 },
  moderate: { power: 85, mps: 4.65, mph: 10.4, kmh: 16.7 },
  brisk: { power: 110, mps: 5.5, mph: 12.3, kmh: 19.8 },
});
export const DEFAULT_PACE = 'moderate';
export const SIGNAL_WAIT_S = 25; // expected wait: ~half the cycle, half the time
export const STOP_WAIT_S = 6;

export function paceFor(bikerPower) {
  return Object.values(PACES).find((p) => p.power === Number(bikerPower)) || PACES[DEFAULT_PACE];
}

/**
 * Halts along the route, clustered by position: OSM tags one signal node per
 * approach plus a crossing node either side, so one intersection shows up as
 * three or four nodes within ~40 m. Each cluster is one halt; a signal in the
 * cluster outranks a stop sign. Returns [{ along, kind: 'signal' | 'stop' }].
 */
export function haltsAlong(segments, gap = 40) {
  const nodes = [];
  for (const seg of segments || []) {
    const t = seg.nodeTags || '';
    if (/highway=traffic_signals|crossing=traffic_signals/.test(t)) nodes.push({ along: seg.along1, kind: 'signal' });
    else if (/highway=stop/.test(t)) nodes.push({ along: seg.along1, kind: 'stop' });
  }
  nodes.sort((a, b) => a.along - b.along);
  const halts = [];
  for (const n of nodes) {
    const last = halts[halts.length - 1];
    if (last && n.along - last.end <= gap) {
      last.end = n.along;
      if (n.kind === 'signal') last.kind = 'signal';
    } else halts.push({ along: n.along, end: n.along, kind: n.kind });
  }
  return halts.map(({ along, kind }) => ({ along, kind }));
}

export function countHalts(segments) {
  const halts = haltsAlong(segments);
  return { signals: halts.filter((h) => h.kind === 'signal').length, stops: halts.filter((h) => h.kind === 'stop').length };
}
export const DEFAULT_ENDPOINT = 'https://brouter.de/brouter';

export const PROFILES = [
  { id: 'trekking', label: 'Balanced', hint: 'Prefers bike paths and quiet streets' },
  { id: 'fastbike', label: 'Fast', hint: 'Road-bike: fastest on paved roads' },
  { id: 'safety', label: 'Safest', hint: 'Avoids traffic wherever it can' },
  { id: 'shortest', label: 'Shortest', hint: 'Minimum distance' },
];

const f6 = (n) => n.toFixed(6).replace(/\.?0+$/, '');

export function buildRouteUrl({
  endpoint = DEFAULT_ENDPOINT,
  from,
  to,
  vias = [],
  profile = 'trekking',
  nogos = '',
  polylines = '',
  alternative = 0,
  bikerPower = null,
}) {
  const pts = [from, ...vias, to].map((p) => `${f6(p.lon)},${f6(p.lat)}`).join('|');
  const params = new URLSearchParams();
  params.set('lonlats', pts);
  if (nogos) params.set('nogos', nogos);
  if (polylines) params.set('polylines', polylines);
  params.set('profile', profile);
  // Rider effort for the time estimate: overrides the profile's `assign bikerPower`.
  if (bikerPower && profile !== 'shortest') params.set('profile:bikerPower', String(bikerPower));
  params.set('alternativeidx', String(alternative));
  params.set('format', 'geojson');
  params.set('timode', '2'); // turn instructions as voicehints
  // URLSearchParams encodes "," and "|"; BRouter accepts both forms, but the
  // raw characters keep the URL far shorter.
  return `${endpoint}?${params.toString().replace(/%2C/g, ',').replace(/%7C/g, '|').replace(/%3A/g, ':')}`;
}

/**
 * Parse a BRouter GeoJSON response into our route shape.
 * Throws with a readable message on BRouter's plain-text errors.
 */
export function parseRoute(body, meta = {}) {
  let json = body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed.startsWith('{')) throw routingError(trimmed);
    json = JSON.parse(trimmed);
  }
  const feat = json?.features?.[0];
  if (!feat?.geometry?.coordinates?.length) throw routingError('no track found');
  const props = feat.properties || {};
  const points = feat.geometry.coordinates.map((c) => ({ lon: c[0], lat: c[1], ele: c[2] }));
  const cum = cumulativeDistances(points);
  const segments = parseSegments(props.messages, points, cum);
  const length = Number(props['track-length']) || cum[cum.length - 1];
  const halts = countHalts(segments);
  // BRouter's kinematic model never stops; add expected waits at lights and
  // stop signs. The "shortest" profile has no speed model at all (its
  // total-time is nonsense), so its riding time comes from the pace instead.
  const pace = paceFor(meta.bikerPower);
  const rideTime = meta.profile === 'shortest' ? length / pace.mps : Number(props['total-time']) || length / pace.mps;
  const stopTime = halts.signals * SIGNAL_WAIT_S + halts.stops * STOP_WAIT_S;
  return {
    points,
    cum,
    segments,
    length,
    time: rideTime + stopTime,
    rideTime,
    stopTime,
    halts,
    ascend: Number(props['filtered ascend']) || 0,
    cost: Number(props.cost) || 0,
    voicehints: Array.isArray(props.voicehints) ? props.voicehints : null,
    profile: meta.profile || null,
    alternative: Number(meta.alternative) || 0,
    from: meta.from || points[0],
    to: meta.to || points[points.length - 1],
    nogoIds: meta.nogoIds || [],
    createdAt: Date.now(),
  };
}

/**
 * BRouter "messages": one row per stretch of constant way tags, ending at a
 * track point. Columns: Longitude, Latitude, Elevation, Distance, CostPerKm,
 * ElevCost, TurnCost, NodeCost, InitialCost, WayTags, NodeTags, Time, Energy.
 * Returns segments { i0, i1, along0, along1, distance, costPerKm, tags, nodeTags }
 * mapped onto route point indices.
 */
export function parseSegments(messages, points, cum) {
  if (!Array.isArray(messages) || messages.length < 2) return [];
  const header = messages[0];
  const col = (name) => header.indexOf(name);
  const iLon = col('Longitude');
  const iLat = col('Latitude');
  const iDist = col('Distance');
  const iCost = col('CostPerKm');
  const iTags = col('WayTags');
  const iNode = col('NodeTags');
  if (iLon < 0 || iLat < 0) return [];
  const segments = [];
  let ptr = 0;
  for (const row of messages.slice(1)) {
    const lon = Number(row[iLon]) / 1e6;
    const lat = Number(row[iLat]) / 1e6;
    // Find the track point this message ends at: scan forward from the last one.
    let end = -1;
    for (let k = ptr; k < points.length; k++) {
      if (Math.abs(points[k].lat - lat) < 2e-6 && Math.abs(points[k].lon - lon) < 2e-6) {
        end = k;
        break;
      }
    }
    if (end < 0) {
      // Not an exact track point (rare): advance by the reported distance instead.
      const target = cum[ptr] + (Number(row[iDist]) || 0);
      end = ptr;
      while (end < points.length - 1 && cum[end + 1] <= target + 0.5) end++;
    }
    if (end <= ptr && segments.length) {
      // Zero-length message (e.g. node cost only): fold its node tags into the previous segment.
      if (iNode >= 0 && row[iNode]) segments[segments.length - 1].nodeTags = [segments[segments.length - 1].nodeTags, row[iNode]].filter(Boolean).join(' ');
      continue;
    }
    segments.push({
      i0: ptr,
      i1: end,
      along0: cum[ptr],
      along1: cum[end],
      distance: cum[end] - cum[ptr],
      costPerKm: iCost >= 0 ? Number(row[iCost]) || 0 : 0,
      tags: iTags >= 0 ? row[iTags] || '' : '',
      nodeTags: iNode >= 0 ? row[iNode] || '' : '',
    });
    ptr = end;
  }
  return segments;
}

/** Error with a `code` so callers can react ('no-route' → try softer blocks). */
function routingError(text) {
  const err = new Error(friendlyError(text));
  const t = text.toLowerCase();
  if (t.includes('no track found') || t.includes('no route') || t.includes('island')) err.code = 'no-route';
  return err;
}

function friendlyError(text) {
  const t = text.toLowerCase();
  if (t.includes('island')) return 'One of the points is unreachable by bike (isolated from the road network).';
  if (t.includes('no track found') || t.includes('no route')) return 'No route found — try moving a point onto a road, or disable some blocked roads.';
  if (t.includes('too far') || t.includes('distance')) return 'That route is too long for the routing server. Try a shorter trip.';
  if (t.includes('watchdog') || t.includes('killed')) return 'The routing server is busy. Please try again.';
  if (t.includes('datafile') || t.includes('segment')) return 'No map data for that area on the routing server.';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export async function fetchRoute(params, { fetchImpl = globalThis.fetch, signal, timeoutMs = 45000 } = {}) {
  const url = buildRouteUrl(params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Routing timed out.')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok && !text.trim().startsWith('{')) throw routingError(text || `Routing failed (${res.status})`);
    return parseRoute(text, { profile: params.profile, from: params.from, to: params.to, nogoIds: params.nogoIds, alternative: params.alternative, bikerPower: params.bikerPower });
  } finally {
    clearTimeout(timer);
  }
}

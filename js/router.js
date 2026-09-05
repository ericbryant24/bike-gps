// BRouter client. Pure URL building and response parsing, with the fetch
// implementation injectable so it can be tested without a network.

import { cumulativeDistances } from './geo.js';

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
}) {
  const pts = [from, ...vias, to].map((p) => `${f6(p.lon)},${f6(p.lat)}`).join('|');
  const params = new URLSearchParams();
  params.set('lonlats', pts);
  if (nogos) params.set('nogos', nogos);
  if (polylines) params.set('polylines', polylines);
  params.set('profile', profile);
  params.set('alternativeidx', String(alternative));
  params.set('format', 'geojson');
  params.set('timode', '2'); // turn instructions as voicehints
  // URLSearchParams encodes "," and "|"; BRouter accepts both forms, but the
  // raw characters keep the URL far shorter.
  return `${endpoint}?${params.toString().replace(/%2C/g, ',').replace(/%7C/g, '|')}`;
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
  return {
    points,
    cum,
    length: Number(props['track-length']) || cum[cum.length - 1],
    time: Number(props['total-time']) || 0,
    ascend: Number(props['filtered ascend']) || 0,
    cost: Number(props.cost) || 0,
    voicehints: Array.isArray(props.voicehints) ? props.voicehints : null,
    profile: meta.profile || null,
    from: meta.from || points[0],
    to: meta.to || points[points.length - 1],
    nogoIds: meta.nogoIds || [],
    createdAt: Date.now(),
  };
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
    return parseRoute(text, { profile: params.profile, from: params.from, to: params.to, nogoIds: params.nogoIds });
  } finally {
    clearTimeout(timer);
  }
}

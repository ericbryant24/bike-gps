// Nominatim geocoding. Usage policy: ≤1 request/second, identify the app.
// Requests are serialised through a small queue that enforces the spacing.

import { distance } from './geo.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org';
const NEARBY_KM = 80; // results beyond this are dropped when enough closer ones exist
const ENOUGH = 3;
const MIN_GAP_MS = 1500;
const results = new Map(); // session cache: query key → results
const MAX_CACHED = 40;
let lastAt = 0;
let chain = Promise.resolve();

/** Serialise requests so two searches never overlap; spacing is applied per request. */
function throttled(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function spaced() {
  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
}

/** "39.96, -83.00" or "39.96 -83.00" → {lat, lon} or null. */
export function parseLatLon(text) {
  const m = String(text).trim().match(/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function formatResult(r) {
  const a = r.address || {};
  const name = r.name || r.display_name.split(',')[0];
  const parts = [a.road, a.neighbourhood || a.suburb, a.city || a.town || a.village || a.municipality, a.state]
    .filter(Boolean)
    .filter((p) => p !== name);
  return {
    label: name,
    address: parts.join(', ') || r.display_name.split(',').slice(1, 4).join(',').trim(),
    kind: (r.type || '').replace(/_/g, ' '),
    osm: `${r.class || ''}=${r.type || ''}`,
    lat: Number(r.lat),
    lon: Number(r.lon),
  };
}

/** One request, never closer than MIN_GAP_MS to the previous one. */
async function nominatim(params, { signal, fetchImpl }) {
  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
  const res = await fetchImpl(`${ENDPOINT}/search?${params}`, {
    signal,
    headers: { Accept: 'application/json', 'Accept-Language': globalThis.navigator?.language || 'en' },
  });
  if (res.status === 429 || res.status === 403) throw new Error('The search service is busy — try again in a few seconds.');
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).map(formatResult);
}

function cached(key, fn) {
  if (results.has(key)) return Promise.resolve(results.get(key).map((r) => ({ ...r })));
  return fn().then((list) => {
    if (results.size >= MAX_CACHED) results.delete(results.keys().next().value);
    results.set(key, list);
    return list.map((r) => ({ ...r }));
  });
}

const baseParams = (q, limit) => new URLSearchParams({ q, format: 'jsonv2', limit: String(Math.min(40, limit)), addressdetails: '1', dedupe: '1' });
const viewbox = (b) => `${b.minLon},${b.maxLat},${b.maxLon},${b.minLat}`;
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((r) => {
    const k = `${r.lat.toFixed(4)},${r.lon.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const box = (near, km) => {
  const dLat = km / 111;
  const dLon = dLat / Math.max(0.2, Math.cos((near.lat * Math.PI) / 180));
  return { minLon: near.lon - dLon, maxLon: near.lon + dLon, minLat: near.lat - dLat, maxLat: near.lat + dLat };
};

// ---------------------------------------------------------------- Photon
// Komoot's Photon geocoder: prefix ("search as you type") matching on place
// names, location-biased, CORS-enabled, free for fair use. Much better than
// Nominatim for "glen echo" → Glen Echo Park; Nominatim remains the fallback.
const PHOTON = 'https://photon.komoot.io/api/';

const PHOTON_KIND = {
  park: 'park', supermarket: 'supermarket', fuel: 'fuel', cafe: 'café', restaurant: 'restaurant', fast_food: 'fast food', bar: 'bar', pub: 'pub',
  school: 'school', university: 'university', hospital: 'hospital', pharmacy: 'pharmacy', library: 'library', bicycle: 'bike shop', bicycle_parking: 'bike parking',
  neighbourhood: 'neighbourhood', suburb: 'neighbourhood', city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', locality: 'area',
  stream: 'stream', river: 'river', cycleway: 'bike path', path: 'path', footway: 'footpath',
};

function formatPhoton(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry?.coordinates || [];
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Place';
  const kind = p.osm_key === 'highway' ? (PHOTON_KIND[p.osm_value] || 'road') : PHOTON_KIND[p.osm_value] || (p.osm_value || '').replace(/_/g, ' ');
  const addr = [
    p.name && p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.name ? p.street : null,
    p.district && p.district !== name ? p.district : null,
    p.city || p.county,
    p.state,
  ].filter(Boolean);
  return { label: name, address: [...new Set(addr)].join(', '), kind: kind === name.toLowerCase() ? '' : kind, lat, lon, osm: `${p.osm_key}=${p.osm_value}` };
}

/** Same-named features of the same type in the same town count once (streams, roads come in segments). */
function collapse(list, near) {
  const best = new Map();
  for (const r of list) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const k = `${r.label.replace(APOS, "'")}|${r.osm || r.kind}|${(r.address || '').split(',').slice(-2).join(',')}`.toLowerCase();
    const d = near ? Math.hypot((r.lat - near.lat) * 111, (r.lon - near.lon) * 111 * Math.cos((near.lat * Math.PI) / 180)) : 0;
    if (!best.has(k) || best.get(k).d > d) best.set(k, { d, r });
  }
  return [...best.values()].map((x) => x.r);
}

const APOS = /[\u2019\u2018\u02BC\u0060\u00B4']/g; // ’ ‘ ʼ ` ´ '

/**
 * Alternative spellings of a name query. OSM names use both the straight (')
 * and curly (’) apostrophe — geocoders treat them as different characters —
 * and people type possessives without any: whits → whit's, whit’s, whit.
 */
export function spellingVariants(q) {
  const t = q.trim();
  const plain = t.replace(APOS, '');
  const out = [];
  if (APOS.test(t)) {
    APOS.lastIndex = 0;
    out.push(t.replace(APOS, "'"), t.replace(APOS, '\u2019'), plain);
  } else if (/s$/i.test(t) && t.length > 3) {
    const stem = t.slice(0, -1);
    out.push(`${stem}'s`, `${stem}\u2019s`); // (the bare stem would match too broadly: "whit" → White Castle)
  }
  return [...new Set(out)].filter((v) => v && v !== t);
}

/** Does this query look like a possessive/apostrophe name, where spellings vary? */
const looksPossessive = (q) => APOS.test(q) || /s$/i.test(q.trim());

async function photon(q, near, { limit = 40, signal, fetchImpl }) {
  const p = new URLSearchParams({ q, limit: String(limit), lang: (globalThis.navigator?.language || 'en').slice(0, 2) });
  if (near) {
    p.set('lat', near.lat.toFixed(5));
    p.set('lon', near.lon.toFixed(5));
    p.set('location_bias_scale', '0.6');
    p.set('zoom', '14');
  }
  const res = await fetchImpl(`${PHOTON}?${p}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const json = await res.json();
  return collapse((json.features || []).map(formatPhoton), near);
}

/**
 * Search for places near a point.
 *
 * Photon first (prefix matching, distance-biased). If it is unreachable, the
 * Nominatim ring search below takes over.
 *
 * Nominatim returns at most `limit` matches inside a box ranked by its own
 * importance score, not by distance — so one big box around the rider can
 * omit the nearest branch of a chain. We search expanding rings instead and
 * stop as soon as a ring came back with fewer than `limit` hits (i.e. it was
 * exhaustive for that area) and we have enough results. `onProgress` gets
 * the merged list after each ring so the UI can show nearby hits at once.
 */
export async function search(query, { near, rings = [4, 12, 30], limit = 40, want = 8, onProgress, signal, fetchImpl = globalThis.fetch } = {}) {
  const q = query.trim();
  if (!q) return [];
  const direct = parseLatLon(q);
  if (direct) return [{ label: `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}`, address: 'Coordinates', kind: '', ...direct }];
  const key = `near|${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : '-'}`;
  return cached(key, async () => {
    try {
      const nearby = (list) => (near ? list.filter((r) => distance(near, r) < NEARBY_KM * 1000) : list);
      let hits = await photon(q, near, { signal, fetchImpl });
      onProgress?.(hits.map((r) => ({ ...r })));
      // Apostrophe spellings vary between places with the same name (Whit's vs
      // Whit’s), so possessive-looking queries always search every spelling;
      // other queries retry variants only when little was found nearby.
      APOS.lastIndex = 0;
      const variants = spellingVariants(q);
      if (variants.length && (looksPossessive(q) || nearby(hits).length < ENOUGH)) {
        const more = await Promise.all(variants.map((v) => photon(v, near, { signal, fetchImpl }).catch(() => [])));
        hits = collapse([...hits, ...more.flat()], near);
        onProgress?.(hits.map((r) => ({ ...r })));
      }
      const close = nearby(hits);
      if (close.length >= ENOUGH) return close;
      if (hits.length) return hits;
    } catch (e) {
      if (signal?.aborted) throw e;
      /* fall back to Nominatim */
    }
    return throttled(async () => {
      let merged = [];
      if (near) {
        for (const km of rings) {
          const p = baseParams(q, limit);
          p.set('viewbox', viewbox(box(near, km)));
          p.set('bounded', '1');
          const ring = await nominatim(p, { signal, fetchImpl });
          merged = dedupe([...merged, ...ring]);
          onProgress?.(merged.map((r) => ({ ...r })));
          if (ring.length < limit && merged.length >= want) break;
        }
      }
      if (merged.length < 3) {
        const p = baseParams(q, 10);
        if (near) p.set('viewbox', viewbox(box(near, 60)));
        merged = dedupe([...merged, ...(await nominatim(p, { signal, fetchImpl }))]);
      }
      return collapse(merged, near);
    });
  });
}

/** Search only inside the given bounds ("search this area"). */
export async function searchInBounds(query, bounds, { limit = 12, signal, fetchImpl = globalThis.fetch } = {}) {
  const q = query.trim();
  if (!q) return [];
  const key = `box|${q.toLowerCase()}|${[bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].map((v) => v.toFixed(3)).join(',')}`;
  return cached(key, () => throttled(async () => {
    const p = baseParams(q, limit);
    p.set('viewbox', viewbox(bounds));
    p.set('bounded', '1');
    return collapse(await nominatim(p, { signal, fetchImpl }), { lat: (bounds.minLat + bounds.maxLat) / 2, lon: (bounds.minLon + bounds.maxLon) / 2 });
  }));
}

/** Reverse geocode to a short label; never throws (returns null instead). */
export async function reverse(point, { signal, fetchImpl = globalThis.fetch } = {}) {
  try {
    return await throttled(async () => {
      await spaced();
      const params = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon), format: 'jsonv2', zoom: '18' });
      const res = await fetchImpl(`${ENDPOINT}/reverse?${params}`, {
        signal,
        headers: { Accept: 'application/json', 'Accept-Language': globalThis.navigator?.language || 'en' },
      });
      if (!res.ok) return null;
      const r = await res.json();
      if (!r || r.error) return null;
      const f = formatResult(r);
      return { ...f, label: r.address?.road ? `${r.address.house_number ? `${r.address.house_number} ` : ''}${r.address.road}` : f.label };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Mapbox
// Optional: Mapbox Search Box API (needs a public access token, pk.…). Built
// for place search: fuzzy matching, relevance + proximity ranking, fresh POI
// data. suggest() is for search-as-you-type (names only, billed per session),
// retrieve() resolves a suggestion to coordinates, forward() returns full
// features with coordinates for a committed search or a bounding box.
const MAPBOX = 'https://api.mapbox.com/search/searchbox/v1';
const MAPBOX_TYPES = 'poi,address,street,place,neighborhood,locality,district';

export class MapboxAuthError extends Error {}

function mapboxKind(p) {
  const cat = (p.poi_category || [])[0];
  if (cat) return cat.replace(/_/g, ' ');
  return (p.feature_type || '').replace(/_/g, ' ');
}

/** Normalise a Search Box feature/suggestion into our result shape. */
export function formatMapbox(p, coords) {
  const lat = coords?.latitude ?? coords?.lat ?? p.coordinates?.latitude;
  const lon = coords?.longitude ?? coords?.lon ?? p.coordinates?.longitude;
  return {
    label: p.name_preferred || p.name || p.full_address || 'Place',
    address: p.place_formatted || p.full_address || p.address || '',
    kind: mapboxKind(p),
    lat: Number.isFinite(lat) ? lat : undefined,
    lon: Number.isFinite(lon) ? lon : undefined,
    distance: Number.isFinite(p.distance) ? p.distance : undefined, // metres from proximity, when given
    mapboxId: p.mapbox_id,
    osm: `mapbox=${p.feature_type || ''}`,
  };
}

async function mapboxGet(path, params, { token, signal, fetchImpl }) {
  params.set('access_token', token);
  params.set('language', (globalThis.navigator?.language || 'en').slice(0, 2));
  const res = await fetchImpl(`${MAPBOX}/${path}?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new MapboxAuthError('Mapbox rejected the access token. Check it in Settings.');
  if (!res.ok) throw new Error(`Mapbox search failed (${res.status})`);
  return res.json();
}

/** Search-as-you-type: names + addresses + distance, no coordinates yet. */
export async function mapboxSuggest(q, { token, session, near, limit = 10, signal, fetchImpl = globalThis.fetch }) {
  const params = new URLSearchParams({ q: q.trim(), limit: String(Math.min(10, limit)), session_token: session, types: MAPBOX_TYPES });
  if (near) params.set('proximity', `${near.lon.toFixed(5)},${near.lat.toFixed(5)}`);
  const json = await mapboxGet('suggest', params, { token, signal, fetchImpl });
  return (json.suggestions || []).map((sug) => formatMapbox(sug));
}

/** Coordinates (and full details) for one suggestion. */
export async function mapboxRetrieve(mapboxId, { token, session, signal, fetchImpl = globalThis.fetch }) {
  const params = new URLSearchParams({ session_token: session });
  const json = await mapboxGet(`retrieve/${encodeURIComponent(mapboxId)}`, params, { token, signal, fetchImpl });
  const f = (json.features || [])[0];
  if (!f) return null;
  return formatMapbox(f.properties || {}, { longitude: f.geometry?.coordinates?.[0], latitude: f.geometry?.coordinates?.[1] });
}

/** Committed search: full features with coordinates, near a point or inside a box. */
export async function mapboxForward(q, { token, near, bounds, limit = 10, signal, fetchImpl = globalThis.fetch }) {
  const params = new URLSearchParams({ q: q.trim(), limit: String(Math.min(10, limit)), types: MAPBOX_TYPES });
  if (near) params.set('proximity', `${near.lon.toFixed(5)},${near.lat.toFixed(5)}`);
  if (bounds) params.set('bbox', `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`);
  const json = await mapboxGet('forward', params, { token, signal, fetchImpl });
  return (json.features || []).map((f) => formatMapbox(f.properties || {}, { longitude: f.geometry?.coordinates?.[0], latitude: f.geometry?.coordinates?.[1] }));
}

/** Cheap validity check for a token (one tiny forward request). */
export async function mapboxCheckToken(token, { fetchImpl = globalThis.fetch } = {}) {
  try {
    await mapboxForward('park', { token, near: { lat: 40, lon: -83 }, limit: 1, fetchImpl });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

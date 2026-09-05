// Overpass API client: road lookup for the blocklist and street names for
// turn instructions. Public mirrors are tried in order; a rate-limited or
// failed mirror falls through to the next. Every query is batched so a route
// costs one request, not one per step.
//
// Junctions are derived client-side: OSM ways that meet share a node, and
// shared nodes come back with identical coordinates in `out geom` output.

import { cumulativeDistances, distance, pointAtDistance, snapToPath } from './geo.js';

export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ROUTABLE = '[highway][highway!~"^(proposed|construction|razed|abandoned|platform|bus_stop|elevator|corridor)$"]';

const cache = new Map();
const MAX_CACHE = 60;

function remember(key, value) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

// Mirrors are tried in this order; one that fails is moved to the back for the
// rest of the session so a dead mirror doesn't tax every query.
const order = [...ENDPOINTS];
function demote(ep) {
  const i = order.indexOf(ep);
  if (i >= 0 && i < order.length - 1) order.push(...order.splice(i, 1));
}

export async function query(ql, { signal, fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  if (cache.has(ql)) return cache.get(ql);
  let lastErr = null;
  for (const ep of [...order]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(`${ep}?data=${encodeURIComponent(ql)}`, { signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok || !text.trim().startsWith('{')) {
        lastErr = new Error(res.status === 429 || /rate_limited/.test(text) ? 'Map data server busy' : `Map data error (${res.status})`);
        demote(ep);
        continue;
      }
      return remember(ql, JSON.parse(text));
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      demote(ep);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr || new Error('Map data unavailable');
}

const qstr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const f6 = (n) => n.toFixed(6);

function toWay(el) {
  const pts = (el.geometry || []).filter(Boolean).map((c) => ({ lat: c.lat, lon: c.lon }));
  return { id: el.id, tags: el.tags || {}, name: el.tags?.name || null, highway: el.tags?.highway || null, points: pts };
}

function parseWays(res) {
  return (res.elements || []).filter((e) => e.type === 'way').map(toWay).filter((w) => w.points.length >= 2);
}

/** Traffic-signal nodes (junction lights or signalled crossings) in a response. */
function parseSignals(res) {
  return (res.elements || [])
    .filter((e) => e.type === 'node' && Number.isFinite(e.lat) && (e.tags?.highway === 'traffic_signals' || e.tags?.crossing === 'traffic_signals'))
    .map((e) => ({ lat: e.lat, lon: e.lon }));
}

/** Nodes shared by two or more ways = junctions. */
export function sharedNodes(ways) {
  const seen = new Map();
  for (const w of ways) {
    const own = new Set();
    for (const p of w.points) {
      const k = `${p.lat},${p.lon}`;
      if (own.has(k)) continue;
      own.add(k);
      const e = seen.get(k);
      if (e) e.count += 1;
      else seen.set(k, { count: 1, p });
    }
  }
  return [...seen.values()].filter((e) => e.count >= 2).map((e) => e.p);
}

/** Best-effort label for an unnamed way. */
export function describeWay(way) {
  if (way.name) return way.name;
  const hw = way.highway || 'road';
  const nice = {
    cycleway: 'Cycle path',
    footway: 'Footpath',
    path: 'Path',
    track: 'Track',
    service: 'Service road',
    residential: 'Residential street',
    unclassified: 'Minor road',
    tertiary: 'Road',
    secondary: 'Road',
    primary: 'Main road',
    trunk: 'Major road',
    living_street: 'Living street',
    pedestrian: 'Pedestrian street',
    steps: 'Steps',
  }[hw];
  return `${nice || hw}${way.tags?.ref ? ` ${way.tags.ref}` : ''}`;
}

function withDistance(ways, point) {
  for (const w of ways) w.dist = snapToPath(point, w.points, cumulativeDistances(w.points), 0, w.points.length).dist;
  return ways.sort((a, b) => a.dist - b.dist);
}

/** Routable ways within `radius` metres of a point, nearest first. */
export async function roadsAt(point, { radius = 15, signal, timeoutMs } = {}) {
  const ql = `[out:json][timeout:20];way(around:${radius},${f6(point.lat)},${f6(point.lon)})${ROUTABLE};out tags geom;`;
  return withDistance(parseWays(await query(ql, { signal, timeoutMs })), point);
}

/**
 * All ways sharing `name` within `radius` of a point, plus their junctions
 * with other roads. Used for "block the whole road".
 */
// `.r` is the set of ways of interest. Two ways to learn where they meet
// other roads:
//  LIGHT – junctions computed server-side (nodes of .r that also belong to
//          other highway ways), returned as bare nodes. Small payload even
//          for a 10 km road.
//  HEAVY – every touching way with geometry; junctions derived client-side
//          from shared coordinates. Used if LIGHT fails on a mirror.
const SIGNALS = 'node.n["highway"~"^(traffic_signals|crossing)$"]->.sig;.sig out;';
const LIGHT = `node(w.r)->.n;way(bn.n)[highway]->.all;(.all; - .r;)->.o;node(w.o)->.on;node.n.on->.j;.r out tags geom;.j out skel;${SIGNALS}`;
const ADJACENT = `node(w.r)->.n;way(bn.n)[highway]->.all;.all out tags geom;${SIGNALS}`;

function bareNodes(res) {
  return (res.elements || []).filter((e) => e.type === 'node' && !e.tags && Number.isFinite(e.lat)).map((e) => ({ lat: e.lat, lon: e.lon }));
}

/** Run `head` + LIGHT, falling back to `head` + ADJACENT. Returns { ways, junctions, signals }. */
async function withJunctions(head, keep, opts) {
  try {
    const res = await query(`[out:json][timeout:25];${head}${LIGHT}`, opts);
    const ways = parseWays(res).filter(keep);
    if (!ways.length) return { ways, junctions: [], signals: parseSignals(res) };
    return { ways, junctions: bareNodes(res), signals: parseSignals(res) };
  } catch (e) {
    if (opts?.signal?.aborted) throw e;
    const res = await query(`[out:json][timeout:25];${head}${ADJACENT}`, opts);
    const all = parseWays(res);
    return { ways: all.filter(keep), junctions: sharedNodes(all), signals: parseSignals(res) };
  }
}

export async function roadByName(name, near, { radius = 5000, signal, timeoutMs } = {}) {
  const head = `way(around:${Math.round(radius)},${f6(near.lat)},${f6(near.lon)})[highway][name=${qstr(name)}]->.r;`;
  return withJunctions(head, (w) => w.name === name, { signal, timeoutMs });
}

/** A single way by id, with its junctions. */
export async function wayWithJunctions(wayId, { signal, timeoutMs } = {}) {
  return withJunctions(`way(${wayId})->.r;`, (w) => w.id === wayId, { signal, timeoutMs });
}

/**
 * Ways touching a polyline (e.g. a routed stretch), plus junctions. Returns
 * the ways sorted by how much of the line they carry (best first).
 */
export async function waysAlong(line, { signal, radius = 2 } = {}) {
  const coords = line.map((p) => `${f6(p.lat)},${f6(p.lon)}`).join(',');
  const head = `way(around:${radius},${coords})${ROUTABLE}->.r;`;
  const { ways, junctions, signals } = await withJunctions(head, () => true, { signal });
  // Score each way by how many line vertices lie on it.
  for (const w of ways) {
    const cum = cumulativeDistances(w.points);
    w.hits = line.reduce((n, p) => n + (snapToPath(p, w.points, cum, 0, w.points.length).dist < 3 ? 1 : 0), 0);
  }
  return { ways: ways.filter((w) => w.hits > 0).sort((a, b) => b.hits - a.hits), junctions, signals };
}

/**
 * Street names for maneuver steps. Fetches every named highway near every
 * step in one request, then picks, for each step, the way the route follows
 * just after the maneuver. Returns an array aligned with `steps` (null where
 * unknown). Never throws.
 */
export async function namesForSteps(steps, route, { signal, lookAhead = 18 } = {}) {
  const names = new Array(steps.length).fill(null);
  const probes = steps.map((s) => pointAtDistance(route.points, route.cum, Math.min(s.along + lookAhead, route.length - 1))?.point || s.at);
  if (!probes.length) return names;
  try {
    const parts = probes.map((p) => `way(around:10,${f6(p.lat)},${f6(p.lon)})[highway][name];`);
    const ql = `[out:json][timeout:25];(${parts.join('')});out tags geom;`;
    const ways = parseWays(await query(ql, { signal })).filter((w) => w.name);
    for (const w of ways) w.cum = cumulativeDistances(w.points);
    probes.forEach((p, i) => {
      let best = null;
      for (const w of ways) {
        if (distance(p, w.points[0]) > 3000 && distance(p, w.points[w.points.length - 1]) > 3000) continue;
        const d = snapToPath(p, w.points, w.cum, 0, w.points.length).dist;
        if (d < 9 && (!best || d < best.d)) best = { d, name: w.name };
      }
      names[i] = best?.name || null;
    });
  } catch {
    /* names are optional */
  }
  return names;
}

const qre = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');

/**
 * Every named place (shop, amenity, …) whose name starts with `text` within
 * `radius` metres. Exhaustive and proximity-based — the complement to a
 * geocoder's importance-ranked hits. Never throws; returns [] on failure.
 */
export async function placesNamed(text, near, { radius = 12000, signal, timeoutMs = 6000 } = {}) {
  const t = text.trim();
  if (t.length < 3 || /\d/.test(t)) return [];
  const ql = `[out:json][timeout:8];nwr["name"~"^${qre(t)}",i]["name"]["highway"!~"."](around:${Math.round(radius)},${f6(near.lat)},${f6(near.lon)});out center tags 60;`;
  try {
    const res = await query(ql, { signal, timeoutMs });
    return (res.elements || [])
      .map((e) => {
        const lat = e.lat ?? e.center?.lat;
        const lon = e.lon ?? e.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const tags = e.tags || {};
        const kind = (tags.shop || tags.amenity || tags.leisure || tags.tourism || tags.office || '').replace(/_/g, ' ');
        const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
        return { label: tags.name, address: [addr, tags['addr:city']].filter(Boolean).join(', '), kind, lat, lon };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

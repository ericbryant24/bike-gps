// On-device place index built from the vector tiles the map already uses.
// Every named shop, park, café, street, water body and neighbourhood within
// a few kilometres is indexed, and queries are matched with punctuation-blind
// prefix + fuzzy matching, nearest first. No geocoder quirks, works offline
// once the tiles are cached.

import { distance } from './geo.js';
import { decodeTile, tileAt } from './mvt.js';

export const INDEX_ZOOM = 14;
export const INDEX_RADIUS_M = 5000;

const KIND = {
  poi: (p) => (p.subclass || p.class || 'place').replace(/_/g, ' '),
  park: () => 'park',
  place: (p) => (p.class || 'place').replace(/_/g, ' '),
  water_name: (p) => (p.class || 'water').replace(/_/g, ' '),
  aerodrome_label: () => 'airport',
  mountain_peak: () => 'peak',
  transportation_name: (p) => ({ cycleway: 'bike path', path: 'path', footway: 'footpath', track: 'track' })[p.class] || 'road',
};
const LAYERS = Object.keys(KIND);

/** Lowercase, accent-free, apostrophes removed, other punctuation → spaces. */
export function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘ʼ'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function centroid(rings) {
  const ring = rings[0] || [];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
    n++;
  }
  return n ? [sx / n, sy / n] : null;
}

/** Named places in one decoded tile → [{ name, kind, layer, lat, lon }]. */
export function extractPlaces(layers) {
  const out = [];
  for (const layer of LAYERS) {
    const L = layers[layer];
    if (!L) continue;
    for (const f of L.features) {
      const p = f.properties || {};
      const name = p.name || p['name:latin'];
      if (!name) continue;
      let pt = null;
      if (f.type === 1) pt = f.geometry[0];
      else if (f.type === 2) {
        const line = f.geometry[0] || [];
        pt = line[Math.floor(line.length / 2)];
      } else if (f.type === 3) pt = centroid(f.geometry);
      if (!pt) continue;
      out.push({ name, kind: KIND[layer](p), layer, lon: pt[0], lat: pt[1] });
    }
  }
  return out;
}

/** Tiles covering a circle around a point. */
export function tilesAround(center, radiusM, z = INDEX_ZOOM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const a = tileAt(center.lat + dLat, center.lon - dLon, z);
  const b = tileAt(center.lat - dLat, center.lon + dLon, z);
  const tiles = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) tiles.push({ z, x, y });
  return tiles;
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition), capped at max+1. */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Typo tolerance grows with the token; typos in the first letter are not tolerated.
const allowance = (tok) => (tok.length >= 8 ? 2 : tok.length >= 4 ? 1 : 0);
const fuzzyTok = (q, n) => {
  if (n.startsWith(q)) return true;
  const max = allowance(q);
  return max > 0 && q[0] === n[0] && (editDistance(q, n.slice(0, q.length), max) <= max || editDistance(q, n, max) <= max);
};

/**
 * Match tier for a normalised name against normalised query tokens:
 *   1 name starts with the query · 2 every query token prefixes a name token ·
 *   3 every query token fuzzily matches a name token · 0 no match
 */
export function matchTier(normName, normQuery, qTokens) {
  if (!normQuery) return 0;
  if (normName.startsWith(normQuery)) return 1;
  const nTokens = normName.split(' ');
  if (qTokens.every((q) => nTokens.some((n) => n.startsWith(q)))) return 2;
  if (qTokens.every((q) => nTokens.some((n) => fuzzyTok(q, n)))) return 3;
  return 0;
}

export class PlaceIndex {
  constructor({ tileUrl, fetchImpl = null, concurrency = 6 } = {}) {
    this.tileUrl = tileUrl; // template with {z}/{x}/{y}
    // Wrap so browsers don't see fetch called with a foreign `this` ("Illegal invocation").
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.concurrency = concurrency;
    this.entries = [];
    this.center = null;
    this.radius = 0;
    this.building = null;
  }

  /** Does the index already cover this point, with a margin so nearby results aren't cut off at the edge? */
  covers(p) {
    if (!this.center) return false;
    const margin = Math.min(1500, this.radius * 0.3);
    return distance(this.center, p) + margin <= this.radius;
  }

  /** Build (or rebuild) around `center`. Resolves when done; safe to call repeatedly. */
  build(center, { radius = INDEX_RADIUS_M, onProgress, signal } = {}) {
    if (this.building) return this.building;
    this.building = (async () => {
      const tiles = tilesAround(center, radius);
      const byKey = new Map();
      let done = 0;
      const work = tiles.slice();
      const worker = async () => {
        while (work.length) {
          const t = work.shift();
          try {
            const res = await this.fetchImpl(this.tileUrl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y), { signal });
            if (res.ok) {
              for (const e of extractPlaces(decodeTile(new Uint8Array(await res.arrayBuffer()), t))) {
                const k = `${normalize(e.name)}|${e.kind}`;
                const d = distance(center, e);
                const prev = byKey.get(k);
                if (!prev || d < prev.d) byKey.set(k, { ...e, d, norm: normalize(e.name) });
              }
            }
          } catch (err) {
            if (signal?.aborted) throw err;
          }
          done++;
          onProgress?.(done, tiles.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, tiles.length) }, worker));
      this.entries = [...byKey.values()];
      this.center = center;
      this.radius = radius;
      return this.entries.length;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  /** Query the index; results in the app's search-result shape, nearest first within match tier. */
  search(query, anchor, { limit = 15 } = {}) {
    const nq = normalize(query);
    if (nq.length < 2) return [];
    const qTokens = nq.split(' ');
    const hits = [];
    for (const e of this.entries) {
      const tier = matchTier(e.norm, nq, qTokens);
      if (!tier) continue;
      hits.push({ label: e.name, address: '', kind: e.kind, lat: e.lat, lon: e.lon, distance: distance(anchor, e), tier, osm: `tiles=${e.layer}` });
    }
    // Roads are rarely destinations: rank them after places at the same tier.
    hits.sort((a, b) => a.tier - b.tier || (a.osm === 'tiles=transportation_name') - (b.osm === 'tiles=transportation_name') || a.distance - b.distance);
    return hits.slice(0, limit);
  }
}

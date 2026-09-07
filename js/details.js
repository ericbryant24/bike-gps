// Place details from free sources: what's inside a park (from the vector
// tiles, offline), a Wikipedia paragraph + photo when one exists, nearby
// Wikimedia Commons photos, and TomTom opening hours formatting.

import { distance } from './geo.js';
import { decodeTile } from './mvt.js';
import { tilesAround, normalize } from './places.js';

// ------------------------------------------------------------ geometry
const M_PER_DEG_LAT = 111320;

/** Ray-casting point-in-ring. p = {lat, lon}; ring = [[lon, lat], …]. */
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area of a lon/lat ring in m² (shoelace on a local equirectangular plane). */
export function ringArea(ring) {
  if (!ring || ring.length < 3) return 0;
  const lat0 = ring.reduce((s, [, la]) => s + la, 0) / ring.length;
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    a += x1 * kx * (y2 * M_PER_DEG_LAT) - x2 * kx * (y1 * M_PER_DEG_LAT);
  }
  return Math.abs(a) / 2;
}

export function formatArea(m2, units = 'metric') {
  if (!(m2 > 0)) return '';
  if (units === 'imperial') {
    const acres = m2 / 4046.86;
    return acres >= 10 ? `${Math.round(acres)} acres` : `${acres.toFixed(1)} acres`;
  }
  const ha = m2 / 10000;
  return ha >= 10 ? `${Math.round(ha)} ha` : `${ha.toFixed(1)} ha`;
}

// ------------------------------------------------------------ parks from tiles
/** OpenMapTiles poi classes/subclasses worth listing for "is this the park I mean?". */
const AMENITY = {
  playground: 'playground', toilets: 'restrooms', picnic_site: 'picnic area', bbq: 'grills', drinking_water: 'drinking water', dog_park: 'dog park',
  pitch: 'sports fields', swimming_pool: 'pool', swimming_area: 'swimming', shelter: 'shelter', bicycle_parking: 'bike racks', parking: 'parking',
  skateboard: 'skate park', golf: 'golf', garden: 'garden', fountain: 'fountain', viewpoint: 'viewpoint', track: 'running track', fitness_centre: 'fitness',
  fitness_station: 'outdoor gym', miniature_golf: 'mini golf', stadium: 'stadium', bandstand: 'bandstand', theatre: 'amphitheatre', ice_rink: 'ice rink',
  marina: 'marina', slipway: 'boat ramp', fishing: 'fishing', bird_hide: 'bird hide', attraction: 'attraction', monument: 'monument', memorial: 'memorial',
  artwork: 'public art', cafe: 'café', restaurant: 'restaurant', school: 'school', community_centre: 'community centre', library: 'library', museum: 'museum', zoo: 'zoo',
};
const PLURAL = { playground: 'playgrounds', shelter: 'shelters', fountain: 'fountains', garden: 'gardens', monument: 'monuments', memorial: 'memorials', viewpoint: 'viewpoints', picnic_site: 'picnic areas', parking: 'parking lots', toilets: 'restroom buildings', bandstand: 'bandstands', artwork: 'public artworks', attraction: 'attractions', pitch: 'sports fields' };
const WATER = { lake: 'lake', pond: 'pond', river: 'river', stream: 'stream', reservoir: 'reservoir' };

/** OpenMapTiles puts park outlines in `landcover` (unnamed; subclass says what it is). */
export const PARK_SUBCLASS = /^(park|garden|recreation_ground|playground|pitch|golf_course|cemetery|nature_reserve|village_green|common|dog_park|grass)$/;

const bboxOf = (rings) => {
  const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const r of rings) for (const [x, y] of r) { b.minLon = Math.min(b.minLon, x); b.maxLon = Math.max(b.maxLon, x); b.minLat = Math.min(b.minLat, y); b.maxLat = Math.max(b.maxLat, y); }
  return b;
};
const touches = (a, b, eps) => a.minLon <= b.maxLon + eps && b.minLon <= a.maxLon + eps && a.minLat <= b.maxLat + eps && b.minLat <= a.maxLat + eps;

/**
 * The park outline for a place: the landcover polygon containing the point (or,
 * when the point is on the street outside, containing the park's own label
 * point), grown across tile edges so a park cut into pieces is counted whole.
 */
export function parkRings(layers, p, name) {
  const polys = (layers.landcover?.features || []).filter((f) => f.type === 3 && PARK_SUBCLASS.test(f.properties?.subclass || ''));
  const containing = (q) => polys.filter((f) => f.geometry.some((r) => pointInRing(q, r)));
  let seed = containing(p);
  if (!seed.length && name) {
    const norm = normalize(name);
    const labels = [...(layers.park?.features || []), ...(layers.poi?.features || [])].filter((f) => f.type === 1 && f.properties?.name && normalize(f.properties.name) === norm);
    for (const l of labels) {
      seed = containing({ lon: l.geometry[0][0], lat: l.geometry[0][1] });
      if (seed.length) break;
    }
  }
  if (!seed.length) return null;
  const union = new Set(seed);
  const eps = 3 / 111320; // ~3 m: tile pieces overlap by their buffer, separate parks don't
  let grew = true;
  while (grew) {
    grew = false;
    const ub = bboxOf([...union].flatMap((f) => f.geometry));
    for (const f of polys) {
      if (union.has(f) || f.properties.subclass !== seed[0].properties.subclass) continue;
      if (touches(bboxOf(f.geometry), ub, eps)) {
        union.add(f);
        grew = true;
      }
    }
  }
  return { name: name || 'Park', rings: [...union].flatMap((f) => f.geometry) };
}

/** Amenities inside any of the rings: [{ kind, label, count }], most numerous first. */
export function amenitiesIn(layers, rings) {
  const seen = new Set();
  const counts = new Map();
  const add = (kind, label, pt) => {
    const k = `${kind}|${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
    if (seen.has(k)) return;
    seen.add(k);
    counts.set(kind, { kind, label, count: (counts.get(kind)?.count || 0) + 1 });
  };
  const inside = (pt) => rings.some((r) => pointInRing({ lon: pt[0], lat: pt[1] }, r));
  for (const f of layers.poi?.features || []) {
    if (f.type !== 1) continue;
    const pt = f.geometry[0];
    if (!pt || !inside(pt)) continue;
    const cls = f.properties?.subclass in AMENITY ? f.properties.subclass : f.properties?.class;
    if (AMENITY[cls]) add(cls, AMENITY[cls], pt);
  }
  for (const f of layers.water_name?.features || []) {
    if (f.type !== 1) continue;
    const pt = f.geometry[0];
    if (!pt || !inside(pt)) continue;
    const cls = f.properties?.class;
    if (WATER[cls]) add(`water:${cls}`, f.properties.name ? `${f.properties.name} (${WATER[cls]})` : WATER[cls], pt);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function describeAmenities(list) {
  return list.map((a) => (a.count > 1 ? `${a.count} ${PLURAL[a.kind] || a.label}` : a.label)).join(', ');
}

/** Merge decoded layers from several tiles into one {layer: {features}} bag. */
function mergeLayers(tiles) {
  const out = {};
  for (const layers of tiles) for (const [name, L] of Object.entries(layers)) (out[name] ||= { features: [] }).features.push(...(L.features || []));
  return out;
}

/**
 * Park facts for a place: { name, area (m²), amenities } or null when the point
 * isn't in a named park. Fetches the z14 tiles around the point (usually cached).
 */
export async function parkFromTiles(tileUrl, p, name, { radius = 700, fetchImpl = (...a) => globalThis.fetch(...a), signal } = {}) {
  const tiles = tilesAround(p, radius);
  const decoded = await Promise.all(
    tiles.map(async (t) => {
      try {
        const res = await fetchImpl(tileUrl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y), { signal });
        return res.ok ? decodeTile(new Uint8Array(await res.arrayBuffer()), t) : {};
      } catch {
        return {};
      }
    })
  );
  const layers = mergeLayers(decoded);
  const park = parkRings(layers, p, name);
  if (!park) return null;
  // Clipped pieces of one park sum to its area; a ring nested inside a larger ring is a hole.
  const areas = park.rings.map((r) => ({ r, a: ringArea(r) })).sort((x, y) => y.a - x.a);
  let area = 0;
  for (const { r, a } of areas) {
    const hole = areas.some((o) => o.a > a && pointInRing({ lon: r[0][0], lat: r[0][1] }, o.r));
    area += hole ? -a : a;
  }
  return { name: park.name, area: Math.max(0, area), amenities: amenitiesIn(layers, park.rings) };
}

// ------------------------------------------------------------ opening hours (TomTom)
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toDate = (t) => new Date(`${t.date}T${pad2(t.hour)}:${pad2(t.minute)}:00`);

export function formatTime(h, m, locale = 'en-US') {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: m ? '2-digit' : undefined }).format(new Date(2000, 0, 1, h, m));
  } catch {
    return `${pad2(h)}:${pad2(m)}`;
  }
}

/**
 * TomTom openingHours (mode nextSevenDays) → { openNow, today, next } where
 * today is "11 AM – 10 PM" (several ranges joined) or "Closed today".
 */
export function formatHours(openingHours, now = new Date(), locale = 'en-US') {
  const ranges = openingHours?.timeRanges || [];
  if (!ranges.length) return null;
  const today = localDate(now);
  const todays = ranges.filter((r) => r.startTime?.date === today);
  const fmt = (t) => formatTime(t.hour, t.minute, locale);
  const openNow = ranges.some((r) => toDate(r.startTime) <= now && now < toDate(r.endTime));
  const closesAt = ranges.find((r) => toDate(r.startTime) <= now && now < toDate(r.endTime))?.endTime;
  const opensNext = ranges.map((r) => r.startTime).filter((t) => toDate(t) > now).sort((a, b) => toDate(a) - toDate(b))[0];
  return {
    openNow,
    today: todays.length ? todays.map((r) => `${fmt(r.startTime)} – ${fmt(r.endTime)}`).join(', ') : 'Closed today',
    closesAt: closesAt ? fmt(closesAt) : null,
    opensAt: opensNext ? `${opensNext.date === today ? '' : `${new Date(`${opensNext.date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' })} `}${fmt(opensNext)}` : null,
  };
}

// ------------------------------------------------------------ Wikipedia / Commons
const WIKI_UA = 'BikeGPS/1.0 (https://github.com/ericbryant24/bike-gps)';
const wikiHeaders = { Accept: 'application/json', 'Api-User-Agent': WIKI_UA };

/** Choose the geosearch hit that is this place: same name (parenthetical dropped) and close by. */
export function pickWikiTitle(name, hits, { maxDist = 450 } = {}) {
  const n = normalize(name);
  if (!n) return null;
  const strip = (t) => normalize(String(t).replace(/\s*\(.*?\)\s*$/, ''));
  const scored = hits
    .filter((h) => (h.dist ?? 0) <= maxDist)
    .map((h) => {
      const t = strip(h.title);
      let score = 0;
      if (t === n) score = 3;
      else if (t.startsWith(n) || n.startsWith(t)) score = 2;
      else {
        const nt = new Set(n.split(' '));
        const overlap = t.split(' ').filter((w) => nt.has(w)).length;
        if (overlap >= 2 && overlap >= Math.min(nt.size, t.split(' ').length) - 1) score = 1;
      }
      return { h, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.h.dist - b.h.dist);
  return scored[0]?.h || null;
}

export async function wikipediaFor(name, p, { fetchImpl = (...a) => globalThis.fetch(...a), signal, lang = 'en' } = {}) {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p.lat.toFixed(5)}|${p.lon.toFixed(5)}&gsradius=600&gslimit=10&format=json&origin=*`;
  const res = await fetchImpl(api, { signal, headers: wikiHeaders });
  if (!res.ok) return null;
  const hit = pickWikiTitle(name, (await res.json())?.query?.geosearch || []);
  if (!hit) return null;
  const sum = await fetchImpl(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, { signal, headers: wikiHeaders });
  if (!sum.ok) return null;
  const s = await sum.json();
  if (!s?.extract) return null;
  return { title: s.title, extract: s.extract, thumbnail: s.thumbnail?.source || null, url: s.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}` };
}

/** Geotagged photos on Wikimedia Commons within `radius` m: [{ thumb, url, title }]. */
export async function commonsPhotos(p, { radius = 220, limit = 8, width = 320, fetchImpl = (...a) => globalThis.fetch(...a), signal } = {}) {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${p.lat.toFixed(5)}|${p.lon.toFixed(5)}&ggsradius=${radius}&ggsnamespace=6&ggslimit=${limit}&prop=imageinfo&iiprop=url&iiurlwidth=${width}&format=json&origin=*`;
  const res = await fetchImpl(api, { signal, headers: wikiHeaders });
  if (!res.ok) return [];
  const pages = Object.values((await res.json())?.query?.pages || {});
  return pages
    .filter((pg) => /\.(jpe?g|png|webp)$/i.test(pg.title || '') && pg.imageinfo?.[0]?.thumburl)
    .map((pg) => ({ thumb: pg.imageinfo[0].thumburl, url: pg.imageinfo[0].descriptionurl || pg.imageinfo[0].url, title: pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '') }));
}

/** Distance helper re-exported for callers matching TomTom hits to a tapped point. */
export { distance };

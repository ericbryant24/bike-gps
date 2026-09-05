// Nominatim geocoding. Usage policy: ≤1 request/second, identify the app.
// Requests are serialised through a small queue that enforces the spacing.

const ENDPOINT = 'https://nominatim.openstreetmap.org';
const MIN_GAP_MS = 1100;
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
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).map(formatResult);
}

const baseParams = (q, limit) => new URLSearchParams({ q, format: 'jsonv2', limit: String(limit), addressdetails: '1', dedupe: '1' });
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

/**
 * Search for places near a point. Looks inside a box around `near` first so
 * chains ("Kroger") return the nearby branches, then widens if that found
 * little. Results are unsorted; callers sort by distance.
 */
export async function search(query, { near, radiusKm = 30, limit = 10, signal, fetchImpl = globalThis.fetch } = {}) {
  const q = query.trim();
  if (!q) return [];
  const direct = parseLatLon(q);
  if (direct) return [{ label: `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}`, address: 'Coordinates', kind: '', ...direct }];
  return throttled(async () => {
    let results = [];
    if (near) {
      const dLat = radiusKm / 111;
      const dLon = dLat / Math.max(0.2, Math.cos((near.lat * Math.PI) / 180));
      const p = baseParams(q, limit);
      p.set('viewbox', viewbox({ minLon: near.lon - dLon, maxLon: near.lon + dLon, minLat: near.lat - dLat, maxLat: near.lat + dLat }));
      p.set('bounded', '1');
      results = await nominatim(p, { signal, fetchImpl });
    }
    if (results.length < 3) {
      const p = baseParams(q, limit);
      if (near) p.set('viewbox', viewbox({ minLon: near.lon - 0.5, maxLon: near.lon + 0.5, minLat: near.lat - 0.5, maxLat: near.lat + 0.5 }));
      results = dedupe([...results, ...(await nominatim(p, { signal, fetchImpl }))]);
    }
    return results;
  });
}

/** Search only inside the given bounds ("search this area"). */
export async function searchInBounds(query, bounds, { limit = 12, signal, fetchImpl = globalThis.fetch } = {}) {
  const q = query.trim();
  if (!q) return [];
  return throttled(async () => {
    const p = baseParams(q, limit);
    p.set('viewbox', viewbox(bounds));
    p.set('bounded', '1');
    return nominatim(p, { signal, fetchImpl });
  });
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

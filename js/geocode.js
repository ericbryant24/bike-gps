// Nominatim geocoding. Usage policy: ≤1 request/second, identify the app.
// Requests are serialised through a small queue that enforces the spacing.

const ENDPOINT = 'https://nominatim.openstreetmap.org';
const MIN_GAP_MS = 1100;
let lastAt = 0;
let chain = Promise.resolve();

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
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

/**
 * Search for places. `near` biases results towards a location
 * (Nominatim viewbox without `bounded`, so far-away matches still appear).
 */
export async function search(query, { near, limit = 6, signal, fetchImpl = globalThis.fetch } = {}) {
  const q = query.trim();
  if (!q) return [];
  const direct = parseLatLon(q);
  if (direct) return [{ label: `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}`, address: 'Coordinates', kind: '', ...direct }];
  return throttled(async () => {
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: String(limit), addressdetails: '1' });
    if (near) {
      const d = 0.4;
      params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
    }
    const res = await fetchImpl(`${ENDPOINT}/search?${params}`, {
      signal,
      headers: { Accept: 'application/json', 'Accept-Language': globalThis.navigator?.language || 'en' },
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const list = await res.json();
    return list.map(formatResult);
  });
}

/** Reverse geocode to a short label; never throws (returns null instead). */
export async function reverse(point, { signal, fetchImpl = globalThis.fetch } = {}) {
  try {
    return await throttled(async () => {
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

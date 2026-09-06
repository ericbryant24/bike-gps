// Recognise map links pasted into search — Google Maps (full and short),
// Apple Maps, OpenStreetMap, Bing, geo: URIs — and extract a destination.
//
// parseMapLink(text) → one of
//   { kind: 'coords', lat, lon, label, approx }   a place with coordinates
//   { kind: 'query',  query }                     a place name to search for
//   { kind: 'short',  url, label }                a short link that must be resolved first
//   null                                          not a map link

const URL_RE = /(https?:\/\/[^\s<>"`]+|geo:[^\s<>"`]+)/i; // apostrophes are legal in URLs ("Whit's")
const LATLON = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

const valid = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const coords = (lat, lon, label, approx = false) => (valid(lat, lon) ? { kind: 'coords', lat, lon, label: label || '', approx } : null);
const pretty = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
  } catch {
    return String(s).replace(/\+/g, ' ').trim();
  }
};
const latLonIn = (s) => {
  const m = String(s || '').match(LATLON);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/**
 * Google's share links often carry no coordinates, only
 * "q=Name, 663 N High St, Worthington, OH 43085, United States". Split that
 * into the place name and the postal address (the address starts at the first
 * comma-separated part that begins with a house number).
 */
export function splitPlaceQuery(q) {
  const parts = String(q || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const at = parts.findIndex((s) => /^\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+\S/i.test(s));
  if (at < 0 || parts.length - at < 2) return { name: parts.join(', '), address: '' };
  return { name: parts.slice(0, at).join(', '), address: parts.slice(at).join(', ') };
}

/** The place name a share sheet puts next to the link ("Whit's Frozen Custard\nhttps://maps.app.goo.gl/…"). */
export function labelFromText(text) {
  const rest = String(text).replace(new RegExp(URL_RE.source, 'gi'), ' ');
  const line = rest
    .split(/\r?\n/)
    .map((l) => l.replace(/[\s·•|–-]+$/g, '').trim())
    .find((l) => /\p{L}/u.test(l) && !/^(https?|www\.)/i.test(l));
  return line ? line.slice(0, 80) : '';
}

function parseGoogle(u, url, label) {
  const decoded = pretty(url);
  let name = '';
  const place = decoded.match(/\/maps\/place\/([^/@?]+)/);
  if (place) name = place[1];
  const search = decoded.match(/\/maps\/search\/([^/@?]+)/);
  if (!name && search) name = search[1];
  const dir = decoded.match(/\/maps\/dir\/(?:[^/@?]*\/)*([^/@?]+)\/?(?:@|data|$)/);
  if (!name && dir && !latLonIn(dir[1])) name = dir[1];
  const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('destination') || u.searchParams.get('daddr') || '';
  const nameLooksLikeCoords = latLonIn(name);
  const split = splitPlaceQuery(latLonIn(q) ? '' : pretty(q));
  const finalLabel = (!nameLooksLikeCoords && name) || split.name || split.address || label;

  // Exact place position lives in the data blob; "@lat,lng" is only the map centre.
  const blob = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (blob) return coords(Number(blob[1]), Number(blob[2]), finalLabel);
  for (const key of ['q', 'query', 'destination', 'daddr', 'll', 'center', 'sll']) {
    const c = latLonIn(u.searchParams.get(key));
    if (c) return coords(c[0], c[1], finalLabel, false);
  }
  if (nameLooksLikeCoords) return coords(nameLooksLikeCoords[0], nameLooksLikeCoords[1], label);
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at && (place || dir)) return coords(Number(at[1]), Number(at[2]), finalLabel, true);
  if (split.address) return { kind: 'query', query: `${split.name ? `${split.name}, ` : ''}${split.address}`, name: split.name, address: split.address };
  if (finalLabel && !/^https?:/i.test(finalLabel)) return { kind: 'query', query: finalLabel };
  if (at) return coords(Number(at[1]), Number(at[2]), label, true);
  return null;
}

function parseApple(u, label) {
  const p = u.searchParams;
  const name = pretty(p.get('name') || p.get('q') || p.get('address') || '') || label;
  for (const key of ['ll', 'coordinate', 'sll', 'q', 'daddr']) {
    const c = latLonIn(p.get(key));
    if (c) return coords(c[0], c[1], name === p.get(key) ? label : name);
  }
  if (name) return { kind: 'query', query: name };
  return null;
}

function parseOsm(u, label) {
  const p = u.searchParams;
  if (p.get('mlat') && p.get('mlon')) return coords(Number(p.get('mlat')), Number(p.get('mlon')), label);
  const hash = u.hash.match(/map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (hash) return coords(Number(hash[1]), Number(hash[2]), label, true);
  const q = p.get('query');
  if (q) return { kind: 'query', query: pretty(q) };
  return null;
}

export function parseMapLink(text) {
  if (!text) return null;
  const m = String(text).match(URL_RE);
  if (!m) return null;
  let raw = m[0].replace(/[.,;!?']+$/, '');
  // A trailing ")" is sentence punctuation unless it closes a paren inside the link, as in geo:…(Whit's).
  while (raw.endsWith(')') && (raw.match(/\)/g) || []).length > (raw.match(/\(/g) || []).length) raw = raw.slice(0, -1).replace(/[.,;!?']+$/, '');
  const label = labelFromText(text);

  if (/^geo:/i.test(raw)) {
    const g = raw.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
    const q = raw.match(/[?&]q=([^&]+)/i);
    if (g && valid(Number(g[1]), Number(g[2]))) return coords(Number(g[1]), Number(g[2]), q ? pretty(q[1]).replace(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?(\(([^)]*)\))?$/, '$4') : label);
    if (q) return { kind: 'query', query: pretty(q[1]) };
    return null;
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co') return { kind: 'short', url: raw, label };
  if (/(^|\.)google\.[a-z.]+$/.test(host)) {
    // Unshorteners abroad get bounced through the cookie-consent page, which
    // carries the real destination in ?continue=.
    const cont = u.searchParams.get('continue');
    if (cont && /^https?:\/\//i.test(cont)) {
      const inner = parseMapLink(label ? `${label}\n${cont}` : cont);
      if (inner) return inner;
    }
    if (u.searchParams.get('cid') && !u.searchParams.get('q')) return { kind: 'short', url: raw, label }; // opaque place id: needs the redirect
    return parseGoogle(u, raw, label);
  }
  if (/(^|\.)apple\.com$/.test(host) && /maps/.test(host + u.pathname)) return parseApple(u, label);
  if (/(^|\.)(openstreetmap\.org|osm\.org)$/.test(host)) return parseOsm(u, label);
  if (/bing\.com$/.test(host) && /maps/.test(u.pathname)) {
    const cp = (u.searchParams.get('cp') || '').split('~').map(Number);
    if (cp.length === 2) return coords(cp[0], cp[1], label, true);
  }
  return null;
}

/** Resolve a short link to its final URL via a public unshortener (CORS-enabled). Null on failure. */
export async function unshorten(url, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://unshorten.me/json/${url}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.success && typeof json.resolved_url === 'string' && json.resolved_url !== url ? json.resolved_url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

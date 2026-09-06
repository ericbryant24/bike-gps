/* Bike GPS service worker.
 *
 * - App shell: stale-while-revalidate in a versioned cache, so the app opens
 *   instantly and offline, and picks up new deploys on the next launch.
 * - Map tiles: cache-first with an LRU cap, so recently viewed areas keep
 *   working without signal. Only real (CORS, status 200) responses are kept —
 *   opaque responses would blow through storage quotas.
 * - Routing / geocoding / Overpass: network only (never stale).
 */

importScripts('./js/version.js');
const VERSION = self.APP_VERSION;
const SHELL_CACHE = `bikegps-shell-${VERSION}`;
const TILE_CACHE = 'bikegps-tiles-v1';
const MAP_ASSET_CACHE = 'bikegps-mapassets-v1';
const TILE_LIMIT = 3000;

const SHELL = [
  './',
  './index.html',
  './app.webmanifest',
  './css/app.css',
  './js/version.js',
  './js/main.js',
  './js/ui.js',
  './js/map.js',
  './js/geo.js',
  './js/router.js',
  './js/alternatives.js',
  './js/rating.js',
  './js/share.js',
  './js/mvt.js',
  './js/places.js',
  './js/links.js',
  './js/instructions.js',
  './js/blocklist.js',
  './js/navigator.js',
  './js/voice.js',
  './js/storage.js',
  './js/geocode.js',
  './js/overpass.js',
  './vendor/maplibre/maplibre-gl.js',
  './vendor/maplibre/maplibre-gl.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|tile-cyclosm\.openstreetmap\.fr$|basemaps\.cartocdn\.com$|^tiles\.openfreemap\.org$/;
// Style JSON, TileJSON, sprites and glyphs: small, shared by every tile — keep fresh but serve instantly.
const MAP_ASSET_PATH = /^\/(styles|sprites|fonts|planet$|natural_earth\/[^/]+$)/;
const API_HOSTS = /brouter\.de$|nominatim\.openstreetmap\.org$|photon\.komoot\.io$|api\.mapbox\.com$|unshorten\.me$|overpass/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Add individually so one missing file doesn't fail the whole install.
      await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('bikegps-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_TILES') event.waitUntil(Promise.all([caches.delete(TILE_CACHE), caches.delete(MAP_ASSET_CACHE)]));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(req.mode === 'navigate' ? navigate(req) : staleWhileRevalidate(req));
    return;
  }
  if (TILE_HOSTS.test(url.hostname)) {
    event.respondWith(MAP_ASSET_PATH.test(url.pathname) ? staleWhileRevalidate(req, MAP_ASSET_CACHE) : tile(req));
    return;
  }
  if (API_HOSTS.test(url.hostname)) return; // network only
});

async function navigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put('./index.html', fresh.clone());
    return fresh;
  } catch {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName = SHELL_CACHE) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return (await network) || Response.error();
}

let tileCount = null;
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.type !== 'opaque') {
      cache.put(req, res.clone()).then(() => trimTiles(cache));
    }
    return res;
  } catch {
    return Response.error();
  }
}

async function trimTiles(cache) {
  if (tileCount == null) tileCount = (await cache.keys()).length;
  else tileCount += 1;
  if (tileCount <= TILE_LIMIT) return;
  const keys = await cache.keys();
  // Cache API returns keys in insertion order: drop the oldest 10%.
  const drop = keys.slice(0, Math.max(1, Math.floor(keys.length * 0.1)));
  await Promise.all(drop.map((k) => cache.delete(k)));
  tileCount = keys.length - drop.length;
}

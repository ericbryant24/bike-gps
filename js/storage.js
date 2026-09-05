// localStorage persistence with safe fallbacks (private mode, quota, Node).

import { DEFAULT_ENDPOINT } from './router.js';

export const KEYS = {
  blocklist: 'bikegps.blocklist.v1',
  settings: 'bikegps.settings.v1',
  lastRoute: 'bikegps.lastRoute.v1',
  recents: 'bikegps.recents.v1',
  view: 'bikegps.view.v1',
};

function localeIsImperial() {
  try {
    const lang = (globalThis.navigator?.language || '').toUpperCase();
    return /-(US|LR|MM)$/.test(lang);
  } catch {
    return false;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  units: localeIsImperial() ? 'imperial' : 'metric',
  voice: true,
  profile: 'trekking',
  tiles: 'liberty',
  navView: '3d', // '3d' course-up perspective | 'north' north-up flat
  crossing: 'signals', // default crossing rule for new blocked roads
  mapboxToken: '', // optional: Mapbox Search Box API public token for place search
  endpoint: DEFAULT_ENDPOINT,
  offRouteMeters: 40,
  autoReroute: true,
  streetNames: true,
  keepAwake: true,
  followMode: true,
});

let memory = new Map();
function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function load(key, fallback = null) {
  const s = store();
  try {
    const raw = s ? s.getItem(key) : memory.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  const s = store();
  try {
    if (s) s.setItem(key, raw);
    else memory.set(key, raw);
    return true;
  } catch {
    memory.set(key, raw);
    return false;
  }
}

export function remove(key) {
  const s = store();
  try {
    if (s) s.removeItem(key);
  } catch {
    /* ignore */
  }
  memory.delete(key);
}

export function loadSettings() {
  const saved = load(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

export function saveSettings(settings) {
  return save(KEYS.settings, settings);
}

/** Recent destinations, most recent first, capped. */
export function pushRecent(place, max = 8) {
  const list = (load(KEYS.recents, []) || []).filter((r) => r.label !== place.label);
  list.unshift({ label: place.label, lat: place.lat, lon: place.lon, at: Date.now() });
  save(KEYS.recents, list.slice(0, max));
}

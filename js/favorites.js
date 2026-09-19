// Saved places ("favorites"): pure helpers over a plain array, persisted by
// the controller. A favorite is { id, name, label, lat, lon, kind, at }.

import { distance } from './geo.js';
import { normalize, matchTier } from './places.js';

const SAME_PLACE_M = 40; // two saves this close are the same place

export const QUICK_NAMES = ['Home', 'Work'];

export function newId() {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The favorite at (or within 40 m of) a point, else null. */
export function findFavoriteNear(list, p, radius = SAME_PLACE_M) {
  if (!p) return null;
  let best = null;
  for (const f of list || []) {
    const d = distance(p, f);
    if (d <= radius && (!best || d < best.d)) best = { f, d };
  }
  return best?.f || null;
}

/** Add (or, for an existing nearby favorite, rename) and return the new list plus the saved entry. */
export function addFavorite(list, { name, label, lat, lon, kind = '' }) {
  const trimmed = String(name || label || 'Saved place').trim().slice(0, 60);
  const existing = findFavoriteNear(list, { lat, lon });
  if (existing) {
    const updated = { ...existing, name: trimmed, label: label || existing.label, kind: kind || existing.kind };
    return { list: (list || []).map((f) => (f.id === existing.id ? updated : f)), fav: updated };
  }
  const fav = { id: newId(), name: trimmed, label: label || trimmed, lat, lon, kind, at: Date.now() };
  return { list: [fav, ...(list || [])], fav };
}

export function removeFavorite(list, id) {
  return (list || []).filter((f) => f.id !== id);
}

export function renameFavorite(list, id, name) {
  const trimmed = String(name || '').trim().slice(0, 60);
  if (!trimmed) return list;
  return (list || []).map((f) => (f.id === id ? { ...f, name: trimmed } : f));
}

/** Favorites whose name (or original label) matches the query, in the app's search-result shape, nearest first. */
export function searchFavorites(list, query, anchor) {
  const nq = normalize(query || '');
  if (!nq) return [];
  const qTokens = nq.split(' ');
  return (list || [])
    .map((f) => {
      const tier = Math.min(matchTier(normalize(f.name), nq, qTokens) || 9, matchTier(normalize(f.label || ''), nq, qTokens) || 9);
      return tier <= 2 ? { ...toResult(f), tier: 1, order: -1, distance: anchor ? distance(anchor, f) : undefined } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

/** A favorite as a search result row. */
export function toResult(f) {
  return { label: f.name, address: f.label && f.label !== f.name ? f.label : '', kind: 'saved', lat: f.lat, lon: f.lon, osm: 'saved', favId: f.id };
}

// App controller: wires the map, routing, blocklist, navigation and UI.

import { MapView, TILE_SOURCES, DEFAULT_TILES } from './map.js';
import { bbox, distance, formatDistance, formatDuration, formatSpeed, pointAtDistance, slicePath } from './geo.js';
import { fetchRoute } from './router.js';
import { announceableSteps, applyNames, stepIcon, stepsFromGeometry, stepsFromVoiceHints } from './instructions.js';
import { rateSegments, rateSteps, routeComposition, gradeRuns } from './rating.js';
import { shareUrl, parseSharedRoute, toGpx } from './share.js';
import * as bl from './blocklist.js';
import { Navigator, simulateRide } from './navigator.js';
import { Voice } from './voice.js';
import * as store from './storage.js';
import * as geocode from './geocode.js';
import * as overpass from './overpass.js';
import { $, el, toast, hideToast, pill, hidePill, openModal, closeModal, openDrawer, closeDrawer, positionMenu, trackSheetHeight, renderSearchResults, renderProfileChips, renderSteps, renderSettings, renderBlocklist, renderEntryEditor, renderAbout, renderInstallHelp, renderComposition } from './ui.js';

const state = {
  settings: store.loadSettings(),
  blocklist: (store.load(store.KEYS.blocklist, []) || []).map(bl.normalizeEntry).filter(Boolean),
  start: null, // explicit start point, else current location
  dest: null,
  destLabel: '',
  route: null,
  steps: [], // all steps
  announceable: [],
  mode: 'idle', // idle | navigating
  nav: null,
  watchId: null,
  sim: null,
  lastFix: null,
  blockMode: null, // null | 'road' | 'stretch' | 'point'
  stretchPick: null,
  rerouting: false,
  lastRerouteAt: 0,
  wakeLock: null,
  installPrompt: null,
  planAbort: null,
  pending: null,
  lookup: null,
};

const voice = new Voice({ enabled: state.settings.voice });
const savedView = store.load(store.KEYS.view);
if (!TILE_SOURCES[state.settings.tiles]) state.settings.tiles = DEFAULT_TILES;
const map = new MapView($('map'), {
  center: savedView?.center || { lat: 39.9612, lon: -82.9988 },
  zoom: savedView?.zoom || 13,
  tiles: state.settings.tiles,
});
const courseUp = () => state.settings.navView !== 'north';

// ------------------------------------------------------------------ helpers
const units = () => state.settings.units;
const fixFromPosition = (pos) => ({
  lat: pos.coords.latitude,
  lon: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
  speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
  timestamp: pos.timestamp || Date.now(),
});

function saveSettings() {
  store.saveSettings(state.settings);
}
function saveBlocklist() {
  store.save(store.KEYS.blocklist, state.blocklist);
  $('blocklist-count').textContent = String(state.blocklist.length);
  map.renderBlocklist(state.blocklist);
}
function reportError(err, fallback = 'Something went wrong') {
  if (err?.name === 'AbortError') return;
  console.error(err);
  toast(err?.message || fallback, { duration: 5000 });
}

const getPosition = (opts) =>
  new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, opts));

/**
 * Get a usable position. Desktop browsers often can't produce a precise fix,
 * so a quick high-accuracy attempt is followed by a coarse one that accepts a
 * cached position; a recent fix we already hold is reused as a last resort.
 */
async function currentPosition({ silent = false, maxAgeMs = 30000 } = {}) {
  if (state.lastFix && Date.now() - state.lastFix.timestamp < maxAgeMs) return state.lastFix;
  if (!navigator.geolocation) throw new Error('Location is not available in this browser. Long-press the map to choose a start point.');
  if (!silent) pill('Finding your location…', { spinner: true });
  let lastErr = null;
  try {
    for (const opts of [
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 },
    ]) {
      try {
        const fix = fixFromPosition(await getPosition(opts));
        onFix(fix);
        return fix;
      } catch (e) {
        lastErr = e;
        if (e?.code === 1) break; // permission denied: no point retrying
      }
    }
    if (state.lastFix && Date.now() - state.lastFix.timestamp < 15 * 60 * 1000) return state.lastFix;
    throw new Error(
      lastErr?.code === 1
        ? 'Location permission is off for this site. Allow it in your browser settings, or long-press the map to choose a start point.'
        : 'Could not get your location (this is common on computers without Wi-Fi location). Long-press the map to choose a start point.'
    );
  } finally {
    if (!silent) hidePill();
  }
}

function onFix(fix) {
  state.lastFix = fix;
  map.setMe(fix, { heading: fix.heading, accuracy: fix.accuracy });
  if (state.nav) state.nav.update(fix);
}

// ------------------------------------------------------------------ routing
function buildSteps(route) {
  return route.voicehints ? stepsFromVoiceHints(route.voicehints, route.points, route.cum) : stepsFromGeometry(route.points, route.cum);
}

/**
 * Street names arrive from Overpass after the route is shown. Step objects are
 * updated in place; the announceable list is only rebuilt when not navigating
 * so in-progress announcements keep their indices.
 */
async function enrichNames(route, steps) {
  if (!state.settings.streetNames || !navigator.onLine) return;
  const names = await overpass.namesForSteps(steps, route);
  if (state.route !== route || !names.some(Boolean)) return;
  applyNames(steps, (s) => names[steps.indexOf(s)]);
  if (state.mode !== 'navigating') {
    state.announceable = announceableSteps(steps);
    applyRatings();
    renderSteps($('steps-list'), state.announceable, units());
  } else if (state.nav?.state) renderHud(state.nav.state);
  store.save(store.KEYS.lastRoute, { route, steps, dest: state.dest, destLabel: state.destLabel, start: state.start });
}

function routeBBox(from, to) {
  const pad = Math.max(1500, distance(from, to) * 0.35);
  return bbox([from, to], pad);
}

/**
 * Route with the blocklist applied.
 *
 * Pass 1 sends the blocks nearest the straight line start→destination. If
 * the request had to be thinned and the route still rides along a blocked
 * road, pass 2 re-sends with the blocks nearest the *route* prioritised.
 * If no route can avoid every block, a final pass uses soft penalties so the
 * router spends as little distance as possible on blocked roads. The route
 * carries `blockedUse` (which blocks it still rides along) and `soft`.
 */
async function computeRoute(from, to, { signal } = {}) {
  const box = routeBBox(from, to);
  const relaxAround = [{ point: from }, { point: to }];
  const active = state.blocklist.filter((e) => e.enabled);
  const request = (nogo) =>
    fetchRoute(
      { endpoint: state.settings.endpoint, from, to, profile: state.settings.profile, nogos: nogo.nogos, polylines: nogo.polylines, nogoIds: nogo.used },
      { signal }
    );
  let focus = [from, to];
  let route = null;
  let nogo = null;
  for (let pass = 0; pass < 2; pass++) {
    nogo = bl.toNogoParams(active, box, { relaxAround, focus });
    try {
      route = await request(nogo);
    } catch (e) {
      if (e.code !== 'no-route' || !(nogo.nogos || nogo.polylines)) throw e;
      // Fenced in: allow blocked roads, but make every metre on them expensive.
      const soft = bl.toNogoParams(active, box, { relaxAround, focus, weight: bl.SOFT_WEIGHT });
      route = await request(soft);
      route.soft = true;
      route.truncated = soft.truncated;
      route.blockedUse = bl.entriesUsedByRoute(route, active);
      return route;
    }
    route.blockedUse = bl.entriesUsedByRoute(route, active);
    route.truncated = nogo.truncated;
    if (!route.blockedUse.length || !nogo.truncated) break;
    focus = route.points;
  }
  return route;
}

async function planRoute() {
  if (!state.dest) return;
  state.planAbort?.abort();
  const ctrl = new AbortController();
  state.planAbort = ctrl;
  try {
    let from = state.start;
    if (!from) {
      try {
        from = await currentPosition();
      } catch (e) {
        // Still let the user plan: start from the middle of the map and say so.
        from = map.center;
        state.start = from;
        map.setStart(from);
        toast(`${e.message.split('.')[0]}. Starting from the map centre — long-press to move the start.`, { duration: 7000 });
      }
    }
    pill('Finding a route…', { spinner: true });
    const route = await computeRoute(from, state.dest, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    const steps = buildSteps(route);
    setRoute(route, steps);
    map.fitPoints(route.points, { top: 80, bottom: $('sheet').offsetHeight || 220 });
    store.save(store.KEYS.lastRoute, { route, steps, dest: state.dest, destLabel: state.destLabel, start: state.start });
    enrichNames(route, steps).catch(() => {});
  } catch (e) {
    reportError(e, 'Routing failed');
  } finally {
    if (state.planAbort === ctrl) {
      state.planAbort = null;
      hidePill();
    }
  }
}

/** Grade the roads of the current route; annotates steps and colours the map. */
function applyRatings() {
  const r = state.route;
  if (!r?.segments?.length) {
    $('route-comp').hidden = true;
    map.setRouteGrades(null);
    return;
  }
  const rated = rateSegments(r);
  r.composition = routeComposition(rated);
  rateSteps(state.announceable, rated);
  renderComposition($('route-comp'), r.composition, units());
  map.setRouteGrades(state.mode === 'navigating' ? null : gradeRuns(r, rated));
}

function setRoute(route, steps) {
  state.route = route;
  state.steps = steps;
  state.announceable = announceableSteps(steps);
  map.setRoute(route.points);
  map.setStart(route.from);
  map.setDest(state.dest);
  renderSheet();
}

function clearRoute() {
  state.planAbort?.abort();
  state.route = null;
  state.steps = [];
  state.announceable = [];
  state.dest = null;
  state.destLabel = '';
  state.start = null;
  map.setRoute(null);
  map.setStart(null);
  map.setDest(null);
  map.setDrop(null);
  $('sheet').hidden = true;
  $('search').value = '';
  $('search-clear').hidden = true;
  clearSearch();
  store.remove(store.KEYS.lastRoute);
}

function renderSheet() {
  const r = state.route;
  if (!r) return;
  $('plan-dist').textContent = formatDistance(r.length, units());
  $('plan-time').textContent = formatDuration(r.time);
  $('plan-ascend').textContent = units() === 'imperial' ? `↗ ${Math.round(r.ascend * 3.28084)} ft` : `↗ ${Math.round(r.ascend)} m`;
  $('plan-dest').textContent = state.destLabel || 'Dropped pin';
  renderProfileChips($('profile-chips'), state.settings.profile, (id) => {
    state.settings.profile = id;
    saveSettings();
    planRoute();
  });
  const warn = $('plan-warning');
  const blockedUsed = r.nogoIds?.length || 0;
  const uses = (r.blockedUse || []).map((u) => `${u.entry.name} (${formatDistance(u.meters, units())})`).join(', ');
  if (r.soft) {
    warn.textContent = `No route can avoid every blocked road. This one uses blocked roads as little as possible: ${uses || 'none'}.`;
    warn.hidden = false;
  } else if (uses) {
    warn.textContent = `Heads up: this route still rides along ${uses}.`;
    warn.hidden = false;
  } else if (blockedUsed) {
    warn.textContent = `Avoiding ${blockedUsed} blocked ${blockedUsed === 1 ? 'road' : 'roads'}${r.truncated ? ' (far-away parts of long blocks were left out of this request)' : ''}.`;
    warn.hidden = false;
  } else warn.hidden = true;
  applyRatings();
  $('shared-note').hidden = !r.shared;
  $('plan-time').textContent = r.shared ? `~${formatDuration(r.time)}` : formatDuration(r.time);
  renderSteps($('steps-list'), state.announceable, units());
  $('sheet').hidden = false;
  $('install-banner').hidden = true;
}

// --------------------------------------------------------------- navigation
async function startNavigation({ simulate = false } = {}) {
  if (!state.route) return;
  voice.unlock();
  let fix = state.lastFix;
  if (!simulate) {
    try {
      fix = await currentPosition();
    } catch (e) {
      reportError(e);
      return;
    }
  }
  state.mode = 'navigating';
  state.nav = new Navigator({ route: state.route, steps: state.announceable, units: units(), offRouteMeters: Number(state.settings.offRouteMeters) });
  state.nav.on('speak', ({ text, priority }) => voice.speak(text, { priority }));
  state.nav.on('update', renderHud);
  state.nav.on('offroute', () => {
    $('nav-offroute').hidden = false;
    if (state.settings.autoReroute) reroute();
  });
  state.nav.on('arrive', () => {
    $('nav-instr').textContent = 'You have arrived';
    $('nav-dist').textContent = '🏁';
    $('nav-icon').textContent = '⚑';
    $('nav-then').hidden = true;
    toast('You have arrived. Nice ride!', { duration: 6000 });
    if (state.sim) state.sim.stop();
  });

  $('sheet').hidden = true;
  $('topbar').hidden = true;
  $('search-here').hidden = true;
  $('install-banner').hidden = true;
  $('block-toolbar').hidden = true;
  $('nav-hud').hidden = false;
  $('nav-offroute').hidden = true;
  $('nav-mute').textContent = voice.enabled ? '🔊' : '🔇';
  $('nav-mute').setAttribute('aria-pressed', String(!voice.enabled));
  $('locate-btn').classList.add('active');
  map.setRouteGrades(null);
  map.setNavPadding({ top: $('nav-banner').offsetHeight + 24, bottom: $('nav-bottom').offsetHeight + 16 });
  map.setFollow(true, fix || state.route.from, { courseUp: courseUp(), heading: fix?.heading ?? null });
  updateCompass();
  map.setProgress(state.route.points, null);

  if (simulate) {
    state.sim = simulateRide(state.route, { speed: 6, intervalMs: 700, detourAt: 0.42, onFix });
    toast('Simulating a ride — it will wander off route once to show rerouting.', { duration: 5000 });
  } else {
    state.watchId = navigator.geolocation.watchPosition((pos) => onFix(fixFromPosition(pos)), (err) => console.warn('GPS', err), {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });
  }
  requestWakeLock();
  state.nav.start();
  if (fix) state.nav.update(fix);
}

function endNavigation() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.sim?.stop();
  state.sim = null;
  state.nav = null;
  state.mode = 'idle';
  voice.stop();
  releaseWakeLock();
  $('nav-hud').hidden = true;
  $('topbar').hidden = false;
  $('locate-btn').classList.remove('active');
  map.setFollow(false);
  updateCompass();
  if (state.route) {
    map.setRoute(state.route.points);
    renderSheet();
    map.fitPoints(state.route.points, { top: 80, bottom: $('sheet').offsetHeight || 220 });
  }
}

function renderHud(s) {
  const step = s.step;
  $('nav-icon').textContent = stepIcon(step);
  $('nav-dist').textContent = s.arrived ? '🏁' : formatDistance(s.distToStep, units());
  $('nav-instr').textContent = s.arrived ? 'You have arrived' : step.text;
  const showThen = s.next && s.next.kind !== 'arrive' && s.next.along - step.along < 150 && !s.arrived;
  $('nav-then').hidden = !showThen;
  if (showThen) {
    $('nav-then-icon').textContent = stepIcon(s.next);
    $('nav-then-text').textContent = s.next.text;
  }
  $('nav-speed').textContent = formatSpeed(s.speed, units());
  $('nav-remaining').textContent = formatDistance(s.remaining, units());
  const eta = new Date(Date.now() + s.etaSeconds * 1000);
  $('nav-eta').textContent = `${formatDuration(s.etaSeconds)} · arrive ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('nav-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!s.offRoute) $('nav-offroute').hidden = true;
  map.setProgress(state.route.points, s.snap);
  map.setMe(s.fix, { heading: s.bearing, accuracy: s.fix.accuracy });
}

async function reroute() {
  if (!state.nav || state.rerouting || !state.lastFix) return;
  if (Date.now() - state.lastRerouteAt < 8000) return;
  state.rerouting = true;
  state.lastRerouteAt = Date.now();
  try {
    const route = await computeRoute(state.lastFix, state.dest);
    if (!state.nav) return;
    const steps = buildSteps(route);
    state.route = route;
    state.steps = steps;
    state.announceable = announceableSteps(steps);
    map.setRoute(route.points);
    state.nav.setRoute(route, state.announceable);
    state.nav.started = true;
    $('nav-offroute').hidden = true;
    if (route.blockedUse?.length) {
      const names = route.blockedUse.map((u) => u.entry.name).join(', ');
      toast(route.soft ? `No route avoids every blocked road — using ${names} as little as possible.` : `Heads up: this route still uses ${names}.`, { duration: 6000 });
    }
    store.save(store.KEYS.lastRoute, { route, steps, dest: state.dest, destLabel: state.destLabel, start: null });
    enrichNames(route, steps).catch(() => {});
  } catch (e) {
    toast(`Rerouting failed: ${e.message}`, { duration: 4000 });
    // Allow another attempt on the next off-route signal.
    if (state.nav) state.nav.offRoute = false;
  } finally {
    state.rerouting = false;
  }
}

/**
 * During navigation: fence the road ahead and reroute. The route's own
 * geometry for the next few hundred metres is used immediately (no network
 * needed); Overpass adds the road name and junction positions if it answers
 * quickly, otherwise gates fall back to dense spacing.
 */
async function avoidRoadAhead() {
  if (!state.nav?.state || !state.route) return;
  const s = state.nav.state;
  const { points, cum, length } = state.route;
  const from = pointAtDistance(points, cum, Math.min(s.along + 5, length)).point;
  const to = pointAtDistance(points, cum, Math.min(s.along + 350, length)).point;
  const line = slicePath(points, from, to);
  if (line.length < 2 || distance(from, to) < 10) {
    toast('Too close to the destination to avoid this road.');
    return;
  }
  pill('Blocking this road…', { spinner: true });
  const local = map.roadFromTiles(line[Math.floor(line.length / 2)]);
  let name = local?.name || 'Road ahead';
  let junctions = local?.junctions || [];
  let signals = [];
  let signalsKnown = false;
  try {
    const along = await Promise.race([overpass.waysAlong(line), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
    junctions = along.junctions;
    signals = along.signals;
    signalsKnown = true;
    name = describeStretch(along.ways) || name;
  } catch {
    /* fall back to the plain geometry */
  } finally {
    hidePill();
  }
  const entry = bl.createStretch(line, { name, junctions, signals, signalsKnown, crossing: state.settings.crossing });
  addEntry(entry, { replan: false });
  state.lastRerouteAt = 0;
  if (state.nav) {
    state.nav.offRoute = true; // make the router look again from here
    await reroute();
  }
}

async function requestWakeLock() {
  if (!state.settings.keepAwake || !navigator.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* ignore */
  }
}
function releaseWakeLock() {
  state.wakeLock?.release?.();
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode === 'navigating') requestWakeLock();
});

// ---------------------------------------------------------------- blocklist
function addEntry(entry, { replan = true } = {}) {
  state.blocklist.unshift(entry);
  saveBlocklist();
  toast(`Blocked: ${entry.name}`, {
    action: 'Undo',
    onAction: () => {
      state.blocklist = state.blocklist.filter((e) => e.id !== entry.id);
      saveBlocklist();
      if (state.route && state.mode === 'idle') planRoute();
    },
    duration: 6000,
  });
  if (replan && state.route && state.mode === 'idle') planRoute();
  if (replan && state.mode === 'navigating') {
    state.lastRerouteAt = 0;
    reroute();
  }
}

// ---- block preview: nothing is added until the user confirms ---------------
function activeChip(containerId, attr, fallback) {
  const c = $(containerId).querySelector('.chip.active');
  return c ? Number(c.dataset[attr]) : fallback;
}

function showPreview(draft, ctx = {}) {
  state.pending = { draft, ...ctx };
  map.setPreview(draft);
  $('block-kind').hidden = true;
  $('block-hint').hidden = true;
  $('stretch-actions').hidden = true;
  $('block-preview').hidden = false;
  $('preview-name').value = draft.name;
  $('preview-range').hidden = draft.kind !== 'road';
  $('preview-radius').hidden = draft.kind !== 'point';
  $('preview-cross-row').hidden = draft.kind === 'point';
  const sel = $('preview-crossing');
  sel.replaceChildren(...Object.entries(bl.CROSSING_RULES).map(([v, label]) => el('option', { value: v, selected: (draft.crossing || state.settings.crossing) === v, text: label })));
  renderPreviewMeta();
  if (draft.kind !== 'point') {
    map.fitPoints(draft.lines.flat(), { top: $('block-toolbar').offsetHeight + 90, bottom: 40, side: 40 });
  }
}

function renderPreviewMeta() {
  const p = state.pending;
  if (!p) return;
  const d = p.draft;
  let text;
  if (d.kind === 'point') text = `${Math.round(d.radius)} m circle — nothing may pass through it.`;
  else {
    const junctions = bl.crossableJunctions(d).length;
    const lights = (d.signals || []).length;
    const lightsText = d.signalsKnown === false ? 'traffic lights not loaded' : `${lights} traffic ${lights === 1 ? 'light' : 'lights'}`;
    text = `${formatDistance(d.length || 0, units())}${d.lines.length > 1 ? ` · ${d.lines.length} sections` : ''} · ${junctions} ${junctions === 1 ? 'junction' : 'junctions'} · ${lightsText}`;
  }
  if (p.note) text += ` · ${p.note}`;
  $('preview-meta').textContent = text;
}

function cancelPreview() {
  if (!state.pending) return;
  state.pending = null;
  map.setPreview(null);
  $('block-preview').hidden = true;
  $('block-kind').hidden = false;
  $('block-hint').hidden = false;
  if (state.blockMode === 'stretch') resetStretch();
}

function confirmPreview() {
  const p = state.pending;
  if (!p) return;
  const draft = p.draft;
  draft.name = $('preview-name').value.trim() || draft.name;
  if (draft.kind !== 'point') draft.crossing = $('preview-crossing').value;
  cancelPreview();
  addEntry(draft);
}

function cancelLookup() {
  state.lookup?.abort();
  state.lookup = null;
  $('block-hint').textContent = state.blockMode ? BLOCK_HINTS[state.blockMode] : '';
}

async function blockRoadAt(p) {
  if (state.blockMode !== 'road') setBlockMode('road');
  cancelPreview();
  cancelLookup();
  const ctrl = (state.lookup = new AbortController());
  map.setDrop(p);
  const rangeKm = activeChip('preview-range', 'km', 5);

  // 1) Instant answer from the map tiles on screen (works offline).
  const local = map.roadFromTiles(p);
  if (local) {
    const draft = bl.createRoad(local.lines, {
      name: local.name,
      junctions: local.junctions,
      signalsKnown: false,
      gateHalfWidth: 10,
      source: 'tiles',
      crossing: state.settings.crossing,
    });
    showPreview(draft, { tap: p, way: { name: local.name, points: local.lines[0] }, rangeKm, note: 'visible part of the road — loading its full length and traffic lights…' });
    map.setDrop(null);
    // 2) Enrich from OpenStreetMap in the background; the card updates when it lands.
    previewRoad({ name: local.name, points: local.lines[0] }, p, rangeKm, { signal: ctrl.signal, quiet: true }).catch(() => {});
    return;
  }

  // Raster style or nothing loaded here: fall back to the map-data server.
  pill('Looking up the road…', { spinner: true });
  $('block-hint').textContent = 'Looking up the road…';
  try {
    const ways = await overpass.roadsAt(p, { radius: 18, timeoutMs: 8000, signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    const way = ways[0];
    if (!way || way.dist > 25) {
      toast('No road there. Tap closer to a road, or block a spot instead.');
      return;
    }
    await previewRoad(way, p, rangeKm, { signal: ctrl.signal });
  } catch (e) {
    if (!ctrl.signal.aborted) reportError(e, 'Could not look up that road — the map-data server may be busy. Try again in a moment.');
  } finally {
    hidePill();
    map.setDrop(null);
    if (state.lookup === ctrl) cancelLookup();
  }
}

/**
 * Build (or rebuild, for a new range) the whole-road draft from OpenStreetMap
 * and show it. With `quiet`, an existing tile-based preview stays on screen
 * and is replaced only if the lookup succeeds.
 */
async function previewRoad(way, tap, rangeKm, { signal, quiet = false } = {}) {
  const label = `Loading ${way.name || 'road'} within ${rangeKm} km…`;
  if (!quiet) pill(label, { spinner: true });
  $('block-hint').textContent = label;
  let draft = null;
  let note = null;
  try {
    if (way.name) {
      const { ways: named, junctions, signals } = await overpass.roadByName(way.name, tap, { radius: rangeKm * 1000, timeoutMs: 20000, signal });
      if (named.length) draft = bl.createRoad(named.map((w) => w.points), { name: way.name, junctions, signals, source: 'osm', crossing: state.settings.crossing });
    } else if (way.id) {
      const { ways: found, junctions, signals } = await overpass.wayWithJunctions(way.id, { timeoutMs: 20000, signal });
      draft = bl.createRoad([(found[0] || way).points], { name: overpass.describeWay(way), junctions, signals, source: 'osm', crossing: state.settings.crossing });
    }
  } catch {
    /* handled below */
  } finally {
    if (!quiet) hidePill();
  }
  if (signal?.aborted) return;
  if (!draft) {
    if (quiet && state.pending?.tap === tap) {
      state.pending.note = 'map-data server busy: showing the visible part of the road; crossing allowed at all junctions until traffic-light data loads. Pick a range to retry.';
      renderPreviewMeta();
      $('block-hint').textContent = BLOCK_HINTS.road;
      return;
    }
    draft = bl.createRoad([way.points], { name: overpass.describeWay(way), signalsKnown: false, gateHalfWidth: 10, crossing: state.settings.crossing });
    note = 'map-data server busy: only the tapped section loaded — pick a range to retry';
  }
  // Keep whatever the user already typed/chose on the card.
  if (state.pending?.tap === tap) {
    draft.crossing = $('preview-crossing').value || draft.crossing;
    const typed = $('preview-name').value.trim();
    if (typed && typed !== state.pending.draft.name) draft.name = typed;
  }
  $('block-hint').textContent = BLOCK_HINTS.road;
  showPreview(draft, { way, tap, rangeKm, note });
}

function blockSpotAt(p) {
  if (state.blockMode !== 'point') setBlockMode('point');
  cancelPreview();
  showPreview(bl.createPoint(p, { radius: activeChip('preview-radius', 'm', bl.DEFAULT_POINT_RADIUS) }));
}

async function stretchTap(p) {
  const pick = state.stretchPick || (state.stretchPick = { points: [] });
  pick.points.push(p);
  map.setStretchPoints(pick.points);
  if (pick.points.length === 1) {
    $('block-hint').textContent = 'Now tap where the blocked stretch should end.';
    $('stretch-actions').hidden = false;
    const local = map.roadFromTiles(p);
    if (local) {
      map.setHighlight(local.lines.flat());
      return;
    }
    try {
      const ways = await overpass.roadsAt(p, { radius: 18, timeoutMs: 6000 });
      if (ways[0] && ways[0].dist < 25 && state.stretchPick === pick) map.setHighlight(ways[0].points);
    } catch {
      /* highlight is optional */
    }
    return;
  }
  const [a, b] = pick.points;
  state.stretchPick = null;
  map.setHighlight(null);
  $('stretch-actions').hidden = true;
  pill('Tracing the stretch…', { spinner: true });
  try {
    // Route between the two taps on the road network: that path IS the stretch.
    const path = await fetchRoute({ endpoint: state.settings.endpoint, from: a, to: b, profile: 'shortest' });
    let name = 'Blocked stretch';
    let junctions = [];
    let signals = [];
    let signalsKnown = false;
    let note = null;
    try {
      // Junction/light data is a bonus; don't hold the preview hostage to it.
      const along = await Promise.race([overpass.waysAlong(path.points), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))]);
      junctions = along.junctions;
      signals = along.signals;
      name = describeStretch(along.ways) || name;
      signalsKnown = true;
    } catch {
      note = 'map data is busy, so junctions and lights could not be loaded';
    }
    hidePill();
    showPreview(bl.createStretch(path.points, { name, junctions, signals, signalsKnown, crossing: state.settings.crossing }), { note });
  } catch (e) {
    reportError(e, 'Could not trace that stretch');
  } finally {
    hidePill();
  }
}

/** Name a stretch after the roads that carry it (not the streets it merely crosses). */
function describeStretch(ways) {
  const carriers = ways.filter((w) => w.hits >= 2);
  const names = [...new Set(carriers.map((w) => w.name).filter(Boolean))];
  if (names.length) return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
  return carriers[0] ? overpass.describeWay(carriers[0]) : ways[0] ? overpass.describeWay(ways[0]) : null;
}

function resetStretch() {
  state.stretchPick = null;
  map.setStretchPoints([]);
  map.setHighlight(null);
  $('stretch-actions').hidden = true;
  if (state.blockMode === 'stretch') $('block-hint').textContent = 'Tap where the blocked stretch should start.';
}

const BLOCK_HINTS = {
  road: 'Tap a road to preview blocking every part of it with that name nearby.',
  stretch: 'Tap where the blocked stretch should start.',
  point: 'Tap the map to place a no-go circle.',
};

function setBlockMode(kind) {
  const entering = !!kind && !state.blockMode;
  const leaving = !kind && !!state.blockMode;
  state.blockMode = kind;
  cancelLookup();
  cancelPreview();
  resetStretch();
  $('block-toolbar').hidden = !kind;
  map.setBlockMode(!!kind);
  if (entering && state.route) $('sheet').hidden = true;
  if (leaving && state.route && state.mode === 'idle') $('sheet').hidden = false;
  $('block-mode-btn').classList.toggle('danger-active', !!kind);
  $('ctx-menu').hidden = true;
  if (kind) {
    for (const b of $('block-kind').querySelectorAll('.chip')) b.classList.toggle('active', b.dataset.kind === kind);
    $('block-hint').textContent = BLOCK_HINTS[kind];
    $('search-results').hidden = true;
  }
}

function openBlocklistView() {
  const body = renderBlocklist(state.blocklist, units(), {
    onToggle: (e, v) => {
      e.enabled = v;
      saveBlocklist();
      if (state.route && state.mode === 'idle') planRoute();
    },
    onEdit: (e) => openEntryEditor(e),
    onShow: (e) => {
      closeModal();
      closeDrawer();
      const pts = e.kind === 'point' ? [e.center] : e.lines.flat();
      map.fitPoints(pts, { top: 80, bottom: $('sheet').hidden ? 0 : $('sheet').offsetHeight });
    },
    onDelete: (e) => {
      state.blocklist = state.blocklist.filter((x) => x.id !== e.id);
      saveBlocklist();
      openBlocklistView();
    },
    onClear: () => {
      if (!confirm('Delete all blocked roads?')) return;
      state.blocklist = [];
      saveBlocklist();
      openBlocklistView();
      if (state.route && state.mode === 'idle') planRoute();
    },
    onExport: exportBlocklist,
    onImport: importBlocklist,
  });
  openModal('Blocked roads', body);
}

function openEntryEditor(entry) {
  const body = renderEntryEditor(entry, units(), {
    onSave: ({ name, radius, crossing }) => {
      entry.name = name;
      if (radius && entry.kind === 'point') entry.radius = Math.max(5, Math.min(500, radius));
      if (crossing && bl.CROSSING_RULES[crossing]) entry.crossing = crossing;
      saveBlocklist();
      openBlocklistView();
      if (state.route && state.mode === 'idle') planRoute();
    },
    onDelete: () => {
      state.blocklist = state.blocklist.filter((x) => x.id !== entry.id);
      saveBlocklist();
      openBlocklistView();
      if (state.route && state.mode === 'idle') planRoute();
    },
    onShow: () => {
      closeModal();
      closeDrawer();
      const pts = entry.kind === 'point' ? [entry.center] : entry.lines.flat();
      map.fitPoints(pts, { top: 80, bottom: $('sheet').hidden ? 0 : $('sheet').offsetHeight });
    },
  });
  openModal(entry.name, body);
}

function exportBlocklist() {
  const blob = new Blob([JSON.stringify({ app: 'bike-gps', version: 1, entries: state.blocklist }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bike-gps-blocklist-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importBlocklist() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const entries = (Array.isArray(data) ? data : data.entries || []).map(bl.normalizeEntry).filter(Boolean);
      const known = new Set(state.blocklist.map((e) => e.id));
      const fresh = entries.filter((e) => !known.has(e.id));
      state.blocklist = [...fresh, ...state.blocklist];
      saveBlocklist();
      toast(`Imported ${fresh.length} blocked ${fresh.length === 1 ? 'road' : 'roads'}.`);
      openBlocklistView();
    } catch {
      toast('That file is not a Bike GPS blocklist.');
    }
  });
  input.click();
}

// ------------------------------------------------------------------- search
let searchTimer = null;
let searchAbort = null;
state.search = { query: '', results: [], center: null, zoom: null, anchor: null, committed: false, session: null };

const RECENT_FIX_MS = 10 * 60 * 1000;
const MAX_SHOWN_RESULTS = 15; // nearest N; more just clutters the map

/** Merge geocoder and OSM hits; the same place from both sources counts once. */
function mergePlaces(primary, extra) {
  const out = [...primary];
  for (const p of extra) {
    const dup = out.some((r) => distance(r, p) < 120 && (r.label || '').toLowerCase().split(' ')[0] === (p.label || '').toLowerCase().split(' ')[0]);
    if (!dup) out.push(p);
  }
  return out;
}

/**
 * Where "near me" is: the rider's location, refreshed quietly when the last
 * fix is stale. The map centre is only used when no location is available
 * at all, so panning the map never changes what a search means.
 */
async function searchAnchor() {
  if (state.lastFix && Date.now() - state.lastFix.timestamp < RECENT_FIX_MS) return state.lastFix;
  try {
    return await currentPosition({ silent: true, maxAgeMs: RECENT_FIX_MS });
  } catch {
    return state.lastFix || map.center;
  }
}

/**
 * Show results. Live suggestions (`commit: false`) only update the list; a
 * committed search (Enter / Go / Search this area) also places pins and, when
 * asked, fits the map to them.
 */
function showResults(results, anchor, { commit = false, fit = false } = {}) {
  for (const r of results) if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) r.distance = distance(anchor, r);
  results.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  results = results.slice(0, MAX_SHOWN_RESULTS);
  state.search.results = results;
  state.search.anchor = anchor;
  state.search.committed = commit;
  renderSearchResults($('search-results'), results, pickPlace, { units: units(), numbered: commit });
  if (!commit) return;
  map.setSearchResults(results.filter((r) => Number.isFinite(r.lat)));
  const located = results.filter((r) => Number.isFinite(r.lat));
  if (fit && located.length > 1) {
    map.fitPoints(located, { top: 90 + ($('search-results').offsetHeight || 0), bottom: $('sheet').hidden ? 40 : $('sheet').offsetHeight, side: 40 });
  } else if (fit && located.length === 1) map.setView(located[0], Math.max(map.zoom, 15));
  // Record the resting camera once any fit animation ends, so "Search this
  // area" only appears after the *user* moves the map.
  state.search.settling = fit;
  state.search.center = map.center;
  state.search.zoom = map.zoom;
  $('search-here').hidden = true;
}

const mapboxToken = () => (state.settings.mapboxToken || '').trim();
function mapboxSession() {
  if (!state.search.session) state.search.session = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return state.search.session;
}

/** Mapbox path: suggest while typing (names + distance), forward on commit (coordinates). */
async function runMapboxSearch(q, anchor, { fromInput, ctrl }) {
  const token = mapboxToken();
  try {
    if (fromInput) {
      const hits = await geocode.mapboxSuggest(q, { token, session: mapboxSession(), near: anchor, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      showResults(hits, anchor, { commit: false });
      return;
    }
    const hits = await geocode.mapboxForward(q, { token, near: anchor, signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    showResults(hits, anchor, { commit: true, fit: true });
    if (!hits.length) toast('No places found near you.');
  } catch (e) {
    if (ctrl.signal.aborted) return;
    if (e instanceof geocode.MapboxAuthError) {
      toast(`${e.message} Using the free geocoder instead.`, { duration: 6000 });
      return runOsmSearch(q, anchor, { fromInput, ctrl });
    }
    throw e;
  }
}

async function runOsmSearch(q, anchor, { fromInput, ctrl }) {
  let shown = false;
  const present = (list, done) => {
    if (ctrl.signal.aborted) return;
    showResults(list, anchor, { commit: !fromInput, fit: !fromInput && !shown });
    shown = shown || list.length > 0;
    if (done && !fromInput) hidePill();
  };
  const [geo, osm] = await Promise.all([
    geocode.search(q, { near: anchor, signal: ctrl.signal, onProgress: (list) => present(list, false) }),
    overpass.placesNamed(q, anchor, { signal: ctrl.signal }),
  ]);
  if (ctrl.signal.aborted) return;
  const results = mergePlaces(geo, osm);
  present(results, true);
  if (!results.length && !fromInput) toast('No places found near you.');
}

async function runSearch(q, { fromInput = false } = {}) {
  searchAbort?.abort();
  const ctrl = (searchAbort = new AbortController());
  if (!q.trim()) {
    showRecents();
    return;
  }
  try {
    // Enter/Go on a query the live suggestions already fetched: commit those
    // results instead of asking the geocoder again (when they carry coordinates).
    if (!fromInput && state.search.query === q && state.search.results.length && !state.search.committed && state.search.results.every((r) => Number.isFinite(r.lat))) {
      showResults(state.search.results, state.search.anchor || map.center, { commit: true, fit: true });
      return;
    }
    if (!fromInput) pill('Searching near you…', { spinner: true });
    const anchor = await searchAnchor();
    if (ctrl.signal.aborted) return;
    state.search.query = q;
    if (mapboxToken()) {
      await runMapboxSearch(q, anchor, { fromInput, ctrl });
      return;
    }
    let shown = false;
    const present = (list, done) => {
      if (ctrl.signal.aborted) return;
      showResults(list, anchor, { commit: !fromInput, fit: !fromInput && !shown });
      shown = shown || list.length > 0;
      if (done && !fromInput) hidePill();
    };
    // Nominatim rings (nearest first) plus an exhaustive OSM name lookup
    // nearby; whichever answers first is shown and the other is merged in.
    const [geo, osm] = await Promise.all([
      geocode.search(q, { near: anchor, signal: ctrl.signal, onProgress: (list) => present(list, false) }),
      overpass.placesNamed(q, anchor, { signal: ctrl.signal }),
    ]);
    if (ctrl.signal.aborted) return;
    const results = mergePlaces(geo, osm);
    present(results, true);
    if (!results.length && !fromInput) toast('No places found near you.');
  } catch (e) {
    if (!fromInput) reportError(e, 'Search failed');
  } finally {
    if (!fromInput) hidePill();
  }
}

async function searchHere() {
  const q = state.search.query;
  if (!q) return;
  $('search-here').hidden = true;
  pill('Searching this area…', { spinner: true });
  try {
    const results = mapboxToken() ? await geocode.mapboxForward(q, { token: mapboxToken(), bounds: map.bounds, near: map.center }) : await geocode.searchInBounds(q, map.bounds);
    const anchor = state.lastFix && Date.now() - state.lastFix.timestamp < RECENT_FIX_MS ? state.lastFix : map.center;
    showResults(results, anchor, { commit: true, fit: false });
    if (!results.length) toast(`No "${q}" here.`);
  } catch (e) {
    reportError(e, 'Search failed');
  } finally {
    hidePill();
  }
}

function maybeOfferSearchHere() {
  const s = state.search;
  if (!s.query || !s.center || state.mode === 'navigating') return;
  if (s.settling) {
    s.settling = false;
    s.center = map.center;
    s.zoom = map.zoom;
    return;
  }
  const moved = distance(s.center, map.center);
  const viewport = distance({ lat: map.bounds.minLat, lon: map.bounds.minLon }, { lat: map.bounds.maxLat, lon: map.bounds.maxLon });
  $('search-here').hidden = !(moved > viewport * 0.25 || Math.abs(map.zoom - s.zoom) > 1.2);
}

function clearSearch() {
  state.search = { query: '', results: [], center: null, zoom: null, anchor: null, committed: false, session: null };
  map.setSearchResults([]);
  $('search-results').hidden = true;
  $('search-here').hidden = true;
}

function showRecents() {
  const recents = store.load(store.KEYS.recents, []) || [];
  renderSearchResults(
    $('search-results'),
    recents.map((r) => ({ ...r, kind: 'recent', address: '' })),
    pickPlace,
    { units: units() }
  );
}

async function pickPlace(place) {
  if (!Number.isFinite(place.lat) && place.mapboxId && mapboxToken()) {
    pill('Locating…', { spinner: true });
    try {
      const full = await geocode.mapboxRetrieve(place.mapboxId, { token: mapboxToken(), session: mapboxSession() });
      if (!full) throw new Error('Could not locate that place.');
      place = { ...place, ...full, label: place.label };
      state.search.session = null; // a session ends with a retrieve
    } catch (e) {
      reportError(e, 'Could not locate that place');
      return;
    } finally {
      hidePill();
    }
  }
  $('search-results').hidden = true;
  $('search').value = place.label;
  $('search-clear').hidden = false;
  $('search').blur();
  store.pushRecent(place);
  map.setSearchResults([]);
  $('search-here').hidden = true;
  state.search.results = [];
  setDestination({ lat: place.lat, lon: place.lon }, place.label);
}

function setDestination(p, label) {
  state.dest = p;
  state.destLabel = label || '';
  map.setDest(p);
  map.setDrop(null);
  planRoute();
  if (!label) geocode.reverse(p).then((r) => r && state.dest === p && ((state.destLabel = r.label), ($('plan-dest').textContent = r.label)));
}

// ------------------------------------------------------------- map gestures
map.onLongPress = (p, xy) => {
  if (state.mode === 'navigating') return;
  map.setDrop(p);
  state.ctxPoint = p;
  state.ctxLabel = null;
  const title = $('ctx-title');
  title.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  title.classList.remove('place');
  $('ctx-details').hidden = true;
  positionMenu($('ctx-menu'), xy.x, xy.y);
};
map.onTap = (p) => {
  $('ctx-menu').hidden = true;
  $('search-results').hidden = true;
  map.setDrop(null);
  if (!state.blockMode) return;
  if (state.blockMode === 'road') blockRoadAt(p);
  else if (state.blockMode === 'point') blockSpotAt(p);
  else if (state.blockMode === 'stretch') {
    if (state.pending) cancelPreview();
    stretchTap(p);
  }
};
map.onBlockTap = (entry) => {
  if (state.blockMode || state.mode === 'navigating') return;
  openEntryEditor(entry);
};
map.onResultTap = (r) => pickPlace(r);

const humanType = (poi) =>
  (poi.subclass || poi.class || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** A place tapped on the map: show what we know and offer to route there. */
map.onPoiTap = async (poi, xy) => {
  if (state.mode === 'navigating') return;
  const p = { lat: poi.lat, lon: poi.lon };
  state.ctxPoint = p;
  state.ctxLabel = poi.name;
  map.setDrop(p);
  const title = $('ctx-title');
  title.textContent = poi.name;
  title.classList.add('place');
  const details = $('ctx-details');
  const ref = state.lastFix || map.center;
  const lines = [el('div', { class: 'type', text: [humanType(poi), state.lastFix ? `${formatDistance(distance(ref, p), units())} away` : null].filter(Boolean).join(' · ') })];
  details.replaceChildren(...lines);
  details.hidden = false;
  positionMenu($('ctx-menu'), xy.x, xy.y);
  // Enrich quietly: address from the geocoder, hours/phone/website from OSM.
  const token = (state.ctxToken = Symbol('poi'));
  const [rev, more] = await Promise.all([geocode.reverse(p), overpass.placeDetails(poi.name, p)]);
  if (state.ctxToken !== token || $('ctx-menu').hidden) return;
  const extra = [];
  const address = more?.address || rev?.address || null;
  if (address) extra.push(el('div', { text: address }));
  if (more?.hours) extra.push(el('div', { text: `Hours: ${more.hours}` }));
  if (more?.cuisine) extra.push(el('div', { text: `Cuisine: ${more.cuisine.replace(/_/g, ' ').replace(/;/g, ', ')}` }));
  if (more?.phone) extra.push(el('div', {}, [el('a', { href: `tel:${more.phone.replace(/\s+/g, '')}`, text: more.phone })]));
  if (more?.website) extra.push(el('div', {}, [el('a', { href: more.website, target: '_blank', rel: 'noopener', text: more.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') })]));
  details.append(...extra);
  positionMenu($('ctx-menu'), xy.x, xy.y);
};
$('search-here').addEventListener('click', searchHere);
map.userInteracted = () => {
  if (state.mode === 'navigating' && map.follow) {
    map.follow = false;
    $('locate-btn').classList.remove('active');
  }
};
let viewTimer = null;
map.map.on('moveend', () => {
  updateCompass();
  maybeOfferSearchHere();
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => store.save(store.KEYS.view, { center: map.center, zoom: map.zoom }), 500);
});

$('ctx-menu').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  $('ctx-menu').hidden = true;
  const p = state.ctxPoint;
  if (act === 'dest') {
    if (state.ctxLabel) {
      store.pushRecent({ label: state.ctxLabel, lat: p.lat, lon: p.lon });
      $('search').value = state.ctxLabel;
      $('search-clear').hidden = false;
    }
    setDestination(p, state.ctxLabel || undefined);
  }
  else if (act === 'start') {
    state.start = p;
    map.setStart(p);
    map.setDrop(null);
    if (state.dest) planRoute();
    else toast('Start set. Now search for or long-press a destination.');
  } else if (act === 'block-road') {
    map.setDrop(null);
    setBlockMode('road');
    blockRoadAt(p);
  } else if (act === 'block-spot') {
    map.setDrop(null);
    setBlockMode('point');
    blockSpotAt(p);
  } else map.setDrop(null);
});

// ------------------------------------------------------------------ UI wiring
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  runSearch($('search').value);
});
$('search').addEventListener('input', (e) => {
  const q = e.target.value;
  $('search-clear').hidden = !q;
  if (q !== state.search.query) $('search-here').hidden = true;
  clearTimeout(searchTimer);
  if (q.trim().length < 3) {
    if (!q.trim()) showRecents();
    return;
  }
  searchTimer = setTimeout(() => runSearch(q, { fromInput: true }), 700);
});
$('search').addEventListener('focus', () => {
  if (!$('search').value.trim()) showRecents();
  else if (state.search.results.length && $('search').value === state.search.query) $('search-results').hidden = false;
});
$('search-clear').addEventListener('click', () => {
  $('search').value = '';
  $('search-clear').hidden = true;
  clearSearch();
  $('search').focus();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#topbar')) $('search-results').hidden = true;
});

$('menu-btn').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-version').textContent = `Bike GPS v${self.APP_VERSION || '?'}`;
$('drawer-update').addEventListener('click', () => {
  closeDrawer();
  checkForUpdates();
});
$('scrim').addEventListener('click', () => {
  closeDrawer();
});
$('drawer').addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (!view) return;
  closeDrawer();
  if (view === 'blocklist') openBlocklistView();
  else if (view === 'settings') openSettings();
  else if (view === 'about') openModal('About', renderAbout(self.APP_VERSION));
});
$('modal-back').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});

$('locate-btn').addEventListener('click', async () => {
  try {
    const fix = await currentPosition();
    if (state.mode === 'navigating') {
      map.setFollow(true, fix, { courseUp: courseUp(), heading: state.nav?.state?.bearing ?? null });
      $('locate-btn').classList.add('active');
    } else map.setView(fix, Math.max(map.zoom, 16));
  } catch (e) {
    reportError(e);
  }
});
function updateCompass() {
  const btn = $('compass-btn');
  const nav = state.mode === 'navigating';
  const bearing = map.bearing;
  btn.hidden = !nav && Math.abs(bearing) < 0.5;
  btn.style.setProperty('--bearing', `${-bearing}deg`);
  btn.classList.toggle('locked', nav && courseUp());
  btn.title = nav ? (courseUp() ? 'Switch to north-up' : 'Switch to 3D heading-up') : 'Reset to north';
}
map.onBearing = updateCompass;
$('compass-btn').addEventListener('click', () => {
  if (state.mode === 'navigating') {
    state.settings.navView = courseUp() ? 'north' : '3d';
    saveSettings();
    const fix = state.lastFix || state.route?.from;
    map.setFollow(true, fix, { courseUp: courseUp(), heading: state.nav?.state?.bearing ?? null });
    $('locate-btn').classList.add('active');
  } else map.resetNorth();
  updateCompass();
});

$('block-mode-btn').addEventListener('click', () => setBlockMode(state.blockMode ? null : 'road'));
$('block-cancel').addEventListener('click', () => setBlockMode(null));
$('block-kind').addEventListener('click', (e) => {
  const kind = e.target.closest('.chip')?.dataset.kind;
  if (kind) setBlockMode(kind);
});
$('stretch-reset').addEventListener('click', resetStretch);
$('preview-confirm').addEventListener('click', confirmPreview);
$('preview-discard').addEventListener('click', cancelPreview);
$('preview-range').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || !state.pending?.way) return;
  for (const c of $('preview-range').querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  const { way, tap } = state.pending;
  cancelLookup();
  const ctrl = (state.lookup = new AbortController());
  await previewRoad(way, tap, Number(chip.dataset.km), { signal: ctrl.signal });
  if (state.lookup === ctrl) cancelLookup();
});
$('preview-radius').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || state.pending?.draft.kind !== 'point') return;
  for (const c of $('preview-radius').querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  state.pending.draft.radius = Number(chip.dataset.m);
  map.setPreview(state.pending.draft);
  renderPreviewMeta();
});
$('preview-crossing').addEventListener('change', (e) => {
  if (state.pending?.draft && state.pending.draft.kind !== 'point') {
    state.pending.draft.crossing = e.target.value;
    renderPreviewMeta();
  }
});

$('layers-btn').addEventListener('click', () => {
  const body = el(
    'div',
    {},
    Object.entries(TILE_SOURCES).map(([id, src]) =>
      el('button', {
        class: `chip${id === state.settings.tiles ? ' active' : ''}`,
        style: 'display:block;width:100%;text-align:left;height:48px;margin-bottom:8px',
        text: src.label,
        onclick: () => {
          state.settings.tiles = id;
          saveSettings();
          map.setTiles(id);
          closeModal();
        },
      })
    )
  );
  openModal('Map style', body);
});

$('plan-close').addEventListener('click', clearRoute);

// ---- sharing
async function shareCurrentRoute() {
  const r = state.route;
  if (!r) return;
  const label = state.destLabel || 'Bike route';
  const url = shareUrl(r, { label });
  const text = `${label} — ${formatDistance(r.length, units())} by bike`;
  const body = el('div', {}, [
    el('p', { class: 'hint', text: 'The link contains this exact route. Whoever opens it sees your path (not one re-planned with their blocks) and can navigate it.' }),
    el('div', { class: 'row gap', style: 'flex-wrap:wrap' }, [
      navigator.share ? el('button', { class: 'primary', text: 'Share link…', onclick: () => navigator.share({ title: label, text, url }).then(closeModal).catch(() => {}) }) : null,
      el('button', {
        class: 'secondary',
        text: 'Copy link',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast('Link copied.');
            closeModal();
          } catch {
            prompt('Copy this link', url);
          }
        },
      }),
      el('button', { class: 'secondary', text: 'Download GPX', onclick: () => downloadText(`${label.replace(/[^\w-]+/g, '_')}.gpx`, toGpx(r, { name: label }), 'application/gpx+xml') }),
    ]),
    el('p', { class: 'hint', style: 'margin-top:12px;word-break:break-all', text: url }),
  ]);
  openModal('Share route', body);
}

function downloadText(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('share-route').addEventListener('click', shareCurrentRoute);
$('replan-own').addEventListener('click', () => {
  if (!state.dest) return;
  state.start = null;
  planRoute();
});

/** A route received via link: show it as-is, navigable, with a way to re-plan. */
function loadSharedRoute(shared) {
  state.dest = shared.to;
  state.destLabel = shared.label || 'Shared destination';
  state.start = shared.from;
  const steps = buildSteps(shared);
  setRoute(shared, steps);
  if (state.destLabel) {
    $('search').value = state.destLabel;
    $('search-clear').hidden = false;
  }
  map.fitPoints(shared.points, { top: 80, bottom: $('sheet').offsetHeight || 260 });
  enrichNames(shared, steps).catch(() => {});
  toast('Opened a shared route.', { duration: 4000 });
}
$('start-nav').addEventListener('click', () => startNavigation());
$('simulate-nav').addEventListener('click', () => startNavigation({ simulate: true }));
$('toggle-steps').addEventListener('click', () => {
  const list = $('steps-list');
  list.hidden = !list.hidden;
  $('toggle-steps').setAttribute('aria-expanded', String(!list.hidden));
});
$('nav-end').addEventListener('click', endNavigation);
$('nav-avoid').addEventListener('click', avoidRoadAhead);
$('nav-mute').addEventListener('click', () => {
  voice.enabled = !voice.enabled;
  state.settings.voice = voice.enabled;
  saveSettings();
  $('nav-mute').textContent = voice.enabled ? '🔊' : '🔇';
  $('nav-mute').setAttribute('aria-pressed', String(!voice.enabled));
  if (!voice.enabled) voice.stop();
  else voice.speak('Voice guidance on.', { priority: true });
});

function openSettings() {
  const body = renderSettings(
    state.settings,
    (key, value) => {
      state.settings[key] = value;
      saveSettings();
      if (key === 'tiles') map.setTiles(value);
      if (key === 'voice') voice.enabled = !!value;
      if (key === 'units') renderSheet();
      if (key === 'navView' && state.mode === 'navigating') {
        map.setFollow(true, state.lastFix || state.route?.from, { courseUp: courseUp(), heading: state.nav?.state?.bearing ?? null });
        updateCompass();
      }
      if (key === 'endpoint' && state.route) planRoute();
      if (key === 'mapboxToken' && value) {
        pill('Checking Mapbox token…', { spinner: true });
        geocode.mapboxCheckToken(value).then((r) => {
          hidePill();
          toast(r.ok ? 'Mapbox search is on.' : `Mapbox token problem: ${r.message}`, { duration: 6000 });
        });
      } else if (key === 'mapboxToken') toast('Mapbox search off — using the free geocoders.');
    },
    {
      version: self.APP_VERSION,
      onClearTiles: () => {
        navigator.serviceWorker?.controller?.postMessage('CLEAR_TILES');
        toast('Cached map tiles cleared.');
      },
      onCheckUpdate: checkForUpdates,
    }
  );
  openModal('Settings', body);
}

/** Last resort: drop the service worker and the app-shell cache, then reload from the network. */
async function hardRefresh() {
  pill('Reloading…', { spinner: true });
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('bikegps-shell')).map((k) => caches.delete(k)));
  } catch {
    /* reload anyway */
  }
  location.reload();
}

/**
 * Fetch the newest build and switch to it. A new service worker precaches
 * with cache:'reload', which bypasses the browser's HTTP cache; once it is
 * waiting we tell it to take over, and the controllerchange handler reloads.
 */
async function checkForUpdates() {
  if (!('serviceWorker' in navigator)) {
    location.reload();
    return;
  }
  pill('Checking for updates…', { spinner: true });
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      location.reload();
      return;
    }
    await reg.update();
    const worker = reg.installing || reg.waiting;
    if (!worker) {
      toast(`You're on the latest version (${self.APP_VERSION}).`, { action: 'Force reload', onAction: hardRefresh, duration: 8000 });
      return;
    }
    const activate = () => worker.postMessage('SKIP_WAITING');
    if (worker.state === 'installed') activate();
    else {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') activate();
      });
    }
    toast('Updating…', { duration: 8000 });
  } catch (e) {
    reportError(e, 'Update check failed');
  } finally {
    hidePill();
  }
}

// --------------------------------------------------------------- PWA plumbing
const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const INSTALL_HINT_KEY = 'bikegps.installHint.v1';

function showInstallHelp() {
  openModal('Install Bike GPS', renderInstallHelp({ ios: isIOS, safari: isSafari }));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  $('install-btn').hidden = false;
});
$('install-btn').addEventListener('click', async () => {
  closeDrawer();
  const p = state.installPrompt;
  if (!p) {
    showInstallHelp();
    return;
  }
  state.installPrompt = null;
  $('install-btn').hidden = true;
  await p.prompt();
});
$('install-dismiss').addEventListener('click', () => {
  $('install-banner').hidden = true;
  store.save(INSTALL_HINT_KEY, { dismissedAt: Date.now() });
});
$('install-banner').addEventListener('click', (e) => {
  if (e.target.closest('#install-dismiss')) return;
  $('install-banner').hidden = true;
  store.save(INSTALL_HINT_KEY, { dismissedAt: Date.now() });
  showInstallHelp();
});

/** iOS has no install prompt: nudge once, then again after a month if still not installed. */
function maybeOfferIosInstall() {
  if (!isIOS || isStandalone()) return;
  $('install-btn').hidden = false; // always reachable from the menu
  const hint = store.load(INSTALL_HINT_KEY);
  if (hint?.dismissedAt && Date.now() - hint.dismissedAt < 30 * 24 * 3600 * 1000) return;
  setTimeout(() => {
    if (state.mode === 'idle' && $('sheet').hidden && !isStandalone()) $('install-banner').hidden = false;
  }, 4000);
}
window.addEventListener('appinstalled', () => toast('Installed! Find Bike GPS on your home screen.'));

function updateOnline() {
  if (navigator.onLine) {
    if ($('status-pill').dataset.offline) {
      hidePill();
      delete $('status-pill').dataset.offline;
    }
  } else {
    pill('Offline — cached map only, routing unavailable');
    $('status-pill').dataset.offline = '1';
  }
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      if (!reg) return;
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update available', { action: 'Reload', onAction: () => worker.postMessage('SKIP_WAITING'), duration: 0 });
          }
        });
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  });
}

// ---------------------------------------------------------------------- boot
function boot() {
  trackSheetHeight($('sheet'), $('nav-bottom'), $('install-banner')); // controls float above whichever is showing
  $('blocklist-count').textContent = String(state.blocklist.length);
  map.renderBlocklist(state.blocklist);
  updateOnline();

  const shared = parseSharedRoute(location.hash);
  if (shared) history.replaceState(null, '', location.pathname + location.search);
  const last = store.load(store.KEYS.lastRoute);
  if (shared) loadSharedRoute(shared);
  else if (last?.route?.points && Date.now() - (last.route.createdAt || 0) < 24 * 3600 * 1000) {
    state.dest = last.dest;
    state.destLabel = last.destLabel || '';
    state.start = last.start || null;
    if (state.destLabel) {
      $('search').value = state.destLabel;
      $('search-clear').hidden = false;
    }
    setRoute(last.route, last.steps || []);
    map.fitPoints(last.route.points, { top: 80, bottom: 240 });
  } else if (!savedView) {
    // First launch: centre on the user if they allow it, quietly.
    currentPosition({ silent: true })
      .then((fix) => map.setView(fix, 15))
      .catch(() => {});
  }
  // Keep the "me" dot fresh while planning, without hammering the GPS.
  if (navigator.geolocation && navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') currentPosition({ silent: true }).catch(() => {});
    }).catch(() => {});
  }
  // Keep the map canvas matched to the viewport: iOS Home Screen apps can
  // shift or shrink the page around the keyboard without a resize event.
  const settle = () => {
    window.scrollTo(0, 0);
    map.invalidate();
  };
  window.addEventListener('resize', settle);
  window.addEventListener('orientationchange', () => setTimeout(settle, 300));
  window.visualViewport?.addEventListener('resize', settle);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && setTimeout(settle, 50));
  $('search').addEventListener('blur', () => setTimeout(settle, 60));
  new ResizeObserver(() => map.invalidate()).observe($('map'));
  maybeOfferIosInstall();
}
boot();

// Exposed for debugging in the console.
window.bikeGps = { state, map, planRoute, reroute };

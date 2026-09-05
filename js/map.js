// MapLibre GL wrapper: one place that knows about [lng, lat] arrays, sources,
// layers, markers, camera and gestures. Everything else talks in {lat, lon}.
//
// Navigation uses a course-up camera: the map rotates with the rider's
// heading and tilts for a perspective view, with the position marker in the
// lower third of the screen so the road ahead fills the view.

/* global maplibregl */

import { cumulativeDistances, destination, distance, snapToPath } from './geo.js';

const OFM = 'https://tiles.openfreemap.org/styles';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const raster = (label, tiles, attribution, maxzoom = 19) => ({
  label,
  kind: 'raster',
  style: {
    version: 8,
    sources: { base: { type: 'raster', tiles, tileSize: 256, maxzoom, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  },
});

export const TILE_SOURCES = {
  liberty: { label: 'OpenFreeMap Liberty (3D)', kind: 'vector', style: `${OFM}/liberty` },
  bright: { label: 'OpenFreeMap Bright (3D)', kind: 'vector', style: `${OFM}/bright` },
  positron: { label: 'OpenFreeMap Positron (light, 3D)', kind: 'vector', style: `${OFM}/positron` },
  osm: raster('OpenStreetMap', ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], OSM_ATTR),
  cyclosm: raster(
    'CyclOSM (bike infrastructure)',
    ['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    `<a href="https://www.cyclosm.org">CyclOSM</a> | ${OSM_ATTR}`,
    20
  ),
  voyager: raster(
    'Carto Voyager',
    ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`),
    `${OSM_ATTR} &copy; <a href="https://carto.com/">CARTO</a>`,
    20
  ),
  dark: raster(
    'Carto Dark',
    ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png`),
    `${OSM_ATTR} &copy; <a href="https://carto.com/">CARTO</a>`,
    20
  ),
};
export const DEFAULT_TILES = 'liberty';

const NAV_PITCH = 58;
const NAV_ZOOM = 17.3;

const lnglat = (p) => [p.lon, p.lat];
const lineFeature = (pts, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map(lnglat) } });
const fc = (features) => ({ type: 'FeatureCollection', features });
const EMPTY = fc([]);

/** Metre-accurate circle as a polygon (MapLibre circle layers are pixel-sized). */
function circlePolygon(center, radius, n = 48) {
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(lnglat(destination(center, (360 * i) / n, radius)));
  return { type: 'Polygon', coordinates: [ring] };
}

export class MapView {
  constructor(el, { center = { lat: 39.9612, lon: -82.9988 }, zoom = 13, tiles = DEFAULT_TILES } = {}) {
    this.el = el;
    this.map = new maplibregl.Map({
      container: el,
      style: (TILE_SOURCES[tiles] || TILE_SOURCES[DEFAULT_TILES]).style,
      center: lnglat(center),
      zoom,
      attributionControl: false,
      maxPitch: 70,
      pitchWithRotate: true,
      dragRotate: true,
      touchPitch: true,
      fadeDuration: 150,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.tilesId = tiles;
    this.data = { route: [], done: [], ahead: [], blocks: EMPTY, highlight: [], preview: EMPTY, accuracy: EMPTY, grades: EMPTY };
    this.markers = {};
    this.follow = false;
    this.courseUp = true;
    this.navZoom = NAV_ZOOM;
    this.navPadding = { top: 0, bottom: 0 };
    this.userInteracted = () => {};
    this.onLongPress = () => {};
    this.onTap = () => {};
    this.onBlockTap = () => {};
    this.onResultTap = () => {};
    this.onPoiTap = () => {};
    this.onBearing = () => {};
    this.suppressClickUntil = 0;
    this.blockMode = false;

    this.map.on('style.load', () => this.addOverlays());
    this.map.on('click', (e) => this.handleClick(e));
    this.map.on('contextmenu', (e) => {
      if (this.touchActive) return;
      e.preventDefault();
      this.suppressClickUntil = Date.now() + 600;
      this.onLongPress({ lat: e.lngLat.lat, lon: e.lngLat.lng }, { x: e.point.x, y: e.point.y });
    });
    for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
      this.map.on(ev, (e) => {
        if (e.originalEvent) this.userInteracted();
      });
    }
    this.map.on('rotate', () => this.onBearing(this.map.getBearing()));
    this.map.on('mousemove', (e) => {
      if (this.blockMode) return;
      const hit = this.blockFeatureAt(e.point);
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
    this.installLongPress(el);
  }

  // ------------------------------------------------------------- overlays
  addOverlays() {
    const m = this.map;
    const src = (id, data) => (m.getSource(id) ? m.getSource(id).setData(data) : m.addSource(id, { type: 'geojson', data }));
    src('route-casing', fc(this.data.route.length ? [lineFeature(this.data.route)] : []));
    src('route-done', fc(this.data.done.length ? [lineFeature(this.data.done)] : []));
    src('route-ahead', fc(this.data.ahead.length ? [lineFeature(this.data.ahead)] : []));
    src('blocks', this.data.blocks);
    src('highlight', fc(this.data.highlight.length ? [lineFeature(this.data.highlight)] : []));
    src('preview', this.data.preview || EMPTY);
    src('me-accuracy', this.data.accuracy || EMPTY);
    src('route-grades', this.data.grades || EMPTY);

    // Draw under labels but above roads/buildings.
    const before = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const line = (id, source, paint, layout = {}) => {
      if (m.getLayer(id)) return;
      m.addLayer({ id, type: 'line', source, paint, layout: { 'line-cap': 'round', 'line-join': 'round', ...layout } }, before);
    };
    line('route-casing', 'route-casing', { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 13], 'line-opacity': 0.9 });
    line('route-done', 'route-done', { 'line-color': '#94a3b8', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8] });
    line('route-ahead', 'route-ahead', { 'line-color': '#1d4ed8', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8] });
    // Planned route coloured by bike-friendliness grade (hidden while navigating).
    line('route-grades', 'route-grades', {
      'line-color': ['match', ['get', 'grade'], 'A', '#16a34a', 'B', '#84cc16', 'C', '#f59e0b', 'D', '#ea580c', 'E', '#dc2626', '#1d4ed8'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8],
    });
    line('highlight', 'highlight', { 'line-color': '#f59e0b', 'line-width': 9, 'line-opacity': 0.85 });
    if (!m.getLayer('me-accuracy')) {
      m.addLayer({ id: 'me-accuracy', type: 'fill', source: 'me-accuracy', paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.12 } }, before);
      m.addLayer({ id: 'me-accuracy-line', type: 'line', source: 'me-accuracy', paint: { 'line-color': '#1d4ed8', 'line-opacity': 0.35, 'line-width': 1 } }, before);
    }
    // Pending block, shown before the user confirms it.
    if (!m.getLayer('preview-fill')) {
      m.addLayer({ id: 'preview-fill', type: 'fill', source: 'preview', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.3 } }, before);
    }
    line('preview-line', 'preview', { 'line-color': '#f59e0b', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 12], 'line-opacity': 0.9 });
    m.setFilter('preview-line', ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']]);
    if (!m.getLayer('blocks-fill')) {
      m.addLayer(
        {
          id: 'blocks-fill',
          type: 'fill',
          source: 'blocks',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': '#dc2626', 'fill-opacity': ['case', ['get', 'enabled'], 0.22, 0.08] },
        },
        before
      );
    }
    if (!m.getLayer('blocks-outline')) {
      m.addLayer(
        {
          id: 'blocks-outline',
          type: 'line',
          source: 'blocks',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-opacity': ['case', ['get', 'enabled'], 0.9, 0.35] },
        },
        before
      );
    }
    line(
      'blocks-line',
      'blocks',
      {
        'line-color': '#dc2626',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 9],
        'line-opacity': ['case', ['get', 'enabled'], 0.9, 0.35],
        'line-dasharray': [0.2, 1.4],
      },
      {}
    );
    m.setFilter('blocks-line', ['==', ['geometry-type'], 'LineString']);
  }

  setTiles(id) {
    const src = TILE_SOURCES[id] || TILE_SOURCES[DEFAULT_TILES];
    this.tilesId = id;
    this.map.setStyle(src.style, { diff: false });
  }

  get center() {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  get zoom() {
    return this.map.getZoom();
  }

  get bearing() {
    return this.map.getBearing();
  }

  setView(p, zoom) {
    this.map.easeTo({ center: lnglat(p), zoom: zoom ?? this.map.getZoom(), duration: 600 });
  }

  /** North-up, flat, fit the given points with room for the top bar and sheet. */
  fitPoints(points, { top = 90, bottom = 0, side = 30 } = {}) {
    if (!points?.length) return;
    const b = points.reduce((acc, p) => acc.extend(lnglat(p)), new maplibregl.LngLatBounds(lnglat(points[0]), lnglat(points[0])));
    this.map.fitBounds(b, { padding: { top, bottom: bottom + 20, left: side, right: side }, maxZoom: 17, bearing: 0, pitch: 0, duration: 700 });
  }

  resetNorth() {
    this.map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  }

  // -------------------------------------------------------------- markers
  marker(key, p, html, opts = {}) {
    if (!p) {
      this.markers[key]?.remove();
      delete this.markers[key];
      return null;
    }
    let mk = this.markers[key];
    if (!mk) {
      const el = document.createElement('div');
      el.innerHTML = html;
      mk = new maplibregl.Marker({ element: el.firstElementChild, anchor: opts.anchor || 'bottom', ...opts }).setLngLat(lnglat(p)).addTo(this.map);
      this.markers[key] = mk;
    } else mk.setLngLat(lnglat(p));
    return mk;
  }

  setStart(p) {
    this.marker('start', p, '<div class="pin start"></div>');
  }

  setDest(p) {
    this.marker('dest', p, '<div class="pin dest"></div>');
  }

  setDrop(p) {
    this.marker('drop', p, '<div class="pin drop"></div>');
  }

  setMe(p, { heading = null, accuracy = null, stale = false } = {}) {
    if (!p) {
      this.marker('me', null);
      this.setSource('me-accuracy', EMPTY);
      return;
    }
    const mk = this.marker('me', p, '<div class="me-marker"><div class="cone" hidden></div><div class="dot"></div></div>', {
      anchor: 'center',
      rotationAlignment: 'map',
      pitchAlignment: 'viewport',
    });
    // GPS uncertainty ring (only when it's big enough to matter on screen).
    this.data.accuracy = Number.isFinite(accuracy) && accuracy > 12 ? fc([{ type: 'Feature', properties: {}, geometry: circlePolygon(p, Math.min(accuracy, 500)) }]) : EMPTY;
    this.setSource('me-accuracy', this.data.accuracy);
    const root = mk.getElement();
    root.classList.toggle('stale', stale);
    const cone = root.querySelector('.cone');
    if (Number.isFinite(heading)) {
      cone.hidden = false;
      mk.setRotation(heading);
    } else cone.hidden = true;
    if (this.follow) {
      // Carry the whole navigation camera each time: a fresh easeTo cancels the
      // one in flight, so a centre-only ease would freeze zoom/pitch mid-way.
      const cam = { center: lnglat(p), duration: 600, easing: (t) => t, ...this.navCamera() };
      if (Number.isFinite(heading) && this.courseUp) cam.bearing = heading;
      this.map.easeTo(cam);
    }
  }

  navCamera() {
    const h = this.el.clientHeight;
    if (this.courseUp) {
      return { zoom: this.navZoom, pitch: NAV_PITCH, padding: { top: Math.round(h * 0.45), bottom: this.navPadding.bottom, left: 0, right: 0 } };
    }
    return { zoom: this.navZoom, pitch: 0, bearing: 0, padding: { top: this.navPadding.top, bottom: this.navPadding.bottom, left: 0, right: 0 } };
  }

  /**
   * Follow the rider. `courseUp` rotates and tilts the map with the heading
   * (3D perspective); otherwise the camera stays north-up and flat.
   */
  setFollow(on, p, { courseUp = true, heading = null, zoom = NAV_ZOOM } = {}) {
    this.follow = on;
    this.courseUp = courseUp;
    if (!on) {
      this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      return;
    }
    this.navZoom = zoom;
    if (!p) return;
    this.map.easeTo({ center: lnglat(p), bearing: courseUp && Number.isFinite(heading) ? heading : 0, ...this.navCamera(), duration: 900 });
  }

  /** Space taken by HUD panels so the camera keeps the rider visible. */
  setNavPadding({ top = 0, bottom = 0 }) {
    this.navPadding = { top, bottom };
  }

  // ----------------------------------------------------------------- route
  setSource(id, data) {
    const s = this.map.getSource(id);
    if (s) s.setData(data);
  }

  setRoute(points) {
    this.data.route = points || [];
    this.data.ahead = points || [];
    this.data.done = [];
    this.setSource('route-casing', fc(points?.length ? [lineFeature(points)] : []));
    this.setSource('route-ahead', fc(points?.length ? [lineFeature(points)] : []));
    this.setSource('route-done', EMPTY);
    if (!points?.length) this.setRouteGrades(null);
  }

  /** Colour the planned route by grade runs [{grade, points}]; null clears. */
  setRouteGrades(runs) {
    this.data.grades = fc((runs || []).map((r) => lineFeature(r.points, { grade: r.grade })));
    this.setSource('route-grades', this.data.grades);
  }

  /** Split the route at the snapped position: grey behind, blue ahead. */
  setProgress(points, snap) {
    if (!snap) return;
    const done = [...points.slice(0, snap.index + 1), snap.point];
    const ahead = [snap.point, ...points.slice(snap.index + 1)];
    this.data.done = done;
    this.data.ahead = ahead;
    this.setSource('route-done', fc([lineFeature(done)]));
    this.setSource('route-ahead', fc([lineFeature(ahead)]));
  }

  setHighlight(points) {
    this.data.highlight = points || [];
    this.setSource('highlight', fc(points?.length ? [lineFeature(points)] : []));
  }

  /** Show a draft blocklist entry in orange (null clears). */
  setPreview(entry) {
    let features = [];
    if (entry?.kind === 'point') features = [{ type: 'Feature', properties: {}, geometry: circlePolygon(entry.center, entry.radius) }];
    else if (entry?.lines) features = entry.lines.map((l) => lineFeature(l));
    this.data.preview = fc(features);
    this.setSource('preview', this.data.preview);
  }

  setStretchPoints(points) {
    for (const k of Object.keys(this.markers)) if (k.startsWith('stretch')) this.marker(k, null);
    (points || []).forEach((p, i) => this.marker(`stretch${i}`, p, '<div class="pin stretch"></div>'));
  }

  /** Numbered pins for search results; tapping one calls onResultTap(result). */
  setSearchResults(results) {
    for (const k of Object.keys(this.markers)) if (k.startsWith('result')) this.marker(k, null);
    (results || []).forEach((r, i) => {
      const mk = this.marker(`result${i}`, r, `<button class="result-pin" type="button" aria-label="${(r.label || '').replace(/"/g, '&quot;')}"><span>${i + 1}</span></button>`);
      const el = mk?.getElement();
      if (el && !el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onResultTap(r);
        });
      }
    });
  }

  get bounds() {
    const b = this.map.getBounds();
    return { minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast() };
  }

  /** Draw blocklist entries. Tapping one calls onBlockTap(entry). */
  renderBlocklist(entries) {
    const features = [];
    for (const e of entries) {
      const props = { id: e.id, name: e.name, enabled: !!e.enabled };
      if (e.kind === 'point') features.push({ type: 'Feature', properties: props, geometry: circlePolygon(e.center, e.radius) });
      else for (const line of e.lines) features.push(lineFeature(line, props));
    }
    this.entries = entries;
    this.data.blocks = fc(features);
    this.setSource('blocks', this.data.blocks);
  }

  blockFeatureAt(point) {
    const layers = ['blocks-line', 'blocks-fill'].filter((l) => this.map.getLayer(l));
    if (!layers.length) return null;
    const box = [
      [point.x - 8, point.y - 8],
      [point.x + 8, point.y + 8],
    ];
    const f = this.map.queryRenderedFeatures(box, { layers })[0];
    return f ? this.entries?.find((e) => e.id === f.properties.id) || null : null;
  }

  // ------------------------------------------------------ places from tiles
  /** Named point of interest under a screen point (from the tiles), or null. */
  poiAt(point, { radius = 14 } = {}) {
    const m = this.map;
    const layers = (m.getStyle()?.layers || []).filter((l) => l['source-layer'] === 'poi' && m.getLayer(l.id)).map((l) => l.id);
    if (!layers.length) return null;
    const box = [
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y + radius],
    ];
    let feats = [];
    try {
      feats = m.queryRenderedFeatures(box, { layers });
    } catch {
      return null;
    }
    const f = feats.find((x) => x.properties?.name && x.geometry?.type === 'Point');
    if (!f) return null;
    const [lon, lat] = f.geometry.coordinates;
    return { name: f.properties.name, class: f.properties.class || null, subclass: f.properties.subclass || null, lat, lon };
  }

  // ---------------------------------------------------- roads from the tiles
  /**
   * Identify the road under a point from the vector tiles already loaded —
   * instant and offline. Returns { name, class, lines, junctions, source:'tiles' }
   * or null (raster style, nothing loaded, or no road within `radius`).
   * Geometry is tile-simplified, so callers should treat it as approximate.
   */
  roadFromTiles(p, { radius = 25 } = {}) {
    const m = this.map;
    if (!m.getSource('openmaptiles')) return null;
    let named;
    try {
      named = m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' });
    } catch {
      return null;
    }
    const toLines = (f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : []).map((l) => l.map(([lon, lat]) => ({ lat, lon })));
    let best = null;
    for (const f of named) {
      if (!f.properties?.name) continue;
      for (const line of toLines(f)) {
        if (line.length < 2) continue;
        const d = snapToPath(p, line, cumulativeDistances(line), 0, line.length).dist;
        if (d <= radius && (!best || d < best.d)) best = { d, f };
      }
    }
    if (!best) return null;
    const name = best.f.properties.name;
    // All fragments of that road in the loaded tiles, minus duplicate segments from tile buffers.
    const seen = new Set();
    const key = (a, b) => `${a.lat.toFixed(6)},${a.lon.toFixed(6)}|${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
    const lines = [];
    for (const f of named) {
      if (f.properties?.name !== name) continue;
      for (const line of toLines(f)) {
        let cur = [];
        for (let i = 0; i < line.length - 1; i++) {
          const k = key(line[i], line[i + 1]);
          const kr = key(line[i + 1], line[i]);
          if (seen.has(k) || seen.has(kr)) {
            if (cur.length >= 2) lines.push(cur);
            cur = [];
            continue;
          }
          seen.add(k);
          if (!cur.length) cur.push(line[i]);
          cur.push(line[i + 1]);
        }
        if (cur.length >= 2) lines.push(cur);
      }
    }
    // Junctions: vertices of this road that coincide with a vertex of another road geometry.
    const ours = new Map();
    for (const l of lines) for (const v of l) ours.set(`${v.lat.toFixed(6)},${v.lon.toFixed(6)}`, v);
    const junctions = [];
    try {
      const roads = m.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' });
      const hit = new Set();
      for (const f of roads) {
        for (const line of toLines(f)) {
          const onOurs = line.filter((v) => ours.has(`${v.lat.toFixed(6)},${v.lon.toFixed(6)}`));
          // A geometry that mostly runs along our road is the road itself, not a cross street.
          if (onOurs.length >= 2 && onOurs.length / line.length > 0.5) continue;
          for (const v of onOurs) hit.add(`${v.lat.toFixed(6)},${v.lon.toFixed(6)}`);
        }
      }
      for (const k of hit) junctions.push(ours.get(k));
    } catch {
      /* junctions optional */
    }
    return { name, class: best.f.properties.class || null, lines, junctions, source: 'tiles', distance: best.d };
  }

  // -------------------------------------------------------------- gestures
  handleClick(e) {
    if (Date.now() < this.suppressClickUntil) return;
    const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    if (!this.blockMode) {
      const entry = this.blockFeatureAt(e.point);
      if (entry) {
        this.onBlockTap(entry);
        return;
      }
      const poi = this.poiAt(e.point);
      if (poi) {
        this.onPoiTap(poi, { x: e.point.x, y: e.point.y });
        return;
      }
    }
    this.onTap(p);
  }

  setBlockMode(on) {
    this.blockMode = on;
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  installLongPress(el) {
    let timer = null;
    let startXY = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      startXY = null;
    };
    el.addEventListener(
      'touchstart',
      (ev) => {
        this.touchActive = true;
        if (ev.touches.length !== 1) return cancel();
        const t = ev.touches[0];
        startXY = { x: t.clientX, y: t.clientY };
        timer = setTimeout(() => {
          timer = null;
          const rect = el.getBoundingClientRect();
          const pt = { x: startXY.x - rect.left, y: startXY.y - rect.top };
          const ll = this.map.unproject([pt.x, pt.y]);
          this.suppressClickUntil = Date.now() + 1200;
          this.onLongPress({ lat: ll.lat, lon: ll.lng }, pt);
          if (navigator.vibrate) navigator.vibrate(15);
        }, 550);
      },
      { passive: true }
    );
    el.addEventListener(
      'touchmove',
      (ev) => {
        if (!startXY || !timer) return;
        const t = ev.touches[0];
        if (Math.hypot(t.clientX - startXY.x, t.clientY - startXY.y) > 10) cancel();
      },
      { passive: true }
    );
    el.addEventListener(
      'touchend',
      () => {
        cancel();
        setTimeout(() => (this.touchActive = false), 400);
      },
      { passive: true }
    );
    el.addEventListener('touchcancel', cancel, { passive: true });
  }

  invalidate() {
    this.map.resize();
  }
}

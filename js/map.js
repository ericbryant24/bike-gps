// MapLibre GL wrapper: one place that knows about [lng, lat] arrays, sources,
// layers, markers, camera and gestures. Everything else talks in {lat, lon}.
//
// Navigation uses a course-up camera: the map rotates with the rider's
// heading and tilts for a perspective view, with the position marker in the
// lower third of the screen so the road ahead fills the view.

/* global maplibregl */

import { destination } from './geo.js';

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
    this.data = { route: [], done: [], ahead: [], blocks: EMPTY, highlight: [] };
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

    // Draw under labels but above roads/buildings.
    const before = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const line = (id, source, paint, layout = {}) => {
      if (m.getLayer(id)) return;
      m.addLayer({ id, type: 'line', source, paint, layout: { 'line-cap': 'round', 'line-join': 'round', ...layout } }, before);
    };
    line('route-casing', 'route-casing', { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 13], 'line-opacity': 0.9 });
    line('route-done', 'route-done', { 'line-color': '#94a3b8', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8] });
    line('route-ahead', 'route-ahead', { 'line-color': '#1d4ed8', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8] });
    line('highlight', 'highlight', { 'line-color': '#f59e0b', 'line-width': 9, 'line-opacity': 0.85 });
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
      return;
    }
    const mk = this.marker('me', p, '<div class="me-marker"><div class="cone" hidden></div><div class="dot"></div></div>', {
      anchor: 'center',
      rotationAlignment: 'map',
      pitchAlignment: 'viewport',
    });
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

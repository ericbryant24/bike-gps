// Leaflet wrapper: one place that knows about [lat, lng] arrays, layers,
// markers and gestures. Everything else talks in {lat, lon}.

/* global L */

export const TILE_SOURCES = {
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  cyclosm: {
    label: 'CyclOSM (bike infrastructure)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    maxZoom: 20,
    subdomains: 'abc',
    attribution:
      '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  voyager: {
    label: 'Carto Voyager (clean)',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
  },
  dark: {
    label: 'Carto Dark',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
  },
};

const ll = (p) => [p.lat, p.lon];
const lls = (pts) => pts.map(ll);

export class MapView {
  constructor(el, { center = { lat: 39.9612, lon: -82.9988 }, zoom = 13, tiles = 'osm' } = {}) {
    this.map = L.map(el, {
      center: ll(center),
      zoom,
      zoomControl: false,
      attributionControl: true,
      tapHold: false,
      worldCopyJump: true,
    });
    this.map.attributionControl.setPrefix(false);
    this.tileLayer = null;
    this.setTiles(tiles);

    this.routeCasing = L.polyline([], { color: 'var(--route-casing)', weight: 10, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(this.map);
    this.routeDone = L.polyline([], { color: '#94a3b8', weight: 6, opacity: 0.8, lineCap: 'round', lineJoin: 'round' }).addTo(this.map);
    this.routeLine = L.polyline([], { color: 'var(--route)', weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(this.map);
    this.blockLayer = L.layerGroup().addTo(this.map);
    this.highlight = L.polyline([], { color: '#f59e0b', weight: 9, opacity: 0.85, lineCap: 'round' }).addTo(this.map);
    this.stretchLayer = L.layerGroup().addTo(this.map);

    this.meMarker = null;
    this.startMarker = null;
    this.destMarker = null;
    this.dropMarker = null;
    this.accuracyCircle = null;
    this.follow = false;
    this.userInteracted = () => {};
    this.onLongPress = () => {};
    this.onTap = () => {};
    this.onBlockTap = () => {};

    this.map.on('dragstart zoomstart', (e) => {
      // Zooms we trigger ourselves carry no originalEvent.
      if (e.type === 'dragstart' || e.originalEvent) this.userInteracted();
    });
    this.suppressClickUntil = 0;
    this.map.on('click', (e) => {
      // Some browsers fire a click after a long-press; don't let it close the menu we just opened.
      if (Date.now() < this.suppressClickUntil) return;
      this.onTap({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
    this.installLongPress(el);
    this.map.on('contextmenu', (e) => {
      // Desktop right-click; on touch devices we rely on our own timer so
      // behaviour is identical across browsers.
      if (e.originalEvent && e.originalEvent.pointerType !== 'touch' && !this.touchActive) {
        e.originalEvent.preventDefault();
        this.suppressClickUntil = Date.now() + 600;
        this.onLongPress({ lat: e.latlng.lat, lon: e.latlng.lng }, { x: e.containerPoint.x, y: e.containerPoint.y });
      }
    });
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
          const pt = L.point(startXY.x - rect.left, startXY.y - rect.top);
          const latlng = this.map.containerPointToLatLng(pt);
          this.suppressClickUntil = Date.now() + 1200;
          this.onLongPress({ lat: latlng.lat, lon: latlng.lng }, { x: pt.x, y: pt.y });
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
    el.addEventListener('touchend', () => { cancel(); setTimeout(() => (this.touchActive = false), 400); }, { passive: true });
    el.addEventListener('touchcancel', cancel, { passive: true });
  }

  setTiles(id) {
    const src = TILE_SOURCES[id] || TILE_SOURCES.osm;
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = L.tileLayer(src.url, {
      maxZoom: src.maxZoom,
      subdomains: src.subdomains || 'abc',
      attribution: src.attribution,
      crossOrigin: 'anonymous', // CORS mode → cacheable, non-opaque responses for the service worker
      detectRetina: false,
    }).addTo(this.map);
    this.tileLayer.bringToBack();
    this.tilesId = id;
  }

  get center() {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  get zoom() {
    return this.map.getZoom();
  }

  setView(p, zoom) {
    this.map.setView(ll(p), zoom ?? this.map.getZoom());
  }

  /** Fit bounds with room for the top bar and bottom sheet. */
  fitPoints(points, { top = 90, bottom = 0, side = 30 } = {}) {
    if (!points?.length) return;
    const b = L.latLngBounds(lls(points));
    this.map.fitBounds(b, { paddingTopLeft: [side, top], paddingBottomRight: [side, bottom + 20], maxZoom: 17, animate: true });
  }

  pinIcon(cls) {
    return L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [28, 40], iconAnchor: [14, 38] });
  }

  setStart(p) {
    this.startMarker = this.upsertMarker(this.startMarker, p, 'start');
  }

  setDest(p) {
    this.destMarker = this.upsertMarker(this.destMarker, p, 'dest');
  }

  setDrop(p) {
    this.dropMarker = this.upsertMarker(this.dropMarker, p, 'drop');
  }

  upsertMarker(existing, p, cls) {
    if (!p) {
      if (existing) this.map.removeLayer(existing);
      return null;
    }
    if (existing) {
      existing.setLatLng(ll(p));
      return existing;
    }
    return L.marker(ll(p), { icon: this.pinIcon(cls), interactive: false, zIndexOffset: cls === 'dest' ? 500 : 400 }).addTo(this.map);
  }

  setRoute(points) {
    const arr = points ? lls(points) : [];
    this.routeCasing.setLatLngs(arr);
    this.routeLine.setLatLngs(arr);
    this.routeDone.setLatLngs([]);
  }

  /** Split the route at the snapped position: grey behind, blue ahead. */
  setProgress(points, snap) {
    if (!snap) return;
    const done = points.slice(0, snap.index + 1).map(ll);
    done.push(ll(snap.point));
    const ahead = [ll(snap.point), ...points.slice(snap.index + 1).map(ll)];
    this.routeDone.setLatLngs(done);
    this.routeLine.setLatLngs(ahead);
  }

  setMe(p, { heading = null, accuracy = null, stale = false } = {}) {
    if (!p) {
      if (this.meMarker) this.map.removeLayer(this.meMarker);
      if (this.accuracyCircle) this.map.removeLayer(this.accuracyCircle);
      this.meMarker = this.accuracyCircle = null;
      return;
    }
    if (!this.meMarker) {
      const icon = L.divIcon({
        className: '',
        html: '<div class="me-marker"><div class="cone" hidden></div><div class="dot"></div></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      this.meMarker = L.marker(ll(p), { icon, interactive: false, zIndexOffset: 1000 }).addTo(this.map);
      this.accuracyCircle = L.circle(ll(p), { radius: accuracy || 0, color: '#1d4ed8', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(ll(p));
      this.accuracyCircle.setLatLng(ll(p));
    }
    if (Number.isFinite(accuracy)) this.accuracyCircle.setRadius(Math.min(accuracy, 200));
    const root = this.meMarker.getElement()?.firstElementChild;
    if (root) {
      root.classList.toggle('stale', stale);
      const cone = root.querySelector('.cone');
      if (Number.isFinite(heading)) {
        cone.hidden = false;
        cone.style.transform = `rotate(${heading}deg)`;
      } else cone.hidden = true;
    }
    if (this.follow) this.map.panTo(ll(p), { animate: true, duration: 0.5, easeLinearity: 0.5 });
  }

  setFollow(on, p, zoom) {
    this.follow = on;
    if (on && p) this.map.setView(ll(p), zoom ?? Math.max(this.map.getZoom(), 16), { animate: true });
  }

  setHighlight(points) {
    this.highlight.setLatLngs(points ? lls(points) : []);
  }

  setStretchPoints(points) {
    this.stretchLayer.clearLayers();
    for (const p of points || []) {
      L.marker(ll(p), { icon: this.pinIcon('stretch'), interactive: false }).addTo(this.stretchLayer);
    }
  }

  /** Draw blocklist entries. `onTap(entry)` opens its editor. */
  renderBlocklist(entries) {
    this.blockLayer.clearLayers();
    for (const e of entries) {
      const style = {
        color: 'var(--blocked)',
        weight: e.kind === 'point' ? 2 : 7,
        opacity: e.enabled ? 0.9 : 0.35,
        fillOpacity: e.enabled ? 0.2 : 0.08,
        dashArray: e.kind === 'point' ? null : '2 10',
        lineCap: 'round',
      };
      let layer;
      if (e.kind === 'point') {
        layer = L.circle(ll(e.center), { radius: e.radius, ...style });
      } else {
        layer = L.featureGroup(e.lines.map((line) => L.polyline(lls(line), style)));
      }
      layer.bindTooltip(`⛔ ${e.name}${e.enabled ? '' : ' (off)'}`, { className: 'block-tip', direction: 'top', sticky: true });
      layer.on('click', (ev) => {
        L.DomEvent.stop(ev);
        this.onBlockTap(e);
      });
      layer.addTo(this.blockLayer);
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}

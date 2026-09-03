# Bike GPS

A mobile-first progressive web app for turn-by-turn bicycle navigation — with the twist that you can **blocklist roads or stretches of road** you never want to be routed down, and the router will route around them while still letting you cross them at intersections.

No build step, no API keys, no backend: it's static HTML/CSS/JS that deploys straight to GitHub Pages and runs offline once installed.

## Features

- **Turn-by-turn guidance** with a large maneuver banner, "then…" preview, spoken prompts (Web Speech API), speed, distance remaining and ETA.
- **Bike-specific routing** via [BRouter](https://brouter.de) — balanced / fast / safest / shortest profiles, with elevation-aware timing.
- **Road blocklist**
  - *Whole road*: tap a road to block every way with that name nearby.
  - *Stretch*: tap two points; the stretch of road between them is traced along the road network and blocked.
  - *Spot*: a circle nothing may pass through (a dangerous junction, a flooded underpass…).
  - *Avoid this road* while navigating: blocks the road you're on and reroutes instantly.
  - Entries can be toggled, renamed, resized, exported/imported as JSON, and are stored on-device.
- **Automatic rerouting** when you leave the route, with GPS-glitch tolerance.
- **Ride simulator** to preview guidance (and rerouting) without leaving your desk.
- **Offline-capable PWA**: app shell cached, recently viewed map tiles cached (LRU), last route restored on launch, screen wake-lock while navigating, install prompt.
- **Map styles**: OpenStreetMap, CyclOSM (bike infrastructure), Carto Voyager / Dark. Light and dark themes follow the system.

## How blocking works

BRouter supports "no-go" areas, but a no-go polyline drawn along a road would also block *crossing* that road, because any way segment touching it is forbidden. Instead, Bike GPS fences a blocked road with short **perpendicular gates** placed between junctions (junction positions come from OpenStreetMap via Overpass). Riding along the road must pass through a gate, so it's impossible; crossing at a junction never touches one. Spots use plain circular no-go areas.

Only the blocklist entries near the route's bounding box are sent with each routing request, simplified and capped so the request stays small. Blocks within 150 m of the start and destination are lifted for that request, so you can always ride off a blocked road you're standing on (or reach a destination on one).

## Running locally

```sh
npm start          # serves http://localhost:8080 (no dependencies)
npm test           # unit tests for geometry, instructions, blocklist, router, navigation
npm run icons      # regenerate PNG icons
```

Geolocation requires a secure context; `localhost` counts. To test on a phone, use a tunnel or serve over HTTPS.

## Deploying to GitHub Pages

The app is zero-build, so GitHub Pages can serve the repository directly. In **Settings → Pages**, set *Source* to **Deploy from a branch**, branch `main`, folder `/ (root)`. The `.nojekyll` file makes Pages publish files verbatim (Jekyll would otherwise skip `vendor/`). Every push to `main` redeploys; the CI workflow runs the unit tests on each push and pull request.

All asset paths are relative, so the app works from a project subpath (`https://<user>.github.io/bike-gps/`) as well as a custom domain.

## Project layout

```
index.html            app shell
app.webmanifest       PWA manifest
sw.js                 service worker (shell + tile caching)
css/app.css
js/
  main.js             controller: wires everything together
  ui.js               DOM helpers and view renderers
  map.js              Leaflet wrapper (markers, route, blocklist layers, gestures)
  geo.js              pure geometry (haversine, snapping, simplification…)
  router.js           BRouter client (URL building, response parsing)
  instructions.js     maneuvers from BRouter voice hints (geometric fallback)
  blocklist.js        blocklist model → no-go gates/circles
  navigator.js        navigation engine + ride simulator
  voice.js            speech synthesis
  geocode.js          Nominatim search/reverse (rate-limited)
  overpass.js         Overpass queries: roads at a point, by name, junctions, street names
  storage.js          localStorage persistence
vendor/leaflet/       Leaflet 1.9.4 (vendored for offline use)
scripts/              dev server, icon generator
test/                 node --test suites (+ a real BRouter response fixture)
```

## Services used

Routing by [BRouter](https://brouter.de), search by [Nominatim](https://nominatim.org), road data via the [Overpass API](https://overpass-api.de), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. These are free, community-run services with usage policies — the app batches and rate-limits its requests, and the routing endpoint is configurable in Settings if you run your own BRouter.

## Browser support

Modern mobile browsers (iOS Safari 16+, Chrome/Android). Voice guidance needs the Web Speech API; wake lock and install prompts are used where available.

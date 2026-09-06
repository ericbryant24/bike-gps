# Bike GPS

A mobile-first progressive web app for turn-by-turn bicycle navigation — with the twist that you can **blocklist roads or stretches of road** you never want to be routed down, and the router will route around them while still letting you cross them at intersections.

No build step, no API keys, no backend: it's static HTML/CSS/JS that deploys straight to GitHub Pages and runs offline once installed.

## Features

- **Turn-by-turn guidance** with a large maneuver banner, "then…" preview, spoken prompts (Web Speech API), speed, distance remaining and ETA.
- **3D heading-up navigation view**: the map rotates with your direction of travel and tilts to a perspective view with 3D buildings (MapLibre GL + OpenFreeMap vector tiles). Tap the compass to switch to flat north-up.
- **Bike-specific routing** via [BRouter](https://brouter.de) — balanced / fast / safest / shortest profiles, with elevation-aware timing.
- **Route options**: after the main route appears, BRouter's alternatives are fetched, thinned to ones that actually differ, and listed side by side with distance, time, overall grade and metres on busy roads (grades D/E). The quietest, fastest and shortest get badges, the unchosen routes sit as grey lines on the map, and tapping a row or a line switches the plan. The profile is still a cost trade-off, so this is how you see whether a longer, calmer route exists.
- **Road blocklist** — every block is previewed in orange with its name, length, junctions and traffic lights before you confirm it.
  - *Whole road*: tap a road to block every way with that name within 2 / 5 / 10 km of the tap.
  - *Stretch*: tap two points; the stretch of road between them is traced along the road network and blocked.
  - *Spot*: a circle (20–120 m) nothing may pass through (a dangerous junction, a flooded underpass…).
  - *Avoid this road* while navigating: blocks the road you're on and reroutes instantly.
  - **Crossing rule** per block: *only at traffic lights* (default) or *at any intersection*.
  - Entries can be toggled, renamed, resized, exported/imported as JSON, and are stored on-device.
- **Road ratings**: every stretch of a planned route is graded A–E for bike-friendliness from its OpenStreetMap tags (separated path → quiet street → moderate → busy → major road, adjusted for bike lanes, protected lanes, signed cycle routes, speed limits and unpaved surfaces). The route is coloured by grade on the map, the summary shows a composition bar and overall grade, and each turn-by-turn step shows its road's grade, description and the lights/stops on it.
- **Tap a place on the map** (shop, park, café… from the tile data) to see its type, distance, address, hours and contact where available, and route to it.
- **Share a route**: the link carries the route's own geometry, so the recipient sees the exact path (not one re-planned with their blocks) and can navigate it; one tap re-plans with their own blocks. GPX export for other devices.
- **On-device place search**: the app decodes the vector tiles it already downloads and indexes every named shop, park, café, street, water body and neighbourhood within ~5 km of you (about 60 tiles, a few MB, cached). Queries match on-device — accent-, case- and apostrophe-blind, prefix and typo-tolerant ("wite castle", "greaters") — nearest first. Photon/Nominatim only add addresses and far-away places. Works offline once tiles are cached.
- **Optional Mapbox search**: paste a Mapbox public token in Settings to use the Mapbox Search Box API instead (note: Mapbox requires a payment method on file even for its free tier).
- **Search** anchored to *your location* regardless of where the map is: suggestions appear as you type without moving the map; Enter/Go sorts results by distance from you, drops numbered pins and fits them into view; "Search this area" (after you pan) is the only search that uses the visible map instead.
- **Automatic rerouting** when you leave the route, with GPS-glitch tolerance.
- **Ride simulator** to preview guidance (and rerouting) without leaving your desk.
- **Offline-capable PWA**: app shell cached, recently viewed map tiles + fonts/sprites cached (LRU), last route restored on launch, screen wake-lock while navigating, install prompt.
- **Map styles**: OpenFreeMap Liberty / Bright / Positron (vector, 3D), plus raster OpenStreetMap, CyclOSM (bike infrastructure), Carto Voyager / Dark. UI follows the system light/dark theme.

## How blocking works

BRouter supports "no-go" areas, but a no-go polyline drawn along a road would also block *crossing* that road, because any way segment touching it is forbidden. Instead, Bike GPS fences a blocked road with short **perpendicular gates** placed between junctions (junction positions come from OpenStreetMap via Overpass). Riding along the road must pass through a gate, so it's impossible; crossing at a junction never touches one. Spots use plain circular no-go areas.

Each blocked road has a **crossing rule**. With *only at traffic lights* (the default), every junction along the road that has no `highway=traffic_signals` node nearby is additionally closed with a 5 m no-go circle, so the router can only cross where there's a light. T-junctions where the blocked road ends are left open, since there's nothing to cross there. *At any intersection* skips the circles.

Only the blocklist entries near the route's bounding box are sent with each routing request. The router accepts about 25 KB of no-go data per request, so gates and circles are ranked by distance to the trip (start→destination line, then the actual route on a second pass) and packed nearest-first into a 20 KB budget — long blocks are thinned far from the trip rather than dropped. After routing, the app checks whether the result still rides along any blocked road and says so. If no route can avoid every block, it retries with *soft* penalties so the router spends as little distance as possible on blocked roads, and the summary names the roads used. Blocks within 150 m of the start and destination are lifted for that request, so you can always ride off a blocked road you're standing on (or reach a destination on one).

## Running locally

```sh
npm start          # serves http://localhost:8080 (no dependencies)
npm test           # unit tests for geometry, instructions, blocklist, router, navigation
npm run icons      # regenerate PNG icons
```

Geolocation requires a secure context; `localhost` counts. To test on a phone, use a tunnel or serve over HTTPS.

## Deploying to GitHub Pages

The app is zero-build, so GitHub Pages can serve the repository directly. In **Settings → Pages**, set *Source* to **Deploy from a branch**, branch `main`, folder `/ (root)`. The `.nojekyll` file makes Pages publish files verbatim (Jekyll would otherwise skip `vendor/`). Every push to `main` redeploys; the CI workflow runs the unit tests on each push and pull request.

**Bump `APP_VERSION` in `js/version.js` with every deploy.** It names the service-worker cache, so a new value is what makes already-installed apps fetch the new files (users see an "Update available" toast, and Settings has a "Check for updates" button).

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
  map.js              MapLibre GL wrapper (styles, camera, markers, route/blocklist layers, gestures)
  geo.js              pure geometry (haversine, snapping, simplification…)
  router.js           BRouter client (URL building, response and segment parsing)
  rating.js           bike-friendliness grading of route segments
  alternatives.js     alternative-route dedupe and traffic-exposure comparison
  share.js            route links (encoded polyline) and GPX export
  mvt.js              minimal Mapbox Vector Tile decoder
  places.js           on-device place index (tiles → fuzzy nearest-first search)
  instructions.js     maneuvers from BRouter voice hints (geometric fallback)
  blocklist.js        blocklist model → no-go gates/circles
  navigator.js        navigation engine + ride simulator
  voice.js            speech synthesis
  geocode.js          Nominatim search/reverse (rate-limited)
  overpass.js         Overpass queries: roads at a point, by name, junctions, street names
  storage.js          localStorage persistence
vendor/maplibre/      MapLibre GL JS 5.24 (vendored for offline use)
scripts/              dev server, icon generator
test/                 node --test suites (+ a real BRouter response fixture)
```

## Optional: Mapbox search

Search uses free OpenStreetMap geocoders by default. For Google-quality place search, create a free Mapbox account, make a **public** token (`pk.…`) with the default scopes, restrict it to your site's URL (e.g. `https://<user>.github.io/bike-gps/*`), and paste it in **Settings → Mapbox search token**. The token is stored only on that device. Mapbox's free tier (tens of thousands of search sessions per month) comfortably covers personal use; the app uses one *suggest* session per query while typing plus one *retrieve* or *forward* request when you commit.

## Services used

Routing by [BRouter](https://brouter.de), search by [Photon](https://photon.komoot.io) with [Nominatim](https://nominatim.org) as fallback, road data via the [Overpass API](https://overpass-api.de), vector tiles by [OpenFreeMap](https://openfreemap.org), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. These are free, community-run services with usage policies — the app batches and rate-limits its requests, and the routing endpoint is configurable in Settings if you run your own BRouter.

## Browser support

Modern mobile browsers (iOS Safari 16+, Chrome/Android) with WebGL. Voice guidance needs the Web Speech API; wake lock and install prompts are used where available.

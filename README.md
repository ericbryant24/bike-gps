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
- **Bike racks**: bike parking from the vector tiles (OpenStreetMap `amenity=bicycle_parking`) is drawn as small teal badges from zoom 14, tappable to route to; the route summary says how many racks are within 250 m of your destination and how far the nearest is (tap to see them); searching "bike rack" lists the nearest ones. Toggle in Settings.
- **Place details**: tap a place on the map, or ⓘ on a search row, for a card that fills in from free sources: for parks, size and what's inside (playgrounds, restrooms, shelters, sports fields, dog parks, ponds…) computed from the vector tiles, offline; opening hours (open/closed now), phone, website and address from TomTom; a Wikipedia paragraph and photo when an article is about that place; nearby geotagged photos from Wikimedia Commons. Tap anywhere inside a named park to get its card.
- **Tap a place on the map** (shop, park, café… from the tile data) to see its type, distance, address, hours and contact where available, and route to it.
- **Paste a map link**: paste a Google Maps, Apple Maps or OpenStreetMap link (or `geo:` URI) into search and the place becomes your destination. Full links are parsed on-device; short `maps.app.goo.gl` links are resolved through unshorten.me (or, failing that, the place name from the shared message is searched). Google's share links usually carry only a name and street address, no coordinates: the address is pinned with Nominatim and the pin snaps to the named place when the on-device index knows it. On Android the app appears in the system Share menu.
- **Share a route**: the link carries the route's own geometry, so the recipient sees the exact path (not one re-planned with their blocks) and can navigate it; one tap re-plans with their own blocks. GPX export for other devices.
- **On-device place search (fallback and offline)**: the app decodes the vector tiles it already downloads and indexes every named shop, park, café, street, water body and neighbourhood within ~5 km of you (about 60 tiles, a few MB, cached). Queries match on-device — accent-, case- and apostrophe-blind, prefix and typo-tolerant ("wite castle", "greaters") — nearest first. Photon/Nominatim only add addresses and far-away places: street addresses ("4457 Rosemary Pkwy") go to Nominatim first, postal abbreviations are spelt out for matching, and anything found nearby always outranks matches far away, which are only shown when nothing at all is close. Works offline once tiles are cached.
- **TomTom search**: suggestions while you type come from the TomTom Search API (commercial business listings and house-number address autocomplete, one request per query), merged with instant hits from the on-device tile index. A built-in free-tier key locked to this site is used; paste your own in Settings to use your own quota. If TomTom is unreachable or the quota runs out, search falls back to the OpenStreetMap stack below.
- **Search** anchored to *your location* regardless of where the map is: suggestions appear as you type without moving the map; Enter/Go sorts results by distance from you, drops numbered pins and fits them into view; "Search this area" (after you pan) is the only search that uses the visible map instead.
- **Automatic rerouting** when you leave the route, with GPS-glitch tolerance.
- **Battery**: idle, the app runs no GPS watch, timers or polling. While navigating the follow camera only moves when you actually move or turn (GPS jitter at a red light no longer keeps the GPU drawing), and a *Battery saver* setting keeps the map flat and north-up, which is much cheaper to render than the tilted 3D view. The avoid-this-road control in the ride HUD is a compact ⛔ button.
- **Ride simulator** to preview guidance (and rerouting) without leaving your desk.
- **Offline-capable PWA**: app shell cached, recently viewed map tiles + fonts/sprites cached (LRU), last route restored on launch, screen wake-lock while navigating, install prompt.
- **Map styles**: OpenFreeMap Liberty / Bright / Positron (vector, 3D), plus raster OpenStreetMap, CyclOSM (bike infrastructure), Carto Voyager / Dark. UI follows the system light/dark theme.

## How blocking works

BRouter supports "no-go" areas, but a no-go polyline drawn along a road would also block *crossing* that road, because any way segment touching it is forbidden. Instead, Bike GPS fences a blocked road with short **perpendicular gates** placed between junctions (junction positions come from OpenStreetMap via Overpass). Riding along the road must pass through a gate, so it's impossible; crossing at a junction never touches one. Spots use plain circular no-go areas.

Each blocked road has a **crossing rule**. With *only at traffic lights* (the default), every junction along the road that has no `highway=traffic_signals` node nearby is additionally closed with a 5 m no-go circle, so the router can only cross where there's a light. T-junctions where the blocked road ends are left open, since there's nothing to cross there. *At any intersection* skips the circles.

**Offset junctions.** Side streets often don't line up across a main road, so crossing at the light means riding a few dozen metres along it (W Weisheimer Rd meets N High St 48 m south of E Weisheimer Rd). Gates and junction circles within 80 m of a traffic light are therefore sent as *weighted* no-gos rather than hard ones: BRouter may pass them, at a penalty of roughly 150–300 m of quiet street per jog. A straight crossing at a light stays free, so it is always preferred when one exists nearby, and the rest of the road stays walled off. On roads with lights closer than about 160 m apart the stretch between two lights becomes expensive rather than impassable. The jog only opens around lights that OpenStreetMap knows about; a missing `highway=traffic_signals` node keeps that junction closed.

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
  mvt.js              minimal Mapbox Vector Tile (MVT) decoder
  config.js           built-in TomTom search key
  details.js          place details: park facts from tiles, TomTom hours, Wikipedia, Commons photos
  places.js           on-device place index (tiles → fuzzy nearest-first search)
  links.js            pasted map links → destination
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

## Search key

`js/config.js` holds a TomTom Search API key. It is intentionally public: a browser app cannot hide a key, so it is a free-tier key (no payment method on the account) with TomTom's domain whitelist set to this site. If it is ever abused, make a new key in the TomTom portal and replace it. **Settings → TomTom key** overrides it per device.

## Services used

Routing by [BRouter](https://brouter.de), search by [Photon](https://photon.komoot.io) with [Nominatim](https://nominatim.org) as fallback, road data via the [Overpass API](https://overpass-api.de), vector tiles by [OpenFreeMap](https://openfreemap.org), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. These are free, community-run services with usage policies — the app batches and rate-limits its requests, and the routing endpoint is configurable in Settings if you run your own BRouter.

## Browser support

Modern mobile browsers (iOS Safari 16+, Chrome/Android) with WebGL. Voice guidance needs the Web Speech API; wake lock and install prompts are used where available.

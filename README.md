# Ember

A live environmental simulation coupled to an adaptive evacuation network.

**Built for NextStep Hacks 2026 — Earth Forward (track: HackAlphaX).** The
brief was to connect environmental data to a real infrastructure decision —
Ember's answer is a wildfire that actually changes which roads are safe and
actually reroutes people around it, rather than a map with a fire animation
layered on top.

Ember simulates how a wildfire can propagate across terrain and dynamically
reroutes evacuation networks as roads become threatened. It is a
decision-support simulation for exploring how environment and infrastructure
interact — **not an operational wildfire forecast.**

> **Status:** `SIMULATION • NOT AN OPERATIONAL FORECAST` — shown persistently
> in the app itself. Never presented as live telemetry.

---

## The problem

Wildfire information usually exists as disconnected layers: fire
observations on one map, weather on another, terrain elsewhere, roads and
evacuation notices somewhere else entirely. Nothing shows how those layers
*interact*. Ember connects them into one system: change the environment, and
watch the infrastructure impact and the evacuation network respond.

```
REAL DATA  →  SIMULATION  →  INFRASTRUCTURE IMPACT  →  ROUTE ADAPTATION
```

## What Ember does

- Runs a **cellular wildfire propagation model** over a terrain grid, driven
  by wind, slope, fuel (land cover), humidity, and temperature.
- Generates **probabilistic spot fires** — downwind ember ignitions that
  create new, non-contiguous fire fronts.
- Classifies every road segment `SAFE → WATCH → THREATENED → BLOCKED` from
  projected fire proximity, with a time-to-threat ETA.
- Runs a **graph-based evacuation router** (Dijkstra) that recomputes
  least-risk routes the moment road status changes, and explains *why* a
  road or route changed.
- Lets the user intervene: shift wind, close a road, or draw a **firebreak**
  and watch the propagation, threatened roads, and routes update.
- Supports **prepared locations** (California, Pacific Northwest, Colorado,
  each reseeding the same generator with a different starting environment)
  and named, session-scoped **scenario snapshots** to save/restore a state.
- Runs a **scenario comparison** drawer: capture a baseline, change the
  environment or let time advance, capture again, and see fire fronts,
  roads threatened/blocked, communities affected, and active routes
  side-by-side.
- Includes an experimental **thermal proxy layer** — a heat-decay overlay
  derived from the simulation itself, explicitly labeled as not live
  Landsat/VIIRS thermal imagery.
- Full **keyboard control** (space to play/pause, R to reset, D for the
  guided demo, L/E/I to toggle layers/environment/inspector panels, arrow
  keys to step the timeline, Escape to close panels) and baseline
  accessibility support (`prefers-reduced-motion`, focus-visible states,
  ARIA live regions on the status line/feed/toasts, keyboard-operable road
  list) — see the in-app Methodology panel for the full shortcut list.
- Runs entirely as a single portable web page, with every external data
  source backed by a **cached fallback** so a network failure never breaks
  the demo.

It is explicitly **not**: a chatbot, an "AI assistant" panel, a static risk
map, or a looping animation. The intelligence is the simulation and
optimization engine, not a language model.

## Architecture

```
             ┌─────────────────────┐
             │   REAL EARTH DATA    │
             ├─────────────────────┤
             │ NASA FIRMS            │
             │ Open-Meteo             │
             │ USGS 3DEP Terrain       │
             │ ESA WorldCover           │
             │ OpenStreetMap / Overpass  │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │   DATA NORMALIZER    │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ ENVIRONMENTAL STATE   │
             └──────────┬──────────┘
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
    ┌──────────────────┐   ┌──────────────────┐
    │ FIRE SIMULATION    │   │ ROAD GRAPH         │
    │                     │   │                     │
    │ wind                │   │ intersections       │
    │ slope               │   │ segments            │
    │ fuel                │   │ travel time         │
    │ humidity            │   │ risk                │
    │ spotting            │   │ closures            │
    └────────┬───────────┘   └────────┬───────────┘
             │                        │
             └──────────┬─────────────┘
                        ▼
             ┌─────────────────────┐
             │ IMPACT / RISK ENGINE  │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ ROUTING ENGINE         │
             │ DIJKSTRA (A*-ready)      │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │   EMBER INTERFACE      │
             │                        │
             │ map                    │
             │ timeline               │
             │ routes                 │
             │ controls                │
             │ intelligence feed        │
             └─────────────────────┘
```

The simulation engine never talks to an individual API directly — everything
flows through a `DataSource → Normalizer → EnvironmentalState` pipeline
(`packages/simulation/engine.js: normalizeEnvironmentalState`), so a real
adapter can be dropped in without touching the fire model, the router, or
the UI. As of this build, **two of the five boxes in "REAL EARTH DATA" above
are actually live** (NASA FIRMS, Open-Meteo) and three are procedurally
generated stand-ins (USGS 3DEP, ESA WorldCover, OpenStreetMap/Overpass) —
see "Data sources" below for exactly which and why.

### Project layout

```
ember/
├── apps/web/index.html          the entire application: simulation, routing,
│                                 rendering, UI — one self-contained file,
│                                 no build step (see docs/architecture.md
│                                 for why a single file was the right call
│                                 under a hackathon deadline)
├── packages/simulation/
│   ├── engine.js                 pure, dependency-free reference
│   │                              implementation of the fire/environment
│   │                              math — independently unit-testable,
│   │                              and what a real backend would import
│   ├── engine.test.js            22 unit tests over engine.js
│   └── behaviour.test.js         62 behavioural tests over the REAL app
│                                  code (see tools/headless-harness.js)
├── tools/headless-harness.js      loads apps/web/index.html into a Node
│                                  vm with the DOM/canvas stubbed, so the
│                                  actual production code path — not a
│                                  reimplementation — is what gets tested
├── docs/
│   ├── architecture.md            why single-file, why vanilla JS, the
│   │                              intervention-ledger design, the road
│   │                              graph's per-segment edge model
│   └── simulation.md              the propagation model in full: fuel,
│                                  wind, slope, humidity, spotting, the
│                                  fire-rendering pipeline
├── CHANGELOG.md                   what was found and fixed, pass by pass,
│                                  across every session that touched this
├── api/firms.js                   Vercel serverless proxy for NASA FIRMS; the
│                                  MAP_KEY lives only here (env var)
├── vercel.json                    serves apps/web as the site root
├── .env.example                   documents FIRMS_MAP_KEY (Vercel env var /
│                                  .env.local); the real key is never committed
└── package.json                   `npm test` — no other dependencies
```

## Data sources — real vs. simulated

Two of the five sources below are genuinely wired to live HTTP calls; the
other three are deliberately not, for an architectural reason explained
after the table (not an oversight — see `CHANGELOG.md` for the full
reasoning).

| Source | Role | This build |
|---|---|---|
| NASA FIRMS | Active fire detections → ignition seeds | **Live** via the server-side `/api/firms` proxy (key in the `FIRMS_MAP_KEY` env var, nothing for users to enter) — falls back to a cached ignition point if the proxy/key is unavailable, offline, or 0 detections found |
| Open-Meteo | Wind, temperature, humidity | **Live** (no key needed) — falls back to a cached, still user-adjustable value on failure |
| USGS 3DEP Terrain | Elevation → slope / aspect | Procedurally generated, deterministic — not wired live |
| ESA WorldCover | Land cover → fuel proxy | Procedurally generated, deterministic — not wired live |
| OpenStreetMap / Overpass | Roads, communities | Hand-authored road graph — not wired live |

**Why terrain/land cover/roads stay procedural.** The 72×72 grid's slope
model, the road IDs the routing graph and the guided demo are keyed to, the
tuned ignition point, and the firebreak coordinates were all derived
empirically against this ONE fixed synthetic geometry (see `CHANGELOG.md`
Pass 2 for how much tuning that took). Real per-location elevation/land
cover/roads for an arbitrary place would invalidate every one of those —
it's not a missing adapter, it's a different scenario that would need the
same tuning work done again from scratch. Weather and fire detections don't
have that problem: they're real conditions *at a point*, and they feed
straight into the existing grid's environment/ignition inputs without
touching its geometry.

**How the live calls work.** Each of the four "prepared locations" in the
scenario picker has a real lat/lon anchor (e.g. Los Padres National Forest,
CA for the default). On boot and on location change, the app calls
Open-Meteo for current wind/humidity/temperature at that point, and — where
the `/api/firms` function is deployed with `FIRMS_MAP_KEY` set — NASA FIRMS for real VIIRS active-fire detections within
the grid's real 18km×18km footprint in the last 24 hours. If FIRMS finds a
real detection, it's mapped onto the grid and used as the actual ignition
point instead of the tuned default. Both calls degrade independently and
loudly: the Data Sources panel (◈) shows `LIVE` with a timestamp/source, or
`CACHED` with the *actual* failure reason (network error, CORS, bad key, 0
detections found) — never a silent fallback, and never `LIVE` for data that
didn't arrive. This is a real instance of the project's own standing rule:
observed / retrieved / cached / simulated must always stay distinguishable
in the UI.

| Simulated output | Never presented as |
|---|---|
| Future fire propagation, projected perimeter | An official forecast |
| Spot-fire probability | A prediction of exact ignition locations |
| Road threat timing / ETA | A guarantee of when a road will close |
| Evacuation route changes | Official evacuation guidance |

## Simulation model

Grid cellular automaton (72×72 cells). Each active cell evaluates its 8
neighbors every tick; ignition probability is:

```
probability = 1 - exp(-(
    base_rate
    × fuel_factor
    × wind_factor      (downwind > crosswind > upwind)
    × slope_factor      (upslope favored, downslope suppressed)
    × dryness_factor      (from humidity)
    × temperature_factor    (secondary, capped)
    × intervention_factor     (firebreaks ≈ 0)
    × spread_multiplier
))
```

Every factor is an independently testable pure function — see
`packages/simulation/engine.js`. Burn duration is fuel-class dependent, so
grass burns out quickly and forest burns for longer. High-intensity cells
have a probabilistic chance, scaled by wind speed, of spotting a new
ignition downwind — a genuinely separate, non-contiguous fire front, which
the engine reports to the feed with its measured separation from the main
front.

### Rendering

The simulation is strictly cellular; the *presentation* is not. Each frame
the cell arrays are resampled into a continuous scalar field at 3× sub-cell
resolution (216² samples) using smoothstep-weighted bilinear interpolation,
with a deterministic fBm warp applied to the sample coordinates. The warp is
fixed per seed and displaces the boundary by well under one cell, so the
perimeter reads as irregular and organic without ever inventing fire where
the simulation has none. On top of that field sit four separable layers:
the charred burn scar, the incandescent body (coloured by real intensity, so
the interior is not uniformly bright), the *active front* — contoured from
cells that ignited within the last few simulated minutes, not the whole
perimeter — and discrete ember glyphs for spot fires. Newly ignited cells
ease in over ~110ms and burnt-out cells fade over ~260ms, so the fire
evolves rather than popping on and off.

The field and its marching-squares contours are cached and rebuilt at 30Hz,
restricted to the fire's bounding box; each frame only blits the cached
offscreen canvas and strokes the cached contours. Measured cost at full fire
extent is ~1.7ms/frame.

**Map canvases render at native resolution.** `canvas.width/height` are sized
to `cssSize * devicePixelRatio`, with the drawing context scaled back down via
`ctx.setTransform(dpr,0,0,dpr,0,0)` so every existing draw call keeps working
in CSS-pixel units unchanged. Without this, all four map canvases rendered at
half (or worse) resolution on any HiDPI display and were then blurred by the
browser's own upscaling — undermining the fire field, terrain and text no
matter how good the drawing code was.

**Terrain has real relief.** `drawTerrain()` only runs on resize/reset/scrub
(never per animation frame), so it computes an actual hillshade: a
finite-difference slope + Lambertian light from a fixed NW direction, with a
9× vertical exaggeration tuned against this generator's gentle procedural
gradients (true-scale slope produces almost no visible contrast). Elevation
contour lines are drawn on top using the same marching-squares machinery as
the fire perimeter, but deliberately *without* the organic fBm warp — this is
simulated geography, not a boundary that should look hand-drawn. Landcover
colors are desaturated ~30% at render time, so fire, roads and the
evacuation route — all drawn on separate canvases layered above — read as
the thing to look *at* rather than compete with the ground for attention.

**Roads, routes and labels are cased.** A dark stroke is drawn under every
road and under the evacuation route line before their status/route color, so
a SAFE (light grey) road stays legible over dark terrain and a route stays
legible once fire has burned through the ground beneath it. Every on-map
label (community names, the safe-zone marker) is drawn with a dark
`strokeText` halo directly behind its `fillText`, for the same reason —
plain text was unreadable over anything colorful behind it.

**The timeline is navigable, not just a progress bar.** Every entry in the
event feed also drops a small tick on the timeline track at the simulated
minute it occurred, colored by kind (wind/spotting event, firebreak, route
change, system). Clicking a tick scrubs straight to that moment. The
track's `aria-valuemax` and minute labels are generated from
`MAX_TL_MINUTES` at startup rather than hardcoded — they had gone stale
(`aria-valuemax="30"`, labels reading up to "30:00") after the horizon was
last retuned to 100 minutes, undetected until this pass. See
`CHANGELOG.md` for the full history of fixes across sessions.

**Honestly simplified, on purpose:** this is not a calibrated fire-behavior
model (no Rothermel equations, no fuel moisture time-lag classes, no real
wind field solved from terrain). It is a heuristic model tuned to make
wind, terrain, and fuel *visibly and correctly* change the outcome, which is
the product's actual claim.

## Routing

Roads are sampled into points; each tick, every sampled point's distance to
the nearest active fire cell determines the road's status
(`SAFE / WATCH / THREATENED / BLOCKED`, configurable thresholds in
`ROAD_THRESHOLDS`). Each community runs Dijkstra from its node to the
designated safe zone, with edge cost `length × (1 + risk_penalty)`;
`BLOCKED` edges are excluded outright, `THREATENED` edges are heavily
penalized, `WATCH` edges lightly penalized. Any status change triggers a
recompute and an intelligence-feed event explaining what changed and why.

## Limitations

- Runs fully offline; "live" data sources are honestly labeled as cached
  fallbacks, not live telemetry.
- Terrain and land cover are procedurally generated from a seed, not real
  USGS/ESA rasters — shaped to resemble their real-world value ranges.
- The fuel/spread/threshold constants are simplified and tunable in the UI,
  not professionally calibrated fire-behavior parameters.
- The road network is a small, hand-authored graph (11 segments, 4
  communities), not an Overpass extract.
- No true geographic projection — the map uses a local grid, not lat/lon
  tiles.

## Running locally

The whole application is one self-contained file. No build step, no
install, no network required.

```bash
open apps/web/index.html        # macOS
xdg-open apps/web/index.html    # Linux
# or just double-click it / drag it into a browser
```

To run the full automated test suite (engine unit tests + behavioural
regression suite — see "Testing" below):

```bash
npm test
```

## Demo

Opens directly into a staged initialization sequence, then the simulation
console for the default scenario, **Los Padres Ridge Corridor** — one
cached fire detection in the upwind NW quadrant, four communities, an
11-road / 30-edge network. Press **Guided Demo** for a ~70-second sequence
at 1× and watch the whole chain run:

```
t=10  Canyon Road → WATCH          (fire front 3.24 km, measured)
t=18  wind shift 315°/24 → 330°/58 (real env change)
t=24  Canyon Road → THREATENED     (1.98 km, closure projected in 7 min)
t=28  Canyon Road → BLOCKED        (removed from the routing graph)
t=28+ spot fires detected ahead of the front
t=52  firebreak deployed           (real propagation multiplier 0.03)
t=58  Oakridge route recomputed    (Old Mill → Hwy 39 → Pine Hollow)
t=75  Highway 39 BLOCKED, Summit View isolated
```

Every one of those is a state transition the engine actually made — the
demo script only supplies the wind shift and the firebreak, and narrates
using numbers read back out of the live simulation. Or drive it manually
with the timeline, environment sliders, manual road closure, and firebreak
drawing tool.

## Testing

```
npm test          # engine unit tests + behavioural regression suite
```

Two suites, both `node`-only with no dependencies:

- `packages/simulation/engine.test.js` — 22 pure-function unit tests over
  `packages/simulation/engine.js`.
- `packages/simulation/behaviour.test.js` — 62 behavioural checks that run
  the **real** application code (simulation, routing, guided demo, canvas
  rendering) loaded out of `apps/web/index.html` by
  `tools/headless-harness.js`, a Node `vm` harness with the DOM stubbed. The
  fake 2D context also *records* the drawing calls made on it (`stroke`,
  `fillText`, `strokeText`, `drawImage`, ...) with a global call-order
  sequence number, so tests can assert on actual rendering decisions —
  "every road is cased before its status stroke", "every label's fillText
  is immediately preceded by its strokeText halo" — instead of trusting
  that the source code matches what executes. Other checks cover: every
  community has a baseline route, road status is derived from measured
  fire distance rather than a timer, wind/humidity/temperature/fuel/slope
  each materially change the outcome, the firebreak reduces burnt area and
  delays isolation, scrubbing replays interventions and rebuilds the event
  feed/timeline markers without duplication, and hillshade responds to
  real terrain slope rather than being flat.

**What this does not cover:** the harness runs the real logic against a
recording *stub*, not a real `<canvas>`, so it can confirm *which* drawing
calls happened and in what order, but not the actual pixels, layout, paint,
z-index, pointer-events or hit-testing. Those still need a real browser.
Playwright is listed but its
browser binaries are not vendored here, so no in-browser interaction testing
has been performed on this build — treat visual/interaction QA as
outstanding.

## Technology

Single-page app: vanilla TypeScript-style JavaScript (no framework, no
build step, by design — see `docs/architecture.md` for why), HTML5 Canvas
rendering, no external runtime dependencies. `packages/simulation/engine.js`
is a plain CommonJS module so its pure functions are independently unit
testable with only `node`.

## What's next

In priority order, grounded in what's actually been flagged as incomplete
across `CHANGELOG.md` and the Limitations/Testing sections above — not a
wishlist:

1. **Real browser QA.** Every behavioural claim in this README is verified
   by a headless Node harness that runs the real code against a stubbed
   DOM/canvas — it's never been checked in an actual browser (no cached
   Playwright binaries, no network, in the environment this was built in).
   Layout, paint, hover states, and real click hit-testing are the biggest
   open risk in the project right now.
2. **Confirm NASA FIRMS actually works.** The Open-Meteo and FIRMS calls
   were implemented from API documentation, never executed against the
   real internet (same environment constraint as above). FIRMS is now called
   through the same-origin `/api/firms` proxy, so browser CORS is no longer a
   concern; what remains to confirm on a real deployment is that
   `FIRMS_MAP_KEY` is set and the function returns CSV.
3. **A real map projection**, if this goes beyond a demo. The grid is
   local and unprojected; real lat/lon tiles (e.g. MapLibre + a vector
   basemap) would let live weather/fire data and the synthetic road network
   coexist honestly instead of the current "real point, synthetic grid
   around it" compromise.
4. **Live terrain/land cover/roads, as a separate project phase — not a
   quick add.** Wiring USGS 3DEP, ESA WorldCover, and OpenStreetMap for a
   real place means the fixed road IDs, the tuned ignition point, and the
   entire guided-demo choreography all need to be re-derived for that
   place's actual geometry. Worth doing, but scoped honestly as its own
   pass rather than bolted onto this one.
5. **Calibrated fire behavior**, if this ever needs to be more than
   directionally correct — Rothermel-style spread equations, real fuel
   moisture time-lag classes, a wind field solved from terrain rather than
   a uniform vector. Explicitly out of scope today (see "Honestly
   simplified, on purpose" above).
6. **Colorblind-safe status encoding.** Road/route state currently leans on
   hue (fire orange / threat amber / route green) as its primary signal;
   dash-pattern or shape redundancy would make it accessible without
   depending on color discrimination.
7. **Mobile/responsive layout.** Built and tested at desktop widths only.

## Priority order (if scope had to be cut)

P0 (all present): map, cached geographic data, fire simulation, wind /
terrain / fuel influence, roads, road threat detection, dynamic routing,
timeline. P1 (all present): spot fires, community routing, wind controls,
manual road closure, firebreak, data-source indicators, inspector. P2 (all
present, in pragmatic form): guided demo, scenario comparison, an
experimental thermal proxy layer (explicitly not live Landsat), session-only
named snapshots, and a prepared-location picker (reseeds the same generator
with a different environment per region — no live geocoding offline).

## License

MIT — see `LICENSE`.

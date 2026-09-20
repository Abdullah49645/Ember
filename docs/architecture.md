# Architecture

## Why one HTML file instead of a React/Vite/FastAPI stack

The spec calls for React + TypeScript + a WebGL mapping library on the
frontend and a Python/Node backend. That is the right shape for a longer
build. Under the four-day constraint of NextStep Hacks 2026 — Earth Forward
(HackAlphaX), with no guarantee of live network access at judging time, the
pragmatic version of "aggressively pragmatic architecture, independently
degradable" is:

- **No backend at all.** There is nothing to deploy, nothing to keep
  running through judging, nothing that can 500. The simulation, routing,
  and rendering all run client-side.
- **No external map tiles.** MapLibre/Mapbox both need a live tile server
  and, in most configurations, an API key — a single point of failure for a
  demo that must survive venue wifi. Terrain, roads, and fire are rendered
  on `<canvas>` instead, which also makes the fire grid, marching-squares
  perimeter, and route overlays trivial to keep in sync (they're all just
  draw calls against the same shared arrays).
- **No build step.** `apps/web/index.html` is the entire frontend. It opens
  by double-clicking it. There is no npm install that can fail offline, no
  bundler version mismatch, no "works on my machine."

The parts of the spec's architecture that matter most — the strict
`DataSource → Normalizer → EnvironmentalState → SimulationEngine` boundary,
independent pure functions per spread factor, a real graph router, honest
LIVE/CACHED labeling — are all present. What's cut is the specific tech
choices (React, MapLibre, a backend process), not the architectural
discipline the spec is actually after.

`packages/simulation/engine.js` exists precisely so the numerical core
*isn't* trapped inside the single HTML file: it's a plain, dependency-free
CommonJS module, independently unit tested (`engine.test.js`), that a real
build (React frontend, FastAPI or Node backend, real map tiles) could import
unchanged. The single-page app currently carries its own inlined copy of
the same logic so the demo stays a portable, dependency-free artifact; the
module is the reference implementation the copy is kept in sync with.

Because the inlined copy is the one that actually runs, it is also the one
that gets tested. `tools/headless-harness.js` loads `apps/web/index.html`
into a Node `vm` with the DOM stubbed and exposes the module-scoped
internals, so `packages/simulation/behaviour.test.js` asserts against the
real production code path rather than a reimplementation. That harness is
how the road-graph, routing, guided-demo and rendering-cost regressions in
this build were found and are now pinned.

## Simulation-time event scheduling

Nothing that mutates simulation inputs is allowed to be driven by a
wall-clock timer. Wind shifts, spotting-probability changes and firebreaks —
whether they come from the guided demo or from the operator drawing on the
map — are recorded in an **intervention ledger**, addressed by the simulated
minute at which they apply, and consumed from inside `stepSimulation()`.

This falls out of a real bug: the guided demo used to schedule its events
with `setTimeout` at 16s / 34s / 70s, while the simulation reached its
horizon in under four real seconds. Every callback fired into an already
frozen world, so the causal chain the demo exists to demonstrate never ran.

The ledger makes four behaviours correct by construction rather than by
careful bookkeeping:

- **Pause** — no simulated time passes, so no events fire. There is no
  timer left running that could fire later.
- **Speed** — speed divides `TICK_MS` only. It never changes how much
  simulated time a tick is worth, so 1× and 10× produce an identical
  causal sequence.
- **Scrub** — `scrubToTime()` re-simulates deterministically from t=0,
  rolls the environment back to the scenario baseline, and replays the
  ledger up to the target minute. A firebreak cut at minute 52 therefore
  exists at minute 60 and does not exist at minute 40.
- **Reset** — clears the ledger, the fired-beat set and the cached fire
  field, and reseeds the PRNG, so a second run is byte-identical to the
  first.

## Road graph construction

Roads are polylines, and the graph is built with **one edge per polyline
segment** (`A↔B`, `B↔C`, `C↔D`), not one edge per road. Every vertex is a
node, so two roads that meet at an interior vertex genuinely share that
node. Each edge carries its parent road's id, so road status, cost, manual
closure and threat state still drive routing exactly as if roads were single
edges.

This is load-bearing, not cosmetic. An earlier build created one edge per
road joining only the first and last vertex; Summit Pass begins at `[52,34]`,
an interior vertex of Highway 39, so that junction was never wired and
**Summit View and Pine Hollow had no evacuation route at all, with zero fire
on the map**. The entire fire → road → route → accessibility story was
broken independently of the wildfire simulation.

## Module boundaries (conceptual, mapped onto the current single file)

```
DataSource        -- DATA_SOURCES table + buildWorld()/ROAD_DEFS (§ data)
Normalizer         -- normalizeEnvironmentalState() (packages/simulation/engine.js)
EnvironmentalState  -- env {...}, world {elevation, landClass, fuel, ...}
SimulationEngine     -- stepSimulation(), spreadProbability(), spot ignition
RoadGraph              -- buildRoadGraph(), updateRoadStatuses()
RoutingEngine           -- dijkstra(), recomputeAllRoutes()
Interface                -- everything under "RENDERING" / "UI WIRING"
```

The simulation engine never imports a data-source-specific type. It only
ever sees the normalized `EnvironmentalState` shape, so swapping "cached
scenario" for "live NASA FIRMS + Open-Meteo + USGS + WorldCover + Overpass"
is a change confined to the DataSource/Normalizer layer.

## Offline-first, not offline-only

Every external source has a designed failure mode:

- FIRMS unavailable → cached detections seed the fire.
- Weather API unavailable → cached wind/humidity/temperature, still fully
  user-adjustable.
- Terrain/land-cover API unavailable → deterministic procedural terrain
  shaped to resemble realistic elevation/fuel distributions.
- Overpass/OSM unavailable → the hand-authored road graph, which is honest
  about being hand-authored rather than pretending to be a live extract.

The in-app Data Sources panel (`btn-data`) reflects this: every source is
currently labeled `FALLBACK`. A production build would flip a source to
`LIVE` the moment its adapter's fetch succeeds, with no other code changes.

## Rendering pipeline

Four stacked canvases, each redrawn only when its layer actually changes:

1. `canvas-terrain` — elevation/land-cover shading. Redrawn on layer toggle
   or resize only (static per scenario).
2. `canvas-fire` — burned/active cells, intensity glow, marching-squares
   perimeter. Redrawn every simulation tick.
3. `canvas-infra` — wind vector field, roads (colored by status),
   evacuation routes, communities. Redrawn every tick alongside fire.
4. `canvas-interact` — firebreak drawing, selection ring. Redrawn on user
   interaction only.

This keeps the expensive terrain fill (5,184 cells) off the per-tick hot
path.

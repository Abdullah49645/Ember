# Changelog

## Pass 7 — FIRMS key server-side, methodology text, legend layout

- **Why.** The FIRMS MAP_KEY used to be pasted into the Data Sources panel and
  kept in each visitor's `localStorage` (per browser + per origin: it never
  travelled with the code, but every visitor would have had to bring their own).
  Hard-coding a key into `index.html` — or exposing it via a client-side "env
  var" — would publish it to everyone (View Source), git or no git.
- **What.** New `api/firms.js` (Vercel function) reads `process.env.FIRMS_MAP_KEY`,
  validates the bounding box (numeric, 1 degree max), calls FIRMS, and returns
  the CSV with `s-maxage=600` so concurrent users share one upstream call.
  `fetchLiveFireDetections()` now calls same-origin `/api/firms?...`; the key
  input, `getFirmsKey/setFirmsKey` and the Save button are gone, replaced by a
  note that EMBER's own key is in use. A one-line cleanup removes any
  leftover `ember_firms_key` from localStorage. Where `/api/firms` doesn't
  exist (file://, static hosting) the app falls back to the cached scenario and
  says so, as before.
- **Methodology panel text.** Replaced the stale "runs fully offline" paragraph with an accurate live-vs-cached description (Open-Meteo and FIRMS live; terrain, land cover, roads procedural).
- **Legend / zoom overlap.** The status legend sat under the +/−/reset zoom buttons at the bottom-right of the map; the legend is now offset left of them (and wraps on narrow maps).
- **Local dev.** `npm run dev` (`tools/dev-server.js`, no dependencies, no login) serves `apps/web` and mounts `api/firms.js`, reading `FIRMS_MAP_KEY` from `.env.local`.
- **Config.** `vercel.json` (`outputDirectory: apps/web`), `.gitignore`
  (`.env*` except `.env.example`), `.env.example` rewritten.
- **Tests.** +2 behaviour checks (proxy URL has no key; CSV -> ignition cells;
  proxy errors surface honestly) and `tools/firms-proxy.test.js` (5 checks: key
  never in any response/header, 503 when unset, bad/oversized boxes rejected
  before any upstream call, GET only, errors uncached).

## Pass 6 — black-terrain fix (colour pipeline) + duplicate terrain repaint

- **Root cause of the all-black map.** `drawTerrain()` chains
  `shadeColor(desaturate(LC_COLOR[cls], 0.15), f)`. `LC_COLOR` is `#rrggbb`;
  `desaturate()` returns `'rgb(r,g,b)'`; `shadeColor()` only understood
  `#rrggbb` (`parseInt(hex.slice(1),16)`), so on `'rgb(...)'` it parsed
  `parseInt('gb(...')` -> `NaN`, `NaN>>16` -> `0`, and returned `rgb(0,0,0)` for
  all 5,184 cells. Introduced in Pass 3 when `desaturate()` was added. The
  terrain-only layer mode never went through `shadeColor()` and was unaffected.
  The Pass 5 brightening did not (and could not) fix this — see the comment in
  `drawTerrain()`.
- **Fix.** One shared `parseColor()` (`#rrggbb`, `rgb()`, `rgba()`); both
  helpers use it, so they accept each other's output. Bad colours or a
  non-finite factor now throw instead of silently becoming black.
- **Duplicate terrain repaint.** On "Enter Simulation", terrain was painted
  twice: once by `resetScenario()` and again by the Pass 5 deferred
  `resizeCanvases()` a frame later (the first `resizeCanvases()` call returns
  early in `drawTerrain()` because `world` is still null). Same pixels both
  times, so this was wasted work, not part of the black bug. `resizeCanvases()`
  is now a no-op when the map box and DPR are unchanged; a genuine size/DPR
  change still resizes and repaints. Spurious `resize` events no longer repaint.
- **Terrain-only layer mode toned down.** With landcover off, the Pass 5
  formula reached ~rgb(235,240,255) on lit slopes (pale "paper" map that washed
  out fire/route layers). It now uses the same recipe as the landcover view
  (`shadeColor(TERRAIN_ONLY_BASE, 0.75 + hillshade*0.85)`, cool-slate base
  `#363c44`), giving a dark basemap with visible relief and contours.
- **Live weather from `file://` is not a bug.** The CORS error seen in the
  sandbox came from its offline network proxy; with a CORS-enabled Open-Meteo
  response the app shows LIVE WEATHER and applies it (checked with a stubbed
  response: NNW->SSE, 58 km/h, 16 C, 29%, matching the reported screenshot).
  No code change; failure still falls back to the cached scenario.
- **Tests (62 -> 69).** New checks inspect the actual `fillStyle` values
  (valid rgb(), no near-black cells, real luminance/variety), hillshade
  finiteness, helper input-format compatibility, contour strokes (order,
  major/minor style, one per level), and resize idempotence. 4 of them fail on
  the pre-fix source. Harness exports extended (additive only).
- **Verified in real Chromium** (Playwright, 1440x900 @2x): pre-fix terrain
  canvas 100% near-black with a single fillStyle `rgb(0,0,0)`; post-fix 0%
  near-black, 368 distinct colours, contours present, 1 terrain paint on entry
  (was 2), 0 repaints while the simulation runs.

## Pass 5 — live-demo UI fixes (map zoom/pan, feed panel, terrain visibility)

Requested and applied during an actual demo session, so scoped for speed
and safety over polish.

- **Map zoom + pan.** All four map canvases now live inside a new
  `#mapstage` wrapper that takes a single CSS `transform` (scale + translate)
  for zoom/pan — no drawing code changed. `+`/`−`/reset buttons and
  scroll-wheel zoom, both centered on whatever's currently under the
  cursor/viewport-center. Panning reuses the *existing* mousedown/mousemove/
  mouseup chain that already handled firebreak-drawing and click-to-inspect,
  rather than adding a second competing listener set: a mousedown starts a
  "pan candidate", and only escalates to an actual pan past a small pixel
  threshold — a plain click with no real movement still fires
  `handleMapClick` exactly as before. `pxToGrid()` was rewritten to compute
  grid coordinates from the ratio of `getBoundingClientRect()` (which is
  transform-aware) rather than dividing by the fixed `cell` constant, so
  click/hover/firebreak-drawing accuracy holds at any zoom/pan level with no
  other change needed.
- **Resizable Intelligence Feed.** The road list ("Network Status") could
  grow tall enough on a shorter screen to squeeze the event feed down to a
  sliver. Added a drag handle (mouse + arrow-key accessible) between the two
  sections so the user can reallocate space live.
- **Terrain visibility.** Two things, both applied: (1) `resetScenario()`
  was being called *before* `resizeCanvases()` in the entry-point click
  handler, so its own internal `drawTerrain()` call could draw once against
  a canvas still at its pre-layout size — usually invisible since
  `resizeCanvases()`'s own trailing redraw corrected it a moment later, but
  fragile under the wrong timing. Reordered, plus a defensive
  `requestAnimationFrame`-deferred re-resize+redraw as a belt-and-braces
  fix. (2) The Pass-3 hillshade/desaturation values read as much darker on
  a demo screen/projector than intended, especially in the "Terrain" (no
  landcover) layer mode, which was near-black. Brightened both terrain
  render paths substantially.

**Not independently re-verified beyond the existing 62-test suite** (which
still passes unchanged, since none of the above touches simulation, routing,
or fire-model logic) — these are DOM/CSS/interaction changes made live
during a demo and warrant a real-browser look when there's time, same as
the outstanding browser-QA item from Pass 2/3.

## Pass 4 — live data: NASA FIRMS + Open-Meteo

**What changed:** two of the five sources in the data panel are now
genuinely wired to real HTTP calls instead of being uniformly cached.

- **Open-Meteo** (no key) — real current wind/humidity/temperature for a
  real lat/lon anchor assigned to each "prepared location", fetched on boot
  and on location change.
- **NASA FIRMS** (free key, entered in-app, stored in `localStorage`) —
  real VIIRS active-fire detections in the grid's real 18km×18km footprint
  in the last 24h. A real detection becomes the actual ignition point; zero
  detections (the overwhelmingly likely case for these anchor points) falls
  back to the tuned default, honestly labeled as such.

**Deliberately NOT wired:** USGS 3DEP elevation, ESA WorldCover land cover,
OpenStreetMap/Overpass roads. Reason: the 72×72 grid's slope model, road
IDs, tuned ignition point, and the entire guided-demo choreography (Pass 2)
were derived empirically against ONE fixed synthetic geometry. Real
per-location geodata would invalidate all of that — it isn't a missing
adapter, it's a different scenario needing the same tuning work redone. This
was a scoping decision made explicit to the user, not a silent omission.

**Fixed along the way**
- A pre-existing bug, unrelated to live data but touched by this work:
  `selectScenario()` called `resetScenario()` (which snapshots the *current*
  env as the scrub baseline) and only assigned the new location's wind/
  humidity/temperature *afterward* — so the baseline silently kept the
  *previous* location's values. Scrubbing after switching location would
  revert the environment to the old place. Fixed by re-snapshotting the
  baseline after the new values are set, not before.
- The harness's `setAttribute` was a no-op and `innerHTML` didn't clear
  `.children` — both now behave like real DOM, which is what made the
  location-switch and live-status tests below meaningful.

**Honesty mechanism:** every fetch is wrapped so failure (network, CORS,
timeout, missing/bad key, malformed response) degrades to the cached
scenario and reports the *actual* reason in the Data Sources panel — never
a silent fallback, never `LIVE` for data that didn't arrive. A generation
counter discards a slow response that resolves after the user has already
switched locations, so a stale fetch can never land on the wrong scenario.

**Verified, not just asserted:** with the harness's `fetch` stubbed to
always reject (no real network reaches this sandbox), the full fallback
path was exercised end-to-end — failure correctly reports `cached` with a
real reason string, never mutates env or ignitions away from the tuned
scenario, and the tuned scenario's own verified behavior (all roads SAFE at
t=0, Canyon Road reaches BLOCKED by t=100) survives a failed fetch attempt
untouched. `gridToLatLon`/`latLonToGrid` round-trip to within one cell and
reject points far outside the grid's real footprint. 6 new tests (56 → 62).

**Known limitation — the one thing that could NOT be verified here:**
whether the actual Open-Meteo and NASA FIRMS HTTP calls succeed against the
real APIs. This sandbox has no network access at all, so the endpoint URLs,
response shapes, and CORS behavior are implemented from best available
knowledge of both APIs but were never executed against them. Open-Meteo's
CORS support is documented and stable; NASA FIRMS's is less certain — if it
throws a generic "Failed to fetch" in a real browser, that is almost always
a CORS rejection, not a bad key, and the panel will show that raw error
message rather than a guess. **Test this in a real browser with real
network before relying on it**, and report back the exact error text if
either call fails so the endpoint/parsing can be corrected.

## Pass 3 — map UI polish

**Fixed**
- Map canvases rendered at half (or worse) resolution on HiDPI/retina
  displays and were then blurred by the browser's own upscaling.
  `canvas.width/height` now scale with `devicePixelRatio`, with the drawing
  context scaled back down so existing CSS-pixel draw code is unchanged.
- Terrain was a flat per-cell fill with no relief. Added a real hillshade
  (finite-difference slope + Lambertian light, 9× vertical exaggeration
  tuned against this world generator's gentle gradients) and elevation
  contour lines (marching squares, no organic warp — this is geography, not
  fire). Landcover colors desaturated ~30% so state layers (fire, roads,
  route) read as the thing to look at.
- Roads and the evacuation route had no casing: a light-grey SAFE road over
  dark terrain, or any road over the burn scar, lost almost all contrast.
  Added a dark stroke under every road and under the route line before
  their status/route color.
- Map labels (community names, safe-zone marker) used plain `fillText` with
  no outline and were unreadable over anything colorful. Added a
  `strokeText` halo directly behind every `fillText`.
- The timeline's `aria-valuemax="30"` and its minute tick labels
  ("00:00"..."30:00") were hardcoded and had silently gone stale when the
  simulation horizon was retuned to 100 minutes in Pass 2 — nobody had
  caught it. Both are now generated from `MAX_TL_MINUTES` at startup.
- Added timeline event markers: every feed event now drops a colored tick
  on the timeline track at the minute it occurred; clicking one scrubs to
  that moment.

**Test infrastructure**
- The harness's fake DOM had a `setAttribute` that was a pure no-op and an
  `innerHTML` that didn't clear `.children` on assignment — so anything
  reading back an attribute it had just set, or expecting a container to
  actually empty when cleared, silently passed against a lie. Both are now
  real (attribute store; `innerHTML=''` clears children).
- The fake 2D canvas context now *records* calls to `stroke`, `fillText`,
  `strokeText`, `fillRect`, `drawImage` with a global call-order sequence
  number, so tests can assert on real rendering decisions (casing-before-
  status-color, halo-immediately-behind-fill) instead of trusting that the
  source matches what runs.
- 10 new behavioural checks (46 → 56) covering the timeline UI and the
  rendering changes above.

**Verified, not just asserted:** hillshade contrast (range 0.15–0.99 vs a
flat ~0.74 before exaggeration was tuned); every road/route gets exactly
one casing stroke before its colored stroke; every label's halo is adjacent
in the draw-call sequence; `drawTerrain()` (only called on resize/reset/
scrub, not per frame) completes in well under 400ms; scrubbing to the same
minute twice, or away and back, does not change the event/marker count.

**Known limitation, unchanged from Pass 2:** no real browser was available
(Playwright installed, no cached binaries, no network). Everything above
was verified through the recording-stub harness or static inspection, not
actual pixels in an actual browser.

## Pass 2 — simulation/demo architecture, routing, rendering

Full detail in the session's own report; summarized here for continuity.

**Fixed**
- The road graph only joined the first and last vertex of each polyline, so
  roads meeting at an interior vertex weren't actually connected. Summit
  View and Pine Hollow had **no evacuation route at all with zero fire on
  the map**. Rebuilt as one graph edge per polyline segment.
- Ignitions `[[24,26],[54,46]]` sat inside the road network's threat
  radius — the scenario opened already at the impact stage. Retuned to a
  single ignition at `[6,6]` after testing 7 candidates; all corridors
  SAFE at t=0.
- `TICK_MS=260` / `MAX_TL_MINUTES=30` meant the whole simulation completed
  in ~4 real seconds, while the guided demo's `setTimeout` calls fired at
  16s/34s/70s into an already-frozen world. Retuned to `TICK_MS=700` /
  `MAX_TL_MINUTES=100` (~70s guided run at 1×).
- The guided demo was rewritten from wall-clock `setTimeout`s to a
  simulation-time script consumed from `stepSimulation()`, backed by a new
  intervention ledger (every wind shift / spotting change / firebreak is
  recorded against the simulated minute it applies). Pause/speed/scrub/
  reset became correct by construction.
- Fire rendering was per-cell `fillRect` (visibly a grid of squares).
  Rebuilt as a resampled, fBm-warped, temporally-eased sub-cell field with
  separate burn-scar/body/active-front layers and discrete spot-fire
  glyphs, with the field+contours cached at 30Hz and restricted to the
  fire's bounding box.
- `resetScenario()` never reseeded the PRNG, so repeated runs diverged.
- An isolated community re-announced ISOLATED on every subsequent tick
  forever (a `''` vs `'NONE'` route-key comparison bug).
- Scrubbing rebuilt the world from scratch and silently destroyed every
  firebreak; fixed by replaying the intervention ledger during scrub.
- Route rendering drew each road's entire polyline instead of just the
  segments Dijkstra actually returned.
- The fire-field rasteriser initially cost ~42ms/frame (a closure allocated
  per sub-cell sample, an `[r,g,b]` array per pixel, a case-table object
  rebuilt per marching-squares cell). Reduced to ~1.7ms/frame by removing
  all three allocations (LUT-based palette, closure-free bilinear sampling,
  hoisted case table).

**Test infrastructure:** built `tools/headless-harness.js` (Node `vm` +
stubbed DOM, running the actual `apps/web/index.html` code) and
`packages/simulation/behaviour.test.js` (46 checks).

## Pass 1 — initial handoff investigation (not preserved in any ZIP)

An earlier session investigated the project via a similar headless
harness and found the road-graph and timing bugs described above, and
began a fix, but ran out of budget before the working copy was captured
into a ZIP. Pass 2 rediscovered and independently re-verified everything
from that investigation, since the only artifact that survived was the
prose handoff, not the code.

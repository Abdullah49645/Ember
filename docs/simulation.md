# Simulation model

## Grid

72×72 cells. Each cell carries:

- `elevation` — Float32, generated from layered value noise plus a ridge
  feature, normalized roughly to `[0, 1.4]`.
- `landClass` — one of `water, urban, cropland, grass, shrub, forest, bare`.
- `fuel` — Float32 in `[0, 1]`, looked up from `landClass`:

  | class | fuel |
  |---|---|
  | forest | 1.00 |
  | shrub | 0.85 |
  | grass | 0.70 |
  | cropland | 0.45 |
  | bare | 0.10 |
  | urban | 0.05 |
  | water | 0.00 |

- `state` — `UNBURNED (0) / ACTIVE (1) / BURNED (2)`.
- `intensity` — Float32 in `[0, 1]`, grows while active, drives color/glow
  and the road-threat proximity check's implicit weighting (more intense
  cells are, on average, closer to the leading edge of the fire).
- `arrival` — simulation tick the cell ignited, `-1` if never.
- `isSpot` — whether this ignition originated from ember-spotting rather
  than contiguous spread.
- `intervention` — multiplier applied to incoming spread probability;
  `1` normally, `≈0.03` inside a user-drawn firebreak.

## Propagation step

Once per simulated minute, for every active cell and each of its 8
neighbors:

```
spread_score =
    base_rate            (0.022)
  × fuel_factor            (neighbor's fuel value directly)
  × wind_factor              (downwind > crosswind > upwind; see below)
  × slope_factor              (upslope favored)
  × dryness_factor              (from humidity)
  × temperature_factor            (secondary, capped 0.82–1.35)
  × intervention_factor              (firebreak ≈ 0.03)
  × spread_multiplier                  (user control, 0.5×–2×)

probability = 1 - exp(-spread_score)
```

Using `1 - exp(-score)` instead of the raw score keeps the value a proper
probability in `[0, 1)` regardless of how many multipliers stack up, rather
than needing an ad hoc clamp.

### Wind

`env.windDir` follows the meteorological convention: the compass bearing
the wind blows **from** (e.g. `315` = "out of the NW"). The fire actually
travels toward the opposite bearing (`windTravelBearing = (windDir + 180) %
360`). For a candidate neighbor at grid offset `(dx, dy)`, its bearing from
the burning cell is compared to the travel bearing; perfectly aligned
(downwind) neighbors get up to a `~3.2×` multiplier at high wind speed,
directly upwind neighbors are suppressed to `~0.12×`. This is the one
subtlety worth flagging explicitly: it is easy to wire the sign backwards
and have "wind out of the NW" visually push fire *toward* the NW instead of
*away from it toward the SE* — `packages/simulation/engine.test.js` pins
this down with an explicit downwind-vs-upwind assertion so a future edit
can't silently invert it again.

### Slope

`slope_factor` is driven by `elevation[neighbor] - elevation[current]`:
positive (uphill) increases spread likelihood up to `2.1×`; negative
(downhill) suppresses it down to `0.22×`.

### Spot fires

Any active cell with `intensity > 0.55` has a per-tick chance, scaled by
the user's spot-probability slider, current intensity, and wind speed, of
igniting a new cell 4–13 grid cells downwind (with angular jitter so
spotting isn't a perfectly straight line). A spotted cell only ignites if
its fuel exceeds `0.28` and a secondary fuel-weighted coin flip passes.
Spot ignitions are flagged (`isSpot`) and rendered distinctly (small amber
markers rather than blended into the main glow), and they count as
independent fire fronts in the connected-component front count — this is
what produces genuinely non-contiguous fire behavior rather than one
expanding blob.

### Burn-out

Each land-cover class has a burn duration (grass ~9 ticks, forest ~38); once
a cell's age since ignition exceeds that, it transitions to `BURNED` and
stops contributing to further spread, matching the spec's requirement that
fronts eventually exhaust rather than burn forever.

### Perimeter extraction

The renderer does not draw a polygon fire perimeter directly from geometry,
and it does not contour the raw binary cell mask either — doing that yields
an axis-aligned staircase that reads as a grid of squares.

Instead the cell state is first resampled into a continuous scalar field at
3× sub-cell resolution with smoothstep-weighted bilinear interpolation, and
the sample coordinates are displaced by a static fBm warp (fixed per seed,
magnitude well under one cell). Marching squares then runs over *that*
field, so the resulting contour is a smooth irregular curve that still hugs
the true burnt cells. The same machinery produces a second contour at a
different threshold over a "recently ignited" field, which is what draws the
advancing front as distinct from the overall perimeter.

The field, both contours and the rasterised fire body are cached and
rebuilt at 30Hz over the fire's bounding box only; frames in between simply
blit and stroke the cached results.

### Simulation clock

One tick is one simulated minute. `TICK_MS = 700` and `MAX_TL_MINUTES = 100`
are tuned together: a guided run occupies ~70 seconds at 1×, ~35s at 2×,
~18s at 4×. Rendering is decoupled from ticking, so a 700ms tick does not
make the animation choppy.

These two constants matter more than they look. An earlier build used
`TICK_MS = 260` with a 30-minute horizon, which completed the entire
simulation in under four real seconds — before any guided-demo event could
fire.

## Road threat model

For each road, sample points are placed every ~1.2 grid units along its
polyline. Each tick, every sampled point's distance to the nearest active
fire cell is measured (brute-force over the active-cell list, which stays
small enough — low hundreds of cells at most — for this to be cheap); the
minimum across all of a road's sample points determines its status:

| status | condition |
|---|---|
| `SAFE` | min distance > 13 cells |
| `WATCH` | 8–13 cells |
| `THREATENED` | 3.2–8 cells, ETA shown |
| `BLOCKED` | ≤ 3.2 cells, or manually closed |

ETA is `(minDist - blockedThreshold) / perimeterGrowthRate`, where
`perimeterGrowthRate` is a rolling estimate of how fast the fire's active
cell count is growing, updated each tick — so ETA tightens as the fire
actually accelerates rather than being a fixed constant.

## Determinism

`mulberry32(seed)` drives both terrain generation and all stochastic
ignition/spotting decisions. The same seed reproduces the same scenario
exactly — verified in `engine.test.js`. "Randomize Seed" in the UI draws a
fresh seed (which, since terrain generation also depends on the seed,
regenerates the whole scenario — an intentional choice so "randomize" gives
a genuinely different demo rather than only reshuffling stochastic noise on
identical terrain).

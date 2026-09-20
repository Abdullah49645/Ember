// packages/simulation/engine.js
//
// Pure, dependency-free implementations of Ember's core numerical model:
// wind/slope/fuel spread factors, the cellular propagation step, spot-fire
// spotting, road-threat classification, and Dijkstra-based rerouting.
//
// This file mirrors the logic embedded in apps/web/index.html so the model
// can be unit-tested with plain `node`, without a browser. If the two ever
// drift, this file is the source of truth for the numerical model; the
// embedded copy in the single-page app exists so the demo stays a single
// portable HTML file.

'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function deg2rad(d) { return (d * Math.PI) / 180; }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Meteorological convention: windDir is the bearing wind blows FROM. */
function windTravelBearing(windDir) { return (windDir + 180) % 360; }

/**
 * Directional wind alignment factor for spread from a cell toward a
 * neighbor offset (dx, dy) in grid space (y grows downward).
 * Returns >1 downwind, ~1 crosswind, <1 upwind.
 */
function windFactor(dx, dy, windDir, windSpeed) {
  const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  let diff = Math.abs(bearing - windTravelBearing(windDir));
  if (diff > 180) diff = 360 - diff;
  const align = Math.cos(deg2rad(diff));
  const spdTerm = windSpeed / 80;
  return clamp(1 + align * spdTerm * 1.7, 0.12, 3.2);
}

/** Upslope spread is favored; downslope is suppressed. slopeDelta = elev(neighbor)-elev(current). */
function slopeFactor(slopeDelta) {
  return clamp(1 + clamp(slopeDelta / 0.22, -1, 1) * 0.85, 0.22, 2.1);
}

/** Lower humidity -> higher dryness -> higher spread. */
function drynessFactor(humidityPct) {
  return clamp(1 + (50 - humidityPct) / 50 * 0.9, 0.28, 1.9);
}

/** Mild secondary multiplier; must never dominate the model. */
function temperatureFactor(tempC) {
  return clamp(1 + (tempC - 20) / 110, 0.82, 1.35);
}

/**
 * Probability an active cell ignites a given unburned neighbor this tick.
 * Every factor is independently inspectable, per the spec's requirement
 * that the equation not be a single unreadable blob.
 */
function spreadProbability({ dx, dy, fuel, slopeDelta, windDir, windSpeed, humidity, temperature, intervention, spreadMultiplier, baseRate }) {
  const score = (baseRate ?? 0.022)
    * fuel
    * windFactor(dx, dy, windDir, windSpeed)
    * slopeFactor(slopeDelta)
    * drynessFactor(humidity)
    * temperatureFactor(temperature)
    * (intervention ?? 1)
    * (spreadMultiplier ?? 1);
  return 1 - Math.exp(-score);
}

/** Downwind spot-ignition candidate cell (grid coords), or null if out of bounds. */
function spotTarget(i, j, windDir, jitterDeg, distanceCells, gridSize) {
  const bearing = deg2rad(windTravelBearing(windDir) + jitterDeg);
  const tx = Math.round(i + Math.sin(bearing) * distanceCells);
  const ty = Math.round(j - Math.cos(bearing) * distanceCells);
  if (tx < 0 || ty < 0 || tx >= gridSize || ty >= gridSize) return null;
  return [tx, ty];
}

const ROAD_THRESHOLDS = { blocked: 3.2, threatened: 8, watch: 13 };

function classifyRoad(minDistCells, manualClosed) {
  if (manualClosed) return 'BLOCKED';
  if (minDistCells <= ROAD_THRESHOLDS.blocked) return 'BLOCKED';
  if (minDistCells <= ROAD_THRESHOLDS.threatened) return 'THREATENED';
  if (minDistCells <= ROAD_THRESHOLDS.watch) return 'WATCH';
  return 'SAFE';
}

function edgeCost(lengthUnits, status) {
  const penalty = status === 'BLOCKED' ? Infinity
    : status === 'THREATENED' ? 5.2
    : status === 'WATCH' ? 0.7
    : 0;
  return lengthUnits * (1 + penalty);
}

/**
 * Minimal Dijkstra over an adjacency map: Map<nodeKey, Array<{to, edgeId, length, status}>>
 * Returns { path: [edgeId...], cost } or null if unreachable.
 */
function dijkstra(adjacency, startKey, endKey) {
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  for (const k of adjacency.keys()) dist.set(k, Infinity);
  dist.set(startKey, 0);
  const pq = [[0, startKey]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, u] = pq.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === endKey) break;
    for (const { to, edgeId, length, status } of adjacency.get(u) || []) {
      const c = edgeCost(length, status);
      if (!isFinite(c)) continue;
      const nd = d + c;
      if (nd < dist.get(to)) {
        dist.set(to, nd);
        prev.set(to, { from: u, edgeId });
        pq.push([nd, to]);
      }
    }
  }
  if (!isFinite(dist.get(endKey))) return null;
  const path = [];
  let cur = endKey;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (!p) return null;
    path.push(p.edgeId);
    cur = p.from;
  }
  path.reverse();
  return { path, cost: dist.get(endKey) };
}

/**
 * Normalize a raw environmental-state-like object into the shape the
 * simulation engine expects, filling safe defaults for missing fields
 * instead of throwing. Mirrors the DataSource -> Normalizer -> EnvironmentalState
 * pipeline described in the architecture doc.
 */
function normalizeEnvironmentalState(raw) {
  raw = raw || {};
  const weather = raw.weather || {};
  return {
    windDir: typeof weather.windDir === 'number' ? weather.windDir : 315,
    windSpeed: typeof weather.windSpeed === 'number' ? weather.windSpeed : 20,
    humidity: typeof weather.humidity === 'number' ? clamp(weather.humidity, 0, 100) : 40,
    temperature: typeof weather.temperature === 'number' ? weather.temperature : 25,
    fires: Array.isArray(raw.fires) ? raw.fires : [],
    roads: Array.isArray(raw.roads) ? raw.roads : [],
    communities: Array.isArray(raw.communities) ? raw.communities : [],
  };
}

module.exports = {
  clamp, deg2rad, mulberry32, windTravelBearing, windFactor, slopeFactor,
  drynessFactor, temperatureFactor, spreadProbability, spotTarget,
  ROAD_THRESHOLDS, classifyRoad, edgeCost, dijkstra, normalizeEnvironmentalState,
};

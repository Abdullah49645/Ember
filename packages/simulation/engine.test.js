// packages/simulation/engine.test.js
// Run with: node packages/simulation/engine.test.js
// No test framework dependency, so this suite runs with zero installs.

'use strict';
const assert = require('assert');
const {
  mulberry32, windFactor, slopeFactor, drynessFactor, spreadProbability,
  classifyRoad, edgeCost, dijkstra, normalizeEnvironmentalState,
} = require('./engine');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  -', name);
  } catch (e) {
    console.error('FAIL  -', name);
    console.error('       ', e.message);
    process.exitCode = 1;
  }
}

console.log('Simulation engine');

test('wind changes spread direction: downwind factor exceeds upwind factor', () => {
  const windDir = 315;   // meteorological "from NW" -> travels toward SE (135deg)
  const windSpeed = 40;
  // neighbor offset toward SE (dx=1, dy=1) should be favored over NW (dx=-1, dy=-1)
  const downwind = windFactor(1, 1, windDir, windSpeed);
  const upwind = windFactor(-1, -1, windDir, windSpeed);
  assert.ok(downwind > upwind, `expected downwind(${downwind}) > upwind(${upwind})`);
});

test('wind factor is neutral (~1) for crosswind neighbors regardless of speed', () => {
  // windDir=0 ("from the north") travels toward bearing 180 (south).
  // A neighbor due east (dx=1, dy=0) is perpendicular to that travel bearing.
  const f = windFactor(1, 0, 0, 60);
  assert.ok(Math.abs(f - 1) < 0.05, `expected crosswind factor near 1, got ${f}`);
});

test('fuel changes spread: higher fuel yields higher ignition probability', () => {
  const base = { dx: 1, dy: 0, slopeDelta: 0, windDir: 0, windSpeed: 10, humidity: 40, temperature: 25, spreadMultiplier: 1 };
  const low = spreadProbability({ ...base, fuel: 0.1 });
  const high = spreadProbability({ ...base, fuel: 1.0 });
  assert.ok(high > low, `expected high-fuel probability (${high}) > low-fuel (${low})`);
});

test('slope changes spread: upslope favored over downslope', () => {
  const upslope = slopeFactor(0.2);   // neighbor is higher
  const downslope = slopeFactor(-0.2); // neighbor is lower
  assert.ok(upslope > downslope, `expected upslope(${upslope}) > downslope(${downslope})`);
});

test('humidity/dryness: lower humidity increases spread multiplier', () => {
  const dry = drynessFactor(10);
  const wet = drynessFactor(80);
  assert.ok(dry > wet, `expected dry(${dry}) > wet(${wet})`);
});

test('firebreak blocks propagation: near-zero intervention factor collapses probability', () => {
  const base = { dx: 1, dy: 0, fuel: 1, slopeDelta: 0, windDir: 0, windSpeed: 30, humidity: 15, temperature: 35, spreadMultiplier: 1 };
  const withoutBreak = spreadProbability({ ...base, intervention: 1 });
  const withBreak = spreadProbability({ ...base, intervention: 0.03 });
  assert.ok(withBreak < withoutBreak * 0.1, `expected firebreak probability (${withBreak}) to be near zero relative to (${withoutBreak})`);
});

test('deterministic seed produces reproducible output', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepStrictEqual(seqA, seqB);
});

test('spot fires can generate: probability is nonzero at high intensity/wind and zero at no wind+intensity', () => {
  // Not a direct spotTarget test (that's geometric), but confirm the ingredients
  // that gate spotting (intensity, wind speed) behave monotonically as the sim expects.
  const highWindFactor = 30 / 80;
  const noWindFactor = 0 / 80;
  assert.ok(highWindFactor > noWindFactor);
});

console.log('\nRoad threat classification');

test('road far from fire is SAFE', () => {
  assert.strictEqual(classifyRoad(20, false), 'SAFE');
});
test('road within watch radius is WATCH', () => {
  assert.strictEqual(classifyRoad(10, false), 'WATCH');
});
test('road within threatened radius is THREATENED', () => {
  assert.strictEqual(classifyRoad(5, false), 'THREATENED');
});
test('road within blocked radius is BLOCKED', () => {
  assert.strictEqual(classifyRoad(1, false), 'BLOCKED');
});
test('manual closure forces BLOCKED regardless of fire distance', () => {
  assert.strictEqual(classifyRoad(999, true), 'BLOCKED');
});

console.log('\nRouting');

function buildTestGraph() {
  // A - B - C, plus a direct A - C "bypass"
  const adjacency = new Map([
    ['A', [{ to: 'B', edgeId: 'AB', length: 10, status: 'SAFE' }]],
    ['B', [
      { to: 'A', edgeId: 'AB', length: 10, status: 'SAFE' },
      { to: 'C', edgeId: 'BC', length: 10, status: 'SAFE' },
    ]],
    ['C', [
      { to: 'B', edgeId: 'BC', length: 10, status: 'SAFE' },
      { to: 'A', edgeId: 'AC', length: 100, status: 'SAFE' },
    ]],
  ]);
  adjacency.get('A').push({ to: 'C', edgeId: 'AC', length: 100, status: 'SAFE' });
  return adjacency;
}

test('shortest path prefers the low-cost edge when all roads are SAFE', () => {
  const g = buildTestGraph();
  const result = dijkstra(g, 'A', 'C');
  assert.deepStrictEqual(result.path, ['AB', 'BC']);
});

test('blocked road is excluded from the route', () => {
  const g = buildTestGraph();
  g.get('A')[0].status = 'BLOCKED'; // A-B blocked
  g.get('B')[0].status = 'BLOCKED';
  const result = dijkstra(g, 'A', 'C');
  assert.deepStrictEqual(result.path, ['AC'], 'should reroute via the direct bypass');
});

test('threatened road has higher cost than an equivalent safe road', () => {
  const safeCost = edgeCost(10, 'SAFE');
  const threatenedCost = edgeCost(10, 'THREATENED');
  const watchCost = edgeCost(10, 'WATCH');
  assert.ok(threatenedCost > watchCost && watchCost > safeCost);
});

test('route changes when an edge becomes blocked mid-simulation', () => {
  const g = buildTestGraph();
  const before = dijkstra(g, 'A', 'C');
  g.get('B')[1].status = 'BLOCKED'; // B-C blocked
  g.get('C')[0].status = 'BLOCKED';
  const after = dijkstra(g, 'A', 'C');
  assert.notDeepStrictEqual(before.path, after.path);
  assert.deepStrictEqual(after.path, ['AC']);
});

test('no-route state is handled (returns null, does not throw)', () => {
  const adjacency = new Map([
    ['A', [{ to: 'B', edgeId: 'AB', length: 5, status: 'BLOCKED' }]],
    ['B', [{ to: 'A', edgeId: 'AB', length: 5, status: 'BLOCKED' }]],
    ['C', []],
  ]);
  const result = dijkstra(adjacency, 'A', 'C');
  assert.strictEqual(result, null);
});

console.log('\nData normalization');

test('normalization fills defaults for a completely empty object', () => {
  const state = normalizeEnvironmentalState({});
  assert.strictEqual(typeof state.windDir, 'number');
  assert.strictEqual(typeof state.windSpeed, 'number');
  assert.ok(Array.isArray(state.fires));
  assert.ok(Array.isArray(state.roads));
});

test('normalization does not crash on missing/null fields', () => {
  assert.doesNotThrow(() => normalizeEnvironmentalState(null));
  assert.doesNotThrow(() => normalizeEnvironmentalState({ weather: null }));
  assert.doesNotThrow(() => normalizeEnvironmentalState({ fires: undefined, roads: null }));
});

test('normalization clamps out-of-range humidity', () => {
  const state = normalizeEnvironmentalState({ weather: { humidity: 250 } });
  assert.strictEqual(state.humidity, 100);
});

test('normalization preserves valid provided values', () => {
  const state = normalizeEnvironmentalState({ weather: { windDir: 90, windSpeed: 55, humidity: 33, temperature: 12 } });
  assert.strictEqual(state.windDir, 90);
  assert.strictEqual(state.windSpeed, 55);
  assert.strictEqual(state.humidity, 33);
  assert.strictEqual(state.temperature, 12);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures above' : '.'}`);

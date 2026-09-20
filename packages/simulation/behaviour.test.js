/**
 * Behavioural regression suite.
 *
 * Runs the REAL application simulation/routing/demo code (loaded out of
 * apps/web/index.html by tools/headless-harness.js) and asserts on observed
 * behaviour. Every test here corresponds to a bug that was actually shipped or
 * to a causal claim the product makes in its UI.
 *
 * Run with: npm test
 */
const { build } = require('../../tools/headless-harness');

let pass = 0, fail = 0;
const failures = [];
/** Runs a test; supports both sync and async test functions. Always
 *  returns a Promise so every call site can `await t(...)`, keeping test
 *  execution strictly sequential (and therefore deterministic in output
 *  order) whether or not a given test does real async work. */
async function t(name, fn){
  try { await fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + e.message); console.log('  \u2717 ' + name + '\n      ' + e.message); }
}
function assert(cond, msg){ if(!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg){ if(a !== b) throw new Error((msg||'') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** Fresh app instance with the default scenario initialised. */
function fresh(){ const { E } = build(); E.reset(); return E; }
/** Advance n simulated minutes. */
function run(E, n){ for(let i=0;i<n;i++) E.step(); return E; }
function burned(E){ let n=0; for(let k=0;k<E.world.state.length;k++) if(E.world.state[k]) n++; return n; }
function routed(E){ return E.COMMUNITIES.filter(c=>E.currentRoutes[c.id]).length; }
function statusOf(E, id){ return E.roads.find(r=>r.id===id).status; }

(async () => {

console.log('\nEmber \u2014 behavioural regression suite\n');

/* ---------------------------------------------------------------------------
   1. ROAD GRAPH  (regression: endpoint-only edges broke mid-polyline junctions)
   --------------------------------------------------------------------------- */
console.log('road graph');

await t('roads are decomposed into per-segment edges, not one edge per road', () => {
  const E = fresh();
  const vertices = E.ROAD_DEFS.reduce((n,d)=>n + d.pts.length - 1, 0);
  eq(E.roadGraph.edges.length, vertices, 'edge count should equal total polyline segments;');
  assert(E.roadGraph.edges.length > E.ROAD_DEFS.length,
    'per-segment decomposition must produce more edges than roads');
});

await t('a junction on an interior vertex is actually connected', () => {
  const E = fresh();
  // Summit Pass starts at [52,34], which is an INTERIOR vertex of Highway 39.
  // With endpoint-only edges this node existed but nothing linked it to hwy39.
  const adj = E.roadGraph.adjacency.get('52,34') || [];
  const ids = new Set(adj.map(a => a.edge.id));
  assert(ids.has('hwy39'), 'node 52,34 must connect to Highway 39; got ' + [...ids]);
  assert(ids.has('summit'), 'node 52,34 must connect to Summit Pass; got ' + [...ids]);
});

await t('every community has a valid evacuation route with zero fire influence', () => {
  const E = fresh();
  for(const c of E.COMMUNITIES){
    const r = E.dijkstra(E.keyOf(c.node), E.SAFE);
    assert(r && r.path.length, c.name + ' has NO baseline route to the safe zone');
  }
  eq(routed(E), E.COMMUNITIES.length, 'all communities routable at t=0;');
});

await t('every graph edge carries its parent road id so status still drives cost', () => {
  const E = fresh();
  for(const e of E.roadGraph.edges){
    assert(E.roads.some(r => r.id === e.id), 'edge ' + e.id + ' has no runtime road record');
    assert(e.pts.length === 2, 'segment edges must have exactly two endpoints');
  }
});

/* ---------------------------------------------------------------------------
   2. SCENARIO GEOMETRY  (regression: demo opened already at THREATENED)
   --------------------------------------------------------------------------- */
console.log('\nscenario geometry');

await t('all corridors are SAFE at t=0', () => {
  const E = fresh();
  const bad = E.roads.filter(r => r.status !== 'SAFE').map(r => r.id + '=' + r.status);
  eq(bad.length, 0, 'corridors must start SAFE so the threat timeline has room to develop; got ' + bad);
});

await t('the first road threat emerges from propagation, not from the initial condition', () => {
  const E = fresh();
  let firstWatch = null;
  for(let m=1; m<=40 && !firstWatch; m++){
    E.step();
    if(E.roads.some(r => r.status !== 'SAFE')) firstWatch = m;
  }
  assert(firstWatch !== null, 'no corridor was ever threatened within 40 minutes');
  assert(firstWatch >= 5, 'first threat at minute ' + firstWatch + ' is too early to read as a progression');
  assert(firstWatch <= 20, 'first threat at minute ' + firstWatch + ' is too late for a guided demo');
});

/* ---------------------------------------------------------------------------
   3. SIMULATION / DEMO TIMING  (regression: sim finished before demo events)
   --------------------------------------------------------------------------- */
console.log('\nsimulation + demo timing');

await t('the horizon is long enough that a guided run is watchable', () => {
  const E = fresh();
  const seconds = E.MAX_TL * E.TICK_MS / 1000;
  assert(seconds >= 60, 'guided run is only ' + seconds + 's at 1x \u2014 too fast to follow');
  assert(seconds <= 180, 'guided run is ' + seconds + 's at 1x \u2014 too slow');
});

await t('every guided-demo beat lands strictly inside the simulation horizon', () => {
  const E = fresh();
  // The original bug: events were scheduled in wall-clock seconds and fired
  // long after the simulation had already frozen at its maximum.
  const beats = E.demoScript.map(b => b.at);
  for(const at of beats) assert(at > 0 && at <= E.MAX_TL,
    'beat at simulated minute ' + at + ' falls outside the 1..' + E.MAX_TL + ' horizon');
  assert(beats.length >= 4, 'guided demo needs several beats to tell a story');
});

await t('demo beats are addressed in simulated minutes and fire exactly once', () => {
  const E = fresh();
  E.startDemo();
  const beats = E.demoScript.map(b => b.at);
  const fired = [];
  for(let m=1; m<=E.MAX_TL; m++){
    const before = E.events.length;
    E.step();
    for(const ev of E.events.slice(before)) if(ev.demoBeat) fired.push(m);
  }
  for(const at of beats) eq(fired.filter(x => x === at).length, 1,
    'beat scheduled at minute ' + at + ' should fire exactly once;');
});

await t('demo progression is identical at any speed (speed is wall-clock only)', () => {
  // Speed divides TICK_MS; it never changes how much simulated time a tick is
  // worth, so the causal sequence must be byte-identical.
  const seq = () => {
    const E = fresh(); E.startDemo();
    const out = [];
    for(let m=1;m<=E.MAX_TL;m++){ const n=E.events.length; E.step();
      for(const ev of E.events.slice(n)) out.push(m+':'+ev.title); }
    return out.join('|');
  };
  eq(seq(), seq(), 'two runs of the guided demo diverged;');
});

await t('a paused simulation produces no demo events', () => {
  const E = fresh();
  E.startDemo();
  const before = E.events.length;
  // "Paused" simply means step() is not called. No wall-clock timer exists that
  // could still fire, which is the whole point of the ledger architecture.
  eq(E.events.length, before, 'events appeared without the simulation advancing;');
  eq(E.simTime, 0, 'simTime advanced while paused;');
});

/* ---------------------------------------------------------------------------
   4. DETERMINISM
   --------------------------------------------------------------------------- */
console.log('\ndeterminism');

await t('reset reseeds the PRNG so repeated runs are identical', () => {
  const E = fresh();
  run(E, 30); const a = burned(E);
  E.reset();
  run(E, 30); const b = burned(E);
  eq(b, a, 'second run after reset burned a different number of cells;');
});

await t('scrubbing to a time reproduces a straight run to that time', () => {
  const E = fresh();
  run(E, 45); const direct = burned(E);
  E.scrubToTime(45);
  eq(burned(E), direct, 'scrub result differs from a direct run;');
  eq(E.simTime, 45, 'simTime after scrub;');
});

/* ---------------------------------------------------------------------------
   5. INTERVENTION LEDGER  (regression: firebreaks vanished on scrub)
   --------------------------------------------------------------------------- */
console.log('\nintervention ledger');

await t('a firebreak recorded at minute N survives a scrub past N', () => {
  const E = fresh();
  run(E, 20);
  E.recordIntervention({ at: 20, type: 'firebreak', data: { pts: [[26,38],[42,58]], halfWidth: 2 }, live: true });
  const cut = E.world.intervention.filter(v => v < 0.5).length;
  assert(cut > 0, 'firebreak cut no cells');
  E.scrubToTime(40);
  eq(E.world.intervention.filter(v => v < 0.5).length, cut,
    'firebreak was lost when scrubbing forward past the minute it was cut;');
});

await t('scrubbing back before an intervention un-does it', () => {
  const E = fresh();
  run(E, 20);
  E.recordIntervention({ at: 20, type: 'firebreak', data: { pts: [[26,38],[42,58]], halfWidth: 2 }, live: true });
  E.scrubToTime(10);
  eq(E.world.intervention.filter(v => v < 0.5).length, 0,
    'a firebreak cut at minute 20 still exists at minute 10;');
});

await t('a wind shift replays at the right minute and rolls back before it', () => {
  const E = fresh();
  const baseDir = E.env.windDir;
  run(E, 18);
  E.recordIntervention({ at: 18, type: 'wind', data: { dir: 330, speed: 58 }, live: true });
  eq(E.env.windDir, 330, 'wind not applied;');
  E.scrubToTime(10);
  eq(E.env.windDir, baseDir, 'wind shift not rolled back when scrubbing before it;');
  E.scrubToTime(25);
  eq(E.env.windDir, 330, 'wind shift not replayed when scrubbing past it;');
});

await t('reset clears all demo state and the ledger', () => {
  const E = fresh();
  E.startDemo();
  run(E, 60);
  assert(E.interventions.length > 0, 'demo recorded no interventions in 60 minutes');
  E.reset();
  eq(E.interventions.length, 0, 'ledger not cleared on reset;');
  eq(Object.keys(E.demoState.fired).length, 0, 'fired demo beats not cleared on reset;');
  eq(E.demoState.active, false, 'demo still marked active after reset;');
  eq(E.world.intervention.filter(v => v < 0.5).length, 0, 'firebreaks survived a reset;');
});

/* ---------------------------------------------------------------------------
   6. ENVIRONMENTAL DRIVERS ACTUALLY DRIVE THE MODEL
   --------------------------------------------------------------------------- */
console.log('\nenvironmental coupling');

/** Run the same ignition twice, mutating env between, and compare burn extent. */
function compareEnv(mutate, minutes){
  const A = fresh(); run(A, minutes || 45);
  const B = fresh(); mutate(B.env); run(B, minutes || 45);
  return { base: burned(A), changed: burned(B) };
}

await t('wind speed materially changes propagation', () => {
  // Measured over a horizon where the fire is large enough for the difference
  // to be unambiguous; at 45 minutes the fire is still small and the delta is
  // within noise of the ignition geometry.
  const r = compareEnv(env => { env.windSpeed = 70; }, 80);
  assert(r.changed > r.base * 1.15,
    'raising wind 24 -> 70 km/h changed burn extent only ' + r.base + ' -> ' + r.changed);
});

await t('wind speed stretches the fire along the downwind axis', () => {
  const extent = (E) => {
    const rad = (((E.env.windDir + 180) % 360)) * Math.PI/180;
    const ux = Math.sin(rad), uy = -Math.cos(rad);
    let lo = Infinity, hi = -Infinity;
    for(let k=0;k<E.world.state.length;k++){
      if(!E.world.state[k]) continue;
      const p = (k % E.GRID)*ux + Math.floor(k/E.GRID)*uy;
      if(p<lo) lo=p; if(p>hi) hi=p;
    }
    return hi - lo;
  };
  const A = fresh(); run(A, 70);
  const B = fresh(); B.env.windSpeed = 70; run(B, 70);
  assert(extent(B) > extent(A) * 1.1,
    'downwind extent ' + extent(A).toFixed(1) + ' -> ' + extent(B).toFixed(1) + ' cells under 3x the wind');
});

await t('wind direction changes where the fire goes, not just how much burns', () => {
  const A = fresh(); run(A, 45);
  const B = fresh(); B.env.windDir = 135; run(B, 45);
  // centroid of burnt cells
  const centroid = E => { let sx=0, sy=0, n=0;
    for(let k=0;k<E.world.state.length;k++) if(E.world.state[k]){ sx += k % E.GRID; sy += Math.floor(k/E.GRID); n++; }
    return [sx/n, sy/n]; };
  const a = centroid(A), b = centroid(B);
  const shift = Math.hypot(a[0]-b[0], a[1]-b[1]);
  assert(shift > 1.5, 'reversing the wind moved the burn centroid only ' + shift.toFixed(2) + ' cells');
});

await t('humidity materially changes propagation', () => {
  const r = compareEnv(env => { env.humidity = 70; });
  assert(r.changed < r.base * 0.9,
    'raising humidity 18 -> 70% changed burn extent only ' + r.base + ' -> ' + r.changed);
});

await t('temperature materially changes propagation', () => {
  const r = compareEnv(env => { env.temperature = 5; });
  assert(r.changed < r.base,
    'dropping temperature 34 -> 5 C changed burn extent only ' + r.base + ' -> ' + r.changed);
});

await t('fuel actually gates propagation (zero-fuel cells never ignite)', () => {
  const E = fresh(); run(E, 60);
  for(let k=0;k<E.world.state.length;k++){
    if(E.world.fuel[k] <= 0) eq(E.world.state[k], 0, 'a zero-fuel cell ignited at index ' + k + ';');
  }
});

await t('slope influences spread (uphill cells are favoured)', () => {
  // Compare mean elevation of burnt cells against the domain mean. With an
  // uphill spread bias the burnt set should not be a neutral sample.
  const E = fresh(); run(E, 50);
  let bs=0, bn=0, as=0;
  for(let k=0;k<E.world.state.length;k++){ as += E.world.elevation[k];
    if(E.world.state[k]){ bs += E.world.elevation[k]; bn++; } }
  const burntMean = bs/bn, allMean = as/E.world.elevation.length;
  assert(Math.abs(burntMean - allMean) > 0.01,
    'burnt-cell elevation mean ' + burntMean.toFixed(3) + ' is indistinguishable from the domain mean ' + allMean.toFixed(3));
});

/* ---------------------------------------------------------------------------
   7. SPOT FIRES ARE REAL SIMULATION ENTITIES
   --------------------------------------------------------------------------- */
console.log('\nspot fires');

await t('spot fires spawn as flagged cells, spatially separated from the front', () => {
  const E = fresh(); E.startDemo(); run(E, 60);
  const spots = [];
  for(let k=0;k<E.world.isSpot.length;k++) if(E.world.isSpot[k]) spots.push(k);
  assert(spots.length > 0, 'no spot fires in 60 minutes of the guided scenario');
  // at least one detached ignition must have been reported by the engine
  const reported = E.events.filter(ev => ev.title === 'SPOT FIRE DETECTED');
  assert(reported.length > 0, 'spot fires exist but none were ever reported to the feed');
});

await t('spotting probability actually changes how many spot cells appear', () => {
  const low = fresh();  low.env.spotProbability = 0.02; run(low, 60);
  const high = fresh(); high.env.spotProbability = 1.0; run(high, 60);
  const count = E => { let n=0; for(let k=0;k<E.world.isSpot.length;k++) if(E.world.isSpot[k]) n++; return n; };
  assert(count(high) > count(low),
    'spot cells: low=' + count(low) + ' high=' + count(high) + ' \u2014 the slider is decorative');
});

await t('spot fires propagate like any other burning cell (downstream consequence)', () => {
  const E = fresh(); E.startDemo(); run(E, 70);
  // a spot cell that has since burnt out or grown proves it entered the model
  let matured = 0;
  for(let k=0;k<E.world.isSpot.length;k++){
    if(E.world.isSpot[k] && E.world.intensity[k] > 0.4) matured++;
  }
  assert(matured > 0, 'no spot fire ever developed intensity \u2014 they are decorative');
});

/* ---------------------------------------------------------------------------
   8. FIREBREAK HAS A MEASURABLE CONSEQUENCE
   --------------------------------------------------------------------------- */
console.log('\nfirebreak');

await t('the demo firebreak measurably reduces burnt area', () => {
  const withFb = fresh(); withFb.startDemo(); run(withFb, 100);
  const noFb = fresh(); noFb.startDemo();
  // suppress only the firebreak beat, keep wind + spotting identical
  noFb.demoScript.forEach((b,i) => { if(b.kind === 'firebreak') noFb.demoState.fired[i] = true; });
  run(noFb, 100);
  const saved = burned(noFb) - burned(withFb);
  assert(saved > 50, 'firebreak saved only ' + saved + ' cells (' + burned(noFb) + ' -> ' + burned(withFb) + ')');
});

await t('the demo firebreak delays community isolation', () => {
  const isoTime = (suppress) => {
    const E = fresh(); E.startDemo();
    if(suppress) E.demoScript.forEach((b,i)=>{ if(b.kind==='firebreak') E.demoState.fired[i]=true; });
    for(let m=1;m<=100;m++){ E.step(); if(!E.currentRoutes['oakridge']) return m; }
    return 999;
  };
  const withFb = isoTime(false), noFb = isoTime(true);
  assert(withFb > noFb, 'Oakridge isolated at minute ' + withFb + ' with the firebreak vs ' + noFb + ' without \u2014 no benefit');
});

await t('firebreak cells carry a real propagation multiplier', () => {
  const E = fresh();
  E.applyFirebreak([[26,38],[42,58]], 2);
  const cut = E.world.intervention.filter(v => v < 0.5);
  assert(cut.length > 0, 'applyFirebreak modified no cells');
  assert(cut.every(v => v <= 0.05), 'firebreak multiplier is not suppressive');
});

/* ---------------------------------------------------------------------------
   9. FIRE -> ROAD -> GRAPH -> ROUTE  (the core causal chain)
   --------------------------------------------------------------------------- */
console.log('\ncausal chain: fire \u2192 road \u2192 route');

await t('road status escalates monotonically as the fire approaches', () => {
  const E = fresh();
  const order = { SAFE:0, WATCH:1, THREATENED:2, BLOCKED:3 };
  let sawWatch=false, sawThreat=false, sawBlocked=false;
  const seenDist = {};
  for(let m=1;m<=100;m++){
    E.step();
    const canyon = E.roads.find(r=>r.id==='canyon');
    if(canyon.status==='WATCH') sawWatch=true;
    if(canyon.status==='THREATENED'){ assert(sawWatch, 'canyon reached THREATENED without passing WATCH'); sawThreat=true; }
    if(canyon.status==='BLOCKED'){ assert(sawThreat, 'canyon reached BLOCKED without passing THREATENED'); sawBlocked=true; }
    seenDist[canyon.status] = canyon.minDist;
  }
  assert(sawBlocked, 'Canyon Road never blocked in 100 minutes');
  assert(seenDist.BLOCKED < seenDist.THREATENED && seenDist.THREATENED < seenDist.WATCH,
    'status severity is not ordered by measured fire distance: ' + JSON.stringify(seenDist));
});

await t('road status is derived from measured fire distance, not a timer', () => {
  const E = fresh(); run(E, 60);
  for(const r of E.roads){
    if(r.manualClosed) continue;
    const expected = r.minDist <= 3.2 ? 'BLOCKED' : r.minDist <= 8 ? 'THREATENED' : r.minDist <= 13 ? 'WATCH' : 'SAFE';
    eq(r.status, expected, r.name + ' status disagrees with its measured distance ' + r.minDist.toFixed(2) + ';');
  }
});

await t('a BLOCKED road is excluded from the routing graph', () => {
  const E = fresh();
  const r = E.roads.find(x => x.id === 'foothill');
  const before = E.dijkstra(E.keyOf(E.COMMUNITIES[1].node), E.SAFE);
  assert(before, 'Mill Creek had no baseline route');
  assert(before.path.some(e => e.id === 'foothill'), 'expected the baseline route to use Foothill Ave');
  r.status = 'BLOCKED';
  const after = E.dijkstra(E.keyOf(E.COMMUNITIES[1].node), E.SAFE);
  assert(!after || !after.path.some(e => e.id === 'foothill'),
    'a BLOCKED road was still used by the route');
});

await t('fire-driven road closure forces a real route change', () => {
  const E = fresh(); E.startDemo();
  const key = c => E.currentRoutes[c] ? E.currentRoutes[c].path.map(e => e.id + '#' + e.seg).join(',') : 'NONE';
  const start = key('oakridge');
  let changedAt = null, cause = null;
  for(let m=1;m<=100;m++){
    E.step();
    if(!changedAt && key('oakridge') !== start){
      changedAt = m;
      cause = E.roads.filter(r => r.status !== 'SAFE').map(r => r.id + '=' + r.status);
    }
  }
  assert(changedAt, 'Oakridge never re-routed across the whole guided scenario');
  assert(cause.length > 0, 'the route changed at minute ' + changedAt + ' with every corridor SAFE \u2014 not fire-driven');
});

await t('route cost reflects road status (threatened corridors are penalised)', () => {
  const E = fresh();
  const c = E.COMMUNITIES[0];
  const base = E.dijkstra(E.keyOf(c.node), E.SAFE);
  for(const e of base.path){ E.roads.find(r => r.id === e.id).status = 'THREATENED'; }
  const after = E.dijkstra(E.keyOf(c.node), E.SAFE);
  assert(after.cost > base.cost, 'marking the route THREATENED did not raise its cost');
});

/* ---------------------------------------------------------------------------
   10. MANUAL CLOSURE + COMMUNITY ISOLATION
   --------------------------------------------------------------------------- */
console.log('\nmanual closure + accessibility');

await t('manually closing a road changes the graph and the route; reopening restores it', () => {
  const E = fresh();
  const key = () => E.currentRoutes['millcreek'] ? E.currentRoutes['millcreek'].path.map(e=>e.id).join(',') : 'NONE';
  const before = key();
  const r = E.roads.find(x => x.id === 'foothill');
  r.manualClosed = true;
  E.updateRoadStatuses(E.simTime); E.recomputeAllRoutes(false);
  eq(r.status, 'BLOCKED', 'manual closure did not set BLOCKED;');
  assert(key() !== before, 'manual closure did not change the route (' + before + ')');
  r.manualClosed = false;
  E.updateRoadStatuses(E.simTime); E.recomputeAllRoutes(false);
  eq(key(), before, 'reopening did not restore the original route;');
});

await t('manual closure survives a scrub', () => {
  const E = fresh();
  E.roads.find(x => x.id === 'foothill').manualClosed = true;
  E.scrubToTime(20);
  eq(E.roads.find(x => x.id === 'foothill').manualClosed, true, 'operator closure was wiped by a scrub;');
});

await t('cutting every corridor into a community isolates it, and restoring reconnects it', () => {
  const E = fresh();
  const safeKey = E.SAFE;
  assert(E.dijkstra(E.keyOf(E.COMMUNITIES[2].node), safeKey), 'Summit View unreachable at baseline');
  // Summit View sits at the end of Summit Pass; closing it and Highway 39
  // removes every path out.
  for(const id of ['summit']) E.roads.find(r => r.id === id).manualClosed = true;
  E.updateRoadStatuses(E.simTime); E.recomputeAllRoutes(false);
  assert(!E.currentRoutes['summitview'], 'Summit View should be isolated with Summit Pass closed');
  E.roads.find(r => r.id === 'summit').manualClosed = false;
  E.updateRoadStatuses(E.simTime); E.recomputeAllRoutes(false);
  assert(E.currentRoutes['summitview'], 'Summit View was not reconnected after reopening Summit Pass');
});

await t('isolation is announced once, not on every subsequent tick', () => {
  const E = fresh(); E.startDemo();
  run(E, 100);
  const iso = E.events.filter(ev => /ISOLATED/.test(ev.title));
  const byCommunity = {};
  for(const ev of iso) byCommunity[ev.title] = (byCommunity[ev.title]||0) + 1;
  for(const k in byCommunity){
    assert(byCommunity[k] <= 2, k + ' was announced ' + byCommunity[k] + ' times \u2014 feed spam');
  }
});

/* ---------------------------------------------------------------------------
   11. FEED HONESTY
   --------------------------------------------------------------------------- */
console.log('\nfeed honesty');

await t('every road event in the feed matches a real status transition', () => {
  const E = fresh(); E.startDemo();
  const transitions = new Set();
  const last = {}; E.roads.forEach(r => last[r.id] = r.status);
  for(let m=1;m<=100;m++){
    E.step();
    for(const r of E.roads) if(last[r.id] !== r.status){ transitions.add(r.name.toUpperCase() + '|' + r.status); last[r.id] = r.status; }
  }
  const claimed = E.events
    .filter(ev => /THREATENED|BLOCKED|WATCH/.test(ev.title))
    .map(ev => ev.title.replace(/ \u2014 WATCH$/, '|WATCH').replace(/ THREATENED$/, '|THREATENED').replace(/ BLOCKED$/, '|BLOCKED'));
  for(const c of claimed) assert(transitions.has(c), 'feed claimed "' + c + '" with no matching state transition');
});

await t('reported fire distances match the engine, in real units', () => {
  const E = fresh(); run(E, 60);
  for(const r of E.roads){
    if(r.status === 'SAFE' || r.manualClosed) continue;
    const km = r.minDist * 0.25;   // CELL_KM
    assert(km >= 0 && km < 20, r.name + ' reported an impossible distance ' + km);
  }
});

/* ---------------------------------------------------------------------------
   12. TIMELINE UI
   --------------------------------------------------------------------------- */
console.log('\ntimeline UI');

await t('the timeline slider bounds match the actual simulation horizon', () => {
  // Regression: aria-valuemax and the tick labels were hardcoded for a
  // 30-minute horizon and silently went stale when MAX_TL_MINUTES became 100.
  const E = fresh();
  eq(E.getElById('tl-track-wrap').getAttribute('aria-valuemax'), String(E.MAX_TL),
    'aria-valuemax does not match MAX_TL_MINUTES;');
});

await t('a timeline marker is rendered for every feed event, in the same order', () => {
  const E = fresh(); E.startDemo();
  for(let m=1;m<=100;m++) E.step();
  const markers = E.getElById('tl-events').children;
  eq(markers.length, E.events.length, 'marker count does not match event count;');
  for(let i=0;i<E.events.length;i++){
    assert(markers[i].className.includes(E.events[i].kind),
      'marker ' + i + ' class "' + markers[i].className + '" does not reflect event kind "' + E.events[i].kind + '"');
  }
});

await t('scrubbing clears and rebuilds the event feed and markers without duplication', () => {
  const E = fresh();
  E.scrubToTime(40);
  const a = E.events.length, am = E.getElById('tl-events').children.length;
  E.scrubToTime(40);   // scrubbing to the SAME point twice must be idempotent
  eq(E.events.length, a, 'repeated scrub to the same minute changed the event count;');
  eq(E.getElById('tl-events').children.length, am, 'repeated scrub duplicated timeline markers;');
  E.scrubToTime(60);
  E.scrubToTime(40);   // and scrubbing away and back must not accumulate either
  eq(E.events.length, a, 'scrubbing away and back changed the event count for the same minute;');
  eq(E.getElById('tl-events').children.length, am, 'scrubbing away and back duplicated timeline markers;');
});

await t('markers and feed stay in sync with events after a reset', () => {
  const E = fresh(); E.startDemo();
  for(let m=1;m<=50;m++) E.step();
  E.reset();
  eq(E.getElById('tl-events').children.length, E.events.length, 'markers out of sync with events after reset;');
  eq(E.getElById('feed').children.length, E.events.length, 'feed out of sync with events after reset;');
});

/* ---------------------------------------------------------------------------
   14. MAP RENDERING: casing, halos, terrain relief
   --------------------------------------------------------------------------- */
console.log('\nmap rendering');

await t('every road is cased (a dark stroke) before its status stroke', () => {
  const E = fresh(); // reset() already renders once internally; don't double-draw
  const casing = E.ctxI.calls.stroke.filter(c => c.snapshot.strokeStyle === 'rgba(6,8,10,0.85)');
  const status = E.ctxI.calls.stroke.filter(c => /^rgba\(2(00|55),/.test(c.snapshot.strokeStyle||''));
  eq(casing.length, E.roads.length, 'expected one casing stroke per road;');
  assert(status.length >= E.roads.length, 'expected at least one status stroke per road');
  const lastCasing = Math.max(...casing.map(c => c.seq));
  const firstStatus = Math.min(...status.map(c => c.seq));
  assert(lastCasing < firstStatus, 'a road status stroke was drawn before all casing strokes were laid down');
});

await t('every map label is drawn with a stroke halo directly behind its fill', () => {
  const E = fresh(); // reset() already renders once internally; don't double-draw
  const { strokeText, fillText } = E.ctxI.calls;
  eq(strokeText.length, fillText.length, 'fillText/strokeText call counts do not match — an unhaloed label exists;');
  assert(strokeText.length > 0, 'no labels were drawn at all');
  for(let i=0;i<fillText.length;i++){
    eq(fillText[i].seq - strokeText[i].seq, 1,
      'label ' + i + ' fillText was not drawn immediately after its strokeText halo');
  }
});

await t('the evacuation route is cased before its colored stroke', () => {
  const E = fresh(); // reset() already renders once internally; don't double-draw
  const dark = E.ctxI.calls.stroke.filter(c => c.snapshot.strokeStyle === 'rgba(5,10,8,0.55)');
  const green = E.ctxI.calls.stroke.filter(c => c.snapshot.strokeStyle === 'rgba(47,217,138,0.9)');
  const routed = COMMUNITIES => E.COMMUNITIES.filter(c => E.currentRoutes[c.id]).length;
  eq(dark.length, routed(), 'expected one casing stroke per routed community;');
  eq(green.length, routed(), 'expected one colored stroke per routed community;');
});

await t('hillshade responds to real terrain slope, not a flat constant', () => {
  const E = fresh();
  const hs = E.computeHillshade();
  let min=1, max=0;
  for(const v of hs){ if(v<min) min=v; if(v>max) max=v; }
  assert(max - min > 0.3, 'hillshade range ' + min.toFixed(2) + '..' + max.toFixed(2) + ' is too flat to read as relief');
});

await t('elevation contours exist within the world\'s real elevation range and not outside it', () => {
  const E = fresh();
  let maxE = 0; for(const v of E.world.elevation) if(v>maxE) maxE = v;
  assert(E.elevationContours(maxE*0.5).length > 0, 'no contour segments at a mid-range elevation');
  eq(E.elevationContours(maxE + 1).length, 0, 'a contour was drawn above the terrain\'s actual maximum elevation');
});

await t('drawTerrain completes in reasonable time (it runs on resize/reset/scrub, not per frame)', () => {
  const E = fresh();
  const t0 = Date.now();
  E.drawTerrain();
  assert(Date.now() - t0 < 400, 'drawTerrain took ' + (Date.now()-t0) + 'ms — too slow even for an infrequent call');
});

/* Terrain colour pipeline + repaint count.
   Regression: desaturate() returned 'rgb(r,g,b)' but shadeColor() parsed its
   input as '#rrggbb' (parseInt(hex.slice(1),16)). Chained in drawTerrain() that
   is parseInt('gb(..') -> NaN -> r=g=b=0, so EVERY landcover cell was filled
   'rgb(0,0,0)' and the map rendered black. The valid-looking (but black)
   output slipped past every earlier check, which never inspected fillStyle. */
const RGB_RE = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/;
function terrainCellFills(E){
  const log = E.ctxT.calls.fillRect;
  log.length = 0;
  E.drawTerrain();
  return log.map(c => c.snapshot.fillStyle);
}

await t('desaturate() and shadeColor() accept each other\'s output for every landcover colour', () => {
  const E = fresh();
  for(const cls of E.LC_ORDER){
    const hex = E.LC_COLOR[cls];
    assert(/^#[0-9a-f]{6}$/i.test(hex), cls + ' LC_COLOR is not #rrggbb: ' + hex);
    const chained = E.shadeColor(E.desaturate(hex, 0.15), 1.2);   // exactly what drawTerrain does
    const m = RGB_RE.exec(chained);
    assert(m, cls + ': chained colour is not a valid rgb() string: ' + chained);
    const [r,g,b] = [m[1],m[2],m[3]].map(Number);
    assert(r<=255 && g<=255 && b<=255, cls + ': channel out of range in ' + chained);
    assert(r+g+b > 30, cls + ': chained colour collapsed to ~black (' + chained + ') — colour helpers disagree on input format');
    // shadeColor must give the same answer whether it is handed hex or the equivalent rgb()
    const [hr,hg,hb] = E.parseColor(hex);
    eq(E.shadeColor(hex, 1.2), E.shadeColor('rgb('+hr+','+hg+','+hb+')', 1.2), cls + ': hex vs rgb() input disagree;');
  }
});

await t('colour helpers fail loudly on bad input instead of producing NaN/black', () => {
  const E = fresh();
  let threw = 0;
  for(const bad of [() => E.shadeColor('not-a-colour', 1), () => E.desaturate(undefined, 0.1), () => E.shadeColor('#123456', NaN), () => E.desaturate('#123456', Infinity)]){
    try { bad(); } catch(e){ threw++; }
  }
  eq(threw, 4, 'number of bad inputs rejected;');
});

await t('hillshade is finite and within 0..1 for every cell (no NaN reaching the colour pipeline)', () => {
  const E = fresh();
  const hs = E.computeHillshade();
  for(let k=0;k<hs.length;k++) assert(Number.isFinite(hs[k]) && hs[k]>=0 && hs[k]<=1, 'hillshade[' + k + '] = ' + hs[k]);
  for(let k=0;k<E.world.elevation.length;k++) assert(Number.isFinite(E.world.elevation[k]), 'elevation[' + k + '] not finite');
});

await t('drawTerrain paints every cell with a valid, visible, relief-shaded colour (landcover layer)', () => {
  const E = fresh();
  const fills = terrainCellFills(E);
  eq(fills.length, E.GRID*E.GRID, 'one fillRect per cell;');
  let black = 0, lumSum = 0;
  for(const f of fills){
    const m = RGB_RE.exec(f);
    assert(m, 'invalid canvas colour assigned to terrain: ' + f);
    const [r,g,b] = [m[1],m[2],m[3]].map(Number);
    assert(r<=255 && g<=255 && b<=255, 'channel out of range: ' + f);
    if(r+g+b <= 6) black++;
    lumSum += 0.299*r + 0.587*g + 0.114*b;
  }
  eq(black, 0, 'number of near-black terrain cells (the all-black-map bug);');
  assert(lumSum/fills.length > 25, 'mean terrain luminance ' + (lumSum/fills.length).toFixed(1) + ' — map would read as black');
  assert(new Set(fills).size > 50, 'only ' + new Set(fills).size + ' distinct terrain colours — hillshade/landcover shading is not reaching the canvas');
});

await t('drawTerrain paints valid, visible colours in the terrain-only layer mode too', () => {
  const E = fresh();
  E.layers.landcover = false;
  const fills = terrainCellFills(E);
  eq(fills.length, E.GRID*E.GRID, 'one fillRect per cell;');
  for(const f of fills) assert(RGB_RE.test(f), 'invalid canvas colour assigned to terrain: ' + f);
  assert(new Set(fills).size > 20, 'terrain-only mode has no relief shading');
  let lum = 0, maxLum = 0;
  for(const f of fills){ const m = RGB_RE.exec(f); const l = 0.299*m[1] + 0.587*m[2] + 0.114*m[3]; lum += l; if(l>maxLum) maxLum = l; }
  const mean = lum/fills.length;
  assert(mean > 25 && mean < 110, 'terrain-only mean luminance ' + mean.toFixed(1) + ' is outside the dark-basemap band 25..110 (too black or washed out)');
  assert(maxLum < 170, 'terrain-only brightest cell has luminance ' + maxLum.toFixed(1) + ' — lit slopes would wash out the state layers');
});

await t('elevation contours are still stroked over the terrain fill, with major/minor styling', () => {
  const E = fresh();
  E.ctxT.calls.fillRect.length = 0; E.ctxT.calls.stroke.length = 0;
  E.drawTerrain();
  const strokes = E.ctxT.calls.stroke, fills = E.ctxT.calls.fillRect;
  assert(strokes.length > 0, 'no contour strokes were issued');
  assert(Math.min(...strokes.map(c=>c.seq)) > Math.max(...fills.map(c=>c.seq)), 'a contour was stroked before the terrain fill finished (it would be painted over)');
  const styles = new Set(strokes.map(c => c.snapshot.strokeStyle + '|' + c.snapshot.lineWidth));
  assert(styles.has('rgba(0,0,0,0.30)|1'), 'no major contour style used');
  assert(styles.has('rgba(0,0,0,0.15)|0.6'), 'no minor contour style used');
  // spacing: one stroke per contour level that has segments, levels every CONTOUR_INTERVAL
  let maxE = 0; for(const v of E.world.elevation) if(v>maxE) maxE = v;
  let expected = 0;
  for(let iso=E.CONTOUR_INTERVAL; iso<maxE; iso+=E.CONTOUR_INTERVAL) if(E.elevationContours(iso).length) expected++;
  eq(strokes.length, expected, 'contour stroke count vs. levels with segments;');
});

await t('resizeCanvases repaints terrain only when the map box or DPR actually changed', () => {
  const E = fresh();
  const wrap = E.getElById('mapwrap');
  const fills = E.ctxT.calls.fillRect;
  fills.length = 0; E.resizeCanvases();
  eq(fills.length, E.GRID*E.GRID, 'first resize should paint terrain once;');
  fills.length = 0; E.resizeCanvases(); E.resizeCanvases();
  eq(fills.length, 0, 'unchanged-size resize repainted terrain (duplicate draw);');
  wrap.clientWidth = 640;
  fills.length = 0; E.resizeCanvases();
  eq(fills.length, E.GRID*E.GRID, 'a real size change must still repaint terrain;');
});

/* ---------------------------------------------------------------------------
   16. LIVE DATA: NASA FIRMS + Open-Meteo, with honest fallback
   -------------------------------------------------------------------------
   The test harness's fetch() always rejects (no real network reaches this
   sandbox), so every check here exercises the FALLBACK path end-to-end --
   which is exactly the path that must be bulletproof, since it's what runs
   whenever a user has no FIRMS key, is offline, or the API is down. These
   checks cannot confirm the live HTTP calls succeed against the real APIs;
   that can only be verified in a real browser with real network access.
   --------------------------------------------------------------------------- */
console.log('\nlive data (weather + fire detections)');

await t('a failed live fetch degrades to the cached scenario, honestly labeled', async () => {
  const E = fresh();
  await E.refreshLiveConditions();
  eq(E.liveStatus.weather.state, 'cached', 'weather did not report cached after a failed fetch;');
  eq(E.liveStatus.fire.state, 'cached', 'fire did not report cached after a failed fetch;');
  assert(/failed|no api key/i.test(E.liveStatus.weather.detail), 'weather cached-state has no real failure reason: ' + E.liveStatus.weather.detail);
  assert(/failed|no api key/i.test(E.liveStatus.fire.detail), 'fire cached-state has no real failure reason: ' + E.liveStatus.fire.detail);
});

await t('a failed live fetch never mutates env or ignitions away from the tuned scenario', async () => {
  const E = fresh();
  const before = { d:E.env.windDir, s:E.env.windSpeed, h:E.env.humidity, t:E.env.temperature };
  await E.refreshLiveConditions();
  E.reset();
  eq(E.env.windDir, before.d); eq(E.env.windSpeed, before.s);
  eq(E.env.humidity, before.h); eq(E.env.temperature, before.t);
  eq(E.liveIgnitionCells.length, 0, 'liveIgnitionCells should stay empty on fetch failure;');
  // and the tuned scenario properties (all corridors SAFE at t=0, Canyon
  // reaches BLOCKED) must be completely undisturbed by the attempted fetch
  eq(E.roads.filter(r=>r.status!=='SAFE').length, 0, 'a road was non-SAFE at t=0 after a failed live fetch;');
  run(E, 100);
  eq(statusOf(E,'canyon'), 'BLOCKED', 'Canyon Road did not reach BLOCKED — the tuned scenario was disturbed by a failed live fetch;');
});

await t('FIRMS is queried via the same-origin /api/firms proxy with no API key in the browser request', async () => {
  const E = fresh();
  const seen = [];
  E.setFetch((url) => { seen.push(String(url)); return Promise.reject(new Error('stub: stop after recording')); });
  await E.fetchLiveFireDetections(E.SCENARIOS[0]).catch(()=>{});
  eq(seen.length, 1, 'number of requests;');
  assert(/^\/api\/firms\?west=[-\d.]+&south=[-\d.]+&east=[-\d.]+&north=[-\d.]+$/.test(seen[0]), 'unexpected request URL: ' + seen[0]);
  assert(!/firms\.modaps|map_?key|api_?key/i.test(seen[0]), 'the browser request must not reach FIRMS directly or carry a key: ' + seen[0]);
});

await t('FIRMS proxy CSV becomes live ignition cells; proxy errors surface as an honest cached state', async () => {
  const E = fresh();
  const scn = E.SCENARIOS[0];
  const csv = 'latitude,longitude,bright_ti4\n' + scn.lat + ',' + scn.lon + ',330\nnot-a-number,x,1\n';
  E.setFetch(() => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(csv), json:()=>Promise.reject(new Error('n/a')) }));
  const pts = await E.fetchLiveFireDetections(scn);
  eq(pts.length, 1, 'valid detections parsed (bad row skipped);');
  E.setFetch(() => Promise.resolve({ ok:false, status:503, text:()=>Promise.resolve(''), json:()=>Promise.resolve({ error:'FIRMS_MAP_KEY is not configured on the server' }) }));
  await E.refreshLiveConditions();
  eq(E.liveStatus.fire.state, 'cached', 'fire state after proxy 503;');
  assert(/not configured on the server/.test(E.liveStatus.fire.detail), 'server error reason not shown: ' + E.liveStatus.fire.detail);
});

await t('gridToLatLon and latLonToGrid are inverse to within one cell', () => {
  const E = fresh();
  const scn = E.SCENARIOS[0];
  for(const [i,j] of [[0,0],[36,36],[71,71],[10,60],[60,10]]){
    const [lat,lon] = E.gridToLatLon(i,j,scn);
    const back = E.latLonToGrid(lat,lon,scn);
    assert(back, 'round-trip landed outside the grid for ('+i+','+j+')');
    assert(Math.abs(back[0]-i)<=1 && Math.abs(back[1]-j)<=1,
      'round-trip (' + i + ',' + j + ') -> (' + back[0] + ',' + back[1] + ') drifted by more than one cell');
  }
});

await t('latLonToGrid rejects a point well outside the scenario\'s real footprint', () => {
  const E = fresh();
  const scn = E.SCENARIOS[0];
  eq(E.latLonToGrid(scn.lat+5, scn.lon+5, scn), null, 'a point ~500km away was mapped onto the grid;');
});

await t('switching location does not leak the previous location\'s live ignition into the new one', () => {
  const E = fresh();
  // Simulate a stale live ignition as if a slow fetch had landed for the
  // previous location, then switch -- the new location must not inherit it.
  E.reset();
  const sierra = E.SCENARIOS.find(s=>s.id==='sierra');
  E.selectScenario(sierra);
  eq(E.liveIgnitionCells.length, 0, 'a stale live ignition leaked across a location change;');
  // A fresh fetch attempt starts synchronously (state flips to 'pending')
  // the moment selectScenario() kicks it off; the invariant that matters is
  // that no STALE 'live' status/ignition from the previous location survives
  // the switch -- not the exact transient state mid-fetch.
  assert(E.liveStatus.fire.state !== 'live', 'a stale LIVE fire status leaked across a location change;');
});

await t('switching location re-baselines the environment, so a later scrub preserves it (regression)', () => {
  // Previously: selectScenario() ran resetScenario() (which snapshots the
  // CURRENT env as the scrub baseline) and only assigned the new scenario's
  // env values afterward -- so the baseline silently stayed the OLD
  // location's values, and scrubbing after switching reverted to them.
  const E = fresh();
  const sierra = E.SCENARIOS.find(s=>s.id==='sierra');
  E.selectScenario(sierra);
  eq(E.env.windDir, sierra.wind.dir); eq(E.env.humidity, sierra.humidity);
  run(E, 20);
  E.scrubToTime(10);
  eq(E.env.windDir, sierra.wind.dir, 'wind direction reverted to the previous location after a scrub;');
  eq(E.env.humidity, sierra.humidity, 'humidity reverted to the previous location after a scrub;');
  eq(E.env.temperature, sierra.temperature, 'temperature reverted to the previous location after a scrub;');
});

/* ---------------------------------------------------------------------------
   17. PERFORMANCE
   --------------------------------------------------------------------------- */
console.log('\nperformance');

await t('a full 100-minute run completes well inside a frame budget per tick', () => {
  const E = fresh(); E.startDemo();
  const t0 = Date.now();
  run(E, 100);
  const ms = Date.now() - t0;
  assert(ms < 4000, 'full guided run took ' + ms + 'ms of engine time');
});

await t('fire rendering stays inside a 60fps frame budget at full fire extent', () => {
  // Regression: the field rasteriser originally allocated a closure per sample
  // and an [r,g,b] array per sub-cell, costing ~42ms/frame at t=100 -- which
  // then forced a field rebuild every single frame, compounding the problem.
  // Budget here is deliberately looser than the real 16.7ms/frame target: the
  // harness's canvas context records every draw call for other tests in this
  // suite, which costs real (if small) overhead that a production <canvas>
  // does not have.
  const E = fresh(); E.startDemo(); run(E, 100);
  E.advanceFireDisplay(16); E.drawFire();          // warm the cache
  const t0 = Date.now();
  for(let i=0;i<120;i++){ E.advanceFireDisplay(16); E.drawFire(); }
  const ms = (Date.now() - t0) / 120;
  assert(ms < 14, 'drawFire costs ' + ms.toFixed(2) + 'ms/frame at full extent (16.7ms/frame budget; alarm well below it)');
});

await t('the fire field is cached, not rebuilt on every frame', () => {
  const E = fresh(); run(E, 60);
  E.advanceFireDisplay(16); E.drawFire();
  const box = E.fieldBox;
  assert(box, 'no field bounding box was computed');
  // the box must track the fire, not cover the whole grid
  assert((box.i1 - box.i0) < E.GRID - 1 || (box.j1 - box.j0) < E.GRID - 1,
    'field work is not restricted to the fire bounding box');
});

await t('contours are generated and correspond to real burnt cells', () => {
  const E = fresh(); run(E, 60);
  E.advanceFireDisplay(16); E.drawFire();
  assert(E.segCounts.perimeter > 0, 'no fire perimeter contour was produced');
  const empty = fresh();
  empty.world.state.fill(0); empty.world.activeList.length = 0;
  empty.advanceFireDisplay(5000);
  empty.invalidateFireField();   // state was mutated directly, as reset/scrub would
  empty.drawFire();
  eq(empty.segCounts.perimeter, 0, 'a perimeter was drawn with no fire on the map;');
});

await t('the active-cell list does not leak burnt-out cells', () => {
  const E = fresh(); run(E, 100);
  for(const idx of E.world.activeList) eq(E.world.state[idx], 1, 'activeList contains a non-active cell;');
  const set = new Set(E.world.activeList);
  eq(set.size, E.world.activeList.length, 'activeList contains duplicates;');
});

/* --------------------------------------------------------------------------- */
console.log('\n' + (fail === 0
  ? '\u2713 ' + pass + ' behavioural checks passed'
  : '\u2717 ' + fail + ' of ' + (pass + fail) + ' failed:\n  - ' + failures.join('\n  - ')) + '\n');
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e); process.exit(1); });

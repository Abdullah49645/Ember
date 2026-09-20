/**
 * Headless behavioural harness.
 *
 * Executes the REAL simulation/routing/demo code out of apps/web/index.html in
 * a Node vm with the DOM stubbed, and exposes the module-scoped internals so
 * behaviour can be asserted rather than inferred from reading the source.
 *
 * This exists because Playwright's browser binaries are not cached in this
 * environment and there is no network access to download them, so literal
 * in-browser interaction is not available here. This harness runs the actual
 * production code path (not a reimplementation), which makes engine, routing
 * and guided-demo behaviour genuinely testable; it does NOT cover layout,
 * paint, z-index, pointer-events or hit-testing, which still need a real
 * browser. See README "Testing" for that distinction.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML = path.join(__dirname, '..', 'apps', 'web', 'index.html');

/**
 * A fake 2D context that also RECORDS calls to a small set of drawing methods
 * (stroke, fillText, strokeText, fillRect, drawImage) with the arguments they
 * were called with. This is what lets behavioural tests assert on rendering
 * decisions -- e.g. "a dark casing stroke happens before every road's status
 * stroke", "every fillText is paired with a strokeText halo" -- rather than
 * trusting that reading the source code matches what actually executes.
 * Each context instance gets its own independent `calls` log.
 */
const GLOBAL_SEQ = {n:0};  // shared call-order counter across all recording contexts
function makeCtx2D(){
  const noop = ()=>{};
  const calls = { stroke:[], fillText:[], strokeText:[], fillRect:[], drawImage:[], beginPath:0 };
  const RECORDED = { stroke:'stroke', fillText:'fillText', strokeText:'strokeText', fillRect:'fillRect', drawImage:'drawImage' };
  const state = {};
  const ctx = new Proxy(state, {
    get(t,k){
      if(k==='canvas') return {width:720,height:720};
      if(k==='calls') return calls;
      if(k==='createImageData') return (w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)});
      if(k==='createRadialGradient'||k==='createLinearGradient') return ()=>({addColorStop:()=>{}});
      if(k==='getImageData') return (x,y,w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)});
      if(k==='beginPath') return ()=>{ calls.beginPath++; };
      if(k in RECORDED) return (...args)=>{ calls[k].push({args, seq:GLOBAL_SEQ.n++, snapshot:{strokeStyle:t.strokeStyle, fillStyle:t.fillStyle, lineWidth:t.lineWidth}}); };
      if(k in t) return t[k];
      return noop;
    },
    set(t,k,v){ t[k]=v; return true; }
  });
  return ctx;
}

function makeEl(id){
  const attrs = {};
  const el = {
    id, style:{ setProperty(){}, removeProperty(){}, getPropertyValue(){return '';} }, dataset:{}, children:[], _text:'', value:'0',
    className:'', checked:false,
    classList:{ add:()=>{}, remove:()=>{}, toggle:()=>{}, contains:()=>false },
    addEventListener:()=>{}, removeEventListener:()=>{},
    // A minimal but real attribute store, unlike the previous no-op stub --
    // application code that reads back what it just set (aria-valuemax,
    // aria-pressed, etc.) needs this to be testable at all.
    setAttribute:(k,v)=>{ attrs[k]=String(v); },
    getAttribute:(k)=>(k in attrs ? attrs[k] : null),
    removeAttribute:(k)=>{ delete attrs[k]; },
    appendChild:(c)=>{ el.children.push(c); return c; },
    removeChild:(c)=>{ const i=el.children.indexOf(c); if(i>=0) el.children.splice(i,1); return c; },
    querySelector:()=>makeEl('q'), querySelectorAll:()=>[],
    getBoundingClientRect:()=>({left:0,top:0,width:720,height:720,right:720,bottom:720}),
    getContext:()=>makeCtx2D(),
    focus:()=>{}, click:()=>{}, remove:()=>{}, insertBefore:()=>{},
    closest:()=>null, contains:()=>false,
    width:720, height:720, clientWidth:720, clientHeight:720,
  };
  Object.defineProperty(el,'textContent',{get:()=>el._text,set:(v)=>{el._text=String(v);}});
  Object.defineProperty(el,'firstChild',{get:()=>el.children[0]||null});
  // Real DOM: setting innerHTML replaces all children. Application code only
  // ever sets it to '' (to clear a container) or as literal content on a
  // freshly-created leaf with no children, so clearing .children on any
  // assignment is a faithful-enough approximation without an HTML parser.
  Object.defineProperty(el,'innerHTML',{
    get:()=>el._html||'',
    set:(v)=>{ el._html=v; el.children.length=0; }
  });
  return el;
}

function build(){
  const html = fs.readFileSync(HTML,'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  let body = m[1];
  // unwrap IIFE so we can append an export hook in the same scope
  body = body.replace(/^\s*\(function\(\)\{/, '').replace(/\}\)\(\);\s*$/, '');
  body += `
;globalThis.__E = {
  get world(){return world;}, get roads(){return roads;}, get roadGraph(){return roadGraph;},
  get env(){return env;}, get simTime(){return simTime;}, set simTime(v){simTime=v;},
  get currentRoutes(){return currentRoutes;}, get events(){return events;},
  get GRID(){return GRID;}, get COMMUNITIES(){return COMMUNITIES;}, get ROAD_DEFS(){return ROAD_DEFS;},
  get SAFE(){return SAFE_ZONE_NODE_KEY;},
  get firebreakSegments(){return firebreakSegments;},
  get MAX_TL(){return typeof MAX_TL_MINUTES!=='undefined'?MAX_TL_MINUTES:null;},
  get TICK_MS(){return TICK_MS;},
  step:()=>stepSimulation(), reset:()=>resetScenario(),
  dijkstra:(a,b)=>dijkstra(a,b), keyOf:(p)=>keyOf(p),
  applyFirebreak:(p)=>applyFirebreak(p),
  seedIgnitions:(t)=>seedIgnitions(t),
  ignite:(i,j,t,sp)=>ignite(i,j,t,sp),
  findFlammableNear:(x,y)=>findFlammableNear(x,y),
  get SEED(){return SEED;},
  buildWorld:(s)=>buildWorld(s), buildRoadGraph:()=>buildRoadGraph(),
  updateRoadStatuses:(t)=>updateRoadStatuses(t), recomputeAllRoutes:(a)=>recomputeAllRoutes(a),
  setWorld:(w)=>{world=w;}, reseed:(s)=>{rng=mulberry32(s);},
  get demoState(){ return demo; },
  get demoScript(){ return DEMO_SCRIPT; },
  get interventions(){ return interventions; },
  getElById:(id)=>document.getElementById(id),
  refreshLiveConditions:()=>refreshLiveConditions(),
  fetchLiveFireDetections:(scn)=>fetchLiveFireDetections(scn),
  setFetch:(f)=>{ fetch = f; },
  get liveStatus(){return liveStatus;},
  get liveIgnitionCells(){return liveIgnitionCells;},
  get SCENARIOS(){return SCENARIOS;},
  selectScenario:(s)=>selectScenario(s),
  gridToLatLon:(i,j,scn)=>gridToLatLon(i,j,scn), latLonToGrid:(lat,lon,scn)=>latLonToGrid(lat,lon,scn),
  get envBaselineSnapshot(){return envBaseline;},
  startDemo:()=>startDemo(), stopDemo:()=>stopDemo(),
  recordIntervention:(iv)=>recordIntervention(iv),
  scrubToTime:(t)=>scrubToTime(t),
  get CELL_KM(){return CELL_KM;},
  get SUB(){return SUB;}, get FIELD(){return FIELD;},
  drawFire:()=>drawFire(), invalidateFireField:()=>invalidateFireField(),
  advanceFireDisplay:(dt)=>advanceFireDisplay(dt),
  get segCounts(){ return {perimeter:segsPerimeter.length, front:segsFront.length}; },
  get fieldBox(){ return fieldBox; },
  drawTerrain:()=>drawTerrain(), computeHillshade:()=>computeHillshade(),
  resizeCanvases:()=>resizeCanvases(),
  get LC_COLOR(){return LC_COLOR;}, get LC_ORDER(){return LC_ORDER;},
  parseColor:(c)=>parseColor(c), desaturate:(c,a)=>desaturate(c,a), shadeColor:(c,f)=>shadeColor(c,f),
  get CONTOUR_INTERVAL(){return CONTOUR_INTERVAL;}, get CONTOUR_MAJOR_EVERY(){return CONTOUR_MAJOR_EVERY;},
  elevationContours:(iso)=>elevationContours(iso),
  renderAll:()=>renderAll(), drawInfra:()=>drawInfra(),
  get ctxI(){return ctxI;}, get ctxT(){return ctxT;}, get ctxF(){return ctxF;},
  get layers(){return layers;}
};`;

  const els = new Map();
  const document = {
    getElementById:(id)=>{ if(!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector:(s)=>makeEl(s), querySelectorAll:()=>[],
    createElement:(t)=>makeEl(t),
    addEventListener:()=>{}, body:makeEl('body'),
    documentElement:makeEl('html'), fullscreenElement:null, exitFullscreen:()=>{},
    activeElement:null,
  };
  const sandbox = {
    document,
    window:{ addEventListener:()=>{}, matchMedia:()=>({matches:false}), innerWidth:1440, innerHeight:900 },
    performance:{ now:()=>Date.now() },
    requestAnimationFrame:()=>0,
    setTimeout:()=>0, clearTimeout:()=>{}, setInterval:()=>0, clearInterval:()=>{},
    console, Math, Date, JSON, Object, Array, Number, String, Boolean, Map, Set,
    Float32Array, Uint8Array, Uint8ClampedArray, Int32Array, isFinite, parseFloat, parseInt,
    localStorage:{ getItem:()=>null, setItem:()=>{}, removeItem:()=>{} },
    // Real network calls never leave this sandbox: fetch always rejects, so
    // every test exercises the app's actual cached/fallback code path rather
    // than a real HTTP response this harness can't produce or verify.
    fetch:()=>Promise.reject(new Error('offline (headless test harness)')),
    AbortController, // real Node global; needed by the live-data fetch-with-timeout helper
    navigator:{ userAgent:'node' },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = document;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox, {filename:'index.html<script>'});
  return { E: sandbox.__E, els, sandbox };
}

module.exports = { build };

if(require.main === module){
  const {E} = build();
  console.log('booted. GRID', E.GRID, 'TICK_MS', E.TICK_MS, 'MAX_TL', E.MAX_TL);
}

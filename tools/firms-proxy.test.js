// Tests for api/firms.js (Vercel function). Run: node tools/firms-proxy.test.js
// Lives in tools/ (not api/) so Vercel doesn't deploy the test as an endpoint.
const assert = require('assert');
const handler = require('../api/firms.js');
const SECRET = 'TEST-SECRET-KEY-0123456789abcdef';
const GOOD = { west:'-118.6', south:'34.0', east:'-118.4', north:'34.2' };

function mockRes(){
  const r = { statusCode:200, headers:{}, body:undefined };
  r.setHeader = (k,v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = JSON.stringify(o); r.headers['content-type'] = 'application/json'; return r; };
  r.send = (t) => { r.body = String(t); return r; };
  return r;
}
async function call(query, { method='GET', env=SECRET, upstream } = {}){
  if(env === null) delete process.env.FIRMS_MAP_KEY; else process.env.FIRMS_MAP_KEY = env;
  const calls = [];
  global.fetch = upstream ? (u, o) => { calls.push(String(u)); return upstream(u, o); } : () => { throw new Error('unexpected upstream call'); };
  const res = mockRes();
  await handler({ method, query }, res);
  return { res, calls };
}
const CSV = 'latitude,longitude,bright_ti4\n34.1,-118.5,330\n';
const ok = (text, status=200) => () => Promise.resolve({ ok: status>=200&&status<300, status, text: () => Promise.resolve(text) });

let passed = 0;
async function t(name, fn){ try{ await fn(); passed++; console.log('  ✓ ' + name); }catch(e){ console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } }

(async () => {
  console.log('api/firms.js');
  await t('returns the CSV and caches it at the edge; key only goes upstream', async () => {
    const { res, calls } = await call(GOOD, { upstream: ok(CSV) });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, CSV);
    assert(/s-maxage=\d+/.test(res.headers['cache-control']), 'edge caching missing');
    assert.strictEqual(calls.length, 1);
    assert(calls[0].startsWith('https://firms.modaps.eosdis.nasa.gov/api/area/csv/' + SECRET + '/VIIRS_SNPP_NRT/-118.6000,34.0000,-118.4000,34.2000/1'), calls[0]);
  });
  await t('never leaks the key in any response, success or failure', async () => {
    const cases = [
      await call(GOOD, { upstream: ok(CSV) }),
      await call(GOOD, { upstream: () => Promise.reject(new Error('boom ' + SECRET)) }),
      await call(GOOD, { upstream: ok('Invalid MAP_KEY.') }),
      await call(GOOD, { upstream: ok('', 500) }),
    ];
    for(const { res } of cases){
      assert(!(res.body || '').includes(SECRET), 'key leaked in body');
      assert(!JSON.stringify(res.headers).includes(SECRET), 'key leaked in headers');
    }
    assert.deepStrictEqual(cases.slice(1).map(c => c.res.statusCode), [502, 502, 502]);
    assert(cases.slice(1).every(c => c.res.headers['cache-control'] === 'no-store'), 'errors must not be cached');
  });
  await t('503 when FIRMS_MAP_KEY is not configured (and no upstream call)', async () => {
    const { res, calls } = await call(GOOD, { env: null });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(calls.length, 0);
  });
  await t('rejects bad / hostile / oversized bounding boxes without calling upstream', async () => {
    const bad = [
      {}, { ...GOOD, west:'abc' }, { ...GOOD, north:'' }, { ...GOOD, east:'-119' },           // missing/NaN/inverted
      { ...GOOD, west:'-118.6/../x' }, { ...GOOD, south:'999' },                               // injection / out of range
      { west:'-120', east:'-110', south:'30', north:'40' },                                    // bulk-sized
    ];
    for(const q of bad){
      const { res, calls } = await call(q, { upstream: ok(CSV) });
      assert.strictEqual(res.statusCode, 400, JSON.stringify(q));
      assert.strictEqual(calls.length, 0, 'upstream called for ' + JSON.stringify(q));
    }
  });
  await t('only GET is allowed', async () => {
    const { res } = await call(GOOD, { method:'POST', upstream: ok(CSV) });
    assert.strictEqual(res.statusCode, 405);
  });
  console.log(passed + ' proxy check(s) passed');
})();

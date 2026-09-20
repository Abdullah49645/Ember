/**
 * Vercel serverless function: GET /api/firms?west=&south=&east=&north=
 *
 * Proxies NASA FIRMS active-fire detections so the FIRMS MAP_KEY lives ONLY
 * in this server-side function (env var FIRMS_MAP_KEY) and is never sent to,
 * or visible in, the browser. It also sidesteps FIRMS's uncertain browser
 * CORS support, and lets Vercel's edge cache answer repeat requests so many
 * simultaneous users share one upstream call instead of each spending quota.
 *
 * Set FIRMS_MAP_KEY in Vercel -> Project -> Settings -> Environment Variables
 * (and in .env.local for `vercel dev`). Never commit the key.
 */
const FIRMS_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/';
const SOURCE = 'VIIRS_SNPP_NRT';   // same product the client always used
const DAYS = 1;                    // last 24 h
const MAX_SPAN_DEG = 1;            // EMBER queries ~0.16 deg boxes; refuse bulk-sized ones

/** Strict number parse: query params arrive as strings; reject '', NaN, out of range. */
function num(v, lo, hi){
  if(typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

module.exports = async function handler(req, res){
  const fail = (status, error) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ error });
  };

  if(req.method !== 'GET'){
    res.setHeader('Allow', 'GET');
    return fail(405, 'method not allowed');
  }

  const key = process.env.FIRMS_MAP_KEY;
  if(!key) return fail(503, 'FIRMS_MAP_KEY is not configured on the server');

  const q = req.query || {};
  const west = num(q.west, -180, 180), east = num(q.east, -180, 180);
  const south = num(q.south, -90, 90), north = num(q.north, -90, 90);
  if([west, east, south, north].includes(null) || west >= east || south >= north ||
     east - west > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG){
    return fail(400, 'expected numeric west<east, south<north within a 1 degree box');
  }

  // Built only from validated numbers + the server-side key: this is not an open proxy.
  const url = FIRMS_URL + encodeURIComponent(key) + '/' + SOURCE + '/' +
    [west, south, east, north].map(n => n.toFixed(4)).join(',') + '/' + DAYS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let upstream, text;
  try {
    upstream = await fetch(url, { signal: ctrl.signal });
    text = await upstream.text();
  } catch(e) {
    return fail(502, 'NASA FIRMS unreachable');   // deliberately no error detail: it could contain the URL/key
  } finally {
    clearTimeout(timer);
  }

  if(!upstream.ok) return fail(502, 'NASA FIRMS returned HTTP ' + upstream.status);
  if(text.length < 200 && /invalid|exceed|error/i.test(text)) return fail(502, 'NASA FIRMS rejected the server-side request');

  // Same box + same day => same answer. Cache at the edge so N users != N upstream calls.
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=300');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.status(200).send(text);
};

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorker, series, mockFetch, formatUTC } from "./load-worker.mjs";

const ENV = { TWELVE_DATA_API_KEY: "test" };

/* Wednesday 28 Oct 2026 14:30 UTC — London 14:30 (GMT), New York 10:30 (EDT) */
const WEDNESDAY = Date.UTC(2026, 9, 28, 14, 30, 20);

/* ------------------------------------------------------------------ */
/* Time handling                                                       */
/* ------------------------------------------------------------------ */

test("parseTime treats Twelve Data timestamps as UTC", async () => {
  const w = await loadWorker();

  assert.equal(w.parseTime("2026-10-28 14:05:00"), Date.UTC(2026, 9, 28, 14, 5));
  assert.equal(w.parseTime("2026-10-28"), Date.UTC(2026, 9, 28));
  assert.equal(w.parseTime("2026-10-28T14:05:00+01:00"), Date.UTC(2026, 9, 28, 13, 5));
  assert.ok(Number.isNaN(w.parseTime("garbage")));
  assert.ok(Number.isNaN(w.parseTime(undefined)));
});

test("normalizeCandles sorts, dedupes and drops invalid rows", async () => {
  const w = await loadWorker();

  const candles = w.normalizeCandles({
    values: [
      { datetime: "2026-10-28 14:02:00", open: "1", high: "2", low: "0.5", close: "1.5" },
      { datetime: "2026-10-28 14:01:00", open: "1", high: "2", low: "0.5", close: "1.2" },
      { datetime: "2026-10-28 14:01:00", open: "1", high: "2", low: "0.5", close: "1.3" },
      { datetime: "2026-10-28 14:03:00", open: "", high: "2", low: "0.5", close: "1" },
      { datetime: "2026-10-28 14:04:00", open: "1", high: "0.1", low: "0.5", close: "1" }
    ]
  });

  assert.deepEqual(candles.map(c => c.datetime), ["2026-10-28 14:01:00", "2026-10-28 14:02:00"]);
  assert.equal(candles[0].close, 1.3);
});

test("closedCandles removes only a still-forming candle", async () => {
  const w = await loadWorker();
  const t = Date.UTC(2026, 9, 28, 14, 0);
  const candles = [{ time: t - 60000 }, { time: t }];

  assert.equal(w.closedCandles(candles, "1min", t + 30000).length, 1);
  assert.equal(w.closedCandles(candles, "1min", t + 60000).length, 2);
  assert.equal(w.closedCandles(candles, "4h", t + 3 * 3600000).length, 1);
});

test("marketStatus follows New York hours including DST", async () => {
  const w = await loadWorker();

  // Saturday
  assert.equal(w.marketStatus(Date.UTC(2026, 9, 31, 12)).reason, "WEEKEND");
  // Friday 16:59 NY (EDT) open, 17:00 closed
  assert.equal(w.marketStatus(Date.UTC(2026, 9, 30, 20, 59)).open, true);
  assert.equal(w.marketStatus(Date.UTC(2026, 9, 30, 21, 0)).reason, "WEEKEND");
  // Sunday 1 Nov 2026 (EST): 17:59 NY closed, 18:00 NY open
  assert.equal(w.marketStatus(Date.UTC(2026, 10, 1, 22, 59)).reason, "WEEKEND");
  assert.equal(w.marketStatus(Date.UTC(2026, 10, 1, 23, 0)).open, true);
  // Daily break Monday 17:30 NY (EST)
  assert.equal(w.marketStatus(Date.UTC(2026, 10, 2, 22, 30)).reason, "DAILY_BREAK");
  // Mid-week open
  assert.equal(w.marketStatus(WEDNESDAY).open, true);
});

test("tradingSession is DST aware", async () => {
  const w = await loadWorker();

  // Summer: 12:30 UTC = London 13:30 BST, NY 08:30 EDT
  assert.equal(w.tradingSession(Date.UTC(2026, 6, 15, 12, 30)).quality, "BEST");
  // Winter: 12:30 UTC = London 12:30, NY 07:30 EST
  assert.equal(w.tradingSession(Date.UTC(2026, 11, 15, 12, 30)).name, "LONDON");
  assert.equal(w.tradingSession(Date.UTC(2026, 11, 15, 3)).name, "ASIA");
  assert.equal(w.tradingSession(Date.UTC(2026, 11, 15, 23)).name, "OFF SESSION");
});

/* ------------------------------------------------------------------ */
/* Engine logic                                                        */
/* ------------------------------------------------------------------ */

function candlesFrom(points) {
  return points.map(([open, high, low, close], i) => ({
    datetime: formatUTC(Date.UTC(2026, 9, 28) + i * 900000),
    time: Date.UTC(2026, 9, 28) + i * 900000,
    open,
    high,
    low,
    close
  }));
}

test("structure can detect a bearish CHoCH in an HH_HL leg", async () => {
  const w = await loadWorker();
  const pts = [];

  for (let i = 0; i < 15; i++) pts.push([100 + i, 101 + i, 99 + i, 100.5 + i]); // previous leg
  for (let i = 0; i < 14; i++) pts.push([120 + i, 121 + i, 119 + i, 120.5 + i]); // current leg, higher
  pts.push([133, 133.5, 116, 117]); // close breaks the higher low (119) but not the previous low

  const s = w.structure(candlesFrom(pts));

  assert.equal(s.state, "HH_HL");
  assert.equal(s.choch, "BEARISH");
});

test("structure can detect a bullish CHoCH in an LH_LL leg", async () => {
  const w = await loadWorker();
  const pts = [];

  for (let i = 0; i < 15; i++) pts.push([200 - i, 201 - i, 199 - i, 199.5 - i]);
  for (let i = 0; i < 14; i++) pts.push([180 - i, 181 - i, 179 - i, 179.5 - i]);
  pts.push([167, 184, 166.5, 183]);

  const s = w.structure(candlesFrom(pts));

  assert.equal(s.state, "LH_LL");
  assert.equal(s.choch, "BULLISH");
});

test("weightedScore is direction aware (bearish setups score high for SELL)", async () => {
  const w = await loadWorker();
  const bearish = { bullScore: 10, bearScore: 90 };
  const scores = { "1min": bearish, "5min": bearish, "15min": bearish, "1h": bearish, "4h": bearish };

  assert.equal(w.weightedScore(scores, "SELL"), 90);
  assert.equal(w.weightedScore(scores, "BUY"), 10);
  assert.equal(w.weightedScore(scores), 90);
});

test("rsi of a flat series is neutral", async () => {
  const w = await loadWorker();

  assert.equal(w.rsi(Array(30).fill(100)), 50);
});

test("m5Pullback measures depth from the extreme of the whole leg", async () => {
  const w = await loadWorker();
  const pts = [];

  for (let i = 0; i < 15; i++) pts.push([100 + i, 100.5 + i, 99.5 + i, 100 + i]);

  const candles = candlesFrom(pts);
  const legHigh = Math.max(...candles.slice(-12).map(c => c.high));

  const chasing = w.m5Pullback(candles, "BUY", 2, legHigh);
  assert.equal(chasing.state, "CHASING");

  const valid = w.m5Pullback(candles, "BUY", 2, legHigh - 1);
  assert.equal(valid.state, "VALID_PULLBACK");
  assert.equal(valid.depthATR, 0.5);

  const deep = w.m5Pullback(candles, "BUY", 2, legHigh - 5);
  assert.equal(deep.state, "DEEP_PULLBACK");
});

test("buildRiskPlan reports the real reward:risk", async () => {
  const w = await loadWorker();
  const m15 = { structure: { swingHigh: 2410, swingLow: 2390 } };
  const plan = w.buildRiskPlan("BUY", 2400, m15, 2);

  assert.equal(plan.sl, 2389.7);
  assert.equal(plan.tp, 2420.6);
  assert.equal(plan.rr, 2);
  assert.equal(w.buildRiskPlan("SELL", 2420, m15, 2), null);
});

/* ------------------------------------------------------------------ */
/* End-to-end analysis with mocked Twelve Data                         */
/* ------------------------------------------------------------------ */

test("strong downtrend produces a SELL-side decision (not NO TRADE)", async () => {
  const w = await loadWorker();

  mockFetch(interval => ({ body: series(interval, WEDNESDAY, -0.8) }));

  const result = await w.calculateAnalysis(ENV, WEDNESDAY);

  assert.equal(result.dataStatus, "FRESH");
  assert.equal(result.multiTimeframeBias, "BEARISH");
  assert.equal(result.entryConfirmation.direction, "SELL");
  assert.ok(result.setupScore >= 70, `score ${result.setupScore}`);
  assert.ok(["SELL", "WAIT — SELL SETUP"].includes(result.decision), result.decision);
  assert.ok(!result.executionGate.reasons.includes("SCORE_BELOW_70"));
});

test("strong uptrend produces a BUY-side decision", async () => {
  const w = await loadWorker();

  mockFetch(interval => ({ body: series(interval, WEDNESDAY, 0.8) }));

  const result = await w.calculateAnalysis(ENV, WEDNESDAY);

  assert.equal(result.multiTimeframeBias, "BULLISH");
  assert.ok(result.setupScore >= 70, `score ${result.setupScore}`);
  assert.ok(["BUY", "WAIT — BUY SETUP"].includes(result.decision), result.decision);
  assert.equal(result.riskPlan === null, result.execution.executable === false);
});

test("executable result always carries a valid risk plan", async () => {
  const w = await loadWorker();

  for (const slope of [-1.2, -0.8, -0.3, 0.3, 0.8, 1.2]) {
    mockFetch(interval => ({ body: series(interval, WEDNESDAY, slope) }));

    const r = await w.calculateAnalysis(ENV, WEDNESDAY + Math.round(slope * 1000));

    if (r.execution.executable) {
      assert.ok(r.riskPlan);
      assert.ok(r.riskPlan.rr >= w.CONFIG.minRR);
      assert.ok(["BUY", "SELL"].includes(r.decision));
    } else {
      assert.equal(r.riskPlan, null);
      assert.ok(r.executionGate.reasons.length > 0);
    }
  }
});

test("stale data blocks trading", async () => {
  const w = await loadWorker();

  // Data ends 3 hours before "now"
  mockFetch(interval => ({ body: series(interval, WEDNESDAY - 3 * 3600000, 0.8) }));

  const result = await w.calculateAnalysis(ENV, WEDNESDAY);

  assert.equal(result.dataStatus, "DEGRADED");
  assert.equal(result.decision, "NO TRADE");
  assert.equal(result.execution.executable, false);
  assert.deepEqual(result.executionGate.reasons, ["DATA_NOT_FRESH_OR_UNAVAILABLE"]);
});

test("closed market never calls Twelve Data", async () => {
  const w = await loadWorker();
  const calls = mockFetch(interval => ({ body: series(interval, Date.now(), 0.8) }));

  const result = await w.calculateAnalysis(ENV, Date.UTC(2026, 9, 31, 12));

  assert.equal(calls.length, 0);
  assert.equal(result.dataStatus, "WEEKEND");
  assert.deepEqual(result.executionGate.reasons, ["WEEKEND"]);
});

/* ------------------------------------------------------------------ */
/* Caching / rate limit protection                                     */
/* ------------------------------------------------------------------ */

test("concurrent requests share one upstream call and are cached in memory", async () => {
  const w = await loadWorker();
  const calls = mockFetch(async interval => {
    await new Promise(r => setTimeout(r, 20));
    return { body: series(interval, Date.now(), 0.5) };
  });

  const [a, b] = await Promise.all([w.getMarket(ENV, "1min"), w.getMarket(ENV, "1min")]);
  const c = await w.getMarket(ENV, "1min");

  assert.equal(calls.length, 1);
  assert.equal(a.candles.length, 250);
  assert.equal(b.candles.length, 250);
  assert.equal(c.cacheHit, true);
});

test("rate limit falls back to last good data (still freshness checked)", async () => {
  const w = await loadWorker();
  let limited = false;

  mockFetch(interval =>
    limited
      ? { status: 429, body: { code: 429, message: "limit", status: "error" } }
      : { body: series(interval, Date.now(), 0.5) }
  );

  await w.getMarket(ENV, "4h");

  // Expire the memory cache by loading the same instance after TTL: simulate via Date.now shift
  limited = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60000;

  try {
    const fallback = await w.getMarket(ENV, "4h");

    assert.equal(fallback.staleFallback, true);
    assert.equal(fallback.upstreamError.code, 429);
  } finally {
    Date.now = realNow;
  }

  // Without previous data the error propagates
  await assert.rejects(w.getMarket(ENV, "1h"), err => err.code === 429);
});

test("missing API key is reported as CONFIG_ERROR", async () => {
  const w = await loadWorker();

  await assert.rejects(w.getMarket({}, "1min"), err => err.code === "CONFIG_ERROR");
});

/* ------------------------------------------------------------------ */
/* HTTP layer                                                          */
/* ------------------------------------------------------------------ */

test("HTTP routes", async () => {
  const w = await loadWorker();
  const worker = w.default;

  const health = await worker.fetch(new Request("https://x/health"), ENV);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const bad = await worker.fetch(new Request("https://x/api/market?interval=2min"), ENV);
  assert.equal(bad.status, 400);

  const options = await worker.fetch(new Request("https://x/api/analyze", { method: "OPTIONS" }), ENV);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");

  const post = await worker.fetch(new Request("https://x/api/analyze", { method: "POST" }), ENV);
  assert.equal(post.status, 405);

  const missing = await worker.fetch(new Request("https://x/nope"), ENV);
  assert.equal(missing.status, 404);

  mockFetch(interval => ({ body: series(interval, Date.now(), 0.5) }));
  const market = await worker.fetch(new Request("https://x/api/market?interval=5min"), ENV);
  const body = await market.json();
  assert.equal(market.status, 200);
  assert.equal(body.candles.length, 250);
  assert.equal(body.freshness.fresh, true);
});

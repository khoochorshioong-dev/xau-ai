const ENGINE_VERSION = "FINAL-TRADING-ENGINE-1.2";
const SYMBOL = "XAU/USD";

/*
  =========================================================
  MARKET DATA CACHE
  =========================================================

  Twelve Data free tier is limited.

  We deliberately cache each timeframe independently.

  1min  -> 30s
  5min  -> 60s
  15min -> 90s
  1h    -> 180s
  4h    -> 300s

  Analysis itself -> 30s

  Two cache layers are used:
    1. isolate memory (always works, also on *.workers.dev)
    2. caches.default (shared per colo, when available)

  Concurrent requests for the same data share one upstream call.
  If Twelve Data fails (e.g. rate limit), the last good data set is
  reused — it still has to pass the freshness check below.

  IMPORTANT:
  Cache reduces API calls.
  It does NOT bypass freshness validation.
*/

const ANALYSIS_CACHE_TTL = 30;

const MARKET_CACHE_TTL = {
  "1min": 30,
  "5min": 60,
  "15min": 90,
  "1h": 180,
  "4h": 300
};

const TIMEFRAMES = {
  "1min": "1min",
  "5min": "5min",
  "15min": "15min",
  "1h": "1h",
  "4h": "4h"
};

const TIMEFRAME_MINUTES = {
  "1min": 1,
  "5min": 5,
  "15min": 15,
  "1h": 60,
  "4h": 240
};

const FRESHNESS_LIMITS = {
  "1min": 10,
  "5min": 30,
  "15min": 90,
  "1h": 240,
  "4h": 960
};

const SCORE_WEIGHTS = {
  "1min": 0.10,
  "5min": 0.20,
  "15min": 0.25,
  "1h": 0.20,
  "4h": 0.25
};

const CONFIG = {
  minScore: 70,
  minRR: 2,
  targetRR: 2,

  m5MinImpulseATR: 0.35,
  m5MinPullbackATR: 0.05,
  m5MaxPullbackATR: 1.20,

  slATRBuffer: 0.15,

  highVolatilityPct: 0.30,
  lowVolatilityPct: 0.05,

  upstreamTimeoutMs: 10000
};

/* =========================================================
   BASIC
========================================================= */

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "Content-Type"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function num(v, fallback = null) {
  if (v === null || v === undefined || v === "") {
    return fallback;
  }

  const n = Number(v);

  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const n = num(v);

  if (n === null) {
    return null;
  }

  const p = 10 ** d;

  return Math.round(n * p) / p;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function average(values) {
  const a = values.filter(v => Number.isFinite(v));

  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function maxOf(candles, key) {
  return Math.max(...candles.map(x => x[key]));
}

function minOf(candles, key) {
  return Math.min(...candles.map(x => x[key]));
}

/*
  Twelve Data returns "YYYY-MM-DD HH:mm:ss" (or "YYYY-MM-DD" for daily)
  in the requested timezone (UTC). Parse it explicitly as UTC so the
  result never depends on the runtime's local timezone.
*/
function parseTime(datetime) {
  if (typeof datetime !== "string" || !datetime.trim()) {
    return NaN;
  }

  let s = datetime.trim().replace(" ", "T");

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s += "T00:00:00";
  }

  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    s += "Z";
  }

  return Date.parse(s);
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (!values.length) {
    return [];
  }

  const k = 2 / (period + 1);
  const output = [values[0]];

  for (let i = 1; i < values.length; i++) {
    output.push(values[i] * k + output[i - 1] * (1 - k));
  }

  return output;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length < 2) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return average(trs.slice(-period));
}

function macd(values) {
  if (!values.length) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] - slow[i]);
  const signal = ema(line, 9);

  const m = line.at(-1) || 0;
  const s = signal.at(-1) || 0;

  return { macd: m, signal: s, histogram: m - s };
}

/* =========================================================
   DATA NORMALIZATION
========================================================= */

function normalizeCandles(raw) {
  const values = Array.isArray(raw?.values) ? raw.values : [];
  const byTime = new Map();

  for (const x of values) {
    const candle = {
      datetime: x?.datetime,
      time: parseTime(x?.datetime),
      open: num(x?.open),
      high: num(x?.high),
      low: num(x?.low),
      close: num(x?.close)
    };

    if (
      !Number.isFinite(candle.time) ||
      candle.open === null ||
      candle.high === null ||
      candle.low === null ||
      candle.close === null ||
      candle.high < candle.low
    ) {
      continue;
    }

    byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/*
  The last candle returned by Twelve Data is usually still forming.
  Signals computed on it repaint, so all structure / pattern / indicator
  logic runs on CLOSED candles only. The live price is still used for
  display, pullback depth and entry.
*/
function closedCandles(candles, tf, now = Date.now()) {
  const last = candles.at(-1);
  const minutes = TIMEFRAME_MINUTES[tf];

  if (!last || !minutes) {
    return candles;
  }

  return last.time + minutes * 60000 > now
    ? candles.slice(0, -1)
    : candles;
}

/* =========================================================
   MARKET HOURS & SESSION (DST aware)

   Spot gold trades Sunday 18:00 → Friday 17:00 New York time,
   with a daily break 17:00 → 18:00 New York time.
========================================================= */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));

  return {
    day: WEEKDAYS[get("weekday")],
    hour,
    minutes: hour * 60 + minute
  };
}

function marketStatus(now = Date.now()) {
  const ny = zonedClock(new Date(now), "America/New_York");
  const close = 17 * 60;
  const open = 18 * 60;

  const weekend =
    ny.day === 6 ||
    (ny.day === 5 && ny.minutes >= close) ||
    (ny.day === 0 && ny.minutes < open);

  if (weekend) {
    return { open: false, reason: "WEEKEND" };
  }

  if (ny.minutes >= close && ny.minutes < open) {
    return { open: false, reason: "DAILY_BREAK" };
  }

  return { open: true, reason: "OPEN" };
}

function tradingSession(now = Date.now()) {
  const date = new Date(now);
  const london = zonedClock(date, "Europe/London").hour;
  const newYork = zonedClock(date, "America/New_York").hour;

  const inLondon = london >= 8 && london < 17;
  const inNewYork = newYork >= 8 && newYork < 17;

  if (inLondon && inNewYork) {
    return { name: "LONDON / NEW YORK OVERLAP", quality: "BEST" };
  }

  if (inLondon) {
    return { name: "LONDON", quality: "GOOD" };
  }

  if (inNewYork) {
    return { name: "NEW YORK", quality: "GOOD" };
  }

  if (london < 8) {
    return { name: "ASIA", quality: "LOW" };
  }

  return { name: "OFF SESSION", quality: "LOW" };
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function structure(candles) {
  if (candles.length < 30) {
    return {
      state: "UNKNOWN",
      bos: "NONE",
      choch: "NONE",
      swingHigh: null,
      swingLow: null
    };
  }

  const lookback = candles.slice(-30);
  const previous = lookback.slice(0, 15);
  const current = lookback.slice(15);

  const previousHigh = maxOf(previous, "high");
  const previousLow = minOf(previous, "low");
  const currentHigh = maxOf(current, "high");
  const currentLow = minOf(current, "low");

  const price = candles.at(-1).close;

  let state = "RANGE";

  if (currentHigh > previousHigh && currentLow > previousLow) {
    state = "HH_HL";
  } else if (currentHigh < previousHigh && currentLow < previousLow) {
    state = "LH_LL";
  }

  let bos = "NONE";

  if (price > previousHigh) {
    bos = "BULLISH";
  } else if (price < previousLow) {
    bos = "BEARISH";
  }

  /*
    CHoCH = the latest close breaks the most recent protected swing
    against the prevailing structure (the higher low in HH_HL, the
    lower high in LH_LL). The protected swing is taken from the current
    leg excluding the latest candle.
  */
  const leg = current.slice(0, -1);
  const protectedLow = minOf(leg, "low");
  const protectedHigh = maxOf(leg, "high");

  let choch = "NONE";

  if (state === "HH_HL" && price < protectedLow) {
    choch = "BEARISH";
  }

  if (state === "LH_LL" && price > protectedHigh) {
    choch = "BULLISH";
  }

  return {
    state,
    bos,
    choch,
    swingHigh: round(Math.max(previousHigh, currentHigh), 2),
    swingLow: round(Math.min(previousLow, currentLow), 2)
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function liquiditySweep(candles) {
  if (candles.length < 25) {
    return "NONE";
  }

  const previous = candles.slice(-21, -1);
  const high = maxOf(previous, "high");
  const low = minOf(previous, "low");
  const current = candles.at(-1);

  if (current.high > high && current.close < high) {
    return "BEARISH_SWEEP";
  }

  if (current.low < low && current.close > low) {
    return "BULLISH_SWEEP";
  }

  return "NONE";
}

/* =========================================================
   CANDLE
========================================================= */

function candleInfo(candles) {
  if (candles.length < 2) {
    return {
      direction: "NEUTRAL",
      pattern: "NONE",
      impulse: false,
      rejection: false
    };
  }

  const c = candles.at(-1);
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 0.00001);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  let direction = "NEUTRAL";

  if (c.close > c.open) {
    direction = "BULLISH";
  }

  if (c.close < c.open) {
    direction = "BEARISH";
  }

  const impulse = body / range >= 0.65;
  const bullishRejection = lower > body * 1.5 && lower > upper * 1.2;
  const bearishRejection = upper > body * 1.5 && upper > lower * 1.2;

  let pattern = "NORMAL";

  if (bullishRejection) {
    pattern = "BULLISH_REJECTION";
  } else if (bearishRejection) {
    pattern = "BEARISH_REJECTION";
  } else if (impulse && direction !== "NEUTRAL") {
    pattern = direction === "BULLISH" ? "BULLISH_IMPULSE" : "BEARISH_IMPULSE";
  }

  return {
    direction,
    pattern,
    impulse,
    rejection: bullishRejection || bearishRejection,
    body: round(body, 3),
    range: round(range, 3)
  };
}

/* =========================================================
   TIMEFRAME ANALYSIS

   bullScore: 0–100, 50 = neutral, >50 bullish pressure
   bearScore: 100 - bullScore
   setupScore: strength of the dominant side on this timeframe
========================================================= */

function analyzeTimeframe(candles, livePrice = null) {
  const lastClose = candles.at(-1)?.close ?? null;
  const price = livePrice ?? lastClose;

  if (candles.length < 50) {
    return {
      bias: "NEUTRAL",
      setupScore: 0,
      bullScore: 50,
      bearScore: 50,
      trend: "NEUTRAL",
      structure: structure(candles),
      liquidity: "NONE",
      momentum: { rsi: 50, macd: 0, signal: 0, histogram: 0 },
      atr: 0,
      price: round(price, 2),
      candleTime: candles.at(-1)?.datetime || null
    };
  }

  const closes = candles.map(x => x.close);
  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const e200 = ema(closes, 200).at(-1);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(candles);
  const s = structure(candles);
  const l = liquiditySweep(candles);
  const c = candleInfo(candles);

  let bull = 0;
  let bear = 0;

  if (lastClose > e20) bull++; else bear++;
  if (e20 > e50) bull++; else bear++;
  if (e50 > e200) bull++; else bear++;

  if (r > 52) bull++;
  else if (r < 48) bear++;

  if (m.histogram > 0) bull++;
  else if (m.histogram < 0) bear++;

  if (s.state === "HH_HL" || s.bos === "BULLISH" || s.choch === "BULLISH") {
    bull += 2;
  }

  if (s.state === "LH_LL" || s.bos === "BEARISH" || s.choch === "BEARISH") {
    bear += 2;
  }

  let bias = "NEUTRAL";

  if (bull >= bear + 2) {
    bias = "BULLISH";
  } else if (bear >= bull + 2) {
    bias = "BEARISH";
  }

  const bosBonus = s.bos === "BULLISH" ? 5 : s.bos === "BEARISH" ? -5 : 0;
  const bullScore = clamp(Math.round(50 + (bull - bear) * 8 + bosBonus), 0, 100);
  const bearScore = 100 - bullScore;

  return {
    bias,
    setupScore: Math.max(bullScore, bearScore),
    bullScore,
    bearScore,
    trend: bias,
    structure: s,
    liquidity: l,
    momentum: {
      rsi: round(r, 2),
      macd: round(m.macd, 4),
      signal: round(m.signal, 4),
      histogram: round(m.histogram, 4)
    },
    atr: round(a, 3),
    price: round(price, 2),
    ema20: round(e20, 2),
    ema50: round(e50, 2),
    ema200: round(e200, 2),
    candleTime: candles.at(-1)?.datetime || null,
    candleMetrics: c
  };
}

/* =========================================================
   WEIGHTED SCORE (direction aware)

   BUY  -> weighted bullScore
   SELL -> weighted bearScore
   NONE -> the stronger of the two
========================================================= */

function weightedScore(scores, direction = "NONE") {
  let bull = 0;
  let bear = 0;
  let weight = 0;

  for (const [tf, w] of Object.entries(SCORE_WEIGHTS)) {
    const s = scores[tf];

    if (!s) {
      continue;
    }

    bull += (s.bullScore ?? 50) * w;
    bear += (s.bearScore ?? 50) * w;
    weight += w;
  }

  if (!weight) {
    return 0;
  }

  bull /= weight;
  bear /= weight;

  if (direction === "BUY") {
    return Math.round(bull);
  }

  if (direction === "SELL") {
    return Math.round(bear);
  }

  return Math.round(Math.max(bull, bear));
}

/* =========================================================
   HIGHER TIMEFRAME DIRECTION

   STRICT FINAL RULE
   BUY:  H4 + H1 + M15 = BULLISH
   SELL: H4 + H1 + M15 = BEARISH
========================================================= */

function higherDirection(scores) {
  const h4 = scores["4h"]?.bias;
  const h1 = scores["1h"]?.bias;
  const m15 = scores["15min"]?.bias;

  if (h4 === "BULLISH" && h1 === "BULLISH" && m15 === "BULLISH") {
    return "BUY";
  }

  if (h4 === "BEARISH" && h1 === "BEARISH" && m15 === "BEARISH") {
    return "SELL";
  }

  return "NONE";
}

/* =========================================================
   M15 GATES
========================================================= */

function m15StructureGate(m15, direction) {
  if (!m15) {
    return false;
  }

  const s = m15.structure;

  if (direction === "BUY") {
    return s.state === "HH_HL" || s.bos === "BULLISH" || s.choch === "BULLISH";
  }

  return s.state === "LH_LL" || s.bos === "BEARISH" || s.choch === "BEARISH";
}

function m15LiquidityGate(m15, direction) {
  if (!m15) {
    return false;
  }

  const s = m15.structure;
  const l = m15.liquidity;

  if (direction === "BUY") {
    return l === "BULLISH_SWEEP" || s.bos === "BULLISH" || s.choch === "BULLISH";
  }

  return l === "BEARISH_SWEEP" || s.bos === "BEARISH" || s.choch === "BEARISH";
}

/* =========================================================
   M5 PULLBACK

   Impulse: first 6 of the last 12 closed M5 candles must move at
   least 0.35 ATR in the trade direction.
   Pullback depth: distance of the live price from the extreme of
   the whole 12-candle leg (so a fresh high after the impulse is
   respected), in ATR.
========================================================= */

function m5Pullback(candles, direction, atrValue, livePrice = null) {
  if (candles.length < 15 || !atrValue) {
    return { valid: false, state: "INSUFFICIENT_DATA", depthATR: null };
  }

  const recent = candles.slice(-12);
  const impulse = recent.slice(0, 6);

  const impulseStart = impulse[0].close;
  const impulseEnd = impulse.at(-1).close;
  const impulseMove =
    direction === "BUY" ? impulseEnd - impulseStart : impulseStart - impulseEnd;
  const impulseATR = round(Math.abs(impulseMove) / atrValue, 2);

  if (impulseMove < atrValue * CONFIG.m5MinImpulseATR) {
    return {
      valid: false,
      state: "NO_M5_IMPULSE",
      depthATR: null,
      impulseATR
    };
  }

  const legHigh = maxOf(recent, "high");
  const legLow = minOf(recent, "low");
  const current = livePrice ?? recent.at(-1).close;

  const depth =
    direction === "BUY"
      ? Math.max(0, legHigh - current) / atrValue
      : Math.max(0, current - legLow) / atrValue;

  let state = "VALID_PULLBACK";

  if (depth < CONFIG.m5MinPullbackATR) {
    state = "CHASING";
  } else if (depth > CONFIG.m5MaxPullbackATR) {
    state = "DEEP_PULLBACK";
  }

  return {
    valid: state === "VALID_PULLBACK",
    state,
    depthATR: round(depth, 2),
    impulseATR
  };
}

/* =========================================================
   M1 CONFIRMATION (closed candles only — no repainting)
========================================================= */

function m1Confirmation(candles, direction) {
  if (candles.length < 8) {
    return {
      confirmed: false,
      microBOS: false,
      candleConfirmation: false,
      pattern: "NONE",
      reason: "INSUFFICIENT_DATA"
    };
  }

  const current = candles.at(-1);
  const previous = candles.slice(-6, -1);
  const previousHigh = maxOf(previous, "high");
  const previousLow = minOf(previous, "low");
  const candle = candleInfo(candles);

  const microBOS =
    direction === "BUY"
      ? current.close > previousHigh
      : current.close < previousLow;

  const candleConfirmation =
    direction === "BUY"
      ? candle.direction === "BULLISH" &&
        (candle.impulse || candle.pattern === "BULLISH_REJECTION")
      : candle.direction === "BEARISH" &&
        (candle.impulse || candle.pattern === "BEARISH_REJECTION");

  const confirmed = microBOS || candleConfirmation;

  return {
    confirmed,
    microBOS,
    candleConfirmation,
    pattern: candle.pattern,
    reason: confirmed ? "M1_CONFIRMATION_CONFIRMED" : "NO_M1_CONFIRMATION"
  };
}

/* =========================================================
   VOLATILITY
========================================================= */

function volatilityStatus(scores) {
  const h1 = scores["1h"];

  if (!h1 || !h1.price || !h1.atr) {
    return { state: "UNKNOWN", atrPercent: null, warning: true };
  }

  const pct = (h1.atr / h1.price) * 100;

  if (pct >= CONFIG.highVolatilityPct) {
    return { state: "HIGH", atrPercent: round(pct, 3), warning: true };
  }

  if (pct <= CONFIG.lowVolatilityPct) {
    return { state: "LOW", atrPercent: round(pct, 3), warning: true };
  }

  return { state: "NORMAL", atrPercent: round(pct, 3), warning: false };
}

/* =========================================================
   MARKET CONDITION
========================================================= */

function marketCondition(scores) {
  const values = Object.values(scores);
  const bull = values.filter(x => x.bias === "BULLISH").length;
  const bear = values.filter(x => x.bias === "BEARISH").length;

  if (bull >= 4) return "STRONG_BULLISH";
  if (bear >= 4) return "STRONG_BEARISH";
  if (bull >= 3) return "BULLISH";
  if (bear >= 3) return "BEARISH";

  return "MIXED";
}

/* =========================================================
   RISK PLAN
========================================================= */

function buildRiskPlan(direction, entry, m15, atrValue) {
  if (!direction || !entry || !m15 || !atrValue) {
    return null;
  }

  const s = m15.structure;

  if (s.swingHigh === null || s.swingLow === null) {
    return null;
  }

  const sl =
    direction === "BUY"
      ? s.swingLow - atrValue * CONFIG.slATRBuffer
      : s.swingHigh + atrValue * CONFIG.slATRBuffer;

  if (direction === "BUY" ? sl >= entry : sl <= entry) {
    return null;
  }

  const risk = Math.abs(entry - sl);

  if (!(risk > 0)) {
    return null;
  }

  const reward = risk * CONFIG.targetRR;
  const tp = direction === "BUY" ? entry + reward : entry - reward;

  return {
    entry: round(entry, 2),
    sl: round(sl, 2),
    tp: round(tp, 2),
    riskDistance: round(risk, 2),
    rewardDistance: round(reward, 2),
    rr: round(reward / risk, 2),
    method: "M15_STRUCTURE + ATR_BUFFER",
    note: "Position size must be calculated from account risk."
  };
}

/* =========================================================
   CACHE HELPERS
========================================================= */

const memoryCache = new Map();
const inflight = new Map();
const lastGoodMarket = new Map();

function memoryGet(key) {
  const entry = memoryCache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expires <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  return entry.value;
}

function memorySet(key, value, ttlSeconds) {
  memoryCache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

function edgeCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheRequest(key) {
  return new Request(`https://cache.xau-ai.local/v3/${key}`);
}

async function readCache(key) {
  const memory = memoryGet(key);

  if (memory) {
    return memory;
  }

  const cache = edgeCache();

  if (!cache) {
    return null;
  }

  try {
    const response = await cache.match(cacheRequest(key));

    if (!response) {
      return null;
    }

    const value = await response.json();
    const expires = num(response.headers.get("x-expires-at"));

    if (expires !== null) {
      if (expires <= Date.now()) {
        return null;
      }

      memoryCache.set(key, { value, expires });
    }

    return value;
  } catch {
    return null;
  }
}

async function writeCache(key, value, ttlSeconds) {
  memorySet(key, value, ttlSeconds);

  const cache = edgeCache();

  if (!cache) {
    return;
  }

  try {
    await cache.put(
      cacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${ttlSeconds}`,
          "x-expires-at": String(Date.now() + ttlSeconds * 1000)
        }
      })
    );
  } catch {
    /* Cache failures must never break analysis. */
  }
}

function dedupe(key, task) {
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      return await task();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);

  return promise;
}

/* =========================================================
   TWELVE DATA
========================================================= */

function upstreamError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchTwelveData(env, interval) {
  const apiKey = env?.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    throw upstreamError("TWELVE_DATA_API_KEY missing", "CONFIG_ERROR");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", "250");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apiKey);

  let response;

  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs)
    });
  } catch (error) {
    throw upstreamError(
      error?.name === "TimeoutError"
        ? "Twelve Data request timed out"
        : `Twelve Data network error: ${error?.message || error}`,
      error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"
    );
  }

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.status === 429 || data?.code === 429) {
    throw upstreamError(data?.message || "Twelve Data API rate limit reached", 429);
  }

  if (!response.ok || !data || data.status === "error") {
    throw upstreamError(
      data?.message || `Twelve Data HTTP ${response.status}`,
      data?.code || response.status
    );
  }

  const candles = normalizeCandles(data);

  if (!candles.length) {
    throw upstreamError("No market data returned", "NO_DATA");
  }

  return {
    ok: true,
    interval,
    symbol: SYMBOL,
    candles,
    fetchedAt: new Date().toISOString(),
    cacheHit: false
  };
}

async function getMarket(env, interval) {
  const key = `market/${interval}`;
  const cached = await readCache(key);

  if (cached) {
    return { ...cached, cacheHit: true };
  }

  return dedupe(key, async () => {
    try {
      const result = await fetchTwelveData(env, interval);

      lastGoodMarket.set(interval, result);
      await writeCache(key, result, MARKET_CACHE_TTL[interval] || 60);

      return result;
    } catch (error) {
      /*
        Upstream failed (rate limit, timeout...). Reuse the last good
        data of this isolate. It is NOT trusted blindly: the freshness
        check still decides whether it may be used for trading.
      */
      const fallback = lastGoodMarket.get(interval);

      if (fallback && error?.code !== "CONFIG_ERROR") {
        return {
          ...fallback,
          cacheHit: true,
          staleFallback: true,
          upstreamError: { code: error?.code ?? "DATA_ERROR", message: error?.message }
        };
      }

      throw error;
    }
  });
}

/* =========================================================
   FRESHNESS
========================================================= */

function freshness(candles, tf, now = Date.now()) {
  const limit = FRESHNESS_LIMITS[tf];
  const last = candles.at(-1);

  if (!last?.datetime) {
    return { fresh: false, ageMinutes: null, limitMinutes: limit, reason: "NO_TIMESTAMP" };
  }

  const time = Number.isFinite(last.time) ? last.time : parseTime(last.datetime);

  if (!Number.isFinite(time)) {
    return { fresh: false, ageMinutes: null, limitMinutes: limit, reason: "INVALID_TIMESTAMP" };
  }

  const ageMinutes = Math.max(0, Math.round((now - time) / 60000));
  const fresh = ageMinutes <= limit;

  return {
    fresh,
    ageMinutes,
    limitMinutes: limit,
    reason: fresh ? "FRESH" : `STALE>${limit}MIN`
  };
}

/* =========================================================
   RESPONSE BUILDERS
========================================================= */

function baseSafety(now, extra = {}) {
  return {
    weekend: false,
    session: tradingSession(now),
    newsRisk: "NOT CHECKED",
    spread: "NOT CHECKED",
    slippage: "NOT CHECKED",
    ...extra
  };
}

function lockedResponse(fields) {
  return {
    ok: true,
    engine: ENGINE_VERSION,
    symbol: SYMBOL,
    decision: "NO TRADE",
    setupScore: 0,
    price: null,
    multiTimeframeBias: "NONE",
    analysis: {},
    freshness: {},
    dataStatus: "DEGRADED",
    unavailable: [],
    entryConfirmation: null,
    riskPlan: null,
    execution: { state: "NO_TRADE", executable: false },
    generatedAt: new Date().toISOString(),
    ...fields
  };
}

function closedResponse(status, now) {
  const weekend = status.reason === "WEEKEND";

  return lockedResponse({
    dataStatus: weekend ? "WEEKEND" : "MARKET_CLOSED",
    marketStatus: status,
    safety: baseSafety(now, {
      weekend,
      volatility: { state: "N/A", atrPercent: null, warning: false },
      marketCondition: "CLOSED"
    }),
    executionGate: { passed: false, reasons: [status.reason] }
  });
}

function degradedResponse(scores, freshState, unavailable, now) {
  return lockedResponse({
    setupScore: weightedScore(scores),
    price: scores["1min"]?.price || scores["5min"]?.price || null,
    multiTimeframeBias: "MIXED",
    analysis: scores,
    freshness: freshState,
    dataStatus: "DEGRADED",
    unavailable,
    marketStatus: { open: true, reason: "OPEN" },
    safety: baseSafety(now, {
      volatility: volatilityStatus(scores),
      marketCondition: marketCondition(scores)
    }),
    executionGate: { passed: false, reasons: ["DATA_NOT_FRESH_OR_UNAVAILABLE"] }
  });
}

/* =========================================================
   FINAL ANALYSIS
========================================================= */

async function calculateAnalysis(env, now = Date.now()) {
  const status = marketStatus(now);

  if (!status.open) {
    return closedResponse(status, now);
  }

  const tfNames = Object.keys(TIMEFRAMES);

  const results = await Promise.allSettled(
    tfNames.map(tf => getMarket(env, TIMEFRAMES[tf]))
  );

  const scores = {};
  const closed = {};
  const freshState = {};
  const unavailable = [];

  results.forEach((result, i) => {
    const tf = tfNames[i];

    if (result.status !== "fulfilled") {
      unavailable.push({
        timeframe: tf,
        code: result.reason?.code || "DATA_ERROR",
        error: result.reason?.message || String(result.reason)
      });
      return;
    }

    const raw = result.value.candles;

    freshState[tf] = freshness(raw, tf, now);

    if (!freshState[tf].fresh) {
      unavailable.push({ timeframe: tf, code: "STALE_DATA", error: freshState[tf].reason });
      return;
    }

    closed[tf] = closedCandles(raw, tf, now);
    scores[tf] = analyzeTimeframe(closed[tf], raw.at(-1)?.close ?? null);
  });

  /*
    STRICT DATA PROTECTION
    Missing or stale data ALWAYS blocks trading.
  */
  const allFresh = tfNames.every(tf => freshState[tf]?.fresh === true);

  if (!allFresh || unavailable.length) {
    return degradedResponse(scores, freshState, unavailable, now);
  }

  const direction = higherDirection(scores);
  const score = weightedScore(scores, direction);
  const price = scores["1min"]?.price || null;
  const volatility = volatilityStatus(scores);
  const condition = marketCondition(scores);

  const common = {
    ok: true,
    engine: ENGINE_VERSION,
    symbol: SYMBOL,
    setupScore: score,
    price: round(price, 2),
    analysis: scores,
    freshness: freshState,
    dataStatus: "FRESH",
    unavailable: [],
    marketStatus: status,
    safety: baseSafety(now, { volatility, marketCondition: condition })
  };

  /* ------------------------- HIGHER TF CONFLICT ------------------------- */

  if (direction === "NONE") {
    return {
      ...common,
      decision: score >= 50 ? "WAIT — MARKET CONFLICT" : "NO TRADE",
      multiTimeframeBias: "MIXED",
      entryConfirmation: null,
      riskPlan: null,
      execution: { state: "WAIT_CONFLICT", executable: false },
      executionGate: { passed: false, reasons: ["H4_H1_M15_NOT_ALIGNED"] },
      generatedAt: new Date().toISOString()
    };
  }

  /* ------------------------------- M15 --------------------------------- */

  const m15 = scores["15min"];
  const m15StructurePassed = m15StructureGate(m15, direction);
  const m15LiquidityPassed = m15LiquidityGate(m15, direction);

  /* -------------------------------- M5 --------------------------------- */

  const m5 = scores["5min"];
  const pullback = m5Pullback(closed["5min"], direction, m5.atr, price);
  const m5Aligned = direction === "BUY" ? m5.bias === "BULLISH" : m5.bias === "BEARISH";

  /* -------------------------------- M1 --------------------------------- */

  const m1 = scores["1min"];
  const confirmation = m1Confirmation(closed["1min"], direction);
  const m1Aligned = direction === "BUY" ? m1.bias !== "BEARISH" : m1.bias !== "BULLISH";

  /* ------------------------- SCORE / VOL / RISK ------------------------ */

  const scorePassed = score >= CONFIG.minScore;
  const volatilityPassed = !volatility.warning;
  const plan = buildRiskPlan(direction, price, m15, m15.atr);
  const rrPassed = !!plan && plan.rr >= CONFIG.minRR;

  /* -------------------------- EXECUTION GATE --------------------------- */

  const checks = [
    [m15StructurePassed, "M15_STRUCTURE_FAILED", "M15_STRUCTURE_CONFIRMED"],
    [m15LiquidityPassed, "M15_LIQUIDITY_OR_BOS_FAILED", "M15_LIQUIDITY_OR_BOS_CONFIRMED"],
    [pullback.valid, `M5_${pullback.state}`, "M5_PULLBACK_CONFIRMED"],
    [confirmation.confirmed, "M1_CONFIRMATION_FAILED", "M1_CONFIRMATION_CONFIRMED"],
    [m5Aligned, "M5_NOT_ALIGNED", "M5_ALIGNED"],
    [m1Aligned, "M1_NOT_ALIGNED", "M1_ALIGNED"],
    [scorePassed, `SCORE_BELOW_${CONFIG.minScore}`, `SCORE_GE_${CONFIG.minScore}`],
    [volatilityPassed, "VOLATILITY_WARNING", "VOLATILITY_ACCEPTABLE"],
    [rrPassed, "RR_BELOW_1_TO_2", "RR_GE_1_TO_2"]
  ];

  const executable = checks.every(([passed]) => passed);

  const reasons = executable
    ? ["H4_H1_M15_ALIGNED", ...checks.map(([, , ok]) => ok)]
    : checks.filter(([passed]) => !passed).map(([, fail]) => fail);

  /* ----------------------------- DECISION ------------------------------ */

  let decision;

  if (executable) {
    decision = direction;
  } else if (score >= 50) {
    decision = direction === "BUY" ? "WAIT — BUY SETUP" : "WAIT — SELL SETUP";
  } else {
    decision = "NO TRADE";
  }

  /* WAIT IS NEVER EXECUTABLE. */
  const executionState = executable
    ? direction === "BUY" ? "TRADE_BUY" : "TRADE_SELL"
    : decision === "WAIT — BUY SETUP"
      ? "WAIT_BUY"
      : decision === "WAIT — SELL SETUP"
        ? "WAIT_SELL"
        : "NO_TRADE";

  return {
    ...common,
    decision,
    multiTimeframeBias: direction === "BUY" ? "BULLISH" : "BEARISH",
    entryConfirmation: {
      direction,
      m15: {
        structurePassed: m15StructurePassed,
        liquidityPassed: m15LiquidityPassed,
        structure: m15.structure,
        liquidity: m15.liquidity
      },
      m5: { aligned: m5Aligned, pullback },
      m1: { aligned: m1Aligned, confirmation },
      scorePassed,
      volatilityPassed,
      rrPassed,
      confirmed: executable
    },
    riskPlan: executable ? plan : null,
    execution: { state: executionState, executable },
    executionGate: { passed: executable, reasons },
    generatedAt: new Date().toISOString()
  };
}

/* =========================================================
   ANALYSIS CACHE
========================================================= */

async function runAnalysis(env) {
  const key = "analyze";
  const cached = await readCache(key);

  if (cached) {
    return { ...cached, cache: { analysisCacheHit: true } };
  }

  return dedupe(key, async () => {
    const result = await calculateAnalysis(env);

    /*
      Cache only successful structured analysis.
      Thrown errors are never cached.
    */
    await writeCache(key, result, ANALYSIS_CACHE_TTL);

    return { ...result, cache: { analysisCacheHit: false } };
  });
}

/* =========================================================
   CLOUDFLARE WORKER
========================================================= */

function healthPayload() {
  return {
    ok: true,
    service: "XAU AI API",
    status: "online",
    symbol: SYMBOL,
    engine: ENGINE_VERSION,
    market: marketStatus(),
    analysisCacheTtlSeconds: ANALYSIS_CACHE_TTL,
    marketCacheTtlSeconds: MARKET_CACHE_TTL
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET, OPTIONS" });
    }

    /* ------------------------------ HEALTH ------------------------------ */

    if (url.pathname === "/" || url.pathname === "/health") {
      return json(healthPayload());
    }

    /* ------------------------------ MARKET ------------------------------ */

    if (url.pathname === "/api/market") {
      const interval = url.searchParams.get("interval") || "1min";
      const tf = Object.keys(TIMEFRAMES).find(key => TIMEFRAMES[key] === interval);

      if (!tf) {
        return json(
          { ok: false, error: "INVALID_INTERVAL", allowed: Object.values(TIMEFRAMES) },
          400
        );
      }

      try {
        const data = await getMarket(env, interval);

        return json({
          ok: true,
          engine: ENGINE_VERSION,
          symbol: SYMBOL,
          interval,
          price: data.candles.at(-1)?.close ?? null,
          freshness: freshness(data.candles, tf),
          cacheHit: data.cacheHit || false,
          staleFallback: data.staleFallback || false,
          candles: data.candles
        });
      } catch (error) {
        const code = error?.code || "DATA_ERROR";

        return json(
          {
            ok: false,
            error: code === 429 ? "DATA_LIMIT" : "MARKET_DATA_ERROR",
            code,
            details: error?.message || String(error)
          },
          code === 429 ? 429 : 502
        );
      }
    }

    /* ------------------------------ ANALYZE ----------------------------- */

    if (url.pathname === "/api/analyze") {
      try {
        return json(await runAnalysis(env));
      } catch (error) {
        return json(
          {
            ok: false,
            engine: ENGINE_VERSION,
            error: "ANALYSIS_FAILED",
            code: error?.code || "UNKNOWN",
            details: error?.message || String(error)
          },
          502
        );
      }
    }

    /* ------------------------------- 404 -------------------------------- */

    return json({ ok: false, error: "NOT_FOUND", engine: ENGINE_VERSION }, 404);
  }
};

const ENGINE_VERSION = "FINAL-TRADING-ENGINE-1.0";
const CACHE_TTL = 15;
const SYMBOL = "XAU/USD";

const TIMEFRAMES = {
  "1min": "1min",
  "5min": "5min",
  "15min": "15min",
  "1h": "1h",
  "4h": "4h"
};

const FRESHNESS_LIMITS = {
  "1min": 10,
  "5min": 30,
  "15min": 90,
  "1h": 240,
  "4h": 960
};

const CONFIG = {
  minScore: 70,
  minRR: 2,
  m5MinPullbackATR: 0.05,
  m5MaxPullbackATR: 1.20,
  slATRBuffer: 0.15,
  highVolatilityPct: 0.30,
  lowVolatilityPct: 0.05
};

/* =========================
   BASIC HELPERS
========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "Content-Type"
    }
  });
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const n = num(v);
  if (n === null) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function average(values) {
  const a = values.filter(Number.isFinite);
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

/* =========================
   INDICATORS
========================= */

function ema(values, period) {
  if (!values.length) return [];

  const k = 2 / (period + 1);
  const out = [values[0]];

  for (let i = 1; i < values.length; i++) {
    out.push(
      values[i] * k +
      out[i - 1] * (1 - k)
    );
  }

  return out;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);

    avgGain =
      (avgGain * (period - 1) + g) / period;

    avgLoss =
      (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;

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
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = values.map(
    (_, i) => fast[i] - slow[i]
  );

  const signal = ema(line, 9);

  const m = line.at(-1) || 0;
  const s = signal.at(-1) || 0;

  return {
    macd: m,
    signal: s,
    histogram: m - s
  };
}

/* =========================
   DATA NORMALIZATION
========================= */

function normalizeCandles(raw) {
  const values = Array.isArray(raw?.values)
    ? raw.values
    : [];

  return values
    .map(x => ({
      datetime: x.datetime,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close)
    }))
    .filter(x =>
      x.datetime &&
      x.open !== null &&
      x.high !== null &&
      x.low !== null &&
      x.close !== null
    )
    .sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );
}

/* =========================
   SESSION / MARKET STATE
========================= */

function tradingSession() {
  const hour = new Date().getUTCHours();

  if (hour < 7) {
    return {
      name: "ASIA",
      quality: "LOW"
    };
  }

  if (hour < 13) {
    return {
      name: "LONDON",
      quality: "GOOD"
    };
  }

  if (hour < 16) {
    return {
      name: "LONDON / NEW YORK OVERLAP",
      quality: "BEST"
    };
  }

  if (hour < 21) {
    return {
      name: "NEW YORK",
      quality: "GOOD"
    };
  }

  return {
    name: "OFF SESSION",
    quality: "LOW"
  };
}

function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

/* =========================
   MARKET STRUCTURE
========================= */

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

  const previousHigh = Math.max(
    ...previous.map(x => x.high)
  );

  const previousLow = Math.min(
    ...previous.map(x => x.low)
  );

  const currentHigh = Math.max(
    ...current.map(x => x.high)
  );

  const currentLow = Math.min(
    ...current.map(x => x.low)
  );

  const price = candles.at(-1).close;

  let state = "RANGE";

  if (
    currentHigh > previousHigh &&
    currentLow > previousLow
  ) {
    state = "HH_HL";
  } else if (
    currentHigh < previousHigh &&
    currentLow < previousLow
  ) {
    state = "LH_LL";
  }

  let bos = "NONE";

  if (price > previousHigh) {
    bos = "BULLISH";
  } else if (price < previousLow) {
    bos = "BEARISH";
  }

  let choch = "NONE";

  if (
    state === "HH_HL" &&
    price < previousLow
  ) {
    choch = "BEARISH";
  }

  if (
    state === "LH_LL" &&
    price > previousHigh
  ) {
    choch = "BULLISH";
  }

  return {
    state,
    bos,
    choch,
    swingHigh: round(
      Math.max(previousHigh, currentHigh),
      2
    ),
    swingLow: round(
      Math.min(previousLow, currentLow),
      2
    )
  };
}

/* =========================
   LIQUIDITY
========================= */

function liquiditySweep(candles) {
  if (candles.length < 25) return "NONE";

  const previous = candles.slice(-21, -1);

  const high = Math.max(
    ...previous.map(x => x.high)
  );

  const low = Math.min(
    ...previous.map(x => x.low)
  );

  const c = candles.at(-1);

  if (
    c.high > high &&
    c.close < high
  ) {
    return "BEARISH_SWEEP";
  }

  if (
    c.low < low &&
    c.close > low
  ) {
    return "BULLISH_SWEEP";
  }

  return "NONE";
}

/* =========================
   CANDLE ANALYSIS
========================= */

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

  const body = Math.abs(
    c.close - c.open
  );

  const range = Math.max(
    c.high - c.low,
    0.00001
  );

  const upper =
    c.high -
    Math.max(c.open, c.close);

  const lower =
    Math.min(c.open, c.close) -
    c.low;

  let direction = "NEUTRAL";

  if (c.close > c.open)
    direction = "BULLISH";

  if (c.close < c.open)
    direction = "BEARISH";

  const impulse =
    body / range >= 0.65;

  const bullishRejection =
    lower > body * 1.5 &&
    lower > upper * 1.2;

  const bearishRejection =
    upper > body * 1.5 &&
    upper > lower * 1.2;

  let pattern = "NORMAL";

  if (bullishRejection) {
    pattern = "BULLISH_REJECTION";
  } else if (bearishRejection) {
    pattern = "BEARISH_REJECTION";
  } else if (impulse) {
    pattern =
      direction === "BULLISH"
        ? "BULLISH_IMPULSE"
        : "BEARISH_IMPULSE";
  }

  return {
    direction,
    pattern,
    impulse,
    rejection:
      bullishRejection ||
      bearishRejection,
    body: round(body, 3),
    range: round(range, 3)
  };
}

/* =========================
   TIMEFRAME ENGINE
========================= */

function analyzeTimeframe(candles) {
  if (candles.length < 50) {
    return {
      bias: "NEUTRAL",
      setupScore: 0,
      trend: "NEUTRAL",
      structure: structure(candles),
      liquidity: "NONE",
      momentum: {
        rsi: 50,
        macd: 0,
        signal: 0,
        histogram: 0
      },
      atr: 0,
      price: candles.at(-1)?.close || null,
      candleTime:
        candles.at(-1)?.datetime || null
    };
  }

  const closes = candles.map(x => x.close);

  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const e200 = ema(closes, 200).at(-1);

  const price = closes.at(-1);

  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(candles);

  const s = structure(candles);
  const l = liquiditySweep(candles);
  const c = candleInfo(candles);

  let bull = 0;
  let bear = 0;

  if (price > e20) bull++;
  else bear++;

  if (e20 > e50) bull++;
  else bear++;

  if (e50 > e200) bull++;
  else bear++;

  if (r > 52) bull++;
  else if (r < 48) bear++;

  if (m.histogram > 0) bull++;
  else if (m.histogram < 0) bear++;

  if (
    s.state === "HH_HL" ||
    s.bos === "BULLISH" ||
    s.choch === "BULLISH"
  ) {
    bull += 2;
  }

  if (
    s.state === "LH_LL" ||
    s.bos === "BEARISH" ||
    s.choch === "BEARISH"
  ) {
    bear += 2;
  }

  let bias = "NEUTRAL";

  if (bull >= bear + 2)
    bias = "BULLISH";

  if (bear >= bull + 2)
    bias = "BEARISH";

  const rawScore =
    50 +
    (bull - bear) * 8 +
    (s.bos !== "NONE" ? 5 : 0);

  return {
    bias,
    setupScore: Math.max(
      0,
      Math.min(100, Math.round(rawScore))
    ),
    trend: bias,

    structure: s,

    liquidity: l,

    momentum: {
      rsi: round(r, 2),
      macd: round(m.macd, 4),
      signal: round(m.signal, 4),
      histogram: round(
        m.histogram,
        4
      )
    },

    atr: round(a, 3),
    price: round(price, 2),

    ema20: round(e20, 2),
    ema50: round(e50, 2),
    ema200: round(e200, 2),

    candleTime:
      candles.at(-1)?.datetime || null,

    candleMetrics: c
  };
}

/* =========================
   SCORE
========================= */

function weightedScore(scores) {
  const weights = {
    "1min": 0.10,
    "5min": 0.20,
    "15min": 0.25,
    "1h": 0.20,
    "4h": 0.25
  };

  let total = 0;
  let weight = 0;

  for (const tf of Object.keys(weights)) {
    if (!scores[tf]) continue;

    total +=
      scores[tf].setupScore *
      weights[tf];

    weight += weights[tf];
  }

  return Math.round(
    weight ? total / weight : 0
  );
}

/* =========================
   HIGHER TIMEFRAME DIRECTION
========================= */

function higherDirection(scores) {
  const h4 = scores["4h"]?.bias;
  const h1 = scores["1h"]?.bias;
  const m15 = scores["15min"]?.bias;

  /*
    FINAL ENGINE:
    H4 + H1 + M15 must agree.
  */

  if (
    h4 === "BULLISH" &&
    h1 === "BULLISH" &&
    m15 === "BULLISH"
  ) {
    return "BUY";
  }

  if (
    h4 === "BEARISH" &&
    h1 === "BEARISH" &&
    m15 === "BEARISH"
  ) {
    return "SELL";
  }

  return "NONE";
}

/* =========================
   M15 STRUCTURE GATE
========================= */

function m15StructureGate(
  m15,
  direction
) {
  if (!m15) return false;

  const s = m15.structure;

  if (direction === "BUY") {
    return (
      s.state === "HH_HL" ||
      s.bos === "BULLISH" ||
      s.choch === "BULLISH"
    );
  }

  return (
    s.state === "LH_LL" ||
    s.bos === "BEARISH" ||
    s.choch === "BEARISH"
  );
}

/* =========================
   M15 LIQUIDITY GATE
========================= */

function m15LiquidityGate(
  m15,
  direction
) {
  if (!m15) return false;

  const s = m15.structure;
  const l = m15.liquidity;

  if (direction === "BUY") {
    return (
      l === "BULLISH_SWEEP" ||
      s.bos === "BULLISH" ||
      s.choch === "BULLISH"
    );
  }

  return (
    l === "BEARISH_SWEEP" ||
    s.bos === "BEARISH" ||
    s.choch === "BEARISH"
  );
}

/* =========================
   M5 PULLBACK ENGINE
========================= */

function m5Pullback(
  candles,
  direction,
  atrValue
) {
  if (
    candles.length < 15 ||
    !atrValue
  ) {
    return {
      valid: false,
      state: "INSUFFICIENT_DATA",
      depthATR: null
    };
  }

  const recent = candles.slice(-12);

  const impulseCandles =
    recent.slice(0, 6);

  const pullbackCandles =
    recent.slice(6);

  const impulseStart =
    impulseCandles[0].close;

  const impulseEnd =
    impulseCandles.at(-1).close;

  const impulseMove =
    direction === "BUY"
      ? impulseEnd - impulseStart
      : impulseStart - impulseEnd;

  /*
    There must first be a directional
    M5 impulse.
  */

  const impulseValid =
    impulseMove >= atrValue * 0.35;

  if (!impulseValid) {
    return {
      valid: false,
      state: "NO_M5_IMPULSE",
      depthATR: null
    };
  }

  const impulseHigh =
    Math.max(
      ...impulseCandles.map(
        x => x.high
      )
    );

  const impulseLow =
    Math.min(
      ...impulseCandles.map(
        x => x.low
      )
    );

  const current =
    candles.at(-1).close;

  let depth;

  if (direction === "BUY") {
    depth =
      Math.max(
        0,
        impulseHigh - current
      ) / atrValue;
  } else {
    depth =
      Math.max(
        0,
        current - impulseLow
      ) / atrValue;
  }

  const valid =
    depth >=
      CONFIG.m5MinPullbackATR &&
    depth <=
      CONFIG.m5MaxPullbackATR;

  let state = "VALID_PULLBACK";

  if (depth <
      CONFIG.m5MinPullbackATR) {
    state = "CHASING";
  }

  if (depth >
      CONFIG.m5MaxPullbackATR) {
    state = "DEEP_PULLBACK";
  }

  return {
    valid,
    state,
    depthATR: round(depth, 2),
    impulseATR: round(
      Math.abs(impulseMove) /
      atrValue,
      2
    )
  };
}

/* =========================
   M1 MICRO CONFIRMATION
========================= */

function m1Confirmation(
  candles,
  direction
) {
  if (candles.length < 8) {
    return {
      confirmed: false,
      reason: "INSUFFICIENT_DATA",
      pattern: "NONE"
    };
  }

  const current =
    candles.at(-1);

  const previous =
    candles.slice(-6, -1);

  const previousHigh =
    Math.max(
      ...previous.map(x => x.high)
    );

  const previousLow =
    Math.min(
      ...previous.map(x => x.low)
    );

  const c =
    candleInfo(candles);

  const microBOS =
    direction === "BUY"
      ? current.close > previousHigh
      : current.close < previousLow;

  const candleConfirmation =
    direction === "BUY"
      ? (
          c.direction === "BULLISH" &&
          (
            c.impulse ||
            c.pattern ===
              "BULLISH_REJECTION"
          )
        )
      : (
          c.direction === "BEARISH" &&
          (
            c.impulse ||
            c.pattern ===
              "BEARISH_REJECTION"
          )
        );

  const confirmed =
    microBOS ||
    candleConfirmation;

  return {
    confirmed,
    microBOS,
    candleConfirmation,
    pattern: c.pattern,
    reason: confirmed
      ? "M1_CONFIRMATION_CONFIRMED"
      : "NO_M1_CONFIRMATION"
  };
}

/* =========================
   VOLATILITY
========================= */

function volatilityStatus(scores) {
  const h1 = scores["1h"];

  if (!h1 || !h1.price || !h1.atr) {
    return {
      state: "UNKNOWN",
      atrPercent: null,
      warning: true
    };
  }

  const pct =
    (h1.atr / h1.price) * 100;

  if (
    pct >=
    CONFIG.highVolatilityPct
  ) {
    return {
      state: "HIGH",
      atrPercent: round(pct, 3),
      warning: true
    };
  }

  if (
    pct <=
    CONFIG.lowVolatilityPct
  ) {
    return {
      state: "LOW",
      atrPercent: round(pct, 3),
      warning: true
    };
  }

  return {
    state: "NORMAL",
    atrPercent: round(pct, 3),
    warning: false
  };
}

/* =========================
   MARKET CONDITION
========================= */

function marketCondition(scores) {
  const values =
    Object.values(scores);

  const bull =
    values.filter(
      x => x.bias === "BULLISH"
    ).length;

  const bear =
    values.filter(
      x => x.bias === "BEARISH"
    ).length;

  if (bull >= 4)
    return "STRONG_BULLISH";

  if (bear >= 4)
    return "STRONG_BEARISH";

  if (bull >= 3)
    return "BULLISH";

  if (bear >= 3)
    return "BEARISH";

  return "MIXED";
}

/* =========================
   RISK PLAN
========================= */

function buildRiskPlan(
  direction,
  entry,
  m15,
  atrValue
) {
  if (
    !direction ||
    !entry ||
    !m15 ||
    !atrValue
  ) {
    return null;
  }

  const s =
    m15.structure;

  if (
    s.swingHigh === null ||
    s.swingLow === null
  ) {
    return null;
  }

  let sl;

  if (direction === "BUY") {
    sl =
      s.swingLow -
      atrValue * CONFIG.slATRBuffer;

    /*
      SL must actually be below entry.
    */
    if (sl >= entry) {
      return null;
    }
  } else {
    sl =
      s.swingHigh +
      atrValue * CONFIG.slATRBuffer;

    /*
      SL must actually be above entry.
    */
    if (sl <= entry) {
      return null;
    }
  }

  const risk =
    Math.abs(entry - sl);

  if (!risk || risk <= 0)
    return null;

  const tp =
    direction === "BUY"
      ? entry + risk * 2
      : entry - risk * 2;

  return {
    entry: round(entry, 2),
    sl: round(sl, 2),
    tp: round(tp, 2),
    riskDistance: round(risk, 2),
    rewardDistance: round(
      risk * 2,
      2
    ),
    rr: 2,
    method:
      "M15_STRUCTURE + ATR_BUFFER",
    note:
      "Position size must be calculated from account risk."
  };
}

/* =========================
   MARKET DATA
========================= */

async function getMarket(
  env,
  interval
) {
  const apiKey =
    env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    const e = new Error(
      "TWELVE_DATA_API_KEY missing"
    );

    e.code =
      "CONFIG_ERROR";

    throw e;
  }

  const cache =
    caches.default;

  const cacheKey =
    new Request(
      `https://cache.xau-ai.local/market/${encodeURIComponent(interval)}`
    );

  const cached =
    await cache.match(cacheKey);

  if (cached) {
    return await cached.json();
  }

  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    SYMBOL
  );

  url.searchParams.set(
    "interval",
    interval
  );

  url.searchParams.set(
    "outputsize",
    "250"
  );

  url.searchParams.set(
    "timezone",
    "UTC"
  );

  url.searchParams.set(
    "apikey",
    apiKey
  );

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    !response.ok ||
    data?.status === "error"
  ) {
    const e =
      new Error(
        data?.message ||
        `Twelve Data HTTP ${response.status}`
      );

    e.code =
      data?.code ||
      response.status;

    throw e;
  }

  const candles =
    normalizeCandles(data);

  if (!candles.length) {
    const e =
      new Error(
        "No market data returned"
      );

    e.code = "NO_DATA";

    throw e;
  }

  const result = {
    ok: true,
    interval,
    symbol: SYMBOL,
    candles
  };

  await cache.put(
    cacheKey,
    new Response(
      JSON.stringify(result),
      {
        headers: {
          "content-type":
            "application/json",
          "cache-control":
            `max-age=${CACHE_TTL}`
        }
      }
    )
  );

  return result;
}

/* =========================
   FRESHNESS
========================= */

function freshness(
  candles,
  tf
) {
  const timestamp =
    candles.at(-1)?.datetime;

  if (!timestamp) {
    return {
      fresh: false,
      ageMinutes: null,
      reason: "NO_TIMESTAMP"
    };
  }

  const time =
    new Date(timestamp).getTime();

  if (!Number.isFinite(time)) {
    return {
      fresh: false,
      ageMinutes: null,
      reason:
        "INVALID_TIMESTAMP"
    };
  }

  const ageMinutes =
    Math.max(
      0,
      Math.round(
        (Date.now() - time) /
        60000
      )
    );

  const limit =
    FRESHNESS_LIMITS[tf];

  return {
    fresh:
      ageMinutes <= limit,
    ageMinutes,
    limitMinutes: limit,
    reason:
      ageMinutes <= limit
        ? "FRESH"
        : `STALE>${limit}MIN`
  };
}

/* =========================
   ANALYSIS ENGINE
========================= */

async function runAnalysis(env) {
  /*
    WEEKEND PROTECTION
  */

  if (isWeekend()) {
    return {
      ok: true,
      engine: ENGINE_VERSION,
      symbol: SYMBOL,

      decision: "NO TRADE",
      setupScore: 0,
      price: null,

      multiTimeframeBias:
        "NONE",

      analysis: {},
      freshness: {},

      dataStatus: "WEEKEND",
      unavailable: [],

      safety: {
        weekend: true,
        session: tradingSession(),

        volatility: {
          state: "N/A",
          atrPercent: null,
          warning: false
        },

        marketCondition:
          "CLOSED",

        newsRisk:
          "NOT CHECKED",

        spread:
          "NOT CHECKED",

        slippage:
          "NOT CHECKED"
      },

      entryConfirmation: null,
      riskPlan: null,

      execution: {
        state: "NO_TRADE",
        executable: false
      },

      executionGate: {
        passed: false,
        reasons: ["WEEKEND"]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  /*
    GET ALL FIVE TIMEFRAMES
  */

  const tfNames =
    Object.keys(TIMEFRAMES);

  const results =
    await Promise.allSettled(
      tfNames.map(
        async tf => {
          const data =
            await getMarket(
              env,
              TIMEFRAMES[tf]
            );

          return {
            tf,
            candles:
              data.candles,
            freshness:
              freshness(
                data.candles,
                tf
              )
          };
        }
      )
    );

  const scores = {};
  const candleStore = {};
  const freshState = {};
  const unavailable = [];

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const tf =
      tfNames[i];

    const result =
      results[i];

    if (
      result.status !==
      "fulfilled"
    ) {
      unavailable.push({
        timeframe: tf,
        code:
          result.reason?.code ||
          "DATA_ERROR",
        error:
          result.reason?.message ||
          String(result.reason)
      });

      continue;
    }

    candleStore[tf] =
      result.value.candles;

    freshState[tf] =
      result.value.freshness;

    if (
      !result.value.freshness.fresh
    ) {
      unavailable.push({
        timeframe: tf,
        code:
          "STALE_DATA",
        error:
          result.value
            .freshness.reason
      });

      continue;
    }

    scores[tf] =
      analyzeTimeframe(
        result.value.candles
      );
  }

  const allFresh =
    tfNames.every(
      tf =>
        freshState[tf]?.fresh ===
        true
    );

  /*
    Missing or stale data
    immediately kills execution.
  */

  if (
    !allFresh ||
    unavailable.length
  ) {
    return {
      ok: true,
      engine: ENGINE_VERSION,
      symbol: SYMBOL,

      decision: "NO TRADE",
      setupScore:
        weightedScore(scores),

      price:
        scores["1min"]?.price ||
        scores["5min"]?.price ||
        null,

      multiTimeframeBias:
        "MIXED",

      analysis: scores,
      freshness: freshState,

      dataStatus: "DEGRADED",
      unavailable,

      safety: {
        weekend: false,
        session: tradingSession(),

        volatility:
          volatilityStatus(scores),

        marketCondition:
          marketCondition(scores),

        newsRisk:
          "NOT CHECKED",

        spread:
          "NOT CHECKED",

        slippage:
          "NOT CHECKED"
      },

      entryConfirmation: null,
      riskPlan: null,

      execution: {
        state: "NO_TRADE",
        executable: false
      },

      executionGate: {
        passed: false,
        reasons: [
          "DATA_NOT_FRESH_OR_UNAVAILABLE"
        ]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  /* =========================
     FINAL DIRECTION
  ========================= */

  const direction =
    higherDirection(scores);

  const score =
    weightedScore(scores);

  const m15 =
    scores["15min"];

  const m5 =
    scores["5min"];

  const m1 =
    scores["1min"];

  const volatility =
    volatilityStatus(scores);

  const condition =
    marketCondition(scores);

  const price =
    m1.price;

  /*
    No H4/H1/M15 alignment
    = no directional trade.
  */

  if (direction === "NONE") {
    return {
      ok: true,
      engine: ENGINE_VERSION,
      symbol: SYMBOL,

      decision:
        score >= 50
          ? "WATCH"
          : "NO TRADE",

      setupScore: score,
      price,

      multiTimeframeBias:
        "MIXED",

      analysis: scores,
      freshness: freshState,

      dataStatus: "FRESH",
      unavailable: [],

      safety: {
        weekend: false,
        session: tradingSession(),
        volatility,
        marketCondition: condition,

        newsRisk:
          "NOT CHECKED",

        spread:
          "NOT CHECKED",

        slippage:
          "NOT CHECKED"
      },

      entryConfirmation: null,
      riskPlan: null,

      execution: {
        state: "WATCH",
        executable: false
      },

      executionGate: {
        passed: false,
        reasons: [
          "H4_H1_M15_NOT_ALIGNED"
        ]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  /* =========================
     M15 STRUCTURE
  ========================= */

  const structurePassed =
    m15StructureGate(
      m15,
      direction
    );

  /* =========================
     M15 LIQUIDITY / BOS
  ========================= */

  const liquidityPassed =
    m15LiquidityGate(
      m15,
      direction
    );

  /* =========================
     M5 PULLBACK
  ========================= */

  const pullback =
    m5Pullback(
      candleStore["5min"],
      direction,
      m5.atr
    );

  /* =========================
     M1 FINAL CONFIRMATION
  ========================= */

  const confirmation =
    m1Confirmation(
      candleStore["1min"],
      direction
    );

  /* =========================
     M5 DIRECTION
  ========================= */

  const m5Aligned =
    direction === "BUY"
      ? m5.bias === "BULLISH"
      : m5.bias === "BEARISH";

  /* =========================
     M1 DIRECTION
  ========================= */

  const m1Aligned =
    direction === "BUY"
      ? m1.bias !== "BEARISH"
      : m1.bias !== "BULLISH";

  /* =========================
     SCORE
  ========================= */

  const scorePassed =
    score >= CONFIG.minScore;

  /* =========================
     VOLATILITY
  ========================= */

  const volatilityPassed =
    !volatility.warning;

  /* =========================
     RISK PLAN
  ========================= */

  const plan =
    buildRiskPlan(
      direction,
      price,
      m15,
      m15.atr
    );

  const rrPassed =
    !!plan &&
    plan.rr >= CONFIG.minRR;

  /* =========================
     EXECUTION GATE
  ========================= */

  const reasons = [];

  if (!structurePassed) {
    reasons.push(
      "M15_STRUCTURE_FAILED"
    );
  }

  if (!liquidityPassed) {
    reasons.push(
      "M15_LIQUIDITY_OR_BOS_FAILED"
    );
  }

  if (!pullback.valid) {
    reasons.push(
      `M5_${pullback.state}`
    );
  }

  if (!confirmation.confirmed) {
    reasons.push(
      "M1_CONFIRMATION_FAILED"
    );
  }

  if (!m5Aligned) {
    reasons.push(
      "M5_NOT_ALIGNED"
    );
  }

  if (!m1Aligned) {
    reasons.push(
      "M1_NOT_ALIGNED"
    );
  }

  if (!scorePassed) {
    reasons.push(
      "SCORE_BELOW_70"
    );
  }

  if (!volatilityPassed) {
    reasons.push(
      "VOLATILITY_WARNING"
    );
  }

  if (!rrPassed) {
    reasons.push(
      "RR_BELOW_1_TO_2"
    );
  }

  const executable =
    structurePassed &&
    liquidityPassed &&
    pullback.valid &&
    confirmation.confirmed &&
    m5Aligned &&
    m1Aligned &&
    scorePassed &&
    volatilityPassed &&
    rrPassed;

  /*
    Important:
    News / spread / slippage are NOT
    fabricated. They are explicitly
    marked NOT CHECKED.
  */

  const decision =
    executable
      ? direction
      : score >= 50
        ? (
            direction === "BUY"
              ? "WATCH — BUY SETUP"
              : "WATCH — SELL SETUP"
          )
        : "NO TRADE";

  const executionState =
    executable
      ? (
          direction === "BUY"
            ? "TRADE_BUY"
            : "TRADE_SELL"
        )
      : decision.startsWith("WATCH")
        ? "WATCH"
        : "NO_TRADE";

  /*
    Entry information is diagnostic
    unless the complete gate passes.
  */

  const entryConfirmation = {
    direction,

    m15: {
      structurePassed,
      liquidityPassed,
      structure:
        m15.structure,
      liquidity:
        m15.liquidity
    },

    m5: {
      aligned:
        m5Aligned,
      pullback
    },

    m1: {
      aligned:
        m1Aligned,
      confirmation
    },

    scorePassed,
    volatilityPassed,
    rrPassed,

    confirmed:
      executable
  };

  return {
    ok: true,

    engine:
      ENGINE_VERSION,

    symbol:
      SYMBOL,

    decision,

    setupScore:
      score,

    price:
      round(price, 2),

    multiTimeframeBias:
      direction === "BUY"
        ? "BULLISH"
        : "BEARISH",

    analysis:
      scores,

    freshness:
      freshState,

    dataStatus:
      "FRESH",

    unavailable: [],

    safety: {
      weekend: false,

      session:
        tradingSession(),

      volatility,

      marketCondition:
        condition,

      newsRisk:
        "NOT CHECKED",

      spread:
        "NOT CHECKED",

      slippage:
        "NOT CHECKED"
    },

    entryConfirmation,

    /*
      Never provide an executable
      risk plan for WATCH / NO TRADE.
    */

    riskPlan:
      executable
        ? plan
        : null,

    execution: {
      state:
        executionState,

      executable
    },

    executionGate: {
      passed:
        executable,

      reasons:
        executable
          ? [
              "H4_H1_M15_ALIGNED",
              "M15_STRUCTURE_CONFIRMED",
              "M15_LIQUIDITY_OR_BOS_CONFIRMED",
              "M5_PULLBACK_CONFIRMED",
              "M1_CONFIRMATION_CONFIRMED",
              "SCORE_GE_70",
              "VOLATILITY_ACCEPTABLE",
              "RR_GE_1_TO_2"
            ]
          : reasons
    },

    generatedAt:
      new Date().toISOString()
  };
}

/* =========================
   CLOUDFLARE ROUTER
========================= */

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    /* CORS */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin":
            "*",
          "access-control-allow-methods":
            "GET,OPTIONS",
          "access-control-allow-headers":
            "Content-Type"
        }
      });
    }

    /* =========================
       HEALTH
    ========================= */

    if (
      url.pathname ===
      "/health"
    ) {
      return json({
        ok: true,

        service:
          "XAU AI API",

        status:
          "online",

        symbol:
          SYMBOL,

        engine:
          ENGINE_VERSION,

        cacheTtlSeconds:
          CACHE_TTL
      });
    }

    /* =========================
       MARKET
    ========================= */

    if (
      url.pathname ===
      "/api/market"
    ) {
      const interval =
        url.searchParams.get(
          "interval"
        ) ||
        "1min";

      if (
        !Object.values(
          TIMEFRAMES
        ).includes(interval)
      ) {
        return json(
          {
            ok: false,
            error:
              "INVALID_INTERVAL",

            allowed:
              Object.values(
                TIMEFRAMES
              )
          },
          400
        );
      }

      try {
        const data =
          await getMarket(
            env,
            interval
          );

        const tf =
          Object.keys(
            TIMEFRAMES
          ).find(
            key =>
              TIMEFRAMES[key] ===
              interval
          ) ||
          "1min";

        return json({
          ok: true,

          engine:
            ENGINE_VERSION,

          symbol:
            SYMBOL,

          interval,

          price:
            data.candles.at(-1)
              ?.close ||
            null,

          freshness:
            freshness(
              data.candles,
              tf
            ),

          candles:
            data.candles
        });
      } catch (error) {
        const code =
          error?.code ||
          "DATA_ERROR";

        return json(
          {
            ok: false,

            error:
              code === 429
                ? "DATA_LIMIT"
                : "MARKET_DATA_ERROR",

            code,

            details:
              error?.message ||
              String(error)
          },
          code === 429
            ? 429
            : 502
        );
      }
    }

    /* =========================
       FINAL ANALYSIS
    ========================= */

    if (
      url.pathname ===
      "/api/analyze"
    ) {
      try {
        return json(
          await runAnalysis(env)
        );
      } catch (error) {
        return json(
          {
            ok: false,

            engine:
              ENGINE_VERSION,

            error:
              "ANALYSIS_FAILED",

            code:
              error?.code ||
              "UNKNOWN",

            details:
              error?.message ||
              String(error)
          },
          502
        );
      }
    }

    /* =========================
       404
    ========================= */

    return json(
      {
        ok: false,
        error: "NOT_FOUND",
        engine:
          ENGINE_VERSION
      },
      404
    );
  }
};

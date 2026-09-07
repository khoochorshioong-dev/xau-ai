const ENGINE_VERSION = "V3.3";
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

const ENTRY_CONFIG = {
  minScore: 70,
  minRR: 2,
  pullbackMaxATR: 1.2,
  confirmationLookback: 5
};

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
  const a = values.filter(v => Number.isFinite(v));
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

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

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
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

  if (!trs.length) return 0;

  return average(
    trs.slice(-period)
  );
}

function macd(
  values,
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {
  if (!values.length) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const fastE = ema(values, fast);
  const slowE = ema(values, slow);

  const line = values.map(
    (_, i) =>
      fastE[i] - slowE[i]
  );

  const signal = ema(
    line,
    signalPeriod
  );

  const m =
    line[line.length - 1] || 0;

  const s =
    signal[signal.length - 1] || 0;

  return {
    macd: m,
    signal: s,
    histogram: m - s
  };
}

function normalizeCandles(raw) {
  const values =
    Array.isArray(raw?.values)
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

function getTradingSession() {
  const hour =
    new Date().getUTCHours();

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
      name:
        "LONDON / NEW YORK OVERLAP",
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
  const day =
    new Date().getUTCDay();

  return (
    day === 0 ||
    day === 6
  );
}

function detectStructure(candles) {
  if (candles.length < 20) {
    return {
      structure: "UNKNOWN",
      bos: "NONE",
      swingHigh: null,
      swingLow: null
    };
  }

  const recent =
    candles.slice(-20);

  const mid = 10;

  const first =
    recent.slice(0, mid);

  const second =
    recent.slice(mid);

  const high1 =
    Math.max(
      ...first.map(x => x.high)
    );

  const high2 =
    Math.max(
      ...second.map(x => x.high)
    );

  const low1 =
    Math.min(
      ...first.map(x => x.low)
    );

  const low2 =
    Math.min(
      ...second.map(x => x.low)
    );

  const last =
    candles[
      candles.length - 1
    ].close;

  let structure = "RANGE";

  if (
    high2 > high1 &&
    low2 > low1
  ) {
    structure = "HH_HL";
  } else if (
    high2 < high1 &&
    low2 < low1
  ) {
    structure = "LH_LL";
  }

  let bos = "NONE";

  if (last > high1) {
    bos = "BULLISH";
  } else if (last < low1) {
    bos = "BEARISH";
  }

  return {
    structure,
    bos,
    swingHigh:
      Math.max(high1, high2),
    swingLow:
      Math.min(low1, low2)
  };
}

function liquiditySweep(candles) {
  if (candles.length < 25) {
    return "NONE";
  }

  const recent =
    candles.slice(-21, -1);

  const high =
    Math.max(
      ...recent.map(x => x.high)
    );

  const low =
    Math.min(
      ...recent.map(x => x.low)
    );

  const c =
    candles[candles.length - 1];

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

function candleMetrics(candles) {
  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const body =
    Math.abs(
      c.close - c.open
    );

  const range =
    Math.max(
      c.high - c.low,
      0.00001
    );

  const upperWick =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) -
    c.low;

  let direction = "NEUTRAL";

  if (c.close > c.open) {
    direction = "BULLISH";
  }

  if (c.close < c.open) {
    direction = "BEARISH";
  }

  let pattern = "NORMAL";

  if (
    lowerWick > body * 1.5 &&
    lowerWick > upperWick * 1.2
  ) {
    pattern =
      "BULLISH_REJECTION";
  } else if (
    upperWick > body * 1.5 &&
    upperWick > lowerWick * 1.2
  ) {
    pattern =
      "BEARISH_REJECTION";
  } else if (
    body / range > 0.65
  ) {
    pattern =
      direction === "BULLISH"
        ? "BULLISH_IMPULSE"
        : "BEARISH_IMPULSE";
  }

  return {
    direction,
    pattern,
    body: round(body, 3),
    range: round(range, 3),
    closeChange:
      round(
        c.close - p.close,
        3
      )
  };
}

function confirmationCandle(
  candles,
  direction
) {
  if (candles.length < 3) {
    return {
      confirmed: false,
      pattern: "NONE"
    };
  }

  const c =
    candles[candles.length - 1];

  const m =
    candleMetrics(candles);

  if (direction === "BUY") {
    const confirmed =
      (
        m.direction === "BULLISH" &&
        (
          m.pattern ===
            "BULLISH_IMPULSE" ||
          m.pattern ===
            "BULLISH_REJECTION"
        )
      ) ||
      (
        c.close >
        candles[
          candles.length - 2
        ].high
      );

    return {
      confirmed,
      pattern: m.pattern
    };
  }

  const confirmed =
    (
      m.direction === "BEARISH" &&
      (
        m.pattern ===
          "BEARISH_IMPULSE" ||
        m.pattern ===
          "BEARISH_REJECTION"
      )
    ) ||
    (
      c.close <
      candles[
        candles.length - 2
      ].low
    );

  return {
    confirmed,
    pattern: m.pattern
  };
}

function detectPullback(
  candles,
  direction,
  atrValue
) {
  if (
    candles.length < 10 ||
    !atrValue
  ) {
    return {
      valid: false,
      depthATR: null,
      state: "UNKNOWN"
    };
  }

  const current =
    candles[
      candles.length - 1
    ].close;

  const lookback =
    candles.slice(-10, -1);

  const high =
    Math.max(
      ...lookback.map(
        x => x.high
      )
    );

  const low =
    Math.min(
      ...lookback.map(
        x => x.low
      )
    );

  let depth;

  if (direction === "BUY") {
    depth =
      Math.max(
        0,
        high - current
      ) / atrValue;
  } else {
    depth =
      Math.max(
        0,
        current - low
      ) / atrValue;
  }

  const valid =
    depth > 0.05 &&
    depth <=
      ENTRY_CONFIG.pullbackMaxATR;

  return {
    valid,
    depthATR: round(depth, 2),
    state:
      valid
        ? "VALID_PULLBACK"
        : depth <= 0.05
          ? "CHASING"
          : "DEEP_PULLBACK"
  };
}

function analyzeTimeframe(candles) {
  if (candles.length < 50) {
    return {
      bias: "NEUTRAL",
      setupScore: 0,
      trend: "NEUTRAL",
      structure:
        detectStructure(candles),
      momentum: {
        rsi: 50,
        macd: 0,
        signal: 0,
        histogram: 0
      },
      liquidity: "NONE",
      atr: 0,
      price:
        candles.at(-1)?.close ||
        null,
      ema20: null,
      ema50: null,
      ema200: null,
      candleTime:
        candles.at(-1)?.datetime ||
        null,
      candleMetrics: null
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const e20 =
    ema(
      closes,
      20
    ).at(-1);

  const e50 =
    ema(
      closes,
      50
    ).at(-1);

  const e200 =
    ema(
      closes,
      200
    ).at(-1);

  const price =
    closes.at(-1);

  const r =
    rsi(
      closes,
      14
    );

  const m =
    macd(closes);

  const a =
    atr(candles);

  const structure =
    detectStructure(candles);

  const liquidity =
    liquiditySweep(candles);

  const cm =
    candleMetrics(candles);

  let bull = 0;
  let bear = 0;

  if (price > e20) {
    bull += 1;
  } else {
    bear += 1;
  }

  if (e20 > e50) {
    bull += 1;
  } else {
    bear += 1;
  }

  if (e50 > e200) {
    bull += 1;
  } else {
    bear += 1;
  }

  if (r > 52) {
    bull += 1;
  } else if (r < 48) {
    bear += 1;
  }

  if (m.histogram > 0) {
    bull += 1;
  } else if (m.histogram < 0) {
    bear += 1;
  }

  if (
    structure.structure ===
      "HH_HL" ||
    structure.bos ===
      "BULLISH"
  ) {
    bull += 2;
  }

  if (
    structure.structure ===
      "LH_LL" ||
    structure.bos ===
      "BEARISH"
  ) {
    bear += 2;
  }

  let bias = "NEUTRAL";

  if (
    bull >= bear + 2
  ) {
    bias = "BULLISH";
  } else if (
    bear >= bull + 2
  ) {
    bias = "BEARISH";
  }

  const setupScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          50 +
          (bull - bear) * 8 +
          (
            structure.bos !==
            "NONE"
              ? 5
              : 0
          )
        )
      )
    );

  return {
    bias,
    setupScore,
    trend: bias,
    structure,
    momentum: {
      rsi: round(r, 2),
      macd: round(m.macd, 4),
      signal: round(m.signal, 4),
      histogram:
        round(
          m.histogram,
          4
        )
    },
    liquidity,
    atr: round(a, 3),
    price: round(price, 2),
    ema20: round(e20, 2),
    ema50: round(e50, 2),
    ema200: round(e200, 2),
    candleTime:
      candles.at(-1)?.datetime ||
      null,
    candleMetrics: cm
  };
}

function weightedSetupScore(scores) {
  const weights = {
    "1min": 0.10,
    "5min": 0.20,
    "15min": 0.25,
    "1h": 0.20,
    "4h": 0.25
  };

  let total = 0;
  let weight = 0;

  for (
    const tf of Object.keys(weights)
  ) {
    if (scores[tf]) {
      total +=
        scores[tf].setupScore *
        weights[tf];

      weight +=
        weights[tf];
    }
  }

  return Math.round(
    weight
      ? total / weight
      : 0
  );
}

function getHigherDirection(scores) {
  const h4 =
    scores["4h"]?.bias;

  const h1 =
    scores["1h"]?.bias;

  const m15 =
    scores["15min"]?.bias;

  const bull =
    [h4, h1, m15]
      .filter(
        x => x === "BULLISH"
      ).length;

  const bear =
    [h4, h1, m15]
      .filter(
        x => x === "BEARISH"
      ).length;

  if (
    bull >= 2 &&
    bull > bear
  ) {
    return "BUY";
  }

  if (
    bear >= 2 &&
    bear > bull
  ) {
    return "SELL";
  }

  return "NONE";
}

function chooseBaseDecision(scores) {
  const score =
    weightedSetupScore(scores);

  const higher =
    getHigherDirection(scores);

  const m5 =
    scores["5min"]?.bias;

  const m1 =
    scores["1min"]?.bias;

  const buyAlignment =
    higher === "BUY" &&
    m5 === "BULLISH" &&
    m1 !== "BEARISH";

  const sellAlignment =
    higher === "SELL" &&
    m5 === "BEARISH" &&
    m1 !== "BULLISH";

  if (
    buyAlignment &&
    score >=
      ENTRY_CONFIG.minScore
  ) {
    return "BUY";
  }

  if (
    sellAlignment &&
    score >=
      ENTRY_CONFIG.minScore
  ) {
    return "SELL";
  }

  if (
    buyAlignment &&
    score >= 50
  ) {
    return "WATCH — BUY SETUP";
  }

  if (
    sellAlignment &&
    score >= 50
  ) {
    return "WATCH — SELL SETUP";
  }

  return "NO TRADE";
}

function entryAnalysis(
  candles,
  direction,
  tfAnalysis
) {
  const a =
    tfAnalysis.atr;

  const price =
    tfAnalysis.price;

  const structure =
    tfAnalysis.structure;

  const liquidity =
    tfAnalysis.liquidity;

  const pullback =
    detectPullback(
      candles,
      direction,
      a
    );

  const confirmation =
    confirmationCandle(
      candles,
      direction
    );

  const cleanBos =
    direction === "BUY"
      ? structure.bos ===
        "BULLISH"
      : structure.bos ===
        "BEARISH";

  const sweep =
    direction === "BUY"
      ? liquidity ===
        "BULLISH_SWEEP"
      : liquidity ===
        "BEARISH_SWEEP";

  const structureValid =
    direction === "BUY"
      ? (
          structure.structure ===
            "HH_HL" ||
          cleanBos
        )
      : (
          structure.structure ===
            "LH_LL" ||
          cleanBos
        );

  const structureGate =
    structureValid;

  const liquidityOrBos =
    sweep ||
    cleanBos;

  const confirmationScore =
    (structureGate
      ? 25
      : 0) +
    (liquidityOrBos
      ? 25
      : 0) +
    (pullback.valid
      ? 20
      : 0) +
    (confirmation.confirmed
      ? 30
      : 0);

  const confirmed =
    structureGate &&
    liquidityOrBos &&
    pullback.valid &&
    confirmation.confirmed;

  const entryZone =
    confirmed
      ? {
          low: round(
            direction === "BUY"
              ? price - a * 0.20
              : price - a * 0.10,
            2
          ),
          high: round(
            direction === "BUY"
              ? price + a * 0.10
              : price + a * 0.20,
            2
          )
        }
      : null;

  const invalidation =
    direction === "BUY"
      ? round(
          structure.swingLow -
            a * 0.15,
          2
        )
      : round(
          structure.swingHigh +
            a * 0.15,
          2
        );

  const reasons = [];

  if (!structureGate) {
    reasons.push(
      "INVALID_STRUCTURE"
    );
  }

  if (!liquidityOrBos) {
    reasons.push(
      "NO_SWEEP_OR_BOS"
    );
  }

  if (!pullback.valid) {
    reasons.push(
      pullback.state
    );
  }

  if (!confirmation.confirmed) {
    reasons.push(
      "NO_M1_CONFIRMATION"
    );
  }

  return {
    entryConfirmation:
      confirmed,

    pullback,

    liquidityLevel:
      liquidity === "NONE"
        ? "NONE"
        : liquidity,

    breakOfStructure:
      structure.bos,

    confirmationCandle:
      confirmation,

    entryZone,

    invalidation,

    confirmationScore,

    executionReason:
      confirmed
        ? "Structure + liquidity/BOS + pullback + confirmation aligned"
        : (
            reasons.join(
              " + "
            ) ||
            "WAIT_FOR_CONFIRMATION"
          )
  };
}

function volatilityStatus(scores) {
  const a =
    scores["1h"]?.atr ||
    0;

  const price =
    scores["1h"]?.price ||
    0;

  const atrPercent =
    price
      ? (a / price) * 100
      : 0;

  if (
    atrPercent >= 0.30
  ) {
    return {
      state: "HIGH",
      atrPercent:
        round(
          atrPercent,
          3
        ),
      warning: true
    };
  }

  if (
    atrPercent <= 0.05
  ) {
    return {
      state: "LOW",
      atrPercent:
        round(
          atrPercent,
          3
        ),
      warning: true
    };
  }

  return {
    state: "NORMAL",
    atrPercent:
      round(
        atrPercent,
        3
      ),
    warning: false
  };
}

function marketCondition(scores) {
  const values =
    Object.values(scores);

  const bull =
    values.filter(
      x =>
        x.bias ===
        "BULLISH"
    ).length;

  const bear =
    values.filter(
      x =>
        x.bias ===
        "BEARISH"
    ).length;

  if (bull >= 4) {
    return "STRONG_BULLISH";
  }

  if (bear >= 4) {
    return "STRONG_BEARISH";
  }

  if (bull >= 3) {
    return "BULLISH";
  }

  if (bear >= 3) {
    return "BEARISH";
  }

  return "MIXED";
}

function riskPlan(
  direction,
  price,
  atrValue
) {
  if (
    !["BUY", "SELL"]
      .includes(direction) ||
    !price ||
    !atrValue
  ) {
    return null;
  }

  const stopDistance =
    atrValue * 1.25;

  const targetDistance =
    stopDistance * 2;

  const sl =
    direction === "BUY"
      ? price - stopDistance
      : price + stopDistance;

  const tp =
    direction === "BUY"
      ? price + targetDistance
      : price - targetDistance;

  return {
    entry: round(
      price,
      2
    ),

    sl: round(
      sl,
      2
    ),

    tp: round(
      tp,
      2
    ),

    rr: 2,

    method:
      "ATR_1.25",

    note:
      "Position size must be calculated from account risk; this engine does not assume account balance."
  };
}

async function getMarket(
  env,
  interval
) {
  const key =
    env.TWELVE_DATA_API_KEY;

  if (!key) {
    throw Object.assign(
      new Error(
        "TWELVE_DATA_API_KEY missing"
      ),
      {
        code:
          "CONFIG_ERROR"
      }
    );
  }

  const cache =
    caches.default;

  const cacheKey =
    new Request(
      `https://cache.xau-ai.local/market?interval=${encodeURIComponent(interval)}`,
      {
        method: "GET"
      }
    );

  const cached =
    await cache.match(
      cacheKey
    );

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
    key
  );

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    !response.ok ||
    data?.status ===
      "error"
  ) {
    const message =
      data?.message ||
      `Twelve Data HTTP ${response.status}`;

    const error =
      new Error(message);

    error.code =
      data?.code ||
      response.status;

    throw error;
  }

  const candles =
    normalizeCandles(data);

  if (!candles.length) {
    throw Object.assign(
      new Error(
        "No market data returned"
      ),
      {
        code:
          "NO_DATA"
      }
    );
  }

  const result = {
    ok: true,
    interval,
    symbol: SYMBOL,
    candles
  };

  const cachedResponse =
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
    );

  await cache.put(
    cacheKey,
    cachedResponse.clone()
  );

  return result;
}

function freshnessFor(
  candles,
  tf
) {
  const last =
    candles?.at(-1)?.datetime;

  if (!last) {
    return {
      fresh: false,
      ageMs: null,
      ageMinutes: null,
      reason:
        "NO_TIMESTAMP"
    };
  }

  const t =
    new Date(last).getTime();

  const now =
    Date.now();

  const ageMs =
    Math.max(
      0,
      now - t
    );

  const ageMinutes =
    Math.round(
      ageMs / 60000
    );

  const limit =
    FRESHNESS_LIMITS[tf];

  if (!Number.isFinite(t)) {
    return {
      fresh: false,
      ageMs: null,
      ageMinutes: null,
      reason:
        "INVALID_TIMESTAMP"
    };
  }

  return {
    fresh:
      ageMinutes <= limit,

    ageMs,

    ageMinutes,

    reason:
      ageMinutes <= limit
        ? "FRESH"
        : `STALE>${limit}MIN`
  };
}

function unavailableResult(
  tf,
  error
) {
  return {
    timeframe: tf,

    error:
      error?.message ||
      String(error),

    code:
      error?.code ||
      "DATA_ERROR"
  };
}

function stripInternalCandles(
  result
) {
  const copy = {
    ...result
  };

  delete copy._candles;

  return copy;
}

async function analyzeAll(
  env
) {
  if (isWeekend()) {
    return {
      ok: true,

      engine:
        ENGINE_VERSION,

      symbol:
        SYMBOL,

      decision:
        "NO TRADE",

      setupScore: 0,

      price: null,

      multiTimeframeBias:
        "NONE",

      analysis: {},

      freshness: {},

      dataStatus:
        "WEEKEND",

      unavailable: [],

      safety: {
        weekend: true,

        session:
          getTradingSession(),

        volatility: {
          state: "N/A",
          atrPercent: 0,
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

      riskPlan:
        null,

      execution: {
        state:
          "NO_TRADE",
        executable:
          false
      },

      executionGate: {
        passed: false,
        reasons: [
          "WEEKEND"
        ]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  const entries =
    await Promise.allSettled(
      Object.entries(
        TIMEFRAMES
      ).map(
        async (
          [tf, interval]
        ) => {
          const data =
            await getMarket(
              env,
              interval
            );

          return {
            tf,

            candles:
              data.candles,

            freshness:
              freshnessFor(
                data.candles,
                tf
              )
          };
        }
      )
    );

  const scores = {};
  const freshness = {};
  const unavailable = [];

  for (
    let i = 0;
    i < entries.length;
    i++
  ) {
    const tf =
      Object.keys(
        TIMEFRAMES
      )[i];

    const result =
      entries[i];

    if (
      result.status ===
      "fulfilled"
    ) {
      const candles =
        result.value.candles;

      freshness[tf] =
        result.value.freshness;

      if (
        !result.value
          .freshness
          .fresh
      ) {
        unavailable.push({
          timeframe: tf,

          code:
            "STALE_DATA",

          error:
            result.value
              .freshness
              .reason
        });

        continue;
      }

      const analysis =
        analyzeTimeframe(
          candles
        );

      analysis._candles =
        candles;

      scores[tf] =
        analysis;
    } else {
      unavailable.push(
        unavailableResult(
          tf,
          result.reason
        )
      );
    }
  }

  const allFresh =
    Object.keys(
      TIMEFRAMES
    ).every(
      tf =>
        freshness[tf]?.fresh ===
        true
    );

  const baseDecision =
    allFresh &&
    unavailable.length === 0
      ? chooseBaseDecision(
          scores
        )
      : "NO TRADE";

  const setupScore =
    weightedSetupScore(
      scores
    );

  const higherDirection =
    getHigherDirection(
      scores
    );

  const price =
    scores["1min"]?.price ||
    scores["5min"]?.price ||
    null;

  const session =
    getTradingSession();

  const volatility =
    volatilityStatus(
      scores
    );

  const condition =
    marketCondition(
      scores
    );

  let entry = null;

  let finalDecision =
    baseDecision;

  let executable =
    false;

  const gateReasons = [];

  if (
    baseDecision ===
      "BUY" ||
    baseDecision ===
      "SELL"
  ) {
    entry =
      entryAnalysis(
        scores["1min"]
          ._candles,
        baseDecision,
        scores["1min"]
      );

    const m5 =
      scores["5min"];

    const m15 =
      scores["15min"];

    const h1 =
      scores["1h"];

    const h4 =
      scores["4h"];

    const higherAligned =
      baseDecision ===
      "BUY"
        ? [
            m15,
            h1,
            h4
          ].filter(
            x =>
              x?.bias ===
              "BULLISH"
          ).length >= 2
        : [
            m15,
            h1,
            h4
          ].filter(
            x =>
              x?.bias ===
              "BEARISH"
          ).length >= 2;

    const m5Aligned =
      baseDecision ===
      "BUY"
        ? m5?.bias ===
          "BULLISH"
        : m5?.bias ===
          "BEARISH";

    const m1Aligned =
      baseDecision ===
      "BUY"
        ? scores["1min"]
            ?.bias !==
          "BEARISH"
        : scores["1min"]
            ?.bias !==
          "BULLISH";

    if (!allFresh) {
      gateReasons.push(
        "DATA_NOT_FRESH"
      );
    }

    if (!higherAligned) {
      gateReasons.push(
        "HIGHER_TF_NOT_ALIGNED"
      );
    }

    if (!m5Aligned) {
      gateReasons.push(
        "M5_NOT_ALIGNED"
      );
    }

    if (!m1Aligned) {
      gateReasons.push(
        "M1_NOT_ALIGNED"
      );
    }

    if (
      setupScore <
      ENTRY_CONFIG.minScore
    ) {
      gateReasons.push(
        "SCORE_BELOW_70"
      );
    }

    if (
      !entry.entryConfirmation
    ) {
      gateReasons.push(
        "ENTRY_CONFIRMATION_FAILED"
      );
    }

    if (
      volatility.warning
    ) {
      gateReasons.push(
        "VOLATILITY_WARNING"
      );
    }

    const rr =
      ENTRY_CONFIG.minRR;

    const plan =
      riskPlan(
        baseDecision,
        price,
        scores["1min"]?.atr
      );

    if (
      !plan ||
      plan.rr < rr
    ) {
      gateReasons.push(
        "RR_BELOW_1_TO_2"
      );
    }

    executable =
      allFresh &&
      unavailable.length === 0 &&
      higherAligned &&
      m5Aligned &&
      m1Aligned &&
      setupScore >=
        ENTRY_CONFIG.minScore &&
      entry.entryConfirmation &&
      !volatility.warning &&
      !!plan &&
      plan.rr >= rr;

    if (!executable) {
      finalDecision =
        "NO TRADE";
    }
  }

  if (
    baseDecision ===
      "WATCH — BUY SETUP" ||
    baseDecision ===
      "WATCH — SELL SETUP"
  ) {
    gateReasons.push(
      "WATCH_ONLY"
    );
  }

  if (
    baseDecision ===
      "NO TRADE" &&
    !gateReasons.length
  ) {
    gateReasons.push(
      "NO_EXECUTABLE_SIGNAL"
    );
  }

  const executionState =
    executable
      ? (
          baseDecision ===
          "BUY"
            ? "TRADE_BUY"
            : "TRADE_SELL"
        )
      : finalDecision.startsWith(
          "WATCH"
        )
        ? "WATCH"
        : "NO_TRADE";

  const cleanAnalysis = {};

  for (
    const tf of Object.keys(
      TIMEFRAMES
    )
  ) {
    if (scores[tf]) {
      cleanAnalysis[tf] =
        stripInternalCandles(
          scores[tf]
        );
    }
  }

  const plan =
    executable
      ? riskPlan(
          baseDecision,
          price,
          scores["1min"]?.atr
        )
      : null;

  return {
    ok: true,

    engine:
      ENGINE_VERSION,

    symbol:
      SYMBOL,

    decision:
      finalDecision,

    setupScore,

    price:
      round(price, 2),

    multiTimeframeBias:
      higherDirection ===
        "BUY"
        ? "BULLISH"
        : higherDirection ===
            "SELL"
          ? "BEARISH"
          : "MIXED",

    analysis:
      cleanAnalysis,

    freshness,

    dataStatus:
      unavailable.length ||
      !allFresh
        ? "DEGRADED"
        : "FRESH",

    unavailable,

    safety: {
      weekend: false,

      session,

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

    entryConfirmation:
      entry,

    riskPlan:
      plan,

    execution: {
      state:
        executionState,

      executable
    },

    executionGate: {
      passed:
        executable,

      reasons:
        gateReasons
    },

    generatedAt:
      new Date().toISOString()
  };
}

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers: {
            "access-control-allow-origin":
              "*",

            "access-control-allow-methods":
              "GET,OPTIONS",

            "access-control-allow-headers":
              "Content-Type"
          }
        }
      );
    }

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
        ).includes(
          interval
        )
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
            k =>
              TIMEFRAMES[k] ===
              interval
          ) ||
          "1min";

        const freshness =
          freshnessFor(
            data.candles,
            tf
          );

        return json({
          ok: true,

          engine:
            ENGINE_VERSION,

          symbol:
            SYMBOL,

          interval,

          price:
            data.candles.at(
              -1
            )?.close ||
            null,

          freshness,

          candles:
            data.candles
        });
      } catch (
        error
      ) {
        const code =
          error?.code ||
          "DATA_ERROR";

        const status =
          code === 429
            ? 429
            : 502;

        return json(
          {
            ok: false,

            error:
              code === 429
                ? "DATA_LIMIT"
                : "MARKET_DATA_ERROR",

            details:
              error?.message ||
              String(error)
          },
          status
        );
      }
    }

    if (
      url.pathname ===
      "/api/analyze"
    ) {
      try {
        return json(
          await analyzeAll(
            env
          )
        );
      } catch (
        error
      ) {
        return json(
          {
            ok: false,

            engine:
              ENGINE_VERSION,

            error:
              "ANALYSIS_FAILED",

            details:
              error?.message ||
              String(error),

            code:
              error?.code ||
              "UNKNOWN"
          },
          502
        );
      }
    }

    return json(
      {
        ok: false,

        error:
          "NOT_FOUND",

        engine:
          ENGINE_VERSION
      },
      404
    );
  }
};

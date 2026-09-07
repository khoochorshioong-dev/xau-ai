const ENGINE_VERSION = "V3.2";
const CACHE_TTL = 15;

const FRESHNESS_LIMITS = {
  "1min": 10 * 60 * 1000,
  "5min": 30 * 60 * 1000,
  "15min": 90 * 60 * 1000,
  "1h": 4 * 60 * 60 * 1000,
  "4h": 16 * 60 * 60 * 1000
};

const SESSION_UTC = {
  ASIA: { start: 0, end: 7 },
  LONDON: { start: 7, end: 13 },
  LONDON_NEW_YORK_OVERLAP: { start: 13, end: 16 },
  NEW_YORK: { start: 16, end: 21 },
  OFF_SESSION: { start: 21, end: 24 }
};

const TIMEFRAMES = [
  "1min",
  "5min",
  "15min",
  "1h",
  "4h"
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,OPTIONS",
        "access-control-allow-headers": "*",
        "cache-control": "no-store",
        ...extraHeaders
      }
    }
  );
}

function getTradingSession() {
  const hour = new Date().getUTCHours();

  if (hour >= 0 && hour < 7) {
    return {
      name: "ASIA",
      quality: "LOW"
    };
  }

  if (hour >= 7 && hour < 13) {
    return {
      name: "LONDON",
      quality: "GOOD"
    };
  }

  if (hour >= 13 && hour < 16) {
    return {
      name: "LONDON / NEW YORK OVERLAP",
      quality: "BEST"
    };
  }

  if (hour >= 16 && hour < 21) {
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

function num(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** digits;

  return Math.round(
    value * multiplier
  ) / multiplier;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function average(values) {
  const filtered = values.filter(
    Number.isFinite
  );

  if (!filtered.length) {
    return null;
  }

  return filtered.reduce(
    (sum, value) => sum + value,
    0
  ) / filtered.length;
}

function sma(values, period) {
  if (values.length < period) {
    return null;
  }

  return average(
    values.slice(-period)
  );
}

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let current =
    average(
      values.slice(0, period)
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    current =
      values[i] * multiplier +
      current * (1 - multiplier);
  }

  return current;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const difference =
      values[i] -
      values[i - 1];

    if (difference >= 0) {
      gain += difference;
    } else {
      loss += Math.abs(
        difference
      );
    }
  }

  let averageGain =
    gain / period;

  let averageLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const difference =
      values[i] -
      values[i - 1];

    const currentGain =
      Math.max(difference, 0);

    const currentLoss =
      Math.max(-difference, 0);

    averageGain =
      (
        averageGain *
        (period - 1) +
        currentGain
      ) / period;

    averageLoss =
      (
        averageLoss *
        (period - 1) +
        currentLoss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength =
    averageGain /
    averageLoss;

  return 100 -
    (
      100 /
      (1 + relativeStrength)
    );
}

function trueRanges(candles) {
  const ranges = [];

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {
    const candle =
      candles[i];

    if (i === 0) {
      ranges.push(
        candle.high -
        candle.low
      );

      continue;
    }

    const previousClose =
      candles[i - 1].close;

    ranges.push(
      Math.max(
        candle.high -
          candle.low,

        Math.abs(
          candle.high -
          previousClose
        ),

        Math.abs(
          candle.low -
          previousClose
        )
      )
    );
  }

  return ranges;
}

function atr(candles, period = 14) {
  const ranges =
    trueRanges(candles);

  return ema(
    ranges,
    period
  );
}

function macd(values) {
  const ema12 =
    ema(values, 12);

  const ema26 =
    ema(values, 26);

  if (
    ema12 == null ||
    ema26 == null
  ) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const macdLine = [];

  let currentEma12 = null;
  let currentEma26 = null;

  const multiplier12 =
    2 / 13;

  const multiplier26 =
    2 / 27;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (i === 11) {
      currentEma12 =
        average(
          values.slice(0, 12)
        );
    } else if (i > 11) {
      currentEma12 =
        values[i] *
          multiplier12 +
        currentEma12 *
          (1 - multiplier12);
    }

    if (i === 25) {
      currentEma26 =
        average(
          values.slice(0, 26)
        );
    } else if (i > 25) {
      currentEma26 =
        values[i] *
          multiplier26 +
        currentEma26 *
          (1 - multiplier26);
    }

    if (
      i >= 25 &&
      currentEma12 != null &&
      currentEma26 != null
    ) {
      macdLine.push(
        currentEma12 -
        currentEma26
      );
    }
  }

  const signal =
    ema(macdLine, 9);

  const current =
    macdLine[
      macdLine.length - 1
    ] ?? null;

  return {
    macd: current,
    signal,
    histogram:
      current != null &&
      signal != null
        ? current - signal
        : null
  };
}

function normalizeCandles(raw) {
  const values =
    Array.isArray(raw?.values)
      ? raw.values
      : [];

  return values
    .map(item => ({
      datetime:
        item.datetime,

      open:
        num(item.open),

      high:
        num(item.high),

      low:
        num(item.low),

      close:
        num(item.close),

      volume:
        num(item.volume)
    }))
    .filter(item =>
      item.open != null &&
      item.high != null &&
      item.low != null &&
      item.close != null
    )
    .reverse();
}

function detectStructure(candles) {
  if (candles.length < 20) {
    return {
      structure: "RANGE",
      bos: "NONE",
      swingHigh: null,
      swingLow: null
    };
  }

  const recent =
    candles.slice(-20);

  const previous =
    candles.slice(-40, -20);

  const recentHigh =
    Math.max(
      ...recent.map(
        candle => candle.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );

  const previousHigh =
    previous.length
      ? Math.max(
          ...previous.map(
            candle =>
              candle.high
          )
        )
      : recentHigh;

  const previousLow =
    previous.length
      ? Math.min(
          ...previous.map(
            candle =>
              candle.low
          )
        )
      : recentLow;

  const last =
    candles[
      candles.length - 1
    ];

  let structure =
    "RANGE";

  let bos =
    "NONE";

  if (
    recentHigh > previousHigh &&
    recentLow > previousLow
  ) {
    structure = "HH_HL";
  } else if (
    recentHigh < previousHigh &&
    recentLow < previousLow
  ) {
    structure = "LH_LL";
  }

  if (
    last.close >
    previousHigh
  ) {
    bos = "BULLISH";
  } else if (
    last.close <
    previousLow
  ) {
    bos = "BEARISH";
  }

  return {
    structure,
    bos,
    swingHigh: recentHigh,
    swingLow: recentLow
  };
}

function liquiditySweep(candles) {
  if (candles.length < 10) {
    return "NONE";
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(-10, -1);

  const previousHigh =
    Math.max(
      ...previous.map(
        candle => candle.high
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        candle => candle.low
      )
    );

  if (
    last.high >
      previousHigh &&
    last.close <
      previousHigh
  ) {
    return "BEARISH_SWEEP";
  }

  if (
    last.low <
      previousLow &&
    last.close >
      previousLow
  ) {
    return "BULLISH_SWEEP";
  }

  return "NONE";
}

function analyzeTimeframe(candles, timeframe) {
  const closes =
    candles.map(
      candle => candle.close
    );

  const last =
    candles[
      candles.length - 1
    ];

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const ema200 =
    ema(closes, 200);

  const r =
    rsi(closes, 14);

  const a =
    atr(candles, 14);

  const m =
    macd(closes);

  const structure =
    detectStructure(candles);

  const liquidity =
    liquiditySweep(candles);

  let bullish = 0;
  let bearish = 0;

  if (
    ema20 != null &&
    last.close > ema20
  ) {
    bullish++;
  } else if (
    ema20 != null
  ) {
    bearish++;
  }

  if (
    ema50 != null &&
    last.close > ema50
  ) {
    bullish++;
  } else if (
    ema50 != null
  ) {
    bearish++;
  }

  if (
    ema200 != null &&
    last.close > ema200
  ) {
    bullish++;
  } else if (
    ema200 != null
  ) {
    bearish++;
  }

  if (r != null) {
    if (
      r >= 52 &&
      r < 75
    ) {
      bullish++;
    } else if (
      r <= 48 &&
      r > 25
    ) {
      bearish++;
    }
  }

  if (m.histogram != null) {
    if (
      m.histogram > 0
    ) {
      bullish++;
    } else if (
      m.histogram < 0
    ) {
      bearish++;
    }
  }

  if (
    structure.structure ===
    "HH_HL"
  ) {
    bullish += 2;
  }

  if (
    structure.structure ===
    "LH_LL"
  ) {
    bearish += 2;
  }

  if (
    structure.bos ===
    "BULLISH"
  ) {
    bullish += 2;
  }

  if (
    structure.bos ===
    "BEARISH"
  ) {
    bearish += 2;
  }

  let bias =
    "NEUTRAL";

  if (
    bullish >
    bearish + 1
  ) {
    bias =
      "BULLISH";
  } else if (
    bearish >
    bullish + 1
  ) {
    bias =
      "BEARISH";
  }

  const strength =
    bullish + bearish;

  let score = 50;

  if (strength > 0) {
    score +=
      (
        (bullish - bearish) /
        strength
      ) * 30;
  }

  if (
    liquidity ===
    "BULLISH_SWEEP"
  ) {
    score += 7;
  }

  if (
    liquidity ===
    "BEARISH_SWEEP"
  ) {
    score -= 7;
  }

  if (
    m.histogram != null
  ) {
    const macdDirection =
      m.histogram > 0
        ? 1
        : -1;

    if (
      (
        bias ===
        "BULLISH" &&
        macdDirection > 0
      ) ||
      (
        bias ===
        "BEARISH" &&
        macdDirection < 0
      )
    ) {
      score += 5;
    }
  }

  score =
    Math.round(
      clamp(
        score,
        0,
        100
      )
    );

  return {
    timeframe,

    bias,

    setupScore:
      score,

    trend:
      bias,

    structure,

    momentum: {
      rsi:
        round(r, 2),

      macd:
        round(
          m.macd,
          4
        ),

      signal:
        round(
          m.signal,
          4
        ),

      histogram:
        round(
          m.histogram,
          4
        )
    },

    liquidity,

    atr:
      round(
        a,
        3
      ),

    price:
      round(
        last.close,
        2
      ),

    ema20:
      round(
        ema20,
        2
      ),

    ema50:
      round(
        ema50,
        2
      ),

    ema200:
      round(
        ema200,
        2
      ),

    candleTime:
      last.datetime
  };
}

function freshnessInfo(
  candles,
  timeframe
) {
  if (!candles.length) {
    return {
      fresh: false,
      ageMs: null,
      ageMinutes: null,
      reason:
        "NO_DATA"
    };
  }

  const last =
    candles[
      candles.length - 1
    ];

  const timestamp =
    Date.parse(
      last.datetime
    );

  if (
    !Number.isFinite(
      timestamp
    )
  ) {
    return {
      fresh: false,
      ageMs: null,
      ageMinutes: null,
      reason:
        "INVALID_TIMESTAMP"
    };
  }

  const ageMs =
    Date.now() -
    timestamp;

  const limit =
    FRESHNESS_LIMITS[
      timeframe
    ];

  return {
    fresh:
      ageMs >= 0 &&
      ageMs <= limit,

    ageMs,

    ageMinutes:
      Math.round(
        Math.max(
          0,
          ageMs
        ) / 60000
      ),

    reason:
      ageMs < 0
        ? "FUTURE_TIMESTAMP"
        : ageMs > limit
          ? "STALE_DATA"
          : "FRESH"
  };
}

function volatilityCondition(
  analysis
) {
  const atrValue =
    analysis[
      "15min"
    ]?.atr;

  const price =
    analysis[
      "15min"
    ]?.price;

  if (
    atrValue == null ||
    price == null ||
    price === 0
  ) {
    return {
      state:
        "UNKNOWN",

      atrPercent:
        null,

      warning:
        false
    };
  }

  const atrPercent =
    (
      atrValue /
      price
    ) * 100;

  if (
    atrPercent >=
    0.25
  ) {
    return {
      state:
        "HIGH",

      atrPercent:
        round(
          atrPercent,
          3
        ),

      warning:
        true
    };
  }

  if (
    atrPercent <=
    0.08
  ) {
    return {
      state:
        "LOW",

      atrPercent:
        round(
          atrPercent,
          3
        ),

      warning:
        false
    };
  }

  return {
    state:
      "NORMAL",

    atrPercent:
      round(
        atrPercent,
        3
      ),

    warning:
      false
  };
}

function marketCondition(
  analysis
) {
  const biases =
    TIMEFRAMES
      .map(
        timeframe =>
          analysis[
            timeframe
          ]?.bias
      )
      .filter(Boolean);

  const bullish =
    biases.filter(
      value =>
        value ===
        "BULLISH"
    ).length;

  const bearish =
    biases.filter(
      value =>
        value ===
        "BEARISH"
    ).length;

  if (
    bullish >= 4
  ) {
    return "STRONG_BULLISH";
  }

  if (
    bearish >= 4
  ) {
    return "STRONG_BEARISH";
  }

  if (
    bullish >= 3
  ) {
    return "BULLISH";
  }

  if (
    bearish >= 3
  ) {
    return "BEARISH";
  }

  return "MIXED";
}

function multiTimeframeBias(
  analysis
) {
  const h4 =
    analysis[
      "4h"
    ]?.bias;

  const h1 =
    analysis[
      "1h"
    ]?.bias;

  const m15 =
    analysis[
      "15min"
    ]?.bias;

  const m5 =
    analysis[
      "5min"
    ]?.bias;

  const m1 =
    analysis[
      "1min"
    ]?.bias;

  const higherBull =
    [
      h4,
      h1,
      m15
    ].filter(
      value =>
        value ===
        "BULLISH"
    ).length;

  const higherBear =
    [
      h4,
      h1,
      m15
    ].filter(
      value =>
        value ===
        "BEARISH"
    ).length;

  if (
    higherBull >= 2 &&
    m5 ===
      "BULLISH" &&
    m1 !==
      "BEARISH"
  ) {
    return "BULLISH";
  }

  if (
    higherBear >= 2 &&
    m5 ===
      "BEARISH" &&
    m1 !==
      "BULLISH"
  ) {
    return "BEARISH";
  }

  if (
    higherBull >
    higherBear
  ) {
    return "BULLISH";
  }

  if (
    higherBear >
    higherBull
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function calculateSetupScore(
  analysis
) {
  const weights = {
    "4h": 0.30,
    "1h": 0.25,
    "15min": 0.20,
    "5min": 0.15,
    "1min": 0.10
  };

  let score = 0;
  let total = 0;

  for (
    const timeframe of
    TIMEFRAMES
  ) {
    const value =
      analysis[
        timeframe
      ]?.setupScore;

    if (
      Number.isFinite(
        value
      )
    ) {
      score +=
        value *
        weights[
          timeframe
        ];

      total +=
        weights[
          timeframe
        ];
    }
  }

  if (!total) {
    return 0;
  }

  return Math.round(
    score / total
  );
}

function riskPlan(
  direction,
  price,
  atrValue
) {
  if (
    ![
      "BUY",
      "SELL"
    ].includes(
      direction
    )
  ) {
    return null;
  }

  if (
    !Number.isFinite(
      price
    ) ||
    !Number.isFinite(
      atrValue
    )
  ) {
    return null;
  }

  const stopDistance =
    Math.max(
      atrValue * 1.5,
      price * 0.001
    );

  const rewardDistance =
    stopDistance * 2;

  const entry =
    price;

  let stopLoss;
  let takeProfit;

  if (
    direction ===
    "BUY"
  ) {
    stopLoss =
      price -
      stopDistance;

    takeProfit =
      price +
      rewardDistance;
  } else {
    stopLoss =
      price +
      stopDistance;

    takeProfit =
      price -
      rewardDistance;
  }

  return {
    entry:
      round(
        entry,
        2
      ),

    stopLoss:
      round(
        stopLoss,
        2
      ),

    takeProfit:
      round(
        takeProfit,
        2
      ),

    rr:
      "1:2"
  };
}

function executionState(decision) {
  if (decision === "BUY") {
    return {
      state: "TRADE",
      executable: true
    };
  }

  if (decision === "SELL") {
    return {
      state: "TRADE",
      executable: true
    };
  }

  if (
    decision ===
    "WATCH — BUY SETUP"
  ) {
    return {
      state: "WATCH",
      executable: false
    };
  }

  if (
    decision ===
    "WATCH — SELL SETUP"
  ) {
    return {
      state: "WATCH",
      executable: false
    };
  }

  return {
    state: "NO_TRADE",
    executable: false
  };
}

function executionGate({
  decision,
  setupScore,
  session,
  volatility,
  dataFresh,
  unavailable
}) {
  const reasons = [];

  if (!dataFresh) {
    reasons.push(
      "DATA_NOT_FRESH"
    );
  }

  if (
    unavailable.length
  ) {
    reasons.push(
      "TIMEFRAME_UNAVAILABLE"
    );
  }

  if (
    session.quality ===
    "LOW"
  ) {
    reasons.push(
      "LOW_SESSION_QUALITY"
    );
  }

  if (
    volatility.warning
  ) {
    reasons.push(
      "HIGH_VOLATILITY_WARNING"
    );
  }

  if (
    decision === "BUY" ||
    decision === "SELL"
  ) {
    if (
      setupScore < 70
    ) {
      reasons.push(
        "SCORE_BELOW_70"
      );
    }
  } else {
    reasons.push(
      "NO_EXECUTABLE_SIGNAL"
    );
  }

  return {
    passed:
      dataFresh &&
      unavailable.length === 0 &&
      (
        decision === "BUY" ||
        decision === "SELL"
      ) &&
      setupScore >= 70,

    reasons
  };
}

function chooseDecision(
  analysis
) {
  const scores = {};

  for (
    const timeframe of
    TIMEFRAMES
  ) {
    scores[timeframe] =
      analysis[
        timeframe
      ];
  }

  const bull =
    [
      "4h",
      "1h",
      "15min"
    ].filter(
      timeframe =>
        scores[
          timeframe
        ]?.bias ===
        "BULLISH"
    ).length;

  const bear =
    [
      "4h",
      "1h",
      "15min"
    ].filter(
      timeframe =>
        scores[
          timeframe
        ]?.bias ===
        "BEARISH"
    ).length;

  const setupScore =
    calculateSetupScore(
      analysis
    );

  const buyAlignment =
    bull >= 2 &&
    scores[
      "5min"
    ]?.bias ===
      "BULLISH" &&
    scores[
      "1min"
    ]?.bias !==
      "BEARISH";

  const sellAlignment =
    bear >= 2 &&
    scores[
      "5min"
    ]?.bias ===
      "BEARISH" &&
    scores[
      "1min"
    ]?.bias !==
      "BULLISH";

  if (
    buyAlignment &&
    setupScore >= 70
  ) {
    return "BUY";
  }

  if (
    sellAlignment &&
    setupScore >= 70
  ) {
    return "SELL";
  }

  if (
    buyAlignment &&
    setupScore >= 50
  ) {
    return "WATCH — BUY SETUP";
  }

  if (
    sellAlignment &&
    setupScore >= 50
  ) {
    return "WATCH — SELL SETUP";
  }

  return "NO TRADE";
}

async function fetchTwelveData(
  env,
  interval
) {
  const apiKey =
    env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }

  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    "XAU/USD"
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
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `INVALID_PROVIDER_RESPONSE:${response.status}`
    );
  }

  if (
    response.status === 429 ||
    data?.code === 429
  ) {
    const error =
      new Error(
        "DATA_LIMIT"
      );

    error.status =
      429;

    error.details =
      data?.message ||
      "Twelve Data API credit limit reached";

    throw error;
  }

  if (
    !response.ok ||
    data?.status ===
      "error"
  ) {
    const error =
      new Error(
        data?.message ||
        `Provider HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.details =
      data;

    throw error;
  }

  return normalizeCandles(
    data
  );
}

async function getMarket(
  env,
  interval,
  ctx
) {
  const cache =
    caches.default;

  const cacheUrl =
    `https://xau-ai-cache.local/api/market?interval=${encodeURIComponent(interval)}`;

  const request =
    new Request(
      cacheUrl,
      {
        method: "GET"
      }
    );

  const cached =
    await cache.match(
      request
    );

  if (cached) {
    const data =
      await cached.json();

    return {
      ...data,
      cached: true
    };
  }

  let candles;

  try {
    candles =
      await fetchTwelveData(
        env,
        interval
      );
  } catch (error) {
    if (
      error?.status ===
        429 ||
      error?.message ===
        "DATA_LIMIT"
    ) {
      throw {
        type:
          "DATA_LIMIT",

        status:
          429,

        message:
          error.details ||
          "Twelve Data credit limit reached"
      };
    }

    throw error;
  }

  const freshness =
    freshnessInfo(
      candles,
      interval
    );

  const payload = {
    ok: true,

    symbol:
      "XAU/USD",

    interval,

    candles,

    freshness,

    fetchedAt:
      new Date().toISOString(),

    cached:
      false
  };

  const response =
    new Response(
      JSON.stringify(
        payload
      ),
      {
        headers: {
          "content-type":
            "application/json",

          "cache-control":
            `public, max-age=${CACHE_TTL}`
        }
      }
    );

  ctx.waitUntil(
    cache.put(
      request,
      response.clone()
    )
  );

  return payload;
}

async function analyzeAll(
  env,
  ctx
) {
  if (isWeekend()) {
    return {
      ok: true,

      engine:
        ENGINE_VERSION,

      symbol:
        "XAU/USD",

      decision:
        "NO TRADE",

      setupScore:
        0,

      price:
        null,

      analysis:
        {},

      dataStatus:
        "WEEKEND",

      unavailable:
        [],

      safety: {
        weekend:
          true,

        session:
          getTradingSession(),

        volatility: {
          state:
            "UNKNOWN",

          atrPercent:
            null,

          warning:
            false
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

      execution:
        executionState(
          "NO TRADE"
        ),

      executionGate: {
        passed:
          false,

        reasons: [
          "WEEKEND"
        ]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  const results =
    await Promise.allSettled(
      TIMEFRAMES.map(
        timeframe =>
          getMarket(
            env,
            timeframe,
            ctx
          )
      )
    );

  const analysis = {};
  const unavailable = {};
  const freshness = {};

  results.forEach(
    (result, index) => {
      const timeframe =
        TIMEFRAMES[index];

      if (
        result.status ===
        "fulfilled"
      ) {
        const market =
          result.value;

        if (
          !market.candles ||
          !market.candles.length
        ) {
          unavailable[
            timeframe
          ] = "NO_DATA";

          return;
        }

        const fresh =
          freshnessInfo(
            market.candles,
            timeframe
          );

        freshness[
          timeframe
        ] = fresh;

        if (
          !fresh.fresh
        ) {
          unavailable[
            timeframe
          ] =
            fresh.reason;

          return;
        }

        analysis[
          timeframe
        ] =
          analyzeTimeframe(
            market.candles,
            timeframe
          );
      } else {
        unavailable[
          timeframe
        ] =
          result.reason?.message ||
          "FETCH_FAILED";
      }
    }
  );

  const unavailableList =
    Object.keys(
      unavailable
    );

  const session =
    getTradingSession();

  if (
    unavailableList.length >
    0
  ) {
    return {
      ok: true,

      engine:
        ENGINE_VERSION,

      symbol:
        "XAU/USD",

      decision:
        "NO TRADE",

      setupScore:
        0,

      price:
        analysis[
          "1min"
        ]?.price ??
        analysis[
          "5min"
        ]?.price ??
        analysis[
          "15min"
        ]?.price ??
        null,

      analysis,

      freshness,

      dataStatus:
        "NOT FRESH",

      unavailable:
        unavailableList,

      unavailableDetails:
        unavailable,

      safety: {
        weekend:
          false,

        session,

        volatility:
          volatilityCondition(
            analysis
          ),

        marketCondition:
          marketCondition(
            analysis
          ),

        newsRisk:
          "NOT CHECKED",

        spread:
          "NOT CHECKED",

        slippage:
          "NOT CHECKED"
      },

      riskPlan:
        null,

      execution:
        executionState(
          "NO TRADE"
        ),

      executionGate: {
        passed:
          false,

        reasons: [
          "TIMEFRAME_DATA_NOT_READY"
        ]
      },

      generatedAt:
        new Date().toISOString()
    };
  }

  const setupScore =
    calculateSetupScore(
      analysis
    );

  const decision =
    chooseDecision(
      analysis
    );

  const price =
    analysis[
      "1min"
    ]?.price ??
    analysis[
      "5min"
    ]?.price ??
    analysis[
      "15min"
    ]?.price ??
    null;

  const atrValue =
    analysis[
      "15min"
    ]?.atr ??
    analysis[
      "5min"
    ]?.atr ??
    analysis[
      "1min"
    ]?.atr ??
    null;

  const volatility =
    volatilityCondition(
      analysis
    );

  const condition =
    marketCondition(
      analysis
    );

  const mtfBias =
    multiTimeframeBias(
      analysis
    );

  const risk =
    riskPlan(
      decision,
      price,
      atrValue
    );

  const execution =
    executionState(
      decision
    );

  const gate =
    executionGate({
      decision,

      setupScore,

      session,

      volatility,

      dataFresh:
        true,

      unavailable:
        unavailableList
    });

  return {
    ok: true,

    engine:
      ENGINE_VERSION,

    symbol:
      "XAU/USD",

    decision,

    setupScore,

    price,

    multiTimeframeBias:
      mtfBias,

    analysis,

    freshness,

    dataStatus:
      "FRESH",

    unavailable:
      unavailableList,

    safety: {
      weekend:
        false,

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

    riskPlan:
      risk,

    execution,

    executionGate:
      gate,

    generatedAt:
      new Date().toISOString()
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400"
        }
      });
    }

    const url =
      new URL(request.url);

    try {
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
            "XAU/USD",

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
          ) || "1min";

        if (
          !TIMEFRAMES.includes(
            interval
          )
        ) {
          return json({
            ok: false,

            error:
              "INVALID_INTERVAL",

            allowed:
              TIMEFRAMES
          }, 400);
        }

        if (isWeekend()) {
          return json({
            ok: false,

            error:
              "MARKET_CLOSED",

            reason:
              "WEEKEND",

            interval
          });
        }

        try {
          const data =
            await getMarket(
              env,
              interval,
              ctx
            );

          return json(
            data
          );
        } catch (error) {
          if (
            error?.type ===
            "DATA_LIMIT"
          ) {
            return json({
              ok: false,

              error:
                "DATA_LIMIT",

              details:
                error.message,

              interval
            }, 429);
          }

          return json({
            ok: false,

            error:
              "MARKET_DATA_ERROR",

            details:
              error?.message ||
              String(error),

            interval
          }, 502);
        }
      }

      if (
        url.pathname ===
        "/api/analyze"
      ) {
        const result =
          await analyzeAll(
            env,
            ctx
          );

        return json(
          result
        );
      }

      return json({
        ok: false,

        error:
          "NOT_FOUND",

        available: [
          "/health",

          "/api/market?interval=1min",

          "/api/market?interval=5min",

          "/api/market?interval=15min",

          "/api/market?interval=1h",

          "/api/market?interval=4h",

          "/api/analyze"
        ]
      }, 404);

    } catch (error) {
      return json({
        ok: false,

        error:
          "INTERNAL_ERROR",

        details:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};

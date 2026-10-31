/*
  Loads worker.js as a fresh module instance and exposes its internal
  functions for testing. worker.js stays a single deployable file
  (it can be pasted into the Cloudflare dashboard as-is).
*/

import { readFile } from "node:fs/promises";

const INTERNALS = [
  "CONFIG",
  "parseTime",
  "normalizeCandles",
  "closedCandles",
  "marketStatus",
  "tradingSession",
  "structure",
  "analyzeTimeframe",
  "weightedScore",
  "m5Pullback",
  "buildRiskPlan",
  "freshness",
  "getMarket",
  "calculateAnalysis",
  "rsi"
];

let counter = 0;

export async function loadWorker() {
  const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  const patched =
    source.replace("export default {", "const __worker = {") +
    `\nexport default __worker;\nexport { ${INTERNALS.join(", ")} };\n` +
    `// instance ${counter++}\n`;

  return import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`);
}

/* ------------------------------------------------------------------ */
/* Synthetic Twelve Data responses                                     */
/* ------------------------------------------------------------------ */

const TF_MINUTES = { "1min": 1, "5min": 5, "15min": 15, "1h": 60, "4h": 240 };

function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatUTC(ms) {
  const d = new Date(ms);

  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/*
  Builds 250 candles (newest first, like Twelve Data) whose last candle
  is still forming at `now`. `slope` is the price change per candle.
*/
export function series(interval, now, slope, { base = 2400, wave = 0.6 } = {}) {
  const step = TF_MINUTES[interval] * 60000;
  const lastOpen = Math.floor(now / step) * step;
  const values = [];

  for (let i = 0; i < 250; i++) {
    const t = lastOpen - (249 - i) * step;
    const mid = base + i * slope;
    const osc = Math.sin(i / 2) * wave;
    const open = mid + osc - slope / 2;
    const close = mid + osc + slope / 2;

    values.push({
      datetime: formatUTC(t),
      open: open.toFixed(2),
      high: (Math.max(open, close) + 0.3).toFixed(2),
      low: (Math.min(open, close) - 0.3).toFixed(2),
      close: close.toFixed(2)
    });
  }

  return { meta: { symbol: "XAU/USD", interval }, values: values.reverse(), status: "ok" };
}

export function mockFetch(handler) {
  const calls = [];

  globalThis.fetch = async url => {
    const u = new URL(url);
    const interval = u.searchParams.get("interval");

    calls.push(interval);

    const { status = 200, body } = await handler(interval, calls.length);

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  };

  return calls;
}

# XAU AI — Strict Execution System

Personal XAUUSD analysis dashboard (PWA) + Cloudflare Worker API.

| File | Role |
|------|------|
| `index.html` | Dashboard (GitHub Pages), polls the API every 35 s |
| `sw.js`, `manifest.json` | Installable PWA / offline shell (API is never cached) |
| `worker.js` | Cloudflare Worker: Twelve Data → multi-timeframe engine |
| `tests/` | Engine + API tests (`npm test`, Node 22+, no dependencies) |

## API

- `GET /health` — status, engine version, market open/closed
- `GET /api/market?interval=1min|5min|15min|1h|4h` — candles + freshness
- `GET /api/analyze` — full decision, diagnostics, execution gate, risk plan

Secret required: `TWELVE_DATA_API_KEY` (`wrangler secret put TWELVE_DATA_API_KEY`).

## Execution rules

1. Market must be open (Sun 18:00 → Fri 17:00 New York, excluding the 17:00–18:00 daily break).
2. All five timeframes must be fresh — otherwise **NO TRADE**.
3. H4 + H1 + M15 bias must agree (BUY or SELL).
4. M15 structure + liquidity sweep / BOS / CHoCH in that direction.
5. M5 aligned, with a pullback of 0.05–1.2 ATR after an impulse.
6. M1 confirmation (micro BOS or confirming candle) on a **closed** candle.
7. Direction-aware score ≥ 70, normal volatility, R:R ≥ 1:2.

All signals are computed on closed candles (no repainting); the live price is
used only for display, pullback depth and entry.

## Twelve Data quota

The free plan allows 8 requests/min and 800/day. With the cache TTLs in
`worker.js`, continuous polling costs ≈ 4 requests/min, i.e. the daily quota
lasts about 3 hours of continuous use. The dashboard stops polling while it is
in the background. If the quota is hit, the worker reuses the last good data —
which still has to pass the freshness check, so stale data never unlocks a trade.

---
Informational only. No system can guarantee profit.

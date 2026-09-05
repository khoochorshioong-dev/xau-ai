const ALLOWED_INTERVALS = new Set([
  "1min",
  "5min",
  "15min",
  "1h",
  "4h"
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders()
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "GET") {
      return json({
        ok: false,
        error: "GET requests only"
      }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "XAU AI API",
        status: "online",
        symbol: "XAU/USD"
      });
    }

    if (url.pathname === "/api/market") {
      const interval = url.searchParams.get("interval") || "5min";

      if (!ALLOWED_INTERVALS.has(interval)) {
        return json({
          ok: false,
          error: "Unsupported interval",
          allowed: [...ALLOWED_INTERVALS]
        }, 400);
      }

      if (!env.TWELVE_DATA_API_KEY) {
        return json({
          ok: false,
          error: "TWELVE_DATA_API_KEY is not configured"
        }, 500);
      }

      const apiUrl = new URL(
        "https://api.twelvedata.com/time_series"
      );

      apiUrl.searchParams.set("symbol", "XAU/USD");
      apiUrl.searchParams.set("interval", interval);
      apiUrl.searchParams.set("outputsize", "200");
      apiUrl.searchParams.set(
        "apikey",
        env.TWELVE_DATA_API_KEY
      );

      const response = await fetch(apiUrl.toString());
      const data = await response.json();

      if (!response.ok || data.status === "error") {
        return json({
          ok: false,
          error: "Twelve Data request failed",
          details: data
        }, 502);
      }

      return json({
        ok: true,
        symbol: "XAU/USD",
        interval,
        values: data.values || [],
        meta: data.meta || {}
      });
    }

    return json({
      ok: false,
      error: "Endpoint not found",
      available: [
        "/health",
        "/api/market?interval=1min",
        "/api/market?interval=5min",
        "/api/market?interval=15min",
        "/api/market?interval=1h",
        "/api/market?interval=4h"
      ]
    }, 404);
  }
};

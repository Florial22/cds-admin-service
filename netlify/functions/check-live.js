const CACHE_TTL_MS = 90 * 1000; // small in-memory cache to limit fetches
let cache = { at: 0, payload: null };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, GET",
    Vary: "Origin",
  };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promiseFactory(ctrl.signal)
    .finally(() => clearTimeout(t))
    .catch((e) => {
      throw e?.name === "AbortError" ? new Error("timeout") : e;
    });
}

async function fetchYT(url, signal) {
  return fetch(url, {
    redirect: "follow",
    signal,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
}

// Strong-signal checks ONLY on real watch pages
function liveFromWatchHtml(html) {
  return (
    /"isLiveNow"\s*:\s*true/.test(html) ||
    /"isLiveContent"\s*:\s*true/.test(html) ||
    /"liveStreamability"\s*:/.test(html) ||
    /itemprop="isLiveBroadcast"\s+content="True"/i.test(html)
  );
}

// Conservative detector:
// - TRUE only if we confirm a watch page with strong live signals.
// - FALSE in all other situations (no more loose "LIVE" heuristics).
async function isYoutubeLive(inputUrl) {
  try {
    let url = String(inputUrl || "").trim();
    if (!url) return false;

    // Normalize: add hl/gl to reduce consent/region quirks
    if (!/[?&](hl|gl)=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "hl=en&gl=US";
    }

    // Fetch channel/@handle/live (or any provided URL)
    const res1 = await withTimeout((signal) => fetchYT(url, signal), 8000);
    const finalUrl1 = res1.url || url;
    const html1 = await res1.text();

    // 1) If we already are on a watch page, decide based on STRONG signals
    if (/\/watch\?v=/.test(finalUrl1)) {
      return liveFromWatchHtml(html1);
    }

    // 2) Extract canonical watch link if present and validate
    const m = html1.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/
    );
    if (m && m[1]) {
      const watchUrl = `https://www.youtube.com/watch?v=${m[1]}&hl=en&gl=US`;
      const res2 = await withTimeout((signal) => fetchYT(watchUrl, signal), 8000);
      const html2 = await res2.text();
      return liveFromWatchHtml(html2);
    }

    // 3) No confirmed watch URL => treat as not live (avoid false positives)
    return false;
  } catch {
    // network/timeout => treat as not live
    return false;
  }
}

exports.handler = async (event) => {
  const { LIVE_JSON_URL, ALLOWED_ORIGIN } = process.env;
  const origin = event.headers.origin || ALLOWED_ORIGIN || "*";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(origin),
      body: "Method Not Allowed",
    };
  }
  if (!LIVE_JSON_URL) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: "LIVE_JSON_URL missing",
    };
  }

  // Serve from warm cache (per Lambda instance) to avoid hammering YouTube
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify(cache.payload),
    };
  }

  try {
    const upstream = await fetch(`${LIVE_JSON_URL}?t=${now}`, {
      cache: "no-store",
    });
    if (!upstream.ok) {
      return {
        statusCode: 502,
        headers: corsHeaders(origin),
        body: `Upstream ${upstream.status}`,
      };
    }
    const json = await upstream.json();
    const streams = Array.isArray(json.streams) ? json.streams : [];

    // Compute liveNow per stream (respect manual boolean if provided)
    const updated = await Promise.all(
      streams.map(async (s) => {
        const out = { ...s };
        if (typeof out.liveNow === "boolean") return out; // manual override wins
        const platform = (out.platform || "youtube").toLowerCase();
        if (platform === "youtube" && out.url) {
          out.liveNow = await isYoutubeLive(out.url);
        } else {
          out.liveNow = false; // non-YouTube not supported yet
        }
        return out;
      })
    );

    const payload = {
      version: Number(json.version) || 1,
      checkedAt: new Date().toISOString(),
      streams: updated,
    };

    cache = { at: now, payload };
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  } catch {
    return { statusCode: 500, headers: corsHeaders(origin), body: "error" };
  }
};

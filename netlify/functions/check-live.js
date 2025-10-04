const CACHE_TTL_MS = 90 * 1000; // cache results for ~90s to avoid hammering
let cache = { at: 0, payload: null };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, GET",
    "Vary": "Origin",
  };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([
    promise(ctrl.signal).finally(() => clearTimeout(t)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms + 10)),
  ]);
}

async function fetchYT(url, signal) {
  return fetch(url, {
    redirect: "follow",
    signal,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
}

// Robust detector for YouTube live status
async function isYoutubeLive(inputUrl) {
  try {
    let url = String(inputUrl || "").trim();
    if (!url) return false;

    // normalize: add hl/gl to reduce consent/region quirks
    if (!/[?&](hl|gl)=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "hl=en&gl=US";
    }

    const res1 = await withTimeout((signal) => fetchYT(url, signal), 8000);
    let finalUrl = res1.url || url;
    let html = await res1.text();

    // 1) If we already landed on a watch URL, check for live signals in the page
    if (/\/watch\?v=/.test(finalUrl)) {
      if (
        /"isLiveNow"\s*:\s*true/.test(html) ||
        /"iconType"\s*:\s*"LIVE"/.test(html) ||
        /"liveBroadcastDetails"\s*:/.test(html) ||
        /itemprop="isLiveBroadcast"\s+content="True"/i.test(html)
      ) {
        return true;
      }
      return false;
    }

    // 2) Try to extract canonical watch link from the /live or channel page
    const m = html.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/
    );
    if (m && m[1]) {
      const watchUrl = `https://www.youtube.com/watch?v=${m[1]}&hl=en&gl=US`;
      const res2 = await withTimeout((signal) => fetchYT(watchUrl, signal), 8000);
      const watchHtml = await res2.text();
      if (
        /"isLiveNow"\s*:\s*true/.test(watchHtml) ||
        /"iconType"\s*:\s*"LIVE"/.test(watchHtml) ||
        /"liveBroadcastDetails"\s*:/.test(watchHtml) ||
        /itemprop="isLiveBroadcast"\s+content="True"/i.test(watchHtml)
      ) {
        return true;
      }
      return false;
    }

    // 3) Heuristics directly on channel/live HTML
    if (
      /"isLiveNow"\s*:\s*true/.test(html) ||
      /"iconType"\s*:\s*"LIVE"/.test(html) ||
      /ytBadges"[^<]*LIVE/.test(html) ||
      /live_stream/.test(html)
    ) {
      return true;
    }
  } catch {
    // swallow errors and treat as not live
  }
  return false;
}

exports.handler = async (event) => {
  const { LIVE_JSON_URL, ALLOWED_ORIGIN } = process.env;
  const origin = event.headers.origin || ALLOWED_ORIGIN || "*";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(origin), body: "Method Not Allowed" };
  }
  if (!LIVE_JSON_URL) {
    return { statusCode: 500, headers: corsHeaders(origin), body: "LIVE_JSON_URL missing" };
  }

  // Warm cache (works during same lambda instance)
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify(cache.payload),
    };
  }

  try {
    const upstream = await fetch(`${LIVE_JSON_URL}?t=${now}`, { cache: "no-store" });
    if (!upstream.ok) {
      return { statusCode: 502, headers: corsHeaders(origin), body: `Upstream ${upstream.status}` };
    }
    const json = await upstream.json();
    const streams = Array.isArray(json.streams) ? json.streams : [];

    // Compute liveNow per stream (respect manual liveNow if already boolean)
    const updated = await Promise.all(
      streams.map(async (s) => {
        const out = { ...s };
        if (typeof out.liveNow === "boolean") return out; // manual override
        const platform = (out.platform || "youtube").toLowerCase();

        if (platform === "youtube" && out.url) {
          out.liveNow = await isYoutubeLive(out.url);
        } else {
          // TODO: support facebook/other later; for now mark false
          out.liveNow = false;
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
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: "error" };
  }
};

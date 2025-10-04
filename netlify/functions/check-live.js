const CACHE_TTL_MS = 90 * 1000; // small cache to avoid hammering
let cache = { at: 0, payload: null };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, GET",
    "Vary": "Origin"
  };
}

async function isYoutubeLive(url) {
  try {
    // follow redirects: if ends up on /watch?v=... it's live
    const res = await fetch(url, { redirect: "follow" });
    const finalUrl = res.url || url;
    if (/\/watch\?v=/.test(finalUrl) || /live_stream/.test(finalUrl)) return true;

    // Fallback: scan a bit of HTML for "isLiveNow":true (heuristic)
    const text = await res.text();
    if (/\"isLiveNow\"\s*:\s*true/.test(text)) return true;
  } catch {
    // network/invalid URL → treat as not live
  }
  return false;
}

exports.handler = async (event) => {
  const {
    LIVE_JSON_URL,               // e.g. https://zionsongs.netlify.app/live.v1.json
    ALLOWED_ORIGIN               // e.g. http://localhost:5173 (dev) or your prod domain
  } = process.env;

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

  // Tiny in-memory cache
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify(cache.payload)
    };
  }

  try {
    const res = await fetch(`${LIVE_JSON_URL}?t=${now}`, { cache: "no-store" });
    if (!res.ok) {
      return { statusCode: 502, headers: corsHeaders(origin), body: `Upstream ${res.status}` };
    }
    const json = await res.json();
    const streams = Array.isArray(json.streams) ? json.streams : [];

    // Compute liveNow for each entry
    const updated = await Promise.all(
      streams.map(async (s) => {
        const out = { ...s };
        if (typeof out.liveNow === "boolean") {
          // honor manual override if present
          return out;
        }
        if ((out.platform || "youtube") === "youtube" && out.url) {
          out.liveNow = await isYoutubeLive(out.url);
        } else {
          out.liveNow = false;
        }
        return out;
      })
    );

    const payload = {
      version: Number(json.version) || 1,
      checkedAt: new Date().toISOString(),
      streams: updated
    };

    cache = { at: now, payload };
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(origin), body: "error" };
  }
};

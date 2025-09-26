const GITHUB_API = "https://api.github.com";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Vary": "Origin"
  };
}

exports.handler = async (event) => {
  const {
    ADMIN_SECRET,
    GITHUB_TOKEN,
    BANNER_REPO,     // e.g. "youruser/cds-banner"
    BANNER_PATH,     // e.g. "banner.json"
    BANNER_BRANCH,   // e.g. "main"
    ALLOWED_ORIGIN   // e.g. "https://your-app-domain.com"
  } = process.env;

  const origin = event.headers.origin || ALLOWED_ORIGIN || "*";

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(origin), body: "Method Not Allowed" };
  }

  // Auth (simple shared secret)
  const auth = event.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!ADMIN_SECRET || token !== ADMIN_SECRET) {
    return { statusCode: 401, headers: corsHeaders(origin), body: "Unauthorized" };
  }

  if (!GITHUB_TOKEN || !BANNER_REPO || !BANNER_PATH || !BANNER_BRANCH) {
    return { statusCode: 500, headers: corsHeaders(origin), body: "Missing env" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders(origin), body: "Bad JSON" };
  }

  // Basic shape check
  if (!payload || typeof payload !== "object" || !payload.title || !payload.id) {
    return { statusCode: 400, headers: corsHeaders(origin), body: "Missing id/title" };
  }

  // Optional: validate dates if provided
  const checkISO = (s) => !s || Number.isFinite(Date.parse(s));
  if (!checkISO(payload.start) || !checkISO(payload.end)) {
    return { statusCode: 400, headers: corsHeaders(origin), body: "Bad date format" };
  }

  // 1) Get current file to obtain SHA (required by GitHub for updates)
  const getUrl = `${GITHUB_API}/repos/${BANNER_REPO}/contents/${encodeURIComponent(BANNER_PATH)}?ref=${encodeURIComponent(BANNER_BRANCH)}`;
  const getRes = await fetch(getUrl, {
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "cds-admin-service"
    }
  });

  if (!getRes.ok) {
    const text = await getRes.text();
    return { statusCode: 502, headers: corsHeaders(origin), body: `GitHub GET failed: ${getRes.status} ${text}` };
  }

  const current = await getRes.json();
  const currentSha = current.sha;

  // Merge (preserve fields not in payload)
  let currentJson;
  try {
    const currentContent = Buffer.from(current.content, current.encoding || "base64").toString("utf8");
    currentJson = JSON.parse(currentContent);
  } catch {
    currentJson = {};
  }

  const next = {
    ...currentJson,
    ...payload
  };

  const nextText = JSON.stringify(next, null, 2) + "\n";
  const nextB64 = Buffer.from(nextText, "utf8").toString("base64");

  // 2) PUT update
  const putUrl = `${GITHUB_API}/repos/${BANNER_REPO}/contents/${encodeURIComponent(BANNER_PATH)}`;
  const commitMsg = `chore(banner): update by admin (${new Date().toISOString()})`;

  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "cds-admin-service",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: commitMsg,
      content: nextB64,
      sha: currentSha,
      branch: BANNER_BRANCH
    })
  });

  if (!putRes.ok) {
    const text = await putRes.text();
    return { statusCode: 502, headers: corsHeaders(origin), body: `GitHub PUT failed: ${putRes.status} ${text}` };
  }

  return {
    statusCode: 200,
    headers: corsHeaders(origin),
    body: JSON.stringify({ ok: true, saved: next })
  };
};

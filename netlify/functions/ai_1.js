// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/ai
// Proxies requests to Anthropic with token-based rate limiting.
//
// Rate limit strategy:
//   - Each device gets a random token (generated client-side, stored in
//     localStorage). The token is sent in the X-Client-Token header.
//   - If no token is provided, one is assigned and returned in the response.
//   - Usage is tracked per token per calendar month in Netlify Blobs.
//   - Limits are per-feature per day + global per month.
//   - VPN-proof: IP is not used for tracking. Token follows the device.
//
// Daily limits per feature (generous for real users, stops abuse):
//   tt-eval    : 15/day  (TT Practice evaluation)
//   tt-question: 30/day  (TT question generation — quick + cheap)
//   ps-eval    : 10/day  (AI Studio evaluation)
//   sd-draft   : 5/day   (Speech Draft Builder)
//   eh-draft   : 8/day   (Eval Helper CRC draft)
//   tmd-script : 10/day  (TMD Script Generator)
//   tg-topics  : 10/day  (AI Topics Generator)
//   wod        : 10/day  (Word of the Day)
//   default    : 20/day  (any other feature)
//
// Monthly global limit: 150 AI calls per token.
// ═══════════════════════════════════════════════════════════════════════════

const { getStore } = require("@netlify/blobs");

const DAILY_LIMITS = {
  "tt-eval":     15,
  "tt-question": 30,
  "ps-eval":     10,
  "sd-draft":    5,
  "eh-draft":    8,
  "tmd-script":  10,
  "tg-topics":   10,
  "wod":         10,
  "default":     20
};

const MONTHLY_LIMIT = 150;

// Generate a random token (called server-side for new clients)
function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "tmc_";
  for (let i = 0; i < 16; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Key helpers
function dayKey(token) {
  const d = new Date();
  return `${token}:day:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function monthKey(token) {
  const d = new Date();
  return `${token}:month:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}

exports.handler = async (event) => {
  // CORS — allow requests from your Netlify domain + localhost dev
  const origin = event.headers["origin"] || "";
  const allowedOrigins = [
    "https://tmcompanion.netlify.app",
    "http://localhost:8888",
    "http://localhost:3000"
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Feature-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Client-Token, X-Usage-Day, X-Usage-Month"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };
  }

  // ── Token resolution ──
  let token = (event.headers["x-client-token"] || "").trim();
  const isNewToken = !token || token.length < 10;
  if (isNewToken) token = generateToken();

  // Sanitise: only allow alphanumeric + underscore, max 32 chars
  token = token.replace(/[^a-z0-9_]/g, "").slice(0, 32);
  if (!token) token = generateToken();

  // ── Feature ID for per-feature rate limiting ──
  const featureId = (event.headers["x-feature-id"] || "default").replace(/[^a-z\-]/g, "");
  const dailyLimit = DAILY_LIMITS[featureId] || DAILY_LIMITS["default"];

  // ── Rate limit check via Netlify Blobs ──
  let dayUsage = 0, monthUsage = 0;
  let store;
  try {
    store = getStore("tmc-usage");
    const dk = dayKey(token);
    const mk = monthKey(token);

    const [dayRaw, monthRaw] = await Promise.all([
      store.get(dk).catch(() => null),
      store.get(mk).catch(() => null)
    ]);

    dayUsage   = dayRaw   ? parseInt(dayRaw,   10) || 0 : 0;
    monthUsage = monthRaw ? parseInt(monthRaw, 10) || 0 : 0;

    // Check limits
    if (dayUsage >= dailyLimit) {
      return {
        statusCode: 429,
        headers: {
          ...corsHeaders,
          "X-Client-Token":  token,
          "X-Usage-Day":     String(dayUsage),
          "X-Usage-Month":   String(monthUsage),
          "X-Limit-Day":     String(dailyLimit),
          "X-Limit-Month":   String(MONTHLY_LIMIT),
          "X-Limit-Feature": featureId
        },
        body: JSON.stringify({
          error: "daily_limit_reached",
          feature: featureId,
          used: dayUsage,
          limit: dailyLimit,
          message: `Daily limit reached for this feature (${dayUsage}/${dailyLimit}). Resets at midnight UTC.`
        })
      };
    }

    if (monthUsage >= MONTHLY_LIMIT) {
      return {
        statusCode: 429,
        headers: {
          ...corsHeaders,
          "X-Client-Token":  token,
          "X-Usage-Day":     String(dayUsage),
          "X-Usage-Month":   String(monthUsage),
          "X-Limit-Month":   String(MONTHLY_LIMIT)
        },
        body: JSON.stringify({
          error: "monthly_limit_reached",
          used: monthUsage,
          limit: MONTHLY_LIMIT,
          message: `Monthly AI limit reached (${monthUsage}/${MONTHLY_LIMIT}). Resets on the 1st.`
        })
      };
    }
  } catch (blobErr) {
    // If Blobs is unavailable, log and continue — don't block the user
    console.error("Blob store unavailable:", blobErr.message);
  }

  // ── Parse request body ──
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" })
    };
  }

  const { model: _clientModel, max_tokens, system, messages } = body;

  // ── Model enforcement ──
  // Default: lock everyone to Sonnet 4.6 (cost control for pooled backend).
  // Owner bypass: send X-Owner-Key header matching OWNER_KEY env var to
  // unlock any model — including Opus. This header is never exposed in the UI.
  const ownerKey = process.env.OWNER_KEY || "";
  const clientOwnerKey = (event.headers["x-owner-key"] || "").trim();
  const isOwner = ownerKey && clientOwnerKey === ownerKey;

  const model = isOwner
    ? (_clientModel || "claude-sonnet-4-6")  // owner gets whatever they ask for
    : "claude-sonnet-4-6";                   // everyone else gets Sonnet, always

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "messages array is required" })
    };
  }

  // ── Call Anthropic ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Server configuration error: missing API key" })
    };
  }

  let anthropicResp;
  try {
    anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type":      "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key":         apiKey
      },
      body: JSON.stringify({
        model:      model      || "claude-sonnet-4-6",
        max_tokens: max_tokens || 1024,
        system:     system     || "",
        messages
      })
    });
  } catch (fetchErr) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to reach Anthropic: " + fetchErr.message })
    };
  }

  const responseText = await anthropicResp.text();

  if (!anthropicResp.ok) {
    return {
      statusCode: anthropicResp.status,
      headers: corsHeaders,
      body: responseText
    };
  }

  // ── Increment usage counters (fire-and-forget, don't block response) ──
  if (store) {
    const dk = dayKey(token);
    const mk = monthKey(token);
    Promise.all([
      store.set(dk, String(dayUsage + 1)),
      store.set(mk, String(monthUsage + 1))
    ]).catch(err => console.error("Usage increment failed:", err.message));
  }

  // ── Return response with usage headers ──
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "content-type":    "application/json",
      "X-Client-Token":  token,
      "X-Usage-Day":     String(dayUsage + 1),
      "X-Usage-Month":   String(monthUsage + 1),
      "X-Limit-Day":     String(dailyLimit),
      "X-Limit-Month":   String(MONTHLY_LIMIT)
    },
    body: responseText
  };
};

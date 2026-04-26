// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/transcribe
// Proxies audio blobs to OpenAI Whisper for transcription.
//
// Uses the same token-based rate limiting as the main ai.js function.
// Daily limit: 10 transcriptions per token (speech sessions are expensive).
// Monthly limit: shared with ai.js global counter.
//
// Model: whisper-1 at $0.006/min, or gpt-4o-mini-transcription at $0.003/min
// A 7-min speech costs ~$0.04 max. At 100 sessions/day = ~$4/day worst case.
//
// Expects: multipart/form-data with:
//   - audio: audio blob (webm, mp4, wav, mp3, m4a — max 25MB)
//   - x-client-token: same device token as ai.js
// ═══════════════════════════════════════════════════════════════════════════

const { getStore } = require("@netlify/blobs");
const { Readable } = require("stream");
const FormData = require("form-data");
const fetch = require("node-fetch");

const DAILY_LIMIT = 10;    // transcriptions per device per day
const MONTHLY_LIMIT = 150; // shared with ai.js

// ── Token validation ─────────────────────────────────────────────────────────
function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "tmc_";
  for (let i = 0; i < 16; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "OpenAI API key not configured" }) };
  }

  // ── Rate limiting (mirrors ai.js) ─────────────────────────────────────────
  let token = event.headers["x-client-token"] || "";
  let isNewToken = false;
  if (!token || !token.startsWith("tmc_")) {
    token = generateToken();
    isNewToken = true;
  }

  let store, dayUsage = 0, monthUsage = 0;
  try {
    store = getStore("tmc-rate-limits");
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const dayKey = `${token}:transcribe:${today}`;
    const monthKey = `${token}:month:${month}`;

    const [dayBlob, monthBlob] = await Promise.all([
      store.get(dayKey).catch(() => null),
      store.get(monthKey).catch(() => null)
    ]);

    dayUsage   = dayBlob   ? parseInt(await dayBlob.text(),   10) || 0 : 0;
    monthUsage = monthBlob ? parseInt(await monthBlob.text(), 10) || 0 : 0;

    if (dayUsage >= DAILY_LIMIT) {
      return {
        statusCode: 429,
        headers: { "x-client-token": token },
        body: JSON.stringify({ error: "Daily transcription limit reached", code: "day_limit" })
      };
    }
    if (monthUsage >= MONTHLY_LIMIT) {
      return {
        statusCode: 429,
        headers: { "x-client-token": token },
        body: JSON.stringify({ error: "Monthly limit reached", code: "month_limit" })
      };
    }

    // Increment before sending — prevents double-spend on error
    await Promise.all([
      store.set(dayKey,   String(dayUsage + 1),   { metadata: { ttl: 86400 } }),
      store.set(monthKey, String(monthUsage + 1), { metadata: { ttl: 2592000 } })
    ]);
  } catch (e) {
    // Blobs unavailable — allow through (fail open, log)
    console.warn("Blobs unavailable for rate limiting:", e.message);
  }

  // ── Parse audio from body ─────────────────────────────────────────────────
  // Netlify functions receive base64-encoded body for binary content
  let audioBuffer;
  let contentType = event.headers["content-type"] || "audio/webm";

  try {
    if (event.isBase64Encoded) {
      audioBuffer = Buffer.from(event.body, "base64");
    } else {
      audioBuffer = Buffer.from(event.body || "", "utf8");
    }
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid audio data" }) };
  }

  if (!audioBuffer || audioBuffer.length < 1000) {
    return { statusCode: 400, body: JSON.stringify({ error: "Audio too short or empty" }) };
  }

  // ── Send to OpenAI Whisper ────────────────────────────────────────────────
  try {
    const form = new FormData();

    // Determine file extension from content type
    const ext = contentType.includes("webm") ? "webm"
      : contentType.includes("mp4")  ? "mp4"
      : contentType.includes("wav")  ? "wav"
      : contentType.includes("m4a")  ? "m4a"
      : "webm";

    form.append("file", audioBuffer, {
      filename: `speech.${ext}`,
      contentType: contentType.split(";")[0].trim()
    });
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append("response_format", "text");
    // Prompt helps Whisper stay on topic and handle TM jargon
    form.append("prompt", "This is a Toastmasters speech or evaluation. The speaker may reference speech timing, projects, audience, evaluation criteria, and public speaking techniques.");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI error:", response.status, errText);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "Transcription failed", detail: errText })
      };
    }

    const transcript = await response.text();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "x-client-token": token,
        "x-day-usage":    String(dayUsage + 1),
        "x-day-limit":    String(DAILY_LIMIT),
        "x-month-usage":  String(monthUsage + 1)
      },
      body: JSON.stringify({ transcript: transcript.trim() })
    };

  } catch (e) {
    console.error("Transcription error:", e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Transcription service error", detail: e.message })
    };
  }
};

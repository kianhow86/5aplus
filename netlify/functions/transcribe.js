// /.netlify/functions/transcribe
// Proxies audio to OpenAI Whisper. Uses only Node.js built-ins — no npm packages.

const https = require("https");
const { getStore } = require("@netlify/blobs");

const DAILY_LIMIT = 10;
const MONTHLY_LIMIT = 150;

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "tmc_";
  for (let i = 0; i < 16; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "OpenAI API key not configured" }) };
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  let token = event.headers["x-client-token"] || "";
  if (!token || !token.startsWith("tmc_")) token = generateToken();

  let dayUsage = 0, monthUsage = 0;
  try {
    const store = getStore("tmc-rate-limits");
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const dayKey = `${token}:transcribe:${today}`;
    const monthKey = `${token}:month:${month}`;

    const [dayVal, monthVal] = await Promise.all([
      store.get(dayKey, { type: "text" }).catch(() => null),
      store.get(monthKey, { type: "text" }).catch(() => null)
    ]);

    dayUsage   = parseInt(dayVal   || "0", 10);
    monthUsage = parseInt(monthVal || "0", 10);

    if (dayUsage >= DAILY_LIMIT) {
      return { statusCode: 429, headers: { "x-client-token": token }, body: JSON.stringify({ error: "Daily transcription limit reached", code: "day_limit" }) };
    }
    if (monthUsage >= MONTHLY_LIMIT) {
      return { statusCode: 429, headers: { "x-client-token": token }, body: JSON.stringify({ error: "Monthly limit reached", code: "month_limit" }) };
    }

    await Promise.all([
      store.set(dayKey,   String(dayUsage + 1)),
      store.set(monthKey, String(monthUsage + 1))
    ]);
  } catch (e) {
    console.warn("Blobs unavailable:", e.message);
  }

  // ── Parse audio ───────────────────────────────────────────────────────────
  let audioBuffer;
  try {
    audioBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body || "", "binary");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid audio data" }) };
  }

  if (!audioBuffer || audioBuffer.length < 1000) {
    return { statusCode: 400, body: JSON.stringify({ error: "Audio too short or empty" }) };
  }

  // ── Build multipart/form-data manually ───────────────────────────────────
  const boundary = "----TMCBoundary" + Date.now().toString(16);
  const contentType = (event.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const ext = contentType.includes("webm") ? "webm"
    : contentType.includes("mp4")  ? "mp4"
    : contentType.includes("wav")  ? "wav"
    : contentType.includes("m4a")  ? "m4a" : "webm";

  const prompt = "This is a Toastmasters speech or evaluation. The speaker may reference speech timing, projects, audience, evaluation criteria, and public speaking techniques.";

  const parts = [];

  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
  ));
  // language field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`
  ));
  // response_format field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`
  ));
  // prompt field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`
  ));
  // audio file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  // ── Send to OpenAI ────────────────────────────────────────────────────────
  try {
    const result = await httpsPost({
      hostname: "api.openai.com",
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      }
    }, body);

    if (result.status !== 200) {
      console.error("OpenAI error:", result.status, result.body);
      return { statusCode: result.status, body: JSON.stringify({ error: "Transcription failed", detail: result.body }) };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "x-client-token": token,
        "x-day-usage":   String(dayUsage + 1),
        "x-day-limit":   String(DAILY_LIMIT),
        "x-month-usage": String(monthUsage + 1)
      },
      body: JSON.stringify({ transcript: result.body.trim() })
    };

  } catch (e) {
    console.error("Transcription error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "Transcription service error", detail: e.message }) };
  }
};

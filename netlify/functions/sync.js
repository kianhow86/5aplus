// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/sync
// Stores one encrypted notebook per sync code, so a member can use the same
// notebook on their phone and computer. No accounts.
//
// Privacy: the app encrypts the notebook on the device (AES-GCM, key derived
// from the sync code) before it is sent. This function only ever sees:
//   id   — SHA-256 of the sync code (64 hex chars); the code itself never arrives
//   data — the encrypted blob (base64)
// It cannot read anyone's notebook, and it cannot work out the code from the id.
//
// API
//   GET    ?id=<64 hex>[&have=<rev>]  → 200 {rev, updated, data} · 200 {rev, same:true} if have==rev · 404
//   POST   {id, base, data}           → 200 {rev} · 409 {rev, updated, data} when base is stale
//   DELETE ?id=<64 hex>               → 200 {deleted:true}
// Stored in Netlify Blobs, store "tmc-sync", key = id.
// ═══════════════════════════════════════════════════════════════════════════

const blobs = require("@netlify/blobs");

const MAX_DATA = 4 * 1024 * 1024;           // 4 MB of base64 per notebook
const ID_RE = /^[a-f0-9]{64}$/;

exports.handler = async (event) => {
  const origin = event.headers["origin"] || "";
  const allowedOrigins = [
    "https://tmcompanion.netlify.app",
    "http://localhost:8888",
    "http://localhost:3000"
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "content-type": "application/json",
    "cache-control": "no-store"
  };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  // Classic (exports.handler) functions must hand the event to Blobs first,
  // or getStore() throws "MissingBlobsEnvironmentError".
  let store;
  try {
    if (typeof blobs.connectLambda === "function") blobs.connectLambda(event);
    try { store = blobs.getStore({ name: "tmc-sync", consistency: "strong" }); }
    catch (e) { store = blobs.getStore("tmc-sync"); }
  } catch (err) {
    console.error("Sync store unavailable:", err.message);
    return reply(503, { error: "unavailable", detail: String(err.message || err).slice(0, 200) });
  }

  const read = async (id) => {
    const raw = await store.get(id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  try {
    if (event.httpMethod === "GET" || event.httpMethod === "DELETE") {
      const q = event.queryStringParameters || {};
      const id = String(q.id || "");
      if (!ID_RE.test(id)) return reply(400, { error: "bad_id" });

      if (event.httpMethod === "DELETE") {
        await store.delete(id);
        return reply(200, { deleted: true });
      }

      const cur = await read(id);
      if (!cur) return reply(404, { error: "not_found" });
      if (q.have && Number(q.have) === cur.rev) return reply(200, { rev: cur.rev, same: true });
      return reply(200, { rev: cur.rev, updated: cur.updated, data: cur.data });
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "bad_json" }); }
      const id = String(body.id || "");
      const data = body.data;
      const base = Number(body.base || 0);
      if (!ID_RE.test(id)) return reply(400, { error: "bad_id" });
      if (typeof data !== "string" || !data || data.length > MAX_DATA) return reply(413, { error: "too_large" });

      const cur = await read(id);
      const curRev = cur ? cur.rev : 0;
      if (curRev !== base) {
        // Someone else synced first: send theirs back to merge, then try again
        return reply(409, { rev: curRev, updated: cur && cur.updated, data: cur && cur.data });
      }
      const next = { rev: curRev + 1, updated: new Date().toISOString(), data };
      await store.set(id, JSON.stringify(next));
      return reply(200, { rev: next.rev, updated: next.updated });
    }

    return reply(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("Sync error:", err.message);
    return reply(500, { error: "server_error", detail: String(err.message || err).slice(0, 200) });
  }
};

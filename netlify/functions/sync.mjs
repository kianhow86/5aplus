// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/sync   (Netlify Functions v2 — replaces sync.js)
// Stores one encrypted notebook per sync code, so a member can use the same
// notebook on their phone and computer. No accounts.
//
// Privacy: the app encrypts the notebook on the device (AES-GCM, key derived
// from the sync code) before it is sent. This function only ever sees:
//   id   — SHA-256 of the sync code (64 hex chars); the code itself never arrives
//   data — the encrypted blob (base64)
//
// API
//   GET    ?ping=1                    → 200 {ok, read, write, consistency, error?}  (health check, open it in a browser)
//   GET    ?id=<64 hex>[&have=<rev>]  → 200 {rev, updated, data} · 200 {rev, same:true} · 404 {error:"not_found"}
//   POST   {id, base, data}           → 200 {rev} · 409 {rev, updated, data} when base is stale
//   DELETE ?id=<64 hex>               → 200 {deleted:true}
// Stored in Netlify Blobs, store "tmc-sync", key = id.
// ═══════════════════════════════════════════════════════════════════════════
import { getStore } from "@netlify/blobs";

const MAX_DATA = 4 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;
const ALLOWED = ["https://tmcompanion.netlify.app", "http://localhost:8888", "http://localhost:3000"];

// Strong consistency means a phone that saves and a laptop that reads a second
// later see the same thing. If this site's Blobs can't do strong reads, fall
// back to the default (eventual) rather than failing.
let mode = "strong";
function store() {
  return mode === "strong" ? getStore({ name: "tmc-sync", consistency: "strong" }) : getStore("tmc-sync");
}
async function withStore(fn) {
  try { return await fn(store()); }
  catch (err) {
    if (mode === "strong") { console.warn("Strong Blobs failed, using eventual:", err.message); mode = "eventual"; return await fn(store()); }
    throw err;
  }
}

export default async (req) => {
  const origin = req.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "content-type": "application/json",
    "cache-control": "no-store"
  };
  const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers });
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  const url = new URL(req.url);
  const q = url.searchParams;
  const read = (s, id) => s.get(id).then(raw => { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } });

  try {
    if (req.method === "GET" && q.get("ping")) {
      const out = { ok: false, read: false, write: false, consistency: mode };
      try {
        await withStore(s => s.set("__ping", new Date().toISOString())); out.write = true;
        await withStore(s => s.get("__ping")); out.read = true;
        out.ok = true; out.consistency = mode;
      } catch (err) { out.error = String(err && err.message || err).slice(0, 300); }
      return reply(out.ok ? 200 : 500, out);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const id = String(q.get("id") || "");
      if (!ID_RE.test(id)) return reply(400, { error: "bad_id" });
      if (req.method === "DELETE") {
        await withStore(s => s.delete(id));
        return reply(200, { deleted: true });
      }
      const cur = await withStore(s => read(s, id));
      if (!cur) return reply(404, { error: "not_found" });
      if (q.get("have") && Number(q.get("have")) === cur.rev) return reply(200, { rev: cur.rev, same: true });
      return reply(200, { rev: cur.rev, updated: cur.updated, data: cur.data });
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }); }
      const id = String(body.id || "");
      const data = body.data;
      const base = Number(body.base || 0);
      if (!ID_RE.test(id)) return reply(400, { error: "bad_id" });
      if (typeof data !== "string" || !data || data.length > MAX_DATA) return reply(413, { error: "too_large" });
      const cur = await withStore(s => read(s, id));
      const curRev = cur ? cur.rev : 0;
      if (curRev !== base) return reply(409, { rev: curRev, updated: cur && cur.updated, data: cur && cur.data });
      const next = { rev: curRev + 1, updated: new Date().toISOString(), data };
      await withStore(s => s.set(id, JSON.stringify(next)));
      return reply(200, { rev: next.rev, updated: next.updated });
    }

    return reply(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("Sync error:", err && err.message);
    return reply(500, { error: "server_error", detail: String(err && err.message || err).slice(0, 300) });
  }
};

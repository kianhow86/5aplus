// ═══ 5A+ TMC APP — UNIFIED DATA ENDPOINT ═══
// Replaces Firebase Realtime Database with Netlify Blobs.
// One function, three operations via the `op` query param:
//   GET  ?op=read&path=clubs/5aplus/members/kian-how
//   GET  ?op=list&prefix=clubs/5aplus/members/
//   POST body: { op:"write", path, value, clubCode }
//   POST body: { op:"delete", path, clubCode }
//
// Auth: writes require a valid clubCode (shared password). Reads are open
// (same as the original Firebase setup).
//
// Data model (unchanged from Firebase):
//   clubs/{clubId}/club               — dates, settings, announcements, meetingOverrides
//   clubs/{clubId}/members/{nameKey}  — name, path, done, plan, paths, ...
//   clubs/{clubId}/help_log/{id}      — anonymized help queries

import { getStore } from "@netlify/blobs";

// Valid club codes — matched against env vars so secrets don't live in source
// Fall back to sentinel values (never match) if env vars not set
const MEMBER_CODE = process.env.CLUB_CODE || "__UNSET_MEMBER__";
const VPE_CODE    = process.env.VPE_CODE  || "__UNSET_VPE__";
const MASTER_CODE = process.env.MASTER_CODE || "__UNSET_MASTER__";

function isValidClubCode(code) {
  if (!code) return false;
  return code === MEMBER_CODE || code === VPE_CODE || code === MASTER_CODE;
}

// Netlify Blob keys can't contain "/" reliably — flatten path into a safe key
// "clubs/5aplus/members/kian-how" → "clubs__5aplus__members__kian-how"
function pathToKey(path) {
  if (!path || typeof path !== "string") return null;
  // Allow a-z, A-Z, 0-9, dash, underscore, slash. Reject anything else.
  if (!/^[a-zA-Z0-9_\-/]+$/.test(path)) return null;
  if (path.length > 300) return null;
  return path.replace(/\//g, "__");
}

function keyToPath(key) {
  return key.replace(/__/g, "/");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // Allow app origin; Netlify is same-origin so this is redundant but safe
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export default async (req) => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") return jsonResponse({ ok: true });

    const url = new URL(req.url);
    const store = getStore("tmc-data");

    // ─── READ ───
    if (req.method === "GET") {
      const op = url.searchParams.get("op") || "read";

      if (op === "read") {
        const path = url.searchParams.get("path");
        const key = pathToKey(path);
        if (!key) return jsonResponse({ error: "invalid path" }, 400);
        const raw = await store.get(key);
        if (!raw) return jsonResponse({ value: null });
        try {
          return jsonResponse({ value: JSON.parse(raw) });
        } catch {
          // Corrupt blob — return null rather than 500
          return jsonResponse({ value: null });
        }
      }

      if (op === "list") {
        const prefix = url.searchParams.get("prefix") || "";
        const prefixKey = pathToKey(prefix);
        if (prefixKey === null) return jsonResponse({ error: "invalid prefix" }, 400);
        const { blobs } = await store.list({ prefix: prefixKey });
        // Return a map { path: value } for convenience (small data volumes)
        const result = {};
        await Promise.all(blobs.map(async (b) => {
          const raw = await store.get(b.key);
          if (raw) {
            try { result[keyToPath(b.key)] = JSON.parse(raw); } catch {}
          }
        }));
        return jsonResponse({ values: result });
      }

      return jsonResponse({ error: "unknown op" }, 400);
    }

    // ─── WRITE / DELETE ───
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch { return jsonResponse({ error: "invalid json" }, 400); }

      const { op, path, value, clubCode } = body;
      if (!isValidClubCode(clubCode)) {
        return jsonResponse({ error: "unauthorized" }, 403);
      }

      const key = pathToKey(path);
      if (!key) return jsonResponse({ error: "invalid path" }, 400);

      if (op === "write") {
        if (value === undefined) return jsonResponse({ error: "missing value" }, 400);
        // Stringify and enforce a reasonable size cap (1 MB per blob)
        const serialized = JSON.stringify(value);
        if (serialized.length > 1024 * 1024) {
          return jsonResponse({ error: "value too large" }, 413);
        }
        await store.set(key, serialized);
        return jsonResponse({ ok: true });
      }

      if (op === "delete") {
        await store.delete(key);
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "unknown op" }, 400);
    }

    return jsonResponse({ error: "method not allowed" }, 405);
  } catch (err) {
    console.error("data function error:", err);
    return jsonResponse({ error: "internal error" }, 500);
  }
};

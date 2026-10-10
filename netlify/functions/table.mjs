// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/table   (Netlify Functions v2)
// Today's Table: the spotlights people chose to share on today's Table Topic.
// One day only. Cards from earlier days are deleted automatically.
//
// What is stored (plain, since it is meant to be read by everyone who answered today):
//   name, club, strength tag, the one line K quoted, K's one-sentence why.
// Never a recording or a transcript. The owner key never arrives: only its SHA-256.
//
// API
//   GET  ?day=YYYY-MM-DD                      → 200 {day, answered, cards:[{id,name,club,tag,quote,why,ts,claps}]}
//   POST {action:"done",   day, key}          → 200 {ok}            (counts you as answered today)
//   POST {action:"share",  day, key, name, club, tag, quote, why}  → 200 {id}
//   POST {action:"clap",   day, id}           → 200 {claps}
//   POST {action:"report", day, id}           → 200 {ok}           (2 reports hide the card)
//   POST {action:"delete", day, id, key}      → 200 {ok}           (owner only)
// Store "tmc-table": day/<day>/<id> = card · done/<day>/<ownerHash> = 1
// ═══════════════════════════════════════════════════════════════════════════
import { getStore } from "@netlify/blobs";

const ALLOWED = ["https://tmcompanion.netlify.app", "http://localhost:8888", "http://localhost:3000"];
const TAGS = ["Vivid opening", "Clear point", "One story", "Strong close", "Clever pivot", "Humour", "Clear structure", "Bold opinion"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HIDE_AT = 2;                       // reports before a card is hidden
const KEEP_DAYS = 2;                     // days kept before cleanup (time zones)
const BAD = /\b(fuck|shit|cunt|bitch|nigg|fag|dick|cock|pussy|whore|slut|rape|nazi|hitler)\w*/i;

let mode = "strong";
function store() { return mode === "strong" ? getStore({ name: "tmc-table", consistency: "strong" }) : getStore("tmc-table"); }
async function withStore(fn) {
  try { return await fn(store()); }
  catch (err) { if (mode === "strong") { mode = "eventual"; return await fn(store()); } throw err; }
}
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const dayOk = d => {
  if (!DAY_RE.test(d)) return false;
  const t = Date.parse(d + "T12:00:00Z"); if (isNaN(t)) return false;
  return Math.abs(t - Date.now()) < 36 * 3600 * 1000;   // ±36h: everyone's local "today"
};
const readJSON = async (s, k) => { const raw = await s.get(k); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

async function listKeys(s, prefix) {
  const out = []; let cursor;
  do { const r = await s.list({ prefix, cursor }); (r.blobs || []).forEach(b => out.push(b.key)); cursor = r.cursor; } while (cursor);
  return out;
}
async function cleanup(s, today) {
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  for (const p of ["day/", "done/"]) {
    const keys = await listKeys(s, p);
    for (const k of keys) { const d = k.split("/")[1]; if (d && d < cutoff) await s.delete(k); }
  }
}

export default async (req) => {
  const origin = req.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "content-type": "application/json",
    "cache-control": "no-store"
  };
  const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers });
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("ping")) {
        const out = { ok: false };
        try { await withStore(s => s.set("__ping", new Date().toISOString())); out.ok = true; out.consistency = mode; }
        catch (err) { out.error = String(err && err.message || err).slice(0, 300); }
        return reply(out.ok ? 200 : 500, out);
      }
      const day = String(url.searchParams.get("day") || "");
      if (!dayOk(day)) return reply(400, { error: "bad_day" });
      const out = await withStore(async s => {
        const keys = await listKeys(s, "day/" + day + "/");
        const cards = [];
        for (const k of keys) { const c = await readJSON(s, k); if (c && (c.reports || 0) < HIDE_AT) cards.push({ id: c.id, name: c.name, club: c.club, tag: c.tag, quote: c.quote, why: c.why, ts: c.ts, claps: c.claps || 0 }); }
        cards.sort((a, b) => (b.claps - a.claps) || (b.ts > a.ts ? 1 : -1));
        const done = await listKeys(s, "done/" + day + "/");
        if (Math.random() < 0.08) { try { await cleanup(s, day); } catch (e) { console.warn("cleanup", e.message); } }
        return { day, answered: Math.max(done.length, cards.length), cards };
      });
      return reply(200, out);
    }

    if (req.method === "POST") {
      let b; try { b = await req.json(); } catch { return reply(400, { error: "bad_json" }); }
      const day = String(b.day || ""), action = String(b.action || "");
      if (!dayOk(day)) return reply(400, { error: "bad_day" });
      const key = String(b.key || "");
      const keyOk = /^[A-Za-z0-9]{16,40}$/.test(key);

      if (action === "done") {
        if (!keyOk) return reply(400, { error: "bad_key" });
        const h = await sha("tmc-table|" + key);
        await withStore(s => s.set("done/" + day + "/" + h, "1"));
        return reply(200, { ok: true });
      }

      if (action === "share") {
        if (!keyOk) return reply(400, { error: "bad_key" });
        const tag = clean(b.tag, 40); if (!TAGS.includes(tag)) return reply(400, { error: "bad_tag" });
        const quote = clean(b.quote, 240), why = clean(b.why, 260);
        if (quote.length < 4 || why.length < 4) return reply(400, { error: "bad_card" });
        let name = clean(b.name, 20), club = clean(b.club, 30);
        if (BAD.test(name) || BAD.test(club)) return reply(400, { error: "bad_name" });
        if (!name) { name = "Anonymous"; club = ""; }
        const owner = await sha("tmc-table|" + key);
        const id = (await sha(owner + "|" + day)).slice(0, 12);   // one card per person per day
        const card = { id, day, name, club, tag, quote, why, ts: new Date().toISOString(), claps: 0, reports: 0, owner };
        await withStore(async s => {
          const old = await readJSON(s, "day/" + day + "/" + id);
          if (old) { card.claps = old.claps || 0; }
          await s.set("day/" + day + "/" + id, JSON.stringify(card));
          await s.set("done/" + day + "/" + owner, "1");
        });
        return reply(200, { id });
      }

      const id = String(b.id || "");
      if (!/^[a-f0-9]{12}$/.test(id)) return reply(400, { error: "bad_id" });
      const k = "day/" + day + "/" + id;

      if (action === "clap" || action === "report") {
        const out = await withStore(async s => {
          const c = await readJSON(s, k); if (!c) return null;
          if (action === "clap") c.claps = Math.min(9999, (c.claps || 0) + 1); else c.reports = (c.reports || 0) + 1;
          await s.set(k, JSON.stringify(c));
          return { ok: true, claps: c.claps };
        });
        return out ? reply(200, out) : reply(404, { error: "not_found" });
      }

      if (action === "delete") {
        if (!keyOk) return reply(400, { error: "bad_key" });
        const owner = await sha("tmc-table|" + key);
        const out = await withStore(async s => {
          const c = await readJSON(s, k); if (!c) return "gone";
          if (c.owner !== owner) return "forbidden";
          await s.delete(k); return "ok";
        });
        if (out === "forbidden") return reply(403, { error: "not_owner" });
        return reply(200, { ok: true });
      }
      return reply(400, { error: "bad_action" });
    }
    return reply(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("Table error:", err && err.message);
    return reply(500, { error: "server_error", detail: String(err && err.message || err).slice(0, 300) });
  }
};

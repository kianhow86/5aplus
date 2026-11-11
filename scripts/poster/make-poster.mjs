#!/usr/bin/env node
// Daily Table Topic poster: renders today's topic as 1:1 (1080×1080) and 2:3 (1080×1620) PNGs.
//
//   node scripts/poster/make-poster.mjs                 # today, in POSTER_TZ (default Asia/Kuala_Lumpur)
//   node scripts/poster/make-poster.mjs 2026-10-30      # a given day
//   node scripts/poster/make-poster.mjs 2026-11-12 --out posters
//
// The topic and the "Try" technique are read from index.html and picked exactly the way the app
// picks them (_ttDailyIdx / _ttTechnique), so the poster always shows what the app shows that day.
// Needs only Playwright (pre-installed in cloud sessions; otherwise `npm i -D playwright`).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);

// ── args ──
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'posters');
const dateArg = args.find((a, i) => /^\d{4}-\d{2}-\d{2}$/.test(a) && args[i - 1] !== '--out');
const TZ = process.env.POSTER_TZ || 'Asia/Kuala_Lumpur';
const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ymd = dateArg || todayIn(TZ);
const [Y, M, D] = ymd.split('-').map(Number);

// ── read the topic bank + techniques straight from the app ──
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function grabArray(name) {
  const at = src.indexOf('const ' + name + '=');
  if (at < 0) throw new Error(name + ' not found in index.html');
  const start = src.indexOf('[', at);
  let depth = 0, k = start;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '"' || c === "'" || c === '`') { k++; while (src[k] !== c) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '[') depth++;
    if (c === ']' && --depth === 0) break;
  }
  return vm.runInNewContext('(' + src.slice(start, k + 1) + ')');
}
function grabConst(name) {
  const m = src.match(new RegExp('\\b' + name + '=((?:\\([^)]*\\)|[^,;(])+)'));
  if (!m) throw new Error(name + ' not found in index.html');
  return vm.runInNewContext('(' + m[1] + ')', { Date });
}
const pool = [];
grabArray('TOPICS_THEMES').forEach(t => pool.push(...(t.prompts || [])));
const TECHNIQUES = grabArray('TT_TECHNIQUES');
const FROM = grabConst('TT_ORDER_FROM'), STEP = grabConst('TT_ORDER_STEP'), OFF = grabConst('TT_ORDER_OFF');

// Mirrors _ttDayHash / _ttDailyIdx / _ttTechnique in index.html (same arithmetic, same quirks)
function dayHash(y, m, d) { let x = y * 10000 + m * 100 + d; x = ((x >>> 16) ^ x) * 0x45d9f3b; x = ((x >>> 16) ^ x) * 0x45d9f3b; x = (x >>> 16) ^ x; return Math.abs(x); }
const dayNo = Math.round(Date.UTC(Y, M - 1, D) / 864e5);
const n = pool.length;
const idx = dayNo < FROM ? dayHash(Y, M, D) % n : (OFF + ((dayNo - FROM) % n) * STEP) % n;
const question = pool[idx];
const technique = TECHNIQUES[(dayHash(Y, M, D) >>> 3) % TECHNIQUES.length].short;

// ── which part of the question goes gold ──
function splitHighlight(q) {
  const cut = (i, skip = 0) => [q.slice(0, i + skip).trimEnd(), q.slice(i + skip).trimStart()];
  let i;
  if ((i = q.lastIndexOf(', or ')) > 0) return cut(i, 1);          // "…, | or how you'll die?"
  if ((i = q.lastIndexOf(' — ')) > 0) return cut(i, 2);            // "…dream job — | and do you still want it?"
  const s = q.slice(0, -1).search(/[?.!]\s+[^?.!]*[?.!]?$/);        // two sentences: gold second one
  if (s > 0) return cut(s, 1);
  if ((i = q.lastIndexOf(', ')) > q.length * 0.35) return cut(i, 1); // late comma clause
  const words = q.split(' ');
  const k = words.length <= 4 ? 1 : words.length <= 9 ? 2 : 3;      // otherwise the last word(s)
  return [words.slice(0, -k).join(' '), words.slice(-k).join(' ')];
}
let [plain, gold] = splitHighlight(question);
plain = plain.replace(/ (—)$/, '\u00a0$1'); // never start a line with the dash

// ── page ──
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const words = s => s.split(' ').filter(Boolean).map(w => `<span class="w">${esc(w)}</span>`).join(' ');
const font = w => `url(data:font/woff2;base64,${fs.readFileSync(path.join(HERE, 'fonts', `bricolage-grotesque-latin-${w}-normal.woff2`)).toString('base64')}) format('woff2')`;
const qr = fs.readFileSync(path.join(HERE, 'qr-today.svg'), 'utf8');
const dateLabel = new Date(Date.UTC(Y, M - 1, D)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '').toUpperCase();

function html(w, h) {
  const tall = h > w;
  const pad = tall ? 84 : 72;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:B;font-weight:500;src:${font(500)}}
@font-face{font-family:B;font-weight:700;src:${font(700)}}
@font-face{font-family:B;font-weight:800;src:${font(800)}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px}
body{font-family:B,sans-serif;color:#F3F3F5;background:#0D0E11;overflow:hidden;
  background-image:radial-gradient(${tall ? 900 : 760}px ${tall ? 700 : 560}px at 0 0,rgba(232,197,90,.17),rgba(232,197,90,0) 70%),linear-gradient(180deg,#141416 0%,#0D0E11 55%);
  display:flex;flex-direction:column;padding:${tall ? 88 : 66}px ${pad}px ${tall ? 72 : 56}px}
.kick{font-weight:800;font-size:${tall ? 31 : 30}px;letter-spacing:.11em;line-height:1.6;text-transform:uppercase}
.kick .a{color:#E8C55A}.kick .b{color:#8A8A90}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;padding-top:${tall ? 48 : 28}px}
.q{font-weight:800;letter-spacing:-.035em;line-height:${tall ? 1.04 : 1.02};text-wrap:balance}
.q em{font-style:normal;color:#E8C55A}
.try{display:flex;align-items:center;gap:20px;margin-top:${tall ? 48 : 40}px}
.chip{background:#C9B6FF;color:#141218;font-weight:800;font-size:${tall ? 26 : 25}px;letter-spacing:.09em;padding:10px 17px;border-radius:9px}
.tech{font-weight:500;font-size:${tall ? 40 : 37}px;color:#CFCFD4;letter-spacing:-.01em}
.rule{height:2px;background:#2A2A2F;margin:${tall ? 40 : 30}px 0 ${tall ? 54 : 40}px}
.foot{display:flex;align-items:flex-end;justify-content:space-between;gap:40px}
.cta{font-weight:800;font-size:${tall ? 60 : 52}px;line-height:1.08;letter-spacing:-.03em}
.cta i{font-style:normal;color:#E8C55A;font-weight:500;margin-left:10px}
.url{font-weight:700;font-size:${tall ? 30 : 28}px;color:#E8C55A;letter-spacing:-.01em;margin-top:${tall ? 22 : 18}px}
.qr{background:#fff;border-radius:${tall ? 26 : 24}px;padding:${tall ? 18 : 18}px;width:${tall ? 200 : 180}px;height:${tall ? 200 : 180}px;flex:none}
.qr svg{width:100%;height:100%;display:block}
</style></head><body>
<div class="kick"><div class="a">Today’s Table Topic</div><div class="b">${esc(dateLabel)} · TMCompanion</div></div>
<div class="mid"><div class="q" id="q">${words(plain)} <em>${words(gold)}</em></div>
<div class="try"><span class="chip">TRY</span><span class="tech">${esc(technique)}.</span></div></div>
<div class="rule"></div>
<div class="foot"><div><div class="cta">Scan to answer<br>today’s topic<i>→</i></div><div class="url">tmcompanion.netlify.app</div></div>
<div class="qr">${qr}</div></div>
</body></html>`;
}

// Largest headline size that still fits its space (capped so short questions don't turn into a billboard)
async function fit(page, tall) {
  await page.evaluate(([maxPx, minPx]) => {
    const q = document.getElementById('q'), mid = q.parentElement, tr = mid.querySelector('.try');
    const room = mid.clientHeight - tr.offsetHeight - parseFloat(getComputedStyle(tr).marginTop) - 40;
    // a word wider than the box can't wrap, so check every word fits too
    const fitsWide = () => [...q.querySelectorAll('.w')].every(s => s.getBoundingClientRect().right <= q.getBoundingClientRect().right + 1);
    for (let px = maxPx; px >= minPx; px -= 2) {
      q.style.fontSize = px + 'px';
      if (q.offsetHeight <= room && fitsWide()) break;
    }
  }, tall ? [128, 56] : [112, 48]);
}

const { chromium } = require('playwright');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const files = [];
for (const [tag, w, h] of [['1x1', 1080, 1080], ['2x3', 1080, 1620]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html(w, h));
  await page.evaluate(() => document.fonts.ready);
  await fit(page, h > w);
  const file = path.join(OUT, `table-topic-${ymd}-${tag}.png`);
  await page.screenshot({ path: file });
  files.push(file);
  await page.close();
}
await browser.close();

const caption = `Today’s Table Topic 🎤\n\n“${question}”\n\nTry: ${technique}.\n\nAnswer it in 1–2 minutes and get instant coaching 👉 https://tmcompanion.netlify.app/#today\n\n#Toastmasters #TableTopics #PublicSpeaking`;
fs.writeFileSync(path.join(OUT, `table-topic-${ymd}-caption.txt`), caption + '\n');
console.log(JSON.stringify({ date: ymd, question, technique, files, caption: path.join(OUT, `table-topic-${ymd}-caption.txt`) }, null, 2));

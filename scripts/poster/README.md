# Daily Table Topic poster

Makes today's Table Topic as social posts: 1:1 (1080×1080) and 3:4 (1080×1440), plus a ready-to-paste caption.

```bash
node scripts/poster/make-poster.mjs              # today (POSTER_TZ, default Asia/Shanghai, Beijing time)
node scripts/poster/make-poster.mjs 2026-12-01   # any day
```

Output goes to `posters/` (git-ignored): `table-topic-YYYY-MM-DD-1x1.png`, `-3x4.png`, `-caption.txt`.

- The question and the "Try" technique are read from `index.html` and picked the same way the app picks them,
  so the poster always matches the app's topic that day.
- Gold highlight: the "…, or …" / "— …" / second-sentence part of the question, otherwise the last word or two.
- QR code (`qr-today.svg`) opens https://tmcompanion.netlify.app/#today, which goes straight to today's topic.
- Font: Bricolage Grotesque (SIL OFL, `fonts/OFL.txt`). Only dependency: Playwright.

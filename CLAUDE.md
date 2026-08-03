# Watchless

Paste a YouTube link, read the transcript. Static site plus one Netlify function.
Nothing runs on Michael's machine, and that is a requirement, not a detail.

## Brief

- **WHAT** — a hosted reader for YouTube transcripts.
- **WHO** — Michael, and anyone he sends the link to.
- **WHY** — reading a structured transcript beats scrubbing a video.
- **MUST** — no dependency on any personal machine, no secret in the browser
  bundle, and no path where a free tier turns into a bill without him choosing it.
- **DONE** — paste link, get chapters, paragraphs, timestamps, search, export.
- **ASK** — before anything that raises the spend or widens what the function reaches.

## Architecture

`site/` is the whole UI, vanilla JS and CSS, no build step. It talks to exactly one
endpoint, `/api/transcript`, and holds no keys.

`netlify/functions/transcript.mjs` is the only backend. Order: Supabase cache, then
monthly quota check, then Supadata. Keys live in Netlify environment variables.

`supabase/schema.sql` creates `watchless_transcripts` (cache) and `watchless_usage`
(spend counter) plus `watchless_spend()`, an atomic increment so two simultaneous
requests cannot both slip past the cap. Both tables have RLS on and no anon policy,
so a browser can read nothing.

## Why the provider is not optional

Measured 2026-08-03, and re-verify before anyone "simplifies" this away:

- youtube.com sends no `Access-Control-Allow-Origin`, so browser-side is dead.
- The signed `timedtext` URL returns an **empty body** — this was true from a
  residential IP as well as a server, so it is not about datacenter blocking. The
  endpoint wants a PO token.
- allorigins, corsproxy.io and r.jina.ai all came back bot-blocked or 401.
- yt-dlp works only by fetching YouTube's player JS and solving a challenge with a
  JS runtime. A 26-second serverless function is not going to reimplement that.

`fromYouTube()` stays in the file as a long shot, tried only when no provider key is
set. If YouTube ever relaxes, it resumes working on its own and costs nothing.

## Money rules

The cache is what makes this affordable: one credit per video, ever. `MONTHLY_CAP`
(default 90, under Supadata's free 100) is a hard stop, not a warning. Never raise it
or add a paid tier without asking him first — his finances are the reason it exists.

## Conventions

- Parse `json3`, never `vtt`. YouTube auto-caption VTT rolls each line 2-3 times;
  json3 marks those with `aAppend` and gives clean, word-timed events.
- Chapters come from description timestamp lines, YouTube's own rule: first at 0:00,
  three or more, or there are no chapters.
- Paragraph grouping lives in `app.js` (`paragraphs()`), not the function, so the UI
  can regroup without refetching.
- Errors always return `{error, hint}` and the UI shows both lines.

## Design — "Printout"

Watchless has its own identity and deliberately does **not** borrow Michael's Corner
or Off-Plate tokens. Those are two separate businesses; this is a tool.

The idea: a transcript is machine output, so it is set like one.

| Token | Value |
|---|---|
| paper | `#F4F1EA` |
| ink | `#1A1A17` |
| muted | `#5F5B52` |
| rule | `#D6D0C4` |
| red | `#D2231A` — the red half of a two-colour printer ribbon, the only accent |
| chrome type | IBM Plex Mono 400/600 |
| reading type | IBM Plex Serif 400 |
| radius | `0`, everywhere, no exceptions |
| shadows | none, hairlines only |
| motion | `120ms linear` for taps, one `200ms` ease-out, plus the caret blink |

Plex is the named reference on purpose: it was drawn off IBM's typewriter and
line-printer lettering, which is the whole concept. Fonts are self-hosted in
`site/assets/fonts`, latin **and latin-ext** so Czech renders.

Mono carries every piece of chrome. The serif carries only the transcript, because
3,000 words of monospace is a punishment and reading is the entire product.

House devices, use these rather than inventing more:
- Buttons are bracketed labels, `[ COPY ]`, with the brackets drawn in CSS so JS can
  still swap the text.
- A chapter prints as a separator: `[01] TITLE ─────────── 0:00`.
- The docket is a label/value grid, like a fax cover sheet.
- One perforated dashed rule between docket and tools. Once, not everywhere.
- A blinking red block caret after the wordmark.

`@media print` is maintained on purpose. It is a printout, so it should print.

**No subtitles under headings.** A number, a count or a state may sit under a title;
a restatement may not. The header stamp shows `From cache` / `Freshly pulled`,
which is state, not a tagline. It must never become one.

**Gotcha:** author `display` beats the UA sheet's `[hidden]`, so `[hidden]
{display:none!important}` is load-bearing. Without it the full-height flex sections
keep their height while "hidden" and leave a viewport of blank above the result.

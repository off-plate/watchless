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

`netlify/functions/transcript.mjs` is the only backend. Order, cheapest first:
Supabase cache, then YouTube's own InnerTube API for metadata and again for
captions, then the monthly quota check, then Supadata for whatever is left. Keys
live in Netlify environment variables.

`supabase/schema.sql` creates `watchless_transcripts` (cache) and `watchless_usage`
(spend counter) plus `watchless_spend()`, an atomic increment so two simultaneous
requests cannot both slip past the cap. Both tables have RLS on and no anon policy,
so a browser can read nothing.

## What YouTube still gives away, and what it does not

Re-measured 2026-08-20 against `youtubei/v1/player`, YouTube's own app API. It
needs no key of ours: `INNERTUBE_KEY` is the one served inside youtube.com's HTML
to every visitor. It answers each client differently, and over ten videos from a
datacenter IP:

- `ANDROID_TESTSUITE` never plays anything, but returns `videoDetails` for **9 of
  10** — title, channel, duration, description. That is every metadata field this
  used to buy, so metadata is now free and `YOUTUBE_API_KEY` is redundant.
- `ANDROID_VR` returned caption tracks for **1 of 10**. The other nine answered
  `LOGIN_REQUIRED`, "Sign in to confirm you're not a bot". That is the IP's
  reputation and not the video: a residential address does far better, which is
  why the number here is a floor rather than a verdict.
- `ANDROID`, `IOS`, `WEB`, `MWEB`, `WEB_CREATOR` and the TVHTML5 clients are all
  dead ends: 400, `UNPLAYABLE` or `LOGIN_REQUIRED` every time.

Still true, so do not go back down these roads:

- youtube.com sends no `Access-Control-Allow-Origin`, so browser-side is dead.
  `youtubei.googleapis.com` is worse — an `Origin` header alone earns a 403 — so
  there is no version of this that runs in the visitor's browser.
- The WEB client's `timedtext` URL returns an **empty body**: it wants a PO token.
  The URL `ANDROID_VR` hands back is a different, signed one carrying
  `ip=0.0.0.0&ipbits=0`, so it is valid from any address, Netlify's included.
- `youtubei/v1/get_transcript` answers "Precondition check failed" for every
  client context tried, including with `visitorData`.
- yt-dlp works only by fetching YouTube's player JS and solving a challenge with a
  JS runtime. A 26-second serverless function is not going to reimplement that.

So the provider stays, but as the fallback rather than the opening move. It is
asked only for transcripts the free path could not get, and never for metadata.

## Money rules

The cache is what makes this affordable: one credit per video, ever. `MONTHLY_CAP`
(default 90, under Supadata's free 100) is a hard stop, not a warning. Never raise it
or add a paid tier without asking him first — his finances are the reason it exists.

A request can only ever buy the transcript itself now, so a credit means one video
rather than two. The cap is checked immediately before the paid call instead of at
the top, which means a month sitting at its cap still serves everything the cache
and the free path can reach. When YouTube plays a video and lists no captions at
all, that is treated as the answer and nothing is bought to confirm it.

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
a restatement may not. The header stamp shows `From cache`, `Freshly pulled, free`
or `Freshly pulled, 1 credit`, which is state, and in the last two cases the only
place the spend is ever visible. It must never become a tagline.

**Gotcha:** author `display` beats the UA sheet's `[hidden]`, so `[hidden]
{display:none!important}` is load-bearing. Without it the full-height flex sections
keep their height while "hidden" and leave a viewport of blank above the result.

# Scribe

Paste a YouTube link, read the transcript. Static site on GitHub Pages plus a local
yt-dlp helper that does the fetching.

## Brief

- **WHAT** — a web front end for the transcript half of the `/watch` skill.
- **WHO** — Michael, on his own Mac, mostly for research and video notes.
- **WHY** — reading a structured transcript beats scrubbing a video.
- **MUST** — work on a hosted URL; never lose the transcript to a layout that reads
  like a wall of text; no backend Michael has to pay for or babysit.
- **DONE** — paste link, get chapters, paragraphs, timestamps, search, export.
- **ASK** — before adding anything that needs a hosted service or an API key.

## Architecture, and why it is split

`docs/` is the whole UI, vanilla JS and CSS, no build step. GitHub Pages serves it.

`helper/scribe_helper.py` is stdlib-only, binds `127.0.0.1:8787`, shells out to
`yt-dlp`, parses json3 captions, returns JSON. It also serves `docs/` so the tool
works with no network dependency on GitHub.

Do not try to move the fetching into the browser or into a serverless function.
This was measured, not assumed (2026-08-03):

- `youtube.com` sends no `Access-Control-Allow-Origin`, so a direct fetch is dead.
- The signed `timedtext` URL from the watch page returns an **empty body** — YouTube
  requires a PO token now.
- `allorigins`, `corsproxy.io`, `r.jina.ai` all come back bot-blocked or 401.
- `yt-dlp` from a residential IP works, solving the JS challenge via deno.

If someone finds a real hosted path later, verify it against a fresh video before
ripping the helper out.

## Conventions

- Captions: prefer published subtitles over auto-captions, and always pick the track
  matching `meta["language"]`. `automatic_captions` lists ~100 machine translations;
  never fall back to "the first one".
- Parse `json3`, not `vtt`. YouTube auto-caption VTT rolls each line 2-3 times; json3
  marks those with `aAppend` and gives clean, word-timed events. `parse_vtt` is only
  a fallback for tracks with no json3.
- Paragraph grouping lives in `app.js` (`paragraphs()`), not the helper, so the UI can
  regroup without refetching.
- Errors always return `{error, hint}` and the UI shows both lines.

## Design

Follows `Jarvis/.claude/design/DESIGN.md` and uses the Michael's Corner palette:
cream `#FAF7F2`, ink `#15130F`, one accent `#F2541B`. Clash Display for headings,
General Sans for body, Space Mono for data only (timestamps, counts, buttons).
Hairlines not shadows, 3px radius, one easing curve, no gradients.

**No subtitles under headings.** A number, a count or a state may sit under a title;
a restatement may not.

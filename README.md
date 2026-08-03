# Scribe

Paste a YouTube link, get the transcript laid out to read: chapter headings, paragraph blocks, clickable timestamps, search, and copy or download as `.txt`, `.md`, or `.srt`.

Site: https://off-plate.github.io/scribe
Local: http://127.0.0.1:8787

## Why there is a helper

The site is static. YouTube will not give a transcript to a browser:

- `youtube.com` returns no CORS headers, so the page cannot fetch it directly.
- The signed `timedtext` caption URLs return an empty body without a valid PO token.
- Public CORS proxies and any datacenter-hosted function get bot-blocked.

`yt-dlp` running on your own machine still works. So the UI is hosted, the fetching is local. The helper is a single stdlib Python file, binds `127.0.0.1` only, and talks to nothing except YouTube.

## Run it

```bash
brew install yt-dlp        # once
cd ~/"Claude Helpers/Scribe"
./helper/start.sh
```

Then open either https://off-plate.github.io/scribe or http://127.0.0.1:8787 (the helper serves the same site, so both work).

To keep it running in the background permanently:

```bash
./helper/install-autostart.sh      # launchd job, starts at login
./helper/install-autostart.sh off  # remove it
```

## API

| Route | Returns |
|---|---|
| `GET /health` | `{ok, version, ytdlp}` |
| `GET /api/transcript?url=<link>` | full payload below (`&refresh=1` bypasses the cache) |

```json
{
  "videoId": "...", "title": "...", "channel": "...", "duration": 1120,
  "captionSource": "manual|auto", "captionLang": "en", "words": 3357,
  "chapters": [{ "start": 0, "end": 44, "title": "..." }],
  "segments": [{ "start": 0.4, "end": 3.2, "text": "..." }]
}
```

Results cache to `~/.cache/scribe/<videoId>.json`, so a repeat read is instant.

## Layout

```
docs/      the site (GitHub Pages serves this folder)
helper/    scribe_helper.py, start.sh, install-autostart.sh
```

Captions come from published subtitles when the channel wrote them, auto-captions otherwise. No captions of either kind means there is nothing to show; Scribe says so rather than guessing. Audio transcription is what `/watch` is for.

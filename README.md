# Watchless

Paste a YouTube link, get the transcript laid out to read: chapter headings, paragraph blocks, clickable timestamps, search, and copy or download as `.txt`, `.md`, or `.srt`.

Nothing runs on anyone's machine. The site is static, the fetching happens in one Netlify function, and results cache in Supabase.

## Setup, once

1. **Netlify** — connect this repo. Publish directory `site`, functions `netlify/functions`. No build command.
2. **Supabase** — open the shared project's SQL editor, paste `supabase/schema.sql`, run it.
3. **Supadata** — sign up at supadata.ai, copy the API key. Free tier is 100 transcripts a month.
4. **Netlify environment variables:**

| Variable | Needed | What it does |
|---|---|---|
| `SUPADATA_API_KEY` | yes | The only working transcript source. Without it nothing loads. |
| `SUPABASE_URL` | yes | Cache and spend counter. Without it every read costs a credit. |
| `SUPABASE_SERVICE_KEY` | yes | Same. Service key, never the anon key, and never in the site folder. |
| `MONTHLY_CAP` | no | New transcripts allowed per month. Defaults to 90, under the free 100. |
| `YOUTUBE_API_KEY` | no | Free Google key, no card. Adds exact duration and real chapters. |

## Why a provider is required

Measured 2026-08-03, from a home IP and from a server:

- `youtube.com` sends no CORS headers, so the browser cannot fetch captions itself.
- The signed `timedtext` URL returns an **empty body**. YouTube wants a PO token now.
- Public proxies come back bot-blocked or 401.
- `yt-dlp` still works, but only by downloading YouTube's player JavaScript and solving a challenge with a JS runtime. That is not something a 26-second serverless function does.

So the caption fetch has to be bought from someone running residential proxies. That is what Supadata is for, and the free tier covers ordinary personal use.

## What it costs

Nothing, until it gets busy. A video read once caches forever, so it costs one credit total no matter how many times it is opened afterwards. The function refuses to spend past `MONTHLY_CAP`, so the free tier cannot quietly become a bill. When the cap is hit, already-read videos still open instantly and the counter resets on the 1st.

## Layout

```
site/                       the front end, no build step
netlify/functions/          transcript.mjs, the only backend
supabase/schema.sql         cache table, spend counter, atomic increment
```

Captions come from published subtitles when the channel wrote them, auto-captions otherwise. A video with neither has nothing to show, and Watchless says so rather than guessing.

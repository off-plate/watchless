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
| `SUPADATA_API_KEY` | almost | Buys the transcripts YouTube would not hand over. Without it, only the minority of videos that come free will load. |
| `SUPABASE_URL` | yes | Cache and spend counter. Without it every read costs a credit. |
| `SUPABASE_SERVICE_KEY` | yes | Same. Service key, never the anon key, and never in the site folder. |
| `MONTHLY_CAP` | no | New transcripts allowed per month. Defaults to 90, under the free 100. |
| `XAI_API_KEY` | no | Grok, for the brief above each transcript. Unset, and the panel simply does not appear. |
| `SUMMARY_MODEL` | no | Which Grok model writes the brief. Defaults to `grok-4`; `?selftest=1` lists the ids your key can actually reach. |
| `SUMMARY_CAP` | no | Briefs allowed per month, counted separately from transcripts. Defaults to the same number as `MONTHLY_CAP`. |
| `YOUTUBE_API_KEY` | no | Was for duration and chapters. Those now come free from YouTube's own app API, so this is a fallback for the rare video that misses. |

## The brief

Above each transcript sits a short panel: what the video is, and the points it
actually makes. It is written by Grok from the transcript, once per video, and
cached with it — reopening a video never asks again. It travels with the `.md`
export too, since it is the part worth keeping.

Videos read before this existed have no brief. Add `&refresh=1` to the request to
re-fetch one and pick it up.

## What is free and what is bought

Watchless asks YouTube's own app API first, and that one takes no key at all.

- **Metadata is free.** Title, channel, duration, and the description the chapters are read out of, came back for 9 of 10 videos tested. Nothing pays for those any more.
- **Captions are sometimes free.** The same API returned caption tracks for 1 of 10 videos when asked from a datacenter IP. The other nine answered "Sign in to confirm you're not a bot", which is a judgement about the server's address rather than about the video. When it does work, that video costs nothing at all.
- **Everything else is bought:** one credit, for the transcript alone.

`/api/transcript?selftest=1` reports which side a given deployment is on, including whether YouTube is answering that host today.

Measured 2026-08-20. The browser cannot do any of this itself: youtube.com sends no CORS headers, and `youtubei.googleapis.com` returns 403 to any request carrying an `Origin`. `yt-dlp` still works, but only by downloading YouTube's player JavaScript and solving a challenge with a JS runtime, which is not something a 26-second serverless function does.

## When it will not read anything

Open `/api/transcript?selftest=1` on the deployed site. It spends no credit and
answers with which of the three moving parts is configured, whether Supabase
answers, and how many transcripts this month has already cost. A missing
`SUPADATA_API_KEY` is the usual answer, and the usual cause is that the variable
was added in Netlify but the site was never redeployed afterwards.

It also reports `freeCaptions`, which says whether YouTube is currently answering
this host or refusing it as a bot. Refusing is normal for a server address and
only means more videos spend a credit.

If a change you expect is missing entirely, check Netlify's **Deploys** tab before
suspecting the code. Builds stop while the account has a billing problem, and
clearing the billing does not go back and build what it missed — the site keeps
serving the last deploy that succeeded until something new lands on `main` or you
trigger a deploy by hand. A site can sit weeks behind the repository this way and
look, from the outside, like a bug.

If the key is there and a link still fails, the error names the reason: a refused
key, an exhausted provider account, a video that does not exist, or a video with
no captions at all. Add `&debug=1` to the request to see what every source said.

## What it costs

Nothing, until it gets busy. A video read once caches forever, so it costs one credit total no matter how many times it is opened afterwards. The function refuses to spend past `MONTHLY_CAP`, so the free tier cannot quietly become a bill. When the cap is hit, already-read videos still open instantly and the counter resets on the 1st.

## Layout

```
site/                       the front end, no build step
netlify/functions/          transcript.mjs, the only backend
supabase/schema.sql         cache table, spend counter, atomic increment
```

Captions come from published subtitles when the channel wrote them, auto-captions otherwise. A video with neither has nothing to show, and Watchless says so rather than guessing.

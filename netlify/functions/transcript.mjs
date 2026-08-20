/* Watchless — transcript endpoint.
 *
 * GET /.netlify/functions/transcript?url=<youtube link>
 *
 * Order of operations, cheapest first:
 *   1. Supabase cache      — free, instant, and the reason credits last. A video
 *                            already read costs nothing ever again.
 *   2. InnerTube metadata  — free. Title, channel, duration and description, so
 *                            the provider is never paid for any of them.
 *   3. InnerTube captions  — free. Often refused, but a hit means this video
 *                            costs nothing at all.
 *   4. Monthly quota check — only now, because only from here can a request
 *                            spend. A month at its cap still reads anything
 *                            steps 2 and 3 can reach.
 *   5. Supadata            — the provider, for the transcript alone.
 *
 * On 2 and 3: YouTube's own app API, youtubei/v1/player, needs no key of ours —
 * the key below ships in youtube.com's own pages. It answers different clients
 * differently, and measured 2026-08-20 from a datacenter IP over ten videos:
 *
 *   ANDROID_VR         returned captions for 1 of 10. The other nine answered
 *                      LOGIN_REQUIRED, "Sign in to confirm you're not a bot".
 *                      That is the IP's reputation, not the video, and a
 *                      residential address does better. Free, so always ask.
 *   ANDROID_TESTSUITE  never plays anything, but hands back videoDetails for
 *                      9 of 10 — every metadata field this used to buy.
 *
 * The old watch-page scrape is gone: it fetched the same player response by a
 * worse route, and the WEB caption URL it produced is the PO-token-gated one
 * that returns an empty body. The signed URL these clients return carries
 * ip=0.0.0.0&ipbits=0, so it is valid from any address, including Netlify's.
 *
 * `?debug=1` reports which path won and what the others said.
 */

const SUPADATA_KEY = process.env.SUPADATA_API_KEY || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'watchless_transcripts';
const USAGE = 'watchless_usage';
const CACHE_DAYS = 90;
// Just under Supadata's 100/month free tier, so a busy month stops rather than bills.
const MONTHLY_CAP = Number(process.env.MONTHLY_CAP || 90);
// Metadata is free now, so a request can only ever buy the transcript itself.
const WORST_CASE = 1;

// YouTube's own public InnerTube key. It is not a secret and not ours: it is
// served inside youtube.com's HTML to every visitor.
const INNERTUBE = 'https://youtubei.googleapis.com/youtubei/v1/player';
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Two clients, two jobs. See the note at the top for what each one measured.
const CAPTION_CLIENT = {
  clientName: 'ANDROID_VR', clientVersion: '1.60.19',
  deviceModel: 'Quest 3', androidSdkVersion: 32,
};
const META_CLIENT = { clientName: 'ANDROID_TESTSUITE', clientVersion: '1.9', androidSdkVersion: 30 };

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/* ------------------------------------------------------------------ utils */

function videoId(input) {
  const raw = (input || '').trim();
  if (ID_RE.test(raw)) return raw;
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const c = u.pathname.slice(1).split('/')[0];
    return ID_RE.test(c) ? c : null;
  }
  if (/^(m\.|music\.)?youtube\.com$/.test(host)) {
    const v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    for (const p of ['/shorts/', '/embed/', '/live/', '/v/']) {
      if (u.pathname.startsWith(p)) {
        const c = u.pathname.slice(p.length).split('/')[0];
        return ID_RE.test(c) ? c : null;
      }
    }
  }
  return null;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** Never let an upstream message echo a key back into the page. */
function redact(text) {
  let out = String(text);
  for (const secret of [SUPADATA_KEY, SB_KEY, YT_KEY]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** An upstream failure that keeps its status code. The status is the whole
 *  difference between "the key is wrong" and "the video has no captions", and
 *  throwing a bare string threw that difference away. */
function upstream(label, res, body) {
  const err = new Error(redact(body.message || body.error || `${label} ${res.status}`));
  err.status = res.status;
  return err;
}

/** Auth and quota refusals will refuse the same way twice; nothing else will. */
const terminal = (err) => [401, 402, 403, 429].includes(err?.status);

async function get(url, extra = {}) {
  return fetch(url, {
    ...extra,
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      cookie: 'CONSENT=YES+1',
      ...(extra.headers || {}),
    },
  });
}

/* ------------------------------------------------------------- transcript */

/** YouTube's json3 caption format: clean, word-timed, no rolling duplicates. */
function parseJson3(data) {
  const out = [];
  for (const ev of data.events || []) {
    if (ev.aAppend || !ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = start + (ev.dDurationMs || 0) / 1000;
    if (out.length && out[out.length - 1].text === text) {
      out[out.length - 1].end = +end.toFixed(2);
      continue;
    }
    out.push({ start: +start.toFixed(2), end: +end.toFixed(2), text });
  }
  return out;
}

function pickTrack(tracks, spoken) {
  const lang = (spoken || 'en').split('-')[0].toLowerCase();
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const auto = tracks.filter((t) => t.kind === 'asr');
  const byLang = (pool) => pool.find((t) => (t.languageCode || '').split('-')[0].toLowerCase() === lang);
  if (manual.length) return { track: byLang(manual) || manual[0], source: 'manual' };
  if (auto.length) return { track: byLang(auto) || auto[0], source: 'auto' };
  return null;
}

/** Chapters as YouTube itself builds them: timestamp lines in the description,
 *  first one at 0:00, at least three of them. */
function chaptersFromDescription(text, duration) {
  if (!text) return [];
  const found = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[(\[]?(\d{1,2}:\d{2}(?::\d{2})?)[)\]]?\s*[-–:|]?\s*(.+?)\s*$/);
    if (!m) continue;
    const parts = m[1].split(':').map(Number);
    const start = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    const title = m[2].replace(/^[-–:|\s]+/, '').trim();
    if (title) found.push({ start, title });
  }
  if (found.length < 3 || found[0].start !== 0) return [];
  return found.map((c, i) => ({
    start: c.start,
    end: i + 1 < found.length ? found[i + 1].start : duration || 0,
    title: c.title,
  }));
}

/** YouTube's app API. No key of ours, no quota, no bill. */
async function innertube(client, id) {
  const res = await fetch(`${INNERTUBE}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      context: { client: { ...client, hl: 'en', gl: 'US' } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw upstream('innertube', res, body.error || body);
  return body;
}

/** Title, channel, duration and chapters, for nothing. This is what the provider
 *  used to be paid a credit for, and what YOUTUBE_API_KEY was optional for. */
async function metaFromYouTube(id) {
  const d = await innertube(META_CLIENT, id);
  const v = d.videoDetails || {};
  if (!v.title) throw new Error('no video details');
  const duration = Number(v.lengthSeconds || 0);
  return {
    title: v.title,
    channel: v.author || '',
    duration,
    chapters: chaptersFromDescription(v.shortDescription, duration),
    language: v.defaultAudioLanguage || '',
    billed: 0,
  };
}

/** The free transcript. Refused more often than not from a datacenter address,
 *  but it costs nothing to ask and a hit means this video never buys anything. */
async function captionsFromYouTube(id) {
  const d = await innertube(CAPTION_CLIENT, id);
  const status = d.playabilityStatus || {};
  if (status.status && status.status !== 'OK') {
    throw new Error(`${status.status}: ${status.reason || 'no reason given'}`);
  }

  const tracks = d.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    // YouTube played the video and listed no captions. That is not a refusal to
    // answer, it is the answer, so there is nothing worth buying afterwards.
    const err = new Error('no caption tracks');
    err.certain = true;
    throw err;
  }

  const details = d.videoDetails || {};
  const chosen = pickTrack(tracks, details.defaultAudioLanguage || tracks[0].languageCode);
  if (!chosen) throw new Error('no usable caption track');

  // The URL arrives asking for srv3; json3 is the one without rolling duplicates.
  const capUrl = new URL(chosen.track.baseUrl);
  capUrl.searchParams.set('fmt', 'json3');
  const capRes = await get(capUrl.toString());
  if (!capRes.ok) throw new Error(`caption fetch ${capRes.status}`);
  const text = await capRes.text();
  if (!text.trim()) throw new Error('caption body empty (PO token required)');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Almost always a consent or bot-check page served in place of the captions.
    throw new Error(`caption body was not json3: ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
  }

  const segments = parseJson3(data);
  if (!segments.length) throw new Error('caption track had no cues');

  const duration = Number(details.lengthSeconds || 0);
  return {
    segments,
    captionSource: chosen.source,
    captionLang: chosen.track.languageCode || '',
    title: details.title || '',
    channel: details.author || '',
    duration,
    chapters: chaptersFromDescription(details.shortDescription, duration),
    via: 'youtube',
    billed: 0,
  };
}

/** The transcript itself.
 *
 *  `lang` matters more than it looks: left unset, Supadata returns the FIRST
 *  AVAILABLE language, which is alphabetical, so an English video comes back in
 *  Arabic. Always ask for something. Offsets and durations are milliseconds. */
async function fromSupadata(id, want) {
  const qs = new URLSearchParams({ videoId: id, text: 'false' });
  if (want) qs.set('lang', want);

  const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?${qs}`, {
    headers: { 'x-api-key': SUPADATA_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw upstream('supadata', res, body);

  const raw = body.content;
  if (!Array.isArray(raw) || !raw.length) throw new Error('supadata returned no cues');

  const segments = raw.map((c) => {
    const start = Number(c.offset || 0) / 1000;
    const end = start + Number(c.duration || 0) / 1000;
    return {
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      text: String(c.text || '').replace(/\s+/g, ' ').trim(),
    };
  }).filter((s) => s.text);

  if (!segments.length) throw new Error('supadata cues were all empty');

  return {
    segments,
    // Supadata does not say whether a track was written or machine-made, so do
    // not claim either. The UI shows the language instead.
    captionSource: 'provider',
    captionLang: body.lang || want || '',
    availableLangs: body.availableLangs || [],
    via: 'supadata',
    billed: 1,
  };
}

/** Which caption language to ask the provider for. YouTube's own metadata is the
 *  signal; when it stays quiet, English is the guess, and the retry without any
 *  language is what catches the guess being wrong. Asking for nothing up front is
 *  worse than guessing: unset, the provider returns the first language
 *  alphabetically, so an English video comes back in Arabic. */
function preferLang(metaLang) {
  return metaLang ? String(metaLang).split('-')[0].toLowerCase() : 'en';
}

/* -------------------------------------------------------------- metadata */

/** Free, no key, no quota. Gives title, channel, thumbnail. */
async function fromOembed(id) {
  // The inner URL has to be encoded. Unencoded, `?v=` and `&format=` bind to the
  // oembed call instead, so it was asking about `/watch` with no video and being
  // told 401 every time.
  const target = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
  const res = await get(`https://www.youtube.com/oembed?url=${target}&format=json`);
  if (!res.ok) return {};
  const d = await res.json().catch(() => ({}));
  return { title: d.title || '', channel: d.author_name || '' };
}

/** Free key, no card, 10k units a day. Gives duration and real chapters. */
async function fromDataApi(id) {
  if (!YT_KEY) return {};
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${id}&key=${YT_KEY}`
  );
  if (!res.ok) return {};
  const d = await res.json().catch(() => ({}));
  const item = (d.items || [])[0];
  if (!item) return {};
  const iso = item.contentDetails?.duration || '';
  const p = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  const duration = (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0);
  return {
    title: item.snippet?.title || '',
    channel: item.snippet?.channelTitle || '',
    duration,
    chapters: chaptersFromDescription(item.snippet?.description, duration),
    language: item.snippet?.defaultAudioLanguage || item.snippet?.defaultLanguage || '',
    billed: 0,
  };
}

/* ----------------------------------------------------------------- cache */

async function cacheGet(id) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/${TABLE}?video_id=eq.${id}&select=payload,fetched_at`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    const age = (Date.now() - new Date(rows[0].fetched_at).getTime()) / 86400000;
    return age > CACHE_DAYS ? null : rows[0].payload;
  } catch { return null; }
}

/* ----------------------------------------------------------------- quota */

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Counts only calls that would spend a credit. Cache hits never reach here. */
async function quota() {
  if (!SB_URL || !SB_KEY) return { used: 0, allowed: true };
  try {
    const month = thisMonth();
    const res = await fetch(`${SB_URL}/rest/v1/${USAGE}?month=eq.${month}&select=count`, {
      headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
    });
    const rows = res.ok ? await res.json() : [];
    const used = rows[0]?.count || 0;
    return { used, allowed: used + WORST_CASE <= MONTHLY_CAP, month };
  } catch {
    return { used: 0, allowed: true };
  }
}

async function spend(month) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/watchless_spend`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        authorization: `Bearer ${SB_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ m: month || thisMonth() }),
    });
  } catch { /* never fail a good request over bookkeeping */ }
}

async function cachePut(id, payload) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        authorization: `Bearer ${SB_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        video_id: id,
        title: payload.title,
        payload,
        fetched_at: new Date().toISOString(),
      }),
    });
  } catch { /* a cache miss is not worth failing the request over */ }
}

/* ----------------------------------------------------------- diagnostics */

/** Name the real failure. The old answer to every provider error was "this video
 *  has no captions", which sends you off to blame the video when the usual cause
 *  is a key Netlify never got. */
function diagnose(err, hasKey) {
  const status = err?.status || 0;
  const said = err?.message || '';
  if (status === 401 || status === 403) {
    return [502, 'The transcript provider refused the key',
      `Supadata answered ${status}, so SUPADATA_API_KEY is missing, mistyped, or expired. Check it in Netlify and redeploy after changing it. It said: ${said}`];
  }
  if (status === 402 || status === 429) {
    return [502, 'The provider account is out of credits',
      `Supadata answered ${status}. That is their limit, not the cap of ${MONTHLY_CAP} this site keeps. Their free tier resets monthly. It said: ${said}`];
  }
  // Order matters: a missing transcript also comes back as a 404, so read what it
  // says before trusting the number, or every silent video becomes a dead link.
  if (/\bno (caption|subtitle|transcript)|transcript.{0,20}not available|not available.{0,20}(transcript|language)/i.test(said)) {
    return [502, 'That video has no captions',
      `Nobody published subtitles and YouTube made none automatically, so there is nothing to read. The provider said: ${said}`];
  }
  if (status === 404 || /not found|unavailable|private|does not exist/i.test(said)) {
    return [404, 'That video does not exist',
      'It may be private, deleted, region-locked, or the link may have a typo in it.'];
  }
  if (!hasKey) {
    return [502, 'No transcript provider is configured',
      `YouTube refused the free path for this video and there is no provider to fall back on. Add SUPADATA_API_KEY in Netlify under Site configuration \u2192 Environment variables, then redeploy. YouTube said: ${said || 'nothing useful'}`];
  }
  return [502, 'Could not get a transcript for that video',
    said ? `The provider said: ${said}` : 'No source would answer. Add &debug=1 to the request to see what each one said.'];
}

/** What is configured and what answers, spending nothing. When the app reads
 *  nothing at all, this says which of the three moving parts is missing without
 *  anyone pasting links to find out. Booleans only, never a key. */
async function selftest() {
  const out = {
    provider: SUPADATA_KEY ? 'SUPADATA_API_KEY is set' : 'SUPADATA_API_KEY is MISSING \u2014 nothing will load',
    cache: SB_URL && SB_KEY ? 'Supabase is configured' : 'Supabase is MISSING \u2014 every read would cost a credit',
    youtubeKey: YT_KEY ? 'YOUTUBE_API_KEY is set' : 'YOUTUBE_API_KEY is unset (optional: chapters and exact duration)',
    monthlyCap: MONTHLY_CAP,
  };
  if (SB_URL && SB_KEY) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/${USAGE}?select=month,count&month=eq.${thisMonth()}`, {
        headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
      });
      out.cacheReachable = res.ok;
      out.cacheStatus = res.status;
      if (res.ok) out.spentThisMonth = (await res.json().catch(() => []))[0]?.count || 0;
      else out.cacheSaid = redact((await res.text().catch(() => '')).slice(0, 200));
    } catch (err) {
      out.cacheReachable = false;
      out.cacheSaid = redact(err.message);
    }
  }
  // The whole free path, end to end, against a video that certainly has captions.
  // Not just the player call: the caption fetch is the step that behaves
  // differently from one host to the next, so it is the step worth proving. It
  // buys nothing, and its answer decides how much of a month gets billed.
  try {
    const probe = await captionsFromYouTube('dQw4w9WgXcQ');
    out.freeCaptions = `working — ${probe.segments.length} cues (${probe.captionLang}) pulled from the probe video for nothing, so videos YouTube allows will not spend a credit`;
  } catch (err) {
    out.freeCaptions = `refused by YouTube: ${redact(err.message)}. Normal for a server address; it only means every new video spends a credit.`;
  }
  return json(200, out);
}

/* ---------------------------------------------------------------- handler */

export default async (request) => {
  const url = new URL(request.url);
  const debug = url.searchParams.get('debug') === '1';
  if (url.searchParams.get('selftest') === '1') return selftest();

  const id = videoId(url.searchParams.get('url') || '');

  if (!id) {
    return json(400, {
      error: 'That is not a YouTube link',
      hint: 'Paste a youtube.com/watch, youtu.be, or /shorts URL.',
    });
  }

  if (url.searchParams.get('refresh') !== '1') {
    const hit = await cacheGet(id);
    if (hit) return json(200, { ...hit, cached: true });
  }

  const tried = [];
  let core = null;
  let meta = {};
  let billed = 0;
  let failure = null;
  let certain = false;
  let month = thisMonth();

  // Free metadata, whatever else happens. Nothing below has to buy a title.
  try {
    meta = await metaFromYouTube(id);
  } catch (err) {
    tried.push(`youtube meta: ${err.message}`);
    if (YT_KEY) meta = await fromDataApi(id);
    if (!meta.title) meta = { ...meta, ...(await fromOembed(id)) };
  }

  // Free captions. Usually refused, and free to be refused.
  try {
    core = await captionsFromYouTube(id);
  } catch (err) {
    tried.push(`youtube captions: ${err.message}`);
    certain = !!err.certain;
    failure = err;
  }

  // Only now can this request cost anything, so only now does the cap apply. A
  // month at its cap still reads every video the free paths above can reach.
  if (!core && !certain && SUPADATA_KEY) {
    const spent = await quota();
    month = spent.month || month;
    if (!spent.allowed) {
      return json(429, {
        error: 'This month is spent',
        hint: `${spent.used} new transcripts already this month, and the cap is ${MONTHLY_CAP}. Videos read before still open instantly, and so does anything YouTube hands over for free. The count resets on the 1st.`,
      });
    }

    const want = preferLang(meta.language);
    try {
      core = await fromSupadata(id, want);
      billed += core.billed;
      failure = null;
    } catch (err) {
      tried.push(`supadata (${want}): ${err.message}`);
      failure = err;
      // The pinned language is a guess whenever the metadata came back thin, and
      // that guess falls through to English. Ask again without it rather than
      // tell someone their Czech video has no captions. A refused call is not a
      // billed call, so the retry costs a credit only if it is the one that works.
      if (want && !terminal(err)) {
        try {
          core = await fromSupadata(id, '');
          billed += core.billed;
          failure = null;
        } catch (second) {
          tried.push(`supadata (any language): ${second.message}`);
          failure = second;
        }
      }
    }
  }

  for (let i = 0; i < billed; i++) await spend(month);

  if (!core) {
    const [status, error, hint] = diagnose(failure, !!SUPADATA_KEY);
    return json(status, { error, hint, ...(debug ? { tried } : {}) });
  }

  const duration = core.duration || meta.duration
    || Math.round(core.segments[core.segments.length - 1]?.end || 0);
  const payload = {
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: core.title || meta.title || id,
    channel: core.channel || meta.channel || '',
    duration,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    captionLang: core.captionLang || '',
    captionSource: core.captionSource,
    words: core.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
    chapters: (core.chapters?.length ? core.chapters : meta.chapters) || [],
    segments: core.segments,
    // What this copy cost to make. Cached alongside the transcript, so reopening
    // a video keeps saying what it originally spent rather than claiming free.
    cost: billed,
    cached: false,
    ...(debug ? { via: core.via, tried } : {}),
  };

  await cachePut(id, payload);
  return json(200, payload);
};

export const config = { path: '/api/transcript' };

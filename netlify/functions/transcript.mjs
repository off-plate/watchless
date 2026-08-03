/* Watchless — transcript endpoint.
 *
 * GET /.netlify/functions/transcript?url=<youtube link>
 *
 * Order of operations:
 *   1. Supabase cache      — free, instant, and the reason credits last. A video
 *                            already read costs nothing ever again.
 *   2. Monthly quota check — refuses to spend past MONTHLY_CAP so the free tier
 *                            can never quietly turn into a bill.
 *   3. Supadata            — the provider. Required, not optional.
 *   4. Direct from YouTube — kept as a long shot only.
 *
 * On 4: measured 2026-08-03 from both a residential IP and a server, YouTube's
 * timedtext endpoint returns an EMPTY body without a PO token. yt-dlp only gets
 * through by running YouTube's player JS and solving a challenge, which is not
 * something a 26-second serverless function is going to do. So this path is
 * tried only when no provider key is set, and it is expected to fail. If YouTube
 * ever relaxes, it starts working again on its own.
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

/** Strategy 2: straight off the watch page. Free, and blocked more often than not. */
async function fromYouTube(id) {
  const res = await get(`https://www.youtube.com/watch?v=${id}`);
  if (!res.ok) throw new Error(`watch page ${res.status}`);
  const html = await res.text();

  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|const|let|<\/script>)/s);
  if (!m) throw new Error('no player response (bot check)');

  let player;
  try { player = JSON.parse(m[1]); } catch { throw new Error('player response unparseable'); }

  const status = player.playabilityStatus || {};
  if (status.status && status.status !== 'OK') {
    throw new Error(`${status.status}: ${status.reason || 'unavailable'}`);
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('no caption tracks');

  const details = player.videoDetails || {};
  const chosen = pickTrack(tracks, details.defaultAudioLanguage || tracks[0].languageCode);
  if (!chosen) throw new Error('no usable caption track');

  const capRes = await get(`${chosen.track.baseUrl}&fmt=json3`);
  const body = await capRes.text();
  if (!body.trim()) throw new Error('caption body empty (PO token required)');

  const segments = parseJson3(JSON.parse(body));
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
  };
}

/** Supadata video metadata: title, channel, duration, description, caption languages.
 *  Costs a credit, so it is only called when there is no free YouTube key. */
async function supadataVideo(id) {
  const res = await fetch(`https://api.supadata.ai/v1/youtube/video?id=${id}`, {
    headers: { 'x-api-key': SUPADATA_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `supadata video ${res.status}`);
  const duration = Number(body.duration || 0);
  return {
    title: body.title || '',
    channel: body.channel?.name || '',
    duration,
    chapters: chaptersFromDescription(body.description, duration),
    langs: body.transcriptLanguages || [],
    billed: 1,
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
  if (!res.ok) throw new Error(body.message || body.error || `supadata ${res.status}`);

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

/** Which caption language to ask for, best signal first. */
function preferLang(metaLang, available) {
  const pool = (available || []).map((l) => String(l).toLowerCase());
  const base = (l) => String(l || '').split('-')[0].toLowerCase();
  if (metaLang) {
    const hit = pool.find((l) => base(l) === base(metaLang));
    if (hit) return hit;
    if (!pool.length) return base(metaLang);
  }
  const english = pool.find((l) => base(l) === 'en');
  return english || pool[0] || 'en';
}

/* -------------------------------------------------------------- metadata */

/** Free, no key, no quota. Gives title, channel, thumbnail. */
async function fromOembed(id) {
  const res = await get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
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
    return { used, allowed: used < MONTHLY_CAP, month };
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

/* ---------------------------------------------------------------- handler */

export default async (request) => {
  const url = new URL(request.url);
  const debug = url.searchParams.get('debug') === '1';
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

  const { used, allowed, month } = await quota();
  if (!allowed) {
    return json(429, {
      error: 'This month is spent',
      hint: `${used} new transcripts already this month, and the cap is ${MONTHLY_CAP}. Videos read before still open instantly. The count resets on the 1st.`,
    });
  }

  const tried = [];
  let core = null;
  let meta = {};
  let billed = 0;

  if (SUPADATA_KEY) {
    // Metadata first, because it decides which caption language to ask for.
    // The Google key is free, so it saves a credit whenever it is configured.
    if (YT_KEY) meta = await fromDataApi(id);

    if (!meta.title) {
      try {
        const video = await supadataVideo(id);
        billed += video.billed;
        meta = { ...video, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v)) };
      } catch (err) {
        tried.push(`supadata video: ${err.message}`);
      }
    }
    if (!meta.title) meta = { ...meta, ...(await fromOembed(id)) };

    try {
      core = await fromSupadata(id, preferLang(meta.language, meta.langs));
      billed += core.billed;
    } catch (err) {
      tried.push(`supadata: ${err.message}`);
    }
  }

  // Free long shot, only when there is no provider to ask.
  if (!core && !SUPADATA_KEY) {
    try {
      core = await fromYouTube(id);
    } catch (err) {
      tried.push(`youtube: ${err.message}`);
    }
  }

  for (let i = 0; i < billed; i++) await spend(month);

  if (!core) {
    const missing = tried.some((t) => /not found|404|unavailable/i.test(t));
    if (missing) {
      return json(404, {
        error: 'That video does not exist',
        hint: 'It may be private, deleted, or the link may have a typo in it.',
        ...(debug ? { tried } : {}),
      });
    }
    return json(502, {
      error: 'Could not get a transcript for that video',
      hint: SUPADATA_KEY
        ? 'The video has no captions in any language, so there is nothing to read.'
        : 'No transcript provider is configured yet, and YouTube will not serve captions directly.',
      ...(debug ? { tried } : {}),
    });
  }

  // The free YouTube path carries its own metadata; anything still missing gets
  // filled from the cheapest source that has it.
  if (!core.title && !meta.title) {
    meta = { ...meta, ...(await fromDataApi(id)) };
    if (!meta.title) meta = { ...meta, ...(await fromOembed(id)) };
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
    cached: false,
    ...(debug ? { via: core.via, tried } : {}),
  };

  await cachePut(id, payload);
  return json(200, payload);
};

export const config = { path: '/api/transcript' };

/* Watchless — paste a YouTube link, read the transcript.
   The page holds no secrets and talks to exactly one endpoint: /api/transcript,
   a Netlify function that does the fetching and caching server-side. */

const ENDPOINT = '/api/transcript';
const RECENT_KEY = 'watchless.recent';

const $ = (id) => document.getElementById(id);
const el = {
  intake: $('intake'), loading: $('loading'), loadingText: $('loadingText'),
  result: $('result'), form: $('form'), url: $('url'), go: $('go'),
  error: $('error'),
  recentWrap: $('recentWrap'), recent: $('recent'),
  thumb: $('thumb'), title: $('title'), facts: $('facts'),
  rail: $('rail'), chapters: $('chapters'), transcript: $('transcript'),
  search: $('search'), hits: $('hits'), body: document.querySelector('.body'),
};

let current = null;      // last payload
let blocks = [];         // [{start, text, chapter}]
let marks = [];          // live <mark> nodes for search cycling
let markIndex = -1;

/* ------------------------------------------------------------ utilities */

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function clock(sec, long) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (h || long) ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function stamp(sec, dur) { return clock(sec, dur >= 3600); }

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => { button.textContent = original; }, 1400);
}

function slug(s) {
  return (s || 'transcript').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/* ----------------------------------------------------------- transcript */

function paragraphs(payload) {
  const chapters = payload.chapters || [];
  const bounds = chapters.map((c) => c.start);
  const chapterAt = (t) => {
    let index = -1;
    for (let i = 0; i < bounds.length; i++) if (t >= bounds[i] - 0.5) index = i;
    return index;
  };

  const out = [];
  let open = null;
  for (const seg of payload.segments) {
    const chapter = chapterAt(seg.start);
    if (open) {
      const gap = seg.start - open.end;
      const ended = /[.!?…"']$/.test(open.text);
      const tooLong = open.text.length > 700 || (open.text.length > 380 && ended)
        || (seg.end - open.start) > 60 || gap > 2.2 || chapter !== open.chapter;
      if (tooLong) { out.push(open); open = null; }
    }
    if (!open) open = { start: seg.start, end: seg.end, chapter, text: '' };
    open.text = open.text ? `${open.text} ${seg.text}` : seg.text;
    open.end = seg.end;
  }
  if (open) out.push(open);
  return out;
}

function render(payload) {
  current = payload;
  blocks = paragraphs(payload);

  el.thumb.src = payload.thumbnail;
  el.thumb.alt = '';
  el.title.textContent = payload.title;

  const facts = [
    payload.channel,
    `${clock(payload.duration)} long`,
    `${payload.words.toLocaleString()} words`,
    `${payload.captionSource === 'manual' ? 'published' : 'auto'} captions · ${payload.captionLang}`,
  ].filter(Boolean);
  el.facts.innerHTML = facts.map((f, i) => (i === 0 ? `<b>${esc(f)}</b>` : esc(f))).join(' &nbsp;·&nbsp; ');

  const chapters = payload.chapters || [];
  el.body.classList.toggle('has-rail', chapters.length > 0);
  el.rail.hidden = chapters.length === 0;
  el.chapters.innerHTML = chapters
    .map((c, i) => `<li><button type="button" data-jump="${i}">${esc(c.title)}</button></li>`)
    .join('');

  const html = [];
  let seen = -1;
  blocks.forEach((b, i) => {
    if (b.chapter > seen && chapters[b.chapter]) {
      seen = b.chapter;
      html.push(
        `<h2 class="chapter" id="ch-${b.chapter}"><span class="num">${stamp(chapters[b.chapter].start, payload.duration)}</span>${esc(chapters[b.chapter].title)}</h2>`
      );
    }
    html.push(
      `<div class="block" data-i="${i}">` +
        `<a class="ts" target="_blank" rel="noopener" href="${payload.url}&t=${Math.floor(b.start)}s">${stamp(b.start, payload.duration)}</a>` +
        `<p>${esc(b.text)}</p>` +
      `</div>`
    );
  });
  el.transcript.innerHTML = html.join('');

  el.search.value = '';
  el.hits.textContent = '';
  watchChapters();
  remember(payload);
  show('result');
  document.title = `${payload.title} — Watchless`;
}

function watchChapters() {
  const headings = [...el.transcript.querySelectorAll('.chapter')];
  if (!headings.length || !('IntersectionObserver' in window)) return;
  const buttons = [...el.chapters.querySelectorAll('button')];
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id));
    const first = headings.find((h) => seen.has(h.id)) || null;
    buttons.forEach((b) => b.classList.toggle('active', !!first && `ch-${b.dataset.jump}` === first.id));
  }, { rootMargin: '-140px 0px -70% 0px' });
  headings.forEach((h) => observer.observe(h));
}

/* --------------------------------------------------------------- search */

function runSearch(query) {
  const q = query.trim();
  marks = []; markIndex = -1;
  const nodes = [...el.transcript.querySelectorAll('.block')];
  if (q.length < 2) {
    nodes.forEach((n, i) => {
      n.classList.remove('dim');
      n.querySelector('p').innerHTML = esc(blocks[i].text);
    });
    el.hits.textContent = '';
    return;
  }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let total = 0;
  nodes.forEach((n, i) => {
    const text = blocks[i].text;
    const hit = re.test(text); re.lastIndex = 0;
    n.classList.toggle('dim', !hit);
    n.querySelector('p').innerHTML = hit
      ? esc(text).replace(new RegExp(re.source, 'gi'), (m) => { total++; return `<mark>${m}</mark>`; })
      : esc(text);
  });
  marks = [...el.transcript.querySelectorAll('mark')];
  el.hits.textContent = total ? `${total} match${total === 1 ? '' : 'es'}` : 'no matches';
}

function cycleMark() {
  if (!marks.length) return;
  marks.forEach((m) => m.classList.remove('on'));
  markIndex = (markIndex + 1) % marks.length;
  const node = marks[markIndex];
  node.classList.add('on');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.hits.textContent = `${markIndex + 1} of ${marks.length}`;
}

/* ---------------------------------------------------------- export text */

function asText(withStamps) {
  const chapters = current.chapters || [];
  const lines = [];
  let seen = -1;
  blocks.forEach((b) => {
    if (b.chapter > seen && chapters[b.chapter]) {
      seen = b.chapter;
      lines.push('', `## ${chapters[b.chapter].title}`, '');
    }
    lines.push(withStamps ? `[${stamp(b.start, current.duration)}] ${b.text}` : b.text, '');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function asMarkdown() {
  const head = [
    `# ${current.title}`, '',
    `${current.channel} · ${clock(current.duration)} · ${current.captionSource === 'manual' ? 'published' : 'auto'} captions`,
    current.url, '',
  ];
  return `${head.join('\n')}\n${asText(true)}\n`;
}

function asSrt() {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const t = (sec) => {
    const s = Math.max(0, sec);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))},${pad(Math.round((s % 1) * 1000), 3)}`;
  };
  return current.segments
    .map((s, i) => `${i + 1}\n${t(s.start)} --> ${t(s.end)}\n${s.text}\n`)
    .join('\n');
}

/* ----------------------------------------------------------- recent list */

function remember(payload) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
      .filter((r) => r.id !== payload.videoId);
    list.unshift({ id: payload.videoId, title: payload.title, channel: payload.channel });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* private mode, nothing to do */ }
}

function drawRecent() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { list = []; }
  el.recentWrap.hidden = list.length === 0;
  el.recent.innerHTML = list.map((r) =>
    `<li><button type="button" data-id="${esc(r.id)}"><span class="t">${esc(r.title)}</span><span class="mono">${esc(r.channel)}</span></button></li>`
  ).join('');
}

/* ------------------------------------------------------------ app flow */

function show(view) {
  el.intake.hidden = view !== 'intake';
  el.loading.hidden = view !== 'loading';
  el.result.hidden = view !== 'result';
  if (view === 'intake') {
    document.title = 'Watchless';
    drawRecent();
  }
}

function fail(message, hint) {
  el.error.innerHTML = `${esc(message)}${hint ? `<span>${esc(hint)}</span>` : ''}`;
  el.error.hidden = false;
  show('intake');
  el.go.disabled = false;
}

let ticker = null;
function tick() {
  const steps = ['asking YouTube for the video', 'picking the caption track', 'pulling the transcript', 'still going, long videos take a moment'];
  let i = 0;
  el.loadingText.textContent = steps[0];
  ticker = setInterval(() => { i = Math.min(i + 1, steps.length - 1); el.loadingText.textContent = steps[i]; }, 4000);
}

async function load(url) {
  el.error.hidden = true;
  el.go.disabled = true;
  show('loading');
  tick();
  try {
    const res = await fetch(`${ENDPOINT}?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) return fail(data.error || 'That did not work', data.hint || '');
    history.replaceState(null, '', `?v=${data.videoId}`);
    render(data);
  } catch {
    fail('Could not reach the server', 'Check your connection and try again.');
  } finally {
    clearInterval(ticker);
    el.go.disabled = false;
  }
}

/* --------------------------------------------------------------- events */

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = el.url.value.trim();
  if (value) load(value);
});

el.recent.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-id]');
  if (button) load(`https://www.youtube.com/watch?v=${button.dataset.id}`);
});

el.chapters.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-jump]');
  if (button) document.getElementById(`ch-${button.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth' });
});

el.search.addEventListener('input', (e) => runSearch(e.target.value));
el.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cycleMark(); } });

$('toggleTs').addEventListener('click', (e) => {
  const off = el.transcript.classList.toggle('no-ts');
  e.currentTarget.classList.toggle('is-on', !off);
});
$('copyAll').addEventListener('click', (e) => {
  navigator.clipboard.writeText(asText(!el.transcript.classList.contains('no-ts')))
    .then(() => flash(e.currentTarget, 'Copied'))
    .catch(() => flash(e.currentTarget, 'Blocked'));
});
$('dlTxt').addEventListener('click', () => download(`${slug(current.title)}.txt`, asText(true), 'text/plain'));
$('dlMd').addEventListener('click', () => download(`${slug(current.title)}.md`, asMarkdown(), 'text/markdown'));
$('dlSrt').addEventListener('click', () => download(`${slug(current.title)}.srt`, asSrt(), 'text/plain'));
$('again').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  el.url.value = '';
  show('intake');
  el.url.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el.search && document.activeElement !== el.url) {
    if (!el.result.hidden) { e.preventDefault(); el.search.focus(); }
  }
});

/* ----------------------------------------------------------------- boot */

drawRecent();
const wanted = new URLSearchParams(location.search).get('v');
if (wanted && /^[A-Za-z0-9_-]{11}$/.test(wanted)) load(`https://www.youtube.com/watch?v=${wanted}`);
else el.url.focus();

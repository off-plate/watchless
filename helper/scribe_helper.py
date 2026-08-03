#!/usr/bin/env python3
"""Scribe helper — local transcript service for the Scribe web UI.

Runs on 127.0.0.1 only. The browser page (GitHub Pages or the copy served from
here) calls GET /api/transcript?url=... and gets back structured JSON.

Why this exists: YouTube's signed caption URLs return empty without a valid PO
token, youtube.com sends no CORS headers, and public proxies are bot-blocked
from datacenter IPs. yt-dlp on this machine still works, so the fetch happens
here.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
PORT = int(os.environ.get("SCRIBE_PORT", "8787"))
SITE_DIR = (Path(__file__).resolve().parent.parent / "docs").resolve()
CACHE_DIR = Path(os.environ.get("SCRIBE_CACHE", Path.home() / ".cache" / "scribe"))
ALLOWED_ORIGIN_RE = re.compile(
    r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://[a-z0-9-]+\.github\.io$",
    re.I,
)
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
YTDLP_TIMEOUT = 180


class ScribeError(Exception):
    def __init__(self, message: str, hint: str = "", status: int = 400):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.status = status


# ---------------------------------------------------------------- yt-dlp glue

def _ytdlp() -> str:
    found = shutil.which("yt-dlp")
    if not found:
        raise ScribeError(
            "yt-dlp is not installed",
            "Install it with: brew install yt-dlp",
            status=503,
        )
    return found


def _run(args: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=YTDLP_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise ScribeError(
            "yt-dlp timed out", "The video may be very long or the network is slow.", 504
        )


def video_id(url: str) -> str | None:
    """Pull the 11-char YouTube id out of any of its URL shapes."""
    if VIDEO_ID_RE.match(url):
        return url
    try:
        parts = urllib.parse.urlparse(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower().removeprefix("www.")
    if host == "youtu.be":
        cand = parts.path.lstrip("/").split("/")[0]
        return cand if VIDEO_ID_RE.match(cand) else None
    if host in {"youtube.com", "m.youtube.com", "music.youtube.com"}:
        qs = urllib.parse.parse_qs(parts.query)
        if qs.get("v") and VIDEO_ID_RE.match(qs["v"][0]):
            return qs["v"][0]
        for prefix in ("/shorts/", "/embed/", "/live/", "/v/"):
            if parts.path.startswith(prefix):
                cand = parts.path[len(prefix):].split("/")[0]
                return cand if VIDEO_ID_RE.match(cand) else None
    return None


def pick_track(meta: dict) -> tuple[str, str]:
    """Choose (lang, source) — manual captions beat auto-generated ones."""
    manual = meta.get("subtitles") or {}
    auto = meta.get("automatic_captions") or {}
    manual = {k: v for k, v in manual.items() if k != "live_chat"}
    spoken = (meta.get("language") or "en").split("-")[0].lower()

    def match(pool: dict) -> str | None:
        if not pool:
            return None
        for key in pool:
            if key.split("-")[0].lower() == spoken and not key.endswith("-orig"):
                return key
        for key in pool:
            if key.split("-")[0].lower() == spoken:
                return key
        return None

    if manual:
        return (match(manual) or next(iter(manual)), "manual")
    if auto:
        # automatic_captions lists ~100 machine translations; the original track
        # is the one matching the spoken language, so never fall back blindly.
        hit = match(auto) or ("en" if "en" in auto else None)
        if hit:
            return (hit, "auto")
    raise ScribeError(
        "This video has no captions",
        "Nothing was published for it and auto-captions are off. Nothing to transcribe.",
        status=404,
    )


def parse_json3(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    out: list[dict] = []
    for ev in data.get("events", []):
        if ev.get("aAppend") or not ev.get("segs"):
            continue
        text = "".join(s.get("utf8", "") for s in ev["segs"])
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        start = ev.get("tStartMs", 0) / 1000.0
        end = start + ev.get("dDurationMs", 0) / 1000.0
        if out and out[-1]["text"] == text:
            out[-1]["end"] = round(end, 2)
            continue
        out.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    return out


VTT_TS = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})"
)


def parse_vtt(path: Path) -> list[dict]:
    """Fallback for tracks with no json3 (dedupes YouTube's rolling cues)."""
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    segs: list[dict] = []
    i = 0
    while i < len(lines):
        m = VTT_TS.match(lines[i])
        if not m:
            i += 1
            continue
        g = m.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
        i += 1
        cue = []
        while i < len(lines) and lines[i].strip():
            cleaned = re.sub(r"<[^>]+>", "", lines[i]).strip()
            if cleaned:
                cue.append(cleaned)
            i += 1
        text = re.sub(r"\s+", " ", " ".join(cue)).strip()
        if text:
            if segs and text == segs[-1]["text"]:
                segs[-1]["end"] = round(end, 2)
            elif segs and text.startswith(segs[-1]["text"] + " "):
                segs[-1]["text"] = text
                segs[-1]["end"] = round(end, 2)
            else:
                segs.append({"start": round(start, 2), "end": round(end, 2), "text": text})
        i += 1
    return segs


def fetch(url: str) -> dict:
    vid = video_id(url)
    if not vid:
        raise ScribeError(
            "That is not a YouTube link",
            "Paste a youtube.com/watch, youtu.be, or /shorts URL.",
        )
    canonical = f"https://www.youtube.com/watch?v={vid}"
    ytdlp = _ytdlp()

    probe = _run([ytdlp, "-J", "--skip-download", "--no-playlist", "--no-warnings", canonical])
    if probe.returncode != 0:
        err = (probe.stderr or "").strip().splitlines()
        detail = err[-1] if err else "yt-dlp failed"
        raise ScribeError("YouTube would not hand over this video", detail, status=502)
    meta = json.loads(probe.stdout)

    lang, source = pick_track(meta)

    with tempfile.TemporaryDirectory(prefix="scribe-") as tmp:
        grab = _run(
            [
                ytdlp, "--skip-download", "--no-playlist", "--no-warnings",
                "--write-subs", "--write-auto-subs",
                "--sub-langs", lang, "--sub-format", "json3/vtt/best",
                "-o", "cap.%(ext)s", canonical,
            ],
            cwd=tmp,
        )
        files = sorted(Path(tmp).glob("cap.*"))
        if not files:
            detail = (grab.stderr or "").strip().splitlines()
            raise ScribeError(
                "The caption track would not download",
                detail[-1] if detail else "yt-dlp returned no subtitle file",
                status=502,
            )
        cap = files[0]
        segments = parse_json3(cap) if cap.suffix == ".json3" else parse_vtt(cap)

    if not segments:
        raise ScribeError(
            "The caption track came back empty",
            "YouTube served the file but there were no cues in it.",
            status=502,
        )

    chapters = [
        {
            "start": round(c.get("start_time") or 0, 2),
            "end": round(c.get("end_time") or 0, 2),
            "title": (c.get("title") or "").strip(),
        }
        for c in (meta.get("chapters") or [])
        if (c.get("title") or "").strip()
    ]

    words = sum(len(s["text"].split()) for s in segments)
    return {
        "videoId": vid,
        "url": canonical,
        "title": meta.get("title") or vid,
        "channel": meta.get("uploader") or meta.get("channel") or "",
        "channelUrl": meta.get("channel_url") or meta.get("uploader_url") or "",
        "duration": meta.get("duration") or 0,
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "uploadDate": meta.get("upload_date") or "",
        "captionLang": lang,
        "captionSource": source,
        "words": words,
        "chapters": chapters,
        "segments": segments,
    }


def cached(url: str, refresh: bool) -> dict:
    vid = video_id(url)
    path = CACHE_DIR / f"{vid}.json" if vid else None
    if path and path.exists() and not refresh:
        try:
            payload = json.loads(path.read_text())
            payload["cached"] = True
            return payload
        except (ValueError, OSError):
            pass
    payload = fetch(url)
    if path:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload))
        except OSError:
            pass
    payload["cached"] = False
    return payload


# ------------------------------------------------------------------- HTTP

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"Scribe/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and ALLOWED_ORIGIN_RE.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        # Chrome's Private Network Access preflight for public page -> localhost
        if self.headers.get("Access-Control-Request-Private-Network"):
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path)
        route = parts.path
        query = urllib.parse.parse_qs(parts.query)

        if route == "/health":
            return self._json(200, {"ok": True, "version": VERSION, "ytdlp": bool(shutil.which("yt-dlp"))})

        if route == "/api/transcript":
            url = (query.get("url") or [""])[0].strip()
            if not url:
                return self._json(400, {"error": "No URL given", "hint": "Pass ?url=<youtube link>"})
            try:
                return self._json(200, cached(url, refresh=bool(query.get("refresh"))))
            except ScribeError as exc:
                return self._json(exc.status, {"error": exc.message, "hint": exc.hint})
            except Exception as exc:  # noqa: BLE001 - surface anything unexpected
                return self._json(500, {"error": "The helper hit an error", "hint": str(exc)})

        return self._static(route)

    def _static(self, route: str):
        rel = "index.html" if route in ("", "/") else route.lstrip("/")
        target = (SITE_DIR / rel).resolve()
        if not str(target).startswith(str(SITE_DIR)) or not target.is_file():
            return self._send(404, b"Not found", "text/plain; charset=utf-8")
        ctype = MIME.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


def main():
    if not shutil.which("yt-dlp"):
        print("yt-dlp is missing. Install it first:  brew install yt-dlp", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Scribe helper {VERSION} listening on http://127.0.0.1:{PORT}")
    print(f"Local UI:  http://127.0.0.1:{PORT}/")
    print("Stop with Ctrl-C.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

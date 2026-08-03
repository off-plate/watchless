#!/usr/bin/env bash
# Start the Scribe helper. Keep this window open while you use the site.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp is missing. Install it with:"
  echo "  brew install yt-dlp"
  exit 1
fi

if lsof -nP -iTCP:"${SCRIBE_PORT:-8787}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already listening on port ${SCRIBE_PORT:-8787}."
  echo "The helper may already be running. Open http://127.0.0.1:${SCRIBE_PORT:-8787}/"
  exit 1
fi

exec python3 scribe_helper.py

#!/usr/bin/env bash
# Keep the Scribe helper running in the background, starting at login.
#   ./install-autostart.sh      install and start
#   ./install-autostart.sh off  stop and remove
set -euo pipefail

LABEL="com.michael.scribe-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "off" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Scribe helper autostart removed."
  exit 0
fi

command -v yt-dlp >/dev/null 2>&1 || { echo "Install yt-dlp first:  brew install yt-dlp"; exit 1; }

# A venv python can disappear; pin to a real interpreter.
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -x "$candidate" ] && PY="$candidate" && break
done
: "${PY:?no python3 found}"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$DIR/scribe_helper.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/scribe-helper.log</string>
  <key>StandardErrorPath</key><string>/tmp/scribe-helper.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -fsS http://127.0.0.1:8787/health >/dev/null \
  && echo "Scribe helper running on http://127.0.0.1:8787 and will start at login." \
  || { echo "Started, but /health did not answer. Check /tmp/scribe-helper.log"; exit 1; }

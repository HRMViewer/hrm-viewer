#!/bin/bash
# Try the Mac app on the build machine: open it, check the viewer answers from its own window (after copying itself
# to Application Support), take a picture, quit it like the Dock does, and check the viewer stops with it.
set -euo pipefail
app="$1"; dist="$2"
echo "opening $app"
open "$app"
for i in $(seq 1 90); do curl -fs -o /dev/null http://127.0.0.1:8765/api/status && break; sleep 2; done
status=$(curl -fs http://127.0.0.1:8765/api/status)
echo "$status" | python3 -c "import sys,json; d=json.load(sys.stdin); print('platform', d['platform'], 'window', d['windowed']); assert d['platform']=='mac' and d['windowed'] and d['desktop']"
ls "$HOME/Library/Application Support/HRM Viewer"
"$HOME/Library/Application Support/HRM Viewer/python/bin/python3" -c "import platform, sqlite3; print('python', platform.machine(), platform.python_version(), 'sqlite', sqlite3.sqlite_version)"
sleep 6
# (with a time limit: on some machines taking a picture waits for a permission nobody can give)
perl -e 'alarm 30; exec @ARGV' screencapture -x "$dist/mac-screenshot.png" || echo "no screenshot"
# end the app the way Quit from the Dock does (straight away, no clean-up): the viewer must notice and stop too
pkill -TERM -x "HRM Viewer"
for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:8765/api/status || break; sleep 1; done
if curl -fs -o /dev/null http://127.0.0.1:8765/api/status; then echo "the viewer kept running after the app quit"; exit 1; fi
echo "Mac app OK"; tail -20 "$HOME/Library/Application Support/HRM Viewer/data/desktop.log"

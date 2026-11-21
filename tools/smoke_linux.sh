#!/bin/bash
# Try the Linux download on the build machine: unpack it, open it on a virtual screen, check the viewer answers
# from its own window, take a picture, then end the window and check the viewer stops with it.
set -euo pipefail
dist="$1"
work=$(mktemp -d)
tar xzf "$dist"/HRM-Viewer-*-linux.tar.gz -C "$work"
cd "$work/HRM Viewer"
export HOME="$work/home" DISPLAY=:99
mkdir -p "$HOME"
Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 &
sleep 2
"./HRM Viewer" >"$work/run.log" 2>&1 &
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:8765/api/status && break; sleep 2; done
status=$(curl -fs http://127.0.0.1:8765/api/status)
echo "$status" | python3 -c "import sys,json; d=json.load(sys.stdin); print('platform', d['platform'], 'window', d['windowed']); assert d['platform']=='linux' and d['windowed'] and d['desktop']"
curl -fs -o /dev/null http://127.0.0.1:8765/app.js
sleep 4
import -window root "$dist/linux-screenshot.png" || true
pkill -f "lib/hrm-viewer-window"
for i in $(seq 1 15); do curl -fs -o /dev/null http://127.0.0.1:8765/api/status || break; sleep 1; done
if curl -fs -o /dev/null http://127.0.0.1:8765/api/status; then echo "the viewer kept running after the window closed"; cat "$work/run.log"; exit 1; fi
echo "Linux download OK"; cat "data/desktop.log"

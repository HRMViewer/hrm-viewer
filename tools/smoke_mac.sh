#!/bin/bash
# Try the Mac app on a build machine, the way someone would use it:
#  1. open it: the viewer must answer from its own window (after copying itself to Application Support)
#  2. the copies it made must not be marked as downloaded (macOS would refuse to run a quarantined Python)
#  3. a download from the page goes to ~/Downloads
#  4. an update installed from inside the viewer (here going back to a release from GitHub) works, the viewer
#     restarts on it, and opening the app again keeps it (the app doesn't put its own version back)
#  5. quitting the app (like Quit from the Dock: straight away, no clean-up) stops the viewer too
set -euo pipefail
app="$1"; dist="$2"; back="${3:-}"
S="$HOME/Library/Application Support/HRM Viewer"
up() { curl -fs -o /dev/null http://127.0.0.1:8765/api/status; }
wait_up() { for i in $(seq 1 90); do up && return 0; sleep 2; done; echo "the viewer didn't start"; tail -30 "$S/data/desktop.log" || true; return 1; }
status() { curl -fs http://127.0.0.1:8765/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['platform'], d['windowed'], d['desktop'], d['app']['version'])"; }
quit_app() {
  pkill -TERM -x "HRM Viewer" || true
  for i in $(seq 1 20); do up || return 0; sleep 1; done
  echo "the viewer kept running after the app quit"; return 1
}

echo "== 1. opening $app ($(uname -m))"
open "$app"
wait_up
read -r plat win desk ver <<<"$(status)"
echo "platform $plat, own window $win, version $ver"
[ "$plat" = mac ] && [ "$win" = True ] && [ "$desk" = True ]
"$S/python/bin/python3" -c "import platform, sqlite3, ssl; print('python', platform.machine(), platform.python_version(), 'sqlite', sqlite3.sqlite_version)"
[ ! -e "$S/static/desktop-app.exe" ] || { echo "the Windows app was copied in"; exit 1; }
sleep 5
perl -e 'alarm 30; exec @ARGV' screencapture -x "$dist/mac-screenshot.png" || echo "no screenshot"

echo "== 2. quarantine on the copies"
if xattr -r "$S/python/bin" "$S/app.py" 2>/dev/null | grep -q com.apple.quarantine; then echo "copies are quarantined"; exit 1; fi
echo "not quarantined"

echo "== 3. a download goes to Downloads"
res=$(curl -fs -X POST --data-binary "a,b
1,2" "http://127.0.0.1:8765/api/desktop/save?name=smoke%20test.csv")
echo "$res"
p=$(echo "$res" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])")
[ -f "$p" ] && [[ "$p" == "$HOME/Downloads/"* ]]
curl -fs -X POST -H "Content-Type: application/json" -d "{\"path\": \"$p\"}" http://127.0.0.1:8765/api/desktop/reveal >/dev/null
osascript -e 'tell application "Finder" to close every window' >/dev/null 2>&1 || true

if [ -n "$back" ]; then
  echo "== 4. install version $back from inside the viewer, then reopen the app"
  curl -fsSL -o "$RUNNER_TEMP/upd.zip" "https://github.com/${GITHUB_REPOSITORY}/releases/download/v$back/HRM-Viewer-update-$back.zip"
  curl -fs -X POST --data-binary @"$RUNNER_TEMP/upd.zip" http://127.0.0.1:8765/api/update; echo
  for i in $(seq 1 60); do sleep 2; v=$(curl -fs http://127.0.0.1:8765/api/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['app']['version'])" 2>/dev/null || true); [ "$v" = "$back" ] && break; done
  echo "after the update: version $v"
  [ "$v" = "$back" ]
  quit_app
  open "$app"
  wait_up
  read -r plat win desk ver <<<"$(status)"
  echo "reopened: version $ver"
  [ "$ver" = "$back" ] || { echo "opening the app undid the update"; exit 1; }
fi

echo "== 5. quit"
quit_app
echo "Mac app OK"
tail -20 "$S/data/desktop.log"

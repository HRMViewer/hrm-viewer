"""Publish a release on GitHub: python3 make_release.py <version> [owner/name]
Tags v<version> and uploads HRM-Viewer-update-<version>.zip and HRM-Viewer-<version>-full.zip from updates/,
with the changelog entry as the release notes. Needs the gh command signed in."""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
v = sys.argv[1]
repo = sys.argv[2] if len(sys.argv) > 2 else None
log = json.load(open(os.path.join(here, "hrm-viewer", "static", "changelog.json")))
e = next(x for x in log if x["version"] == v)
notes = "## %s\n\n%s\n\n**New here?** Download **HRM-Viewer-%s-full.zip**, unzip it and double-click *HRM Viewer.exe*.\n" \
        "**Already have it?** The viewer offers this update itself (or use Settings → Install an update with HRM-Viewer-update-%s.zip)." % (
            e["title"], "\n".join("- " + c for c in e["changes"]), v, v)
files = [os.path.join(here, "updates", "HRM-Viewer-update-%s.zip" % v), os.path.join(here, "updates", "HRM-Viewer-%s-full.zip" % v)]
cmd = ["gh", "release", "create", "v" + v, *files, "--title", "HRM Viewer %s — %s" % (v, e["title"]), "--notes", notes, "--latest"]
if repo:
    cmd += ["--repo", repo]
subprocess.run(cmd, check=True)

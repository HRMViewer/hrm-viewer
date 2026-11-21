"""Build the two release zips from this repository (used by the GitHub release workflow).

usage: python3 tools/ci_build.py <HRM Viewer.exe> <out dir>
Writes HRM-Viewer-update-<v>.zip and HRM-Viewer-<v>-full.zip, plus notes.md for the release page."""
import json
import os
import re
import shutil
import sys
import zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
exe, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
version = re.search(r'^VERSION = "([^"]+)"', open(os.path.join(root, "app.py")).read(), re.M).group(1)
log = json.load(open(os.path.join(root, "static", "changelog.json")))
entry = next((e for e in log if e["version"] == version), {"title": "", "changes": []})
shutil.copyfile(exe, os.path.join(root, "static", "desktop-app.exe"))
static = sorted(f for f in os.listdir(os.path.join(root, "static")) if not f.startswith("."))

# the in-app update: update.json, app.py, README.txt and static/ (with the desktop app inside)
upd = os.path.join(out, "HRM-Viewer-update-%s.zip" % version)
with zipfile.ZipFile(upd, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("update.json", json.dumps({"app": "hrm-viewer", "version": version, "notes": entry["title"]}, indent=2))
    for f in ["app.py", "README.txt"] + ["static/" + s for s in static]:
        z.write(os.path.join(root, f), f)

# the full download: everything in an "HRM Viewer" folder
full = os.path.join(out, "HRM-Viewer-%s-full.zip" % version)
top = "HRM Viewer/"
with zipfile.ZipFile(full, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(exe, top + "HRM Viewer.exe")
    z.write(os.path.join(root, "static", "quick-guide.pdf"), top + "HRM Viewer - Quick Guide.pdf")
    z.writestr(top + "update.json", json.dumps({"app": "hrm-viewer", "version": version,
                                                 "notes": "Full package of version %s." % version}, indent=2))
    for f in ["Start.bat", "Load database.bat"]:
        z.write(os.path.join(root, "package", f), top + f)
    for f in ["app.py", "README.txt"] + ["static/" + s for s in static]:
        z.write(os.path.join(root, f), top + f)

with open(os.path.join(out, "notes.md"), "w", encoding="utf-8") as f:
    f.write("## %s\n\n%s\n\n**New here?** Download **HRM-Viewer-%s-full.zip**, unzip it and double-click *HRM Viewer.exe*.  \n"
            "**Already have it?** The viewer offers this update by itself (or use Settings → Install an update with "
            "**HRM-Viewer-update-%s.zip**, don't unzip it).\n" % (entry["title"], "\n".join("- " + c for c in entry["changes"]), version, version))
with open(os.path.join(out, "version.txt"), "w") as f:
    f.write(version)
print(version, os.path.getsize(upd), os.path.getsize(full))

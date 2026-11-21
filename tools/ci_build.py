"""Build the two release zips from this repository (used by the GitHub release workflow).

usage: python3 tools/ci_build.py <HRM Viewer.exe> <out dir> <python folder>
(the python folder is the Windows embeddable Python, unzipped; it goes in the full download so nothing needs installing)
Writes HRM-Viewer-update-<v>.zip and HRM-Viewer-<v>-full.zip, plus notes.md for the release page."""
import json
import os
import re
import shutil
import sys
import zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
exe, out, pydir = sys.argv[1], sys.argv[2], sys.argv[3]
for need in ("python.exe", "pythonw.exe", "_sqlite3.pyd", "sqlite3.dll", "_ssl.pyd"):
    if not os.path.exists(os.path.join(pydir, need)):
        sys.exit("The bundled Python is missing %s" % need)
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
    for dirpath, _, names in os.walk(pydir):
        for n in sorted(names):
            full_path = os.path.join(dirpath, n)
            z.write(full_path, top + "python/" + os.path.relpath(full_path, pydir).replace(os.sep, "/"))
    for f in ["app.py", "README.txt"] + ["static/" + s for s in static]:
        z.write(os.path.join(root, f), top + f)

with open(os.path.join(out, "notes.md"), "w", encoding="utf-8") as f:
    f.write("## %s\n\n%s\n\n**New here?** Download the one for your computer:\n"
            "- **Windows:** **HRM-Viewer-%s-full.zip**, unzip it and double-click *HRM Viewer.exe*.\n"
            "- **Mac** (Apple Silicon or Intel, macOS 11+): **HRM-Viewer-%s-mac.zip**, unzip it, drag *HRM Viewer* into Applications and open it. "
            "The first time, click *Open Anyway* in System Settings → Privacy & Security (the app isn't signed with a paid Apple account).\n"
            "- **Linux / Steam Deck:** **HRM-Viewer-%s-linux.tar.gz**, unpack it in your home folder and open *HRM Viewer*.\n\n"
            "**Already have it?** The viewer offers this update by itself (or use Settings → Install an update with "
            "**HRM-Viewer-update-%s.zip**, don't unzip it).\n" % (entry["title"], "\n".join("- " + c for c in entry["changes"]), version, version, version, version))
with open(os.path.join(out, "version.txt"), "w") as f:
    f.write(version)
print(version, os.path.getsize(upd), os.path.getsize(full))

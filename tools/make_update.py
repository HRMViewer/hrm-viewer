"""Build an in-app update file (and the full package) from the hrm-viewer folder.

usage: python3 make_update.py <source dir> <out dir> [notes]
"""
import json
import os
import re
import sys
import zipfile

src, out = sys.argv[1], sys.argv[2]
notes = sys.argv[3] if len(sys.argv) > 3 else ""
version = re.search(r'^VERSION = "([^"]+)"', open(os.path.join(src, "app.py")).read(), re.M).group(1)
manifest = json.dumps({"app": "hrm-viewer", "version": version, "notes": notes}, indent=2)
files = ["app.py", "README.txt"] + (["HRM Viewer.new.exe"] if os.path.exists(os.path.join(src, "HRM Viewer.new.exe")) else []) + ["static/" + f for f in sorted(os.listdir(os.path.join(src, "static")))]
path = os.path.join(out, "HRM-Viewer-update-%s.zip" % version)
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("update.json", manifest)
    for f in files:
        p = os.path.join(src, f)
        if os.path.exists(p):
            z.write(p, f)
print(path, os.path.getsize(path))

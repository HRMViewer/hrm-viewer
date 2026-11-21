"""Build the Mac and Linux downloads (used by the GitHub desktop-builds workflow).

usage:
  python3 tools/ci_unix.py linux <out dir> <HRM Viewer launcher> <hrm-viewer-window> <python dir>
      -> <out>/HRM-Viewer-<version>-linux.tar.gz   (an "HRM Viewer" folder: unpack it anywhere and open "HRM Viewer")
  python3 tools/ci_unix.py mac <out dir> <universal HRM Viewer binary> <python dir for arm64> <python dir for x86_64>
      -> <out>/HRM Viewer.app   (the workflow signs it and zips it as HRM-Viewer-<version>-mac.zip)

The python dirs are python-build-standalone "install_only" builds, unpacked. Parts the viewer never uses
(tests, Tk, IDLE, pip, headers) are left out to keep the download small.
"""
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
version = re.search(r'^VERSION = "([^"]+)"', open(os.path.join(root, "app.py")).read(), re.M).group(1)
STATIC_SKIP = {"desktop-app.exe"}     # the Windows app; Mac and Linux have their own launchers

PY_DROP_DIRS = ["include", "share", "lib/pkgconfig", "lib/tcl8", "lib/tcl8.6", "lib/tk8.6", "lib/itcl4.2.4", "lib/thread2.8.9",
                "lib/python3.13/test", "lib/python3.13/idlelib", "lib/python3.13/tkinter", "lib/python3.13/turtledemo",
                "lib/python3.13/ensurepip", "lib/python3.13/lib2to3", "lib/python3.13/pydoc_data", "lib/python3.13/site-packages",
                "lib/python3.13/config-3.13-darwin", "lib/python3.13/config-3.13-x86_64-linux-gnu"]
PY_DROP_FILES = re.compile(r"^(bin/(idle3.*|pip.*|pydoc3.*|2to3.*|python3.*-config)|lib/lib(tcl|tk)8\.6\..*|lib/python3\.13/lib-dynload/_tkinter\..*)$")


def copy_python(src, dst):
    """Copy a portable Python without the parts the viewer never uses (symbolic links kept)."""
    shutil.copytree(src, dst, symlinks=True)
    for d in PY_DROP_DIRS:
        shutil.rmtree(os.path.join(dst, d), ignore_errors=True)
    for dirpath, dirnames, names in os.walk(dst):
        for n in names:
            rel = os.path.relpath(os.path.join(dirpath, n), dst).replace(os.sep, "/")
            if PY_DROP_FILES.match(rel):
                os.remove(os.path.join(dirpath, n))
    os.makedirs(os.path.join(dst, "lib", "python3.13", "site-packages"), exist_ok=True)
    for need in ("bin/python3", "lib/python3.13/sqlite3/__init__.py", "lib/python3.13/ssl.py", "lib/python3.13/http/server.py"):
        if not os.path.lexists(os.path.join(dst, need)):
            sys.exit("The bundled Python is missing %s" % need)


def copy_app(dst):
    """app.py, README.txt, update.json and static/ (what the in-app updater manages)."""
    os.makedirs(os.path.join(dst, "static"), exist_ok=True)
    for f in ("app.py", "README.txt"):
        shutil.copy2(os.path.join(root, f), os.path.join(dst, f))
    for f in sorted(os.listdir(os.path.join(root, "static"))):
        if not f.startswith(".") and f not in STATIC_SKIP:
            shutil.copy2(os.path.join(root, "static", f), os.path.join(dst, "static", f))
    with open(os.path.join(dst, "update.json"), "w") as f:
        json.dump({"app": "hrm-viewer", "version": version, "notes": "Full package of version %s." % version}, f, indent=2)


def executable(path):
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def build_linux(out, launcher, window, pydir):
    stage = os.path.join(out, "linux-stage")
    shutil.rmtree(stage, ignore_errors=True)
    top = os.path.join(stage, "HRM Viewer")
    os.makedirs(os.path.join(top, "lib"))
    copy_app(top)
    shutil.copy2(launcher, os.path.join(top, "HRM Viewer"))
    shutil.copy2(window, os.path.join(top, "lib", "hrm-viewer-window"))
    executable(os.path.join(top, "HRM Viewer"))
    executable(os.path.join(top, "lib", "hrm-viewer-window"))
    shutil.copy2(os.path.join(root, "desktop", "res", "icon256.png"), os.path.join(top, "hrm-viewer.png"))
    shutil.copy2(os.path.join(root, "static", "quick-guide.pdf"), os.path.join(top, "HRM Viewer - Quick Guide.pdf"))
    copy_python(pydir, os.path.join(top, "python"))
    name = os.path.join(out, "HRM-Viewer-%s-linux.tar.gz" % version)
    with tarfile.open(name, "w:gz") as t:
        t.add(top, arcname="HRM Viewer")
    shutil.rmtree(stage, ignore_errors=True)
    print(name, os.path.getsize(name))


def make_icns(png, dst):
    """AppIcon.icns from the 1024px icon (with the Mac's own tools when they're there)."""
    if shutil.which("iconutil") and shutil.which("sips"):
        iconset = dst[:-5] + ".iconset"
        os.makedirs(iconset, exist_ok=True)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                n = "icon_%dx%d%s.png" % (size, size, "@2x" if scale == 2 else "")
                subprocess.run(["sips", "-z", str(px), str(px), png, "--out", os.path.join(iconset, n)], check=True, capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", dst], check=True)
        shutil.rmtree(iconset)
    else:
        from PIL import Image
        Image.open(png).save(dst)


def build_mac(out, binary, py_arm, py_x86):
    app = os.path.join(out, "HRM Viewer.app")
    shutil.rmtree(app, ignore_errors=True)
    contents = os.path.join(app, "Contents")
    res = os.path.join(contents, "Resources")
    os.makedirs(os.path.join(contents, "MacOS"))
    os.makedirs(res)
    shutil.copy2(binary, os.path.join(contents, "MacOS", "HRM Viewer"))
    executable(os.path.join(contents, "MacOS", "HRM Viewer"))
    copy_app(os.path.join(res, "app"))
    copy_python(py_arm, os.path.join(res, "python-arm64"))
    copy_python(py_x86, os.path.join(res, "python-x86_64"))
    make_icns(os.path.join(root, "desktop", "res", "icon-mac-1024.png"), os.path.join(res, "AppIcon.icns"))
    with open(os.path.join(contents, "Info.plist"), "wb") as f:
        plistlib.dump({
            "CFBundleName": "HRM Viewer", "CFBundleDisplayName": "HRM Viewer", "CFBundleExecutable": "HRM Viewer",
            "CFBundleIdentifier": "io.github.hrmviewer.viewer", "CFBundlePackageType": "APPL", "CFBundleIconFile": "AppIcon",
            "CFBundleShortVersionString": version, "CFBundleVersion": version, "CFBundleInfoDictionaryVersion": "6.0",
            "LSMinimumSystemVersion": "11.0", "NSHighResolutionCapable": True, "LSApplicationCategoryType": "public.app-category.utilities",
            "NSHumanReadableCopyright": "HRM Viewer, a viewer for Horse Racing Manager saves",
            # the viewer runs on this computer (http://127.0.0.1), which needs saying for the window to show it
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        }, f)
    print(app)


if __name__ == "__main__":
    kind, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    if kind == "linux":
        build_linux(out, *sys.argv[3:6])
    elif kind == "mac":
        build_mac(out, *sys.argv[3:6])
    else:
        sys.exit(__doc__)
    with open(os.path.join(out, "version.txt"), "w") as f:
        f.write(version)

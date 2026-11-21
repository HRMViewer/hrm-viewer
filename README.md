# HRM Viewer

A desktop viewer for **Horse Racing Manager** saves: browse your horses, stables, races and finances with search, charts and form guides. It updates itself from this repository's releases.

## Download

1. Go to **[Releases](https://github.com/jomdesa-glitch/hrm-viewer/releases/latest)** and download **HRM-Viewer-&lt;version&gt;-full.zip**.
2. Unzip it anywhere (for example your Documents folder).
3. Double-click **HRM Viewer.exe**, then click **Load new database** and choose your game's `database.db`.

Windows 10 or 11 is needed. The *HRM Viewer - Quick Guide.pdf* inside the zip walks through the main features.

## Updates

When a new version is published here, the viewer shows a bar at the top: **Install now** downloads it, installs it and restarts. Your stored data, photos and settings are never touched, and *Versions & changes* can put the previous version back.

You can also install by hand: download **HRM-Viewer-update-&lt;version&gt;.zip** (don't unzip it) and use *Settings → Install an update*.

## What's in this repository

| Folder | What it is |
|---|---|
| `app.py` | The viewer's local server (Python, standard library only) |
| `static/` | The viewer's pages, styles, fonts and changelog |
| `desktop/` | The Windows desktop window (Go + WebView2) that becomes *HRM Viewer.exe* |
| `guide/` | Source of the Quick Guide PDF |
| `package/` | Extra files that go in the full download |
| `tools/` | Scripts that build the update/full zips, the guide and the GitHub release |

Your save files are only read on your own computer; nothing is uploaded anywhere.

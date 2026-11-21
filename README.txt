HRM DATABASE VIEWER
===================

Browse everything in your Horse Racing Manager save (database.db): horses, races,
stables, people and racecourses, all linked together, plus every one of the
188 tables exactly as stored.

It runs on your computer. Nothing is uploaded anywhere.

New here? Open "HRM Viewer - Quick Guide.pdf" in this folder for a short
guide to the main features (updated with every version).


GETTING STARTED
---------------
1. Unzip the download somewhere permanent, e.g. Documents\HRM Viewer.
2. Double-click "HRM Viewer.exe". That's all: everything it needs is in this
   folder (including its own Python in the "python" folder), so nothing else
   has to be installed.
   - Windows may show "Windows protected your PC". Click "More info" and then
     "Run anyway". This only happens because the file isn't from the Store.
3. Click "Load database" and choose your game's database.db (or paste its path).

The viewer opens in its own window, like any other program, and stops when you
close the window. The first time, it offers to add HRM Viewer to your desktop
and Start menu (also in Settings > Desktop app). You can also drag a database.db
onto HRM Viewer.exe to load it. Keep HRM Viewer.exe in this folder; use a
shortcut to open it from anywhere else. It uses the Microsoft Edge WebView2
Runtime, which comes with Windows 10 and 11; if it's missing, the viewer opens in
your browser and tells you where to get it.

ON A MAC
--------
1. Download HRM-Viewer-<version>-mac.zip and double-click it to unzip.
2. Drag "HRM Viewer" into your Applications folder.
3. Open it. The first time, the Mac says it "could not verify" HRM Viewer,
   because the app isn't signed with a paid Apple developer account. Click
   Done (or OK), then open System Settings > Privacy & Security, scroll down
   and click "Open Anyway" next to HRM Viewer, and confirm. This is only
   needed once.
It works on Apple Silicon and Intel Macs (macOS 11 Big Sur or later) and opens
in its own window. Your data is kept in your home folder under
Library/Application Support/HRM Viewer, so it stays when you replace the app
with a newer download. Files you download in the viewer (CSV, pictures) go to
your Downloads folder. Quit with Cmd+Q or by closing the window.

ON LINUX (INCLUDING STEAM DECK DESKTOP MODE)
-------------------------------------------
1. Download HRM-Viewer-<version>-linux.tar.gz and unpack it somewhere in your
   home folder, e.g. ~/HRM Viewer.
2. Open "HRM Viewer" in that folder (double-click it, or run "./HRM Viewer").
   The first time, it offers to add itself to your applications menu (also in
   Settings > Desktop app).
It opens in its own window when WebKitGTK is installed (most desktops have it:
the package is called libwebkit2gtk-4.1 or webkit2gtk-4.1). Without it, the
viewer opens in your browser instead; stop it with Settings > Stop the viewer
(or Ctrl+C if you started it from a terminal). Everything it needs, including
its own Python, is in the folder, and your data is kept in its "data" folder,
like on Windows. Files you download in the viewer go to your Downloads folder.

LOADING A NEWER SAVE
--------------------
Save your game first, then any of these:
  - In the viewer, click "Load new database" and press Load. The path is
    remembered after the first time.
  - Drag database.db onto "HRM Viewer.exe".

Each load builds on what's stored:
  - Records in the new file replace the older versions (newest wins).
  - History the game has deleted since is kept: old race results, races,
    transactions, news, awards, breeding, stat/value history, finances and
    past jobs. Horses, people, stables and racecourses the game removes are
    kept too, marked "Removed from game".
  - "Live" things always come from the newest file: upcoming entries, offers,
    current shareholdings, active effects and settings. Future races the game
    cancelled are dropped.
  - If the file is from a different career, or older than what's stored,
    the viewer asks first. For an older file you can add just the records
    it has that are missing - handy for recovering history from old backups.
  - Tick "Start fresh" in the load window to throw everything away and keep
    only the new file.
The Home page lists every load and how many older records were kept.
Your stored data isn't touched until the new file has been checked.

UPDATING THE VIEWER
-------------------
New versions are published on GitHub. When one is out, the viewer asks when it
opens (and shows a bar at the top): click "Install now" and it downloads,
installs and restarts by itself. "Skip this version" stops it asking about that
one. Settings > Viewer > Updates has "Check now" and "All versions": every
published version, so you can go back to an earlier one if you don't like a
new one (and update again later).
Untick "Check for updates automatically" there to stop the viewer looking for
new versions by itself ("Check now" still works).
Download page: https://github.com/HRMViewer/hrm-viewer/releases

Updates also come as a file called HRM-Viewer-update-<version>.zip. Don't unzip it.
1. In the viewer, go to Settings and click "Install an update".
2. Choose the update file and click Install.
3. The viewer restarts itself and the page reloads on the new version.
Updates only replace the program files. Your stored data, load history and
settings in the "data" folder are never touched. The previous version is
saved in the "backups" folder first, and "Go back to version ..." in
Settings > Versions & changes puts it back. If a new version ever fails to start, the
viewer puts the previous version back by itself.

WHERE THE DATA IS KEPT
----------------------
The "data" folder next to HRM Viewer.exe holds your stored databases. Since
version 7.9 each database has its own folder in "data\databases" (about
1.2 GB each). Delete the "data" folder to clear everything. The "backups"
folder holds earlier versions of the viewer's program files (not your data).

DARK MODE AND FONTS
-------------------
Settings > Appearance switches between light, dark and "Match Windows".
Settings > Colours lets you pick your own colours (accent, top bar, headings,
background, cards, lines, winning rows) or a preset. Light and dark mode each
keep their own colours.
Settings > Font lets you pick from 93 free fonts that come with the viewer
(they work offline) or fonts installed on your computer. The bundled fonts
are from Google Fonts; their licences are in static\fonts-licenses.txt.

STABLE FINANCIALS
-----------------
Every stable page has an Overview tab and a Financials tab. Financials shows
income and expenses for each year (totals of the stable's monthly figures),
broken down by the game's own categories, and below that each year's payments
by category and type, with every single payment one click away. The money
charts there use a logarithmic scale so a single huge month doesn't flatten the
rest; $0 and negative amounts are still shown, and hovering gives exact amounts.

The Horse finances tab lists every horse the stable has had, now and in the
past, with what each one earned and cost while it was there (prize money,
sales, stud fees, sponsorship; purchase, feed & care, training, entry fees,
travel, vet and so on). Open a horse for its breakdown and year-by-year figures.

HORSE PHOTOS
------------
On a horse's page, click "Add photos" (or "Gallery") to upload as many pictures
as you like. "Profile" makes one the horse's profile picture (next to its name,
and small in the horse lists); "Banner" puts one across the top of its hover
card (if no banner is chosen, the hover card has no picture). "Banner view"
in the gallery sets how the banner looks: drag it to choose which part shows,
zoom, fill or whole picture, height, and sharp pixels for pixel art. Photos are kept in the
database's own folder (data\databases\<name>\images), so they stay with that
save and are never touched by updates.

TABLES AND CHARTS
-----------------
Click any column heading to sort. Tables with lots of rows have a "Filter rows"
box (Esc clears it) and a CSV button. Charts have a Linear / Log switch, time
ranges, a button to open them large, and PNG (picture) and CSV (numbers)
downloads. Click a name in a chart's legend to hide that line; double-click it
to show only that line.

SIDE MENU
---------
The ☰ button switches the side menu between full, icons only and hidden.
On smaller windows (about 1150 pixels wide or less) it slides in over the
page instead; click outside it, press Esc or pick a page to close it.

AUTOMATIC UPDATES
-----------------
Settings > Automatic updates: switch it on and leave the viewer running.
Each time you save in the game, the viewer notices database.db has changed,
waits until the game has finished writing it, and loads it (the same as
Load database: newest records win, history is kept). It watches the file
the open database was last loaded from, so load it once from its real
location (not a copy) first. Different saves and older files are never
loaded automatically.

SEVERAL DATABASES
-----------------
Open "Databases" in the left-hand menu (or click the database name at the
top right) to:
- switch between databases - each save keeps its own history;
- load a save as a new database ("Load into: a new database named ...");
- rename or delete databases;
- move data stored by versions before 7.9 into the new structure (a
  one-click move, nothing is copied or changed);
- bring in the stored data from another HRM Viewer folder (for example an
  older copy you unzipped somewhere else), copied or moved.
If you load a file from a different save, the viewer offers to keep both
by loading it as a separate database.


PEDIGREES, HORSE TABLE AND STABLE TABLE
---------------------------------------
- Pedigrees: rank sires, dams or broodmare sires (the sire of a horse's dam)
  by how their foals have done: runners, winners, stakes winners, G1 winners
  and earnings. Filter by the years the foals were born, colts or fillies,
  and a minimum number of runners. "tree" opens a four-generation family
  tree; click any name in it to move the tree to that horse.
- Horse table: every horse with its key stats in one sortable table.
- Stable table: every stable with horses, race record, money and staff.
- Click any column heading to sort. "Export CSV" downloads every matching
  row as a file you can open in Excel.

TRACK RECORDS
-------------
Each racecourse page lists the fastest winning time at every distance on each
of its tracks. Click a distance to see every earlier record holder, when
they set it and how much they lowered it by.

USING THE "ALL TABLES" PAGE
---------------------------
- Click a column name to sort; click again to reverse.
- Type under a column and press Enter to filter:
    text      rows containing that text
    =5  !=0   equal / not equal
    >100  <=2018   greater / less than
    null  !null    empty / not empty
- Blue numbers are links to that horse, person, stable, race or racecourse.
- Click any row to see all of its fields.

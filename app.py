"""HRM Database Viewer - a local viewer for Horse Racing Manager save databases.

Run:  python app.py            (opens the viewer in your browser)
      python app.py --import "C:\\path\\to\\database.db"   (load a database, then start)

Only the Python standard library is used. The stored copy lives in the "data" folder
next to this file. Loading a new database replaces it.
"""

import argparse
import bisect
import calendar
import datetime
import json
import os
import re
import shutil
import socket
import sqlite3
import sys
import threading
import time
import traceback
import webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
import urllib.request

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
STATIC_DIR = os.path.join(APP_DIR, "static")
CURRENT_DB = os.path.join(DATA_DIR, "current.db")
INCOMING_DB = os.path.join(DATA_DIR, "incoming.db")
META_FILE = os.path.join(DATA_DIR, "meta.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

REQUIRED_TABLES = ["horses", "persons", "stables", "races", "race_days", "race_results", "racecourses"]

# Indexes added to the stored copy so the pages load quickly. (table, column)
INDEXES = [
    ("horses", "horse_stable_id"),
    ("horses", "horse_breeding_parent_mare_id"),
    ("horses", "horse_breeding_parent_stallion_id"),
    ("horses", "horse_name"),
    ("horses", "horse_career_earnings"),
    ("horses", "horse_international_rating"),
    ("persons", "person_full_name"),
    ("races", "races_race_day_id"),
    ("races", "races_race_date_time"),
    ("races", "races_prize_money_total"),
    ("transactions", "transaction_from_entity_id"),
    ("transactions", "transaction_to_entity_id"),
    ("training_fee_months", "tfm_horse_id"),
    ("travel_history", "travel_history_entity_id"),
    ("breeding", "breeding_stallion_id"),
    ("breeding", "breeding_mare_id"),
    ("race_days", "raceday_racecourse_id"),
    ("race_days", "raceday_date"),
    ("race_results", "race_result_race_id"),
    ("race_results", "race_result_horse_id"),
    ("race_results", "race_result_person_jockey_id"),
    ("race_results", "race_result_stable_id"),
    ("race_results", "race_result_trainer_id"),
    ("race_results", "race_result_stable_head_trainer_id"),     # People overview: trainers' races
    ("race_results", "race_result_stable_manager_id"),          # People overview: managers' races
    ("race_participants", "race_participant_race_id"),
    ("race_participants", "race_participant_horse_id"),
    ("race_participants", "race_participant_person_jockey_id"),
    # 16.5: sponsors, rankings, syndicates, languages, facilities, plans and ride offers
    ("horse_sponsors", "sponsor_horse_id"),
    ("horse_pedigree_percentiles", "pedigree_horse_id"),
    ("horse_earnings_percentiles", "percentile_horse_id"),
    ("horse_syndications", "syndication_horse_id"),
    ("horse_syndicate_shareholders", "shareholder_syndication_id"),
    ("horse_syndicate_shareholders", "shareholder_person_id"),
    ("person_languages", "person_id"),
    ("constructed_facilities", "constructed_facility_entity_id"),
    ("farm_sponsors", "fs_stable_id"),
    ("venue_sponsors", "vs_venue_id"),
    ("horse_qualification_points", "hqp_horse_id"),
    ("campaign_suggestions", "cs_horse_id"),
    ("ride_offers", "ride_offer_person_id"),
    ("horse_training", "ht_horse_id"),
    ("horse_shoes", "shoe_horse_id"),
    ("horse_yearly_schedule", "hys_horse_id"),
    ("races", "races_calendar_id"),
    ("horse_qualification_points", "hqp_target_calendar_id"),
    ("staff", "staff_stable_id"),
    ("staff", "staff_person_id"),
    ("horse_stats_snapshots", "snapshot_horse_id"),
    ("horse_valuation_history", "valuation_history_horse_id"),
    ("illness_injury_history", "illness_injury_entity_id"),
    ("entity_traits", "entity_id"),
    ("stable_financial_snapshots", "snapshot_stable_id"),
    ("stable_investors", "investor_stable_id"),
    ("story_events", "event_primary_actor_id"),
    ("story_events", "event_secondary_actor_id"),
    ("awards", "award_entity_id"),
    ("children", "child_person_id"),
    ("children", "child_parent_1_id"),
    ("children", "child_parent_2_id"),
    ("timing_trials", "tt_horse_id"),       # a horse's trials (16.7.11)
    ("timing_trials", "tt_date"),           # everyone else in the same trial session
    ("auction_results", "auction_result_shell_id"),          # auctions, share offerings and assets (16.7.15)
    ("auction_results", "auction_result_auctionhouse_id"),
    ("auction_results", "auction_result_from_stable_id"),
    ("auction_results", "auction_result_to_stable_id"),
    ("auction_participants", "auction_participant_shell_id"),
    ("auction_shell", "auction_shell_house_id"),
    ("auction_house", "auction_house_owner_id"),
    ("share_offerings", "so_stable_id"),
    ("share_offering_rights", "sor_offering_id"),
    ("pending_investor_offers", "offer_stable_id"),
    ("owned_assets", "asset_owner_id"),
]

PAGE_SIZE = 50


# --------------------------------------------------------------------------- helpers

def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def qident(name):
    return '"' + name.replace('"', '""') + '"'


class RWLock:
    """Many readers at once; the database swap waits for them and blocks new ones."""

    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False

    def acquire_read(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._readers += 1

    def release_read(self):
        with self._cond:
            self._readers -= 1
            self._cond.notify_all()

    def acquire_write(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._writer = True
            while self._readers:
                self._cond.wait()

    def release_write(self):
        with self._cond:
            self._writer = False
            self._cond.notify_all()


DB_LOCK = RWLock()
META = {}
META_MTIME = None
META_LOCK = threading.Lock()


def meta_mtime():
    try:
        return os.path.getmtime(META_FILE)
    except OSError:
        return None


def load_meta():
    global META, META_MTIME
    with META_LOCK:
        META_MTIME = meta_mtime()
        META = read_json(META_FILE, {}) if os.path.exists(CURRENT_DB) else {}
    db_changed()


# --------------------------------------------------------------------------- speed: pooled connections + page cache

DB_GEN = 0
PORT = None


class ConnPool:
    """Keeps a few read-only connections open between requests (their caches stay warm).
    Idle ones are closed after a few seconds so Windows can still replace the file."""

    def __init__(self):
        self.lock = threading.Lock()
        self.idle = []

    def get(self):
        with self.lock:
            while self.idle:
                con, gen, _ = self.idle.pop()
                if gen == DB_GEN:
                    return con
                try:
                    con.close()
                except Exception:
                    pass
        con = sqlite3.connect(ro_uri(CURRENT_DB), uri=True, check_same_thread=False, factory=PooledConnection)
        con.row_factory = sqlite3.Row
        con.text_factory = lambda b: b.decode("utf-8", errors="replace")
        try:
            con.execute("pragma mmap_size=1073741824")
            con.execute("pragma cache_size=-32768")
        except sqlite3.Error:
            pass
        con.hrmv_gen = DB_GEN
        return con

    def put(self, con):
        if getattr(con, "hrmv_gen", None) != DB_GEN:
            con.close()
            return
        with self.lock:
            self.idle.append((con, con.hrmv_gen, time.time()))

    def close_all(self, max_idle=None):
        now = time.time()
        with self.lock:
            if max_idle is None:
                drop, self.idle = self.idle, []
            else:
                drop = [x for x in self.idle if now - x[2] >= max_idle]
                self.idle = [x for x in self.idle if now - x[2] < max_idle]
        for con, _, _ in drop:
            try:
                con.close()
            except Exception:
                pass


class PooledConnection(sqlite3.Connection):
    """A read-only connection that remembers which stored database it belongs to."""
    hrmv_gen = None


POOL = ConnPool()


from collections import OrderedDict

CACHE = OrderedDict()
CACHE_LOCK = threading.Lock()
CACHE_LIMIT = 96 * 1024 * 1024
CACHE_SIZE = [0]


def cache_get(key):
    with CACHE_LOCK:
        v = CACHE.get((DB_GEN, key))
        if v is not None:
            CACHE.move_to_end((DB_GEN, key))
        return v


def cache_put(key, body):
    with CACHE_LOCK:
        k = (DB_GEN, key)
        if k in CACHE:
            return
        CACHE[k] = body
        CACHE_SIZE[0] += len(body)
        while CACHE_SIZE[0] > CACHE_LIMIT and CACHE:
            _, old = CACHE.popitem(last=False)
            CACHE_SIZE[0] -= len(old)


COUNTS = OrderedDict()


def count_rows(con, sql, params=()):
    """Row counts for list pages, remembered per database so sorting or paging a list doesn't count it again."""
    key = (DB_GEN, sql, tuple(params))
    with CACHE_LOCK:
        if key in COUNTS:
            COUNTS.move_to_end(key)
            return COUNTS[key]
    n = con.execute(sql, params).fetchone()[0]
    with CACHE_LOCK:
        COUNTS[key] = n
        while len(COUNTS) > 4000:
            COUNTS.popitem(last=False)
    return n


def db_changed():
    """The stored database was replaced: forget cached pages and open connections."""
    global DB_GEN
    DB_GEN += 1
    with CACHE_LOCK:
        CACHE.clear()
        CACHE_SIZE[0] = 0
        COUNTS.clear()
    POOL.close_all()


def reaper():
    while True:
        time.sleep(3)
        POOL.close_all(max_idle=8)


def warm_up(delay=1.0):
    """After start-up or a load: open the common pages in the background and read the save file once,
    so the first clicks don't wait for the disk."""
    gen = DB_GEN

    def run():
        import urllib.request
        time.sleep(delay)
        if not PORT or not os.path.exists(CURRENT_DB):
            return
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # the Stables pages come before People overview (16.7.11): that one reads every race result and takes a while,
        # and anything clicked while it runs waits behind it
        pages = ["home", "meetings", "horses", "races", "races?when=upcoming", "stables", "stable_rankings", "stable_table"]
        if META.get("player_stable_id"):
            ps = META["player_stable_id"]
            pages += ["stable/%s" % ps, "stable_more/%s" % ps, "horse_table?stable=%s" % ps, "stable_races/%s" % ps, "stable_courses/%s" % ps,
                      # your stable's money pages, alone and for its whole ownership group
                      "stable_finance/%s" % ps, "stable_finance/%s?group=1" % ps, "stable_horse_money/%s" % ps, "stable_horse_money/%s?group=1" % ps]
        pages += ["people", "people_overview", "awards", "courses", "pedigrees", "pedigrees?kind=dams", "pedigrees?kind=damsires", "horse_table", "tables"]
        if META.get("player_id"):
            pages.append("person/%s" % META["player_id"])
        for pg in pages:
            if DB_GEN != gen:
                return
            try:
                opener.open("http://127.0.0.1:%d/api/%s" % (PORT, pg), timeout=120).read()
            except Exception:
                pass
        # read the file once so the operating system keeps it in memory
        try:
            with open(CURRENT_DB, "rb") as f:
                while DB_GEN == gen and f.read(8 * 1024 * 1024):
                    time.sleep(0.005)
        except OSError:
            pass

    threading.Thread(target=run, daemon=True).start()


def refresh_meta_if_changed():
    """Pick up a database loaded by another window (e.g. 'Load database.bat')."""
    if meta_mtime() != META_MTIME:
        load_meta()


def ro_uri(path):
    """Read-only SQLite URI that works for Windows drive paths, spaces and odd characters."""
    return Path(os.path.abspath(path)).as_uri() + "?mode=ro"


def connect_ro():
    con = sqlite3.connect(ro_uri(CURRENT_DB), uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.text_factory = lambda b: b.decode("utf-8", errors="replace")
    return con


def rows(con, sql, params=()):
    return [dict(r) for r in con.execute(sql, params).fetchall()]


def one(con, sql, params=()):
    r = con.execute(sql, params).fetchone()
    return dict(r) if r else None


def has_table(con, name):
    return con.execute("select 1 from sqlite_master where type='table' and name=?", (name,)).fetchone() is not None


def columns(con, table):
    return [r[1] for r in con.execute("pragma table_info(" + qident(table) + ")")]


def to_int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def clean_blob(row):
    for k, v in list(row.items()):
        if isinstance(v, (bytes, bytearray)):
            row[k] = "<binary %d bytes>" % len(v)
    return row


# --------------------------------------------------------------------------- import

JOB = {"state": "idle", "step": "", "pct": 0, "error": None, "started": None, "finished": None}
JOB_LOCK = threading.Lock()


STEP_NUM = re.compile(r"\s*\(\d+ of \d+\)\s*$")


def set_job(**kw):
    with JOB_LOCK:
        now = time.time()
        if kw.get("state") == "running" and "started" in kw:
            JOB["steps"] = []          # a new job: time its steps afresh
        step = kw.get("step")
        if step is not None and JOB.get("state") == "running" or kw.get("state") == "running":
            base = STEP_NUM.sub("", step or "")
            steps = JOB.setdefault("steps", [])
            if base and (not steps or steps[-1][0] != base):
                steps.append([base, now])
        JOB.update(kw)


def step_times(until=None):
    """How long each step of the running job took: [[step, seconds], ...] in order."""
    with JOB_LOCK:
        steps = [list(x) for x in JOB.get("steps") or []]
    end = until or time.time()
    out = []
    for i, (name, t) in enumerate(steps):
        nxt = steps[i + 1][1] if i + 1 < len(steps) else end
        out.append([name, round(nxt - t, 1)])
    return out


def job_snapshot():
    with JOB_LOCK:
        d = dict(JOB)
    d.pop("steps", None)
    return d


def job_busy():
    return job_snapshot()["state"] == "running"


def copy_with_backup(src_path):
    """Copy using SQLite's backup API: consistent even if the game has the file open."""
    if os.path.exists(INCOMING_DB):
        os.remove(INCOMING_DB)
    src = sqlite3.connect(ro_uri(src_path), uri=True)
    dst = sqlite3.connect(INCOMING_DB)
    try:
        def progress(status, remaining, total):
            if total:
                set_job(pct=int(40 * (total - remaining) / total))
        src.backup(dst, pages=4096, progress=progress)
    finally:
        dst.close()
        src.close()


WORK_DB = os.path.join(DATA_DIR, "work.db")

# Merge policy ---------------------------------------------------------------
# Entities and history tables: when a newer save no longer has a row, the stored row is kept.
# Everything else ("live" state: entries, offers, shareholdings, settings, rankings...) always comes
# from the newest file, because a missing row there means it is no longer true.
KEEP_ENTITIES = {"horses": "horses", "persons": "persons", "stables": "stables", "racecourses": "racecourses"}
KEEP_TABLES = [
    "horses", "persons", "stables", "racecourses",
    "races", "race_days", "race_series", "race_results", "race_position_snapshots", "race_replays", "timing_trials",
    "transactions", "share_transactions", "auction_results", "trades", "horse_syndicate_distributions", "tax_records", "capital_gains",
    "story_events", "awards", "breeding", "children", "marriages", "illness_injury_history", "criminal_record", "lawsuits",
    "horse_stats_snapshots", "horse_valuation_history", "rating_history", "prestige_log", "stable_financial_snapshots",
    "stable_valuation_history", "staff_stats_snapshots", "venue_monthly_snapshots", "horse_financial_history",
    "staff", "travel_history", "world_economics", "coat_unlocks", "dna_unlocks",
]
# Scheduled things: a missing future row means it was cancelled, so only past rows are kept.
FUTURE_COLS = {"races": "races_race_date_time", "race_days": "raceday_date", "race_series": "raceseries_start_date"}


def single_pk(con, schema, table):
    cols = con.execute("pragma %s.table_info(%s)" % (schema, qident(table))).fetchall()
    pk = [c[1] for c in sorted(cols, key=lambda c: c[5]) if c[5]]
    return pk[0] if len(pk) == 1 else None


def has_table_in(con, schema, name):
    return con.execute("select 1 from %s.sqlite_master where type='table' and name=?" % schema, (name,)).fetchone() is not None


def ensure_removed_table(con):
    con.execute("create table if not exists hrmv_removed (tbl text not null, pk integer not null, last_seen real, primary key (tbl, pk))")


def read_save_info(path):
    """Identify the career a database belongs to, and its in-game date."""
    con = sqlite3.connect(ro_uri(path), uri=True)
    try:
        info = {"save_id": None, "game_date": None, "player": None}
        if has_table(con, "settings"):
            r = con.execute("select settings_value from settings where settings_name='export_save_id'").fetchone()
            if r and r[0]:
                info["save_id"] = r[0]
            else:
                r = con.execute("select settings_value from settings where settings_name='start_date'").fetchone()
                info["save_id"] = "start:" + str(r[0]) if r else None
        if has_table(con, "player"):
            info["game_date"] = con.execute("select max(player_date) from player").fetchone()[0]
        if info["game_date"] is None:
            info["game_date"] = con.execute("select max(race_result_date) from race_results").fetchone()[0]
        if "person_is_player" in columns(con, "persons"):
            r = con.execute("select person_full_name from persons where person_is_player in ('true',1,'1') limit 1").fetchone()
            info["player"] = r[0] if r else None
        return info
    finally:
        con.close()


def merge_missing(target_path, other_path, target_gd, other_gd):
    """Copy rows that exist in other_path but not in target_path into target_path (target wins on conflicts).

    Returns {table: rows_added}."""
    con = sqlite3.connect(target_path)
    added = {}
    try:
        con.execute("attach database ? as other", (other_path,))
        ensure_removed_table(con)
        tables = [t for t in KEEP_TABLES if has_table_in(con, "main", t) and has_table_in(con, "other", t)]
        for i, t in enumerate(tables):
            set_job(step="Keeping older records the new save no longer has (%d of %d)" % (i + 1, len(tables)), pct=42 + int(16 * i / max(1, len(tables))))
            pk = single_pk(con, "main", t)
            if not pk or pk != single_pk(con, "other", t):
                continue
            main_cols = [c[1] for c in con.execute("pragma main.table_info(%s)" % qident(t))]
            other_cols = set(c[1] for c in con.execute("pragma other.table_info(%s)" % qident(t)))
            cols = [c for c in main_cols if c in other_cols]
            cl = ", ".join(qident(c) for c in cols)
            cond = "not exists (select 1 from main.%s n where n.%s=o.%s)" % (qident(t), qident(pk), qident(pk))
            params = []
            if t in FUTURE_COLS and FUTURE_COLS[t] in cols and target_gd is not None:
                cond += " and (o.%s is null or o.%s<=?)" % (qident(FUTURE_COLS[t]), qident(FUTURE_COLS[t]))
                params.append(target_gd)
            con.execute("drop table if exists temp._keep")
            con.execute("create temp table _keep as select %s from other.%s o where %s" % (", ".join("o." + qident(c) for c in cols), qident(t), cond), params)
            n = con.execute("select count(*) from temp._keep").fetchone()[0]
            if not n:
                continue
            if t == "staff" and "staff_end_date" in cols and other_gd is not None:
                # a job that vanished from the newer save has ended by then
                con.execute("update temp._keep set staff_end_date=? where staff_end_date is null", (other_gd,))
            con.execute("insert into main.%s (%s) select %s from temp._keep" % (qident(t), cl, cl))
            if t in KEEP_ENTITIES:
                if has_table_in(con, "other", "hrmv_removed"):
                    con.execute("""insert or ignore into main.hrmv_removed (tbl, pk, last_seen)
                        select r.tbl, r.pk, r.last_seen from other.hrmv_removed r where r.tbl=? and r.pk in (select %s from temp._keep)""" % qident(pk), (t,))
                con.execute("insert or ignore into main.hrmv_removed (tbl, pk, last_seen) select ?, %s, ? from temp._keep" % qident(pk), (t, other_gd))
            added[t] = n
        con.execute("drop table if exists temp._keep")
        con.commit()
        con.execute("detach database other")
    finally:
        con.close()
    return added


def validate_incoming():
    set_job(step="Checking the file is a Horse Racing Manager database", pct=38)
    with open(INCOMING_DB, "rb") as f:
        header = f.read(16)
    if header != b"SQLite format 3\x00":
        raise ValueError("That file isn't a SQLite database.")
    con = sqlite3.connect(INCOMING_DB)
    try:
        missing = [t for t in REQUIRED_TABLES if not has_table(con, t)]
        if missing:
            raise ValueError("This doesn't look like a Horse Racing Manager database (missing tables: %s)." % ", ".join(missing))
        ok = con.execute("pragma quick_check").fetchone()[0]
        if ok != "ok":
            raise ValueError("The database file is damaged: %s" % ok)
        con.execute("pragma journal_mode=delete")
    finally:
        con.close()


def stored_save_info():
    info = {"save_id": META.get("save_id"), "game_date": META.get("game_date"), "player": META.get("player_name")}
    if not info["save_id"] and os.path.exists(CURRENT_DB):
        try:
            info = read_save_info(CURRENT_DB)
        except Exception:
            pass
    return info


def fdate(ts):
    try:
        return (datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=ts)).strftime("%d %b %Y").lstrip("0")
    except Exception:
        return "unknown date"


# --------------------------------------------------------------------------- compact stored data (16.7)
# Optional (Settings -> Stored data), off unless switched on. Applied on every load while it is on:
#  - tables the viewer never shows (rating_history, race_replays) and the story events' hidden "data" text are dropped,
#    as are the game's "Yearly Summary" story events (they have no text and appear nowhere)
#  - other people's horses' raw race positions are dropped once their sectionals are worked out (the sectionals are kept)
#  - big tables are rebuilt without the extra UNIQUE index the game puts on their INTEGER PRIMARY KEY (a copy of the key)
#  - with "thin": other people's horses' stat and value snapshots are kept to one per quarter (charts get fewer points)
# Your stables, your family and every horse that has raced for, been bred or traded by your stables or ridden by you
# (and those horses' parents) are never thinned; that set only grows (meta "compact_keep").
COMPACT_DROP = ("rating_history", "race_replays")
COMPACT_REBUILD_ROWS = 100000          # rebuild a table without its duplicate key index from this many rows
COMPACT_THIN = (("horse_stats_snapshots", "snapshot_id", "snapshot_horse_id", "snapshot_date"),
                ("horse_valuation_history", "valuation_history_id", "valuation_history_horse_id", "valuation_history_date"))
COMPACT_BUCKET = 90 * 86400
COMPACT_DUP_KEY = re.compile(r"(\bINTEGER\s+PRIMARY\s+KEY(?:\s+NOT\s+NULL)?)\s+UNIQUE\b", re.I)


def compact_settings():
    c = read_json(CONFIG_FILE, {}).get("compact") or {}
    on = bool(c.get("on"))
    return {"on": on, "thin": on and bool(c.get("thin")), "disk": os.name == "nt" and c.get("disk") is True,
            "disk_available": os.name == "nt"}


# --------------------------------------------------------------------------- compressing the stored data on disk (Windows, 16.7.2)
# Windows can keep a file compressed on an NTFS drive (the same as ticking "Compress contents to save disk space").
# On by default: each load compresses the new stored copy just before it replaces the old one, while nothing else has it open.
# Pages read it as normal. Not NTFS (FAT, exFAT, some network drives): Windows says no and the file stays as it is.
def compact_exe():
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "compact.exe")


def disk_size(path):
    """The space a file takes on disk: less than its size when Windows keeps it compressed."""
    try:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.GetCompressedFileSizeW.restype = ctypes.c_ulong
            hi = ctypes.c_ulong(0)
            ctypes.set_last_error(0)
            lo = k32.GetCompressedFileSizeW(ctypes.c_wchar_p(path), ctypes.byref(hi))
            if lo != 0xFFFFFFFF or ctypes.get_last_error() == 0:
                return (hi.value << 32) + lo
        st = os.stat(path)
        return st.st_blocks * 512 if getattr(st, "st_blocks", None) else st.st_size
    except Exception:
        return None


DISK = {"busy": False, "thread": None}


def disk_compress_later(path):
    """Compress (switching the setting on) the stored data already in use, in the background. Pages are slow until it's done."""
    def run():
        t = time.time()
        size = disk_compress(path)
        took = round(time.time() - t, 1)
        try:
            meta = read_json(META_FILE, {})
            if meta.get("last_load"):
                meta["last_load"].update(compress_took=took, disk_size=size)
                write_json(META_FILE, meta)
                load_meta_keep_cache()
        except Exception:
            traceback.print_exc()
        DISK["busy"] = False
    disk_wait()
    DISK["busy"] = True
    DISK["thread"] = threading.Thread(target=run, daemon=True)
    DISK["thread"].start()


def disk_wait():
    """Wait for a background compression to finish (Windows won't replace a file it's still compressing)."""
    th = DISK.get("thread")
    if th and th.is_alive():
        th.join()


def disk_compress(path, on=True):
    """Compress (or uncompress) a file on disk with Windows' NTFS compression. Returns the space it takes afterwards."""
    if os.name != "nt" or not os.path.exists(path):
        return None
    import subprocess
    try:
        subprocess.run([compact_exe(), "/c" if on else "/u", "/i", "/q", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=3600, creationflags=0x08000000)       # no console window
    except Exception as e:
        print("Couldn't %s %s: %s" % ("compress" if on else "uncompress", path, e))
    return disk_size(path)


def compact_keep_sets(con, prior):
    """Fill temp.ck_p / temp.ck_s / temp.ck_h with the people, stables and horses that are never thinned."""
    prior = prior or {}
    for t in ("ck_p", "ck_s", "ck_h"):
        con.execute("drop table if exists temp.%s" % t)
        con.execute("create temp table %s (id integer primary key)" % t)

    def add(t, sql):
        try:
            con.execute("insert or ignore into temp.%s %s" % (t, sql))
        except sqlite3.Error as e:
            print("compact: skipped a keep-set query (%s)" % e)

    for t, key in (("ck_p", "persons"), ("ck_s", "stables"), ("ck_h", "horses")):
        con.executemany("insert or ignore into temp.%s values (?)" % t, [(int(i),) for i in prior.get(key) or []])
    if "person_is_player" in columns(con, "persons"):
        add("ck_p", "select person_person_id from persons where person_is_player in ('true',1,'1')")
    if has_table(con, "children"):
        add("ck_p", "select child_parent_1_id from children where child_person_id in (select id from temp.ck_p) and child_parent_1_id is not null")
        add("ck_p", "select child_parent_2_id from children where child_person_id in (select id from temp.ck_p) and child_parent_2_id is not null")
    for _ in range(3):      # spouses, children and grandchildren
        if has_table(con, "marriages"):
            add("ck_p", "select marriage_person_2_id from marriages where marriage_person_1_id in (select id from temp.ck_p)")
            add("ck_p", "select marriage_person_1_id from marriages where marriage_person_2_id in (select id from temp.ck_p)")
        if has_table(con, "children"):
            add("ck_p", "select child_person_id from children where child_parent_1_id in (select id from temp.ck_p) or child_parent_2_id in (select id from temp.ck_p)")
    add("ck_s", "select stable_stable_id from stables where stable_owner_id in (select id from temp.ck_p)")
    if has_table(con, "settings"):
        add("ck_s", "select cast(settings_value as integer) from settings where settings_name='player_active_stable_id' and settings_value is not null")
    add("ck_h", "select horse_horse_id from horses where horse_stable_id in (select id from temp.ck_s)")
    for table, col, idcol in (("race_results", "race_result_stable_id", "race_result_horse_id"),
                              ("race_participants", "race_participant_stable_id", "race_participant_horse_id"),
                              ("breeding", "breeding_stable_id", "breeding_horse_id"),
                              ("horse_financial_history", "hfh_stable_id", "hfh_horse_id")):
        if has_table(con, table) and {col, idcol} <= set(columns(con, table)):
            add("ck_h", "select %s from %s where %s in (select id from temp.ck_s) and %s is not null" % (idcol, table, col, idcol))
    if has_table(con, "race_results") and "race_result_person_jockey_id" in columns(con, "race_results"):
        add("ck_h", "select race_result_horse_id from race_results where race_result_person_jockey_id in (select id from temp.ck_p)")
    if has_table(con, "trades"):
        add("ck_h", """select trades_entity_id from trades where trades_entity_type='horse'
            and (trades_seller_stable_id in (select id from temp.ck_s) or trades_buyer_stable_id in (select id from temp.ck_s))""")
    if {"horse_breeding_parent_mare_id", "horse_breeding_parent_stallion_id"} <= set(columns(con, "horses")):
        add("ck_h", "select horse_breeding_parent_mare_id from horses where horse_horse_id in (select id from temp.ck_h) and horse_breeding_parent_mare_id is not null")
        add("ck_h", "select horse_breeding_parent_stallion_id from horses where horse_horse_id in (select id from temp.ck_h) and horse_breeding_parent_stallion_id is not null")
    return {k: [r[0] for r in con.execute("select id from temp.%s order by id" % t)] for k, t in (("persons", "ck_p"), ("stables", "ck_s"), ("horses", "ck_h"))}


def compact_rebuild(con, t):
    """Rebuild a table without the extra UNIQUE index the game puts on its INTEGER PRIMARY KEY (it only copies the key).
    The table's other indexes and triggers are made again. Returns True if it was rebuilt."""
    r = con.execute("select sql from sqlite_master where type='table' and name=?", (t,)).fetchone()
    if not r or not r[0] or not COMPACT_DUP_KEY.search(r[0]):
        return False
    if not con.execute("select 1 from sqlite_master where type='index' and tbl_name=? and name like 'sqlite_autoindex%'", (t,)).fetchone():
        return False
    new = COMPACT_DUP_KEY.sub(r"\1", r[0], count=1)
    new = re.sub(r"^\s*CREATE\s+TABLE\s+(?:\"[^\"]+\"|`[^`]+`|\[[^\]]+\]|\S+?)(?=\s*\()", "CREATE TABLE hrmv_compact_new", new, count=1, flags=re.I)
    if "hrmv_compact_new" not in new:
        return False
    extra = [x[0] for x in con.execute("select sql from sqlite_master where tbl_name=? and type in ('index','trigger') and sql is not null", (t,))]
    con.commit()
    try:
        con.execute("begin")
        con.execute("drop table if exists hrmv_compact_new")
        con.execute(new)
        con.execute("insert into hrmv_compact_new select * from %s" % qident(t))
        con.execute("drop table %s" % qident(t))
        con.execute("alter table hrmv_compact_new rename to %s" % qident(t))
        for sql in extra:
            con.execute(sql)
        con.commit()
        return True
    except sqlite3.Error as e:
        con.rollback()
        print("compact: left %s as it was (%s)" % (t, e))
        return False


def compact_pre(con, thin, prior_keep):
    """The compacting that can be done before the stats are worked out. Returns what to remember in meta.json."""
    info = {"thin": thin, "events": 0, "snapshots": 0, "rebuilt": []}
    set_job(step="Compacting the stored data (1 of 3)", pct=56)
    info["keep"] = compact_keep_sets(con, prior_keep)
    for t in COMPACT_DROP:
        con.execute("drop table if exists %s" % qident(t))
    if has_table(con, "story_events"):
        before = con.total_changes
        con.execute("delete from story_events where event_type='Yearly Summary'")
        info["events"] = con.total_changes - before
        if "event_data" in columns(con, "story_events"):
            con.execute("update story_events set event_data=NULL where event_data is not null")
    if thin:
        for tbl, idc, hc, dc in COMPACT_THIN:
            if has_table(con, tbl) and {idc, hc, dc} <= set(columns(con, tbl)):
                before = con.total_changes
                con.execute("""delete from %s where %s not in (select id from temp.ck_h) and %s not in
                    (select max(%s) from %s group by %s, cast(%s / %d as int))""" % (tbl, hc, idc, idc, tbl, hc, dc, COMPACT_BUCKET))
                info["snapshots"] += con.total_changes - before
    con.commit()
    set_job(step="Compacting the stored data (2 of 3)", pct=58)
    big = []
    for (t,) in con.execute("""select distinct tbl_name from sqlite_master where type='index' and name like 'sqlite_autoindex%'
            and tbl_name not like 'hrmv_%'""").fetchall():
        if con.execute("select count(*) from (select 1 from %s limit %d)" % (qident(t), COMPACT_REBUILD_ROWS)).fetchone()[0] >= COMPACT_REBUILD_ROWS:
            big.append(t)
    for t in big:
        if compact_rebuild(con, t):
            info["rebuilt"].append(t)
    return info


# Tables the viewer never keeps: daily_function_performance is the game's own log of how long its daily routines
# took to run (developer diagnostics, ~28 MB on a big save, nothing about racing). Dropped on every load (16.7.5).
NEVER_KEEP = ("daily_function_performance",)


FORK_ROLLED = ("Salary, yearly total", "Win shares, yearly total")
FORK_CHECKED = " (payments the save no longer has)"


def fix_fork_rollups(con):
    """Stored data from the slimmed personal edit of 16.6 rolled other stables' salary and win-share payments of
    finished years into one row per payer, payee, type and year (negative ids, notes like "Salary, yearly total").
    The game keeps handing those payments back, which that edit deleted on every load; here they're kept, so each
    yearly total is cut to the part the save no longer has (or removed if every payment is back), and marked so it's
    only done once. Returns how many yearly totals were changed (16.7.3)."""
    if not has_table(con, "transactions") or not {"transaction_note", "transaction_category"} <= set(columns(con, "transactions")):
        return 0
    rolled = con.execute("""select transaction_transaction_id, transaction_from_entity_id, transaction_from_entity_type, transaction_to_entity_id,
            transaction_to_entity_type, transaction_type, coalesce(transaction_category, ''), strftime('%Y', transaction_date, 'unixepoch'),
            transaction_amount, transaction_note from transactions where transaction_transaction_id < 0 and transaction_note in (?, ?)""", FORK_ROLLED).fetchall()
    if not rolled:
        return 0
    con.execute("drop table if exists temp.fork_raw")
    con.execute("""create temp table fork_raw as select transaction_from_entity_id as f, transaction_from_entity_type as ft,
            transaction_to_entity_id as t, transaction_to_entity_type as tt, transaction_type as ty, coalesce(transaction_category, '') as cat,
            strftime('%Y', transaction_date, 'unixepoch') as y, sum(transaction_amount) as amt
        from transactions where transaction_transaction_id > 0 and transaction_type in ('Salary', 'Win Share') group by 1, 2, 3, 4, 5, 6, 7""")
    con.execute("create index temp.fork_raw_k on fork_raw(f, t, y)")
    changed = 0
    for rid, f, ft, t, tt, ty, cat, y, amt, note in rolled:
        r = con.execute("select amt from temp.fork_raw where f=? and t=? and y=? and ft is ? and tt is ? and ty is ? and cat=?",
                        (f, t, y, ft, tt, ty, cat)).fetchone()
        back = (r[0] or 0) if r else 0
        if back and abs(amt or 0) - abs(back) <= 0.01:
            con.execute("delete from transactions where transaction_transaction_id=?", (rid,))
        else:
            con.execute("update transactions set transaction_amount=?, transaction_note=? where transaction_transaction_id=?",
                        ((amt or 0) - back, note + FORK_CHECKED, rid))
        changed += bool(back)
    con.execute("drop table temp.fork_raw")
    con.commit()
    return changed


def carry_sectionals(con, carry):
    """Bring the sectionals (and section records) already worked out for the stored data into incoming.db, so a load
    only adds the new races instead of working them all out again. Returns (sectionals carried, records carried)."""
    same = META.get("derived_version") == DERIVED_VERSION
    must = bool(META.get("compact_keep") or META.get("slim_keep"))      # compacted (or the slimmed 16.6 edit): other horses' race positions are gone, so these are the only copy
    if not carry or not os.path.exists(CURRENT_DB):
        return False, False
    if has_table(con, "hrmv_sectionals"):       # "add older records" and Compact now start from a copy of the stored data
        if same or must:
            return True, same and has_table(con, "hrmv_section_records")
        con.executescript("drop table if exists hrmv_sectionals; drop table if exists hrmv_section_records;")
        return False, False
    if not (same or must):
        return False, False
    con.execute("attach database ? as prev", (CURRENT_DB,))
    try:
        if not has_table_in(con, "prev", "hrmv_sectionals"):
            return False, False
        con.execute("create table hrmv_sectionals as select * from prev.hrmv_sectionals")
        rec = same and has_table_in(con, "prev", "hrmv_section_records")
        if rec:
            con.execute("create table hrmv_section_records as select * from prev.hrmv_section_records")
        return True, rec
    finally:
        con.commit()
        con.execute("detach database prev")


def compact_early(path, prior):
    """Compacting that's done to the copy of the save before the stored data's older records are added (16.7.7):
    the big tables are rebuilt without their duplicate key index, and other people's horses' race positions are
    dropped where their sectionals are already stored. The older records then fill the space this frees, instead of
    the whole file being rewritten at the end to give it back. Returns the tables rebuilt."""
    con = sqlite3.connect(path)
    rebuilt = []
    try:
        set_job(step="Compacting the save before keeping older records", pct=40)
        for t in NEVER_KEEP:
            con.execute("drop table if exists %s" % qident(t))
        con.commit()
        # which tables are big enough to rebuild, decided before any rows are dropped (as compacting after the merge did)
        big = []
        for (t,) in con.execute("""select distinct tbl_name from sqlite_master where type='index' and name like 'sqlite_autoindex%'
                and tbl_name not like 'hrmv_%'""").fetchall():
            if con.execute("select count(*) from (select 1 from %s limit %d)" % (qident(t), COMPACT_REBUILD_ROWS)).fetchone()[0] >= COMPACT_REBUILD_ROWS:
                big.append(t)
        if prior and has_table(con, "race_position_snapshots") and os.path.exists(CURRENT_DB):
            compact_keep_sets(con, prior)
            con.execute("attach database ? as prev", (CURRENT_DB,))
            try:
                if has_table_in(con, "prev", "hrmv_sectionals"):
                    con.execute("drop table if exists temp.ce_done")
                    con.execute("create temp table ce_done (race_id integer, horse_id integer, primary key (race_id, horse_id)) without rowid")
                    con.execute("insert or ignore into temp.ce_done select race_id, horse_id from prev.hrmv_sectionals where horse_id not in (select id from temp.ck_h)")
                    con.execute("""delete from race_position_snapshots where race_position_horse_id not in (select id from temp.ck_h)
                        and exists (select 1 from temp.ce_done d where d.race_id=race_position_race_id and d.horse_id=race_position_horse_id)""")
                    con.execute("drop table temp.ce_done")
                con.commit()
            finally:
                con.execute("detach database prev")
        for t in big:
            if compact_rebuild(con, t):
                rebuilt.append(t)
    finally:
        con.close()
    return rebuilt


def compact_post(con, info):
    """After the sectionals are worked out: other people's horses' raw race positions, then give the space back."""
    if has_table(con, "race_position_snapshots"):
        set_job(step="Compacting the stored data (3 of 3)", pct=88)
        con.execute("delete from race_position_snapshots where race_position_horse_id not in (select id from temp.ck_h)")
        con.commit()
    page = con.execute("pragma page_size").fetchone()[0]
    free = con.execute("pragma freelist_count").fetchone()[0] * page
    info["freed"] = free
    total = con.execute("pragma page_count").fetchone()[0] * page
    if free >= max(64 * 1024 * 1024, total // 20):
        set_job(step="Giving the space back (a minute or so)", pct=90)
        con.execute("vacuum")


def process_incoming(source_label, source_path, decision=None, validated=False):
    """Validate data/incoming.db, merge with the stored data, add indexes and stats, then swap it in.

    decision: None = merge automatically (asking first if the file is from another save or older),
    "merge" = newest wins, "add" = only add missing rows, "replace" = start fresh from this file."""
    if not validated:
        validate_incoming()
    new = read_save_info(INCOMING_DB)
    mode = "fresh"
    added = {}
    early_rebuilt = []
    if os.path.exists(CURRENT_DB):
        old = stored_save_info()
        same = bool(old.get("save_id")) and old.get("save_id") == new.get("save_id")
        older = same and new["game_date"] is not None and old["game_date"] is not None and new["game_date"] < old["game_date"]
        # each database follows one player: a different player name (or a different save) means asking first
        player_changed = bool(old.get("player")) and bool(new.get("player")) and old["player"] != new["player"]
        if decision == "compact":
            mode = "compact"        # Compact now: the stored data itself, copied to incoming.db
        elif decision is None:
            if not same:
                set_job(state="confirm", step="Waiting for your choice", pending={"label": source_label, "path": source_path}, confirm={
                    "kind": "different",
                    "message": "This file is from a different save (%s, %s) than this database (%s, %s). Is it the same world?" % (
                        new.get("player") or "unknown player", fdate(new["game_date"]), old.get("player") or "unknown player", fdate(old["game_date"])),
                    "options": [["newdb", "No, a different world: load it as a new database (recommended)"],
                                ["merge", "Yes, the same world: keep using this database and update it"],
                                ["replace", "Replace this database with this file"], ["cancel", "Cancel"]]})
                return False
            if player_changed:
                set_job(state="confirm", step="Waiting for your choice", pending={"label": source_label, "path": source_path}, confirm={
                    "kind": "player",
                    "message": "The player in this save is %s, but this database has been following %s. Is it the same world "
                               "(for example %s's heir carrying on), or a new player?" % (new["player"], old["player"], old["player"]),
                    "options": [["merge", "Same world: keep using this database for %s" % new["player"]],
                                ["newdb", "New player: create a new database for %s" % new["player"]], ["cancel", "Cancel"]]})
                return False
            if older:
                set_job(state="confirm", step="Waiting for your choice", pending={"label": source_label, "path": source_path}, confirm={
                    "kind": "older",
                    "message": "This file is older (game date %s) than the stored data (%s)." % (fdate(new["game_date"]), fdate(old["game_date"])),
                    "options": [["add", "Add only the records it has that the stored data doesn't (recommended)"],
                                ["replace", "Replace everything with this older file"], ["cancel", "Cancel"]]})
                return False
            mode = "merge_new"
        elif decision == "add":
            mode = "merge_old"
        elif decision == "merge":
            mode = "merge_new"
        else:
            mode = "fresh"
        if mode == "merge_new":
            if compact_settings()["on"]:
                early_rebuilt = compact_early(INCOMING_DB, META.get("compact_keep") or META.get("slim_keep"))
            added = merge_missing(INCOMING_DB, CURRENT_DB, new["game_date"], old["game_date"])
        elif mode == "merge_old":
            set_job(step="Copying the stored data", pct=40)
            shutil.copyfile(CURRENT_DB, WORK_DB)
            added = merge_missing(WORK_DB, INCOMING_DB, old["game_date"], new["game_date"])
            os.replace(WORK_DB, INCOMING_DB)

    con = sqlite3.connect(INCOMING_DB)
    cset = compact_settings()
    carry = mode != "fresh"
    compact_info = None
    try:
        ensure_removed_table(con)
        for t in NEVER_KEEP:
            con.execute("drop table if exists %s" % qident(t))
        con.commit()
        size_before = os.path.getsize(CURRENT_DB) if carry and os.path.exists(CURRENT_DB) else os.path.getsize(INCOMING_DB)
        carried, carried_rec = carry_sectionals(con, carry)
        fork_fixed = fix_fork_rollups(con) if carry else 0
        if cset["on"]:
            compact_info = compact_pre(con, cset["thin"], (META.get("compact_keep") or META.get("slim_keep")) if carry else None)
            compact_info["rebuilt"] = early_rebuilt + compact_info["rebuilt"]
        todo = []
        for table, col in INDEXES:
            if has_table(con, table) and col in columns(con, table):
                todo.append((table, col))
        for i, (table, col) in enumerate(todo):
            set_job(step="Building fast lookups (%d of %d)" % (i + 1, len(todo)), pct=60 + int(22 * i / max(1, len(todo))))
            con.execute("create index if not exists %s on %s(%s)" % (qident("hrmv_%s_%s" % (table, col)), qident(table), qident(col)))
        con.commit()

        set_job(step="Working out career and stable stats", pct=84)
        build_derived(con, carried, carried_rec)
        if compact_info:
            compact_post(con, compact_info)

        set_job(step="Counting rows", pct=93)
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'hrmv_%' order by name")]
        counts = {t: con.execute("select count(*) from " + qident(t)).fetchone()[0] for t in tables}
        removed = dict(con.execute("select tbl, count(*) from hrmv_removed group by tbl").fetchall())

        player_id = None
        if "person_is_player" in columns(con, "persons"):
            r = con.execute("select person_person_id from persons where person_is_player in ('true',1,'1') order by person_person_id limit 1").fetchone()
            player_id = r[0] if r else None
        player_stable_id = None
        if has_table(con, "settings"):
            r = con.execute("select settings_value from settings where settings_name='player_active_stable_id'").fetchone()
            player_stable_id = to_int(r[0]) if r else None
    finally:
        con.close()

    final = read_save_info(INCOMING_DB)
    history = list(META.get("history") or []) if mode != "fresh" else []
    history.append({"loaded_at": time.time(), "source": source_path or source_label, "file_game_date": new["game_date"],
                    "mode": mode, "kept": sum(added.values()), "kept_by_table": added})
    meta = {
        "source": source_label,
        "source_path": source_path,
        "loaded_at": time.time(),
        "file_size": os.path.getsize(INCOMING_DB),
        "game_date": final["game_date"],
        "save_id": final["save_id"],
        "player_name": final["player"],
        "players": list(dict.fromkeys([p for p in (META.get("players") or []) + [META.get("player_name"), final["player"]] if p]))
        if mode != "fresh" else [p for p in [final["player"]] if p],
        "player_id": player_id,
        "player_stable_id": player_stable_id,
        "counts": counts,
        "removed": removed,
        "history": history[-50:],
        "derived_version": DERIVED_VERSION,
    }
    if compact_info:
        meta["compact_keep"] = compact_info.pop("keep")
        compact_info.update(at=time.time(), before=size_before, after=os.path.getsize(INCOMING_DB))
        meta["compact"] = compact_info
    elif carry and (META.get("compact_keep") or META.get("slim_keep")):
        meta["compact_keep"] = META.get("compact_keep") or META["slim_keep"]     # its other horses' race positions are still gone
        if META.get("compact"):
            meta["compact"] = META["compact"]

    if cset["disk"]:
        # before the swap: pages keep reading the old stored data at full speed meanwhile (a file Windows is
        # compressing can hardly be read until it's done, so doing it after the swap would make pages hang)
        set_job(step="Compressing it on disk", pct=95)
        t = time.time()
        meta["disk_size"] = disk_compress(INCOMING_DB)
        meta["compress_took"] = round(time.time() - t, 1)
    set_job(step="Saving", pct=97)
    if DISK["busy"]:
        set_job(step="Waiting for the last compression to finish", pct=97)
        disk_wait()
    started = job_snapshot().get("started") or time.time()
    meta["last_load"] = {"at": time.time(), "took": round(time.time() - started, 1), "mode": mode, "steps": step_times(),
                         "size": os.path.getsize(INCOMING_DB), "compress": cset["disk"], "compress_took": meta.pop("compress_took", None),
                         "disk_size": meta.pop("disk_size", None),
                         "save_size": os.path.getsize(source_path) if source_path and os.path.exists(source_path) else None}
    history[-1]["took"] = meta["last_load"]["took"]
    if fork_fixed:
        history[-1]["yearly_totals_fixed"] = fork_fixed
    DB_LOCK.acquire_write()
    try:
        POOL.close_all()
        for attempt in range(40):
            try:
                os.replace(INCOMING_DB, CURRENT_DB)
                break
            except PermissionError:
                # Windows can briefly lock a file (antivirus, or another viewer window that still has it open).
                if attempt == 39:
                    raise
                time.sleep(1)
        write_json(META_FILE, meta)
        load_meta()
    finally:
        DB_LOCK.release_write()
    warm_up()
    if source_path:
        cfg = read_json(CONFIG_FILE, {})
        cfg["last_path"] = source_path
        write_json(CONFIG_FILE, cfg)
    summary = {"mode": mode, "kept": sum(added.values()), "kept_by_table": added}
    set_job(result=summary)
    return True


# --------------------------------------------------------------------------- several databases
# Each database lives in data/databases/<id>/ (current.db, meta.json, slot.json with its name).
# Data stored by versions before 7.9 sits straight in data/ and shows up as the "old layout"
# database until it is moved into the new structure.

DBS_DIR = os.path.join(DATA_DIR, "databases")
LEGACY_ID = "_legacy"
ACTIVE = {"id": None}


def slot_dir(sid):
    return DATA_DIR if sid == LEGACY_ID else os.path.join(DBS_DIR, sid)


def legacy_present():
    return os.path.exists(os.path.join(DATA_DIR, "current.db"))


def valid_slot(sid):
    if not sid:
        return False
    if sid == LEGACY_ID:
        return legacy_present()
    return bool(re.match(r"^[a-z0-9-]{1,60}$", sid)) and os.path.isfile(os.path.join(DBS_DIR, sid, "slot.json"))


def slot_name(sid):
    if sid == LEGACY_ID:
        return "Stored data (old layout)"
    return read_json(os.path.join(DBS_DIR, sid, "slot.json"), {}).get("name") or sid


def slot_summary(sid):
    d = slot_dir(sid)
    db = os.path.join(d, "current.db")
    meta = read_json(os.path.join(d, "meta.json"), {}) if os.path.exists(db) else {}
    slot = read_json(os.path.join(d, "slot.json"), {}) if sid != LEGACY_ID else {}
    try:
        size = os.path.getsize(db) if os.path.exists(db) else 0
    except OSError:
        size = 0
    return {"id": sid, "name": slot_name(sid), "legacy": sid == LEGACY_ID, "active": sid == ACTIVE["id"], "loaded": bool(size),
            "size": size, "player": meta.get("player_name"), "players": meta.get("players") or [], "game_date": meta.get("game_date"), "loaded_at": meta.get("loaded_at"),
            "created": slot.get("created"), "source_path": meta.get("source_path"), "loads": len(meta.get("history") or []),
            "save_id": meta.get("save_id")}


def list_slots():
    out = []
    if legacy_present():
        out.append(LEGACY_ID)
    if os.path.isdir(DBS_DIR):
        for name in sorted(os.listdir(DBS_DIR)):
            if valid_slot(name):
                out.append(name)
    return out


def new_slot(name):
    name = (name or "").strip()[:80] or "New database"
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "database"
    sid, n = base, 2
    while os.path.exists(os.path.join(DBS_DIR, sid)):
        sid, n = "%s-%d" % (base, n), n + 1
    os.makedirs(os.path.join(DBS_DIR, sid))
    write_json(os.path.join(DBS_DIR, sid, "slot.json"), {"name": name, "created": time.time()})
    return sid


def set_paths(sid):
    global CURRENT_DB, INCOMING_DB, META_FILE, WORK_DB
    d = slot_dir(sid)
    CURRENT_DB = os.path.join(d, "current.db")
    INCOMING_DB = os.path.join(d, "incoming.db")
    META_FILE = os.path.join(d, "meta.json")
    WORK_DB = os.path.join(d, "work.db")
    ACTIVE["id"] = sid


def remember_active(sid):
    cfg = read_json(CONFIG_FILE, {})
    cfg["active_db"] = sid
    write_json(CONFIG_FILE, cfg)


def resolve_active():
    cfg = read_json(CONFIG_FILE, {})
    want = cfg.get("active_db")
    if valid_slot(want):
        return want
    if legacy_present():
        return LEGACY_ID
    slots = list_slots()
    if slots:
        return slots[0]
    return new_slot("My save")


def ensure_indexes():
    """Lookups added in newer versions: build any the stored data doesn't have yet (a few seconds, once)."""
    if not os.path.exists(CURRENT_DB):
        return
    try:
        con = sqlite3.connect(CURRENT_DB, timeout=30)
        try:
            have = {r[0] for r in con.execute("select name from sqlite_master where type='index'")}
            made = 0
            for table, col in INDEXES:
                name = "hrmv_%s_%s" % (table, col)
                if name not in have and has_table(con, table) and col in columns(con, table):
                    con.execute("create index if not exists %s on %s(%s)" % (qident(name), qident(table), qident(col)))
                    made += 1
            if made:
                con.commit()
        finally:
            con.close()
    except sqlite3.Error as e:
        print("Couldn't add the newer lookups:", e)


def ensure_derived(progress=None):
    """Data stored by an older version of the viewer: add the newest stats tables once."""
    ensure_indexes()
    if not os.path.exists(CURRENT_DB) or META.get("derived_version") == DERIVED_VERSION:
        return False
    if progress:
        progress()
    con = sqlite3.connect(CURRENT_DB)
    try:
        build_derived(con, carried_sectionals=bool(META.get("compact_keep") or META.get("slim_keep")))
    finally:
        con.close()
    meta = read_json(META_FILE, {})
    meta["derived_version"] = DERIVED_VERSION
    write_json(META_FILE, meta)
    load_meta()
    return True


def activate(sid, rebuild=True):
    """Make another database the one every page shows."""
    DB_LOCK.acquire_write()
    try:
        POOL.close_all()
        set_paths(sid)
        remember_active(sid)
        load_meta()
        if rebuild:
            ensure_derived(lambda: set_job(step="Updating this database for this version of the viewer (about 15 seconds)", pct=50))
    finally:
        DB_LOCK.release_write()
    warm_up()


def replace_retry(src, dst):
    for attempt in range(40):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.5)


def migrate_legacy(name):
    """Move the data stored by versions before 7.9 (data/current.db, data/meta.json) into its own database folder."""
    if not legacy_present():
        raise ValueError("There's nothing in the old layout to move.")
    was_active = ACTIVE["id"] == LEGACY_ID
    sid = new_slot(name)
    DB_LOCK.acquire_write()
    try:
        POOL.close_all()
        db_changed()
        time.sleep(0.2)
        for f in ("current.db", "meta.json", "notes.json"):      # your notes and tags go with their database too
            src = os.path.join(DATA_DIR, f)
            if os.path.exists(src):
                replace_retry(src, os.path.join(DBS_DIR, sid, f))
        if os.path.isdir(os.path.join(DATA_DIR, "images")):      # horse photos go with their database
            shutil.move(os.path.join(DATA_DIR, "images"), os.path.join(DBS_DIR, sid, "images"))
        for f in ("incoming.db", "work.db"):
            try:
                os.remove(os.path.join(DATA_DIR, f))
            except OSError:
                pass
        if was_active:
            set_paths(sid)
            remember_active(sid)
        load_meta()
    finally:
        DB_LOCK.release_write()
    warm_up()
    return sid


def find_viewer_data(path):
    """Where is the stored data in another HRM Viewer folder? Returns (current.db, meta.json or None)."""
    path = os.path.expandvars(os.path.expanduser((path or "").strip().strip('"')))
    if os.path.isfile(path):
        meta = os.path.join(os.path.dirname(path), "meta.json")
        return path, (meta if os.path.isfile(meta) else None)
    for d in (path, os.path.join(path, "data")):
        db = os.path.join(d, "current.db")
        if os.path.isfile(db):
            meta = os.path.join(d, "meta.json")
            return db, (meta if os.path.isfile(meta) else None)
    db = os.path.join(path, "database.db")
    if os.path.isfile(db):
        return db, None
    return None, None


def is_viewer_db(path):
    try:
        con = sqlite3.connect(ro_uri(path), uri=True)
        try:
            return has_table(con, "hrmv_horse_stats")
        finally:
            con.close()
    except sqlite3.Error:
        return False


def run_copy_in(src_db, src_meta, name, move):
    """Bring the stored data of another HRM Viewer folder in as a new database, then open it."""
    try:
        prev = ACTIVE["id"]
        sid = new_slot(name)
        dst = os.path.join(DBS_DIR, sid, "current.db")
        size = os.path.getsize(src_db)
        set_job(step="%s the stored data (%s MB)" % ("Moving" if move else "Copying", size // 1048576), pct=5)
        if move:
            shutil.move(src_db, dst)
            if src_meta:
                shutil.move(src_meta, os.path.join(DBS_DIR, sid, "meta.json"))
        else:
            done = 0
            with open(src_db, "rb") as fi, open(dst + ".part", "wb") as fo:
                while True:
                    chunk = fi.read(8 << 20)
                    if not chunk:
                        break
                    fo.write(chunk)
                    done += len(chunk)
                    set_job(pct=5 + int(70 * done / max(1, size)))
            os.replace(dst + ".part", dst)
            if src_meta:
                shutil.copyfile(src_meta, os.path.join(DBS_DIR, sid, "meta.json"))
        if not src_meta:
            info = read_save_info(dst)
            write_json(os.path.join(DBS_DIR, sid, "meta.json"), {"source": "another HRM Viewer folder", "source_path": src_db, "loaded_at": time.time(),
                                                                  "game_date": info["game_date"], "save_id": info["save_id"], "player_name": info["player"],
                                                                  "derived_version": 0})
        set_job(step="Opening it", pct=80)
        activate(sid)
        set_job(state="done", step="Done", pct=100, finished=time.time(), result={"db": sid, "prev": prev})
    except Exception as e:
        traceback.print_exc()
        set_job(state="error", error=str(e) or e.__class__.__name__, finished=time.time())


def run_switch(sid):
    try:
        set_job(step="Opening %s" % slot_name(sid), pct=20)
        activate(sid)
        set_job(state="done", step="Done", pct=100, finished=time.time(), result={"db": sid})
    except Exception as e:
        traceback.print_exc()
        set_job(state="error", error=str(e) or e.__class__.__name__, finished=time.time())


def start_job(target, *args):
    set_job(state="running", step="Starting", pct=0, error=None, started=time.time(), finished=None, confirm=None, result=None, pending=None, new_db=None, auto=False)
    threading.Thread(target=target, args=args, daemon=True).start()


def undo_new_db():
    """A load into a brand-new database was cancelled or failed: remove the empty database and go back."""
    s = job_snapshot()
    nd = (s.get("pending") or {}).get("new_db") or s.get("new_db")
    if not nd or ACTIVE["id"] != nd.get("id") or os.path.exists(CURRENT_DB):
        return
    shutil.rmtree(slot_dir(nd["id"]), ignore_errors=True)
    if valid_slot(nd.get("prev")):
        activate(nd["prev"], rebuild=False)
    else:
        activate(resolve_active(), rebuild=False)


def api_dbs():
    return {"active": ACTIVE["id"], "legacy": legacy_present(), "list": [slot_summary(x) for x in list_slots()],
            "folder": DATA_DIR}


# --------------------------------------------------------------------------- automatic updates
# Watches the save file the open database was loaded from. When the game writes it (you save),
# the viewer waits until the file has been quiet for a while, then loads it the normal way
# (newest wins, history kept). Only the same save, and never an older file, is loaded on its own.

AUTO_DEFAULTS = {"enabled": True, "quiet": 30, "min_gap": 300}       # on to begin with (16.7.4)
AUTO = {"state": "off", "message": "", "last_check": None, "changed_at": None, "seen_sig": None, "last_import": None,
        "last_result": None, "running": False}
AUTO_LOCK = threading.Lock()


def auto_settings():
    cfg = read_json(CONFIG_FILE, {})
    out = dict(AUTO_DEFAULTS)
    out.update(cfg.get("auto_update") or {})
    return out


GAME_SETTINGS_NAME = "settings.json"


def game_settings_file():
    """The game's own settings.json (16.7.13): it sits in the game's data folder, a level or two above the Saves folder
    of the save this database follows; otherwise the usual data folder for the platform."""
    tried = []
    src = META.get("source_path") or read_json(CONFIG_FILE, {}).get("last_path")
    if src:
        d = os.path.dirname(os.path.abspath(src))
        for _ in range(5):
            tried.append(os.path.join(d, GAME_SETTINGS_NAME))
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
    home = os.path.expanduser("~")
    for base in (os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"),
                 os.path.join(home, "Library", "Application Support"), os.path.join(home, ".local", "share")):
        for godot in ("Godot", "godot"):
            tried.append(os.path.join(base, godot, "app_userdata", "Horse Racing Manager", GAME_SETTINGS_NAME))
    for p in tried:
        try:
            if os.path.isfile(p):
                with open(p, encoding="utf-8") as f:
                    j = json.load(f)
                if isinstance(j, dict) and isinstance(j.get("LOCALIZATION"), dict):
                    return p, j
        except (OSError, ValueError):
            continue
    return None, None


def api_game_display(con):
    """The game's display settings (currency, number, date and unit formats) and the currencies in the save."""
    path, j = game_settings_file()
    cur = []
    if con is not None and has_table(con, "countries") and {"country_currency", "country_currency_symbol"} <= set(columns(con, "countries")):
        seen = {}
        iso = "country_code_iso2" if "country_code_iso2" in columns(con, "countries") else "''"
        for code, sym, name, cc in con.execute("select country_currency, country_currency_symbol, country_name, %s from countries where country_currency is not null order by country_name" % iso):
            if not code:
                continue
            # named after its own country (a currency code starts with that country's code: NZD, New Zealand), or the first that uses it
            if code not in seen or (cc and str(cc).upper() == code[:2] and seen[code].get("cc") != code[:2]):
                seen[code] = {"code": code, "symbol": sym or code, "country": name, "cc": str(cc or "").upper()}
        shared = {"EUR": "Euro area", "XOF": "West Africa (CFA)", "XAF": "Central Africa (CFA)", "XCD": "East Caribbean", "XPF": "French Pacific (CFP)", "ANG": "Netherlands Antilles"}
        for c in seen.values():
            c["country"] = shared.get(c["code"], c["country"])
            c.pop("cc", None)
        cur = sorted(seen.values(), key=lambda x: x["code"])
    return {"found": bool(path), "path": path, "loc": (j or {}).get("LOCALIZATION") or {}, "currencies": cur}


def file_sig(path):
    """(modified time, size) of the save file and its write-ahead log, which together change whenever the game writes."""
    try:
        st = os.stat(path)
        sig = [st.st_mtime, st.st_size]
        wal = path + "-wal"
        if os.path.exists(wal):
            w = os.stat(wal)
            sig += [w.st_mtime, w.st_size]
        return tuple(sig)
    except OSError:
        return None


def load_meta_keep_cache():
    global META, META_MTIME
    with META_LOCK:
        META_MTIME = meta_mtime()
        META = read_json(META_FILE, {}) if os.path.exists(CURRENT_DB) else {}


def auto_watch_path():
    p = META.get("source_path")
    return p if p and os.path.isfile(p) else None


def auto_status():
    st = auto_settings()
    path = META.get("source_path")
    exists = bool(path) and os.path.isfile(path)
    mtime = None
    if exists:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            pass
    with AUTO_LOCK:
        a = dict(AUTO)
    a.pop("seen_sig", None)
    return dict(a, settings=st, path=path, exists=exists, file_mtime=mtime, loaded_at=META.get("loaded_at"), last_load=META.get("last_load"),
                compressing=DISK["busy"],
                game_date=META.get("game_date"), db=ACTIVE["id"], job=job_snapshot().get("state"),
                job_auto=bool(job_snapshot().get("auto")), job_started=job_snapshot().get("started"))


def auto_set(**kw):
    with AUTO_LOCK:
        AUTO.update(kw)


def auto_tick(force=False):
    st = auto_settings()
    now = time.time()
    auto_set(last_check=now)
    if not st["enabled"] and not force:
        auto_set(state="off", message="Automatic updates are off.")
        return
    path = auto_watch_path()
    if not path:
        auto_set(state="nofile", message="The save file this database was loaded from can't be found. Load it once from its location to start watching it.")
        return
    sig = file_sig(path)
    if not sig:
        return
    done = META.get("source_sig")
    if done is None:
        # loaded before 8.5: count the file as loaded if it hasn't changed since
        if META.get("loaded_at") and sig[0] <= META["loaded_at"]:
            meta = read_json(META_FILE, {})
            meta["source_sig"] = list(sig)
            write_json(META_FILE, meta)
            load_meta_keep_cache()
            done = list(sig)
    if done is not None and tuple(done) == sig:
        auto_set(state="current", message="Up to date with %s." % os.path.basename(path), changed_at=None)
        return
    with AUTO_LOCK:
        if AUTO.get("seen_sig") != sig:
            AUTO["seen_sig"] = sig
            AUTO["changed_at"] = now
    a = dict(AUTO)
    if not force:
        if now - (a["changed_at"] or now) < st["quiet"]:
            auto_set(state="waiting", message="The save file changed — waiting until the game has finished writing it.")
            return
        if a["last_import"] and now - a["last_import"] < st["min_gap"]:
            auto_set(state="waiting", message="The save file changed — the next update is allowed at %s." %
                     time.strftime("%H:%M", time.localtime(a["last_import"] + st["min_gap"])))
            return
    if job_busy() or job_snapshot().get("state") == "confirm":
        auto_set(state="waiting", message="Waiting for the current load to finish.")
        return
    try:
        info = read_save_info(path)
    except Exception:
        auto_set(state="waiting", message="The save file is busy — trying again shortly.")
        return
    stored = stored_save_info()
    other_save = stored.get("save_id") and info.get("save_id") != stored.get("save_id")
    other_player = stored.get("player") and info.get("player") and info["player"] != stored["player"]
    if other_save or other_player:
        # remember this file version so the question is asked once, then ask what to do
        meta = read_json(META_FILE, {})
        meta["source_sig"] = list(sig)
        write_json(META_FILE, meta)
        load_meta_keep_cache()
        auto_set(state="skipped", message=("The save file now holds a different save" if other_save else
                                           "The player in the save file is now %s (this database follows %s)" % (info["player"], stored["player"]))
                 + ", so the viewer is asking what to do.")
        start_import("path", path, None, auto=True)
        return
    if info.get("game_date") and stored.get("game_date") and info["game_date"] < stored["game_date"]:
        meta = read_json(META_FILE, {})
        meta["source_sig"] = list(sig)
        write_json(META_FILE, meta)
        load_meta_keep_cache()
        auto_set(state="skipped", message="The save file is older than the stored data, so it wasn't loaded automatically.")
        return
    auto_set(state="updating", message="Loading the new save…", running=True)
    start_import("path", path, "merge", auto=True)


def auto_set_path(raw):
    """Point the open database at another save file to follow. Returns an error message, or None."""
    p = os.path.expandvars(os.path.expanduser(str(raw).strip().strip('"')))
    if os.path.isdir(p):
        p = os.path.join(p, "database.db")
    if not os.path.isfile(p):
        return "No file found at: %s" % p
    try:
        info = read_save_info(p)
    except Exception:
        return "That file isn't a Horse Racing Manager database (or it couldn't be opened)."
    stored = stored_save_info()
    if stored.get("save_id") and info.get("save_id") and info["save_id"] != stored["save_id"]:
        return ("That file holds a different save (%s, %s) from this database (%s, %s). Load it as a new database instead "
                "(Load database → a new database), then watch it from there." % (info.get("player") or "unknown player", fdate(info.get("game_date")),
                                                                                stored.get("player") or "unknown player", fdate(stored.get("game_date"))))
    meta = read_json(META_FILE, {})
    meta["source_path"] = p
    meta.pop("source_sig", None)     # newer than the stored data? it gets loaded on the next check
    write_json(META_FILE, meta)
    load_meta_keep_cache()
    cfg = read_json(CONFIG_FILE, {})
    cfg["last_path"] = p
    write_json(CONFIG_FILE, cfg)
    with AUTO_LOCK:
        AUTO["seen_sig"] = None
        AUTO["changed_at"] = None
    return None


def auto_after_import(ok, result=None, error=None):
    auto_set(running=False, last_import=time.time(),
             state="current" if ok else "error",
             message=("Updated automatically from %s." % os.path.basename(META.get("source_path") or "the save file")) if ok else "The automatic update failed: %s" % error,
             last_result={"ok": ok, "at": time.time(), "game_date": META.get("game_date"), "kept": (result or {}).get("kept"), "error": error})


def auto_watcher():
    time.sleep(5)
    while True:
        try:
            auto_tick()
        except Exception:
            traceback.print_exc()
        time.sleep(5)


def cleanup_temp_files():
    for p in (INCOMING_DB, WORK_DB):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


def run_import(kind, path=None, decision=None, label=None):
    try:
        if kind == "path":
            set_job(step="Copying the database", pct=0)
            sig = file_sig(path)
            copy_with_backup(path)
            done = process_incoming(os.path.basename(path), path, decision)
            if done and sig:
                meta = read_json(META_FILE, {})
                meta["source_sig"] = list(sig)
                write_json(META_FILE, meta)
                load_meta_keep_cache()
        elif kind == "decision":
            done = process_incoming(label, path, decision, validated=True)
        elif kind == "compact":
            set_job(step="Copying the stored data", pct=5)
            keep = {k: META.get(k) for k in ("source_sig", "file_size", "loaded_at") if META.get(k) is not None}
            shutil.copyfile(CURRENT_DB, INCOMING_DB)
            done = process_incoming(META.get("source") or "stored data", META.get("source_path"), "compact", validated=True)
            if done and keep:       # still the same save file: the automatic updates shouldn't load it again
                meta = read_json(META_FILE, {})
                meta.update(keep)
                write_json(META_FILE, meta)
                load_meta_keep_cache()
        else:
            done = process_incoming(label or "uploaded file", None, decision)
        if done:
            set_job(state="done", step="Loaded", pct=100, finished=time.time())
            if job_snapshot().get("auto"):
                auto_after_import(True, job_snapshot().get("result"))
    except Exception as e:
        traceback.print_exc()
        if job_snapshot().get("auto"):
            auto_after_import(False, error=str(e))
        cleanup_temp_files()
        try:
            undo_new_db()
        except Exception:
            traceback.print_exc()
        set_job(state="error", error=str(e) or e.__class__.__name__, finished=time.time())


def start_import(kind, path=None, decision=None, label=None, new_db=None, auto=False):
    set_job(state="running", step="Starting", pct=0, error=None, started=time.time(), finished=None, confirm=None, result=None,
            new_db=new_db, auto=auto)
    t = threading.Thread(target=run_import, args=(kind, path, decision, label), daemon=True)
    t.start()


def answer_confirm(decision):
    s = job_snapshot()
    if s.get("state") != "confirm" or not os.path.exists(INCOMING_DB):
        return False
    if decision == "cancel":
        cleanup_temp_files()
        undo_new_db()
        set_job(state="idle", step="Cancelled", pct=0, confirm=None, pending=None)
        return True
    pending = s.get("pending") or {}
    if decision == "newdb":
        # keep the stored save as it is and load this file as a separate database
        info = read_save_info(INCOMING_DB)
        prev = ACTIVE["id"]
        sid = new_slot("%s (%s)" % (info.get("player") or "Another save", fdate(info.get("game_date")) if info.get("game_date") else "new"))
        replace_retry(INCOMING_DB, os.path.join(DBS_DIR, sid, "incoming.db"))
        activate(sid, rebuild=False)
        start_import("decision", pending.get("path"), "replace", pending.get("label"), new_db={"id": sid, "prev": prev})
        return True
    start_import("decision", pending.get("path"), decision, pending.get("label"), new_db=s.get("new_db"))
    return True


# --------------------------------------------------------------------------- API: shared bits

RACE_COLS = """x.races_race_id as race_id, x.races_race_name as race_name, x.races_distance as distance,
    x.races_type_of_race as race_type, x.races_grade as grade, x.races_track as track,
    x.races_race_date_time as race_time, x.races_prize_money_total as purse"""


PAGE_LOCAL = threading.local()
MAX_PAGE_ROWS = 5000


def page_size():
    """Rows per page; an export asks for every row."""
    return getattr(PAGE_LOCAL, "size", None) or PAGE_SIZE


def page_args(q):
    page = max(1, to_int(q.get("page"), 1))
    return page, (page - 1) * page_size()


def order_sql(col, d):
    """Empty values last either way. SQLite sorts NULL lowest, so a descending sort already puts them last
    and can then use an index instead of sorting the whole table."""
    return "%s desc" % col if d == "desc" else "(%s is null), %s asc" % (col, col)


def sort_args(q, allowed, default):
    s = q.get("sort") or default
    if s not in allowed:
        s = default
    d = "asc" if (q.get("dir") or "").lower() == "asc" else "desc"
    return allowed[s], d


def name_map(con, table, idcol, namecol, ids):
    ids = [i for i in set(ids) if i not in (None, 0, -1)]
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        sql = "select %s, %s from %s where %s in (%s)" % (idcol, namecol, table, idcol, ",".join("?" * len(chunk)))
        for r in con.execute(sql, chunk):
            out[r[0]] = r[1]
    return out


# --------------------------------------------------------------------------- API: endpoints

def my_stables(con, player_id, active_id):
    """Stables the player manages, owns (and their sub-stables) or holds shares in, directly or through one of their stables.
    Stables the player manages come first."""
    if not player_id:
        return []
    managed = [r[0] for r in con.execute("""select distinct staff_stable_id from staff where staff_person_id=? and staff_end_date is null
        and staff_current_role in ('Manager','Assistant manager') order by staff_current_role='Assistant manager', staff_start_date""", (player_id,))] \
        if has_table(con, "staff") else []
    jobs = dict(con.execute("""select staff_stable_id, staff_current_role from staff where staff_person_id=? and staff_end_date is null
        and staff_current_role in ('Manager','Assistant manager')""", (player_id,)).fetchall()) if managed else {}
    owned = [r[0] for r in con.execute("select stable_stable_id from stables where stable_owner_id=?", (player_id,))]
    if active_id and active_id not in owned:
        owned.append(active_id)
    if owned:
        q = ",".join("?" * len(owned))
        owned += [r[0] for r in con.execute("select stable_stable_id from stables where stable_parent_stable_id in (%s)" % q, owned) if r[0] not in owned]
    shares = {}
    if has_table(con, "stable_investors"):
        q = ",".join("?" * len(owned)) if owned else "null"
        for sid, n, holder in con.execute("""select investor_stable_id, investor_shares_owned, investor_holder_stable_id from stable_investors
                where investor_person_id=? or investor_holder_stable_id in (%s)""" % q, [player_id] + owned):
            shares.setdefault(sid, [0, set()])
            shares[sid][0] += n or 0
            if holder and holder != sid:
                shares[sid][1].add(holder)
    ids = list(dict.fromkeys(managed + owned + list(shares)))
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    info = {r["id"]: r for r in rows(con, """select s.stable_stable_id as id, s.stable_name as name, s.stable_owner_id as owner_id,
        s.stable_total_shares as total_shares, s.stable_liquidated as closed, s.stable_parent_stable_id as parent_id,
        coalesce(t.horses,0) as horses, coalesce(t.starts,0) as starts, coalesce(t.wins,0) as wins, t.prize, t.net_worth
        from stables s left join hrmv_stable_stats t on t.stable_id=s.stable_stable_id where s.stable_stable_id in (%s)""" % q, ids)}
    names = {i: info[i]["name"] for i in info}
    out = []
    for i in ids:
        r = info.get(i)
        if not r:
            continue
        mine = r["owner_id"] == player_id or i in owned or i in jobs
        n, via = shares.get(i, [0, set()])
        pct_ = (100.0 * n / r["total_shares"]) if r["total_shares"] else None
        job = jobs.get(i)
        if job and r["owner_id"] == player_id:
            role = "Owner & %s" % job.lower()
        elif job:
            role = job
        elif r["owner_id"] == player_id:
            role = "Owner"
        elif i in owned:
            role = "Part of %s" % names.get(r["parent_id"], "your stable")
        else:
            role = "Shareholder"
        out.append(dict(r, role=role, mine=mine, managed=bool(job), shares=n, share_pct=pct_, via=[{"id": v, "name": names.get(v)} for v in via if v in names],
                        active=i == active_id, closed=r["closed"] in (1, "1", "true", True)))
    order = {i: n for n, i in enumerate(managed)}
    out.sort(key=lambda r: (not r["managed"], not r["active"], order.get(r["id"], 99), not r["mine"], r["closed"], -(r["share_pct"] or 0), r["name"] or ""))
    return out


def owned_stable_ids(con):
    """Stables you own: yours, and ones your stables own (not ones you only manage or hold shares in)."""
    return [s["id"] for s in my_stables(con, META.get("player_id"), META.get("player_stable_id"))
            if s["mine"] and s["role"] not in ("Manager", "Assistant manager")]


def api_card(con, kind, cid):
    """Small summary shown when you hover over a link."""
    if kind == "horse":
        h = one(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_color as color,
            h.horse_birth_date as birth, h.horse_deceased_date as died, h.horse_international_rating as rating, h.horse_peak_rating as peak,
            h.horse_career_earnings as earnings, h.horse_form as form, h.horse_distance_preference as dist_pref,
            st.stable_name as stable, sp.horse_name as sire, dp.horse_name as dam,
            coalesce(s.starts,0) as starts, coalesce(s.wins,0) as wins, coalesce(s.seconds,0) as seconds, coalesce(s.thirds,0) as thirds,
            %s as g1, coalesce(s.stakes_wins,0) as stakes_wins, s.last_run
            from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id left join stables st on st.stable_stable_id=h.horse_stable_id
            left join horses sp on sp.horse_horse_id=h.horse_breeding_parent_stallion_id left join horses dp on dp.horse_horse_id=h.horse_breeding_parent_mare_id
            where h.horse_horse_id=?""" % gwins("h", "s", "g1"), (cid,))
        return h
    if kind == "person":
        cols = columns(con, "persons")
        want = [c for c in ("person_jockey_starts", "person_jockey_wins", "person_jockey_winnings", "person_trainer_starts", "person_trainer_wins",
                            "person_head_trainer_starts", "person_head_trainer_wins", "person_fame_calculated", "person_birth_date",
                            "person_owner_of_stable_id", "person_deceased_date", "person_jockey_ranking") if c in cols]
        p = one(con, "select person_person_id as id, person_full_name as name%s from persons where person_person_id=?" % "".join(", " + c for c in want), (cid,))
        if p and p.get("person_owner_of_stable_id"):
            st = one(con, "select stable_name from stables where stable_stable_id=?", (p["person_owner_of_stable_id"],))
            p["owns"] = st and st["stable_name"]
        return p
    if kind == "stable":
        return one(con, """select s.stable_stable_id as id, s.stable_name as name, p.person_full_name as owner, s.stable_prestige as prestige,
            s.stable_liquidated as closed, t.horses, t.starts, t.wins, t.prize, t.net_worth, t.g1, t.group_wins, t.top_rating
            from stables s left join hrmv_stable_stats t on t.stable_id=s.stable_stable_id left join persons p on p.person_person_id=s.stable_owner_id
            where s.stable_stable_id=?""", (cid,))
    if kind == "race":
        r = one(con, """select x.races_race_id as id, x.races_race_name as name, x.races_type_of_race as race_type, x.races_race_date_time as date,
            x.races_distance as distance, x.races_track as track, x.races_prize_money_total as purse, c.racecourse_name as course,
            d.raceday_weather_condition as weather,
            (select count(*) from race_results r where r.race_result_race_id=x.races_race_id) as runners
            from races x left join race_days d on d.raceday_race_day_id=x.races_race_day_id
            left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id where x.races_race_id=?""", (cid,))
        if r:
            r["top3"] = rows(con, """select r.race_result_rank as rank, h.horse_name as horse, r.race_result_time as time from race_results r
                left join horses h on h.horse_horse_id=r.race_result_horse_id where r.race_result_race_id=? and r.race_result_rank<=3 order by 1""", (cid,))
            if not r["runners"] and has_table(con, "race_participants"):
                r["entries"] = con.execute("select count(*) from race_participants where race_participant_race_id=?", (cid,)).fetchone()[0]
        return r
    if kind == "course":
        return one(con, """select racecourse_racecourse_id as id, racecourse_name as name, racecourse_location_city as city,
            racecourse_location_country as country, racecourse_direction as direction, racecourse_outer_oval_track_surface as surface,
            racecourse_outer_oval_track_distance as track_length, racecourse_max_attendance as capacity
            from racecourses where racecourse_racecourse_id=?""", (cid,))
    return None


AWARD_GROUPS = [
    ("year", "Horse of the Year", ["best_overall", "best_male", "best_female", "worst_overall"]),
    ("age", "Age divisions", ["male_2yo", "female_2yo", "male_3yo", "female_3yo", "male_4yo", "female_4yo", "male_5yo_plus", "female_5yo_plus"]),
    ("distance", "Distance champions (Asahi Gold)", ["asahi_gold_%s_%s" % (d, x) for d in ("sprint", "mile", "intermediate", "long", "extended") for x in ("stallion", "mare")]),
    ("breeding", "Breeding", ["best_sire", "best_dam", "best_breeder"]),
    ("people", "People", ["best_jockey", "best_trainer", "best_head_trainer", "best_manager", "best_stablehand"]),
    ("stables", "Stables", ["best_stable", "thravang_award"]),
    ("hof", "Hall of Fame", ["hall_of_fame", "hall_of_fame_nominee"]),
]
AWARD_LABELS = {
    "best_overall": "Horse of the Year", "best_male": "Champion Male", "best_female": "Champion Female", "worst_overall": "Worst Horse of the Year",
    "male_2yo": "Champion 2yo Colt", "female_2yo": "Champion 2yo Filly", "male_3yo": "Champion 3yo Colt", "female_3yo": "Champion 3yo Filly",
    "male_4yo": "Champion 4yo Male", "female_4yo": "Champion 4yo Female", "male_5yo_plus": "Champion Older Male (5yo+)", "female_5yo_plus": "Champion Older Female (5yo+)",
    "best_sire": "Sire of the Year", "best_dam": "Dam of the Year", "best_breeder": "Breeder of the Year (Saga Award)",
    "best_jockey": "Jockey of the Year", "best_trainer": "Trainer of the Year", "best_head_trainer": "Head Trainer of the Year",
    "best_manager": "Manager of the Year", "best_stablehand": "Stablehand of the Year",
    "best_stable": "Stable of the Year", "thravang_award": "Thravang Award",
    "hall_of_fame": "Hall of Fame (inducted)", "hall_of_fame_nominee": "Hall of Fame nominees",
}


def award_label(cat, concepts):
    if cat in AWARD_LABELS:
        return AWARD_LABELS[cat]
    m = re.match(r"^asahi_gold_(\w+?)_(stallion|mare)$", cat)
    if m:
        return "%s — %s" % (m.group(1).capitalize(), "Male" if m.group(2) == "stallion" else "Female")
    m = re.match(r"^concept_(\d+)$", cat)
    if m:
        return concepts.get(int(m.group(1))) or "Special award %s" % m.group(1)
    return cat.replace("_", " ").capitalize()


AWARD_RACE_CATS = {"G1": "g1_race", "G2": "g2_race", "G3": "g3_race", "listed": "listed_race"}
AWARD_ROLE_COLS = [("award_jockey_id", "Jockey"), ("award_trainer_id", "Trainer"), ("award_head_trainer_id", "Head trainer"),
                   ("award_stable_manager_id", "Manager"), ("award_caretaker_id", "Caretaker")]


AWARD_ROLE_ORDER = ["Owner", "Manager", "Head trainer", "Trainer", "Jockey", "Caretaker"]


def person_horse_awards(con, pids, races=False):
    """Horse awards (season and concept awards; with races=True also Group/Listed race-win awards) that these people share in:
    as the horse's jockey, trainer, head trainer, manager or caretaker that the game wrote on the award, or as anyone who managed
    the horse's stable on the award date (the game writes one manager only, as on race results).
    {person: [award row + "roles": [...]]}"""
    pids = {p for p in pids if p}
    out = {p: [] for p in pids}
    if not pids or not has_table(con, "awards"):
        return out
    acols = columns(con, "awards")
    roles = [(c, r) for c, r in AWARD_ROLE_COLS if c in acols]
    by_st, _ = manager_tenures(con)
    race_cats = ("g1_race", "g2_race", "g3_race", "listed_race")
    sql = """select a.award_id as id, a.award_category as cat, a.award_year as year, a.award_date as date, a.award_rank as rank,
        a.award_value as value, a.award_description as description, a.award_race_id as race_id, a.award_entity_type as etype,
        a.award_entity_id as eid, case when a.award_entity_type='horse' then coalesce(a.award_horse_id, a.award_entity_id) end as horse_id,
        coalesce(a.award_stable_id, case when a.award_entity_type='stable' then a.award_entity_id end) as stable_id,
        a.award_jockey_id as jockey_id%s from awards a where a.award_entity_type in ('horse', 'stable')""" % "".join(", a.%s as %s" % (c, c) for c, _ in roles)
    own = ownership(con)["pct"]       # stable awards (Stable of the Year, the Thravang Award…) also go to the stable's owner
    if not races:
        sql += " and a.award_category not in ('g1_race','g2_race','g3_race','listed_race')"
    for r in rows(con, sql):
        got = {}
        for c, role in roles:
            if r["etype"] == "stable" and role != "Manager":      # stable awards: only its owner and managers
                continue
            if r.get(c) in pids:
                got.setdefault(r[c], set()).add(role)
        if r["etype"] == "stable":
            h = own.get(r["stable_id"])
            if h and h[0] == "person" and h[1] in pids:
                got.setdefault(h[1], set()).add("Owner")
        if r["stable_id"] and r["date"] is not None:
            for a, b, pid in by_st.get(r["stable_id"], ()):
                if pid in pids and a <= r["date"] <= b:
                    got.setdefault(pid, set()).add("Manager")
        if not got:
            continue
        base = {k: v for k, v in r.items() if not k.startswith("award_")}
        for pid, rs in got.items():
            out[pid].append(dict(base, roles=[x for x in AWARD_ROLE_ORDER if x in rs]))
    return out


def api_awards_of(con, kind, eid):
    """The Awards tab of a horse or a person: every season award, and every Group/Listed race win.
    A person's race wins are the ones they rode, trained, managed or looked after (the role is given)."""
    if not has_table(con, "awards"):
        return {"awards": []}
    concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
    acols = columns(con, "awards")
    sel = """select a.award_id as id, a.award_category as cat, a.award_year as year, a.award_date as date, a.award_rank as rank,
        a.award_value as value, a.award_description as description, a.award_race_id as race_id, a.award_entity_type as etype,
        a.award_entity_id as eid, a.award_horse_id as horse_id, a.award_stable_id as stable_id, a.award_jockey_id as jockey_id %s
        from awards a"""
    roles = [(c, r) for c, r in AWARD_ROLE_COLS if c in acols]
    if kind == "horse":
        data = rows(con, sel % "" + " where a.award_entity_type='horse' and a.award_entity_id=?", (eid,))
        for r in data:
            r["horse_id"] = r["horse_id"] or eid
    else:
        data = rows(con, sel % "" + " where a.award_entity_type='person' and a.award_entity_id=?", (eid,))
        # horse awards and Group/Listed race wins they shared in, with their role(s)
        for r in person_horse_awards(con, [eid], races=True)[eid]:
            r["role"] = " & ".join(r.pop("roles"))
            r["horse_award"] = r["cat"] not in AWARD_RACE_CATS.values()
            r["stable_award"] = r["etype"] == "stable"
            data.append(r)
    # Group 2/3 and Listed wins the awards table doesn't hold, from the results (for a person: the races they rode)
    have = {r["race_id"] for r in data if r.get("race_id")}
    rcols = set(columns(con, "race_results")) if has_table(con, "race_results") else set()
    params = [eid]
    if kind == "horse":
        who = "r.race_result_horse_id=?"
    else:     # rode, head-trained or managed (by the result, or by managing the stable that day)
        who = "(" + " or ".join("r.%s=?1" % c for c in ("race_result_person_jockey_id", "race_result_stable_head_trainer_id", "race_result_trainer_id", "race_result_stable_manager_id") if c in rcols)
        mgr = [(st, a, b) for st, a, b in manager_tenures(con)[1].get(eid, ())]
        if mgr:
            who += " or r.race_result_stable_id in (%s)" % ",".join(str(int(st)) for st in {m[0] for m in mgr})
        who += ")"
    extra = ", r.race_result_stable_head_trainer_id as ht_id" if "race_result_stable_head_trainer_id" in rcols else ", null as ht_id"
    extra += ", r.race_result_stable_manager_id as mg_id" if "race_result_stable_manager_id" in rcols else ", null as mg_id"
    extra += ", r.race_result_trainer_id as tr_id" if "race_result_trainer_id" in rcols else ", null as tr_id"
    for w in rows(con, """select r.race_result_date as date, r.race_result_cash_received as value, x.races_race_name as description,
            x.races_race_id as race_id, x.races_type_of_race as race_type, r.race_result_horse_id as horse_id,
            r.race_result_person_jockey_id as jockey_id, r.race_result_stable_id as stable_id%s
            from race_results r join races x on x.races_race_id=r.race_result_race_id
            where %s and r.race_result_rank=1 and x.races_type_of_race in ('G1','G2','G3','listed')""" % (extra, who), params) if "race_result_stable_id" in rcols else []:
        if w["race_id"] in have:
            continue
        ht, mg, tr = w.pop("ht_id"), w.pop("mg_id"), w.pop("tr_id")
        if kind == "person":
            rs = set()
            if mg == eid or any(st == w["stable_id"] and a <= (w["date"] or 0) <= b for st, a, b in mgr):
                rs.add("Manager")
            if ht == eid:
                rs.add("Head trainer")
            if tr == eid:       # 16.8.1: the horse's own trainer too, as on the Overview's "As a trainer"
                rs.add("Trainer")
            if w["jockey_id"] == eid:
                rs.add("Jockey")
            if not rs:
                continue
            w["role"] = " & ".join(x for x in AWARD_ROLE_ORDER if x in rs)
        yr = (datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=w["date"])).year if w["date"] is not None else None
        data.append(dict(w, id=None, cat=AWARD_RACE_CATS[w.pop("race_type")], year=yr, rank=None, etype=kind, eid=eid))
    hn = name_map(con, "horses", "horse_horse_id", "horse_name", [r["horse_id"] for r in data])
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in data])
    pn = name_map(con, "persons", "person_person_id", "person_full_name", [r["jockey_id"] for r in data])
    for r in data:
        r["kind"] = "race" if r["cat"] in AWARD_RACE_CATS.values() else "season"
        r["label"] = award_label(r["cat"], concepts) if r["kind"] == "season" else None
        r["horse"], r["stable"], r["jockey"] = hn.get(r["horse_id"]), sn.get(r["stable_id"]), pn.get(r["jockey_id"])
        r.setdefault("role", None)
        r.setdefault("horse_award", False)
    data.sort(key=lambda r: (r["date"] or 0, -(r["rank"] or 0)), reverse=True)
    return {"awards": data}


def api_awards(con, q):
    """Season awards year by year (Group and Listed race wins are left out)."""
    if not has_table(con, "awards"):
        return {"groups": [], "years": [], "winners": []}
    concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
    data = rows(con, """select award_category as cat, award_entity_type as etype, award_entity_id as eid, award_year as year, award_rank as rank,
        award_value as value, award_description as description, award_stable_id as stable_id, award_horse_id as horse_id
        from awards where award_category not like '%\\_race' escape '\\' and award_category not in ('g1_race','g2_race','g3_race','listed_race')
        order by award_year desc, award_category, coalesce(award_rank, 99)""")
    ids = {"horse": set(), "person": set(), "stable": set()}
    for r in data:
        if r["etype"] in ids:
            ids[r["etype"]].add(r["eid"])
        if r["stable_id"]:
            ids["stable"].add(r["stable_id"])
    names = {"horse": name_map(con, "horses", "horse_horse_id", "horse_name", list(ids["horse"])),
             "person": name_map(con, "persons", "person_person_id", "person_full_name", list(ids["person"])),
             "stable": name_map(con, "stables", "stable_stable_id", "stable_name", list(ids["stable"]))}
    by_cat = {}
    years = sorted({r["year"] for r in data if r["year"]}, reverse=True)
    for r in data:
        r["name"] = names.get(r["etype"], {}).get(r["eid"])
        r["stable"] = names["stable"].get(r["stable_id"]) if r["stable_id"] and r["etype"] != "stable" else None
        by_cat.setdefault(r["cat"], {}).setdefault(str(r["year"]), []).append(r)
    known = set()
    groups = []
    for key, title, cats in AWARD_GROUPS:
        items = []
        for c in cats:
            for etype in ("horse", "person", "stable"):
                cells = {y: [x for x in v if x["etype"] == etype] for y, v in by_cat.get(c, {}).items()}
                cells = {y: v for y, v in cells.items() if v}
                if cells:
                    lab = award_label(c, concepts)
                    if c.startswith("hall_of_fame"):
                        lab = "%s — %s" % (lab, {"horse": "horses", "person": "people", "stable": "stables"}[etype])
                    items.append({"cat": c, "etype": etype, "label": lab, "years": cells})
            known.add(c)
        if items:
            groups.append({"key": key, "title": title, "awards": items})
    special = []
    for c in sorted(by_cat, key=lambda c: award_label(c, concepts)):
        if c not in known:
            cells = by_cat[c]
            special.append({"cat": c, "etype": next(iter(cells.values()))[0]["etype"], "label": award_label(c, concepts), "years": cells})
    if special:
        groups.append({"key": "special", "title": "Special awards (race series)", "awards": special})
    # who has won the most
    tally = {}
    for r in data:
        if (r["rank"] or 1) != 1 or r["cat"] in ("hall_of_fame_nominee", "worst_overall"):
            continue
        k = (r["etype"], r["eid"])
        t = tally.setdefault(k, {"etype": r["etype"], "id": r["eid"], "name": r["name"], "wins": 0, "awards": {}, "years": set()})
        t["wins"] += 1
        lab = award_label(r["cat"], concepts)
        t["awards"][lab] = t["awards"].get(lab, 0) + 1
        t["years"].add(r["year"])
    winners = sorted(tally.values(), key=lambda t: (-t["wins"], t["name"] or ""))
    for t in winners:
        t["years"] = sorted(t["years"])
        t["awards"] = sorted(t["awards"].items(), key=lambda kv: -kv[1])
    return {"groups": groups, "years": years, "winners": winners}


def api_status(con, q):
    with META_LOCK:
        meta = dict(META)
    cfg = read_json(CONFIG_FILE, {})
    out = {"loaded": bool(con), "meta": meta, "last_path": cfg.get("last_path"), "job": job_snapshot(), "app": update_status(),
           "db": {"id": ACTIVE["id"], "name": slot_name(ACTIVE["id"]), "legacy": ACTIVE["id"] == LEGACY_ID},
           "legacy": legacy_present(), "db_count": len(list_slots()), "desktop": os.environ.get("HRMV_DESKTOP") == "1",
           "has_exe": os.path.exists(os.path.join(APP_DIR, DESKTOP_EXE)), "platform": PLATFORM, "windowed": WINDOWED,
           "window_problem": os.environ.get("HRMV_WINDOW_PROBLEM") or None, "compact": compact_settings(),
           "db_size": os.path.getsize(CURRENT_DB) if os.path.exists(CURRENT_DB) else None,
           "db_disk": disk_size(CURRENT_DB) if os.path.exists(CURRENT_DB) else None, "compressing": DISK["busy"]}
    if con:
        if meta.get("player_id"):
            out["player"] = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (meta["player_id"],))
        if meta.get("player_stable_id"):
            out["player_stable"] = one(con, "select stable_stable_id as id, stable_name as name from stables where stable_stable_id=?", (meta["player_stable_id"],))
        try:
            out["my_stables"] = my_stables(con, meta.get("player_id"), meta.get("player_stable_id"))
        except sqlite3.Error:
            out["my_stables"] = []
    return out


def home_leaders(con):
    """Leader boards for the whole save, shown on the home page."""
    hsel = """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth, h.horse_deceased_date as died,
        h.horse_stable_id as stable_id, st.stable_name as stable, h.horse_international_rating as rating, h.horse_peak_rating as peak,
        h.horse_career_earnings as earnings, coalesce(s.starts,0) as starts, coalesce(s.wins,0) as wins, %s as g1
        from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id left join stables st on st.stable_stable_id=h.horse_stable_id """ % gwins("h", "s", "g1")
    # every horse board comes as {all, alive, dead}; the home page switches between them
    out = {
        "rated": horse_status_lists(lambda w: rows(con, hsel + "where %s order by h.horse_international_rating desc limit 10" % w)),
        "wins": horse_status_lists(lambda w: rows(con, hsel + "where h.horse_horse_id in (select s2.horse_id from hrmv_horse_stats s2 join horses h on h.horse_horse_id=s2.horse_id where %s order by s2.wins desc limit 10) order by wins desc, starts" % w)),
        "earners": horse_status_lists(lambda w: rows(con, hsel + "where %s order by h.horse_career_earnings desc limit 10" % w)),
        "g1": horse_status_lists(lambda w: rows(con, hsel + "where %s order by g1 desc, h.horse_career_earnings desc limit 10" % w)),
    }
    pc = columns(con, "persons")
    if "person_jockey_wins" in pc:
        out["jockeys"] = rows(con, """select person_person_id as id, person_full_name as name, person_jockey_starts as starts, person_jockey_wins as wins,
            person_jockey_winnings as prize from persons order by person_jockey_wins desc limit 10""")
    if "person_trainer_wins" in pc:
        out["trainers"] = rows(con, """select person_person_id as id, person_full_name as name, person_trainer_starts as starts, person_trainer_wins as wins,
            person_trainer_winnings as prize from persons order by person_trainer_wins desc limit 10""")
    out["stables"] = rows(con, """select s.stable_stable_id as id, s.stable_name as name, t.starts, t.wins, t.prize, t.g1, t.horses
        from hrmv_stable_stats t join stables s on s.stable_stable_id=t.stable_id order by t.wins desc limit 10""")
    sires = rows(con, """select g.sid as id, p.horse_name as name, g.foals, g.winners, g.earnings, p.horse_deceased_date as died,
            (g.sid in (select pk from hrmv_removed where tbl='horses')) as removed from (
            select h.horse_breeding_parent_stallion_id as sid, count(*) as foals, sum(coalesce(s.wins,0) > 0) as winners,
                sum(coalesce(h.horse_career_earnings,0)) as earnings
            from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id where h.horse_breeding_parent_stallion_id > 0 group by 1
            order by earnings desc limit 400) g left join horses p on p.horse_horse_id=g.sid order by g.earnings desc""")
    out["sires"] = {"all": sires[:10], "alive": [r for r in sires if r["died"] is None and not r["removed"]][:10],
                    "dead": [r for r in sires if r["died"] is not None][:10]}
    return out


HORSE_STATUS_SQL = {"all": "1=1",
                    "alive": "h.horse_deceased_date is null and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')",
                    "dead": "h.horse_deceased_date is not null"}


def horse_status_lists(fetch):
    """The same horse list three ways: every horse, horses still alive, and horses that have died."""
    return {k: fetch(w) for k, w in HORSE_STATUS_SQL.items()}


def api_home(con, q):
    gd = META.get("game_date") or time.time()
    top_horses = horse_status_lists(lambda w: rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_sex as sex, h.horse_gender as gender,
        h.horse_birth_date as birth, h.horse_deceased_date as died, h.horse_career_earnings as earnings, h.horse_international_rating as rating,
        h.horse_stable_id as stable_id, s.stable_name as stable_name, h.horse_form as form
        from horses h left join stables s on s.stable_stable_id=h.horse_stable_id
        where %s order by h.horse_career_earnings desc limit 10""" % w))
    recent_big = rows(con, """select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
        (select r.race_result_horse_id from race_results r where r.race_result_race_id=x.races_race_id and r.race_result_rank=1 limit 1) as winner_id
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where x.races_type_of_race in ('G1','G2') and x.races_race_date_time<=? order by x.races_race_date_time desc limit 12""" % RACE_COLS, (gd,))
    winners = name_map(con, "horses", "horse_horse_id", "horse_name", [r["winner_id"] for r in recent_big])
    for r in recent_big:
        r["winner_name"] = winners.get(r["winner_id"])
    upcoming_big = rows(con, """select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
        (select count(*) from race_participants p where p.race_participant_race_id=x.races_race_id) as entries
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where x.races_type_of_race='G1' and x.races_race_date_time>? order by x.races_race_date_time asc limit 8""" % RACE_COLS, (gd,))
    out = {"top_horses": top_horses, "recent_big": recent_big, "upcoming_big": upcoming_big}
    out["next_races"] = rows(con, """select %s, x.races_race_number as number, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
        c.racecourse_location_country as country
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where x.races_race_date_time>? order by x.races_race_date_time limit 10""" % RACE_COLS, (gd,))
    sid = META.get("player_stable_id")
    if sid:
        out["my_horses"] = horse_status_lists(lambda w: rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_sex as sex, h.horse_gender as gender,
            h.horse_birth_date as birth, h.horse_deceased_date as died, h.horse_career_earnings as earnings, h.horse_international_rating as rating, h.horse_form as form
            from horses h where h.horse_stable_id=? and %s order by h.horse_career_earnings desc""" % w, (sid,)))
    pid = META.get("player_id")
    if pid:
        out["me"] = one(con, """select person_person_id as id, person_full_name as name, person_jockey_starts as jockey_starts,
            person_jockey_wins as jockey_wins, person_jockey_winnings as jockey_winnings, person_reputation as reputation
            from persons where person_person_id=?""", (pid,))
        out["my_rides"] = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_cash_received as prize,
            r.race_result_horse_id as horse_id, h.horse_name as horse, r.race_result_race_id as race_id, x.races_race_name as race_name,
            x.races_type_of_race as race_type, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
            (select count(*) from race_results rr where rr.race_result_race_id=r.race_result_race_id and r.race_result_race_id>0) as runners
            from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
            left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
            left join race_days d on d.raceday_race_day_id=x.races_race_day_id
            left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
            where r.race_result_person_jockey_id=? order by r.race_result_date desc limit 10""", (pid,))
        out["my_upcoming"] = rows(con, """select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
            p.race_participant_horse_id as horse_id, h.horse_name as horse
            from race_participants p join races x on x.races_race_id=p.race_participant_race_id
            left join race_days d on d.raceday_race_day_id=x.races_race_day_id
            left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
            left join horses h on h.horse_horse_id=p.race_participant_horse_id
            where p.race_participant_person_jockey_id=? and x.races_race_date_time>? order by x.races_race_date_time limit 10""" % RACE_COLS,
                                 (pid, gd)) if has_table(con, "race_participants") else []
    # race cards: your next rides first, then the next Group races
    card_ids = []
    for r in out.get("my_upcoming") or []:
        if r["race_id"] not in card_ids:
            card_ids.append(r["race_id"])
    if len(card_ids) < 3:
        for r in rows(con, """select x.races_race_id as race_id from races x where x.races_race_date_time>?
                and x.races_type_of_race in ('G1','G2','G3') order by x.races_race_date_time limit 6""", (gd,)):
            if r["race_id"] not in card_ids:
                card_ids.append(r["race_id"])
    cards = []
    for rid in card_ids[:3]:
        race = one(con, """select %s, x.races_race_number as number, c.racecourse_name as course, c.racecourse_racecourse_id as course_id
            from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
            left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id where x.races_race_id=?""" % RACE_COLS, (rid,))
        if not race:
            continue
        race["field"] = rows(con, """select p.race_participant_starting_position as gate, p.race_participant_horse_id as horse_id,
            h.horse_name as horse, h.horse_international_rating as rating, h.horse_form as form,
            p.race_participant_person_jockey_id as jockey_id, j.person_full_name as jockey
            from race_participants p left join horses h on h.horse_horse_id=p.race_participant_horse_id
            left join persons j on j.person_person_id=p.race_participant_person_jockey_id
            where p.race_participant_race_id=? order by p.race_participant_starting_position""", (rid,)) if has_table(con, "race_participants") else []
        cards.append(race)
    out["race_cards"] = cards
    _out = out
    _out["leaders"] = home_leaders(con)
    return _out


def api_search(con, q):
    term = (q.get("q") or "").strip()
    if len(term) < 2:
        return {"results": []}
    like = "%" + term + "%"
    res = []
    for r in rows(con, "select horse_horse_id as id, horse_name as name, horse_gender as extra from horses where horse_name like ? order by horse_career_earnings desc limit 8", (like,)):
        res.append({"type": "horse", **r})
    for r in rows(con, "select person_person_id as id, person_full_name as name, '' as extra from persons where person_full_name like ? order by person_fame_calculated desc limit 6", (like,)):
        res.append({"type": "person", **r})
    for r in rows(con, "select stable_stable_id as id, stable_name as name, '' as extra from stables where stable_name like ? order by stable_prestige desc limit 5", (like,)):
        res.append({"type": "stable", **r})
    for r in rows(con, "select racecourse_racecourse_id as id, racecourse_name as name, racecourse_location_country as extra from racecourses where racecourse_name like ? or racecourse_nickname like ? limit 5", (like, like)):
        res.append({"type": "course", **r})
    for r in rows(con, """select max(x.races_race_id) as id, x.races_race_name as name,
        coalesce(x.races_type_of_race,'') || ' · ' || coalesce(max(c.racecourse_name),'') as extra
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where x.races_race_name like ? and x.races_race_date_time<=?
        group by coalesce(nullif(x.races_calendar_id,''), x.races_race_name || '@' || d.raceday_racecourse_id || '@' || coalesce(x.races_type_of_race,''))
        order by min(coalesce(x.races_grade,9)) limit 6""", (like, META.get("game_date") or 4e9)):
        res.append({"type": "race", **r})
    have = {(r["type"], r["id"]) for r in res}
    res += [r for r in notes_search(con, term) if ("horse", r["id"]) not in have]
    return {"results": res}


HORSE_SORTS = {"earnings": "h.horse_career_earnings", "rating": "h.horse_international_rating", "name": "h.horse_name",
               "birth": "h.horse_birth_date", "value": "h.horse_value_calculated", "g1": "h.horse_g1_wins"}


HORSE_ROLES = ("racing", "breeding", "retired", "unraced")


def horse_role_where(con, q, where):
    """The Role and Sires & dams filters on the horse lists (16.7.14). The save has no racing / retired / breeding status,
    so it's worked out: breeding = at stud, leased out, in foal, or had a foal in the last two years; racing = ran in the
    last 12 months; not raced yet = no starts and under 5; retired = the rest. A horse you've pinned to one of the game's
    lists (racing, breeding, retired) goes there. Uses the hrmv_horse_stats join "s". Returns True when it needs it."""
    role, parent = q.get("role"), q.get("parent")
    if role not in HORSE_ROLES and parent not in ("sires", "dams"):
        return False
    gd = float(META.get("game_date") or time.time())
    hc = set(columns(con, "horses"))
    col = lambda c: ("h.%s is not null" % c) if c in hc else "0"
    # a pin is the date you put the horse on that list in the game; if it's on more than one, the latest counts
    pv = lambda c: ("coalesce(h.%s, 0)" % c) if c in hc else "0"
    b_, r_, ra_ = pv("horse_breeding_pinned"), pv("horse_retired_pinned"), pv("horse_racing_pinned")
    pin_b = "(%s > 0 and %s >= %s and %s >= %s)" % (b_, b_, r_, b_, ra_)
    pin_r = "(%s > 0 and %s > %s and %s >= %s)" % (r_, r_, b_, r_, ra_)
    pin_ra = "(%s > 0 and %s > %s and %s > %s)" % (ra_, ra_, b_, ra_, r_)
    nopin = "(%s = 0 and %s = 0 and %s = 0)" % (b_, r_, ra_)
    foal_any = """(exists (select 1 from horses o where o.horse_breeding_parent_mare_id=h.horse_horse_id%s)
        or exists (select 1 from horses o where o.horse_breeding_parent_stallion_id=h.horse_horse_id%s))"""
    recent = " and o.horse_birth_date > %r" % (gd - 2 * YEAR)
    breeding_auto = "(%s or %s or %s or %s)" % (col("horse_stud_date"), col("horse_lease_date"), col("horse_is_pregnant"), foal_any % (recent, recent))
    alive = "h.horse_deceased_date is null and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')"
    ran_recently = "coalesce(s.last_run, 0) >= %r" % (gd - YEAR)
    unraced = "coalesce(s.starts, 0) = 0 and h.horse_birth_date > %r" % (gd - 5 * YEAR)
    if role == "breeding":
        where.append("(%s and (%s or (%s and %s)))" % (alive, pin_b, nopin, breeding_auto))
    elif role == "racing":
        where.append("(%s and (%s or (%s and not %s and %s)))" % (alive, pin_ra, nopin, breeding_auto, ran_recently))
    elif role == "unraced":
        where.append("(%s and %s and not %s and %s)" % (alive, nopin, breeding_auto, unraced))
    elif role == "retired":
        where.append("(%s and (%s or (%s and not %s and not %s and not (%s))))" % (alive, pin_r, nopin, breeding_auto, ran_recently, unraced))
    if parent == "sires":
        where.append("(h.horse_sex='Male' and (%s or exists (select 1 from horses o where o.horse_breeding_parent_stallion_id=h.horse_horse_id)))" % col("horse_stud_date"))
    elif parent == "dams":
        where.append("(h.horse_sex='Female' and (%s or exists (select 1 from horses o where o.horse_breeding_parent_mare_id=h.horse_horse_id)))" % col("horse_is_pregnant"))
    return True


def rank_select(sort_expr, natural_asc):
    """Each row's rank in the sorted column, over every row the filters keep: the best is 1 whichever way it's sorted,
    equal figures share a rank, an empty figure gets none (16.7.11 on the Stable table; 16.7.14 on the horse lists)."""
    return ", case when %s is null then null else rank() over (order by %s) end as _rank " % (sort_expr, order_sql(sort_expr, "asc" if natural_asc else "desc"))


def api_horses(con, q):
    where, params = [], []
    if q.get("q"):
        where.append("h.horse_name like ?")
        params.append("%" + q["q"] + "%")
    status = q.get("status") or "alive"
    if status in ("alive", "dead"):
        where.append(HORSE_STATUS_SQL[status])
    if q.get("gender"):
        where.append("h.horse_gender=?")
        params.append(q["gender"])
    if q.get("stable"):
        where.append("h.horse_stable_id=?")
        params.append(to_int(q["stable"]))
    notes_filter(where, q, con=con)
    needs_stats = horse_role_where(con, q, where)
    sort, d = sort_args(q, HORSE_SORTS, "earnings")
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    sj = " left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id" if needs_stats else ""
    total = count_rows(con, "select count(*) from horses h" + sj + w, params)
    data = rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth,
        h.horse_deceased_date as died, h.horse_career_earnings as earnings, h.horse_international_rating as rating,
        h.horse_value_calculated as value, h.horse_g1_wins as g1, h.horse_form as form, h.horse_color as color,
        h.horse_stable_id as stable_id, st.stable_name as stable_name""" + rank_select(sort, (q.get("sort") or "earnings") == "name") + """
        from horses h left join stables st on st.stable_stable_id=h.horse_stable_id""" + sj + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    auto = horse_auto(con, [r["id"] for r in data])
    for r in data:
        r["auto"] = auto.get(r["id"])
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


def horse_owners(con, h):
    """Every stable that has owned a horse, oldest first (16.7.16): when it got the horse, what it paid, and whether it was
    at auction (the game logs every change of hands in "trades", auction sales included; those are matched to their sale)."""
    hid = h["horse_horse_id"]
    if not has_table(con, "trades"):
        return []
    tr = rows(con, """select t.trades_date as date, t.trades_seller_stable_id as seller_id, t.trades_buyer_stable_id as buyer_id, t.trades_cash as price,
        bs.stable_name as buyer, ss.stable_name as seller from trades t left join stables bs on bs.stable_stable_id=t.trades_buyer_stable_id
        left join stables ss on ss.stable_stable_id=t.trades_seller_stable_id
        where t.trades_entity_type='horse' and t.trades_entity_id=? order by t.trades_date, t.trades_trade_id""", (hid,))
    sales = rows(con, """select r.auction_result_date as date, r.auction_result_final_price as price, r.auction_result_shell_id as sale_id, a.auction_shell_name as sale,
        h.auction_house_id as house_id, h.auction_house_name as house from auction_results r left join auction_shell a on a.auction_shell_id=r.auction_result_shell_id
        left join auction_house h on h.auction_house_id=r.auction_result_auctionhouse_id
        where r.auction_result_horse_id=? and r.auction_result_accepted in (1,'1','true')""", (hid,)) if has_table(con, "auction_results") else []
    out = []
    if tr:
        first = tr[0]
        out.append({"stable_id": first["seller_id"], "stable": first["seller"], "from": h.get("horse_birth_date"), "how": "first", "price": None})
    else:
        st = one(con, "select stable_name from stables where stable_stable_id=?", (h.get("horse_stable_id"),)) if h.get("horse_stable_id") is not None else None
        return [{"stable_id": h.get("horse_stable_id"), "stable": (st or {}).get("stable_name"), "from": h.get("horse_birth_date"), "how": "first", "price": None, "now": True}]
    for t in tr:
        sale = next((x for x in sales if x["date"] is not None and t["date"] is not None and abs(x["date"] - t["date"]) < 4 * 86400), None)
        out.append({"stable_id": t["buyer_id"], "stable": t["buyer"], "from": t["date"], "price": t["price"],
                    "how": "auction" if sale else ("free" if not t["price"] else "private"), "sale_id": (sale or {}).get("sale_id"), "sale": (sale or {}).get("sale"),
                    "house_id": (sale or {}).get("house_id"), "house": (sale or {}).get("house")})
    for i, o in enumerate(out):
        o["to"] = out[i + 1]["from"] if i + 1 < len(out) else None
        o["sold_for"] = out[i + 1]["price"] if i + 1 < len(out) else None
    out[-1]["now"] = not h.get("horse_deceased_date")
    return out


def api_horse(con, hid):
    h = one(con, "select * from horses where horse_horse_id=?", (hid,))
    if not h:
        return None
    h = clean_blob(h)
    out = {"horse": h, "removed": removed_info(con, "horses", hid)}
    out["stable"] = one(con, "select stable_stable_id as id, stable_name as name, stable_owner_id as owner_id from stables where stable_stable_id=?", (h.get("horse_stable_id"),))
    out["dam"] = one(con, "select horse_horse_id as id, horse_name as name, horse_breeding_parent_mare_id as dam_id, horse_breeding_parent_stallion_id as sire_id from horses where horse_horse_id=?", (h.get("horse_breeding_parent_mare_id"),))
    out["sire"] = one(con, "select horse_horse_id as id, horse_name as name, horse_breeding_parent_mare_id as dam_id, horse_breeding_parent_stallion_id as sire_id from horses where horse_horse_id=?", (h.get("horse_breeding_parent_stallion_id"),))
    gp = {}
    for side in ("sire", "dam"):
        p = out[side]
        if p:
            gp[side] = {
                "sire": one(con, "select horse_horse_id as id, horse_name as name from horses where horse_horse_id=?", (p["sire_id"],)),
                "dam": one(con, "select horse_horse_id as id, horse_name as name from horses where horse_horse_id=?", (p["dam_id"],)),
            }
    out["grandparents"] = gp
    # 16.7.16: three generations for the Overview's pedigree, with a few facts about the family
    tree, frontier = {}, {"": {"sire_id": h.get("horse_breeding_parent_stallion_id"), "dam_id": h.get("horse_breeding_parent_mare_id")}}
    for g in range(3):
        want = {}
        for path, x in frontier.items():
            if x:
                want[path + "s"], want[path + "d"] = x.get("sire_id"), x.get("dam_id")
        info = horse_brief(con, list(want.values()))
        frontier = {pth: info.get(i) for pth, i in want.items()}
        tree.update(frontier)
    sid, did = h.get("horse_breeding_parent_stallion_id"), h.get("horse_breeding_parent_mare_id")
    cnt = lambda where, args: (one(con, "select count(*) as n from horses where " + where, args) or {}).get("n") or 0
    seen = {}
    for pth, x in tree.items():
        if x:
            seen.setdefault(x["id"], {"id": x["id"], "name": x["name"], "gens": []})["gens"].append(len(pth))
    out["ped3"] = {"tree": tree, "repeats": [v for v in seen.values() if len(v["gens"]) > 1],
                   "sire_foals": cnt("horse_breeding_parent_stallion_id=?", (sid,)) if realid(sid) else 0,
                   "dam_foals": cnt("horse_breeding_parent_mare_id=?", (did,)) if realid(did) else 0,
                   "full_sibs": cnt("horse_breeding_parent_stallion_id=? and horse_breeding_parent_mare_id=? and horse_horse_id<>?", (sid, did, hid)) if realid(sid) and realid(did) else 0}
    staff_ids = {k: h.get(k) for k in ("horse_manager_id", "horse_head_trainer_id", "horse_trainer_id", "horse_prefered_jockey_id", "horse_caretaker_id")}
    names = name_map(con, "persons", "person_person_id", "person_full_name", [v for v in staff_ids.values() if v])
    out["people"] = {k: {"id": v, "name": names.get(v)} for k, v in staff_ids.items() if v and v in names}

    results = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_time as time,
        r.race_result_cash_received as prize, r.race_result_win_odds as odds, r.race_result_rating as rating,
        r.race_result_person_jockey_id as jockey_id, r.race_result_stable_id as stable_id, r.race_result_race_id as race_id,
        r.race_result_trainer_id as trainer_id, r.race_result_gear as gear, r.race_result_starting_position as gate,
        x.races_race_name as race_name, x.races_distance as distance, x.races_type_of_race as race_type, x.races_track as track,
        c.racecourse_name as course, c.racecourse_racecourse_id as course_id, d.raceday_weather_condition as weather,
        (select count(*) from race_results rr where rr.race_result_race_id=r.race_result_race_id and r.race_result_race_id>0) as runners
        from race_results r left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where r.race_result_horse_id=? order by r.race_result_date desc""", (hid,))
    jn = name_map(con, "persons", "person_person_id", "person_full_name", [r["jockey_id"] for r in results] + [r["trainer_id"] for r in results])
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in results])
    for r in results:
        r["jockey"] = jn.get(r["jockey_id"])
        r["trainer"] = jn.get(r["trainer_id"])
        r["stable"] = sn.get(r["stable_id"])
    out["results"] = results

    out["entries"] = rows(con, """select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
        p.race_participant_person_jockey_id as jockey_id, j.person_full_name as jockey
        from race_participants p join races x on x.races_race_id=p.race_participant_race_id
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        left join persons j on j.person_person_id=p.race_participant_person_jockey_id
        where p.race_participant_horse_id=? and x.races_race_date_time>? order by x.races_race_date_time""" % RACE_COLS,
                          (hid, META.get("game_date") or 0)) if has_table(con, "race_participants") else []

    out["offspring"] = rows(con, """select horse_horse_id as id, horse_name as name, horse_gender as gender, horse_birth_date as birth,
        horse_deceased_date as died, horse_career_earnings as earnings, horse_g1_wins as g1,
        case when horse_breeding_parent_mare_id=? then horse_breeding_parent_stallion_id else horse_breeding_parent_mare_id end as mate_id
        from horses where horse_breeding_parent_mare_id=? or horse_breeding_parent_stallion_id=?
        order by horse_career_earnings desc limit 300""", (hid, hid, hid))
    mn = name_map(con, "horses", "horse_horse_id", "horse_name", [r["mate_id"] for r in out["offspring"]])
    for r in out["offspring"]:
        r["mate_name"] = mn.get(r["mate_id"])
    out["offspring_total"] = con.execute("select count(*) from horses where horse_breeding_parent_mare_id=? or horse_breeding_parent_stallion_id=?", (hid, hid)).fetchone()[0]

    if has_table(con, "horse_stats_snapshots"):
        out["stats"] = rows(con, """select snapshot_date as date, snapshot_speed as speed, snapshot_stamina as stamina,
            snapshot_acceleration as acceleration, snapshot_strength as strength, snapshot_intelligence as intelligence,
            snapshot_condition as condition from horse_stats_snapshots where snapshot_horse_id=? order by snapshot_date""", (hid,))
    if has_table(con, "horse_valuation_history"):
        out["valuation"] = rows(con, "select valuation_history_date as date, valuation_history_value as value from horse_valuation_history where valuation_history_horse_id=? order by valuation_history_date", (hid,))
    if has_table(con, "illness_injury_history"):
        # 16.7.11: with the details the Health tab shows (treatment, recovery, complications, what it does to racing)
        hc_, ic_ = set(columns(con, "illness_injury_history")), set(columns(con, "injury_illness")) if has_table(con, "injury_illness") else set()
        hx = lambda c, a_: ("h.%s as %s" % (c, a_)) if c in hc_ else "null as %s" % a_
        ix = lambda c, a_: ("i.%s as %s" % (c, a_)) if c in ic_ else "null as %s" % a_
        out["health"] = rows(con, """select h.illness_injury_history_start_date as start, h.illness_injury_history_end_date as end,
            i.injury_illness_name as name, i.injury_illness_type as type, i.injury_illness_severity as severity, %s
            from illness_injury_history h left join injury_illness i on i.injury_illness_id=h.illness_injury_history_injury_illness_id
            where h.illness_injury_entity_id=? and h.illness_injury_entity_type='horse' order by h.illness_injury_history_start_date desc""" % ", ".join([
            hx("illness_injury_history_treatment_plan", "treatment"), hx("illness_injury_history_treatment_started_date", "treated"),
            hx("illness_injury_history_complications_count", "complications"), hx("illness_injury_history_start_points", "start_points"),
            hx("illness_injury_history_current_points", "points"), hx("illness_injury_history_contagious", "contagious"),
            hx("illness_injury_history_restriction", "restriction"), hx("illness_injury_history_disaster_event_id", "disaster_id"),
            ix("injury_illness_description", "about"), ix("injury_illness_recovery_time", "recovery_days"), ix("injury_illness_race_impact", "race_impact"),
            ix("injury_illness_chronic", "chronic"), ix("injury_illness_can_be_fatal", "fatal_chance")]), (hid,))
    out["traits"] = entity_traits(con, hid, "horse")
    out["owners"] = horse_owners(con, h)
    out["events"] = entity_events(con, hid, "horse")
    awards = rows(con, """select award_category as category, award_year as year, award_date as date, award_rank as rank, award_value as value,
        award_description as description, award_race_id as race_id
        from awards where award_entity_id=? and award_entity_type='horse'""", (hid,)) if has_table(con, "awards") else []
    have = {a["race_id"] for a in awards if a.get("race_id")}
    for w in rows(con, """select r.race_result_date as date, r.race_result_cash_received as value, x.races_race_name as description,
            x.races_race_id as race_id, x.races_type_of_race as race_type
            from race_results r join races x on x.races_race_id=r.race_result_race_id
            where r.race_result_horse_id=? and r.race_result_rank=1 and x.races_type_of_race in ('G1','G2','G3','listed')""", (hid,)):
        if w["race_id"] in have:
            continue
        cat = {"G1": "g1_race", "G2": "g2_race", "G3": "g3_race", "listed": "listed_race"}[w["race_type"]]
        yr = (datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=w["date"])).year if w["date"] is not None else None
        awards.append({"category": cat, "year": yr, "date": w["date"], "rank": None, "value": w["value"], "description": w["description"], "race_id": w["race_id"]})
    awards.sort(key=lambda a: (a.get("date") or 0), reverse=True)
    out["awards"] = awards
    out["track_records"] = horse_track_records(con, hid)
    out["section_records"] = rows(con, """select t.course_id, c.racecourse_name as course, t.track, t.distance, t.sec, t.time, t.date, t.race_id,
        x.races_race_name as race_name, t.runs
        from hrmv_section_records t left join racecourses c on c.racecourse_racecourse_id=t.course_id left join races x on x.races_race_id=t.race_id
        where t.horse_id=? order by t.date desc, c.racecourse_name, t.distance, t.sec""", (hid,)) if has_table(con, "hrmv_section_records") else []
    return out


def horse_track_records(con, hid):
    """Every course record this horse set: whether it still stands, and if not who broke it and when."""
    if not has_table(con, "hrmv_track_records"):
        return []
    mine = rows(con, """select t.course_id, c.racecourse_name as course, t.track, t.distance, t.date, t.time, t.prev_best, t.race_id, t.rid,
        x.races_race_name as race_name, x.races_type_of_race as race_type, t.jockey_id, p.person_full_name as jockey
        from hrmv_track_records t left join racecourses c on c.racecourse_racecourse_id=t.course_id
        left join races x on x.races_race_id=t.race_id left join persons p on p.person_person_id=t.jockey_id
        where t.horse_id=? order by t.date desc""", (hid,))
    for r in mine:
        nxt = one(con, """select t.date, t.time, t.horse_id, h.horse_name as horse, t.race_id from hrmv_track_records t
            left join horses h on h.horse_horse_id=t.horse_id
            where t.course_id=? and t.track is ? and t.distance=? and (t.date > ? or (t.date = ? and t.rid > ?)) order by t.date, t.rid limit 1""",
                  (r["course_id"], r["track"], r["distance"], r["date"], r["date"], r["rid"]))
        r["current"] = nxt is None
        r["broken_by"] = nxt
        cur = one(con, """select t.time, t.horse_id, h.horse_name as horse, t.date from hrmv_track_records t left join horses h on h.horse_horse_id=t.horse_id
            where t.course_id=? and t.track is ? and t.distance=? order by t.time limit 1""", (r["course_id"], r["track"], r["distance"])) if nxt else None
        r["record_now"] = cur
        r.pop("rid", None)
    return mine


def removed_info(con, tbl, pk):
    """If the game has since removed this record, when it was last seen (it's kept from an earlier load)."""
    if not has_table(con, "hrmv_removed"):
        return None
    return one(con, "select last_seen from hrmv_removed where tbl=? and pk=?", (tbl, pk))


def entity_traits(con, eid, etype):
    if not (has_table(con, "entity_traits") and has_table(con, "trait_definitions")):
        return []
    return rows(con, """select t.trait_display_name as name, t.trait_description as description, t.trait_is_positive as positive,
        e.acquired_date as acquired, e.revealed_date as revealed
        from entity_traits e join trait_definitions t on t.trait_id=e.trait_id
        where e.entity_id=? and e.entity_type=?""", (eid, etype))


def entity_events(con, eid, etype, limit=60):
    if not has_table(con, "story_events"):
        return []
    return rows(con, """select * from (
        select event_timestamp as date, event_type as type, event_outcome as text from story_events
        where event_primary_actor_id=? and event_primary_actor_type=? and event_outcome like '%% %%'
        union all
        select event_timestamp as date, event_type as type, event_outcome as text from story_events
        where event_secondary_actor_id=? and event_secondary_actor_type=? and event_outcome like '%% %%')
        order by date desc limit %d""" % limit, (eid, etype, eid, etype))


RACE_SORTS = {"date": "x.races_race_date_time", "purse": "x.races_prize_money_total", "name": "x.races_race_name", "distance": "x.races_distance"}


def api_races(con, q):
    gd = META.get("game_date") or time.time()
    where, params = [], []
    when = q.get("when") or "past"
    if when == "past":
        where.append("x.races_race_date_time<=?")
        params.append(gd)
    elif when == "upcoming":
        where.append("x.races_race_date_time>?")
        params.append(gd)
    if q.get("q"):
        where.append("x.races_race_name like ?")
        params.append("%" + q["q"] + "%")
    if q.get("type"):
        where.append("x.races_type_of_race=?")
        params.append(q["type"])
    if q.get("course"):
        where.append("d.raceday_racecourse_id=?")
        params.append(to_int(q["course"]))
    sort, d = sort_args(q, RACE_SORTS, "date")
    if not q.get("sort") and when == "upcoming":
        d = "asc"
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    base = """from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id"""
    total = count_rows(con, "select count(*) " + base + w, params)
    data = rows(con, "select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id, d.raceday_weather_condition as weather, "
                     "(select r.race_result_horse_id from race_results r where r.race_result_race_id=x.races_race_id and r.race_result_rank=1 limit 1) as winner_id "
                % RACE_COLS + base + w + " order by %s %s limit %d offset %d" % (sort, d, page_size(), off), params)
    wn = name_map(con, "horses", "horse_horse_id", "horse_name", [r["winner_id"] for r in data])
    for r in data:
        r["winner_name"] = wn.get(r["winner_id"])
    race_list_extras(con, data)
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


def race_list_extras(con, data):
    """Field size, and the winner's jockey, stable and time, for a page of races (16.7.9)."""
    ids = [r["race_id"] for r in data if r.get("race_id")]
    if not ids:
        return
    mk = ",".join("?" * len(ids))
    ran = dict(con.execute("select race_result_race_id, count(*) from race_results where race_result_race_id in (%s) group by 1" % mk, ids).fetchall())
    entered = dict(con.execute("select race_participant_race_id, count(*) from race_participants where race_participant_race_id in (%s) group by 1" % mk, ids).fetchall()) \
        if has_table(con, "race_participants") else {}
    win = {r[0]: r[1:] for r in con.execute("""select race_result_race_id, race_result_person_jockey_id, race_result_stable_id, race_result_time
        from race_results where race_result_race_id in (%s) and race_result_rank=1""" % mk, ids)}
    jn = name_map(con, "persons", "person_person_id", "person_full_name", [w[0] for w in win.values()])
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [w[1] for w in win.values()])
    for r in data:
        r["runners"] = ran.get(r["race_id"]) or entered.get(r["race_id"]) or None
        w = win.get(r["race_id"])
        if w:
            r["winner_jockey_id"], r["winner_stable_id"], r["winner_time"] = w
            r["winner_jockey"], r["winner_stable"] = jn.get(w[0]), sn.get(w[1])


def race_sectionals(con, rid):
    if not has_table(con, "hrmv_sectionals"):
        return []
    return rows(con, """select s.*, h.horse_name as horse, r.race_result_rank as rank, r.race_result_starting_position as gate
        from hrmv_sectionals s left join horses h on h.horse_horse_id=s.horse_id
        left join race_results r on r.race_result_race_id=s.race_id and r.race_result_horse_id=s.horse_id
        where s.race_id=? order by coalesce(r.race_result_rank, s.r5)""", (rid,))


def api_race(con, rid):
    race = one(con, "select * from races where races_race_id=?", (rid,))
    if not race:
        return None
    out = {"race": clean_blob(race)}
    out["day"] = one(con, "select * from race_days where raceday_race_day_id=?", (race["races_race_day_id"],))
    if out["day"]:
        out["course"] = one(con, "select racecourse_racecourse_id as id, racecourse_name as name, racecourse_location_country as country, racecourse_location_city as city from racecourses where racecourse_racecourse_id=?", (out["day"]["raceday_racecourse_id"],))
        out["card"] = rows(con, "select races_race_id as id, races_race_name as name, races_race_number as number, races_race_date_time as time, races_type_of_race as race_type, races_distance as distance from races where races_race_day_id=? order by races_race_date_time, races_race_number", (race["races_race_day_id"],))
    res = rows(con, """select r.race_result_rank as rank, r.race_result_time as time, r.race_result_cash_received as prize,
        r.race_result_win_odds as odds, r.race_result_starting_position as gate, r.race_result_rating as rating,
        r.race_result_running_style as style, r.race_result_gear as gear, r.race_result_note as note,
        r.race_result_rating_before as rating_before,
        r.race_result_horse_id as horse_id, h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth,
        h.horse_color as color, r.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey,
        r.race_result_trainer_id as trainer_id, t.person_full_name as trainer,
        r.race_result_stable_id as stable_id, s.stable_name as stable
        from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
        left join persons j on j.person_person_id=r.race_result_person_jockey_id
        left join persons t on t.person_person_id=r.race_result_trainer_id
        left join stables s on s.stable_stable_id=r.race_result_stable_id
        where r.race_result_race_id=? order by r.race_result_rank""", (rid,))
    add_prerace_form(con, res, race["races_race_date_time"])
    out["results"] = res
    out["sectionals"] = race_sectionals(con, rid)
    if out.get("day"):
        col = SURFACE_COL.get(race.get("races_track"))
        if col and col in columns(con, "racecourses"):
            sv = con.execute("select %s from racecourses where racecourse_racecourse_id=?" % col, (out["day"]["raceday_racecourse_id"],)).fetchone()
            out["surface"] = sv[0] if sv and sv[0] else None
    if not res and has_table(con, "race_participants"):
        out["entries"] = rows(con, """select p.race_participant_starting_position as gate, p.race_participant_handicap as handicap,
            p.race_participant_horse_id as horse_id, h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth,
            h.horse_international_rating as rating, h.horse_form as form, h.horse_career_earnings as earnings,
            h.horse_color as color, p.race_participant_person_jockey_id as jockey_id, j.person_full_name as jockey,
            h.horse_trainer_id as trainer_id, t.person_full_name as trainer,
            p.race_participant_stable_id as stable_id, s.stable_name as stable
            from race_participants p left join horses h on h.horse_horse_id=p.race_participant_horse_id
            left join persons j on j.person_person_id=p.race_participant_person_jockey_id
            left join persons t on t.person_person_id=h.horse_trainer_id
            left join stables s on s.stable_stable_id=p.race_participant_stable_id
            where p.race_participant_race_id=? order by p.race_participant_starting_position""", (rid,))
        add_prerace_form(con, out["entries"], race["races_race_date_time"])
    # Other runnings of the same race. Many names are used at several courses (two different "January Cup"s),
    # so match on the game's calendar id when it has one, otherwise on name + course + race type.
    cal = race.get("races_calendar_id")
    if cal:
        match, params = "x.races_calendar_id=?", [cal]
    else:
        match = "x.races_race_name=? and d.raceday_racecourse_id=? and coalesce(x.races_type_of_race,'')=coalesce(?,'')"
        params = [race["races_race_name"], out["day"]["raceday_racecourse_id"] if out.get("day") else None, race.get("races_type_of_race")]
    out["history"] = rows(con, """select x.races_race_id as race_id, x.races_race_date_time as date, x.races_distance as distance,
        x.races_type_of_race as race_type, w.race_result_horse_id as winner_id, h.horse_name as winner,
        w.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey, w.race_result_stable_id as stable_id,
        s.stable_name as stable, w.race_result_time as time, w.race_result_cash_received as prize
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join race_results w on w.race_result_race_id=x.races_race_id and w.race_result_rank=1
        left join horses h on h.horse_horse_id=w.race_result_horse_id
        left join persons j on j.person_person_id=w.race_result_person_jockey_id
        left join stables s on s.stable_stable_id=w.race_result_stable_id
        where %s and x.races_race_id<>? order by x.races_race_date_time desc limit 60""" % match, params + [rid])
    return out


STABLE_SORTS = {"prestige": "s.stable_prestige", "name": "s.stable_name", "founded": "s.stable_founded_date", "horses": "horses",
                "starts": "t.starts", "wins": "t.wins", "seconds": "t.seconds", "thirds": "t.thirds", "g1": "t.g1", "g2": "t.g2",
                "g3": "t.g3", "listed": "t.listed", "prize": "t.prize", "winpct": "(case when t.starts>0 then 1.0*t.wins/t.starts end)"}


def api_stables(con, q):
    where, params = [], []
    if q.get("q"):
        where.append("s.stable_name like ?")
        params.append("%" + q["q"] + "%")
    if (q.get("status") or "active") == "active":
        where.append("s.stable_liquidated is null and s.stable_stable_id not in (select pk from hrmv_removed where tbl='stables')")
    elif q.get("status") == "closed":
        where.append("(s.stable_liquidated is not null or s.stable_stable_id in (select pk from hrmv_removed where tbl='stables'))")
    sort, d = sort_args(q, STABLE_SORTS, "prestige")
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    total = count_rows(con, "select count(*) from stables s" + w, params)
    data = rows(con, """select s.stable_stable_id as id, s.stable_name as name, s.stable_prestige as prestige, s.stable_founded_date as founded,
        t.starts, t.wins, t.seconds, t.thirds, t.g1, t.g2, t.g3, t.listed, t.prize,
        s.stable_liquidated as liquidated, s.stable_owner_id as owner_id, p.person_full_name as owner, s.stable_level as level,
        (select count(*) from horses h where h.horse_stable_id=s.stable_stable_id and h.horse_deceased_date is null and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')) as horses
        from stables s left join persons p on p.person_person_id=s.stable_owner_id
        left join hrmv_stable_stats t on t.stable_id=s.stable_stable_id""" + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


# ------------------------------------------------------------------ 16.5: training, shoes, plans, rankings, syndicates, facilities, sponsors, languages
def _t(con, t):
    return has_table(con, t)


def api_horse_trials(con, hid):
    """A horse's timing trials (16.7.11): each run with its course, track, distance, time, jockey and condition, and how it
    went against the other horses timed at the same course, track and distance that day ("place" of "field", the fastest time)."""
    if not has_table(con, "timing_trials"):
        return {"trials": []}
    tc = set(columns(con, "timing_trials"))
    col = lambda c, a: ("t.%s as %s" % (c, a)) if c in tc else "null as %s" % a
    courses = has_table(con, "racecourses")
    trials = rows(con, """select %s from timing_trials t%s%s where t.tt_horse_id=? order by t.tt_date desc, t.tt_distance""" % (
        ", ".join([col("tt_id", "id"), col("tt_date", "date"), col("tt_distance", "distance"), col("tt_time_result", "time"),
                   col("tt_track", "track"), col("tt_surface", "surface"), col("tt_racecourse_id", "course_id"),
                   col("tt_person_jockey_id", "jockey_id"), col("tt_condition_at_trial", "condition"), col("tt_condition_used", "cond_used"),
                   col("tt_speed_revealed", "speed_revealed"), col("tt_stamina_revealed", "stamina_revealed"), col("tt_harness", "harness")] +
                  (["c.racecourse_name as course"] if courses else ["null as course"]) + ["p.person_full_name as jockey"]),
        " left join racecourses c on c.racecourse_racecourse_id=t.tt_racecourse_id" if courses else "",
        " left join persons p on p.person_person_id=t.tt_person_jockey_id"), (hid,))
    # the rest of each session: everyone timed at the same course and distance on the same day
    dates = sorted({t["date"] for t in trials if t["date"] is not None})
    field = {}
    if dates:
        trk = "tt_track" if "tt_track" in tc else "null"
        for d, c, tk, dist, tm in con.execute("select tt_date, tt_racecourse_id, %s, tt_distance, tt_time_result from timing_trials where tt_date in (%s) and tt_time_result > 0"
                                              % (trk, ",".join("?" * len(dates))), dates):
            field.setdefault((d, c, tk, dist), []).append(tm)
    for t in trials:
        times = sorted(field.get((t["date"], t["course_id"], t["track"], t["distance"]), []))
        t["field"] = len(times)
        t["best"] = times[0] if times else None
        t["place"] = (sum(1 for x in times if x < t["time"]) + 1) if times and t["time"] else None
    return {"trials": trials}


def api_course_trials(con, cid, q):
    """Timing trials held at a racecourse (16.7.11): its sessions (a day on one track), the fastest trial time at each track
    and distance, and every timed run (filtered by session, track, distance or horse) with its place against the others
    timed at that distance that day."""
    out = {"sessions": [], "fastest": [], "rows": [], "dates": [], "tracks": [], "distances": [], "total": 0}
    if not has_table(con, "timing_trials") or not {"tt_racecourse_id", "tt_date", "tt_distance", "tt_time_result"} <= set(columns(con, "timing_trials")):
        return out
    tc = set(columns(con, "timing_trials"))
    col = lambda c, a: ("t.%s as %s" % (c, a)) if c in tc else "null as %s" % a
    allr = rows(con, """select %s, h.horse_name as horse, h.horse_stable_id as stable_id, st.stable_name as stable, p.person_full_name as jockey
        from timing_trials t left join horses h on h.horse_horse_id=t.tt_horse_id left join stables st on st.stable_stable_id=h.horse_stable_id
        left join persons p on p.person_person_id=t.tt_person_jockey_id where t.tt_racecourse_id=? order by t.tt_date desc, t.tt_distance, t.tt_time_result""" % ", ".join([
        col("tt_id", "id"), col("tt_horse_id", "horse_id"), col("tt_date", "date"), col("tt_distance", "distance"), col("tt_time_result", "time"),
        col("tt_track", "track"), col("tt_surface", "surface"), col("tt_person_jockey_id", "jockey_id"), col("tt_condition_at_trial", "condition"),
        col("tt_speed_revealed", "speed_revealed"), col("tt_stamina_revealed", "stamina_revealed")]), (cid,))
    # places against everyone timed on the same track and distance here that day
    field = {}
    for r in allr:
        if r["time"] and r["time"] > 0:
            field.setdefault((r["date"], r["track"], r["distance"]), []).append(r["time"])
    for v in field.values():
        v.sort()
    for r in allr:
        times = field.get((r["date"], r["track"], r["distance"]), [])
        r["field"] = len(times)
        r["best"] = times[0] if times else None
        r["place"] = (sum(1 for x in times if x < r["time"]) + 1) if times and r["time"] else None
    # sessions: one per day and track
    sess = {}
    for r in allr:
        k = (r["date"], r["track"])
        s_ = sess.setdefault(k, {"date": r["date"], "track": r["track"], "surface": r["surface"], "horses": set(), "runs": 0, "distances": set(), "tops": {}})
        s_["horses"].add(r["horse_id"]); s_["runs"] += 1; s_["distances"].add(r["distance"])
        if r["place"] == 1:
            s_["tops"][r["horse_id"]] = s_["tops"].get(r["horse_id"], 0) + 1
    names = {r["horse_id"]: r["horse"] for r in allr}
    for s_ in sorted(sess.values(), key=lambda x: -(x["date"] or 0)):
        top = max(s_["tops"].items(), key=lambda kv: kv[1]) if s_["tops"] else None
        out["sessions"].append({"date": s_["date"], "track": s_["track"], "surface": s_["surface"], "horses": len(s_["horses"]), "runs": s_["runs"],
                                "distances": len(s_["distances"]), "dmin": min(s_["distances"]), "dmax": max(s_["distances"]),
                                "top_id": top[0] if top else None, "top": names.get(top[0]) if top else None, "top_n": top[1] if top else 0})
    # the fastest trial time at each track and distance
    best = {}
    for r in allr:
        k = (r["track"], r["distance"])
        if r["time"] and r["time"] > 0 and (k not in best or r["time"] < best[k]["time"]):
            best[k] = r
    out["fastest"] = [{k: b[k] for k in ("track", "surface", "distance", "time", "horse_id", "horse", "date", "jockey_id", "jockey", "stable_id", "stable")}
                      for _, b in sorted(best.items(), key=lambda kv: (kv[0][0] or "", kv[0][1] or 0))]
    out["dates"] = sorted({r["date"] for r in allr if r["date"] is not None}, reverse=True)
    out["tracks"] = sorted({r["track"] for r in allr if r["track"]})
    out["distances"] = sorted({r["distance"] for r in allr if r["distance"]})
    # the filtered list of every run
    data = allr
    if q.get("date"):
        data = [r for r in data if str(int(r["date"] or 0)) == str(q["date"])]
    if q.get("track"):
        data = [r for r in data if r["track"] == q["track"]]
    if to_int(q.get("distance")):
        data = [r for r in data if r["distance"] == to_int(q["distance"])]
    if q.get("q"):
        t = q["q"].strip().lower()
        data = [r for r in data if t in (r["horse"] or "").lower() or t in (r["stable"] or "").lower() or t in (r["jockey"] or "").lower()]
    out["total"] = len(data)
    out["rows"] = data[:3000]
    return out


# --------------------------------------------------------------------------- 16.7.15: auctions, share offerings, lifestyle assets

def _city_names(con, ids):
    """{city id: (city, country)}"""
    ids = [int(i) for i in set(ids) if i]
    if not ids or not has_table(con, "cities"):
        return {}
    out = {}
    for cid, city, country in con.execute("""select c.city_id, c.city_name, n.country_name from cities c left join countries n on n.country_id=c.city_country_id
            where c.city_id in (%s)""" % ",".join(str(i) for i in ids)):
        out[cid] = (city, country)
    return out


def auction_sale_stats(con, shell_ids=None):
    """{sale id: {entries, sold, total, top, commission}} from the results (and the entries of sales still to come)."""
    out = {}
    if has_table(con, "auction_results"):
        w = (" where auction_result_shell_id in (%s)" % ",".join(str(int(i)) for i in shell_ids)) if shell_ids else ""
        for sid, n, sold, tot, top, cut in con.execute("""select auction_result_shell_id, count(*), sum(auction_result_accepted in (1,'1','true')),
                sum(case when auction_result_accepted in (1,'1','true') then auction_result_final_price else 0 end),
                max(case when auction_result_accepted in (1,'1','true') then auction_result_final_price end), sum(coalesce(auction_result_cut_to_auctionhouse,0))
                from auction_results%s group by 1""" % w):
            out[sid] = {"entries": n, "sold": sold or 0, "total": tot or 0, "top": top, "commission": cut or 0}
    if has_table(con, "auction_participants"):
        w = (" where auction_participant_shell_id in (%s)" % ",".join(str(int(i)) for i in shell_ids)) if shell_ids else ""
        for sid, n in con.execute("select auction_participant_shell_id, count(*) from auction_participants%s group by 1" % w):
            out.setdefault(sid, {"sold": 0, "total": 0, "top": None, "commission": 0})["entries"] = max(n, (out.get(sid) or {}).get("entries") or 0)
    return out


AUCTION_SORTS = {"date": "a.auction_shell_date", "name": "a.auction_shell_name", "house": "h.auction_house_name", "type": "a.auction_shell_horse_type",
                 "entry": "a.auction_shell_entry_cost", "commission": "a.auction_shell_percentage_of_sale"}


def api_auctions(con, q):
    """Racing → Auctions: every sale, coming up or held (filter by type, house or name)."""
    if not has_table(con, "auction_shell"):
        return {"total": 0, "page": 1, "page_size": page_size(), "rows": [], "types": []}
    gd = META.get("game_date") or time.time()
    when = q.get("when") or "upcoming"
    where, params = [], []
    if when == "upcoming":
        where.append("a.auction_shell_date >= ?"); params.append(gd)
    elif when == "past":
        where.append("a.auction_shell_date < ?"); params.append(gd)
    if q.get("type"):
        where.append("a.auction_shell_horse_type = ?"); params.append(q["type"])
    if q.get("house"):
        where.append("a.auction_shell_house_id = ?"); params.append(to_int(q["house"]))
    if q.get("q"):
        where.append("(a.auction_shell_name like ? or h.auction_house_name like ?)"); params += ["%" + q["q"] + "%"] * 2
    w = (" where " + " and ".join(where)) if where else ""
    base = " from auction_shell a left join auction_house h on h.auction_house_id=a.auction_shell_house_id"
    sort, d = sort_args(dict(q, sort=q.get("sort") or "date", dir=q.get("dir") or ("asc" if when == "upcoming" else "desc")), AUCTION_SORTS, "date")
    page, off = page_args(q)
    total = count_rows(con, "select count(*)" + base + w, params)
    data = rows(con, """select a.auction_shell_id as id, a.auction_shell_name as name, a.auction_shell_date as date, a.auction_shell_horse_type as type,
        a.auction_shell_entry_cost as entry, a.auction_shell_percentage_of_sale as commission, a.auction_shell_gender_restriction as sex,
        a.auction_shell_breed_restriction as breed, a.auction_shell_min_birth_date as born_from, a.auction_shell_max_birth_date as born_to,
        h.auction_house_id as house_id, h.auction_house_name as house, h.auction_house_city_id as city_id, h.auction_house_owner_id as owner_id,
        h.auction_house_commission_rate as house_commission""" + base + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    st = auction_sale_stats(con, [r["id"] for r in data])
    cities = _city_names(con, [r["city_id"] for r in data])
    for r in data:
        r.update(st.get(r["id"]) or {"entries": 0, "sold": 0, "total": 0, "top": None})
        r["city"], r["country"] = cities.get(r["city_id"], (None, None))
    types = [x[0] for x in con.execute("select distinct auction_shell_horse_type from auction_shell where auction_shell_horse_type is not null order by 1")]
    return {"total": total, "page": page, "page_size": page_size(), "rows": data, "types": types}


def api_auction(con, aid):
    """One sale: its details, the horses entered, and (once held) what each sold for and to whom."""
    a = one(con, """select a.auction_shell_id as id, a.auction_shell_name as name, a.auction_shell_date as date, a.auction_shell_horse_type as type,
        a.auction_shell_entry_cost as entry, a.auction_shell_percentage_of_sale as commission, a.auction_shell_gender_restriction as sex,
        a.auction_shell_breed_restriction as breed, a.auction_shell_min_birth_date as born_from, a.auction_shell_max_birth_date as born_to,
        h.auction_house_id as house_id, h.auction_house_name as house, h.auction_house_city_id as city_id, h.auction_house_owner_id as owner_id,
        h.auction_house_prestige as prestige, h.auction_house_commission_rate as house_commission, s.stable_name as owner from auction_shell a left join auction_house h on h.auction_house_id=a.auction_shell_house_id
        left join stables s on s.stable_stable_id=h.auction_house_owner_id where a.auction_shell_id=?""", (aid,)) if has_table(con, "auction_shell") else None
    if not a:
        return None
    a["city"], a["country"] = _city_names(con, [a["city_id"]]).get(a["city_id"], (None, None))
    hsel = """h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth, h.horse_international_rating as rating,
        h.horse_career_earnings as earnings, h.horse_value_calculated as value, h.horse_breeding_parent_stallion_id as sire_id, sp.horse_name as sire,
        h.horse_breeding_parent_mare_id as dam_id, dp.horse_name as dam"""
    hjoin = """left join horses h on h.horse_horse_id=%s left join horses sp on sp.horse_horse_id=h.horse_breeding_parent_stallion_id
        left join horses dp on dp.horse_horse_id=h.horse_breeding_parent_mare_id"""
    entries = rows(con, """select p.auction_participant_horse_id as horse_id, p.auction_participant_starting_price as start, p.auction_participant_reserve_price as reserve,
        p.auction_participant_buyout_price as buyout, p.auction_participant_autobid_enabled as autobid, p.auction_participant_autobid_max_amount as autobid_max,
        p.auction_participant_autobid_stable_id as autobid_stable_id, ab.stable_name as autobid_stable, h.horse_stable_id as stable_id, st.stable_name as stable, """ + hsel + """
        from auction_participants p """ + (hjoin % "p.auction_participant_horse_id") + """ left join stables st on st.stable_stable_id=h.horse_stable_id
        left join stables ab on ab.stable_stable_id=p.auction_participant_autobid_stable_id
        where p.auction_participant_shell_id=? order by p.auction_participant_starting_price desc""", (aid,)) if has_table(con, "auction_participants") else []
    results = rows(con, """select r.auction_result_horse_id as horse_id, r.auction_result_final_price as price, r.auction_result_accepted as sold,
        r.auction_result_buyout_price as buyout, r.auction_result_cut_to_auctionhouse as cut, r.auction_result_date as date,
        r.auction_result_from_stable_id as from_id, fs.stable_name as seller, r.auction_result_to_stable_id as to_id, ts.stable_name as buyer, """ + hsel + """
        from auction_results r """ + (hjoin % "r.auction_result_horse_id") + """ left join stables fs on fs.stable_stable_id=r.auction_result_from_stable_id
        left join stables ts on ts.stable_stable_id=r.auction_result_to_stable_id where r.auction_result_shell_id=? order by r.auction_result_final_price desc""", (aid,)) \
        if has_table(con, "auction_results") else []
    for r in results:
        r["sold"] = r["sold"] in (1, "1", "true", True)
    return {"auction": a, "entries": entries, "results": results}


AUCTION_HOUSE_SORTS = {"name": "h.auction_house_name", "prestige": "h.auction_house_prestige", "fame": "h.auction_house_fame",
                       "commission": "h.auction_house_commission_rate", "capacity": "h.auction_house_capacity", "condition": "h.auction_house_condition",
                       "founded": "h.auction_house_founding_date", "owner": "s.stable_name", "turnover": "t.total", "sold": "t.sold", "price": "h.auction_house_asking_price"}


def api_auction_houses(con, q):
    """Racing → Auctions → Auction houses."""
    if not has_table(con, "auction_house"):
        return {"total": 0, "page": 1, "page_size": page_size(), "rows": []}
    where, params = ["coalesce(h.auction_house_demolished_date, 0) = 0"], []
    if q.get("q"):
        where.append("(h.auction_house_name like ? or s.stable_name like ?)"); params += ["%" + q["q"] + "%"] * 2
    if q.get("forsale") == "1":
        where.append("h.auction_house_for_sale = 1")
    if q.get("owner"):
        where.append("h.auction_house_owner_id = ?"); params.append(to_int(q["owner"]))
    w = " where " + " and ".join(where)
    tot = ("""left join (select auction_result_auctionhouse_id as hid, count(*) as sold, sum(auction_result_final_price) as total, sum(coalesce(auction_result_cut_to_auctionhouse,0)) as cut
        from auction_results where auction_result_accepted in (1,'1','true') group by 1) t on t.hid=h.auction_house_id""" if has_table(con, "auction_results")
           else "left join (select null as hid, null as sold, null as total, null as cut) t on 0")
    base = " from auction_house h left join stables s on s.stable_stable_id=h.auction_house_owner_id " + tot
    sort, d = sort_args(q, AUCTION_HOUSE_SORTS, "turnover")
    page, off = page_args(q)
    total = count_rows(con, "select count(*) from auction_house h left join stables s on s.stable_stable_id=h.auction_house_owner_id" + w, params)
    data = rows(con, """select h.auction_house_id as id, h.auction_house_name as name, h.auction_house_owner_id as owner_id, s.stable_name as owner,
        h.auction_house_city_id as city_id, h.auction_house_prestige as prestige, h.auction_house_fame as fame, h.auction_house_commission_rate as commission,
        h.auction_house_capacity as capacity, h.auction_house_condition as condition, h.auction_house_founding_date as founded, h.auction_house_for_sale as for_sale,
        h.auction_house_asking_price as price, h.auction_house_licence_tier as licence, t.sold as sold, t.total as turnover, t.cut as cut""" + base + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    cities = _city_names(con, [r["city_id"] for r in data])
    for r in data:
        r["city"], r["country"] = cities.get(r["city_id"], (None, None))
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


def api_auction_house(con, hid):
    """One auction house: who owns it, how it's run, its upgrades, its sales coming up and held, and its best sales."""
    h = one(con, """select h.*, s.stable_name as owner from auction_house h left join stables s on s.stable_stable_id=h.auction_house_owner_id
        where h.auction_house_id=?""", (hid,)) if has_table(con, "auction_house") else None
    if not h:
        return None
    gd = META.get("game_date") or time.time()
    out = {"house": h}
    out["city"], out["country"] = _city_names(con, [h.get("auction_house_city_id")]).get(h.get("auction_house_city_id"), (None, None))
    out["upgrades"] = rows(con, "select ahu_upgrade_key as key, ahu_active as active, ahu_activated_date as date from auction_house_upgrades where ahu_auction_house_id=? order by ahu_activated_date",
                           (hid,)) if has_table(con, "auction_house_upgrades") else []
    out["cash"] = (one(con, "select account_balance as v from accounts where account_owner_type='auction_house' and account_owner_id=? and account_type='cash'", (hid,)) or {}).get("v") \
        if has_table(con, "accounts") else None
    sales = rows(con, """select auction_shell_id as id, auction_shell_name as name, auction_shell_date as date, auction_shell_horse_type as type,
        auction_shell_entry_cost as entry, auction_shell_percentage_of_sale as commission from auction_shell where auction_shell_house_id=? order by auction_shell_date""", (hid,)) \
        if has_table(con, "auction_shell") else []
    st = auction_sale_stats(con, [x["id"] for x in sales]) if sales else {}
    for x in sales:
        x.update(st.get(x["id"]) or {"entries": 0, "sold": 0, "total": 0, "top": None, "commission_paid": 0})
    out["upcoming"] = [x for x in sales if (x["date"] or 0) >= gd]
    out["past"] = sorted([x for x in sales if (x["date"] or 0) < gd], key=lambda x: -(x["date"] or 0))
    out["top_sales"] = rows(con, """select r.auction_result_horse_id as horse_id, hh.horse_name as horse, r.auction_result_final_price as price, r.auction_result_date as date,
        r.auction_result_shell_id as sale_id, a.auction_shell_name as sale, r.auction_result_from_stable_id as from_id, fs.stable_name as seller,
        r.auction_result_to_stable_id as to_id, ts.stable_name as buyer from auction_results r left join horses hh on hh.horse_horse_id=r.auction_result_horse_id
        left join auction_shell a on a.auction_shell_id=r.auction_result_shell_id left join stables fs on fs.stable_stable_id=r.auction_result_from_stable_id
        left join stables ts on ts.stable_stable_id=r.auction_result_to_stable_id
        where r.auction_result_auctionhouse_id=? and r.auction_result_accepted in (1,'1','true') order by r.auction_result_final_price desc limit 25""", (hid,)) \
        if has_table(con, "auction_results") else []
    out["years"] = rows(con, """select cast(strftime('%Y', auction_result_date, 'unixepoch') as int) as year, count(*) as sold, sum(auction_result_final_price) as total,
        sum(coalesce(auction_result_cut_to_auctionhouse,0)) as cut from auction_results where auction_result_auctionhouse_id=? and auction_result_accepted in (1,'1','true')
        group by 1 order by 1""", (hid,)) if has_table(con, "auction_results") else []
    return out


def stable_auction_counts(con, sid):
    """How much auction business a stable has: auction houses it owns, and horses it has sold or bought at auction (for its tabs)."""
    n = 0
    if has_table(con, "auction_house"):
        n += con.execute("select count(*) from auction_house where auction_house_owner_id=? and coalesce(auction_house_demolished_date,0)=0", (sid,)).fetchone()[0]
    if has_table(con, "auction_results"):
        n += con.execute("select count(*) from auction_results where auction_result_from_stable_id=? or auction_result_to_stable_id=?", (sid, sid)).fetchone()[0]
    return n


def api_stable_auctions(con, sid):
    """A stable's Auctions tab: the auction houses it owns, its horses entered in sales still to come, and what it has sold and bought at auction."""
    gd = META.get("game_date") or time.time()
    out = {"houses": [], "entries": [], "sold": [], "bought": []}
    if has_table(con, "auction_house"):
        out["houses"] = api_auction_houses(con, {"owner": str(sid), "size": "500"})["rows"]
    if has_table(con, "auction_participants") and has_table(con, "auction_shell"):
        out["entries"] = rows(con, """select p.auction_participant_horse_id as horse_id, h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth,
            p.auction_participant_starting_price as start, p.auction_participant_reserve_price as reserve, p.auction_participant_buyout_price as buyout,
            a.auction_shell_id as sale_id, a.auction_shell_name as sale, a.auction_shell_date as date, ah.auction_house_id as house_id, ah.auction_house_name as house
            from auction_participants p join horses h on h.horse_horse_id=p.auction_participant_horse_id
            join auction_shell a on a.auction_shell_id=p.auction_participant_shell_id left join auction_house ah on ah.auction_house_id=a.auction_shell_house_id
            where h.horse_stable_id=? and a.auction_shell_date >= ? order by a.auction_shell_date""", (sid, gd))
    if has_table(con, "auction_results"):
        q_ = """select r.auction_result_horse_id as horse_id, h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth,
            r.auction_result_final_price as price, r.auction_result_accepted as sold, r.auction_result_date as date, r.auction_result_shell_id as sale_id,
            a.auction_shell_name as sale, ah.auction_house_id as house_id, ah.auction_house_name as house,
            r.auction_result_from_stable_id as from_id, fs.stable_name as seller, r.auction_result_to_stable_id as to_id, ts.stable_name as buyer
            from auction_results r left join horses h on h.horse_horse_id=r.auction_result_horse_id left join auction_shell a on a.auction_shell_id=r.auction_result_shell_id
            left join auction_house ah on ah.auction_house_id=r.auction_result_auctionhouse_id
            left join stables fs on fs.stable_stable_id=r.auction_result_from_stable_id left join stables ts on ts.stable_stable_id=r.auction_result_to_stable_id
            where %s order by r.auction_result_date desc"""
        out["sold"] = rows(con, q_ % "r.auction_result_from_stable_id=?", (sid,))
        out["bought"] = rows(con, q_ % "r.auction_result_to_stable_id=? and r.auction_result_accepted in (1,'1','true')", (sid,))
        for r in out["sold"]:
            r["sold"] = r["sold"] in (1, "1", "true", True)
    return out


def stable_share_counts(con, sid):
    n = 0
    if has_table(con, "share_offerings"):
        n += con.execute("select count(*) from share_offerings where so_stable_id=?", (sid,)).fetchone()[0]
    if has_table(con, "pending_investor_offers"):
        n += con.execute("select count(*) from pending_investor_offers where offer_stable_id=?", (sid,)).fetchone()[0]
    return n


def api_stable_shares(con, sid):
    """A stable's Shares tab: its share offerings (new shares put up for sale), who had the right to buy in and what they did,
    and investors' offers to buy or sell its shares."""
    out = {"offerings": [], "offers": []}
    if has_table(con, "share_offerings"):
        out["offerings"] = rows(con, """select so_id as id, so_type as type, so_shares_offered as offered, so_price_per_share as price, so_claim_price_per_share as claim_price,
            so_created_date as created, so_deadline_date as deadline, so_status as status, so_resolved_date as resolved, so_claimed_shares as claimed,
            so_market_shares as market from share_offerings where so_stable_id=? order by so_created_date desc""", (sid,))
        if out["offerings"] and has_table(con, "share_offering_rights"):
            ids = ",".join(str(int(o["id"])) for o in out["offerings"])
            rights = rows(con, """select r.sor_offering_id as oid, r.sor_person_id as person_id, p.person_full_name as person, r.sor_holder_stable_id as holder_id,
                s.stable_name as holder, r.sor_entitled as entitled, r.sor_claimed as claimed, r.sor_response as response from share_offering_rights r
                left join persons p on p.person_person_id=r.sor_person_id left join stables s on r.sor_holder_stable_id > 0 and s.stable_stable_id=r.sor_holder_stable_id
                where r.sor_offering_id in (%s) order by r.sor_entitled desc""" % ids)
            for o in out["offerings"]:
                o["rights"] = [r for r in rights if r["oid"] == o["id"]]
    if has_table(con, "pending_investor_offers"):
        out["offers"] = rows(con, """select o.offer_id as id, o.offer_type as type, o.offer_status as status, o.offer_date as date, o.offer_shares as shares,
            o.offer_price_per_share as price, o.offer_total_price as total, o.offer_investor_person_id as person_id, p.person_full_name as person,
            o.offer_holder_stable_id as holder_id, s.stable_name as holder from pending_investor_offers o left join persons p on p.person_person_id=o.offer_investor_person_id
            left join stables s on o.offer_holder_stable_id > 0 and s.stable_stable_id=o.offer_holder_stable_id where o.offer_stable_id=? order by o.offer_date desc""", (sid,))
    return out


ASSET_SORTS = {"price": "a.asset_purchase_price", "date": "a.asset_purchase_date", "name": "c.catalog_name", "category": "c.catalog_category",
               "owner": "p.person_full_name", "value": "c.catalog_purchase_price", "upkeep": "c.catalog_annual_maintenance", "tier": "c.catalog_tier"}


def api_assets(con, q):
    """People → Lifestyle assets: the houses, yachts, cars, watches and so on that people own (or, view=catalogue, everything there is to buy)."""
    if not (has_table(con, "owned_assets") and has_table(con, "asset_catalog")):
        return {"total": 0, "page": 1, "page_size": page_size(), "rows": [], "categories": []}
    cats = [x[0] for x in con.execute("select distinct catalog_category from asset_catalog where catalog_category is not null order by 1")]
    if q.get("view") == "catalogue":
        where, params = [], []
        if q.get("category"):
            where.append("c.catalog_category=?"); params.append(q["category"])
        if q.get("q"):
            where.append("c.catalog_name like ?"); params.append("%" + q["q"] + "%")
        w = (" where " + " and ".join(where)) if where else ""
        sort, d = sort_args(q, {"value": "c.catalog_purchase_price", "name": "c.catalog_name", "category": "c.catalog_category", "upkeep": "c.catalog_annual_maintenance",
                                "tier": "c.catalog_tier", "owned": "o.n", "prestige": "c.catalog_prestige_bonus"}, "value")
        data = rows(con, """select c.catalog_id as id, c.catalog_category as category, c.catalog_name as name, c.catalog_description as about, c.catalog_tier as tier,
            c.catalog_purchase_price as value, c.catalog_annual_maintenance as upkeep, c.catalog_city_id as city_id, c.catalog_prestige_bonus as prestige,
            c.catalog_travel_speed_multiplier as travel, c.catalog_rarity as rarity, coalesce(o.n, 0) as owned from asset_catalog c
            left join (select asset_catalog_id as cid, count(*) as n from owned_assets group by 1) o on o.cid=c.catalog_id""" + w + " order by " + order_sql(sort, d), params)
        cities = _city_names(con, [r["city_id"] for r in data])
        for r in data:
            r["city"], r["country"] = cities.get(r["city_id"], (None, None))
        return {"total": len(data), "page": 1, "page_size": max(1, len(data)), "rows": data, "categories": cats}
    where, params = [], []
    if q.get("category"):
        where.append("c.catalog_category=?"); params.append(q["category"])
    if q.get("q"):
        where.append("(c.catalog_name like ? or a.asset_custom_name like ? or p.person_full_name like ?)"); params += ["%" + q["q"] + "%"] * 3
    if q.get("forsale") == "1":
        where.append("a.asset_for_sale = 1")
    if q.get("owner"):
        where.append("a.asset_owner_id=?"); params.append(to_int(q["owner"]))
    w = (" where " + " and ".join(where)) if where else ""
    base = """ from owned_assets a join asset_catalog c on c.catalog_id=a.asset_catalog_id
        left join persons p on a.asset_owner_type='person' and p.person_person_id=a.asset_owner_id"""
    sort, d = sort_args(q, ASSET_SORTS, "price")
    page, off = page_args(q)
    total = count_rows(con, "select count(*)" + base + w, params)
    data = rows(con, """select a.asset_id as id, a.asset_custom_name as custom, c.catalog_name as name, c.catalog_category as category, c.catalog_tier as tier,
        c.catalog_rarity as rarity, c.catalog_description as about, a.asset_owner_type as owner_type, a.asset_owner_id as owner_id, p.person_full_name as owner,
        a.asset_purchase_date as date, a.asset_purchase_price as price, c.catalog_purchase_price as value, c.catalog_annual_maintenance as upkeep,
        a.asset_is_primary_home as home, a.asset_city_id as city_id, a.asset_for_sale as for_sale""" + base + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    cities = _city_names(con, [r["city_id"] for r in data])
    for r in data:
        r["city"], r["country"] = cities.get(r["city_id"], (None, None))
    summary = rows(con, """select c.catalog_category as category, count(*) as n, sum(a.asset_purchase_price) as spent""" + base + w + " group by 1 order by 3 desc", params)
    return {"total": total, "page": page, "page_size": page_size(), "rows": data, "categories": cats, "summary": summary}


# --------------------------------------------------------------------------- 16.7.15: auction house finances
# The same payment log as racecourses (entity type "auction_house"), with the same rule for the years the game only keeps
# as one "Yearly Summary" payment each way. Dividends to the owner and capital put in by the owner are kept apart: they
# move money between the house and its owner and aren't income or running costs.
AH_INCOME_LABEL = {"Venue Sponsorship": "Sponsorship", "Venue Sponsor Event Bonus": "Sponsor event bonuses", "Auction Commission": "Commission on sales",
                   "Fee": "Entry fees"}
AH_EXPENSE_LABEL = {"Operating Expenses": "Operating expenses", "Tax Payment": "Tax", "Auction Arrangement": "Setting up sales"}
AH_OWNER = {"Dividend": "dividends", "Capital Injection": "capital"}


def _ah_bucket():
    return {"income": 0.0, "expenses": 0.0, "dividends": 0.0, "capital": 0.0, "income_cats": {}, "expense_cats": {}}


def _ah_add(b, side, typ, amount):
    amount = amount or 0
    if typ in AH_OWNER:
        b[AH_OWNER[typ]] += amount
    elif side == "to":
        lab = AH_INCOME_LABEL.get(typ, typ or "Other")
        b["income"] += amount
        b["income_cats"][lab] = b["income_cats"].get(lab, 0) + amount
    else:
        lab = AH_EXPENSE_LABEL.get(typ, typ or "Other")
        b["expenses"] += amount
        b["expense_cats"][lab] = b["expense_cats"].get(lab, 0) + amount


def api_auction_house_finances(con, hid):
    """An auction house's Financials tab: the last 12 months (against the 12 before), month by month, and year by year."""
    out = {"months12": [], "last12": _ah_bucket(), "prev12": _ah_bucket(), "years": []}
    if not has_table(con, "transactions"):
        return out
    gd = META.get("game_date") or time.time()
    w0 = course_window_start(gd)
    py, pm = time.gmtime(w0)[:2]
    p0 = calendar.timegm((py - 1, pm, 1, 0, 0, 0))
    # month keys for the last 12 months
    keys = []
    y, m = py, pm
    for _ in range(12):
        keys.append("%04d-%02d" % (y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    months = {k: dict(_ah_bucket(), key=k, year=int(k[:4]), month=int(k[5:])) for k in keys}
    summary_years = set()
    years = {}
    for side in ("to", "from"):
        for ts, typ, amount in con.execute("""select transaction_date, transaction_type, transaction_amount from transactions
                where transaction_%s_entity_type='auction_house' and transaction_%s_entity_id=?""" % (side, side), (hid,)):
            if ts is None:
                continue
            yr = time.gmtime(ts)[0]
            yb = years.setdefault(yr, dict(_ah_bucket(), year=yr, summary_in=0.0, summary_out=0.0))
            if typ == "Yearly Summary":
                summary_years.add(yr)
                yb["summary_in" if side == "to" else "summary_out"] += amount or 0
                continue
            _ah_add(yb, side, typ, amount)
            if ts > gd:
                continue
            if ts >= w0:
                mk = "%04d-%02d" % time.gmtime(ts)[:2]
                if mk in months:
                    _ah_add(months[mk], side, typ, amount)
                _ah_add(out["last12"], side, typ, amount)
            elif ts >= p0:
                _ah_add(out["prev12"], side, typ, amount)
    for b in list(months.values()) + [out["last12"], out["prev12"]]:
        b["profit"] = b["income"] - b["expenses"]
    out["months12"] = [months[k] for k in keys]
    # the 12 months before are only comparable when the game still keeps them in detail
    out["prev12"]["complete"] = not any(yr in summary_years for yr in range(time.gmtime(p0)[0], time.gmtime(w0 - 1)[0] + 1))
    for yr in sorted(years):
        b = years[yr]
        if yr in summary_years:      # a yearly total stands for the whole year (any detail kept from earlier loads is only part of it)
            b.update(income=b["summary_in"], expenses=b["summary_out"], income_cats={}, expense_cats={}, itemised=False)
        else:
            b["itemised"] = True
        b["profit"] = b["income"] - b["expenses"]
        out["years"].append(b)
    return out


def api_horse_more(con, hid):
    """A horse's Training & plans tab, and the rankings and syndicate panels on its Overview."""
    out = {"training": None, "shoes": None, "schedule": None, "plan": None, "campaigns": [], "qualifying": [], "rankings": {}, "syndicates": []}
    if _t(con, "horse_training"):
        out["training"] = one(con, """select ht_training_type as type, ht_food as food, ht_care as care, ht_trainer_effect as trainer, ht_head_trainer_effect as head_trainer,
            ht_stablehand_effect as stablehand, ht_speed_training_effect as speed, ht_stamina_training_effect as stamina, ht_strength_training_effect as strength,
            ht_acceleration_training_effect as acceleration from horse_training where ht_horse_id=? order by ht_training_id desc limit 1""", (hid,))
    if _t(con, "horse_shoes"):
        out["shoes"] = one(con, """select shoe_material as material, shoe_position as position, shoe_durability as durability, shoe_quality as quality,
            shoe_applied_date as applied, shoe_applied_by as by_id from horse_shoes where shoe_horse_id=? order by shoe_id desc limit 1""", (hid,))
    if _t(con, "horse_yearly_schedule") and _t(con, "yearly_schedules"):
        out["schedule"] = one(con, """select y.ys_name as name, y.ys_description as about, y.ys_pre_race_days as pre, y.ys_recovery_days as recovery
            from horse_yearly_schedule s join yearly_schedules y on y.ys_id=s.hys_schedule_id where s.hys_horse_id=? order by s.hys_id desc limit 1""", (hid,))
    if _t(con, "race_plans") and "horse_race_plan_id" in columns(con, "horses"):
        p = one(con, """select p.rp_id as id, p.rp_name as name, p.rp_stage as stage, h.horse_race_plan_date as since from horses h join race_plans p on p.rp_id=h.horse_race_plan_id
            where h.horse_horse_id=?""", (hid,))
        if p:
            p["legs"] = rows(con, """select rpl_order as n, rpl_month as month, rpl_kind as kind, rpl_grades as grades, rpl_distance_min as dmin, rpl_distance_max as dmax,
                rpl_surface as surface, rpl_min_purse as purse, rpl_countries as countries from race_plan_legs where rpl_plan_id=? order by rpl_order""", (p["id"],)) if _t(con, "race_plan_legs") else []
        out["plan"] = p
    if _t(con, "campaign_suggestions"):
        out["campaigns"] = rows(con, """select c.cs_season_year as year, c.cs_stage as stage, c.cs_status as status, c.cs_verdict as verdict, c.cs_date as date, k.concept_name as concept
            from campaign_suggestions c left join concepts k on k.concept_id=c.cs_concept_id where c.cs_horse_id=? order by c.cs_date desc""", (hid,)) if _t(con, "concepts") else []
    if _t(con, "horse_qualification_points"):
        out["qualifying"] = rows(con, """select hqp_target_race_name as target, hqp_type as type, hqp_points as points, hqp_source_race_name as source, hqp_source_race_id as race_id,
            hqp_date_earned as date, hqp_cycle_closed as closed from horse_qualification_points where hqp_horse_id=? order by hqp_date_earned desc""", (hid,))
    rk = {}
    if _t(con, "horse_earnings_rankings"):
        r = one(con, "select career_percentile as career, offspring_earnings as offspring_earnings, offspring_percentile as offspring from horse_earnings_rankings where horse_id=?", (hid,))
        if r:
            rk.update(r)
    if _t(con, "horse_earnings_percentiles"):
        r = one(con, "select percentile_age_group as age_group, percentile_rank as age_rank from horse_earnings_percentiles where percentile_horse_id=? order by percentile_id desc limit 1", (hid,))
        if r:
            rk.update(r)
    if _t(con, "horse_pedigree_percentiles"):
        r = one(con, "select pedigree_rank as pedigree, pedigree_combined_earnings as pedigree_earnings from horse_pedigree_percentiles where pedigree_horse_id=? order by pedigree_percentile_id desc limit 1", (hid,))
        if r:
            rk.update(r)
    out["rankings"] = rk
    if _t(con, "horse_syndications"):
        sy = rows(con, """select y.syndication_id as id, y.syndication_managing_stable_id as stable_id, s.stable_name as stable, y.syndication_total_shares as shares,
            y.syndication_available_shares as available, y.syndication_price_per_share as price, y.syndication_management_fee_pct as fee, y.syndication_status as status,
            y.syndication_created_date as created, y.syndication_closed_date as closed, y.syndication_dissolved_date as dissolved,
            y.syndication_total_distributed as distributed, y.syndication_total_costs_charged as costs
            from horse_syndications y left join stables s on s.stable_stable_id=y.syndication_managing_stable_id where y.syndication_horse_id=? order by y.syndication_created_date desc""", (hid,))
        if sy and _t(con, "horse_syndicate_shareholders"):
            ids = ",".join(str(int(x["id"])) for x in sy)
            sh = rows(con, """select h.shareholder_syndication_id as sid, h.shareholder_person_id as person_id, p.person_full_name as person, h.shareholder_shares_owned as shares,
                h.shareholder_total_paid as paid, h.shareholder_purchase_date as date from horse_syndicate_shareholders h left join persons p on p.person_person_id=h.shareholder_person_id
                where h.shareholder_syndication_id in (%s) order by h.shareholder_shares_owned desc""" % ids)
            for x in sy:
                x["holders"] = [r for r in sh if r["sid"] == x["id"]]
        out["syndicates"] = sy
    return out


def api_stable_more(con, sid):
    """A stable's facilities and farm sponsors."""
    out = {"facilities": [], "sponsors": []}
    if _t(con, "constructed_facilities") and _t(con, "facility_types"):
        out["facilities"] = rows(con, """select f.facility_type_name as type, f.facility_type_description as about, f.facility_type_daily_cost as daily, f.facility_type_base_cost as cost,
            count(*) as n, min(c.constructed_facility_construction_date) as first, max(c.constructed_facility_construction_date) as last, sum(c.constructed_facility_is_operational) as working
            from constructed_facilities c join facility_types f on f.facility_type_id=c.constructed_facility_type_id
            where c.constructed_facility_entity_type='stable' and c.constructed_facility_entity_id=? group by f.facility_type_id order by min(c.constructed_facility_construction_date)""", (sid,))
    if _t(con, "farm_sponsors"):
        gd = META.get("game_date") or time.time()
        out["sponsors"] = rows(con, """select fs_brand_name as brand, fs_industry as industry, fs_monthly_payment as monthly, fs_contract_start_date as start, fs_contract_end_date as end,
            fs_total_payments_made as paid from farm_sponsors where fs_stable_id=? order by fs_contract_start_date desc""", (sid,))
        for r in out["sponsors"]:
            r["current"] = bool(r["start"] and r["start"] <= gd and (not r["end"] or r["end"] > gd))
    return out


def course_sponsors(con, cid):
    if not _t(con, "venue_sponsors"):
        return []
    gd = META.get("game_date") or time.time()
    out = rows(con, """select vs_brand_name as brand, vs_industry as industry, vs_monthly_payment as monthly, vs_per_event_bonus as bonus, vs_sponsorship_type as type,
        vs_contract_start_date as start, vs_contract_end_date as end, vs_total_payments_made as paid, vs_events_during_contract as events
        from venue_sponsors where vs_venue_type='racecourse' and vs_venue_id=? order by vs_contract_start_date desc""", (cid,))
    for r in out:
        r["current"] = bool(r["start"] and r["start"] <= gd and (not r["end"] or r["end"] > gd))
    return out


def person_more(con, pid):
    """Languages and syndicate shares, for a person's Overview."""
    out = {"languages": [], "syndicate_shares": []}
    if _t(con, "person_languages"):
        out["languages"] = rows(con, "select language, skill from person_languages where person_id=? order by skill desc", (pid,))
    if _t(con, "horse_syndicate_shareholders") and _t(con, "horse_syndications"):
        out["syndicate_shares"] = rows(con, """select y.syndication_horse_id as horse_id, h.horse_name as horse, h.horse_deceased_date as died, s.shareholder_shares_owned as shares,
            y.syndication_total_shares as of, s.shareholder_total_paid as paid, s.shareholder_purchase_date as date, y.syndication_status as status,
            y.syndication_managing_stable_id as stable_id, st.stable_name as stable
            from horse_syndicate_shareholders s join horse_syndications y on y.syndication_id=s.shareholder_syndication_id
            left join horses h on h.horse_horse_id=y.syndication_horse_id left join stables st on st.stable_stable_id=y.syndication_managing_stable_id
            where s.shareholder_person_id=? order by s.shareholder_purchase_date desc""", (pid,))
    return out


def language_list(con):
    return [r[0] for r in con.execute("select language from person_languages group by 1 order by count(*) desc")] if _t(con, "person_languages") else []


# ------------------------------------------------------------------ 16.7: your racing season (set in Settings; the viewer passes ss=MM-DD)
def season_start(q):
    """The day your racing season starts, from ?ss=MM-DD: (month, day). Calendar year if not given."""
    m = re.match(r"^(\d{1,2})-(\d{1,2})$", str(q.get("ss") or ""))
    if m and 1 <= int(m.group(1)) <= 12 and 1 <= int(m.group(2)) <= 28:
        return int(m.group(1)), int(m.group(2))
    return 1, 1


def season_key(ts, ss):
    """The season a date falls in, by the year it starts."""
    t = time.gmtime(ts)
    return t.tm_year if (t.tm_mon, t.tm_mday) >= ss else t.tm_year - 1


def season_label(y, ss):
    return str(y) if ss == (1, 1) else "%d/%s" % (y, str(y + 1)[2:])


def season_bounds(y, ss):
    return calendar.timegm((y, ss[0], ss[1], 0, 0, 0)), calendar.timegm((y + 1, ss[0], ss[1], 0, 0, 0))


# ------------------------------------------------------------------ 16.5: a jockey's season
DIST_BANDS = [(0, 1300, "Sprint (up to 1,300 m)"), (1300, 1700, "Mile (1,300–1,700 m)"), (1700, 2100, "Middle (1,700–2,100 m)"),
              (2100, 2700, "Classic (2,100–2,700 m)"), (2700, 99999, "Staying (2,700 m+)")]


def api_jockey_season(con, pid, q):
    """Season summary for a jockey: this season against the one before, and where and with whom they win."""
    gd = META.get("game_date") or time.time()
    ss = season_start(q)
    years = sorted({season_key(r[0], ss) for r in con.execute("select race_result_date from race_results where race_result_person_jockey_id=? and race_result_date is not null", (pid,))}, reverse=True)
    now_y = season_key(gd, ss)
    year = to_int(q.get("year"), None) or (years[0] if years else now_y)
    def span(y):
        return season_bounds(y, ss)
    def runs(y, extra=""):
        a, b = span(y)
        return rows(con, """select r.race_result_rank as rank, r.race_result_cash_received as prize, r.race_result_horse_id as horse_id, r.race_result_trainer_id as trainer_id,
            r.race_result_stable_id as stable_id, r.race_result_date as date, r.race_result_race_id as race_id, x.races_distance as dist, x.races_track as track,
            x.races_type_of_race as grade, d.raceday_racecourse_id as course_id
            from race_results r join races x on x.races_race_id=r.race_result_race_id left join race_days d on d.raceday_race_day_id=x.races_race_day_id
            where r.race_result_person_jockey_id=? and r.race_result_date>=? and r.race_result_date<?""", (pid, a, b))
    def summary(rs, upto=None):
        if upto is not None:
            rs = [r for r in rs if (r["date"] or 0) <= upto]
        n = len(rs)
        w = sum(1 for r in rs if r["rank"] == 1)
        pl = sum(1 for r in rs if r["rank"] and r["rank"] <= 3)
        return {"rides": n, "wins": w, "places": pl, "strike": (w / n) if n else None, "place_rate": (pl / n) if n else None,
                "prize": sum(r["prize"] or 0 for r in rs), "stakes": sum(1 for r in rs if r["rank"] == 1 and r["grade"] in ("G1", "G2", "G3", "listed"))}
    cur, prev = runs(year), runs(year - 1)
    # the same point last season, when this season isn't over
    a, _ = span(year)
    upto = (gd - a) + span(year - 1)[0] if year == now_y else None
    def group(rs, key, label):
        g = {}
        for r in rs:
            k = key(r)
            if k is None:
                continue
            s = g.setdefault(k, {"key": k, "rides": 0, "wins": 0, "places": 0, "prize": 0})
            s["rides"] += 1
            s["wins"] += r["rank"] == 1
            s["places"] += bool(r["rank"] and r["rank"] <= 3)
            s["prize"] += r["prize"] or 0
        out = sorted(g.values(), key=lambda s: (-s["wins"], -s["rides"]))
        for s in out:
            s["strike"] = s["wins"] / s["rides"] if s["rides"] else None
            s["label"] = label(s["key"])
        return out
    def band(d):
        for lo, hi, lab in DIST_BANDS:
            if d is not None and lo <= d < hi:
                return lab
        return None
    cn = name_map(con, "racecourses", "racecourse_racecourse_id", "racecourse_name", [r["course_id"] for r in cur])
    pn = name_map(con, "persons", "person_person_id", "person_full_name", [r["trainer_id"] for r in cur])
    hn = name_map(con, "horses", "horse_horse_id", "horse_name", [r["horse_id"] for r in cur])
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in cur])
    out = {"year": year, "label": season_label(year, ss), "prev_label": season_label(year - 1, ss), "start_month": ss[0],
           "years": [{"key": y, "label": season_label(y, ss)} for y in years], "now": summary(cur), "prev": summary(prev), "prev_same": summary(prev, upto) if upto else None,
           "by_course": group(cur, lambda r: r["course_id"], lambda k: cn.get(k)),
           "by_distance": sorted(group(cur, lambda r: band(r["dist"]), lambda k: k), key=lambda s: [b[2] for b in DIST_BANDS].index(s["key"])),
           "by_track": group(cur, lambda r: r["track"], lambda k: k),
           "trainers": group(cur, lambda r: r["trainer_id"], lambda k: pn.get(k))[:15],
           "horses": group(cur, lambda r: r["horse_id"], lambda k: hn.get(k))[:15],
           "stables": group(cur, lambda r: r["stable_id"], lambda k: sn.get(k))[:15]}
    months = {}
    for r in cur:
        m = int(time.strftime("%m", time.gmtime(r["date"])))
        s = months.setdefault(m, {"month": m, "rides": 0, "wins": 0})
        s["rides"] += 1
        s["wins"] += r["rank"] == 1
    out["months"] = [months[m] for m in sorted(months, key=lambda m: (m - ss[0]) % 12)]
    # rides booked ahead, and ride offers
    out["upcoming"] = rows(con, """select %s, c.racecourse_name as course, c.racecourse_racecourse_id as course_id, p.race_participant_horse_id as horse_id, h.horse_name as horse,
        h.horse_stable_id as stable_id, s.stable_name as stable
        from race_participants p join races x on x.races_race_id=p.race_participant_race_id
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        left join horses h on h.horse_horse_id=p.race_participant_horse_id left join stables s on s.stable_stable_id=h.horse_stable_id
        where p.race_participant_person_jockey_id=? and x.races_race_date_time>? order by x.races_race_date_time limit 100""" % RACE_COLS, (pid, gd)) if _t(con, "race_participants") else []
    out["offers"] = rows(con, """select o.ride_offer_race_id as race_id, x.races_race_name as race, x.races_race_date_time as date, o.ride_offer_horse_id as horse_id, h.horse_name as horse,
        o.ride_offer_stable_id as stable_id, s.stable_name as stable, o.ride_offer_fee as fee, o.ride_offer_created_date as offered, o.ride_offer_expires_date as expires,
        o.ride_offer_status as status, o.ride_offer_win_percentage as win_pct
        from ride_offers o left join races x on x.races_race_id=o.ride_offer_race_id left join horses h on h.horse_horse_id=o.ride_offer_horse_id
        left join stables s on s.stable_stable_id=o.ride_offer_stable_id where o.ride_offer_person_id=? order by o.ride_offer_created_date desc""", (pid,)) if _t(con, "ride_offers") else []
    return out


# ------------------------------------------------------------------ 16.5: alerts on Home
def api_alerts(con):
    """Things worth a look for you: sponsor deals ending soon, new fan milestones, rides coming up, ride offers to answer, qualifying races."""
    pid, ps = META.get("player_id"), META.get("player_stable_id")
    gd = META.get("game_date") or time.time()
    day = 86400
    out = []
    mine = [s["id"] for s in my_stables(con, pid, ps) if s["mine"]] if pid else []
    mk = ",".join(str(int(x)) for x in mine) or "0"
    if _t(con, "horse_sponsors"):
        for r in rows(con, """select s.sponsor_horse_id as horse_id, h.horse_name as horse, s.sponsor_brand_name as brand, s.sponsor_contract_end_date as end, s.sponsor_monthly_payment as monthly
                from horse_sponsors s join horses h on h.horse_horse_id=s.sponsor_horse_id where h.horse_stable_id in (%s) and h.horse_deceased_date is null
                and s.sponsor_contract_start_date<=? and s.sponsor_contract_end_date>? and s.sponsor_contract_end_date<=? order by s.sponsor_contract_end_date""" % mk, (gd, gd, gd + 60 * day)):
            out.append(dict(r, kind="sponsor_end", date=r["end"]))
    if _t(con, "farm_sponsors"):
        for r in rows(con, """select fs_stable_id as stable_id, fs_brand_name as brand, fs_contract_end_date as end, fs_monthly_payment as monthly from farm_sponsors
                where fs_stable_id in (%s) and fs_contract_start_date<=? and fs_contract_end_date>? and fs_contract_end_date<=?""" % mk, (gd, gd, gd + 60 * day)):
            out.append(dict(r, kind="farm_sponsor_end", date=r["end"], stable=dict(con.execute("select stable_stable_id, stable_name from stables where stable_stable_id=?", (r["stable_id"],)).fetchall()).get(r["stable_id"])))
    for hid, ms in fan_inbox(con).items():
        for m in ms:
            if m["date"] and gd - 30 * day <= m["date"] <= gd and m["kind"] != "merch":
                out.append({"kind": "fan", "horse_id": hid, "date": m["date"], "subject": m["subject"], "step": m["kind"]})
    if pid and _t(con, "race_participants"):
        for r in rows(con, """select x.races_race_id as race_id, x.races_race_name as race, x.races_race_date_time as date, x.races_type_of_race as grade, p.race_participant_horse_id as horse_id,
                h.horse_name as horse from race_participants p join races x on x.races_race_id=p.race_participant_race_id left join horses h on h.horse_horse_id=p.race_participant_horse_id
                where p.race_participant_person_jockey_id=? and x.races_race_date_time>? and x.races_race_date_time<=? order by x.races_race_date_time""", (pid, gd, gd + 14 * day)):
            out.append(dict(r, kind="ride"))
    if pid and _t(con, "ride_offers"):
        for r in rows(con, """select o.ride_offer_race_id as race_id, x.races_race_name as race, o.ride_offer_horse_id as horse_id, h.horse_name as horse, o.ride_offer_fee as fee,
                o.ride_offer_expires_date as date from ride_offers o left join races x on x.races_race_id=o.ride_offer_race_id left join horses h on h.horse_horse_id=o.ride_offer_horse_id
                where o.ride_offer_person_id=? and o.ride_offer_status in ('pending','open','offered') and o.ride_offer_expires_date>?""", (pid, gd)):
            out.append(dict(r, kind="offer"))
    if _t(con, "horse_qualification_points"):
        for r in rows(con, """select q.hqp_horse_id as horse_id, h.horse_name as horse, q.hqp_target_race_name as target, q.hqp_source_race_name as source, q.hqp_date_earned as date, q.hqp_type as type
                from horse_qualification_points q join horses h on h.horse_horse_id=q.hqp_horse_id where h.horse_stable_id in (%s) and q.hqp_cycle_closed=0 and q.hqp_date_earned>=?
                order by q.hqp_date_earned desc limit 10""" % mk, (gd - 60 * day,)):
            out.append(dict(r, kind="qualified"))
    hn = name_map(con, "horses", "horse_horse_id", "horse_name", [a["horse_id"] for a in out if a.get("horse_id") and not a.get("horse")])
    for a in out:
        if a.get("horse_id") and not a.get("horse"):
            a["horse"] = hn.get(a["horse_id"])
    order = {"offer": 0, "ride": 1, "sponsor_end": 2, "farm_sponsor_end": 2, "fan": 3, "qualified": 4}
    out.sort(key=lambda a: (order.get(a["kind"], 9), a.get("date") or 0))
    return {"alerts": out, "now": gd}


# ------------------------------------------------------------------ 16.5: your notes in the search box; backing up your notes
def notes_search(con, term):
    d = notes_load()
    t = term.lower()
    tagn = {x["id"]: x["name"] for x in d.get("tags", [])}
    hits = []
    for k, it in d.get("items", {}).items():
        if not k.startswith("horse:"):
            continue
        texts = [n.get("text") or "" for n in it.get("log") or []]
        tags = [tagn.get(x, "") for x in it.get("tags") or []]
        found = next((x for x in texts if t in x.lower()), None)
        tag = next((x for x in tags if t in x.lower()), None)
        if found or tag:
            hits.append((it.get("updated") or 0, int(k[6:]), found, tag))
    hits.sort(reverse=True)
    hits = hits[:6]
    names = name_map(con, "horses", "horse_horse_id", "horse_name", [h[1] for h in hits])
    out = []
    for _, hid, found, tag in hits:
        if found:
            i = found.lower().find(t)
            snip = ("…" if i > 30 else "") + found[max(0, i - 30): i + len(t) + 40].replace("\n", " ") + ("…" if i + len(t) + 40 < len(found) else "")
            extra = "Your note: " + snip
        else:
            extra = "Your tag: " + tag
        out.append({"type": "horse", "id": hid, "name": names.get(hid) or "Horse #%d" % hid, "extra": extra, "note": True})
    return out


def notes_import(data):
    """Bring back a notes backup: merge (add to what's there) or replace."""
    mode = data.get("mode") or "merge"
    src = data.get("data")
    if not isinstance(src, dict) or not isinstance(src.get("items"), dict):
        return {"error": "That isn't an HRM Viewer notes backup."}, 400
    with NOTES_LOCK:
        cur = notes_load()
        if mode == "replace":
            cur = {"v": 2, "tags": [], "items": {}}
        have = {t["id"]: t for t in cur.get("tags", [])}
        for t in src.get("tags") or []:
            if isinstance(t, dict) and t.get("id") and t["id"] not in have and len(cur["tags"]) < TAGS_MAX:
                cur["tags"].append({k: t.get(k) for k in ("id", "name", "color", "icon")})
                have[t["id"]] = t
        added = 0
        for k, it in src["items"].items():
            if not isinstance(it, dict) or not re.match(r"^horse:-?\d+$", k):
                continue
            mine = cur["items"].setdefault(k, {"tags": [], "log": []})
            log = mine.setdefault("log", [])
            seen = {(n.get("text"), n.get("at")) for n in log}
            nmax = max([to_int(str(n.get("id", ""))[1:], 0) for n in log] + [0])
            for n in it.get("log") or ([{"text": it["note"], "at": it.get("updated")}] if it.get("note") else []):
                if (n.get("text"), n.get("at")) in seen or not n.get("text"):
                    continue
                nmax += 1
                log.append({"id": "n%d" % nmax, "text": str(n["text"])[:NOTE_MAX], "at": n.get("at") or time.time(), "gd": n.get("gd"), "edited": n.get("edited")})
                added += 1
            mine["tags"] = sorted(set(mine.get("tags") or []) | {x for x in it.get("tags") or [] if x in have})
            mine["updated"] = max(mine.get("updated") or 0, it.get("updated") or 0) or time.time()
        write_json(notes_path(), cur)
    NOTES_REV[0] += 1
    return {"ok": True, "notes_added": added, "horses": len(src["items"]), "tags": len(cur["tags"])}, 200


# ------------------------------------------------------------------ 16.6: Racing → Concepts (Triple Crowns and other series) and Qualifying
def race_instances(con, cal_ids):
    """Every running of these races (by the game's calendar id): {calendar_id: [{race_id, date, year, name, course_id, course}]}."""
    ids = [c for c in set(cal_ids) if c]
    out = {c: [] for c in ids}
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        for r in rows(con, """select x.races_calendar_id as cal, x.races_race_id as race_id, x.races_race_date_time as date, x.races_race_name as name,
                x.races_type_of_race as grade, d.raceday_racecourse_id as course_id, c.racecourse_name as course
                from races x left join race_days d on d.raceday_race_day_id=x.races_race_day_id left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
                where x.races_calendar_id in (%s) and coalesce(x.races_cancelled,0)=0 order by x.races_race_date_time""" % ",".join("?" * len(chunk)), chunk):
            r["year"] = utc_year(r["date"]) if r["date"] else None
            out[r.pop("cal")].append(r)
    return out


def race_winners(con, race_ids):
    """{race_id: {horse_id, horse, jockey_id, jockey, stable_id, stable}} for races already run; places 1-3 under "top3"."""
    out = {}
    ids = [i for i in set(race_ids) if i]
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in rows(con, """select r.race_result_race_id as race_id, r.race_result_rank as rank, r.race_result_horse_id as horse_id, h.horse_name as horse,
                r.race_result_person_jockey_id as jockey_id, r.race_result_stable_id as stable_id from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
                where r.race_result_race_id in (%s) and r.race_result_rank between 1 and 3""" % ",".join("?" * len(chunk)), chunk):
            w = out.setdefault(r["race_id"], {"top3": []})
            w["top3"].append(r)
            if r["rank"] == 1:
                w.update(horse_id=r["horse_id"], horse=r["horse"], jockey_id=r["jockey_id"], stable_id=r["stable_id"])
    pn = name_map(con, "persons", "person_person_id", "person_full_name", [w.get("jockey_id") for w in out.values()])
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [w.get("stable_id") for w in out.values()])
    for w in out.values():
        w["jockey"], w["stable"] = pn.get(w.get("jockey_id")), sn.get(w.get("stable_id"))
    return out


def concept_points(scheme):
    try:
        return [float(x) for x in str(scheme or "").split("-") if x.strip()]
    except ValueError:
        return []


def concept_seasons(legs, inst, gd, ss=None):
    """A series' runnings grouped into seasons, newest first: [{start, label, legs: [run or None per race], done}].
    With ss (month, day) a season is that fixed period (your racing season, set in Settings). Without it each series
    keeps its own season: it starts with a running of the first race and each later race joins the season it follows."""
    if ss:
        by = {}
        for k, l in enumerate(legs):
            for r in sorted(inst.get(l["cal"], []), key=lambda r: r["date"]):
                y = season_key(r["date"], ss)
                se = by.setdefault(y, {"key": y, "legs": [None] * len(legs)})
                if se["legs"][k] is None:
                    se["legs"][k] = r
        out = []
        for y, se in by.items():
            a, b = season_bounds(y, ss)
            ds = [r["date"] for r in se["legs"] if r]
            se.update(start=a, end=max(ds), label=season_label(y, ss), started=min(ds) <= gd,
                      done=all(r and r["date"] <= gd for r in se["legs"]) or (gd >= b and all(r is None or r["date"] <= gd for r in se["legs"])))
            out.append(se)
        out.sort(key=lambda se: se["key"], reverse=True)
        return out
    runs1 = sorted(inst.get(legs[0]["cal"], []), key=lambda r: r["date"]) if legs else []
    seasons = [{"start": r["date"], "legs": [r] + [None] * (len(legs) - 1)} for r in runs1]
    for k, l in enumerate(legs[1:], 1):
        for r in sorted(inst.get(l["cal"], []), key=lambda r: r["date"]):
            host = None
            for se in seasons:
                if se["start"] <= r["date"] + 86400 and r["date"] - se["start"] < 330 * 86400 and se["legs"][k] is None:
                    host = se
            if host is None:      # a later race with no first race before it (the save starts mid-series)
                host = {"start": r["date"], "legs": [None] * len(legs)}
                seasons.append(host)
            host["legs"][k] = r
    for se in seasons:
        ds = [r["date"] for r in se["legs"] if r]
        y0, y1 = utc_year(min(ds)), utc_year(max(ds))
        se["label"] = str(y0) if y0 == y1 else "%d/%s" % (y0, str(y1)[2:])
        se["year0"], se["year1"] = y0, y1
        se["end"] = max(ds)
        se["started"] = min(ds) <= gd
        se["done"] = all(r and r["date"] <= gd for r in se["legs"])
    seasons.sort(key=lambda se: se["start"], reverse=True)
    return seasons


def season_status(se, win):
    """Winners so far and whether one horse can still sweep it."""
    legs = []
    for r in se["legs"]:
        w = win.get(r["race_id"]) if r else None
        legs.append({"race_id": r["race_id"] if r else None, "date": r["date"] if r else None, "winner": w if w and w.get("horse_id") else None})
    ws = [l["winner"]["horse_id"] for l in legs if l["winner"]]
    alive = None
    if ws and len(set(ws)) == 1:
        first = next(l["winner"] for l in legs if l["winner"])
        alive = {"horse_id": first["horse_id"], "horse": first["horse"], "won": len(ws), "of": len(legs)}
    return legs, alive


def concept_ss(q):
    """Concepts follow your racing season unless you've asked each series to keep its own (ss=auto)."""
    return None if str(q.get("ss") or "") == "auto" else season_start(q)


def api_concepts(con, q=None):
    """Racing → Concepts: every series, this season's races and winners, who can still sweep it, and how often it's been swept."""
    if not has_table(con, "concepts"):
        return {"concepts": []}
    cs = rows(con, """select concept_id as id, concept_name as name, concept_description as about, concept_scoring_type as scoring, concept_points_granted as points,
        concept_bonus_cash as bonus, concept_enabled as enabled from concepts order by concept_name""")
    legs = rows(con, "select cr_concept_id as cid, cr_race_name as race, cr_racecourse_name as course, cr_calendar_id as cal, cr_leg_order as n from concept_races order by cr_concept_id, cr_leg_order") if has_table(con, "concept_races") else []
    inst = race_instances(con, [l["cal"] for l in legs])
    gd = META.get("game_date") or time.time()
    sweeps = {}
    for cat, n, last in con.execute("select award_category, count(*), max(award_year) from awards where award_category like 'concept_%' and award_entity_type='horse' group by 1"):
        sweeps[to_int(cat[8:], 0)] = (n, last)
    per = {}
    for c in cs:
        cl = [l for l in legs if l["cid"] == c["id"]]
        ss = concept_seasons(cl, inst, gd, concept_ss(q or {}))
        started = [se for se in ss if se["started"]]
        cur = started[0] if started else None
        upcoming = next((se for se in reversed(ss) if not se["started"]), None)
        per[c["id"]] = (cl, cur, upcoming)
    win = race_winners(con, [r["race_id"] for cl, cur, _ in per.values() if cur for r in cur["legs"] if r and r["date"] <= gd])
    for c in cs:
        cl, cur, upcoming = per[c["id"]]
        lg, alive = season_status(cur, win) if cur else ([], None)
        c["season"] = cur["label"] if cur else None
        c["season_done"] = bool(cur and cur["done"])
        c["legs"] = []
        for i, l in enumerate(cl):
            r = cur["legs"][i] if cur else None
            nxt = upcoming["legs"][i] if upcoming else None
            c["legs"].append({"race": l["race"], "course": l["course"], "race_id": (r or nxt or {}).get("race_id"),
                              "winner": lg[i]["winner"] if lg else None, "date": (r or {}).get("date"), "run": bool(r and r["date"] <= gd)})
        c["next_season"] = {"label": upcoming["label"], "start": upcoming["start"]} if upcoming else None
        c["alive"] = alive
        c["sweeps"], c["last_sweep"] = sweeps.get(c["id"], (0, None))
    return {"concepts": cs}


def api_concept(con, cid, q):
    """One concept: its races season by season, the points table for a season, and every sweep."""
    c = one(con, """select concept_id as id, concept_name as name, concept_description as about, concept_scoring_type as scoring, concept_points_granted as points,
        concept_bonus_cash as bonus from concepts where concept_id=?""", (cid,)) if has_table(con, "concepts") else None
    if not c:
        return None
    legs = rows(con, "select cr_race_name as race, cr_racecourse_name as course, cr_calendar_id as cal, cr_leg_order as n from concept_races where cr_concept_id=? order by cr_leg_order", (cid,))
    inst = race_instances(con, [l["cal"] for l in legs])
    gd = META.get("game_date") or time.time()
    ss = concept_seasons(legs, inst, gd, concept_ss(q))
    win = race_winners(con, [r["race_id"] for se in ss for r in se["legs"] if r and r["date"] <= gd])
    awards = rows(con, """select a.award_year as year, a.award_date as date, a.award_entity_id as horse_id, h.horse_name as horse, a.award_stable_id as stable_id, s.stable_name as stable,
        a.award_jockey_id as jockey_id, p.person_full_name as jockey from awards a left join horses h on h.horse_horse_id=a.award_entity_id
        left join stables s on s.stable_stable_id=a.award_stable_id left join persons p on p.person_person_id=a.award_jockey_id
        where a.award_category=? and a.award_entity_type='horse' order by a.award_date""", ("concept_%d" % cid,))
    pts = concept_points(c["points"])
    seasons = []
    for se in ss:
        lg, alive = season_status(se, win)
        # the sweep award: given when (or soon after) the season's last race, to its winner
        sw = next((a for a in awards if a["date"] and se["start"] - 86400 <= a["date"] <= se["end"] + 120 * 86400), None)
        table = {}
        for r in se["legs"]:
            w = win.get(r["race_id"]) if r else None
            for t in (w or {}).get("top3", []):
                if 1 <= (t["rank"] or 0) <= len(pts):
                    e = table.setdefault(t["horse_id"], {"horse_id": t["horse_id"], "horse": t["horse"], "points": 0, "wins": 0, "legs": 0})
                    e["points"] += pts[t["rank"] - 1]
                    e["wins"] += t["rank"] == 1
                    e["legs"] += 1
        seasons.append({"label": se["label"], "start": se["start"], "done": se["done"], "started": se["started"], "legs": lg, "alive": alive, "sweep": sw,
                        "table": sorted(table.values(), key=lambda e: (-e["points"], -e["wins"]))[:12]})
    return {"concept": c, "legs": legs, "seasons": seasons, "points_scale": pts, "now": gd}


def api_qualifying(con, q):
    """Racing → Qualifying: races you have to earn a place in, the races that lead to them, and who is in so far."""
    if not has_table(con, "race_qualifications"):
        return {"targets": []}
    gd = META.get("game_date") or time.time()
    rq = rows(con, """select rq_target_race_name as target, rq_target_calendar_id as cal, rq_source_race_name as source, rq_source_racecourse_name as course,
        rq_source_calendar_id as src_cal, rq_type as type, rq_num_qualifiers as qualifiers, rq_points_granted as points from race_qualifications""")
    targets = {}
    for r in rq:
        t = targets.setdefault(r["cal"], {"cal": r["cal"], "name": r["target"], "type": r["type"], "feeders": []})
        t["feeders"].append(r)
    inst = race_instances(con, list(targets) + [r["src_cal"] for r in rq])
    hq = rows(con, """select hqp_target_calendar_id as cal, hqp_horse_id as horse_id, hqp_type as type, hqp_points as points, hqp_source_race_name as source,
        hqp_source_race_id as race_id, hqp_date_earned as date, hqp_cycle_closed as closed from horse_qualification_points""") if has_table(con, "horse_qualification_points") else []
    mine = {s["id"] for s in my_stables(con, META.get("player_id"), META.get("player_stable_id")) if s["mine"]} if META.get("player_id") else set()
    my_horses = {r[0] for r in con.execute("select horse_horse_id from horses where horse_stable_id in (%s)" % ",".join(str(int(x)) for x in mine))} if mine else set()
    for t in targets.values():
        runs = inst.get(t["cal"], [])
        t["next"] = next((r for r in runs if r["date"] > gd), None)
        t["last"] = next((r for r in reversed(runs) if r["date"] <= gd), None)
        t["course"] = (t["next"] or t["last"] or {}).get("course")
        t["course_id"] = (t["next"] or t["last"] or {}).get("course_id")
        t["grade"] = (t["next"] or t["last"] or {}).get("grade")
        opn = [h for h in hq if h["cal"] == t["cal"] and not h["closed"]]
        t["open"] = len({h["horse_id"] for h in opn})
        t["yours"] = len({h["horse_id"] for h in opn if h["horse_id"] in my_horses})
        t["scale"] = next((f["points"] for f in t["feeders"] if f["points"]), "")
    sel = q.get("target")
    for t in targets.values():
        t["feeder_n"] = len(t["feeders"])
    out = {"targets": sorted(({k: v for k, v in t.items() if k != "feeders"} for t in targets.values()), key=lambda t: ((t["next"] or {}).get("date") or 9e12, t["name"])), "now": gd}
    if sel and sel in targets:
        t = targets[sel]
        for f in t["feeders"]:
            runs = inst.get(f["src_cal"], [])
            f["next"] = next((r for r in runs if r["date"] > gd), None)
            f["last"] = next((r for r in reversed(runs) if r["date"] <= gd), None)
        t["feeders"].sort(key=lambda f: ((f["next"] or {}).get("date") or 9e12))
        opn = [h for h in hq if h["cal"] == sel and not h["closed"]]
        st = {}
        for h in opn:
            e = st.setdefault(h["horse_id"], {"horse_id": h["horse_id"], "points": 0, "qualified": 0, "earned": []})
            e["points"] += h["points"] or 0
            e["qualified"] += h["type"] == "qualifier"
            e["earned"].append({"source": h["source"], "race_id": h["race_id"], "date": h["date"], "points": h["points"], "type": h["type"]})
        info = {r[0]: r[1:] for r in con.execute("select horse_horse_id, horse_name, horse_stable_id from horses where horse_horse_id in (%s)"
                                                   % ",".join(str(int(k)) for k in st))} if st else {}
        sn = name_map(con, "stables", "stable_stable_id", "stable_name", [v[1] for v in info.values()])
        for e in st.values():
            nm, sid = info.get(e["horse_id"], (None, None))
            e.update(horse=nm, stable_id=sid, stable=sn.get(sid), yours=sid in mine)
            e["earned"].sort(key=lambda x: x["date"] or 0)
        t["standings"] = sorted(st.values(), key=lambda e: (-e["points"], -e["qualified"], e["horse"] or ""))
        t["past_cycles"] = len({(h["horse_id"], h["date"]) for h in hq if h["cal"] == sel and h["closed"]})
        out["target"] = t
    return out


# ------------------------------------------------------------------ ownership groups (16.3)
# A person's group: every stable they own outright (all its shares), plus the stables those stables hold a majority of, and so on.
# A stable not wholly owned by one person still forms a group with the stables it (or its majority parent) holds a majority of.
OWN_CACHE = {}


def ownership(con):
    """{parent: {child: parent stable holding > half its shares}, kids: {stable: [children]}, full: {stable: person owning all of it},
    by_person: {person: [stables they own outright]}, pct: {stable: (holder kind, holder id, share)}}. Kept for the loaded save."""
    if OWN_CACHE.get("gen") == DB_GEN:
        return OWN_CACHE["o"]
    o = {"parent": {}, "kids": {}, "full": {}, "by_person": {}, "pct": {}}
    if has_table(con, "stable_investors") and "stable_total_shares" in columns(con, "stables"):
        tot = {sid: t for sid, t in con.execute("select stable_stable_id, stable_total_shares from stables where stable_total_shares>0")}
        for sid, pid, hs, n in con.execute("""select investor_stable_id, coalesce(investor_person_id,0), coalesce(investor_holder_stable_id,0), sum(investor_shares_owned)
                from stable_investors group by 1, 2, 3"""):
            t = tot.get(sid)
            if not t or not n:
                continue
            share = n / float(t)
            if hs > 0 and hs != sid and share > 0.5:
                o["parent"][sid] = hs
                o["kids"].setdefault(hs, []).append(sid)
                o["pct"][sid] = ("stable", hs, share)
            elif hs <= 0 and pid > 0:
                if share >= 1 - 1e-9:
                    o["full"][sid] = pid
                    o["by_person"].setdefault(pid, []).append(sid)
                if share > 0.5 and sid not in o["pct"]:
                    o["pct"][sid] = ("person", pid, share)
    OWN_CACHE.update(gen=DB_GEN, o=o)
    return o


def own_descendants(o, roots):
    ids, stack = [], list(roots)
    while stack:
        x = stack.pop(0)
        if x in ids:
            continue
        ids.append(x)
        stack += sorted(o["kids"].get(x, []))
    return ids


def ownership_group(con, sid):
    """The stables consolidated with this one: (ids in tree order, the person owning the top outright or None)."""
    o = ownership(con)
    top, seen = sid, set()
    while top in o["parent"] and top not in seen:
        seen.add(top)
        top = o["parent"][top]
    person = o["full"].get(top)
    roots = sorted(o["by_person"][person]) if person else [top]
    return own_descendants(o, roots), person


def group_list(con, ids):
    """The group's stables for the page: name, who holds it (a person or a parent stable) and how much, closed or not."""
    o = ownership(con)
    info = {r["id"]: r for r in rows(con, "select stable_stable_id as id, stable_name as name, stable_liquidated as closed from stables where stable_stable_id in (%s)"
                                     % ",".join(str(int(i)) for i in ids))} if ids else {}
    hold = [o["pct"].get(i) for i in ids]
    pn = name_map(con, "persons", "person_person_id", "person_full_name", [h[1] for h in hold if h and h[0] == "person"])
    out = []
    for i, h in zip(ids, hold):
        r = info.get(i) or {"id": i, "name": "Stable %s" % i, "closed": 0}
        out.append({"id": i, "name": r["name"], "closed": bool(r["closed"]), "holder_kind": h[0] if h else None, "holder_id": h[1] if h else None,
                    "holder": (pn.get(h[1]) if h[0] == "person" else (info.get(h[1]) or {}).get("name")) if h else None,
                    "pct": round(100 * h[2], 2) if h else None, "parent_id": o["parent"].get(i)})
    return out


def person_owned_groups(con, pid):
    """A person's stables for their page: the ones they own outright (one group) and each majority-owned stable with sub-stables."""
    o = ownership(con)
    out = []
    full = sorted(o["by_person"].get(pid, []))
    if full:
        ids = own_descendants(o, full)
        out.append({"key": full[0], "full": True, "stables": group_list(con, ids)})
    for sid, (kind, holder, share) in sorted(o["pct"].items()):
        if kind == "person" and holder == pid and sid not in full and o["kids"].get(sid):
            out.append({"key": sid, "full": False, "stables": group_list(con, own_descendants(o, [sid]))})
    return out


def merge_horse_money(parts, ids):
    """Horse finances for a group: each horse's money in all the group's stables added up. Transfers inside the group
    (and a group stable's purchase before passing a horse on, already counted where it was bought) drop out."""
    H, tot = {}, {"inc": {}, "exp": {}}
    names = {}
    for sid, part in parts:
        for h in part.get("horses") or []:
            m = H.get(h["id"])
            if m is None:
                m = H[h["id"]] = dict(h, inc={}, exp={}, years={}, starts=0, wins=0, with_ids=[], current_in=None)
            m["with_ids"].append(sid)
            m["starts"] += h["starts"] or 0
            m["wins"] += h["wins"] or 0
            m["bred"] = m["bred"] or h["bred"]
            m["from"] = min([x for x in (m["from"], h["from"]) if x is not None], default=None)
            m["to"] = max([x for x in (m["to"], h["to"]) if x is not None], default=None)
            if h["status"] == "current":
                m["current_in"] = sid
            for k in ("inc", "exp"):
                for c, v in (h[k] or {}).items():
                    if c == "Transfer fee within the group" or c.startswith("Purchase by "):
                        continue
                    m[k][c] = m[k].get(c, 0) + v
            for y in h.get("years") or []:
                yy = m["years"].setdefault(y["year"], {"inc": 0, "exp": 0})
                yy["inc"] += y.get("inc") or 0
                yy["exp"] += y.get("exp") or 0
    out = []
    for hid, m in H.items():
        inc, exp = sum(m["inc"].values()), sum(m["exp"].values())
        for k in ("inc", "exp"):
            for c, v in m[k].items():
                tot[k][c] = tot[k].get(c, 0) + v
        if m["current_in"] is not None:
            m["status"], m["now_stable_id"], m["now_stable"] = "current", None, None
        elif m.get("now_stable_id") in ids:      # moved to another of the group's stables and left from there
            m["now_stable_id"], m["now_stable"] = None, None
        m.update(income=inc, expenses=exp, net=inc - exp, years=[{"year": y, **v} for y, v in sorted(m["years"].items())])
        out.append(m)
    out.sort(key=lambda r: (r["status"] != "current", -(r["net"] or 0)))
    return {"horses": out, "totals": tot}


def api_stable(con, sid):
    s = one(con, "select * from stables where stable_stable_id=?", (sid,))
    if not s:
        return None
    out = {"stable": clean_blob(s), "removed": removed_info(con, "stables", sid)}
    out["record"] = one(con, "select * from hrmv_stable_stats where stable_id=?", (sid,)) if has_table(con, "hrmv_stable_stats") else None
    out["owner"] = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (s.get("stable_owner_id"),))
    out["racecourses_owned"] = owned_courses(con, sid)
    out["auction_n"] = stable_auction_counts(con, sid)      # for its Auctions and Shares tabs (16.7.15)
    out["shares_n"] = stable_share_counts(con, sid)
    out["city"] = one(con, "select c.city_name as city, n.country_name as country from cities c left join countries n on n.country_id=c.city_country_id where c.city_id=?", (s.get("stable_city_id"),)) if has_table(con, "cities") and has_table(con, "countries") else None
    out["horses"] = rows(con, """select horse_horse_id as id, horse_name as name, horse_gender as gender, horse_birth_date as birth,
        horse_career_earnings as earnings, horse_international_rating as rating, horse_form as form, horse_g1_wins as g1,
        horse_value_calculated as value, horse_condition as condition
        from horses where horse_stable_id=? and horse_deceased_date is null and horse_horse_id not in (select pk from hrmv_removed where tbl='horses') order by horse_career_earnings desc""", (sid,))
    out["staff"] = rows(con, """select f.staff_current_role as role, f.staff_start_date as start, f.staff_salary_yearly as salary,
        f.staff_type_of_contract as contract, p.person_person_id as id, p.person_full_name as name
        from staff f left join persons p on p.person_person_id=f.staff_person_id
        where f.staff_stable_id=? and f.staff_end_date is null order by f.staff_current_role, p.person_full_name""", (sid,))
    if has_table(con, "stable_financial_snapshots"):
        out["finance"] = rows(con, """select snapshot_date as date, snapshot_cash as cash, snapshot_net_worth as net_worth,
            snapshot_income_total as income, snapshot_expense_total as expenses, snapshot_net_income as net_income,
            snapshot_share_price as share_price from stable_financial_snapshots where snapshot_stable_id=? order by snapshot_date""", (sid,))
        out["latest_finance"] = one(con, "select * from stable_financial_snapshots where snapshot_stable_id=? order by snapshot_date desc limit 1", (sid,))
    gids, gperson = ownership_group(con, sid)
    if len(gids) > 1:
        out["group"] = {"stables": group_list(con, gids), "person": one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?",
                                                                             (gperson,)) if gperson else None}
    # 16.8.2: stables the group (or this stable) holds shares in without a majority: not added into the group's figures
    out["group_excluded"] = []
    if has_table(con, "stable_investors"):
        mem = gids if len(gids) > 1 else [sid]
        q = ",".join(str(int(i)) for i in mem)
        out["group_excluded"] = [r for r in rows(con, """select i.investor_stable_id as id, s.stable_name as name, i.investor_holder_stable_id as holder_id,
                h.stable_name as holder, sum(i.investor_shares_owned) as shares, s.stable_total_shares as total, s.stable_liquidated as closed
                from stable_investors i join stables s on s.stable_stable_id=i.investor_stable_id left join stables h on h.stable_stable_id=i.investor_holder_stable_id
                where i.investor_holder_stable_id in (%s) and i.investor_stable_id not in (%s) group by 1, 3 having sum(i.investor_shares_owned) > 0""" % (q, q))]
        for r in out["group_excluded"]:
            r["pct"] = 100.0 * r["shares"] / r["total"] if r["total"] else None
        out["group_excluded"].sort(key=lambda r: -(r["pct"] or 0))
    out["recent_results"] = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_cash_received as prize,
        r.race_result_horse_id as horse_id, h.horse_name as horse, r.race_result_race_id as race_id, x.races_race_name as race_name,
        x.races_type_of_race as race_type, r.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey
        from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
        left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join persons j on j.person_person_id=r.race_result_person_jockey_id
        where r.race_result_stable_id=? order by r.race_result_date desc limit 100""", (sid,))
    if has_table(con, "stable_investors"):
        # a holder is a person or (16.8.1) another stable: the game leaves the person empty when a stable holds the shares
        out["investors"] = rows(con, """select case when coalesce(i.investor_holder_stable_id, 0) > 0 then 'stable' else 'person' end as kind,
            case when coalesce(i.investor_holder_stable_id, 0) > 0 then i.investor_holder_stable_id else i.investor_person_id end as id,
            coalesce(case when coalesce(i.investor_holder_stable_id, 0) > 0 then hs.stable_name else p.person_full_name end, '—') as name,
            sum(i.investor_shares_owned) as shares
            from stable_investors i left join persons p on p.person_person_id=i.investor_person_id
            left join stables hs on hs.stable_stable_id=i.investor_holder_stable_id
            where i.investor_stable_id=? group by 1, 2 order by shares desc limit 15""", (sid,))
    out["courses"] = rows(con, "select racecourse_racecourse_id as id, racecourse_name as name from racecourses where racecourse_owner_stable_id=?", (sid,))
    # 16.8.2: everything the stable owns, on one list: shares in other stables, and racecourses and auction houses (owned whole)
    hold = []
    if has_table(con, "stable_investors"):
        hold += rows(con, """select 'stable' as kind, i.investor_stable_id as id, s.stable_name as name, sum(i.investor_shares_owned) as shares,
            s.stable_total_shares as total, min(i.investor_purchase_date) as since, s.stable_liquidated as closed
            from stable_investors i join stables s on s.stable_stable_id=i.investor_stable_id
            where i.investor_holder_stable_id=? and i.investor_stable_id<>? group by i.investor_stable_id having sum(i.investor_shares_owned) > 0""", (sid, sid))
    hold += rows(con, """select 'course' as kind, racecourse_racecourse_id as id, racecourse_name as name, null as shares, null as total,
        null as since, racecourse_demolished_date as closed from racecourses where racecourse_owner_stable_id=?""", (sid,))
    if has_table(con, "auction_house"):
        hold += rows(con, """select 'house' as kind, auction_house_id as id, auction_house_name as name, null as shares, null as total,
            auction_house_founding_date as since, auction_house_demolished_date as closed from auction_house
            where auction_house_owner_entity='stable' and auction_house_owner_id=?""", (sid,))
    for r in hold:
        r["pct"] = (100.0 * r["shares"] / r["total"]) if r["kind"] == "stable" and r["total"] else (100.0 if r["kind"] != "stable" else None)
    out["holdings"] = sorted(hold, key=lambda r: ({"stable": 0, "course": 1, "house": 2}[r["kind"]], -(r["pct"] or 0), r["name"] or ""))
    return out


FIN_YEAR = "cast(strftime('%Y', {0}, 'unixepoch') as int)"


def api_stable_finance(con, sid, q):
    """Financials tab: income and expenses per year from the monthly snapshots (one column per category, as the game stores them),
    plus the expense detail for one year from the transaction log (category -> type -> individual payments)."""
    if not one(con, "select 1 as x from stables where stable_stable_id=?", (sid,)):
        return None
    out = {"income_cats": [], "expense_cats": [], "years": [], "detail": None, "detail_years": []}
    grp = ownership_group(con, sid)[0] if q.get("group") == "1" else [sid]
    if len(grp) < 2:
        grp = [sid]
    gin = ",".join(str(int(i)) for i in grp)
    SW = "snapshot_stable_id in (%s)" % gin           # the stable, or every stable in its group
    if len(grp) > 1:
        out["group"] = grp
    if has_table(con, "stable_financial_snapshots"):
        cols = columns(con, "stable_financial_snapshots")
        inc = [c for c in cols if c.startswith("snapshot_income_") and c != "snapshot_income_total"]
        exp = [c for c in cols if c.startswith("snapshot_expense_") and c != "snapshot_expense_total"]
        out["income_cats"] = [c[len("snapshot_income_"):] for c in inc]
        out["expense_cats"] = [c[len("snapshot_expense_"):] for c in exp]
        sums = ", ".join("sum(%s) as %s" % (qident(c), qident(c)) for c in inc + exp + ["snapshot_income_total", "snapshot_expense_total"])
        for r in rows(con, "select %s as year, count(distinct snapshot_date) as months, %s from stable_financial_snapshots where %s group by 1 order by 1"
                      % (FIN_YEAR.format("snapshot_date"), sums, SW)):
            out["years"].append({
                "year": r["year"], "months": r["months"],
                "income": {c[len("snapshot_income_"):]: r[c] or 0 for c in inc}, "income_total": r["snapshot_income_total"] or 0,
                "expenses": {c[len("snapshot_expense_"):]: r[c] or 0 for c in exp}, "expense_total": r["snapshot_expense_total"] or 0,
            })
        # month by month (the Financials tab's monthly breakdown)
        cols_m = ", ".join("sum(%s) as %s" % (qident(c), qident(c)) for c in inc + exp + ["snapshot_income_total", "snapshot_expense_total"])
        out["months"] = [{"date": m["date"], "year": m["year"], "income": {c[len("snapshot_income_"):]: m[c] or 0 for c in inc},
                          "income_total": m["snapshot_income_total"] or 0,
                          "expenses": {c[len("snapshot_expense_"):]: m[c] or 0 for c in exp}, "expense_total": m["snapshot_expense_total"] or 0}
                         for m in rows(con, "select snapshot_date as date, %s as year, %s from stable_financial_snapshots where %s group by snapshot_date order by snapshot_date"
                                       % (FIN_YEAR.format("snapshot_date"), cols_m, SW))]
        if len(grp) > 1:      # the group's cash, net worth, income and expenses month by month, added up
            out["group_monthly"] = rows(con, """select snapshot_date as date, sum(snapshot_cash) as cash, sum(snapshot_net_worth) as net_worth, sum(snapshot_income_total) as income,
                sum(snapshot_expense_total) as expenses, count(*) as stables from stable_financial_snapshots where %s group by snapshot_date order by snapshot_date""" % SW)
            last = out["group_monthly"][-1] if out["group_monthly"] else None
            out["group_latest"] = {"snapshot_date": last["date"], "snapshot_cash": last["cash"], "snapshot_net_worth": last["net_worth"]} if last else {}
        # a year still in progress is compared with the same months of the year before ("prev_same")
        part = [y for y in out["years"] if y["months"] < 12]
        if part:
            cols_sel = ", ".join("sum(%s) as %s" % (qident(c), qident(c)) for c in inc + exp + ["snapshot_income_total", "snapshot_expense_total"])
            monthly = rows(con, "select %s as year, cast(strftime('%%m', snapshot_date, 'unixepoch') as int) as month, %s from stable_financial_snapshots where %s group by snapshot_date"
                           % (FIN_YEAR.format("snapshot_date"), cols_sel, SW))
            for y in part:
                months = {m["month"] for m in monthly if m["year"] == y["year"]}
                prev = [m for m in monthly if m["year"] == y["year"] - 1 and m["month"] in months]
                if prev:
                    y["prev_same"] = {
                        "year": y["year"] - 1, "months": sorted(months),
                        "income": {c[len("snapshot_income_"):]: sum(m[c] or 0 for m in prev) for c in inc},
                        "income_total": sum(m["snapshot_income_total"] or 0 for m in prev),
                        "expenses": {c[len("snapshot_expense_"):]: sum(m[c] or 0 for m in prev) for c in exp},
                        "expense_total": sum(m["snapshot_expense_total"] or 0 for m in prev),
                    }
    if has_table(con, "transactions"):
        # money paid out by the stable (or, with dir=in, paid to it); the game's "Yearly Summary" rows roll up years it no longer
        # keeps in detail, so they're left out
        incoming = q.get("dir") == "in"
        out["detail_dir"] = "in" if incoming else "out"
        me, other = ("to", "from") if incoming else ("from", "to")
        if len(grp) > 1:     # the group's payments to and from outside it (money moved between its own stables drops out)
            base = """from transactions where transaction_%s_entity_type='stable' and transaction_%s_entity_id in (%s) and ? is not null
                and not (transaction_%s_entity_type='stable' and transaction_%s_entity_id in (%s))
                and coalesce(transaction_type,'') <> 'Yearly Summary'""" % (me, me, gin, other, other, gin)
            out["internal"] = rows(con, """select %s as year, count(*) as n, sum(transaction_amount) as total from transactions
                where transaction_from_entity_type='stable' and transaction_to_entity_type='stable' and transaction_from_entity_id in (%s)
                and transaction_to_entity_id in (%s) and coalesce(transaction_type,'') <> 'Yearly Summary' group by 1 order by 1"""
                                   % (FIN_YEAR.format("transaction_date"), gin, gin))
        else:
            base = """from transactions where transaction_%s_entity_type='stable' and transaction_%s_entity_id=?
                and coalesce(transaction_type,'') <> 'Yearly Summary'""" % (me, me)
        yr = FIN_YEAR.format("transaction_date")
        out["detail_years"] = [r["year"] for r in rows(con, "select distinct %s as year %s order by 1" % (yr, base), (sid,))]
        snap_years = sorted({m["year"] for m in out.get("months") or [] if m.get("year")})
        first = rows(con, "select min(transaction_date) as d %s" % base, (sid,))
        out["detail_from"] = first[0]["d"] if first else None     # when the payment log starts
        # any year on record can be picked: years in the payment log get the full detail, older ones are shown
        # from the monthly figures on the page (the game only keeps a yearly total of their payments)
        year = to_int(q.get("year"), 0) or (out["detail_years"][-1] if out["detail_years"] else (snap_years[-1] if snap_years else 0))
        out["detail_year"] = year
        month = to_int(q.get("month"), 0)
        if year in out["detail_years"]:
            out["detail_months"] = [r["m"] for r in rows(con, "select distinct cast(strftime('%%m', transaction_date, 'unixepoch') as int) as m %s and %s = ? order by 1" % (base, yr), (sid, year))]
            if month not in out["detail_months"]:
                month = 0
            if month:
                lo = calendar.timegm((year, month, 1, 0, 0, 0))
                hi = calendar.timegm((year + (month == 12), month % 12 + 1, 1, 0, 0, 0))
            else:
                lo, hi = calendar.timegm((year, 1, 1, 0, 0, 0)), calendar.timegm((year + 1, 1, 1, 0, 0, 0))
            cats = {}
            for r in rows(con, """select transaction_category as cat, transaction_type as type, count(*) as n, sum(transaction_amount) as total
                    %s and transaction_date >= ? and transaction_date < ? group by 1, 2""" % base, (sid, lo, hi)):
                c = cats.setdefault(r["cat"] or "", {"cat": r["cat"] or "", "total": 0, "n": 0, "types": []})
                c["total"] += r["total"] or 0
                c["n"] += r["n"]
                c["types"].append({"type": r["type"] or "", "n": r["n"], "total": r["total"] or 0, "items": []})
            items = rows(con, """select transaction_category as cat, transaction_type as type, transaction_date as date, transaction_amount as amount,
                    transaction_note as note, transaction_%s_entity_type as to_type, transaction_%s_entity_id as to_id
                    %s and transaction_date >= ? and transaction_date < ? order by transaction_date desc, transaction_transaction_id desc""" % (other, other, base), (sid, lo, hi))
            # names for who was paid (people and stables; other payees are the bank, a racecourse and so on)
            def to_int_id(v):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
            pn = name_map(con, "persons", "person_person_id", "person_full_name", [to_int_id(i["to_id"]) for i in items if i["to_type"] == "person"])
            sn = name_map(con, "stables", "stable_stable_id", "stable_name", [to_int_id(i["to_id"]) for i in items if i["to_type"] == "stable"])
            cn = name_map(con, "racecourses", "racecourse_racecourse_id", "racecourse_name", [to_int_id(i["to_id"]) for i in items if i["to_type"] == "racecourse"]) \
                if has_table(con, "racecourses") else {}
            for it in items:
                it["to_id"] = to_int_id(it["to_id"])
                it["to_name"] = {"person": pn, "stable": sn, "racecourse": cn}.get(it["to_type"], {}).get(it["to_id"])
            find = {(c["cat"], t["type"]): t for c in cats.values() for t in c["types"]}
            for it in items:
                t = find.get((it["cat"] or "", it["type"] or ""))
                if t is not None and len(t["items"]) < 200:      # newest 200 payments per type
                    t["items"].append(it)
            # money in for covers by your stallions: one more level, by horse
            if incoming:
                for c in cats.values():
                    if c["cat"] != "breeding_fees":
                        continue
                    for t in c["types"]:
                        its = [it for it in items if (it["cat"] or "") == c["cat"] and (it["type"] or "") == t["type"]]
                        by = stud_income_by_horse(con, sid, its)
                        if by:
                            t["horses"] = by
            for c in cats.values():
                c["types"].sort(key=lambda t: -(t["total"] or 0))
            out["detail"] = {"year": year, "month": month or None, "categories": sorted(cats.values(), key=lambda c: -(c["total"] or 0)),
                             "total": sum(c["total"] for c in cats.values())}
    return out


BF_FEE = re.compile(r"^Breeding fee for (.+?)\.(?:\s+Expected foal\b.*)?\s*$", re.S)
BF_FAIL = re.compile(r"^Breeding failure between (.+?)\.?\s*$", re.S)


def stud_income_by_horse(con, sid, items):
    """Breeding money paid to a stable, split by its horse. The game notes a cover as "Breeding fee for <mare> and
    <stallion>. Expected foal: ..." (paid by the mare's owner) and a refund as "Breeding failure between <a> and <b>.",
    so the horse is the one of the two the stable owns (its stallion), or else the stallion. Returns
    [{hid, name, gender, stable_id, stable, n, total, items}] biggest first, or [] when the notes don't name horses."""
    names = bare_horse_names(con)
    bare = lambda n: HM_NAME_PREFIX.sub("", n).strip().lower()
    parsed, want = [], set()
    for it in items:
        note = (it.get("note") or "").strip()
        m, fee = BF_FEE.match(note), True
        if not m:
            m, fee = BF_FAIL.match(note), False
        if not m:
            parsed.append((it, None, fee))
            continue
        parts = m.group(1).split(" and ")
        cands = []
        for i in range(1, len(parts)):          # a name can itself contain "and": try every split
            for nm in (" and ".join(parts[:i]), " and ".join(parts[i:])):
                for hid, st in names.get(bare(nm), []):
                    cands.append((hid, st))
                    want.add(hid)
        parsed.append((it, cands, fee))
    if not want:
        return []
    gender = {}
    ids = sorted(want)
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        for hid, g in con.execute("select horse_horse_id, horse_gender from horses where horse_horse_id in (%s)" % ",".join("?" * len(chunk)), chunk):
            gender[hid] = (g or "").lower()
    by = {}
    for it, cands, fee in parsed:
        hid = None
        if cands:
            mine = lambda h: str(h[1]) == str(sid)      # (fee or refund, the stable's own horse first)
            stal = lambda h: gender.get(h[0]) == "stallion"
            order = sorted(cands, key=lambda h: (not mine(h), not stal(h), h[0]))
            hid = order[0][0]
        e = by.setdefault(hid, {"hid": hid, "n": 0, "total": 0, "items": []})
        e["n"] += 1
        e["total"] += it.get("amount") or 0
        if len(e["items"]) < 300:
            e["items"].append(it)
    info = {}
    hids = [h for h in by if h is not None]
    for i in range(0, len(hids), 900):
        chunk = hids[i:i + 900]
        for hid, nm, g, st in con.execute("select horse_horse_id, horse_name, horse_gender, horse_stable_id from horses where horse_horse_id in (%s)" % ",".join("?" * len(chunk)), chunk):
            info[hid] = (nm, g, st)
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [to_int(v[2], None) for v in info.values()])
    for h, e in by.items():
        nm, g, st = info.get(h, (None, None, None))
        e.update(name=nm, gender=g, stable_id=to_int(st, None), stable=sn.get(to_int(st, None)))
    return sorted(by.values(), key=lambda e: (e["hid"] is None, -(e["total"] or 0)))


HM_NAME_PREFIX = re.compile(r"^(?:†\s*|\([A-Z]{1,3}\)\s*)+")
# payments to or from the stable whose note names one of its horses (sponsorship "for X", win shares "for X in Race",
# "stall rest treatment for X", "Surgery ... of X", "Freelance jockey fee for X, ..."). Race prizes come from the race results
# instead, and the roll-ups/internal transfers aren't horse money.
HM_TX_SKIP = ("Yearly Summary", "Prize", "Transfer", "transfer")
HM_TX_LABELS = {
    "exp": {"Win Share": "Win shares (jockey & trainer)", "Breeder Fee": "Breeder fees paid", "Treatment": "Vet treatment",
            "Veterinary": "Vet & surgery", "Freelance Jockey Fee": "Freelance jockey fees", "Fee": "Other fees (registration, rehoming…)",
            "Auction Commission": "Auction commission"},
    "inc": {"Breeder Fee": "Breeder fees received", "Win Share": "Win shares received", "Award Prize": "Award prizes"},
}


HM_TRADE_NOTE = re.compile(r"^.* purchased (.+) from .+\.$")


def stable_group(con, sid):
    """A stable and the stables tied to it: its parent stable, its sub-stables, and its parent's other sub-stables."""
    if "stable_parent_stable_id" not in columns(con, "stables"):
        return {sid}
    r = one(con, "select stable_parent_stable_id as p from stables where stable_stable_id=?", (sid,)) or {}
    top = r.get("p") if r.get("p") and r["p"] > 0 else sid
    ids = {sid, top} | {x["id"] for x in rows(con, "select stable_stable_id as id from stables where stable_parent_stable_id in (?, ?)", (sid, top))}
    return ids


BARE_NAMES = {}


def bare_horse_names(con):
    """Every horse by its name without the game's prefixes, lower case: {name: [(id, stable id), ...]} in id order.
    Worked out once per loaded save."""
    if BARE_NAMES.get("gen") != DB_GEN:
        out = {}
        sub = HM_NAME_PREFIX.sub
        for hid, name, stable in con.execute("select horse_horse_id, horse_name, horse_stable_id from horses where horse_name is not null order by horse_horse_id"):
            bare = (sub("", name) if name[:1] in ("(", "\u2020", " ") else name).strip().lower()
            out.setdefault(bare, []).append((hid, stable))
        BARE_NAMES.clear()
        BARE_NAMES.update(gen=DB_GEN, names=out)
    return BARE_NAMES["names"]


def horse_trades(con, sid):
    """Private horse sales involving this stable or its group: {hid, date, amount, buyer, seller, internal}.
    The game notes them as "<buyer> purchased <horse> from <seller>." and pays from the buying stable to the selling one."""
    tcols = columns(con, "transactions")
    if not {"transaction_category", "transaction_note", "transaction_from_entity_type", "transaction_to_entity_type"} <= set(tcols):
        return []
    group = sorted(stable_group(con, sid))
    marks = ",".join("?" * len(group))
    tx = rows(con, """select transaction_date as date, transaction_amount as amount, transaction_note as note,
            cast(transaction_from_entity_id as int) as buyer, cast(transaction_to_entity_id as int) as seller from transactions
            where transaction_category='horse_trade' and transaction_from_entity_type='stable' and transaction_to_entity_type='stable'
            and (transaction_from_entity_id in (%s) or transaction_to_entity_id = ?)""" % marks, group + [sid])
    if not tx:
        return []
    wanted = {}
    for t in tx:
        m = HM_TRADE_NOTE.match(t["note"] or "")
        if m:
            wanted.setdefault(HM_NAME_PREFIX.sub("", m.group(1)).strip().lower(), []).append(t)
    # horse names in notes can carry the game's prefixes ((F), (P), †) or not, so match on the bare name
    names = bare_horse_names(con)
    ids = {}
    for bare in wanted:
        for hid, stable in names.get(bare, ()):
            prev = ids.get(bare)
            # several horses with the same name: prefer one that has been with the group
            if prev is None or (stable in group and prev[1] not in group):
                ids[bare] = (hid, stable)
    out = []
    for bare, ts in wanted.items():
        if bare not in ids:
            continue
        for t in ts:
            out.append({"hid": ids[bare][0], "date": t["date"], "amount": t["amount"] or 0, "buyer": t["buyer"], "seller": t["seller"],
                        "internal": t["buyer"] in group and t["seller"] in group})
    out.sort(key=lambda t: t["date"] or 0)
    return out


def api_stable_horse_money(con, sid, q):
    """Horse finances tab: money in and out for every horse the stable has had, now or in the past.
    Each horse's figures only count what happened while it was with this stable (as far as the save can tell).
    With group=1: every horse of the stable's ownership group, its money in all the group's stables added up."""
    if not one(con, "select 1 as x from stables where stable_stable_id=?", (sid,)):
        return None
    if q.get("group") == "1":
        grp = ownership_group(con, sid)[0]
        if len(grp) > 1:
            out = merge_horse_money([(g, api_stable_horse_money(con, g, {})) for g in grp], set(grp))
            sn = name_map(con, "stables", "stable_stable_id", "stable_name", grp)
            for h in out["horses"]:
                h["with"] = [{"id": g, "name": sn.get(g)} for g in h.pop("with_ids")]
                h.pop("current_in", None)
            out.update(now=META.get("game_date"), group=grp)
            return out
    has = lambda t: has_table(con, t)
    H = {}

    def horse(hid):
        if hid in (None, 0, -1):
            return None
        return H.setdefault(hid, {"id": hid, "starts": 0, "wins": 0, "first": None, "last": None, "bought": None, "sold": None, "bred": False,
                                  "inc": {}, "exp": {}, "years": {}})

    def seen(h, ts):
        if isinstance(ts, (int, float)):
            h["first"] = ts if h["first"] is None else min(h["first"], ts)
            h["last"] = ts if h["last"] is None else max(h["last"], ts)

    for r in rows(con, "select horse_horse_id as id from horses where horse_stable_id=?", (sid,)):
        horse(r["id"])["current"] = True
    for r in rows(con, """select race_result_horse_id as id, count(*) as starts, sum(case when race_result_rank=1 then 1 else 0 end) as wins,
            min(race_result_date) as a, max(race_result_date) as b from race_results where race_result_stable_id=? group by 1""", (sid,)):
        h = horse(r["id"])
        if h:
            h["starts"], h["wins"] = r["starts"], r["wins"] or 0
            seen(h, r["a"]); seen(h, r["b"])
    auctions = rows(con, """select auction_result_horse_id as id, auction_result_date as date, auction_result_final_price as price,
            auction_result_cut_to_auctionhouse as cut, auction_result_from_stable_id as frm, auction_result_to_stable_id as too
            from auction_results where auction_result_accepted=1 and (auction_result_to_stable_id=? or auction_result_from_stable_id=?)""", (sid, sid)) if has("auction_results") else []
    for a in auctions:
        h = horse(a["id"])
        if h:
            if a["too"] == sid:
                h["bought"] = a["date"] if h["bought"] is None else min(h["bought"], a["date"])
            if a["frm"] == sid:
                h["sold"] = a["date"] if h["sold"] is None else max(h["sold"], a["date"])
            seen(h, a["date"])
    trades = horse_trades(con, sid) if has("transactions") else []
    for t in trades:      # private sales: buying a horse brings it to the stable, selling it ends its time here
        if t["buyer"] == sid:
            h = horse(t["hid"])
            if h:
                h["bought"] = t["date"] if h["bought"] is None else min(h["bought"], t["date"])
                seen(h, t["date"])
        elif t["seller"] == sid:
            h = horse(t["hid"])
            if h:
                h["sold"] = t["date"] if h["sold"] is None else max(h["sold"], t["date"])
                seen(h, t["date"])
    hfh = rows(con, "select hfh_horse_id as id, hfh_year as year, hfh_feed_care as feed, hfh_staff_costs as staff from horse_financial_history where hfh_stable_id=?", (sid,)) if has("horse_financial_history") else []
    for r in hfh:
        h = horse(r["id"])
        if h and r["year"]:
            seen(h, calendar.timegm((r["year"], 1, 1, 0, 0, 0)))
    if has("breeding"):
        for r in rows(con, "select breeding_horse_id as id, breeding_birth_date as born from breeding where breeding_stable_id=? and breeding_horse_id>0", (sid,)):
            h = horse(r["id"])
            if h:
                h["bred"] = True
                seen(h, r["born"])
    if not H:
        return {"horses": [], "totals": {"inc": {}, "exp": {}}, "now": META.get("game_date")}
    ids = list(H)
    info = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in rows(con, """select horse_horse_id as id, horse_name as name, horse_gender as sex, horse_birth_date as birth, horse_deceased_date as died,
                horse_stable_id as stable_id from horses where horse_horse_id in (%s)""" % ",".join("?" * len(chunk)), chunk):
            info[r["id"]] = r
    # when the horse was with the stable: from purchase (or birth, or the first thing seen) until sale, death or now
    for hid, h in H.items():
        i = info.get(hid) or {}
        start = h["bought"] if h["bought"] is not None else (i.get("birth") if h["bred"] else h["first"])
        if h.get("current"):
            end = None
        elif h["sold"] is not None:
            end = h["sold"]
        else:
            end = i.get("died") or h["last"]
        h["from"], h["to"] = start, end

    def within(h, ts):
        return isinstance(ts, (int, float)) and (h["from"] is None or ts >= h["from"] - 86400 * 31) and (h["to"] is None or ts <= h["to"] + 86400 * 31)

    def put(hid, kind, cat, year, amount):
        h = H.get(hid)
        if not h or not amount:
            return
        book = h["inc" if kind == "inc" else "exp"]
        book[cat] = book.get(cat, 0) + amount
        if year:
            y = h["years"].setdefault(str(year), {"inc": 0, "exp": 0})
            y["inc" if kind == "inc" else "exp"] += amount

    yr = lambda ts: utc_year(ts) if isinstance(ts, (int, float)) and ts > -2e10 else None
    # income: prize money while racing for the stable, sales, stud fees, and named payments
    for r in rows(con, """select race_result_horse_id as id, cast(strftime('%Y', race_result_date, 'unixepoch') as int) as year, sum(race_result_cash_received) as prize
            from race_results where race_result_stable_id=? group by 1, 2""", (sid,)):
        put(r["id"], "inc", "Prize money", r["year"], r["prize"] or 0)
    # auction sales: the game also books an auction as a horse-trade payment for the full price, plus an
    # "Auction Commission" payment from the seller, and both are counted below. So an auction only counts here when
    # there's no such payment for it (older auctions in long saves): the full price, and the auction house's cut as a cost.
    def paid_as_trade(a):
        return any(t["hid"] == a["id"] and abs((t["date"] or 0) - (a["date"] or 0)) <= 7 * 86400 and abs((t["amount"] or 0) - (a["price"] or 0)) < 1 for t in trades)
    for a in auctions:
        if paid_as_trade(a):
            continue
        if a["frm"] == sid:
            put(a["id"], "inc", "Sale", yr(a["date"]), a["price"] or 0)
            put(a["id"], "exp", "Auction commission", yr(a["date"]), a["cut"] or 0)
        if a["too"] == sid:
            put(a["id"], "exp", "Purchase", yr(a["date"]), a["price"] or 0)
    # private sales: the price this stable paid or got, and what one of its group's stables (its parent, sub-stables or their
    # sister stables) paid for a horse before passing it on to this stable
    group_names = name_map(con, "stables", "stable_stable_id", "stable_name", list({t["buyer"] for t in trades}))
    for t in trades:
        if t["buyer"] == sid:
            put(t["hid"], "exp", "Transfer fee within the group" if t["internal"] else "Purchase", yr(t["date"]), t["amount"])
        elif t["seller"] == sid:
            put(t["hid"], "inc", "Sale" if not t["internal"] else "Transfer fee within the group", yr(t["date"]), t["amount"])
        elif not t["internal"] and t["hid"] in H:
            h = H[t["hid"]]
            # bought by a group stable before it came here (not after it left)
            if h["from"] is None or t["date"] <= h["from"] + 86400 * 31:
                put(t["hid"], "exp", "Purchase by %s" % (group_names.get(t["buyer"]) or "a group stable"), yr(t["date"]), t["amount"])
    if has("breeding"):
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            for r in rows(con, "select breeding_stallion_id as id, breeding_birth_date as d, breeding_fee as fee, breeding_stable_id as payer from breeding where breeding_stallion_id in (%s) and breeding_fee>0" % marks, chunk):
                if r["payer"] != sid and within(H[r["id"]], r["d"]):
                    put(r["id"], "inc", "Stud fees", yr(r["d"]), r["fee"])
            for r in rows(con, "select breeding_mare_id as id, breeding_birth_date as d, breeding_fee as fee from breeding where breeding_mare_id in (%s) and breeding_stable_id=? and breeding_fee>0" % marks, chunk + [sid]):
                put(r["id"], "exp", "Breeding fees", yr(r["d"]), r["fee"])
    # expenses: race entry fees, feed/care/training (yearly records, then monthly ones for years not in them), travel
    for r in rows(con, """select r.race_result_horse_id as id, cast(strftime('%Y', r.race_result_date, 'unixepoch') as int) as year, sum(x.races_entrance_fee) as fee
            from race_results r join races x on x.races_race_id=r.race_result_race_id where r.race_result_stable_id=? and r.race_result_race_id>0 group by 1, 2""", (sid,)):
        put(r["id"], "exp", "Race entry fees", r["year"], r["fee"] or 0)
    hfh_years = {}
    for r in hfh:
        hfh_years.setdefault(r["id"], set()).add(r["year"])
        put(r["id"], "exp", "Feed & care", r["year"], r["feed"] or 0)
        put(r["id"], "exp", "Staff costs", r["year"], r["staff"] or 0)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        marks = ",".join("?" * len(chunk))
        if has("training_fee_months"):
            for r in rows(con, "select tfm_horse_id as id, tfm_month as m, tfm_nutrition_cost as n, tfm_care_cost as c, tfm_training_cost as t from training_fee_months where tfm_horse_id in (%s)" % marks, chunk):
                y = yr(r["m"])
                if within(H[r["id"]], r["m"]) and y not in hfh_years.get(r["id"], ()):
                    put(r["id"], "exp", "Feed & care", y, (r["n"] or 0) + (r["c"] or 0))
                    put(r["id"], "exp", "Training", y, r["t"] or 0)
        if has("travel_history"):
            for r in rows(con, "select travel_history_entity_id as id, travel_history_departure_date as d, travel_history_cost as c from travel_history where travel_history_entity_type='horse' and travel_history_entity_id in (%s)" % marks, chunk):
                if within(H[r["id"]], r["d"]):
                    put(r["id"], "exp", "Travel", yr(r["d"]), r["c"] or 0)
        if has("horse_travel_cost_archive"):
            for r in rows(con, "select archive_horse_id as id, archive_travel_cost as c from horse_travel_cost_archive where archive_horse_id in (%s)" % marks, chunk):
                if H[r["id"]].get("current"):     # a lifetime total with no dates: only counted for horses still here
                    put(r["id"], "exp", "Travel (earlier, lifetime total)", None, r["c"] or 0)
    # payments whose note names one of the horses
    if has("transactions"):
        names = {}
        for hid in ids:
            nm = HM_NAME_PREFIX.sub("", (info.get(hid) or {}).get("name") or "").strip()
            if len(nm) >= 3:
                names.setdefault(nm.lower(), hid)
        if names:
            rx = re.compile(r"(?<![\w'])(%s)(?![\w'])" % "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)), re.I)
            skip = ",".join("'%s'" % t for t in HM_TX_SKIP)
            for kind, side in (("exp", "from"), ("inc", "to")):
                for r in rows(con, """select transaction_type as type, transaction_date as d, transaction_amount as amt, transaction_note as note from transactions
                        where transaction_%s_entity_type='stable' and transaction_%s_entity_id=? and coalesce(transaction_type,'') not in (%s)""" % (side, side, skip), (sid,)):
                    m = rx.search(HM_NAME_PREFIX.sub("", r["note"] or "")) or rx.search(r["note"] or "")
                    if m:
                        put(names[m.group(1).lower()], kind, HM_TX_LABELS[kind].get(r["type"], r["type"] or "Other"), yr(r["d"]), r["amt"] or 0)
    out, tot = [], {"inc": {}, "exp": {}}
    cur_names = name_map(con, "stables", "stable_stable_id", "stable_name", [(info.get(h) or {}).get("stable_id") for h in ids])
    for hid, h in H.items():
        i = info.get(hid) or {}
        inc, exp = sum(h["inc"].values()), sum(h["exp"].values())
        for k in ("inc", "exp"):
            for c, v in h[k].items():
                tot[k][c] = tot[k].get(c, 0) + v
        status = "current" if h.get("current") else "sold" if h["sold"] is not None else "died" if i.get("died") else "left"
        out.append({"id": hid, "name": i.get("name") or "Horse %s" % hid, "sex": i.get("sex"), "birth": i.get("birth"), "died": i.get("died"),
                    "status": status, "from": h["from"], "to": h["to"], "starts": h["starts"], "wins": h["wins"], "bred": h["bred"],
                    "now_stable_id": i.get("stable_id") if status != "current" else None,
                    "now_stable": cur_names.get(i.get("stable_id")) if status != "current" else None,
                    "income": inc, "expenses": exp, "net": inc - exp, "inc": h["inc"], "exp": h["exp"],
                    "years": [{"year": int(y), **v} for y, v in sorted(h["years"].items())]})
    out.sort(key=lambda r: (r["status"] != "current", -(r["net"] or 0)))
    return {"horses": out, "totals": tot, "now": META.get("game_date")}


PEOPLE_SORTS = {"fame": "p.person_fame_calculated", "name": "p.person_full_name", "jockey_wins": "p.person_jockey_wins",
                "jockey_winnings": "p.person_jockey_winnings", "birth": "p.person_birth_date", "reputation": "p.person_reputation"}


def api_people(con, q):
    where, params = [], []
    join = ""
    if q.get("q"):
        where.append("p.person_full_name like ?")
        params.append("%" + q["q"] + "%")
    if (q.get("status") or "alive") == "alive":
        where.append("p.person_deceased_date is null and p.person_person_id not in (select pk from hrmv_removed where tbl='persons')")
    elif q.get("status") == "dead":
        where.append("(p.person_deceased_date is not null or p.person_person_id in (select pk from hrmv_removed where tbl='persons'))")
    role = q.get("role")
    if role:
        join = " join staff f on f.staff_person_id=p.person_person_id and f.staff_end_date is null and f.staff_current_role=?"
        params.insert(0, role)
    if q.get("lang") and has_table(con, "person_languages"):      # speaks this language (16.5)
        where.append("p.person_person_id in (select person_id from person_languages where language=?)")
        params.append(q["lang"])
    sort, d = sort_args(q, PEOPLE_SORTS, "fame")
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    total = count_rows(con, "select count(*) from persons p" + join + w, params)
    data = rows(con, """select p.person_person_id as id, p.person_full_name as name, p.person_sex as sex, p.person_birth_date as birth,
        p.person_deceased_date as died, p.person_fame_calculated as fame, p.person_reputation as reputation,
        p.person_jockey_starts as jockey_starts, p.person_jockey_wins as jockey_wins, p.person_jockey_winnings as jockey_winnings,
        (select f2.staff_current_role from staff f2 where f2.staff_person_id=p.person_person_id and f2.staff_end_date is null limit 1) as role,
        (select f3.staff_stable_id from staff f3 where f3.staff_person_id=p.person_person_id and f3.staff_end_date is null limit 1) as stable_id
        from persons p""" + join + w + " order by %s %s limit %d offset %d" % (sort, d, page_size(), off), params)
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in data])
    for r in data:
        r["stable_name"] = sn.get(r["stable_id"])
    if has_table(con, "person_languages") and data:
        lg = {}
        for pid, lang in con.execute("select person_id, language from person_languages where person_id in (%s) order by skill desc" % ",".join(str(int(r["id"])) for r in data)):
            lg.setdefault(pid, []).append(lang)
        for r in data:
            r["languages"] = lg.get(r["id"], [])
    out = {"total": total, "page": page, "page_size": page_size(), "rows": data}
    if q.get("meta") == "1":
        out["languages"] = language_list(con)
    return out


# People → Jockeys: every person's jockey, trainer and stable (management) numbers side by side
CAREER_SORTS = {"name": "p.person_full_name", "birth": "p.person_birth_date",
                "jockey_starts": "p.person_jockey_starts", "jockey_wins": "p.person_jockey_wins", "jockey_winnings": "p.person_jockey_winnings",
                "jockey_strike": "(1.0*p.person_jockey_wins/nullif(p.person_jockey_starts,0))",
                "trainer_starts": "(coalesce(p.person_trainer_starts,0)+coalesce(p.person_head_trainer_starts,0))",
                "trainer_wins": "(coalesce(p.person_trainer_wins,0)+coalesce(p.person_head_trainer_wins,0))",
                "trainer_winnings": "(coalesce(p.person_trainer_winnings,0)+coalesce(p.person_head_trainer_career_winnings,0))",
                "trainer_strike": "(1.0*(coalesce(p.person_trainer_wins,0)+coalesce(p.person_head_trainer_wins,0))/nullif(coalesce(p.person_trainer_starts,0)+coalesce(p.person_head_trainer_starts,0),0))",
                "mgmt_winnings": "p.person_management_career_winnings", "mgmt_exp": "p.person_management_experience",
                "reputation": "p.person_reputation"}
CAREER_VIEWS = {
    "jockeys": ("coalesce(p.person_jockey_starts,0) > 0", "jockey_wins"),
    "trainers": ("coalesce(p.person_trainer_starts,0) + coalesce(p.person_head_trainer_starts,0) > 0", "trainer_wins"),
    "managers": ("(coalesce(p.person_management_career_winnings,0) > 0 or p.person_person_id in (select staff_person_id from staff where staff_current_role='Manager'))", "mgmt_winnings"),
    "all": ("(coalesce(p.person_jockey_starts,0) + coalesce(p.person_trainer_starts,0) + coalesce(p.person_head_trainer_starts,0) > 0 or coalesce(p.person_management_career_winnings,0) > 0)", "jockey_wins"),
}


def api_careers(con, q):
    view = q.get("view") if q.get("view") in CAREER_VIEWS else "jockeys"
    cond, default_sort = CAREER_VIEWS[view]
    where, params = [cond], []
    if q.get("q"):
        where.append("p.person_full_name like ?")
        params.append("%" + q["q"] + "%")
    if (q.get("status") or "alive") == "alive":
        where.append("p.person_deceased_date is null and p.person_person_id not in (select pk from hrmv_removed where tbl='persons')")
    elif q.get("status") == "dead":
        where.append("(p.person_deceased_date is not null or p.person_person_id in (select pk from hrmv_removed where tbl='persons'))")
    if q.get("job"):     # what they do now
        where.append("p.person_person_id in (select staff_person_id from staff where staff_end_date is null and staff_current_role=?)")
        params.append(q["job"])
    sort, d = sort_args(q, CAREER_SORTS, default_sort)
    page, off = page_args(q)
    w = " where " + " and ".join(where)
    total = count_rows(con, "select count(*) from persons p" + w, params)
    data = rows(con, """select p.person_person_id as id, p.person_full_name as name, p.person_birth_date as birth, p.person_deceased_date as died,
        p.person_is_player as is_player, p.person_reputation as reputation,
        p.person_jockey_starts as j_starts, p.person_jockey_wins as j_wins, p.person_jockey_winnings as j_prize, p.person_jockey_ranking as j_rank,
        coalesce(p.person_trainer_starts,0)+coalesce(p.person_head_trainer_starts,0) as t_starts,
        coalesce(p.person_trainer_wins,0)+coalesce(p.person_head_trainer_wins,0) as t_wins,
        coalesce(p.person_trainer_winnings,0)+coalesce(p.person_head_trainer_career_winnings,0) as t_prize,
        p.person_head_trainer_wins as ht_wins,
        p.person_management_career_winnings as m_prize, p.person_management_experience as m_exp
        from persons p""" + w + " order by %s %s nulls last, p.person_person_id limit %d offset %d" % (sort, d, page_size(), off), params)
    ids = [r["id"] for r in data]
    if ids:
        qm = ",".join("?" * len(ids))
        jobs = {}
        for r in rows(con, """select f.staff_person_id as pid, f.staff_current_role as role, f.staff_stable_id as sid, s.stable_name as stable,
                t.wins as s_wins, t.starts as s_starts, t.prize as s_prize, t.g1 as s_g1
                from staff f left join stables s on s.stable_stable_id=f.staff_stable_id left join hrmv_stable_stats t on t.stable_id=f.staff_stable_id
                where f.staff_end_date is null and f.staff_person_id in (%s) order by f.staff_start_date""" % qm, ids):
            jobs.setdefault(r["pid"], []).append(r)
        managed = {}
        for r in rows(con, """select f.staff_person_id as pid, count(distinct f.staff_stable_id) as n from staff f
                where f.staff_current_role='Manager' and f.staff_person_id in (%s) group by 1""" % qm, ids):
            managed[r["pid"]] = r["n"]
        for r in data:
            js = jobs.get(r["id"]) or []
            # their main job: managing first, then training, then riding
            rank = {"Manager": 0, "Assistant manager": 1, "Head trainer": 2, "Trainer": 3, "Jockey": 4}
            js.sort(key=lambda j: (rank.get(j["role"], 9), j["sid"] != META.get("player_stable_id")))
            r["jobs"] = [{"role": j["role"], "stable_id": j["sid"], "stable": j["stable"]} for j in js]
            top = js[0] if js else None
            r.update({"stable_id": top and top["sid"], "stable": top and top["stable"], "s_wins": top and top["s_wins"],
                      "s_starts": top and top["s_starts"], "s_prize": top and top["s_prize"], "s_g1": top and top["s_g1"],
                      "managed_ever": managed.get(r["id"], 0)})
    return {"total": total, "page": page, "page_size": page_size(), "rows": data, "view": view}


# ------------------------------------------------------------------ People overview
# Three sections (jockeys, trainers, managers) built the same way, then the latest awards and news about people.
# A race "belongs" to a person through the race result: the jockey who rode, the trainer or head trainer of the horse,
# or the stable's manager at the time. Group = races of type G1, G2 or G3; Listed = type "listed".
PO_ROLES = {
    "jockeys": {"jobs": ("Jockey",), "cols": ("race_result_person_jockey_id",),
                "rank": "coalesce(p.person_jockey_wins,0)"},
    "trainers": {"jobs": ("Trainer", "Head trainer"), "cols": ("race_result_trainer_id", "race_result_stable_head_trainer_id"),
                 "rank": "coalesce(p.person_trainer_wins,0)+coalesce(p.person_head_trainer_wins,0)"},
    "managers": {"jobs": ("Manager",), "cols": ("race_result_stable_manager_id",),
                 "rank": "coalesce(p.person_management_career_winnings,0)"},
}
PO_TOP = 8           # people per section
PO_LATEST = 15       # awards / news items sent (the compact panels show the first few)
PO_NEWS_TYPES = ("HIRE_STAFF", "FIRE_STAFF", "STAFF_RESIGNATION", "STAFF_ROLE_CHANGE", "MARRIAGE_PROPOSAL", "DIVORCE_REQUEST",
                 "SECRET_EXPOSED", "RUMOR", "TRAINING_SUCCESS", "PRAISE")


PO_AGG = {}          # (data generation, role, year) -> every person's figures in that role, best first
PO_PAGE = 25         # people per page when showing everyone


EPOCH = datetime.datetime(1970, 1, 1)


def utc_year(ts):
    """Calendar year (UTC) of a game timestamp. Works for dates before 1970 too: Windows' time.gmtime and
    utcfromtimestamp refuse negative timestamps ("[Errno 22] Invalid argument"), and saves have races back to the 1800s."""
    try:
        return (EPOCH + datetime.timedelta(seconds=ts)).year
    except (TypeError, ValueError, OverflowError):
        return None


def po_years(con):
    """Years with jockeys or trainers on the results, newest first (for the year picker)."""
    scan = po_scan(con)
    return sorted({y for k in ("jockeys", "trainers") for (_, y) in scan[k] if y}, reverse=True)


PO_LOCK = threading.Lock()
RESULT_YEARS = {}


def result_years(con):
    """The same years as po_years (results with a jockey, trainer or head trainer), from one plain query instead of
    the full People overview scan, so the stable Rankings year picker doesn't wait for it (16.7.11). Kept for the loaded save."""
    ys = RESULT_YEARS.get(DB_GEN)
    if ys is None:
        rc = columns(con, "race_results")
        who = [c for c in ("race_result_person_jockey_id", "race_result_trainer_id", "race_result_stable_head_trainer_id") if c in rc]
        if not who or "race_result_date" not in rc:
            return []
        ys = [r[0] for r in con.execute("""select distinct cast(strftime('%%Y', race_result_date, 'unixepoch') as int) from race_results
            where race_result_date is not null and (%s) order by 1 desc""" % " or ".join("+%s > 0" % c for c in who)) if r[0]]   # "+": a plain scan, not three index lookups
        RESULT_YEARS.clear()
        RESULT_YEARS[DB_GEN] = ys
    return ys


MGR_TENURE = {}


def manager_tenures(con):
    """Who managed each stable, and when, from the staff table: ({stable: [(start, end, person)]}, {person: [(stable, start, end)]}).
    The game writes ONE manager on each race result, so a stable with two managers credits each win to only one of them;
    the viewer credits a stable's race to every manager it had that day. Kept for the loaded save."""
    t = MGR_TENURE.get(DB_GEN)
    if t is None:
        by_st, by_p = {}, {}
        if has_table(con, "staff"):
            for st, a, b, pid in con.execute("""select staff_stable_id, staff_start_date, staff_end_date, staff_person_id from staff
                    where staff_current_role='Manager' and staff_stable_id>0 and staff_person_id>0"""):
                a = a if a is not None else -1e18
                b = b if b is not None else 1e18
                by_st.setdefault(st, []).append((a, b, pid))
                by_p.setdefault(pid, []).append((st, a, b))
        t = (by_st, by_p)
        MGR_TENURE.clear()
        MGR_TENURE[DB_GEN] = t
    return t


def managers_on(by_st, stable, date, recorded):
    """Everyone who managed this stable on this day, plus the manager the game wrote on the result."""
    out = {recorded} if recorded and recorded > 0 else set()
    if stable and date is not None:
        for a, b, pid in by_st.get(stable, ()):
            if a <= date <= b:
                out.add(pid)
    return out


def manager_clause(con, pid, alias="r"):
    """SQL (and its arguments) for the race results a person shares as a manager: those the game wrote them on, and
    every race their stable ran while they managed it."""
    parts, args = ["%s.race_result_stable_manager_id=?" % alias], [pid]
    for st, a, b in manager_tenures(con)[1].get(pid, ()):
        parts.append("(%s.race_result_stable_id=? and %s.race_result_date between ? and ?)" % (alias, alias))
        args += [st, a, b]
    return "(" + " or ".join(parts) + ")", args


def po_scan(con):
    """Read the race results once and total everyone's record in each role for each year:
    races, wins, places, prize money, last race date, and G1/G2/G3/Listed wins.
    A head trainer who is also the trainer is counted once. A stable's race counts for every manager it had that day
    (the game itself writes only one). Kept for the loaded save."""
    key = (DB_GEN, "scan")
    with PO_LOCK:
        if key in PO_AGG:
            return PO_AGG[key]
        for k in [k for k in PO_AGG if k[0] != DB_GEN]:
            PO_AGG.pop(k, None)
        rc = columns(con, "race_results")
        want = ["race_result_person_jockey_id", "race_result_trainer_id", "race_result_stable_head_trainer_id", "race_result_stable_manager_id",
                "race_result_stable_id"]
        sel = ", ".join(c if c in rc else "null" for c in want)
        grade = {}
        if has_table(con, "races") and "races_type_of_race" in columns(con, "races"):
            gi = {"G1": 0, "G2": 1, "G3": 2, "listed": 3}
            grade = {rid: gi[t] for rid, t in con.execute(
                "select races_race_id, races_type_of_race from races where races_type_of_race in ('G1','G2','G3','listed')")}
        out = {"jockeys": {}, "trainers": {}, "managers": {}, "stables": {}}     # stables: for the stable rankings
        J, T, M, S = out["jockeys"], out["trainers"], out["managers"], out["stables"]
        years = {}
        mgr = manager_tenures(con)[0]
        mgr_from = {st: min(a for a, _, _ in lst) for st, lst in mgr.items()}     # races before anyone's job record: only the recorded manager

        def add(d, pid, y, rk, cash, dt, g):
            a = d.get((pid, y))
            if a is None:
                a = d[(pid, y)] = [0, 0, 0, 0, None, 0, 0, 0, 0]   # starts wins places prize last G1 G2 G3 listed
            a[0] += 1
            if rk is not None and 1 <= rk <= 3:
                a[2] += 1
                if rk == 1:
                    a[1] += 1
                    if g is not None:
                        a[5 + g] += 1
            if cash:
                a[3] += cash
            if dt is not None and (a[4] is None or dt > a[4]):
                a[4] = dt
        for j, tr, ht, mg, st, dt, rk, cash, rid in con.execute(
                "select %s, race_result_date, race_result_rank, race_result_cash_received, race_result_race_id from race_results" % sel):
            y = years.get(dt)
            if y is None:
                y = years[dt] = utc_year(dt) if dt is not None else None
            g = grade.get(rid)
            if j and j > 0:
                add(J, j, y, rk, cash, dt, g)
            if tr and tr > 0:
                add(T, tr, y, rk, cash, dt, g)
            if ht and ht > 0 and ht != tr:
                add(T, ht, y, rk, cash, dt, g)
            f0 = mgr_from.get(st)
            if f0 is not None and dt is not None and dt >= f0:
                for m in managers_on(mgr, st, dt, mg):
                    add(M, m, y, rk, cash, dt, g)
            elif mg and mg > 0:
                add(M, mg, y, rk, cash, dt, g)
            if st and st > 0:
                add(S, st, y, rk, cash, dt, g)
        PO_AGG[key] = out
        return out


def po_agg(con, key, year):
    """Everyone's record in one role, all time (year None) or one calendar year, best first."""
    ck = (DB_GEN, key, year)
    if ck in PO_AGG:
        return PO_AGG[ck]
    per = {}
    for (pid, y), a in po_scan(con)[key].items():
        if year and y != year:
            continue
        t = per.get(pid)
        if t is None:
            per[pid] = list(a)
        else:
            for i in (0, 1, 2, 3, 5, 6, 7, 8):
                t[i] += a[i]
            if a[4] is not None and (t[4] is None or a[4] > t[4]):
                t[4] = a[4]
    data = []
    for pid, a in per.items():
        g = a[5] + a[6] + a[7]
        data.append({"pid": pid, "starts": a[0], "wins": a[1], "places": a[2], "prize": a[3], "last": a[4],
                     "G1": a[5], "G2": a[6], "G3": a[7], "listed": a[8], "group": g, "total_gl": g + a[8]})
    data.sort(key=lambda r: (-r["wins"], -r["prize"]))
    PO_AGG[ck] = data
    return data


def po_section(con, key, year=None, who="now", everyone=False, page=1):
    cfg = PO_ROLES[key]
    data = po_agg(con, key, year)
    jobs = ",".join("'%s'" % j for j in cfg["jobs"])
    if who == "now":      # alive and working in this role now
        now = {r[0] for r in con.execute("""select f.staff_person_id from staff f join persons p on p.person_person_id=f.staff_person_id
                where f.staff_end_date is null and f.staff_current_role in (%s) and p.person_deceased_date is null""" % jobs)}
        data = [r for r in data if r["pid"] in now]
    total = len(data)
    pages = max(1, -(-total // PO_PAGE))
    page = max(1, min(page, pages))
    shown = data[(page - 1) * PO_PAGE: page * PO_PAGE] if everyone else data[:PO_TOP]
    ids = [r["pid"] for r in shown]
    info = {}
    if ids:
        marks = ",".join("?" * len(ids))
        for r in rows(con, """select p.person_person_id as id, p.person_full_name as name, p.person_birth_date as birth, p.person_deceased_date as died,
                p.person_is_player as is_player,
                (select f.staff_current_role from staff f where f.staff_person_id=p.person_person_id and f.staff_end_date is null
                    order by f.staff_current_role in (%s) desc, f.staff_start_date limit 1) as job,
                (select f.staff_stable_id from staff f where f.staff_person_id=p.person_person_id and f.staff_end_date is null
                    order by f.staff_current_role in (%s) desc, f.staff_start_date limit 1) as stable_id
                from persons p where p.person_person_id in (%s)""" % (jobs, jobs, marks), ids):
            info[r["id"]] = r
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in info.values()])
    rc = [c for c in cfg["cols"] if c in columns(con, "race_results")]
    people = []
    for r in shown:
        i = info.get(r["pid"]) or {"id": r["pid"], "name": "Person %s" % r["pid"]}
        row = dict(r, id=r["pid"], name=i.get("name"), birth=i.get("birth"), died=i.get("died"), job=i.get("job"),
                   stable_id=i.get("stable_id"), stable=sn.get(i.get("stable_id")), is_player=i.get("is_player") in ("true", 1, "1", True))
        # their latest race in this period
        if r["last"] is not None and rc:
            who, wa = manager_clause(con, r["pid"]) if key == "managers" else (" or ".join("r.%s=?" % c for c in rc), [r["pid"]] * len(rc))
            row["last_race"] = one(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_race_id as race_id, x.races_race_name as race
                    from race_results r left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
                    where (%s) and r.race_result_date=? order by r.race_result_rank limit 1""" % who, wa + [r["last"]])
        people.append(row)
    return {"key": key, "people": people, "total": total, "page": page, "pages": pages, "everyone": everyone}


def api_people_overview(con, q=None):
    q = q or {}
    year = to_int(q.get("year")) or None
    who = "all" if q.get("who") == "all" else "now"
    ok = has_table(con, "staff") and has_table(con, "race_results")
    out = {"year": year, "who": who, "years": po_years(con) if ok else [],
           "sections": [po_section(con, k, year, who, q.get("all") == k, to_int(q.get("page"), 1) if q.get("all") == k else 1)
                        for k in PO_ROLES] if ok else []}
    # latest awards won by people
    out["awards"] = []
    if has_table(con, "awards"):
        concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
        aw = rows(con, """select a.award_category as cat, a.award_year as year, a.award_date as date, a.award_rank as rank, a.award_description as description,
                a.award_entity_id as pid from awards a where a.award_entity_type='person' order by a.award_date desc, a.award_rank limit %d""" % PO_LATEST)
        pn = name_map(con, "persons", "person_person_id", "person_full_name", [a["pid"] for a in aw])
        for a in aw:
            a["label"], a["person"] = award_label(a["cat"], concepts), pn.get(a["pid"])
        out["awards"] = aw
    # latest news about people: jobs, contracts and life events (not every lost race)
    out["news"] = rows(con, """select event_timestamp as date, event_type as type, event_outcome as text, event_primary_actor_id as pid
            from story_events where event_primary_actor_type='person' and event_type in (%s) and event_outcome like '%% %%'
            order by event_timestamp desc limit %d""" % (",".join("'%s'" % t for t in PO_NEWS_TYPES), PO_LATEST)) if has_table(con, "story_events") else []
    return out


# ------------------------------------------------------------------ people: family tree and dynasty
FAMILY_GENS = 8


def family_graph(con):
    """Parents, children and marriages for everyone the save records them for."""
    par, kids = {}, {}
    if has_table(con, "children"):
        for k, a, b in con.execute("select child_person_id, child_parent_1_id, child_parent_2_id from children"):
            ps = [x for x in (a, b) if x and x > 0]
            if k and ps:
                par[k] = ps
                for x in ps:
                    kids.setdefault(x, []).append(k)
    mar = {}
    if has_table(con, "marriages"):
        for a, b, d, div, end in con.execute("""select marriage_person_1_id, marriage_person_2_id, marriage_date, marriage_divorce_date, marriage_end_date
                from marriages order by marriage_date"""):
            for x, y in ((a, b), (b, a)):
                if x and y:
                    mar.setdefault(x, []).append({"id": y, "date": d, "divorced": div, "ended": end})
    for pid, sp, pa in con.execute("""select person_person_id, person_spouse_id, person_partner_id from persons
            where coalesce(person_spouse_id,0) > 0 or coalesce(person_partner_id,0) > 0"""):
        for other, kind in ((sp, "spouse"), (pa, "partner")):
            if other and other > 0 and not any(m["id"] == other for m in mar.get(pid, [])):
                mar.setdefault(pid, []).append({"id": other, "date": None, "divorced": None, "ended": None, "partner": kind == "partner"})
    return par, kids, mar


def ordinal_word(n):
    return {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth"}.get(n, "%dth" % n)


def relation_name(up, down, sex, half=False):
    """What someone is to you, from how many generations up to your closest shared ancestor and back down to them."""
    m, f = sex == "Male", sex == "Female"
    g = lambda male, female, other: male if m else female if f else other
    greats = lambda n: "" if n <= 0 else "great-" if n == 1 else "great-great-" if n == 2 else "%d× great-" % n
    if up == 0 and down == 0:
        return "Themselves"
    if down == 0:
        return {1: g("Father", "Mother", "Parent"), 2: g("Grandfather", "Grandmother", "Grandparent")}.get(up) or \
            (greats(up - 2) + g("grandfather", "grandmother", "grandparent")).capitalize()
    if up == 0:
        return {1: g("Son", "Daughter", "Child"), 2: g("Grandson", "Granddaughter", "Grandchild")}.get(down) or \
            (greats(down - 2) + g("grandson", "granddaughter", "grandchild")).capitalize()
    if up == 1 and down == 1:
        return ("Half-" if half else "") + (g("brother", "sister", "sibling") if half else g("Brother", "Sister", "Sibling"))
    if down == 1:
        return (greats(up - 2) + g("uncle", "aunt", "aunt or uncle")).capitalize()
    if up == 1:
        return (("grand" if down == 3 else greats(down - 3) + "grand" if down > 3 else "") + g("nephew", "niece", "niece or nephew")).capitalize()
    degree, removed = min(up, down) - 1, abs(up - down)
    name = "%s cousin" % ordinal_word(degree)
    if removed:
        name += " " + ({1: "once", 2: "twice", 3: "three times"}.get(removed) or "%d times" % removed) + " removed"
    return name.capitalize()


def person_cards(con, ids):
    """Short facts for a list of people: name, sex, born, died, job now and stable."""
    out = {}
    ids = [i for i in dict.fromkeys(ids) if i]
    for k in range(0, len(ids), 500):
        chunk = ids[k:k + 500]
        marks = ",".join("?" * len(chunk))
        for r in rows(con, """select p.person_person_id as id, p.person_full_name as name, p.person_last_name as surname, p.person_sex as sex,
                p.person_birth_date as birth, p.person_deceased_date as died, p.person_is_player as is_player,
                p.person_jockey_wins as j_wins, coalesce(p.person_trainer_wins,0)+coalesce(p.person_head_trainer_wins,0) as t_wins,
                p.person_owner_of_stable_id as owns_id,
                (select f.staff_current_role from staff f where f.staff_person_id=p.person_person_id and f.staff_end_date is null order by f.staff_start_date limit 1) as job,
                (select f.staff_stable_id from staff f where f.staff_person_id=p.person_person_id and f.staff_end_date is null order by f.staff_start_date limit 1) as stable_id
                from persons p where p.person_person_id in (%s)""" % marks, chunk):
            out[r["id"]] = r
    sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in out.values()] + [r["owns_id"] for r in out.values()])
    for r in out.values():
        r["stable"], r["owns"] = sn.get(r["stable_id"]), sn.get(r["owns_id"])
        r["is_player"] = r["is_player"] in ("true", 1, "1", True)
    return out


def api_family(con, pid):
    """Family tree tab: ancestors up to eight generations back, and every blood relative the save links to them
    (siblings, aunts and uncles, cousins of any degree, nieces, nephews, children...) with what they are to this person."""
    if not one(con, "select 1 as x from persons where person_person_id=?", (pid,)):
        return None
    par, kids, mar = family_graph(con)
    # ancestors: "F"/"M" paths (father/mother first by sex when known), up to eight generations
    sexes = dict(con.execute("select person_person_id, person_sex from persons where person_person_id in (%s)" % ",".join(
        str(int(x)) for x in set(list(par) + [y for v in par.values() for y in v] + [pid]))).fetchall()) if par else {}

    def ordered(ps):
        ps = list(ps)
        ps.sort(key=lambda x: 0 if sexes.get(x) == "Male" else 1)
        return ps

    tree, frontier = {"": pid}, {"": pid}
    for gen in range(1, FAMILY_GENS + 1):
        nxt = {}
        for path, who in frontier.items():
            for i, p in enumerate(ordered(par.get(who, []))[:2]):
                nxt[path + ("F" if (sexes.get(p) == "Male" or (sexes.get(p) is None and i == 0)) else "M")] = p
        tree.update(nxt)
        frontier = nxt
        if not nxt:
            break
    # relatives: from every ancestor (and yourself) down again
    up = {pid: 0}
    queue = [pid]
    while queue:
        x = queue.pop(0)
        if up[x] >= FAMILY_GENS:
            continue
        for p in par.get(x, []):
            if p not in up:
                up[p] = up[x] + 1
                queue.append(p)
    rel = {}
    for anc, i in sorted(up.items(), key=lambda kv: kv[1]):
        level, seen = [anc], {anc}
        for j in range(0, FAMILY_GENS + 1):
            for x in level:
                if x == pid or x in up and up[x] < i:
                    continue
                best = rel.get(x)
                if best is None or (i + j) < (best["up"] + best["down"]):
                    rel[x] = {"up": i, "down": j, "via": anc}
            nxt = []
            for x in level:
                for k in kids.get(x, []):
                    if k not in seen:
                        seen.add(k)
                        nxt.append(k)
            level = nxt
            if not level:
                break
    rel.pop(pid, None)
    for a in up:      # ancestors themselves
        if a != pid:
            rel[a] = {"up": up[a], "down": 0, "via": a}
    # descendants for the tree chart: each person's children grouped by the other parent, four generations down
    def families(x, depth, seen):
        out = {}
        for k in kids.get(x, []):
            if k in seen:
                continue
            other = next((p for p in par.get(k, []) if p != x), None)
            out.setdefault(other, []).append(k)
        fams = []
        for other, ks in out.items():
            ks.sort(key=lambda k: cards_birth.get(k) or 0)
            fams.append({"partner": other, "children": [{"id": k, "families": families(k, depth + 1, seen | {k}) if depth < 4 else []} for k in ks]})
        # partners with no children recorded still stand beside them
        for m in mar.get(x, []):
            if m["id"] not in out:
                fams.append({"partner": m["id"], "children": [], "divorced": m["divorced"], "ended": m["ended"]})
        for f in fams:
            mm = next((m for m in mar.get(x, []) if m["id"] == f["partner"]), None)
            if mm:
                f["divorced"], f["ended"], f["married"] = mm["divorced"], mm["ended"], mm["date"]
        return fams
    desc_ids = set()

    def walk(x, depth):
        for k in kids.get(x, []):
            if k not in desc_ids and depth < 5:
                desc_ids.add(k)
                walk(k, depth + 1)
    walk(pid, 1)
    cards_birth = dict(con.execute("select person_person_id, person_birth_date from persons where person_person_id in (%s)" % ",".join(
        str(int(i)) for i in desc_ids | {pid})).fetchall()) if desc_ids else {}
    fam_tree = families(pid, 1, {pid})

    def fam_ids(fams):
        for f in fams:
            if f["partner"]:
                yield f["partner"]
            for c in f["children"]:
                yield c["id"]
                yield from fam_ids(c["families"])
    siblings = [k for p in par.get(pid, []) for k in kids.get(p, []) if k != pid]
    ids = list(rel) + list(tree.values()) + [m["id"] for m in mar.get(pid, [])] + list(fam_ids(fam_tree)) + siblings
    cards = person_cards(con, ids)
    my_parents = set(par.get(pid, []))
    out_rel = []
    for x, r in rel.items():
        c = cards.get(x)
        if not c:
            continue
        half = r["up"] == 1 and r["down"] == 1 and len(set(par.get(x, [])) & my_parents) < min(2, len(my_parents) or 2)
        out_rel.append(dict(c, up=r["up"], down=r["down"], relation=relation_name(r["up"], r["down"], c["sex"], half),
                            spouses=[m["id"] for m in mar.get(x, []) if not m.get("divorced") and not m.get("ended")]))
    sp_cards = person_cards(con, [s for r in out_rel for s in r["spouses"]])
    for r in out_rel:
        r["spouses"] = [{"id": s, "name": (sp_cards.get(s) or {}).get("name")} for s in r["spouses"] if sp_cards.get(s)]
    out_rel.sort(key=lambda r: (r["up"] + r["down"], r["up"], r["birth"] or 0))
    spouses = [dict(cards.get(m["id"]) or {"id": m["id"]}, married=m["date"], divorced=m["divorced"], ended=m["ended"], partner=m.get("partner"))
               for m in mar.get(pid, [])]
    sib = []
    for k in dict.fromkeys(siblings):
        if k in cards:
            shared = len(set(par.get(k, [])) & my_parents)
            sib.append(dict(cards[k], half=shared < len(my_parents), parents=par.get(k, [])))
    sib.sort(key=lambda r: r["birth"] or 0)
    return {"person": cards.get(pid) or person_cards(con, [pid]).get(pid), "tree": {k: cards.get(v) or {"id": v} for k, v in tree.items() if k},
            "descendants": fam_tree, "siblings": sib, "cards": {i: c for i, c in cards.items() if i in set(fam_ids(fam_tree))},
            "relatives": out_rel, "spouses": spouses, "gens": FAMILY_GENS,
            "deepest": max([len(k) for k in tree if k] or [0]), "recorded": len(par)}


def life_facts(con, ids):
    """What each of these people did, for the Lifespans tab and the Dynasty views: jobs over time, stables they own,
    jockey and trainer wins (with Group 1s, first win, first Group 1 and wins per year), season awards they won and prize money.
    {id: {...}}, worked out in a handful of grouped queries however many people there are."""
    ids = [i for i in dict.fromkeys(ids) if i]
    out = {i: {"careers": [], "owned": [], "j_wins": 0, "t_wins": 0, "m_wins": 0, "g1": 0, "first_win": None, "first_g1": None,
               "by_year": {}, "awards": [], "prize": 0} for i in ids}
    if not ids:
        return out
    def chunks():
        for k in range(0, len(ids), 400):
            c = ids[k:k + 400]
            yield c, ",".join("?" * len(c))
    if has_table(con, "staff"):
        for c, mk in chunks():
            for r in rows(con, """select f.staff_person_id as id, f.staff_current_role as role, f.staff_start_date as start, f.staff_end_date as end,
                    f.staff_stable_id as stable_id, s.stable_name as stable from staff f left join stables s on s.stable_stable_id=f.staff_stable_id
                    where f.staff_person_id in (%s) and f.staff_current_role is not null order by f.staff_start_date""" % mk, c):
                out[r.pop("id")]["careers"].append(r)
    for c, mk in chunks():
        for r in rows(con, """select stable_owner_id as id, stable_stable_id as stable_id, stable_name as name, stable_founded_date as founded,
                stable_liquidated as gone from stables where stable_owner_id in (%s) order by stable_founded_date""" % mk, c):
            out[r.pop("id")]["owned"].append(r)
    pcols = set(columns(con, "persons"))
    money = [x for x in ("person_jockey_winnings", "person_trainer_winnings", "person_head_trainer_career_winnings", "person_management_career_winnings") if x in pcols]
    if money and not ("race_results" in [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
                      and "race_result_cash_received" in columns(con, "race_results")):
        for c, mk in chunks():
            for r in con.execute("select person_person_id, %s from persons where person_person_id in (%s)" % (" + ".join("coalesce(%s,0)" % x for x in money), mk), c):
                out[r[0]]["prize"] = r[1] or 0
    if has_table(con, "race_results"):
        rcols = set(columns(con, "race_results"))
        roles = [("j", "race_result_person_jockey_id"), ("t", "race_result_trainer_id"), ("t", "race_result_stable_head_trainer_id")]
        roles = [(k, c) for k, c in roles if c in rcols]
        # every win as jockey, trainer or manager; a race they had more than one part in counts once in their total
        won = {}
        mgr_people = manager_tenures(con)[1]
        for c, mk in chunks():
            parts, args = [], []
            for k, col in roles:
                parts.append("""select '%s' as k, %s as pid, race_result_id as rid, race_result_race_id as race, race_result_date as d, race_result_horse_id as horse
                    from race_results where race_result_rank=1 and %s in (%s)""" % (k, col, col, mk))
                args += c
            if "race_result_stable_manager_id" in rcols:
                plain = [x for x in c if x not in mgr_people]
                if plain:
                    parts.append("""select 'm', race_result_stable_manager_id, race_result_id, race_result_race_id, race_result_date, race_result_horse_id
                        from race_results where race_result_rank=1 and race_result_stable_manager_id in (%s)""" % ",".join("?" * len(plain)))
                    args += plain
                for x in c:
                    if x in mgr_people:      # a manager: every race their stable won while they managed it
                        cl, ca = manager_clause(con, x, "race_results")
                        parts.append("""select 'm', ?, race_result_id, race_result_race_id, race_result_date, race_result_horse_id
                            from race_results where race_result_rank=1 and %s""" % cl)
                        args += [x] + ca
            sub = " union all ".join(parts)
            for k, who, rid, race, d, horse, typ, rname, hname in con.execute("""select w.*, x.races_type_of_race, x.races_race_name, h.horse_name from (%s) w
                    left join races x on x.races_race_id=w.race and w.race>0 left join horses h on h.horse_horse_id=w.horse""" % sub, args):
                won.setdefault(who, {}).setdefault(rid, [set(), d, typ, race, rname, horse, hname])[0].add(k)
        # prize money: every race result they had a part in (jockey, trainer, head trainer or manager of the stable), each
        # counted once. The save's own per-role totals overlap (a race you managed, trained and rode counts in all three)
        # and its manager total runs well above the stable's actual race money, so they aren't added up (16.7.1).
        if "race_result_cash_received" in rcols:
            for c, mk in chunks():
                parts, args = [], []
                for k, col in roles:
                    parts.append("select %s as pid, race_result_id as rid, race_result_cash_received as cash from race_results where %s in (%s)" % (col, col, mk))
                    args += c
                if "race_result_stable_manager_id" in rcols:
                    plain = [x for x in c if x not in mgr_people]
                    if plain:
                        parts.append("""select race_result_stable_manager_id, race_result_id, race_result_cash_received from race_results
                            where race_result_stable_manager_id in (%s)""" % ",".join("?" * len(plain)))
                        args += plain
                    for x in c:
                        if x in mgr_people:
                            cl, ca = manager_clause(con, x, "race_results")
                            parts.append("select ?, race_result_id, race_result_cash_received from race_results where %s" % cl)
                            args += [x] + ca
                for who, total in con.execute("select pid, sum(coalesce(cash, 0)) from (%s) group by pid" % " union ".join(parts), args):
                    if who in out:
                        out[who]["prize"] = total or 0
        for who, races in won.items():
            f = out[who]
            for rid, (ks, d, typ, race, rname, horse, hname) in races.items():
                f["j_wins"] += "j" in ks
                f["t_wins"] += "t" in ks
                f["m_wins"] += "m" in ks
                y = utc_year(d)
                if y is not None:
                    f["by_year"][y] = f["by_year"].get(y, 0) + 1
                if d is not None and (f["first_win"] is None or d < f["first_win"]):
                    f["first_win"] = d
                if typ == "G1":
                    f["g1"] += 1
                    if d is not None and (not f["first_g1"] or d < f["first_g1"]["date"]):
                        f["first_g1"] = {"date": d, "race_id": race, "race": rname, "horse_id": horse, "horse": hname}
    if has_table(con, "awards"):
        concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
        for c, mk in chunks():
            for r in rows(con, """select award_entity_id as id, award_category as cat, award_year as year, award_date as date, award_rank as rank
                    from awards where award_entity_type='person' and award_entity_id in (%s) order by award_year""" % mk, c):
                won = r["cat"] not in ("worst_overall", "hall_of_fame_nominee") and (r["rank"] in (None, 0, 1))
                if won:
                    out[r["id"]]["awards"].append({"year": r["year"], "date": r["date"], "label": award_label(r["cat"], concepts), "cat": r["cat"]})
        hn = {}
        for pid, lst in person_horse_awards(con, list(out)).items():
            for r in lst:
                if r["cat"] in ("worst_overall", "hall_of_fame_nominee") or r["rank"] not in (None, 0, 1):
                    continue
                hn.setdefault(r["horse_id"], None)
                out[pid]["awards"].append({"year": r["year"], "date": r["date"], "label": award_label(r["cat"], concepts), "cat": r["cat"],
                                           "horse_id": r["horse_id"], "roles": r["roles"], "stable_id": r["stable_id"] if r["etype"] == "stable" else None})
        names = name_map(con, "horses", "horse_horse_id", "horse_name", list(hn))
        stn = name_map(con, "stables", "stable_stable_id", "stable_name", [a.get("stable_id") for f in out.values() for a in f["awards"] if a.get("stable_id")])
        for f in out.values():
            for a in f["awards"]:
                if a.get("horse_id"):
                    a["label"] = "%s · %s, as %s" % (a["label"], names.get(a["horse_id"]) or "a horse", " & ".join(a["roles"]).lower())
                elif a.get("stable_id"):
                    a["label"] = "%s · %s, as %s" % (a["label"], stn.get(a["stable_id"]) or "a stable", " & ".join(a["roles"]).lower())
            f["awards"].sort(key=lambda a: (a["year"] or 0, a["date"] or 0))
    for f in out.values():
        f["wins"] = sum(f["by_year"].values())      # different races won, in any role
    return out


def api_lifespans(con, pid):
    """Lifespans tab: the person and their ancestors (and, if wanted, brothers, sisters and children) on one time line,
    with what each of them did: jobs, stables owned, first win, awards, marriages and children."""
    fam = api_family(con, pid)
    if not fam:
        return None
    par, kids, mar = family_graph(con)
    tree = fam["tree"]
    people = [{"id": pid, "path": "", "gen": 0}]
    people += [{"id": r["id"], "path": path, "gen": len(path)} for path, r in tree.items() if r and r.get("id")]
    for r in fam.get("siblings") or []:
        people.append({"id": r["id"], "path": "S", "gen": 0, "half": r.get("half")})
    for k in kids.get(pid, []):
        people.append({"id": k, "path": "C", "gen": -1})
    seen, plist = set(), []
    for x in people:
        if x["id"] not in seen:
            seen.add(x["id"])
            plist.append(x)
    ids = [x["id"] for x in plist]
    cards = person_cards(con, ids)
    facts = life_facts(con, ids)
    for x in plist:
        c = cards.get(x["id"]) or {}
        x.update({k: c.get(k) for k in ("name", "sex", "birth", "died", "job", "stable_id", "stable", "is_player")})
        x.update(facts.get(x["id"], {}))
        x["marriages"] = [{"id": m["id"], "date": m["date"], "divorced": m["divorced"], "ended": m["ended"]} for m in mar.get(x["id"], [])]
    kid_ids = sorted({int(k) for x in plist for k in kids.get(x["id"], [])})
    births = dict(con.execute("select person_person_id, person_birth_date from persons where person_person_id in (%s)" % ",".join(map(str, kid_ids))).fetchall()) if kid_ids else {}
    for x in plist:
        x["children"] = sorted(births[k] for k in kids.get(x["id"], []) if births.get(k) is not None)
        x["kids_n"] = len(kids.get(x["id"], []))
    return {"person": fam["person"], "people": plist, "game_date": META.get("game_date"), "deepest": fam.get("deepest")}


def api_dynasty(con, pid):
    """Dynasty tab: the family that shares this person's last name, as far as the save links them by birth or marriage,
    from its earliest known members down: every member, those who married in, its tree, records and events."""
    me = one(con, "select person_person_id as id, person_last_name as surname from persons where person_person_id=?", (pid,))
    if not me:
        return None
    surname = (me["surname"] or "").strip()
    par, kids, mar = family_graph(con)
    # everyone linked to this person by birth or marriage
    comp, queue = {pid}, [pid]
    while queue and len(comp) < 5000:
        x = queue.pop()
        for y in par.get(x, []) + kids.get(x, []) + [m["id"] for m in mar.get(x, [])]:
            if y not in comp:
                comp.add(y)
                queue.append(y)
    cards = person_cards(con, list(comp))
    members = {i for i, c in cards.items() if surname and (c["surname"] or "").strip().lower() == surname.lower()}
    members.add(pid)
    # Someone with the name but no parents in the family who married into it took the name on marriage: they count as married in.
    # Between two such people married to each other (the earliest couple), the husband carries the line.
    has_line = {x for x in members if set(par.get(x, [])) & members}
    took_name = set()
    for x in members - has_line:
        for m in mar.get(x, []):
            y = m["id"]
            if y in has_line or (y in members and y not in has_line and cards.get(x, {}).get("sex") == "Female" and cards.get(y, {}).get("sex") == "Male"):
                took_name.add(x)
                break
    took_name.discard(pid) if pid in has_line else None
    line = members - took_name
    married_in = took_name | {m["id"] for x in line for m in mar.get(x, []) if m["id"] not in members and m["id"] in cards}
    # generations: the earliest members of the line are generation 1, their children 2, and so on
    founders = sorted((x for x in line if not (set(par.get(x, [])) & line)), key=lambda x: cards.get(x, {}).get("birth") or 0)
    gen = {}

    def gen_of(x, depth=0):
        if x not in gen:
            ps = [p for p in par.get(x, []) if p in line]
            gen[x] = 1 + max((gen_of(p, depth + 1) for p in ps), default=0) if depth < 60 else 1
        return gen[x]
    for x in line:
        gen_of(x)
    for x in took_name | married_in:      # married in: the generation of the one they married
        gen[x] = max((gen.get(m["id"], 0) for m in mar.get(x, []) if m["id"] in line), default=0) or None
    # what the dynasty has done
    ids = list(members)
    facts = life_facts(con, [x for x in line | married_in if x in cards])
    owned = {}
    for k in range(0, len(ids), 500):
        chunk = ids[k:k + 500]
        for r in rows(con, "select stable_stable_id as id, stable_name as name, stable_owner_id as owner, stable_liquidated as gone from stables where stable_owner_id in (%s)"
                      % ",".join("?" * len(chunk)), chunk):
            owned.setdefault(r["owner"], []).append(r)
    def member(x, kind):
        c = dict(cards[x])
        f = facts.get(x) or {}
        c.update(kind=kind, gen=gen.get(x), awards=len(f.get("awards") or []), award_list=f.get("awards") or [], stables=owned.get(x, []),
                 g1=f.get("g1", 0), wins=f.get("wins", 0), prize=f.get("prize", 0),
                 j_wins=f.get("j_wins", 0), t_wins=f.get("t_wins", 0), m_wins=f.get("m_wins", 0), first_win=f.get("first_win"), first_g1=f.get("first_g1"),
                 by_year=f.get("by_year") or {}, careers=f.get("careers") or [], owned=f.get("owned") or [],
                 parents=[p for p in par.get(x, []) if p in cards], children=[k for k in kids.get(x, []) if k in cards],
                 spouses=[{"id": m["id"], "name": cards[m["id"]]["name"], "divorced": m["divorced"], "ended": m["ended"]}
                          for m in mar.get(x, []) if m["id"] in cards])
        return c
    def wed_kind(x):     # married in, or divorced from everyone they married in the family
        ties = [m for m in mar.get(x, []) if m["id"] in line]
        return "divorced" if ties and all(m["divorced"] for m in ties) else "married"
    mem = [member(x, "member") for x in line if x in cards] + [member(x, wed_kind(x)) for x in married_in]
    mem.sort(key=lambda r: (r["gen"] or 99, r["birth"] or 0))
    # events: births, marriages and deaths of members
    ev = []
    members = line
    for r in mem:
        if r["kind"] == "member" and r["birth"]:
            ev.append({"date": r["birth"], "kind": "born", "who": r["id"]})
        if r["died"]:
            ev.append({"date": r["died"], "kind": "died", "who": r["id"]})
    seen = set()
    for x in members:
        for m in mar.get(x, []):
            key = tuple(sorted((x, m["id"])))
            if m["date"] and key not in seen and m["id"] in cards:
                seen.add(key)
                ev.append({"date": m["date"], "kind": "married", "who": x, "with": m["id"]})
                if m["divorced"]:
                    ev.append({"date": m["divorced"], "kind": "divorced", "who": x, "with": m["id"]})
    # racing: first win, first Group 1, season awards won, stables founded (family members, not those who married in)
    for r in mem:
        if r["kind"] != "member":
            continue
        if r["first_win"]:
            ev.append({"date": r["first_win"], "kind": "first_win", "who": r["id"]})
        if r["first_g1"]:
            ev.append({"date": r["first_g1"]["date"], "kind": "first_g1", "who": r["id"], "race": r["first_g1"]})
        for a in r["award_list"]:
            d = a["date"] or (calendar.timegm((a["year"], 12, 31, 0, 0, 0)) if a["year"] else None)
            if d is not None:
                ev.append({"date": d, "kind": "award", "who": r["id"], "label": a["label"], "year": a["year"]})
        for o in r["owned"]:
            if o["founded"]:
                ev.append({"date": o["founded"], "kind": "stable", "who": r["id"], "stable_id": o["stable_id"], "stable": o["name"]})
    ev.sort(key=lambda e: e["date"], reverse=True)
    # the family's stables: owned by a member or by someone who married in
    st_ids = sorted({o["stable_id"] for r in mem for o in r["owned"]})
    stables = []
    if st_ids:
        mk = ",".join("?" * len(st_ids))
        rem = "and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')" if has_table(con, "hrmv_removed") else ""
        for r in rows(con, """select s.stable_stable_id as id, s.stable_name as name, s.stable_owner_id as owner, s.stable_founded_date as founded, s.stable_liquidated as gone,
                (select count(*) from horses h where h.horse_stable_id=s.stable_stable_id and h.horse_deceased_date is null %s) as horses
                from stables s where s.stable_stable_id in (%s)""" % (rem, mk), st_ids):
            stables.append(r)
        if has_table(con, "race_results"):
            wins = {r[0]: (r[1], r[2] or 0) for r in con.execute("""select r.race_result_stable_id, count(*), sum(x.races_type_of_race='G1') from race_results r
                    left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
                    where r.race_result_rank=1 and r.race_result_stable_id in (%s) group by 1""" % mk, st_ids)}
            for r in stables:
                r["wins"], r["g1"] = wins.get(r["id"], (0, 0))
        staff_at = {}
        for r in mem:
            if r.get("stable_id") and not r.get("died"):
                staff_at.setdefault(r["stable_id"], []).append(r["id"])
        for r in stables:
            r["family_staff"] = staff_at.get(r["id"], [])
    # head of the family: the eldest living member of the earliest generation still alive
    alive = [r for r in mem if r["kind"] == "member" and not r["died"]]
    head = min(alive, key=lambda r: (r["gen"] or 99, r["birth"] or 0))["id"] if alive else None
    by_year = {}
    for r in mem:
        if r["kind"] == "member":
            for y, n in r["by_year"].items():
                by_year[y] = by_year.get(y, 0) + n
    others = one(con, "select count(*) as n from persons where lower(trim(person_last_name))=lower(?)", (surname,))["n"] - len(members) if surname else 0
    live = [r for r in mem if r["kind"] == "member" and not r["died"]]
    return {"surname": surname, "person_id": pid, "members": mem, "founders": [x for x in founders if x in cards],
            "generations": max(gen.values() or [1]), "events": ev[:300], "unlinked_same_name": max(0, others),
            "living": len(live), "total": len([r for r in mem if r["kind"] == "member"]), "head": head, "family_stables": stables,
            "wins_by_year": by_year, "game_date": META.get("game_date"),
            "stables": sorted({(s["id"], s["name"], bool(s["gone"])) for r in mem for s in r["stables"]}, key=lambda t: t[1] or "")}


# A person's record in each role, for their Overview tab (the same race attribution as the People overview).
PERSON_ROLES = [
    ("jockey", ("race_result_person_jockey_id",), ("Jockey",), "person_jockey_ranking", "person_jockey_experience", ("person_jockey_winnings",)),
    ("trainer", ("race_result_trainer_id", "race_result_stable_head_trainer_id"), ("Trainer", "Head trainer"), "person_head_trainer_ranking",
     "person_trainer_experience", ("person_trainer_winnings", "person_head_trainer_career_winnings")),
    ("manager", ("race_result_stable_manager_id",), ("Manager",), "person_management_rankings", "person_management_experience",
     ("person_management_career_winnings",)),
]
ROLE_RACES = 50     # latest races sent per role (the page shows a few and expands)


def person_roles(con, pid, p):
    out = {}
    rcols_all = columns(con, "race_results") if has_table(con, "race_results") else []
    for key, rcols, jobs, rank_col, exp_col, money_cols in PERSON_ROLES:
        rcols = [c for c in rcols if c in rcols_all]
        rec = {"key": key, "ranking": p.get(rank_col), "experience": p.get(exp_col),
               "career_prize": sum((p.get(c) or 0) for c in money_cols),
               "jobs_now": rows(con, """select f.staff_current_role as role, f.staff_stable_id as stable_id, s.stable_name as stable, f.staff_start_date as since
                    from staff f left join stables s on s.stable_stable_id=f.staff_stable_id
                    where f.staff_person_id=? and f.staff_end_date is null and f.staff_current_role in (%s)""" % ",".join("?" * len(jobs)), (pid,) + jobs)
               if has_table(con, "staff") else [],
               "starts": 0, "wins": 0, "places": 0, "prize": 0, "races": [], "big_wins": []}
        if rcols:
            if key == "manager":      # every race their stable ran while they managed it
                who, args = manager_clause(con, pid)
            else:
                who = " or ".join("r.%s=?" % c for c in rcols)
                args = [pid] * len(rcols)
            st = one(con, """select count(*) as starts, sum(r.race_result_rank=1) as wins, sum(r.race_result_rank between 1 and 3) as places,
                    sum(r.race_result_cash_received) as prize from race_results r where %s""" % who, args) or {}
            rec.update(starts=st.get("starts") or 0, wins=st.get("wins") or 0, places=st.get("places") or 0, prize=st.get("prize") or 0)
            if rec["starts"]:
                sel = """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_cash_received as prize,
                    r.race_result_race_id as race_id, x.races_race_name as race, x.races_type_of_race as type, x.races_distance as distance,
                    r.race_result_horse_id as horse_id, h.horse_name as horse, c.racecourse_racecourse_id as course_id, c.racecourse_name as course,
                    r.race_result_stable_id as stable_id
                    from race_results r left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
                    left join horses h on h.horse_horse_id=r.race_result_horse_id
                    left join race_days d on d.raceday_race_day_id=x.races_race_day_id
                    left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id"""
                rec["races"] = rows(con, sel + " where %s order by r.race_result_date desc limit %d" % (who, ROLE_RACES), args)
                # every Group (G1/G2/G3) and Listed win, newest first
                rec["big_wins"] = rows(con, sel + " where (%s) and r.race_result_rank=1 and x.races_type_of_race in ('G1','G2','G3','listed') order by r.race_result_date desc" % who, args)
                sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in rec["races"] + rec["big_wins"]])
                for r in rec["races"] + rec["big_wins"]:
                    r["stable"] = sn.get(r["stable_id"])
        bw = rec["big_wins"]
        rec.update(G1=sum(w["type"] == "G1" for w in bw), G2=sum(w["type"] == "G2" for w in bw), G3=sum(w["type"] == "G3" for w in bw),
                   listed=sum(w["type"] == "listed" for w in bw))
        rec["group"] = rec["G1"] + rec["G2"] + rec["G3"]
        out[key] = rec
    return out


def api_person(con, pid):
    p = one(con, "select * from persons where person_person_id=?", (pid,))
    if not p:
        return None
    out = {"person": clean_blob(p), "removed": removed_info(con, "persons", pid)}
    if has_table(con, "cities") and has_table(con, "countries"):
        out["city"] = one(con, "select c.city_name as city, n.country_name as country from cities c left join countries n on n.country_id=c.city_country_id where c.city_id=?", (p.get("person_city_id"),))
    out["jobs"] = rows(con, """select f.staff_current_role as role, f.staff_start_date as start, f.staff_end_date as end,
        f.staff_salary_yearly as salary, f.staff_stable_id as stable_id, s.stable_name as stable
        from staff f left join stables s on s.stable_stable_id=f.staff_stable_id where f.staff_person_id=? order by f.staff_start_date desc""", (pid,))
    out["owns"] = rows(con, "select stable_stable_id as id, stable_name as name, stable_liquidated as liquidated from stables where stable_owner_id=?", (pid,))
    out["rides"] = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_cash_received as prize,
        r.race_result_horse_id as horse_id, h.horse_name as horse, r.race_result_race_id as race_id, x.races_race_name as race_name,
        x.races_type_of_race as race_type, x.races_distance as distance, c.racecourse_name as course, c.racecourse_racecourse_id as course_id,
        (select count(*) from race_results rr where rr.race_result_race_id=r.race_result_race_id and r.race_result_race_id>0) as runners
        from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
        left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        where r.race_result_person_jockey_id=? order by r.race_result_date desc limit 300""", (pid,))
    out["ride_summary"] = one(con, """select count(*) as rides, sum(race_result_rank=1) as wins, sum(race_result_rank<=3) as places,
        sum(race_result_cash_received) as prize from race_results where race_result_person_jockey_id=?""", (pid,))
    rel = {}
    for key in ("person_spouse_id", "person_partner_id"):
        if p.get(key):
            rel[key] = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (p[key],))
    out["relations"] = rel
    if has_table(con, "children"):
        out["children"] = rows(con, """select c.child_person_id as id, k.person_full_name as name, c.child_birth_date as birth
            from children c left join persons k on k.person_person_id=c.child_person_id
            where c.child_parent_1_id=? or c.child_parent_2_id=? order by c.child_birth_date""", (pid, pid))
        par = one(con, "select child_parent_1_id as a, child_parent_2_id as b from children where child_person_id=?", (pid,))
        out["parents"] = []
        if par:
            for k in ("a", "b"):
                if par[k]:
                    r = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (par[k],))
                    if r:
                        out["parents"].append(r)
    out["traits"] = entity_traits(con, pid, "person")
    out["events"] = entity_events(con, pid, "person")
    out["awards"] = rows(con, """select award_category as category, award_year as year, award_date as date, award_rank as rank, award_value as value,
        award_description as description from awards where award_entity_id=? and award_entity_type='person' order by award_date desc""", (pid,)) if has_table(con, "awards") else []
    ha = person_horse_awards(con, [pid])[pid] if has_table(con, "awards") else []
    if ha:
        names = name_map(con, "horses", "horse_horse_id", "horse_name", [r["horse_id"] for r in ha])
        sn = name_map(con, "stables", "stable_stable_id", "stable_name", [r["stable_id"] for r in ha if r["etype"] == "stable"])
        out["awards"] += [{"category": r["cat"], "year": r["year"], "date": r["date"], "rank": r["rank"], "value": r["value"], "description": r["description"],
                           "horse_id": r["horse_id"], "horse": names.get(r["horse_id"]), "role": " & ".join(r["roles"]),
                           "stable_award": r["etype"] == "stable", "stable_id": r["stable_id"] if r["etype"] == "stable" else None,
                           "stable": sn.get(r["stable_id"]) if r["etype"] == "stable" else None} for r in ha]
        out["awards"].sort(key=lambda a: a["date"] or 0, reverse=True)
    if out["awards"]:
        concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
        for a in out["awards"]:
            a["label"] = award_label(a["category"], concepts)
    out["roles"] = person_roles(con, pid, p)
    out["owned_groups"] = person_owned_groups(con, pid)
    # 16.8.1: every stable they hold shares in, however few (their own, not through a stable of theirs)
    out["shares_held"] = rows(con, """select i.investor_stable_id as id, s.stable_name as name, sum(i.investor_shares_owned) as shares,
        s.stable_total_shares as total, min(i.investor_purchase_date) as since, sum(i.investor_total_paid) as paid, s.stable_liquidated as closed
        from stable_investors i join stables s on s.stable_stable_id=i.investor_stable_id
        where i.investor_person_id=? and coalesce(i.investor_holder_stable_id, 0) <= 0 group by i.investor_stable_id
        having sum(i.investor_shares_owned) > 0 order by 1.0 * sum(i.investor_shares_owned) / max(s.stable_total_shares, 1) desc""", (pid,)) \
        if has_table(con, "stable_investors") else []
    # 16.8.2: and what those stables hold in turn (and what those hold…), with the person's share worked through
    via, seen = [], {r["id"] for r in out["shares_held"]}
    level = [(r["id"], r["name"], (r["shares"] / r["total"]) if r["total"] else 0, [r["id"]]) for r in out["shares_held"]]
    for depth in range(1, 5):
        if not level or not has_table(con, "stable_investors"):
            break
        frac = {h: (f, path, name) for h, name, f, path in level}
        q = ",".join(str(int(h)) for h in frac)
        nxt = []
        for r in rows(con, """select i.investor_holder_stable_id as holder_id, i.investor_stable_id as id, s.stable_name as name, sum(i.investor_shares_owned) as shares,
                s.stable_total_shares as total, min(i.investor_purchase_date) as since, s.stable_liquidated as closed
                from stable_investors i join stables s on s.stable_stable_id=i.investor_stable_id
                where i.investor_holder_stable_id in (%s) and i.investor_stable_id <> i.investor_holder_stable_id
                group by 1, 2 having sum(i.investor_shares_owned) > 0""" % q):
            f, path, hname = frac[r["holder_id"]]
            if r["id"] in path:
                continue
            pct = (r["shares"] / r["total"]) if r["total"] else 0
            via.append(dict(r, holder=hname, depth=depth, stake=pct, eff=f * pct, path=path))
            if r["id"] not in seen:
                seen.add(r["id"])
                nxt.append((r["id"], r["name"], f * pct, path + [r["id"]]))
        level = nxt
    first = {r["id"]: i for i, r in enumerate(out["shares_held"])}      # their biggest holdings first, as on All shares
    out["shares_via"] = sorted(via, key=lambda r: (first.get(r["path"][0], 1e9), r["path"], -r["stake"]))
    out.update(person_more(con, pid))
    return out


def api_courses(con, q):
    where, params = [], []
    if q.get("q"):
        where.append("(c.racecourse_name like ? or c.racecourse_nickname like ? or c.racecourse_location_city like ?)")
        params += ["%" + q["q"] + "%"] * 3
    if q.get("country"):
        where.append("c.racecourse_location_country=?")
        params.append(q["country"])
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    total = count_rows(con, "select count(*) from racecourses c" + w, params)
    data = rows(con, """select c.racecourse_racecourse_id as id, c.racecourse_name as name, c.racecourse_location_country as country,
        c.racecourse_location_city as city, c.racecourse_max_attendance as capacity, c.racecourse_outer_oval_track_surface as surface,
        c.racecourse_direction as direction, c.racecourse_owner_stable_id as owner_id, s.stable_name as owner
        from racecourses c left join stables s on s.stable_stable_id=c.racecourse_owner_stable_id""" + w +
                " order by c.racecourse_location_country, c.racecourse_name limit %d offset %d" % (page_size(), off), params)
    countries = [r[0] for r in con.execute("select distinct racecourse_location_country from racecourses where racecourse_location_country is not null order by 1")]
    return {"total": total, "page": page, "page_size": page_size(), "rows": data, "countries": countries}


def api_course(con, cid):
    c = one(con, "select * from racecourses where racecourse_racecourse_id=?", (cid,))
    if not c:
        return None
    gd = META.get("game_date") or time.time()
    out = {"course": clean_blob(c), "removed": removed_info(con, "racecourses", cid)}
    out["owner"] = one(con, "select stable_stable_id as id, stable_name as name from stables where stable_stable_id=?", (c.get("racecourse_owner_stable_id"),))
    out["manager"] = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (c.get("racecourse_manager_id"),))
    day_sql = """select d.raceday_race_day_id as id, d.raceday_date as date, d.raceday_raceseries_name as name, d.raceday_weather_condition as weather,
        (select count(*) from races x where x.races_race_day_id=d.raceday_race_day_id) as races,
        (select x.races_race_id from races x where x.races_race_day_id=d.raceday_race_day_id and x.races_type_of_race in ('G1','G2','G3','listed')
            order by case x.races_type_of_race when 'G1' then 1 when 'G2' then 2 when 'G3' then 3 else 4 end, x.races_prize_money_total desc limit 1) as top_race_id,
        (select min(x.races_race_id) from races x where x.races_race_day_id=d.raceday_race_day_id) as first_race_id
        from race_days d where d.raceday_racecourse_id=? and d.raceday_date %s ? order by d.raceday_date %s limit 40"""
    out["recent_days"] = rows(con, day_sql % ("<=", "desc"), (cid, gd))
    out["upcoming_days"] = rows(con, day_sql % (">", "asc"), (cid, gd))
    tops = {}
    ids = [r["top_race_id"] for r in out["recent_days"] + out["upcoming_days"] if r["top_race_id"]]
    if ids:
        for r in con.execute("select races_race_id, races_race_name, races_type_of_race from races where races_race_id in (%s)" % ",".join("?" * len(ids)), ids):
            tops[r[0]] = (r[1], r[2])
    for r in out["recent_days"] + out["upcoming_days"]:
        r["top_race_name"], r["top_grade"] = tops.get(r["top_race_id"], (None, None))
    if has_table(con, "hrmv_track_records"):
        out["track_records"] = rows(con, """select t.track, t.distance, t.date, t.time, t.prev_best, t.horse_id, h.horse_name as horse,
            t.jockey_id, j.person_full_name as jockey, t.stable_id, s.stable_name as stable, t.race_id, x.races_race_name as race_name,
            x.races_type_of_race as race_type
            from hrmv_track_records t left join horses h on h.horse_horse_id=t.horse_id
            left join persons j on j.person_person_id=t.jockey_id left join stables s on s.stable_stable_id=t.stable_id
            left join races x on x.races_race_id=t.race_id
            where t.course_id=? order by t.track, t.distance, t.date desc""", (cid,))
    out["section_records"] = rows(con, """select t.track, t.distance, t.sec, t.time, t.horse_id, h.horse_name as horse, t.race_id,
        x.races_race_name as race_name, t.date, t.runs
        from hrmv_section_records t left join horses h on h.horse_horse_id=t.horse_id left join races x on x.races_race_id=t.race_id
        where t.course_id=? order by t.track, t.distance, t.sec""", (cid,)) if has_table(con, "hrmv_section_records") else []
    out["big_races"] = rows(con, """select x.races_race_name as name, x.races_type_of_race as race_type, max(x.races_race_id) as race_id, x.races_distance as distance
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        where d.raceday_racecourse_id=? and x.races_type_of_race in ('G1','G2','G3','listed')
        group by x.races_race_name order by min(x.races_grade), x.races_race_name""", (cid,))
    out["sponsors"] = course_sponsors(con, cid)
    return out


# --------------------------------------------------------------------------- racecourse finances (16.7.8)
# The money a racecourse takes in and pays out is in the payment log (entity type "racecourse"). For years the game no
# longer keeps in detail it leaves one "Yearly Summary" payment each way, dated 1 January; a year with one counts at that
# total (the detail the viewer kept from earlier loads is then only part of it), and is itemised only when there's none.
COURSE_INCOME_LABEL = {"Ticket Revenue": "Tickets", "Concessions & Parking": "Food, drink & parking", "Media Rights": "Media rights",
                       "Betting Commission": "Betting commission", "Venue Sponsorship": "Sponsorship", "Venue Sponsor Event Bonus": "Sponsor event bonuses",
                       "Venue Subsidy": "Subsidy", "Fee": "Fees"}
COURSE_EXPENSE_LABEL = {"Prize": "Prize money", "Operating Expenses": "Operating expenses", "Venue Surplus": "Surplus paid out"}


def course_window_start(gd):
    """The start of "the last 12 months" on racecourse pages: the first day of the month 11 months before the game date."""
    y, m = time.gmtime(gd)[:2]
    m -= 11
    while m < 1:
        m += 12
        y -= 1
    return calendar.timegm((y, m, 1, 0, 0, 0))


def course_months(con, cids, gd, back=0):
    """The 12 calendar months up to the game date (or the 12 before that, back=1), month by month, summed over the
    given racecourses: income and expenses by type (by the month the money was paid), meetings and races."""
    gy, gm = time.gmtime(gd)[:2]
    gm -= 12 * back
    months = []
    for k in range(11, -1, -1):
        y, m = gy, gm - k
        while m < 1:
            m += 12
            y -= 1
        months.append({"key": "%04d-%02d" % (y, m), "year": y, "month": m, "income": 0, "expenses": 0, "surplus": 0, "meetings": 0, "races": 0,
                       "income_cats": {}, "expense_cats": {}})
    by = {x["key"]: x for x in months}
    first = calendar.timegm((months[0]["year"], months[0]["month"], 1, 0, 0, 0))
    ly, lm = months[-1]["year"], months[-1]["month"] + 1
    if lm > 12:
        ly, lm = ly + 1, 1
    last = min(gd, calendar.timegm((ly, lm, 1, 0, 0, 0)) - 1)
    ids = ",".join(str(int(c)) for c in cids) or "0"
    if has_table(con, "transactions"):
        for side, key, labels in (("to", "income", COURSE_INCOME_LABEL), ("from", "expenses", COURSE_EXPENSE_LABEL)):
            for mk, typ, total in con.execute("""select strftime('%%Y-%%m', transaction_date, 'unixepoch'), transaction_type, sum(transaction_amount) from transactions
                    where transaction_%s_entity_type='racecourse' and transaction_%s_entity_id in (%s) and transaction_date >= ? and transaction_date <= ?
                    and transaction_type <> 'Yearly Summary' group by 1, 2""" % (side, side, ids), (first, last)):
                x = by.get(mk)
                if not x:
                    continue
                if key == "expenses" and typ == "Venue Surplus":
                    x["surplus"] += total or 0
                    continue
                label = labels.get(typ, typ or "Other")
                cats = x["income_cats" if key == "income" else "expense_cats"]
                cats[label] = cats.get(label, 0) + (total or 0)
                x[key] += total or 0
    for mk, n in con.execute("select strftime('%%Y-%%m', raceday_date, 'unixepoch'), count(*) from race_days where raceday_racecourse_id in (%s) and raceday_date >= ? and raceday_date <= ? group by 1" % ids, (first, last)):
        if mk in by:
            by[mk]["meetings"] = n
    for mk, n in con.execute("""select strftime('%%Y-%%m', d.raceday_date, 'unixepoch'), count(*) from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
            where d.raceday_racecourse_id in (%s) and d.raceday_date >= ? and d.raceday_date <= ? group by 1""" % ids, (first, last)):
        if mk in by:
            by[mk]["races"] = n
    for x in months:
        x["profit"] = x["income"] - x["expenses"]
    return months


def course_prev_complete(con, cids, gd):
    """Whether the 12 months before "the last 12 months" are still kept payment by payment for these racecourses
    (not folded into the game's yearly totals), so comparing with them is fair."""
    lo = course_window_start(gd)
    y0, y1 = time.gmtime(lo)[0] - 1, time.gmtime(lo - 1)[0]
    ids = ",".join(str(int(c)) for c in cids) or "0"
    a, b = calendar.timegm((y0, 1, 1, 0, 0, 0)), calendar.timegm((y1 + 1, 1, 1, 0, 0, 0))
    n = con.execute("""select count(*) from transactions where transaction_type='Yearly Summary' and transaction_date >= ? and transaction_date < ?
        and ((transaction_to_entity_type='racecourse' and transaction_to_entity_id in (%s)) or (transaction_from_entity_type='racecourse' and transaction_from_entity_id in (%s)))""" % (ids, ids),
        (a, b)).fetchone()[0] if has_table(con, "transactions") else 1
    return n == 0


def months_total(months):
    t = {"income": 0, "expenses": 0, "surplus": 0, "meetings": 0, "races": 0, "income_cats": {}, "expense_cats": {}}
    for x in months:
        for k in ("income", "expenses", "surplus", "meetings", "races"):
            t[k] += x[k]
        for k in ("income_cats", "expense_cats"):
            for cat, v in x[k].items():
                t[k][cat] = t[k].get(cat, 0) + v
    t["profit"] = t["income"] - t["expenses"]
    return t


LEAGUE_CACHE = {}    # (data generation, game date) -> every racecourse's last 12 months


def course_league(con, gd):
    """Every racecourse's last-12-months income, expenses, profit and meetings (itemised payments), for ranks and averages.
    It reads every racecourse payment in the save (a few seconds on a big one), so it's kept until the next load."""
    key = (DB_GEN, gd)
    if key in LEAGUE_CACHE:
        return LEAGUE_CACHE[key]
    LEAGUE_CACHE.clear()
    out = LEAGUE_CACHE[key] = course_league_build(con, gd)
    return out


def course_league_build(con, gd):
    lo = course_window_start(gd)
    out = {}
    if not has_table(con, "transactions"):
        return out
    for cid, v in con.execute("""select transaction_to_entity_id, sum(transaction_amount) from transactions where transaction_to_entity_type='racecourse'
            and transaction_date >= ? and transaction_date <= ? and transaction_type <> 'Yearly Summary' group by 1""", (lo, gd)):
        out.setdefault(cid, {"income": 0, "expenses": 0, "meetings": 0})["income"] = v or 0
    for cid, v in con.execute("""select transaction_from_entity_id, sum(transaction_amount) from transactions where transaction_from_entity_type='racecourse'
            and transaction_date >= ? and transaction_date <= ? and transaction_type not in ('Yearly Summary', 'Venue Surplus') group by 1""", (lo, gd)):
        out.setdefault(cid, {"income": 0, "expenses": 0, "meetings": 0})["expenses"] = v or 0
    for cid, n in con.execute("select raceday_racecourse_id, count(*) from race_days where raceday_date >= ? and raceday_date <= ? group by 1", (lo, gd)):
        if cid in out:
            out[cid]["meetings"] = n
    for v in out.values():
        v["profit"] = v["income"] - v["expenses"]
        v["per_meeting"] = v["income"] / v["meetings"] if v["meetings"] else None
    return out


def league_place(league, cid, key):
    """(place, out of) for one racecourse by a key, highest first; None if it isn't in the league."""
    vals = [(v[key], k) for k, v in league.items() if v.get(key) is not None]
    vals.sort(key=lambda x: -x[0])
    for i, (_, k) in enumerate(vals):
        if k == cid:
            return [i + 1, len(vals)]
    return None


def owned_courses(con, sid):
    """The racecourses a stable owns, with what they took in and paid out over the last 12 months of the save."""
    if "racecourse_owner_stable_id" not in columns(con, "racecourses"):
        return []
    out = rows(con, """select racecourse_racecourse_id as id, racecourse_name as name, racecourse_location_city as city,
        racecourse_location_country as country, racecourse_max_attendance as capacity, racecourse_condition_of_track as track_condition,
        racecourse_condition_of_facilities as facilities, racecourse_licence_grade as licence, racecourse_for_sale as for_sale,
        racecourse_monthly_dividend as dividend, racecourse_demolished_date as demolished
        from racecourses where racecourse_owner_stable_id=? order by racecourse_name""", (sid,))
    if not out or not has_table(con, "transactions"):
        return out
    gd = META.get("game_date") or time.time()
    lo = course_window_start(gd)
    ids = ",".join(str(int(r["id"])) for r in out)
    inc = {r[0]: r[1] for r in con.execute("""select transaction_to_entity_id, sum(transaction_amount) from transactions where transaction_to_entity_type='racecourse'
        and transaction_to_entity_id in (%s) and transaction_date >= ? and transaction_type <> 'Yearly Summary' group by 1""" % ids, (lo,))}
    exp = {r[0]: r[1] for r in con.execute("""select transaction_from_entity_id, sum(transaction_amount) from transactions where transaction_from_entity_type='racecourse'
        and transaction_from_entity_id in (%s) and transaction_date >= ? and transaction_type <> 'Yearly Summary' and transaction_type <> 'Venue Surplus' group by 1""" % ids, (lo,))}
    days = {r[0]: r[1] for r in con.execute("select raceday_racecourse_id, count(*) from race_days where raceday_racecourse_id in (%s) and raceday_date >= ? and raceday_date <= ? group by 1" % ids, (lo, gd))}
    league = course_league(con, gd)
    for r in out:
        r["income_12m"], r["expenses_12m"], r["meetings_12m"] = inc.get(r["id"], 0), exp.get(r["id"], 0), days.get(r["id"], 0)
        r["profit_12m"] = r["income_12m"] - r["expenses_12m"]
        r["income_rank"] = league_place(league, r["id"], "income")
        r["profit_rank"] = league_place(league, r["id"], "profit")
    return out


def api_stable_courses(con, sid):
    """A stable's Racecourses tab: the racecourses it owns, and their money month by month (16.7.9)."""
    out = {"courses": owned_courses(con, sid)}
    gd = META.get("game_date") or time.time()
    ids = [r["id"] for r in out["courses"]]
    if ids:
        out["months12"] = course_months(con, ids, gd)
        out["prev12"] = months_total(course_months(con, ids, gd, back=1))
        out["prev12"]["complete"] = course_prev_complete(con, ids, gd)
        out["breakdown"] = course_breakdown(con, ids, gd)      # 16.7.18: all its racecourses together, line by line
        for r in out["courses"]:
            r["months12"] = [{k: m[k] for k in ("key", "year", "month", "income", "expenses", "profit")} for m in course_months(con, [r["id"]], gd)]
    return out


def course_breakdown(con, cids, gd, years=None):
    """Income and expenses line by line (16.7.18), from the payment notes: each sponsor, race days and races paid for,
    entry and trial fees, prize money by class of race. For the last 12 months and each year the game still itemises.
    One racecourse, or several added together (a stable's racecourses)."""
    if not has_table(con, "transactions") or not cids:
        return {}
    ids = ",".join(str(int(c)) for c in cids)
    lo12 = course_window_start(gd)
    periods = {"last12": None}
    if years is None:       # the years with payments, less any the game only keeps a yearly total for (for any of the racecourses)
        yr = "cast(strftime('%%Y', transaction_date, 'unixepoch') as int)"
        have = {r[0] for r in con.execute("select distinct %s from transactions where transaction_to_entity_type='racecourse' and transaction_to_entity_id in (%s)" % (yr, ids))}
        summ = {r[0] for r in con.execute("select distinct %s from transactions where transaction_to_entity_type='racecourse' and transaction_to_entity_id in (%s) and transaction_type='Yearly Summary'" % (yr, ids))}
        years = [{"year": y, "itemised": True, "income": 1} for y in have - summ if y]
    for e in years:
        if e.get("itemised") and not e.get("summary") and (e.get("income") or e.get("expenses")):
            periods[str(e["year"])] = None
    for k in periods:
        periods[k] = {"inc": {}, "exp": {}, "surplus": 0}

    def targets(t):
        out = []
        if lo12 <= t <= gd:
            out.append(periods["last12"])
        y = str(time.gmtime(t)[0])
        if y in periods and t <= gd:
            out.append(periods[y])
        return out

    def line(p, side, key, amt, n=1, sub=None, **extra):
        L = p[side].setdefault(key, {"total": 0, "n": 0, "sub": {}})
        L["total"] += amt or 0
        L["n"] += n
        for k2, v in extra.items():
            L[k2] = L.get(k2, 0) + v
        if sub:
            S = L["sub"].setdefault(sub, {"total": 0, "n": 0})
            S["total"] += amt or 0
            S["n"] += n

    def num(note):
        m = re.search(r"\((\d+) ", note or "")
        return int(m.group(1)) if m else 0
    for side, io in (("to", "inc"), ("from", "exp")):
        for t, typ, note, n, total in con.execute("""select min(transaction_date), transaction_type, transaction_note, count(*), sum(transaction_amount) from transactions
                where transaction_%s_entity_type='racecourse' and transaction_%s_entity_id in (%s) and transaction_type not in ('Yearly Summary', 'Prize')
                group by strftime('%%Y-%%m', transaction_date, 'unixepoch'), 2, 3""" % (side, side, ids)):
            for p in targets(t):
                if typ == "Venue Surplus":
                    p["surplus"] += total or 0
                elif typ == "Ticket Revenue":
                    line(p, io, "Tickets", total, n, race_days=num(note))
                elif typ == "Concessions & Parking":
                    line(p, io, "Food, drink & parking", total, n, race_days=num(note))
                elif typ == "Media Rights":
                    line(p, io, "Media rights", total, n, races=num(note))
                elif typ == "Betting Commission":
                    line(p, io, "Betting commission", total, n)
                elif typ == "Venue Sponsorship":
                    line(p, io, "Sponsorship", total, n, sub=(note or "").split(":", 1)[-1].strip() or "Sponsor")
                elif typ == "Venue Sponsor Event Bonus":
                    m = re.match(r"Event bonus: (.*) \((\d+) event", note or "")
                    line(p, io, "Sponsor event bonuses", total, n, sub=m.group(1) if m else "Sponsor", events=int(m.group(2)) if m else 0)
                elif typ == "Venue Subsidy":
                    line(p, io, "Subsidy", total, n)
                elif typ == "Fee":
                    line(p, io, "Fees", total, n, sub="Time trial fees" if "trial" in (note or "").lower() else "Race entry fees")
                elif typ == "Operating Expenses":
                    line(p, io, "Operating costs", total, n)
                else:
                    line(p, io, (COURSE_INCOME_LABEL if io == "inc" else COURSE_EXPENSE_LABEL).get(typ, typ or "Other"), total, n)
    # prize money by class of race: the payment names the race, matched to this course's races that day
    grade_of = {}
    for c, day, name, typ in con.execute("""select d.raceday_racecourse_id, cast(d.raceday_date / 86400 as int), x.races_race_name, x.races_type_of_race from races x
            join race_days d on d.raceday_race_day_id=x.races_race_day_id where d.raceday_racecourse_id in (%s)""" % ids):
        grade_of[(c, day, name)] = typ
    CLASS = {"G1": "Group 1", "G2": "Group 2", "G3": "Group 3", "listed": "Listed", "stakes": "Stakes"}
    for c, t, race, n, total in con.execute("""select transaction_from_entity_id, min(transaction_date), substr(transaction_note, instr(transaction_note, ', for result in ') + 16),
            count(*), sum(transaction_amount) from transactions where transaction_from_entity_type='racecourse' and transaction_from_entity_id in (%s) and transaction_type='Prize'
            group by 1, cast(transaction_date / 86400 as int), 3""" % ids):
        day = int(t // 86400)
        typ = grade_of.get((c, day, race)) or grade_of.get((c, day - 1, race))
        cls = CLASS.get(typ, "Other races" if typ else "Race not found")
        for p in targets(t):
            line(p, "exp", "Prize money", total, n, sub=cls, races=1)
    out = {}
    for k, p in periods.items():
        if k == "last12":
            lo, hi = lo12, gd
        else:
            lo, hi = calendar.timegm((int(k), 1, 1, 0, 0, 0)), min(gd, calendar.timegm((int(k) + 1, 1, 1, 0, 0, 0)) - 1)
        meetings = one(con, "select count(*) as n from race_days where raceday_racecourse_id in (%s) and raceday_date >= ? and raceday_date <= ?" % ids, (lo, hi))["n"]

        def lines(d):
            res = []
            for key, L in sorted(d.items(), key=lambda kv: -kv[1]["total"]):
                L = dict(L, label=key)
                L["sub"] = [dict(v, label=n) for n, v in sorted(L["sub"].items(), key=lambda kv: -kv[1]["total"])]
                res.append(L)
            return res
        out[k] = {"income": lines(p["inc"]), "expenses": lines(p["exp"]), "surplus": p["surplus"], "meetings": meetings}
    return out


def api_course_finances(con, cid):
    c = one(con, "select * from racecourses where racecourse_racecourse_id=?", (cid,))
    if not c:
        return None
    gd = META.get("game_date") or time.time()
    out = {"course": {k: c.get(k) for k in c if k.startswith("racecourse_") and not k.startswith("racecourse_location_map")}, "game_date": gd}
    out["owner"] = one(con, "select stable_stable_id as id, stable_name as name from stables where stable_stable_id=?", (c.get("racecourse_owner_stable_id"),))
    yr = "cast(strftime('%Y', transaction_date, 'unixepoch') as int)"
    years = {}

    def year(y):
        return years.setdefault(y, {"year": y, "income": 0, "expenses": 0, "surplus": 0, "income_cats": {}, "expense_cats": {}, "summary": False,
                                    "meetings": 0, "races": 0, "prize_paid": 0})
    if has_table(con, "transactions"):
        for direction, side in (("in", "to"), ("out", "from")):
            for y, typ, n, total in con.execute("""select %s, transaction_type, count(*), sum(transaction_amount) from transactions
                    where transaction_%s_entity_type='racecourse' and transaction_%s_entity_id=? group by 1, 2""" % (yr, side, side), (cid,)):
                e = year(y)
                key = "income" if direction == "in" else "expenses"
                if typ == "Yearly Summary":
                    e["summary_" + key] = total or 0
                    e["summary"] = True
                    continue
                if direction == "out" and typ == "Venue Surplus":
                    e["surplus"] += total or 0
                    continue
                label = (COURSE_INCOME_LABEL if direction == "in" else COURSE_EXPENSE_LABEL).get(typ, typ or "Other")
                cats = e["income_cats" if direction == "in" else "expense_cats"]
                cats[label] = cats.get(label, 0) + (total or 0)
                e[key] += total or 0
                if typ == "Prize":
                    e["prize_paid"] += total or 0
        for e in years.values():
            for key in ("income", "expenses"):
                if "summary_" + key in e:          # the game's yearly total covers the whole year (it includes any surplus paid out)
                    e[key + "_detail"] = e[key]
                    e[key] = e.pop("summary_" + key) - (e["surplus"] if key == "expenses" else 0)
                    e[key + "_from_summary"] = True
    for y, n in con.execute("select cast(strftime('%Y', raceday_date, 'unixepoch') as int), count(*) from race_days where raceday_racecourse_id=? and raceday_date <= ? group by 1", (cid, gd)):
        year(y)["meetings"] = n
    for y, n in con.execute("""select cast(strftime('%Y', d.raceday_date, 'unixepoch') as int), count(*) from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
            where d.raceday_racecourse_id=? and d.raceday_date <= ? group by 1""", (cid, gd)):
        year(y)["races"] = n
    ys = sorted(years.values(), key=lambda e: e["year"])
    for e in ys:
        e["profit"] = e["income"] - e["expenses"]
        e["per_meeting_income"] = e["income"] / e["meetings"] if e["meetings"] else None
        e["per_meeting_profit"] = e["profit"] / e["meetings"] if e["meetings"] else None
        e["itemised"] = not e.get("income_from_summary") and not e.get("expenses_from_summary")
    out["years"] = [e for e in ys if e["income"] or e["expenses"] or e["meetings"]]
    # the last 12 months of the save, from the itemised payments: the 12 calendar months up to the game date (this month
    # so far and the 11 before), the same months as the month-by-month chart, so the two always agree
    lo = course_window_start(gd)
    last = {"income": 0, "expenses": 0, "surplus": 0, "income_cats": {}, "expense_cats": {}}
    if has_table(con, "transactions"):
        for side, key, labels in (("to", "income", COURSE_INCOME_LABEL), ("from", "expenses", COURSE_EXPENSE_LABEL)):
            for typ, total in con.execute("""select transaction_type, sum(transaction_amount) from transactions where transaction_%s_entity_type='racecourse'
                    and transaction_%s_entity_id=? and transaction_date >= ? and transaction_date <= ? and transaction_type <> 'Yearly Summary' group by 1""" % (side, side), (cid, lo, gd)):
                if key == "expenses" and typ == "Venue Surplus":
                    last["surplus"] += total or 0
                    continue
                label = labels.get(typ, typ or "Other")
                cats = last["income_cats" if key == "income" else "expense_cats"]
                cats[label] = cats.get(label, 0) + (total or 0)
                last[key] += total or 0
    last["meetings"] = one(con, "select count(*) as n from race_days where raceday_racecourse_id=? and raceday_date >= ? and raceday_date <= ?", (cid, lo, gd))["n"]
    last["races"] = one(con, """select count(*) as n from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        where d.raceday_racecourse_id=? and d.raceday_date >= ? and d.raceday_date <= ?""", (cid, lo, gd))["n"]
    last["profit"] = last["income"] - last["expenses"]
    out["last12"] = last
    # the last 12 months month by month, and the 12 before them for comparison (16.7.9)
    out["months12"] = course_months(con, [cid], gd)
    prev = months_total(course_months(con, [cid], gd, back=1))
    # the comparison only counts when the game still keeps those months' payments in detail
    py0, py1 = time.gmtime(course_window_start(gd))[0] - 1, time.gmtime(course_window_start(gd) - 1)[0]
    prev["complete"] = all(years.get(y, {}).get("itemised", True) and not years.get(y, {}).get("summary") for y in range(py0, py1 + 1))
    out["prev12"] = prev
    league = course_league(con, gd)
    out["rank"] = {k: league_place(league, cid, k) for k in ("income", "profit", "per_meeting")}
    pm = sorted(v["per_meeting"] for v in league.values() if v.get("per_meeting"))
    out["typical_per_meeting"] = pm[len(pm) // 2] if pm else None
    avg_cols = ("racecourse_vip_ticket_price", "racecourse_normal_ticket_price", "racecourse_standing_ticket_price", "racecourse_parking_price",
                "racecourse_food_price", "racecourse_drink_price", "racecourse_staff_budget", "racecourse_maintenance_budget", "racecourse_marketing_budget",
                "racecourse_prize_pool_contribution")
    have = set(columns(con, "racecourses"))
    cols = [x for x in avg_cols if x in have]
    if cols:
        r = con.execute("select %s from racecourses where racecourse_demolished_date is null" % ", ".join("avg(%s)" % x for x in cols)).fetchone()
        out["averages"] = dict(zip(cols, r))
    # each meeting: what was paid on the day itself, betting commission in and prize money out (tickets, food, media
    # rights, subsidy and operating costs are settled once a month, so they're only in the yearly and 12-month figures)
    out["meetings"] = []
    if has_table(con, "transactions"):
        out["meetings"] = rows(con, """select d.raceday_race_day_id as id, d.raceday_date as date, d.raceday_raceseries_name as name,
            (select count(*) from races x where x.races_race_day_id=d.raceday_race_day_id) as races,
            (select min(x.races_race_id) from races x where x.races_race_day_id=d.raceday_race_day_id) as first_race_id,
            (select count(*) from race_results rr join races x on x.races_race_id=rr.race_result_race_id where x.races_race_day_id=d.raceday_race_day_id) as runners,
            (select sum(x.races_prize_money_total) from races x where x.races_race_day_id=d.raceday_race_day_id) as purse,
            (select sum(t.transaction_amount) from transactions t where t.transaction_to_entity_type='racecourse' and t.transaction_to_entity_id=d.raceday_racecourse_id
                and t.transaction_date >= d.raceday_date and t.transaction_date < d.raceday_date + 86400 and t.transaction_type = 'Betting Commission') as betting,
            (select sum(t.transaction_amount) from transactions t where t.transaction_from_entity_type='racecourse' and t.transaction_from_entity_id=d.raceday_racecourse_id
                and t.transaction_date >= d.raceday_date and t.transaction_date < d.raceday_date + 86400 and t.transaction_type = 'Prize') as prizes
            from race_days d where d.raceday_racecourse_id=? and d.raceday_date <= ? order by d.raceday_date desc limit 60""", (cid, gd))
        prize_by_race = {}
        ids = [m["id"] for m in out["meetings"]]
        if ids:     # the biggest race of each meeting, by prize money
            for r in con.execute("""select x.races_race_day_id, x.races_race_id, x.races_race_name, x.races_type_of_race, x.races_prize_money_total from races x
                    where x.races_race_day_id in (%s) order by x.races_prize_money_total""" % ",".join("?" * len(ids)), ids):
                prize_by_race[r[0]] = r[1:]
        for m in out["meetings"]:
            top = prize_by_race.get(m["id"])
            m["top_race_id"], m["top_race_name"], m["top_grade"], m["top_purse"] = top if top else (None, None, None, None)
    # month by month, when the save keeps the racecourse's own monthly figures
    out["monthly"] = rows(con, """select vms_date as date, vms_cash as cash, vms_income as income, vms_costs as costs, vms_value as value,
        vms_prestige_percentile as prestige from venue_monthly_snapshots where vms_venue_type='racecourse' and vms_venue_id=? order by vms_date""", (cid,)) \
        if has_table(con, "venue_monthly_snapshots") else []
    out["sponsors"] = course_sponsors(con, cid)
    out["breakdown"] = course_breakdown(con, [cid], gd, ys)
    return out


# --------------------------------------------------------------------------- API: raw tables

OPS = {"eq": "=", "ne": "<>", "gt": ">", "lt": "<", "ge": ">=", "le": "<="}


def api_tables(con, q):
    counts = META.get("counts") or {}
    out = []
    for (name,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'hrmv_%' order by name"):
        out.append({"name": name, "rows": counts.get(name), "columns": columns(con, name)})
    return {"tables": out}


def raw_where(con, name, q):
    cols = columns(con, name)
    where, params = [], []
    for key, val in q.items():
        if not key.startswith("f.") or val == "":
            continue
        col = key[2:]
        if col not in cols:
            continue
        op, _, value = val.partition(":")
        if op == "has":
            where.append("cast(%s as text) like ?" % qident(col))
            params.append("%" + value + "%")
        elif op == "null":
            where.append("%s is null" % qident(col))
        elif op == "notnull":
            where.append("%s is not null" % qident(col))
        elif op in OPS:
            where.append("%s %s ?" % (qident(col), OPS[op]))
            try:
                params.append(float(value) if re.fullmatch(r"-?\d+(\.\d+)?", value.strip()) else value)
            except ValueError:
                params.append(value)
    if q.get("q"):
        text_cols = [r[1] for r in con.execute("pragma table_info(" + qident(name) + ")") if "CHAR" in (r[2] or "").upper() or "TEXT" in (r[2] or "").upper() or not r[2]]
        if text_cols:
            where.append("(" + " or ".join("%s like ?" % qident(c) for c in text_cols) + ")")
            params += ["%" + q["q"] + "%"] * len(text_cols)
    w = (" where " + " and ".join(where)) if where else ""
    sort = q.get("sort")
    order = ""
    if sort in cols:
        order = " order by %s %s" % (qident(sort), "desc" if q.get("dir") == "desc" else "asc")
    return cols, w, params, order


def api_table(con, name, q):
    if not has_table(con, name):
        return None
    cols, w, params, order = raw_where(con, name, q)
    size = min(MAX_PAGE_ROWS, max(10, to_int(q.get("size"), 100)))
    page = max(1, to_int(q.get("page"), 1))
    if w:
        total = count_rows(con, "select count(*) from " + qident(name) + w, params)
    else:
        total = (META.get("counts") or {}).get(name)
        if total is None:
            total = count_rows(con, "select count(*) from " + qident(name))
    data = con.execute("select * from %s%s%s limit %d offset %d" % (qident(name), w, order, size, (page - 1) * size), params).fetchall()
    out_rows = []
    for r in data:
        out_rows.append([("<binary %d bytes>" % len(v)) if isinstance(v, (bytes, bytearray)) else v for v in r])
    return {"name": name, "columns": cols, "rows": out_rows, "total": total, "page": page, "page_size": size}


# --------------------------------------------------------------------------- Custom tables (16.8)
# Tables you build yourself in Settings → Custom tables: pick what each row is (a horse, a race run, a sale…), the columns,
# filters and the sort. The definitions are kept in config.json; only the fields listed here can be asked for, and every
# value you type goes in as a parameter.
CT_Y = "cast((%s - {base}) / 31556952 as int)"
# (key, label, expression, kind, group[, id expression for links])
CT_SOURCES = {
    "horses": {
        "label": "Horses", "about": "One row per horse.",
        "base": "horses h",
        "joins": [
            ("hs", "left join hrmv_horse_stats hs on hs.horse_id=h.horse_horse_id"),
            ("st", "left join stables st on st.stable_stable_id=h.horse_stable_id and h.horse_stable_id>0"),
            ("si", "left join horses si on si.horse_horse_id=h.horse_breeding_parent_stallion_id"),
            ("da", "left join horses da on da.horse_horse_id=h.horse_breeding_parent_mare_id"),
            ("tr", "left join persons tr on tr.person_person_id=h.horse_trainer_id"),
            ("jk", "left join persons jk on jk.person_person_id=h.horse_prefered_jockey_id"),
        ],
        "fields": [
            ("name", "Horse", "h.horse_name", "horse", "Horse", "h.horse_horse_id"),
            ("age", "Age", "cast(({gd} - h.horse_birth_date) / 31556952 as int)", "int", "Horse"),
            ("sex", "Sex", "case when h.horse_castrated in (1,'1','true') then 'Gelding' else h.horse_sex end", "text", "Horse"),
            ("born", "Foaled", "h.horse_birth_date", "date", "Horse"),
            ("died", "Died", "h.horse_deceased_date", "date", "Horse"),
            ("alive", "Alive", "(h.horse_deceased_date is null)", "bool", "Horse"),
            ("breed", "Breed", "h.horse_breed", "text", "Horse"),
            ("colour", "Colour", "h.horse_color", "text", "Horse"),
            ("height", "Height", "h.horse_height", "height", "Horse"),
            ("weight", "Weight", "h.horse_weight", "weight", "Horse"),
            ("stable", "Stable", "st.stable_name", "stable", "Connections", "st.stable_stable_id"),
            ("trainer", "Trainer", "tr.person_full_name", "person", "Connections", "tr.person_person_id"),
            ("jockey", "Preferred jockey", "jk.person_full_name", "person", "Connections", "jk.person_person_id"),
            ("sire", "Sire", "si.horse_name", "horse", "Pedigree", "si.horse_horse_id"),
            ("dam", "Dam", "da.horse_name", "horse", "Pedigree", "da.horse_horse_id"),
            ("starts", "Starts", "coalesce(hs.starts, 0)", "int", "Racing record"),
            ("wins", "Wins", "coalesce(hs.wins, 0)", "int", "Racing record"),
            ("seconds", "Seconds", "coalesce(hs.seconds, 0)", "int", "Racing record"),
            ("thirds", "Thirds", "coalesce(hs.thirds, 0)", "int", "Racing record"),
            ("winpct", "Win %", "(case when hs.starts > 0 then 1.0 * hs.wins / hs.starts end)", "pct", "Racing record"),
            ("prize", "Prize money", "coalesce(hs.prize, 0)", "money", "Racing record"),
            ("g1", "G1 wins", "coalesce(hs.g1, 0)", "int", "Racing record"),
            ("g2", "G2 wins", "coalesce(hs.g2, 0)", "int", "Racing record"),
            ("g3", "G3 wins", "coalesce(hs.g3, 0)", "int", "Racing record"),
            ("listed", "Listed wins", "coalesce(hs.listed, 0)", "int", "Racing record"),
            ("stakes", "Stakes wins", "coalesce(hs.stakes_wins, 0)", "int", "Racing record"),
            ("best", "Best race rating", "hs.best_rating", "num", "Racing record"),
            ("first_run", "First start", "hs.first_run", "date", "Racing record"),
            ("last_run", "Last start", "hs.last_run", "date", "Racing record"),
            ("rating", "Rating", "h.horse_international_rating", "num", "Ability"),
            ("peak_rating", "Peak rating", "h.horse_peak_rating", "num", "Ability"),
            ("ability", "Ability index", "h.horse_ability_index", "num", "Ability"),
            ("max_ability", "Potential ability", "h.horse_max_ability_index", "num", "Ability"),
            ("speed", "Speed", "h.horse_speed", "num", "Ability"),
            ("max_speed", "Speed potential", "h.horse_max_speed", "num", "Ability"),
            ("stamina", "Stamina", "h.horse_stamina", "num", "Ability"),
            ("max_stamina", "Stamina potential", "h.horse_max_stamina", "num", "Ability"),
            ("acceleration", "Acceleration", "h.horse_acceleration", "num", "Ability"),
            ("max_acceleration", "Acceleration potential", "h.horse_max_acceleration", "num", "Ability"),
            ("strength", "Strength", "h.horse_strength", "num", "Ability"),
            ("max_strength", "Strength potential", "h.horse_max_strength", "num", "Ability"),
            ("distance_pref", "Distance preference", "h.horse_distance_preference", "text", "Ability"),
            ("form", "Form", "h.horse_form", "text", "Ability"),
            ("temperament", "Temperament", "h.horse_temperament", "num", "Mind & health"),
            ("intelligence", "Intelligence", "h.horse_intelligence", "num", "Mind & health"),
            ("sociability", "Sociability", "h.horse_sociability", "num", "Mind & health"),
            ("experience", "Experience", "h.horse_experience", "num", "Mind & health"),
            ("condition", "Condition", "h.horse_condition", "num", "Mind & health"),
            ("health_risk", "Health risk", "h.horse_health_risk", "num", "Mind & health"),
            ("value", "Value", "h.horse_value_calculated", "money", "Money"),
            ("earnings", "Career earnings (game)", "h.horse_career_earnings", "money", "Money"),
            ("fame", "Fame", "h.horse_fame_calculated", "num", "Money"),
            ("stud_fee", "Stud fee", "h.horse_stud_fee", "money", "Money"),
            ("for_sale", "For sale", "(h.horse_for_sale_date is not null)", "bool", "Money"),
            ("at_stud", "At stud", "(h.horse_stud_date is not null)", "bool", "Breeding"),
            ("in_foal", "In foal", "(h.horse_is_pregnant in (1,'1','true'))", "bool", "Breeding"),
            ("foals", "Foals", "(select count(*) from horses o where o.horse_breeding_parent_stallion_id=h.horse_horse_id or o.horse_breeding_parent_mare_id=h.horse_horse_id)", "int", "Breeding"),
        ],
        "default": ["name", "age", "sex", "stable", "starts", "wins", "prize", "g1", "rating"],
        "sort": ["prize", "desc"],
    },
    "results": {
        "label": "Race results", "about": "One row per runner in a race: every start by every horse.",
        "base": "race_results r",
        "joins": [
            ("x", "left join races x on x.races_race_id=r.race_result_race_id"),
            ("d", "left join race_days d on d.raceday_race_day_id=x.races_race_day_id"),
            ("c", "left join racecourses c on c.racecourse_racecourse_id=r.race_result_racecourse_id"),
            ("h", "left join horses h on h.horse_horse_id=r.race_result_horse_id"),
            ("j", "left join persons j on j.person_person_id=r.race_result_person_jockey_id"),
            ("t", "left join persons t on t.person_person_id=r.race_result_trainer_id"),
            ("s", "left join stables s on s.stable_stable_id=r.race_result_stable_id and r.race_result_stable_id>0"),
        ],
        "fields": [
            ("date", "Date", "r.race_result_date", "date", "Race"),
            ("race", "Race", "x.races_race_name", "race", "Race", "r.race_result_race_id"),
            ("course", "Racecourse", "c.racecourse_name", "course", "Race", "c.racecourse_racecourse_id"),
            ("country", "Country", "c.racecourse_location_country", "text", "Race"),
            ("grade", "Grade", "x.races_type_of_race", "grade", "Race"),
            ("distance", "Distance", "x.races_distance", "dist", "Race"),
            ("track", "Track", "x.races_track", "text", "Race"),
            ("purse", "Purse", "x.races_prize_money_total", "money", "Race"),
            ("weather", "Weather", "d.raceday_weather_condition", "text", "Race"),
            ("horse", "Horse", "h.horse_name", "horse", "Runner", "r.race_result_horse_id"),
            ("pos", "Position", "r.race_result_rank", "int", "Runner"),
            ("won", "Won", "(r.race_result_rank = 1)", "bool", "Runner"),
            ("time", "Time", "r.race_result_time", "racetime", "Runner"),
            ("odds", "Odds", "r.race_result_win_odds", "odds", "Runner"),
            ("barrier", "Barrier", "r.race_result_starting_position", "int", "Runner"),
            ("style", "Running style", "r.race_result_running_style", "text", "Runner"),
            ("gear", "Gear", "r.race_result_gear", "text", "Runner"),
            ("rating", "Race rating", "r.race_result_rating", "num", "Runner"),
            ("rating_before", "Rating before", "r.race_result_rating_before", "num", "Runner"),
            ("prize", "Prize won", "r.race_result_cash_received", "money", "Runner"),
            ("jockey", "Jockey", "j.person_full_name", "person", "Connections", "r.race_result_person_jockey_id"),
            ("trainer", "Trainer", "t.person_full_name", "person", "Connections", "r.race_result_trainer_id"),
            ("stable", "Stable", "s.stable_name", "stable", "Connections", "s.stable_stable_id"),
        ],
        "default": ["date", "race", "course", "grade", "distance", "horse", "pos", "jockey", "time", "prize"],
        "sort": ["date", "desc"],
    },
    "races": {
        "label": "Races", "about": "One row per race.",
        "base": "races x",
        "joins": [
            ("d", "left join race_days d on d.raceday_race_day_id=x.races_race_day_id"),
            ("c", "left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id"),
        ],
        "fields": [
            ("date", "Date", "d.raceday_date", "date", "Race"),
            ("race", "Race", "x.races_race_name", "race", "Race", "x.races_race_id"),
            ("course", "Racecourse", "c.racecourse_name", "course", "Race", "c.racecourse_racecourse_id"),
            ("country", "Country", "c.racecourse_location_country", "text", "Race"),
            ("grade", "Grade", "x.races_type_of_race", "grade", "Race"),
            ("distance", "Distance", "x.races_distance", "dist", "Race"),
            ("track", "Track", "x.races_track", "text", "Race"),
            ("ages", "Ages", "(cast(x.races_min_horse_age as int) || '–' || cast(x.races_max_horse_age as int))", "text", "Race"),
            ("weather", "Weather", "d.raceday_weather_condition", "text", "Race"),
            ("purse", "Purse", "x.races_prize_money_total", "money", "Money"),
            ("first_prize", "First prize", "x.races_prize_money_1", "money", "Money"),
            ("entry_fee", "Entry fee", "x.races_entrance_fee", "money", "Money"),
            ("record", "Record time", "x.races_record_time", "racetime", "Race"),
            ("runners", "Runners", "(select count(*) from race_results rr where rr.race_result_race_id=x.races_race_id)", "int", "Result"),
            ("winner", "Winner", "(select wh.horse_name from race_results w join horses wh on wh.horse_horse_id=w.race_result_horse_id where w.race_result_race_id=x.races_race_id and w.race_result_rank=1 limit 1)", "horse", "Result",
             "(select w.race_result_horse_id from race_results w where w.race_result_race_id=x.races_race_id and w.race_result_rank=1 limit 1)"),
            ("win_time", "Winning time", "(select w.race_result_time from race_results w where w.race_result_race_id=x.races_race_id and w.race_result_rank=1 limit 1)", "racetime", "Result"),
            ("cancelled", "Cancelled", "(x.races_cancelled in (1,'1','true'))", "bool", "Race"),
        ],
        "default": ["date", "race", "course", "grade", "distance", "purse", "runners", "winner"],
        "sort": ["date", "desc"],
    },
    "stables": {
        "label": "Stables", "about": "One row per stable.",
        "base": "stables s",
        "joins": [
            ("t", "left join hrmv_stable_stats t on t.stable_id=s.stable_stable_id"),
            ("p", "left join persons p on p.person_person_id=s.stable_owner_id"),
        ],
        "fields": [
            ("name", "Stable", "s.stable_name", "stable", "Stable", "s.stable_stable_id"),
            ("owner", "Owner", "p.person_full_name", "person", "Stable", "p.person_person_id"),
            ("country", "Country", "s.stable_location_country", "text", "Stable"),
            ("founded", "Founded", "s.stable_founded_date", "date", "Stable"),
            ("level", "Level", "s.stable_level", "int", "Stable"),
            ("prestige", "Prestige", "s.stable_prestige", "num", "Stable"),
            ("active", "Active", "(s.stable_liquidated is null)", "bool", "Stable"),
            ("horses", "Horses", "t.horses", "int", "Horses"),
            ("avg_rating", "Average rating", "t.avg_rating", "num", "Horses"),
            ("top_rating", "Top rating", "t.top_rating", "num", "Horses"),
            ("horses_value", "Horses' value", "t.horses_value", "money", "Horses"),
            ("starts", "Starts", "t.starts", "int", "Racing record"),
            ("wins", "Wins", "t.wins", "int", "Racing record"),
            ("places", "Places", "t.places", "int", "Racing record"),
            ("winpct", "Win %", "(case when t.starts > 0 then 1.0 * t.wins / t.starts end)", "pct", "Racing record"),
            ("prize", "Prize money", "t.prize", "money", "Racing record"),
            ("g1", "G1 wins", "t.g1", "int", "Racing record"),
            ("group_wins", "Group wins", "t.group_wins", "int", "Racing record"),
            ("last_run", "Last start", "t.last_run", "date", "Racing record"),
            ("cash", "Cash", "t.cash", "money", "Money"),
            ("net_worth", "Net worth", "t.net_worth", "money", "Money"),
            ("share_price", "Share price", "t.share_price", "money", "Money"),
            ("staff", "Staff", "t.staff", "int", "Money"),
            ("courses", "Racecourses", "t.courses", "int", "Money"),
        ],
        "default": ["name", "owner", "country", "horses", "starts", "wins", "prize", "g1", "net_worth"],
        "sort": ["prize", "desc"],
    },
    "people": {
        "label": "People", "about": "One row per person: jockeys, trainers, managers and the rest.",
        "base": "persons p",
        "joins": [
            ("sf", "left join staff sf on sf.staff_entity_id=(select max(z.staff_entity_id) from staff z where z.staff_person_id=p.person_person_id and z.staff_end_date is null)"),
            ("ss", "left join stables ss on ss.stable_stable_id=sf.staff_stable_id and sf.staff_stable_id>0"),
        ],
        "fields": [
            ("name", "Name", "p.person_full_name", "person", "Person", "p.person_person_id"),
            ("age", "Age", "cast(({gd} - p.person_birth_date) / 31556952 as int)", "int", "Person"),
            ("sex", "Sex", "p.person_sex", "text", "Person"),
            ("alive", "Alive", "(p.person_deceased_date is null)", "bool", "Person"),
            ("role", "Job", "sf.staff_current_role", "text", "Job"),
            ("employer", "Works for", "ss.stable_name", "stable", "Job", "ss.stable_stable_id"),
            ("salary", "Salary (yearly)", "sf.staff_salary_yearly", "money", "Job"),
            ("since", "Started", "sf.staff_start_date", "date", "Job"),
            ("j_starts", "Rides", "p.person_jockey_starts", "int", "As a jockey"),
            ("j_wins", "Wins (jockey)", "p.person_jockey_wins", "int", "As a jockey"),
            ("j_pct", "Win % (jockey)", "(case when p.person_jockey_starts > 0 then 1.0 * p.person_jockey_wins / p.person_jockey_starts end)", "pct", "As a jockey"),
            ("j_money", "Winnings (jockey)", "p.person_jockey_winnings", "money", "As a jockey"),
            ("j_rank", "Jockey ranking", "p.person_jockey_ranking", "int", "As a jockey"),
            ("j_skill", "Jockey skill", "p.person_jockey_skill", "num", "As a jockey"),
            ("t_starts", "Runners trained", "p.person_trainer_starts", "int", "As a trainer"),
            ("t_wins", "Wins (trainer)", "p.person_trainer_wins", "int", "As a trainer"),
            ("t_pct", "Win % (trainer)", "(case when p.person_trainer_starts > 0 then 1.0 * p.person_trainer_wins / p.person_trainer_starts end)", "pct", "As a trainer"),
            ("t_money", "Winnings (trainer)", "p.person_trainer_winnings", "money", "As a trainer"),
            ("t_skill", "Trainer skill", "p.person_trainer_skill", "num", "As a trainer"),
            ("ht_wins", "Wins (head trainer)", "p.person_head_trainer_wins", "int", "As a head trainer"),
            ("ht_skill", "Head trainer skill", "p.person_head_trainer_skill", "num", "As a head trainer"),
            ("reputation", "Reputation", "p.person_reputation", "num", "Standing"),
            ("fame", "Fame", "p.person_fame_calculated", "num", "Standing"),
            ("value", "Value", "p.person_value_calculated", "money", "Standing"),
        ],
        "default": ["name", "age", "role", "employer", "j_starts", "j_wins", "j_pct", "j_money"],
        "sort": ["j_wins", "desc"],
    },
    "trials": {
        "label": "Trials", "about": "One row per timed trial run.",
        "base": "timing_trials tt",
        "joins": [
            ("h", "left join horses h on h.horse_horse_id=tt.tt_horse_id"),
            ("c", "left join racecourses c on c.racecourse_racecourse_id=tt.tt_racecourse_id"),
            ("j", "left join persons j on j.person_person_id=tt.tt_person_jockey_id"),
            ("st", "left join stables st on st.stable_stable_id=h.horse_stable_id and h.horse_stable_id>0"),
        ],
        "fields": [
            ("date", "Date", "tt.tt_date", "date", "Trial"),
            ("horse", "Horse", "h.horse_name", "horse", "Trial", "tt.tt_horse_id"),
            ("stable", "Stable (now)", "st.stable_name", "stable", "Trial", "st.stable_stable_id"),
            ("course", "Racecourse", "c.racecourse_name", "course", "Trial", "c.racecourse_racecourse_id"),
            ("track", "Track", "tt.tt_track", "text", "Trial"),
            ("surface", "Surface", "tt.tt_surface", "text", "Trial"),
            ("distance", "Distance", "tt.tt_distance", "dist", "Trial"),
            ("time", "Time", "tt.tt_time_result", "racetime", "Trial"),
            ("speed", "Average speed", "(case when tt.tt_time_result > 0 then tt.tt_distance / tt.tt_time_result end)", "speed", "Trial"),
            ("condition", "Condition", "tt.tt_condition_at_trial", "pct100", "Trial"),
            ("jockey", "Jockey", "j.person_full_name", "person", "Trial", "j.person_person_id"),
        ],
        "default": ["date", "horse", "course", "track", "distance", "time", "speed", "jockey"],
        "sort": ["date", "asc"],
    },
    "sales": {
        "label": "Auction sales", "about": "One row per horse offered at auction.",
        "base": "auction_results a",
        "joins": [
            ("h", "left join horses h on h.horse_horse_id=a.auction_result_horse_id"),
            ("sh", "left join auction_shell sh on sh.auction_shell_id=a.auction_result_shell_id"),
            ("ah", "left join auction_house ah on ah.auction_house_id=a.auction_result_auctionhouse_id"),
            ("fs", "left join stables fs on fs.stable_stable_id=a.auction_result_from_stable_id and a.auction_result_from_stable_id>0"),
            ("ts", "left join stables ts on ts.stable_stable_id=a.auction_result_to_stable_id and a.auction_result_to_stable_id>0"),
        ],
        "fields": [
            ("date", "Date", "a.auction_result_date", "date", "Sale"),
            ("horse", "Horse", "h.horse_name", "horse", "Sale", "a.auction_result_horse_id"),
            ("age", "Age at sale", "cast((a.auction_result_date - h.horse_birth_date) / 31556952 as int)", "int", "Sale"),
            ("sale", "Sale", "sh.auction_shell_name", "auction", "Sale", "a.auction_result_shell_id"),
            ("house", "Auction house", "ah.auction_house_name", "house", "Sale", "a.auction_result_auctionhouse_id"),
            ("price", "Price", "a.auction_result_final_price", "money", "Money"),
            ("sold", "Sold", "(a.auction_result_accepted in (1,'1','true'))", "bool", "Money"),
            ("cut", "House's cut", "a.auction_result_cut_to_auctionhouse", "money", "Money"),
            ("seller", "Seller", "fs.stable_name", "stable", "Stables", "fs.stable_stable_id"),
            ("buyer", "Buyer", "ts.stable_name", "stable", "Stables", "ts.stable_stable_id"),
        ],
        "default": ["date", "horse", "age", "sale", "house", "price", "sold", "seller", "buyer"],
        "sort": ["price", "desc"],
    },
    "payments": {
        "label": "Payments", "about": "One row per payment in the game's money log.",
        "base": "transactions m",
        "joins": [
            ("fs", "left join stables fs on m.transaction_from_entity_type='stable' and fs.stable_stable_id=m.transaction_from_entity_id"),
            ("fp", "left join persons fp on m.transaction_from_entity_type='person' and fp.person_person_id=m.transaction_from_entity_id"),
            ("fc", "left join racecourses fc on m.transaction_from_entity_type='racecourse' and fc.racecourse_racecourse_id=m.transaction_from_entity_id"),
            ("ts", "left join stables ts on m.transaction_to_entity_type='stable' and ts.stable_stable_id=m.transaction_to_entity_id"),
            ("tp", "left join persons tp on m.transaction_to_entity_type='person' and tp.person_person_id=m.transaction_to_entity_id"),
            ("tc", "left join racecourses tc on m.transaction_to_entity_type='racecourse' and tc.racecourse_racecourse_id=m.transaction_to_entity_id"),
        ],
        "fields": [
            ("date", "Date", "m.transaction_date", "date", "Payment"),
            ("type", "Type", "m.transaction_type", "text", "Payment"),
            ("amount", "Amount", "m.transaction_amount", "money", "Payment"),
            ("note", "Note", "m.transaction_note", "text", "Payment"),
            ("category", "Category", "m.transaction_category", "text", "Payment"),
            ("from", "From", "coalesce(fs.stable_name, fp.person_full_name, fc.racecourse_name, m.transaction_from_entity_type)", "text", "Who"),
            ("from_kind", "From (kind)", "m.transaction_from_entity_type", "text", "Who"),
            ("to", "To", "coalesce(ts.stable_name, tp.person_full_name, tc.racecourse_name, m.transaction_to_entity_type)", "text", "Who"),
            ("to_kind", "To (kind)", "m.transaction_to_entity_type", "text", "Who"),
            ("from_stable", "From stable", "fs.stable_name", "stable", "Who", "fs.stable_stable_id"),
            ("to_stable", "To stable", "ts.stable_name", "stable", "Who", "ts.stable_stable_id"),
        ],
        "default": ["date", "type", "from", "to", "amount", "note"],
        "sort": ["date", "desc"],
    },
}
CT_OPS = {"eq": "=", "ne": "<>", "gt": ">", "lt": "<", "ge": ">=", "le": "<="}


def ct_catalogue():
    """What the Custom tables builder can offer: each kind of row, its fields grouped, and the starting columns."""
    out = []
    for k, s in CT_SOURCES.items():
        out.append({"key": k, "label": s["label"], "about": s["about"], "default": s["default"], "sort": s["sort"],
                    "fields": [{"key": f[0], "label": f[1], "kind": f[3], "group": f[4]} for f in s["fields"]]})
    return out


def ct_load():
    return [t for t in (read_json(CONFIG_FILE, {}).get("custom_tables") or []) if isinstance(t, dict)]


def ct_save(tables):
    clean = []
    for t in tables if isinstance(tables, list) else []:
        if not isinstance(t, dict) or t.get("source") not in CT_SOURCES:
            continue
        keys = {f[0] for f in CT_SOURCES[t["source"]]["fields"]}
        clean.append({
            "id": re.sub(r"[^a-z0-9]", "", str(t.get("id") or ""))[:16] or ("t%x" % int(time.time() * 1000)),
            "name": str(t.get("name") or "My table")[:80], "about": str(t.get("about") or "")[:300], "source": t["source"],
            "cols": [c for c in (t.get("cols") or []) if c in keys][:40],
            "filters": [{"f": f.get("f"), "op": str(f.get("op") or ""), "v": f.get("v")} for f in (t.get("filters") or [])
                        if isinstance(f, dict) and f.get("f") in keys][:20],
            "sort": [s for s in (t.get("sort") or [])][:2] if isinstance(t.get("sort"), list) else None,
            "size": to_int(t.get("size"), 100),
        })
    cfg = read_json(CONFIG_FILE, {})
    cfg["custom_tables"] = clean
    write_json(CONFIG_FILE, cfg)
    return clean


def ct_run(con, d, q):
    """Run a custom table: d is its definition (source, cols, filters, sort); q has page and size."""
    src = CT_SOURCES.get((d or {}).get("source"))
    if not src:
        return {"error": "Pick what each row should be."}
    gd = float(META.get("game_date") or time.time())
    F = {f[0]: f for f in src["fields"]}
    fx = lambda f: f[2].replace("{gd}", repr(gd))
    cols = [c for c in (d.get("cols") or []) if c in F] or list(src["default"])
    where, params = [], []
    for flt in d.get("filters") or []:
        f = F.get((flt or {}).get("f"))
        if not f:
            continue
        op, v, e, kind = flt.get("op"), flt.get("v"), fx(f), f[3]
        if op == "empty":
            where.append("(%s is null or %s = '')" % (e, e)); continue
        if op == "notempty":
            where.append("(%s is not null and %s <> '')" % (e, e)); continue
        if kind == "bool":
            where.append("coalesce(%s, 0) = %d" % (e, 1 if op != "no" else 0)); continue
        if op == "yours":       # one of your stables: the ids come from the viewer
            ids = [to_int(x) for x in str(v or "").split(",") if to_int(x) is not None]
            if len(f) > 5 and ids:
                where.append("%s in (%s)" % (f[5], ",".join(str(i) for i in ids)))
            elif len(f) > 5:
                where.append("0")
            continue
        if v is None or v == "":
            continue
        if op in ("has", "nothas"):
            where.append("%s(coalesce(%s, '') like ?)" % ("not " if op == "nothas" else "", e)); params.append("%" + str(v) + "%"); continue
        if op in ("is", "isnot"):
            where.append("%s(lower(coalesce(%s, '')) = lower(?))" % ("not " if op == "isnot" else "", e)); params.append(str(v)); continue
        if op == "on":      # a date: that whole day
            try:
                day = float(v)
            except (TypeError, ValueError):
                continue
            where.append("(%s >= ? and %s < ?)" % (e, e)); params += [day, day + 86400]; continue
        if op in CT_OPS:
            try:
                val = float(v)
            except (TypeError, ValueError):
                val = str(v)
            where.append("%s %s ?" % (e, CT_OPS[op])); params.append(val)
    srt = d.get("sort") if isinstance(d.get("sort"), list) and d.get("sort") else src["sort"]
    sf = F.get(srt[0]) or F[src["sort"][0]]
    sdir = "asc" if (srt[1] if len(srt) > 1 else "desc") == "asc" else "desc"
    order = " order by (%s is null), %s %s" % (fx(sf), fx(sf), sdir)
    w = (" where " + " and ".join(where)) if where else ""
    alias = src["base"].split()[-1]

    def joins_for(text):
        # the joins the text needs, and the joins those need
        need, txt, changed = [], text, True
        while changed:
            changed = False
            for a, j in src["joins"]:
                if a not in need and re.search(r"\b%s\." % re.escape(a), txt):
                    need.append(a); txt += " " + j; changed = True
        return " ".join(j for a, j in src["joins"] if a in need)
    size = min(MAX_PAGE_ROWS, max(10, to_int(q.get("size"), to_int(d.get("size"), 100) or 100)))
    page = max(1, to_int(q.get("page"), 1))
    inner_joins = joins_for(w + order)
    total = count_rows(con, "select count(*) from %s %s%s" % (src["base"], joins_for(w), w), params)
    rids = [r[0] for r in con.execute("select %s.rowid from %s %s%s%s limit %d offset %d" % (alias, src["base"], inner_joins, w, order, size, (page - 1) * size), params)]
    sel = []
    for i, c in enumerate(cols):
        f = F[c]
        sel.append("%s as c%d" % (fx(f), i))
        if len(f) > 5:
            sel.append("%s as c%d_id" % (fx(f) if f[5] == f[2] else f[5].replace("{gd}", repr(gd)), i))
    out_rows = []
    if rids:
        sel_sql = ", ".join(sel)
        got = {}
        for r in con.execute("select %s.rowid as _rid, %s from %s %s where %s.rowid in (%s)" % (
                alias, sel_sql, src["base"], joins_for(sel_sql), alias, ",".join(str(int(x)) for x in rids))):
            got[r[0]] = r
        for rid in rids:
            r = got.get(rid)
            if r is None:
                continue
            vals, k = [], 1
            for i, c in enumerate(cols):
                v = r[k]; k += 1
                if len(F[c]) > 5:
                    vals.append([v, r[k]]); k += 1
                else:
                    vals.append(v)
            out_rows.append(vals)
    return {"cols": [{"key": c, "label": F[c][1], "kind": F[c][3]} for c in cols], "rows": out_rows, "total": total,
            "page": page, "page_size": size, "sort": [sf[0], sdir]}


# --------------------------------------------------------------------------- derived stats (v2)

DERIVED_VERSION = 6
YEAR = 365.2425 * 86400


def build_derived(con, carried_sectionals=False, carried_records=False):
    """Precompute per-horse race records and per-stable totals into hrmv_* tables.
    carried_sectionals / carried_records: see build_sectionals."""
    ensure_removed_table(con)
    if "race_result_trainer_id" in columns(con, "race_results"):
        con.execute("create index if not exists hrmv_race_results_race_result_trainer_id on race_results(race_result_trainer_id)")
    con.executescript("""
        drop table if exists hrmv_horse_stats;
        create table hrmv_horse_stats as
        select r.race_result_horse_id as horse_id, count(*) as starts,
            sum(r.race_result_rank=1) as wins, sum(r.race_result_rank=2) as seconds, sum(r.race_result_rank=3) as thirds,
            sum(coalesce(r.race_result_cash_received,0)) as prize, max(r.race_result_date) as last_run, min(r.race_result_date) as first_run,
            max(r.race_result_rating) as best_rating,
            sum(r.race_result_rank=1 and x.races_type_of_race='G1') as g1,
            sum(r.race_result_rank=1 and x.races_type_of_race='G2') as g2,
            sum(r.race_result_rank=1 and x.races_type_of_race='G3') as g3,
            sum(r.race_result_rank=1 and x.races_type_of_race='listed') as listed,
            sum(r.race_result_rank=1 and x.races_type_of_race in ('G1','G2','G3','listed')) as stakes_wins
        from race_results r not indexed left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        group by r.race_result_horse_id;
        create unique index hrmv_horse_stats_pk on hrmv_horse_stats(horse_id);
    """)
    if has_table(con, "stable_financial_snapshots"):
        fin = """select snapshot_stable_id as sid, snapshot_cash as cash, snapshot_net_worth as net_worth,
            snapshot_share_price as share_price, snapshot_market_cap as market_cap from (
            select *, row_number() over (partition by snapshot_stable_id order by snapshot_date desc) as rn
            from stable_financial_snapshots) where rn=1"""
    else:
        fin = "select null as sid, null as cash, null as net_worth, null as share_price, null as market_cap where 0"
    staff = ("select staff_stable_id as sid, count(*) as staff from staff where staff_end_date is null group by 1"
             if has_table(con, "staff") else "select null as sid, 0 as staff where 0")
    con.executescript("""
        drop table if exists hrmv_stable_stats;
        create table hrmv_stable_stats as
        with res as (
            select r.race_result_stable_id as sid, count(*) as starts, sum(r.race_result_rank=1) as wins,
                sum(r.race_result_rank=2) as seconds, sum(r.race_result_rank=3) as thirds,
                sum(r.race_result_rank<=3) as places, sum(coalesce(r.race_result_cash_received,0)) as prize,
                sum(r.race_result_rank=1 and x.races_type_of_race='G1') as g1,
                sum(r.race_result_rank=1 and x.races_type_of_race='G2') as g2,
                sum(r.race_result_rank=1 and x.races_type_of_race='G3') as g3,
                sum(r.race_result_rank=1 and x.races_type_of_race='listed') as listed,
                sum(r.race_result_rank=1 and x.races_type_of_race in ('G1','G2','G3')) as group_wins,
                max(r.race_result_date) as last_run
            from race_results r not indexed left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
            where r.race_result_stable_id>0 group by 1),
        fin as (%s),
        hs as (
            select horse_stable_id as sid, count(*) as horses, avg(horse_international_rating) as avg_rating,
                max(horse_international_rating) as top_rating, sum(horse_value_calculated) as horses_value
            from horses where horse_deceased_date is null and horse_stable_id>0
            and horse_horse_id not in (select pk from hrmv_removed where tbl='horses') group by 1),
        top as (
            select sid, hid from (select horse_stable_id as sid, horse_horse_id as hid,
                row_number() over (partition by horse_stable_id order by horse_international_rating desc, horse_career_earnings desc) as rn
                from horses where horse_deceased_date is null and horse_stable_id>0
                and horse_horse_id not in (select pk from hrmv_removed where tbl='horses')) where rn=1),
        st as (%s),
        rc as (select racecourse_owner_stable_id as sid, count(*) as courses from racecourses where racecourse_owner_stable_id>0 group by 1)
        select s.stable_stable_id as stable_id, coalesce(hs.horses,0) as horses, hs.avg_rating, hs.top_rating, hs.horses_value,
            top.hid as top_horse_id, coalesce(res.starts,0) as starts, coalesce(res.wins,0) as wins, coalesce(res.places,0) as places,
            coalesce(res.prize,0) as prize, coalesce(res.g1,0) as g1, coalesce(res.group_wins,0) as group_wins, res.last_run,
            coalesce(res.seconds,0) as seconds, coalesce(res.thirds,0) as thirds, coalesce(res.g2,0) as g2,
            coalesce(res.g3,0) as g3, coalesce(res.listed,0) as listed,
            fin.cash, fin.net_worth, fin.share_price, fin.market_cap, coalesce(st.staff,0) as staff, coalesce(rc.courses,0) as courses
        from stables s left join res on res.sid=s.stable_stable_id left join fin on fin.sid=s.stable_stable_id
        left join hs on hs.sid=s.stable_stable_id left join top on top.sid=s.stable_stable_id
        left join st on st.sid=s.stable_stable_id left join rc on rc.sid=s.stable_stable_id;
        create unique index hrmv_stable_stats_pk on hrmv_stable_stats(stable_id);
    """ % (fin, staff))
    # Track records: every winning run that beat the previous best time for its course, track and distance
    con.executescript("""
        drop table if exists hrmv_track_records;
        create table hrmv_track_records as
        with w as (
            select d.raceday_racecourse_id as course_id, x.races_track as track, cast(round(x.races_distance) as integer) as distance,
                x.races_race_date_time as date, r.race_result_time as time, r.race_result_horse_id as horse_id,
                r.race_result_person_jockey_id as jockey_id, r.race_result_stable_id as stable_id, x.races_race_id as race_id,
                r.race_result_id as rid
            from race_results r join races x on x.races_race_id=r.race_result_race_id
            join race_days d on d.raceday_race_day_id=x.races_race_day_id
            where r.race_result_rank=1 and r.race_result_time>0 and r.race_result_race_id>0),
        p as (
            select w.*, min(time) over (partition by course_id, track, distance order by date, rid
                rows between unbounded preceding and 1 preceding) as prev_best
            from w)
        select * from p where prev_best is null or time < prev_best;
        create index hrmv_track_records_course on hrmv_track_records(course_id);
    """)
    build_sectionals(con, carried_sectionals, carried_records)
    con.commit()


SECTION_RECORDS_SQL = """
    with s as (
        select d.raceday_racecourse_id as course_id, x.races_track as track, cast(round(x.races_distance) as integer) as distance,
            x.races_race_date_time as date, s.race_id, s.horse_id, s.t1, s.t2, s.t3, s.t4, s.t5
        from %(src)s s join races x on x.races_race_id=s.race_id
        join race_days d on d.raceday_race_day_id=x.races_race_day_id),
    u as (
        select course_id, track, distance, 1 as sec, t1 as time, horse_id, race_id, date from s where t1>0
        union all select course_id, track, distance, 2, t2-t1, horse_id, race_id, date from s where t2>t1 and t1>0
        union all select course_id, track, distance, 3, t3-t2, horse_id, race_id, date from s where t3>t2 and t2>0
        union all select course_id, track, distance, 4, t4-t3, horse_id, race_id, date from s where t4>t3 and t3>0
        union all select course_id, track, distance, 5, t5-t4, horse_id, race_id, date from s where t5>t4 and t4>0),
    rk as (
        select *, row_number() over (partition by course_id, track, distance, sec order by time, date) as rn,
            count(*) over (partition by course_id, track, distance, sec) as runs
        from u)
    select course_id, track, distance, sec, time, horse_id, race_id, date, runs from rk where rn=1"""


def update_section_records(con):
    """Fold the sectionals in temp.sect_added into the stored records instead of ranking every stored sectional again:
    a group's record is replaced only by a strictly better time (or the same time earlier), and its run count grows."""
    con.execute("drop table if exists temp.rec_best")
    con.execute("create temp table rec_best as " + SECTION_RECORDS_SQL % {"src": "temp.sect_added"})
    con.execute("drop table if exists temp.rec_win")
    better = "r.rowid is null or b.time<r.time or (b.time=r.time and b.date<r.date)"
    con.execute("""create temp table rec_win as select r.rowid as rid, b.course_id, b.track, b.distance, b.sec,
        case when %(w)s then b.time else r.time end as time,
        case when %(w)s then b.horse_id else r.horse_id end as horse_id,
        case when %(w)s then b.race_id else r.race_id end as race_id,
        case when %(w)s then b.date else r.date end as date,
        coalesce(r.runs, 0) + b.runs as runs
        from temp.rec_best b left join hrmv_section_records r on r.course_id is b.course_id and r.track is b.track
            and r.distance is b.distance and r.sec=b.sec""" % {"w": better})
    con.execute("delete from hrmv_section_records where rowid in (select rid from temp.rec_win where rid is not null)")
    con.execute("""insert into hrmv_section_records (course_id, track, distance, sec, time, horse_id, race_id, date, runs)
        select course_id, track, distance, sec, time, horse_id, race_id, date, runs from temp.rec_win""")
    con.execute("drop table temp.rec_best")
    con.execute("drop table temp.rec_win")


def build_sectionals(con, keep_existing=False, carried_records=False):
    """Sectional times from the race position snapshots (taken at 25%, 50%, 75%, 90% and 100% of the race).

    keep_existing: hrmv_sectionals was carried over from the stored data; only races not in it yet are added from the
    race positions, and stored rows are never replaced (compacted data no longer holds other horses' positions).
    carried_records: hrmv_section_records was carried over too and is only updated with the new sectionals, instead of
    ranking every stored sectional again (that took 10-15 seconds on a big save)."""
    keep_existing = keep_existing and has_table(con, "hrmv_sectionals")
    carried_records = keep_existing and carried_records and has_table(con, "hrmv_section_records")
    con.executescript(("" if carried_records else "drop table if exists hrmv_section_records;") + ("" if keep_existing else "drop table if exists hrmv_sectionals;"))
    have_positions = has_table(con, "race_position_snapshots")
    if not have_positions and not keep_existing:
        return
    pick = lambda col, name: ", ".join("max(case when k=%d then %s end) as %s%d" % (k, col, name, k) for k in range(1, 6))
    if have_positions:
        con.execute("drop table if exists temp.sect_new")
        con.executescript("""
            create table %s as
            select race_position_race_id as race_id, race_position_horse_id as horse_id, %s, %s, %s, %s, %s,
                max(case when k=5 then race_position_stamina_percentage end) as stamina
            from (select *, case when race_position_completion_percentage between 0.24 and 0.26 then 1
                                 when race_position_completion_percentage between 0.49 and 0.51 then 2
                                 when race_position_completion_percentage between 0.74 and 0.76 then 3
                                 when race_position_completion_percentage between 0.89 and 0.91 then 4
                                 when race_position_completion_percentage >= 0.99 then 5 end as k
                  from race_position_snapshots not indexed)
            where k is not null group by 1, 2;
        """ % (("temp.sect_new" if keep_existing else "hrmv_sectionals"), pick("race_position_snapshot_time", "t"), pick("race_position_current_rank", "r"),
               pick("race_position_meters_from_leader", "m"), pick("race_position_current_speed", "v"), pick("race_position_distance_completed", "d")))
        if keep_existing:
            # add what is new; a race the save only has some positions for must not replace a complete stored row
            con.execute("create index if not exists hrmv_sectionals_race on hrmv_sectionals(race_id)")
            con.execute("drop table if exists temp.sect_added")
            con.execute("""create temp table sect_added as select n.* from temp.sect_new n left join hrmv_sectionals s
                on s.race_id=n.race_id and s.horse_id=n.horse_id where s.race_id is null""")
            con.execute("insert into hrmv_sectionals select * from temp.sect_added")
            con.execute("drop table temp.sect_new")
    con.execute("create index if not exists hrmv_sectionals_race on hrmv_sectionals(race_id)")
    if carried_records:
        if have_positions:
            update_section_records(con)
            con.execute("drop table if exists temp.sect_added")
        con.execute("create index if not exists hrmv_section_records_course on hrmv_section_records(course_id)")
        return
    con.execute("drop table if exists temp.sect_added")
    con.execute("drop table if exists hrmv_section_records")
    con.execute("create table hrmv_section_records as " + SECTION_RECORDS_SQL % {"src": "hrmv_sectionals"})
    con.execute("create index hrmv_section_records_course on hrmv_section_records(course_id)")


def gwins(alias_h, alias_s, g):
    return "max(coalesce(%s.horse_%s_wins,0), coalesce(%s.%s,0))" % (alias_h, g, alias_s, g)


# --------------------------------------------------------------------------- Horse table tab

HT_SORTS = {
    "fans": "coalesce(fans,0)", "sponsor_pay": "coalesce(sponsor_pay,0)",
    "earn_pct": "coalesce(earn_pct,101)", "ped_pct": "coalesce(ped_pct,-1)",
    "name": "h.horse_name", "gender": "h.horse_gender", "birth": "h.horse_birth_date", "stable": "st.stable_name",
    "sire": "sp.horse_name", "dam": "dp.horse_name", "rating": "h.horse_international_rating", "peak": "h.horse_peak_rating",
    "starts": "coalesce(s.starts,0)", "wins": "coalesce(s.wins,0)", "seconds": "coalesce(s.seconds,0)", "thirds": "coalesce(s.thirds,0)",
    "winpct": "(case when s.starts>0 then 1.0*s.wins/s.starts end)", "g1": gwins("h", "s", "g1"), "g2": gwins("h", "s", "g2"),
    "g3": gwins("h", "s", "g3"), "listed": gwins("h", "s", "listed"), "earnings": "h.horse_career_earnings",
    "value": "h.horse_value_calculated", "last_run": "s.last_run", "condition": "h.horse_condition",
    "breeding": "h.horse_breeding_ability",
}


def horse_table_query(con, q):
    gd = META.get("game_date") or time.time()
    where, params = [], []
    if q.get("q"):
        where.append("h.horse_name like ?"); params.append("%" + q["q"] + "%")
    status = q.get("status") or "alive"
    if status in ("alive", "dead"):
        where.append(HORSE_STATUS_SQL[status])
    if q.get("gender"):
        where.append("h.horse_gender=?"); params.append(q["gender"])
    if q.get("stable"):
        where.append("h.horse_stable_id=?"); params.append(to_int(q["stable"]))
    if q.get("stableq"):
        where.append("st.stable_name like ?"); params.append("%" + q["stableq"] + "%")
    if q.get("sire"):
        where.append("h.horse_breeding_parent_stallion_id=?"); params.append(to_int(q["sire"]))
    if q.get("dam"):
        where.append("h.horse_breeding_parent_mare_id=?"); params.append(to_int(q["dam"]))
    if to_int(q.get("minstarts")):
        where.append("coalesce(s.starts,0)>=?"); params.append(to_int(q["minstarts"]))
    if q.get("agemin") not in (None, ""):
        where.append("h.horse_birth_date<=?"); params.append(gd - to_int(q["agemin"], 0) * YEAR)
    if q.get("agemax") not in (None, ""):
        where.append("h.horse_birth_date>?"); params.append(gd - (to_int(q["agemax"], 0) + 1) * YEAR)
    notes_filter(where, q, con=con)
    horse_role_where(con, q, where)       # its join "s" is in the base query already
    if q.get("stakes") == "1":
        where.append("(coalesce(s.stakes_wins,0)>0 or coalesce(h.horse_g1_wins,0)+coalesce(h.horse_g2_wins,0)+coalesce(h.horse_g3_wins,0)+coalesce(h.horse_listed_wins,0)>0)")
    base = """from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id
        left join stables st on st.stable_stable_id=h.horse_stable_id
        left join horses sp on sp.horse_horse_id=h.horse_breeding_parent_stallion_id
        left join horses dp on dp.horse_horse_id=h.horse_breeding_parent_mare_id"""
    hc = set(columns(con, "horses"))
    fan_sel = "cast(round(h.horse_fame_calculated) as integer) as fans, h.horse_fan_band_notified as fan_band" if {"horse_fame_calculated", "horse_fan_band_notified"} <= hc else "null as fans, 0 as fan_band"
    if has_table(con, "horse_sponsors"):      # the sponsor it has now (one at a time)
        base += """ left join horse_sponsors hs on hs.sponsor_id=(select x.sponsor_id from horse_sponsors x where x.sponsor_horse_id=h.horse_horse_id
            and x.sponsor_contract_start_date<=%r and (x.sponsor_contract_end_date is null or x.sponsor_contract_end_date>%r) limit 1)""" % (float(gd), float(gd))
        sp_sel = "hs.sponsor_brand_name as sponsor, hs.sponsor_monthly_payment as sponsor_pay"
    else:
        base += " left join (select null as sponsor_id, null as sponsor_monthly_payment) hs on 0"
        sp_sel = "null as sponsor, null as sponsor_pay"
    # 16.5: the game's earnings and pedigree rankings (top x% by career earnings; how a horse's pedigree compares)
    if has_table(con, "horse_earnings_rankings"):
        base += " left join horse_earnings_rankings er on er.horse_id=h.horse_horse_id"
        sp_sel += ", er.career_percentile as earn_pct"
    else:
        sp_sel += ", null as earn_pct"
    if has_table(con, "horse_pedigree_percentiles"):
        sp_sel += ", (select pp.pedigree_rank from horse_pedigree_percentiles pp where pp.pedigree_horse_id=h.horse_horse_id order by pp.pedigree_percentile_id desc limit 1) as ped_pct"
    else:
        sp_sel += ", null as ped_pct"
    w = (" where " + " and ".join(where)) if where else ""
    sel = """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth,
        h.horse_deceased_date as died, h.horse_stable_id as stable_id, st.stable_name as stable,
        h.horse_breeding_parent_stallion_id as sire_id, sp.horse_name as sire, h.horse_breeding_parent_mare_id as dam_id, dp.horse_name as dam,
        h.horse_international_rating as rating, h.horse_peak_rating as peak, coalesce(s.starts,0) as starts, coalesce(s.wins,0) as wins,
        coalesce(s.seconds,0) as seconds, coalesce(s.thirds,0) as thirds, %s as g1, %s as g2, %s as g3, %s as listed,
        h.horse_career_earnings as earnings, h.horse_value_calculated as value, h.horse_form as form, s.last_run as last_run,
        h.horse_distance_preference as distance_pref, h.horse_condition as condition, h.horse_breeding_ability as breeding,
        h.horse_color as color, h.horse_breed as breed, %s, %s """ % (gwins("h", "s", "g1"), gwins("h", "s", "g2"), gwins("h", "s", "g3"), gwins("h", "s", "listed"), fan_sel, sp_sel)
    sort, d = sort_args(q, HT_SORTS, "earnings")
    sel += rank_select(sort, (q.get("sort") or "earnings") in ("name", "gender", "stable", "sire", "dam", "earn_pct"))
    order = " order by " + order_sql(sort, d)
    # the other joins are one-to-one, so the count only needs the ones the filters use
    cbase = "from horses h" + (" left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id" if re.search(r"\bs\.", w) else "") + \
        (" left join stables st on st.stable_stable_id=h.horse_stable_id" if re.search(r"\bst\.", w) else "")
    return sel + base + w + order, "select count(*) " + cbase + w, params


def api_horse_table(con, q):
    sql, count_sql, params = horse_table_query(con, q)
    page = max(1, to_int(q.get("page"), 1))
    size = getattr(PAGE_LOCAL, "size", None) or 100
    total = count_rows(con, count_sql, params)
    data = rows(con, sql + " limit %d offset %d" % (size, (page - 1) * size), params)
    auto = horse_auto(con, [r["id"] for r in data])
    for r in data:
        r["auto"] = auto.get(r["id"])
    return {"total": total, "page": page, "page_size": size, "rows": data}


# --------------------------------------------------------------------------- Stable table tab

STT_SORTS = {
    "name": "s.stable_name", "owner": "p.person_full_name", "country": "n.country_name", "horses": "t.horses",
    "avg_rating": "t.avg_rating", "top_rating": "t.top_rating", "horses_value": "t.horses_value", "starts": "t.starts",
    "wins": "t.wins", "winpct": "(case when t.starts>0 then 1.0*t.wins/t.starts end)", "places": "t.places", "prize": "t.prize",
    "g1": "t.g1", "g2": "t.g2", "g3": "t.g3", "listed": "t.listed", "seconds": "t.seconds", "thirds": "t.thirds", "group_wins": "t.group_wins", "cash": "t.cash", "net_worth": "t.net_worth", "share_price": "t.share_price",
    "staff": "t.staff", "courses": "t.courses", "prestige": "s.stable_prestige", "level": "s.stable_level",
    "founded": "s.stable_founded_date", "last_run": "t.last_run",
}


def stable_table_query(con, q):
    where, params = [], []
    if q.get("q"):
        where.append("s.stable_name like ?"); params.append("%" + q["q"] + "%")
    if (q.get("status") or "active") == "active":
        where.append("s.stable_liquidated is null and s.stable_stable_id not in (select pk from hrmv_removed where tbl='stables')")
    elif q.get("status") == "closed":
        where.append("(s.stable_liquidated is not null or s.stable_stable_id in (select pk from hrmv_removed where tbl='stables'))")
    if q.get("country"):
        where.append("n.country_name=?"); params.append(q["country"])
    if to_int(q.get("minhorses")):
        where.append("t.horses>=?"); params.append(to_int(q["minhorses"]))
    base = """from stables s left join hrmv_stable_stats t on t.stable_id=s.stable_stable_id
        left join persons p on p.person_person_id=s.stable_owner_id
        left join cities c on c.city_id=s.stable_city_id left join countries n on n.country_id=c.city_country_id
        left join horses th on th.horse_horse_id=t.top_horse_id"""
    w = (" where " + " and ".join(where)) if where else ""
    sel = """select s.stable_stable_id as id, s.stable_name as name, s.stable_liquidated as liquidated, s.stable_owner_id as owner_id,
        p.person_full_name as owner, c.city_name as city, n.country_name as country, t.horses, t.avg_rating, t.top_rating,
        t.top_horse_id, th.horse_name as top_horse, t.horses_value, t.starts, t.wins, t.seconds, t.thirds, t.places, t.prize,
        t.g1, t.g2, t.g3, t.listed, t.group_wins,
        t.last_run, t.cash, t.net_worth, t.share_price, t.staff, t.courses, s.stable_prestige as prestige, s.stable_level as level,
        s.stable_founded_date as founded """
    sort, d = sort_args(q, STT_SORTS, "prestige")
    # each stable's rank in the sorted column (16.7.11), over every stable the filters keep: the best is 1 whichever way
    # it's sorted and on any page, stables with the same figure share a rank (1, 2, 2, 4), and an empty figure gets none.
    # Best is the highest number, or A first for names, owners and countries.
    best = order_sql(sort, "asc" if sort in (STT_SORTS["name"], STT_SORTS["owner"], STT_SORTS["country"]) else "desc")
    sel += ", case when %s is null then null else rank() over (order by %s) end as _rank " % (sort, best)
    order = " order by " + order_sql(sort, d)
    return sel + base + w + order, "select count(*) " + base + w, params


STABLE_RACE_WINS = {"g1_race": "G1 win", "g2_race": "G2 win", "g3_race": "G3 win", "listed_race": "Listed win"}


def api_stable_awards(con, sid, q):
    """Every award tied to this stable: awards to the stable itself, awards won by its horses while they were in this stable
    (season awards and Group/Listed race wins) and awards won by its employees while they worked here. The save records the
    stable on each horse and staff award at the time, so a horse or employee who has since moved on keeps the award with the
    stable they won it for."""
    if not has_table(con, "awards"):
        return {"awards": []}
    concepts = dict(con.execute("select concept_id, concept_name from concepts").fetchall()) if has_table(con, "concepts") else {}
    data = rows(con, """select a.award_id as id, a.award_entity_type as etype, a.award_entity_id as eid, a.award_category as cat,
        a.award_year as year, a.award_date as date, a.award_rank as rank, a.award_description as description, a.award_race_id as race_id,
        h.horse_name as horse, p.person_full_name as person
        from awards a
        left join horses h on a.award_entity_type='horse' and h.horse_horse_id=a.award_entity_id
        left join persons p on a.award_entity_type='person' and p.person_person_id=a.award_entity_id
        where (a.award_entity_type='stable' and a.award_entity_id=?1) or (a.award_entity_type in ('horse','person') and a.award_stable_id=?1)
        order by a.award_year desc, a.award_date desc, coalesce(a.award_rank, 99), a.award_category""", (sid,))
    for r in data:
        cat = r["cat"]
        r["kind"] = "race" if cat in STABLE_RACE_WINS else "season"
        r["label"] = STABLE_RACE_WINS.get(cat) or ("Hall of Fame nominee" if cat == "hall_of_fame_nominee" else award_label(cat, concepts))
        r["who"] = r.pop("horse") if r["etype"] == "horse" else r.pop("person") if r["etype"] == "person" else None
        r.pop("horse", None)
        r.pop("person", None)
    return {"awards": data}


# --------------------------------------------------------------------------- Stable rankings (like the game's league tables)

SR_CACHE = {}        # (data generation, tab, year) -> every open stable's figures for that tab
SR_PAGE = 100
# per tab: the figure it's ranked by, and whether it can be looked at for one year
SR_TABS = {
    "earnings": {"main": "prize", "year": True}, "times": {"main": "held", "year": True}, "staff": {"main": "staff", "year": False},
    "prestige": {"main": "prestige", "year": False}, "horses": {"main": "horses", "year": False},
    "traders": {"main": "profit", "year": True}, "breeders": {"main": "earnings", "year": False}, "value": {"main": "value", "year": False},
}


def sr_base(con):
    """Every stable still open: id, name, owner and country (from the stable's town)."""
    sc = columns(con, "stables")
    where = ["s.stable_stable_id > 0"]
    if "stable_liquidated" in sc:
        where.append("s.stable_liquidated is null")
    if "stable_merged_into_id" in sc:
        where.append("coalesce(s.stable_merged_into_id, 0) = 0")
    where.append("s.stable_stable_id not in (select pk from hrmv_removed where tbl='stables')")
    town = ("left join cities c on c.city_id=s.stable_city_id left join countries n on n.country_id=c.city_country_id"
            if "stable_city_id" in sc and has_table(con, "cities") and has_table(con, "countries") else "")
    ctry = "n.country_name as country, n.country_code_iso2 as iso2" if town else "null as country, null as iso2"
    return rows(con, """select s.stable_stable_id as id, s.stable_name as name, s.stable_owner_id as owner_id, p.person_full_name as owner, %s
        from stables s left join persons p on p.person_person_id=s.stable_owner_id %s where %s""" % (ctry, town, " and ".join(where)))


def sr_figures(con, tab, year):
    """{stable id: {column: value}} for one tab."""
    args = []
    if year:
        args = [calendar.timegm((year, 1, 1, 0, 0, 0)), calendar.timegm((year + 1, 1, 1, 0, 0, 0))]
    out = {}
    if tab == "earnings" and (DB_GEN, "scan") not in PO_AGG and {"race_result_stable_id", "race_result_rank", "race_result_date"} <= set(columns(con, "race_results")):
        # 16.7.11: one query for just this tab, so it doesn't wait for the People overview's pass over every result
        # (same figures; that pass is used instead once it has been done)
        rc = columns(con, "race_results")
        cash = "coalesce(rr.race_result_cash_received, 0)" if "race_result_cash_received" in rc else "0"
        graded = has_table(con, "races") and "races_type_of_race" in columns(con, "races")
        g = lambda t: ("sum(rr.race_result_rank = 1 and r.races_type_of_race = '%s')" % t) if graded else "0"
        join = " left join races r on r.races_race_id = rr.race_result_race_id" if graded else ""
        when = " and rr.race_result_date >= ? and rr.race_result_date < ?" if year else ""
        for r in con.execute("""select rr.race_result_stable_id, count(*), sum(rr.race_result_rank = 1), sum(rr.race_result_rank between 1 and 3), sum(%s), %s, %s, %s, %s
                from race_results rr%s where rr.race_result_stable_id > 0%s group by 1""" % (cash, g("G1"), g("G2"), g("G3"), g("listed"), join, when), args):
            out[r[0]] = dict(zip(("starts", "wins", "places", "prize", "g1", "g2", "g3", "listed"), (x or 0 for x in r[1:])))
        for r in out.values():
            r["winpct"] = 100.0 * r["wins"] / r["starts"] if r["starts"] else None
            r["group"] = r["g1"] + r["g2"] + r["g3"]
    elif tab == "earnings":
        # from the same single pass over the results as the People overview (worked out once per save)
        for (sid, y), a in po_scan(con)["stables"].items():
            if year and y != year:
                continue
            r = out.get(sid)
            if r is None:
                r = out[sid] = {"starts": 0, "wins": 0, "places": 0, "prize": 0, "g1": 0, "g2": 0, "g3": 0, "listed": 0}
            for k, i in (("starts", 0), ("wins", 1), ("places", 2), ("prize", 3), ("g1", 5), ("g2", 6), ("g3", 7), ("listed", 8)):
                r[k] += a[i]
        for r in out.values():
            r["winpct"] = 100.0 * r["wins"] / r["starts"] if r["starts"] else None
            r["group"] = r["g1"] + r["g2"] + r["g3"]
    elif tab == "times":
        if not has_table(con, "hrmv_track_records"):
            return out
        when = " where date >= ? and date < ?" if year else ""
        for r in rows(con, "select stable_id as id, count(*) as set_count, max(date) as last_set from hrmv_track_records%s group by 1" % when, args):
            out[r["id"]] = r
        # a record is held now if nobody has run faster since: the latest record for its course, track and distance
        for r in rows(con, """select stable_id as id, count(*) as held, count(distinct course_id) as courses from (
                select *, row_number() over (partition by course_id, track, distance order by date desc, rid desc) as rn from hrmv_track_records) where rn=1 group by 1"""):
            out.setdefault(r["id"], {}).update(held=r["held"], courses=r["courses"])
    elif tab == "staff":
        if not has_table(con, "staff"):
            return out
        for r in rows(con, """select staff_stable_id as id, count(*) as staff, sum(staff_current_role='Jockey') as jockeys,
                sum(staff_current_role in ('Trainer','Head trainer')) as trainers, sum(staff_current_role in ('Manager','Assistant manager')) as managers,
                sum(staff_current_role='Stablehand') as stablehands, sum(staff_current_role='Scout') as scouts, sum(coalesce(staff_salary_yearly,0)) as wages
                from staff where staff_end_date is null and staff_stable_id > 0 group by 1"""):
            out[r["id"]] = r
    elif tab == "prestige":
        sc = columns(con, "stables")
        pick = lambda c, a: ("s.%s as %s" % (c, a)) if c in sc else "null as %s" % a
        for r in rows(con, "select s.stable_stable_id as id, %s from stables s" % ", ".join(pick(c, a) for c, a in (
                ("stable_prestige", "prestige"), ("stable_prestige_rank_year_start", "start_rank"), ("stable_fame", "fame"),
                ("stable_experience", "experience"), ("stable_legacy", "legacy"), ("stable_level", "level")))):
            out[r["id"]] = r
        if has_table(con, "prestige_log"):
            gd = META.get("game_date") or time.time()
            y0 = calendar.timegm((utc_year(gd) or 1970, 1, 1, 0, 0, 0))
            for sid, pts in con.execute("select prestige_log_stable_id, sum(prestige_log_points) from prestige_log where prestige_log_date >= ? group by 1", (y0,)):
                out.setdefault(sid, {})["this_year"] = pts
    elif tab == "horses":
        # the save only keeps age-group counts for the player's stable, so count them from the horses (alive, by age at the game date)
        gd = META.get("game_date") or time.time()
        hc = columns(con, "horses")
        preg = "sum(h.horse_is_pregnant is not null)" if "horse_is_pregnant" in hc else "null"
        stud = "sum(h.horse_stud_date is not null)" if "horse_stud_date" in hc else "null"
        for r in rows(con, """select h.horse_stable_id as id, count(*) as horses,
                sum(h.horse_birth_date > ?) as foals, sum(h.horse_birth_date <= ? and h.horse_birth_date > ?) as yearlings,
                sum(h.horse_birth_date <= ? and h.horse_birth_date > ?) as two_yo, sum(h.horse_birth_date <= ?) as older,
                %s as in_foal, %s as at_stud, avg(h.horse_international_rating) as avg_rating, max(h.horse_international_rating) as top_rating,
                sum(coalesce(h.horse_value_calculated,0)) as horses_value
                from horses h where h.horse_stable_id > 0 and h.horse_deceased_date is null
                and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses') group by 1""" % (preg, stud),
                (gd - YEAR, gd - YEAR, gd - 2 * YEAR, gd - 2 * YEAR, gd - 3 * YEAR, gd - 3 * YEAR)):
            out[r["id"]] = r
    elif tab == "traders":
        def add(sid, kind, amount):
            if not sid or sid <= 0:
                return
            f = out.setdefault(sid, {"sold": 0, "sales": 0.0, "bought": 0, "spent": 0.0})
            if kind == "sell":
                f["sold"] += 1; f["sales"] += amount or 0
            else:
                f["bought"] += 1; f["spent"] += amount or 0
        if has_table(con, "auction_results"):
            when = " and auction_result_date >= ? and auction_result_date < ?" if year else ""
            for seller, buyer, price in con.execute("""select auction_result_from_stable_id, auction_result_to_stable_id, auction_result_final_price
                    from auction_results where auction_result_accepted in (1,'1','true')%s""" % when, args):
                add(seller, "sell", price); add(buyer, "buy", price)
        if has_table(con, "transactions") and {"transaction_category", "transaction_from_entity_type"} <= set(columns(con, "transactions")):
            when = " and transaction_date >= ? and transaction_date < ?" if year else ""
            # private sales: paid by the buying stable to the selling one
            for buyer, seller, amount in con.execute("""select cast(transaction_from_entity_id as int), cast(transaction_to_entity_id as int), transaction_amount
                    from transactions where transaction_category='horse_trade' and transaction_from_entity_type='stable' and transaction_to_entity_type='stable'%s""" % when, args):
                add(seller, "sell", amount); add(buyer, "buy", amount)
        for f in out.values():
            f["profit"] = f["sales"] - f["spent"]
            f["traded"] = f["sold"] + f["bought"]
    elif tab == "breeders":
        if has_table(con, "breeding"):
            for r in rows(con, """select b.breeding_stable_id as id, count(*) as foals, sum(coalesce(s.starts,0) > 0) as runners, sum(coalesce(s.wins,0) > 0) as winners,
                    sum(coalesce(s.stakes_wins,0) > 0) as stakes_winners, sum(coalesce(s.g1,0) > 0) as g1_winners,
                    sum(coalesce(h.horse_career_earnings,0)) as earnings
                    from breeding b left join horses h on h.horse_horse_id=b.breeding_horse_id left join hrmv_horse_stats s on s.horse_id=b.breeding_horse_id
                    where b.breeding_stable_id > 0 and b.breeding_horse_id > 0 group by 1"""):
                out[r["id"]] = r
    elif tab == "value":
        if has_table(con, "stable_financial_snapshots"):
            fc = columns(con, "stable_financial_snapshots")
            col = lambda c: c if c in fc else "null"
            for r in rows(con, """select snapshot_stable_id as id, %s as market_cap, %s as net_worth, %s as horses, coalesce(%s,0) + coalesce(%s,0) as property,
                    %s as cash, %s as loans from (
                    select *, row_number() over (partition by snapshot_stable_id order by snapshot_date desc) as rn from stable_financial_snapshots) where rn=1""" % (
                    col("snapshot_market_cap"), col("snapshot_net_worth"), col("snapshot_horses_value"), col("snapshot_racecourses_value"),
                    col("snapshot_auction_houses_value"), col("snapshot_cash"), col("snapshot_loans"))):
                # the game's stable value: its market value where it has one, otherwise what it owns less what it owes
                r["value"] = r["market_cap"] if r["market_cap"] else r["net_worth"]
                out[r["id"]] = r
    return out


def sr_table(con, tab, year):
    """Every open stable with this tab's figures, ranked by the tab's main figure (the rank stays when sorting by another column)."""
    key = (DB_GEN, tab, year)
    if key not in SR_CACHE:
        for k in [k for k in SR_CACHE if k[0] != DB_GEN]:
            SR_CACHE.pop(k, None)
        figs = sr_figures(con, tab, year)
        main = SR_TABS[tab]["main"]
        data = []
        for b in sr_base(con):
            f = figs.get(b["id"]) or {}
            r = dict(b)
            r.update({k: v for k, v in f.items() if k != "id"})
            data.append(r)
        if tab == "prestige":    # prestige rank now, and how far it has moved since the year began
            for i, r in enumerate(sorted(data, key=lambda r: -(r.get("prestige") or 0))):
                r["now_rank"] = i + 1
                r["move"] = (r["start_rank"] - r["now_rank"]) if r.get("start_rank") else None
        data.sort(key=lambda r: (r.get(main) is None, -(r.get(main) or 0), (r.get("name") or "").lower()))
        for i, r in enumerate(data):
            r["rank"] = i + 1
        SR_CACHE[key] = data
    return SR_CACHE[key]


def api_stable_rankings(con, q):
    tab = q.get("tab") if q.get("tab") in SR_TABS else "value"
    years = result_years(con)
    year = to_int(q.get("year")) if SR_TABS[tab]["year"] else None
    if SR_TABS[tab]["year"] and q.get("year") is None and years:
        year = utc_year(META.get("game_date") or time.time())       # this season unless another year (or all time) is picked
    data = sr_table(con, tab, year or None)
    text = (q.get("q") or "").strip().lower()
    if text:
        data = [r for r in data if text in (r.get("name") or "").lower() or text in (r.get("owner") or "").lower() or text in (r.get("country") or "").lower()]
    if q.get("mine"):
        mine = {s["id"] for s in my_stables(con, META.get("player_id"), META.get("player_stable_id"))}
        data = [r for r in data if r["id"] in mine]
    sort = q.get("sort") or "rank"
    if data and sort not in data[0] and sort != "rank":
        sort = "rank"
    desc = (q.get("dir") or ("asc" if sort in ("rank", "name", "owner", "country") else "desc")) == "desc"
    have = [r for r in data if r.get(sort) is not None]
    have.sort(key=lambda r: (r[sort].lower() if isinstance(r[sort], str) else r[sort]), reverse=desc)
    data = have + [r for r in data if r.get(sort) is None]
    size = getattr(PAGE_LOCAL, "size", None) or SR_PAGE
    total = len(data)
    page = max(1, min(to_int(q.get("page"), 1), max(1, -(-total // size))))
    full = sr_table(con, tab, year or None)
    blank = sorted({k for k in (full[0] if full else {}) if all(not r.get(k) for r in full)})
    return {"tab": tab, "year": year, "years": years, "total": total, "page": page, "page_size": size, "blank": blank,
            "rows": data[(page - 1) * size: page * size]}


def api_stable_table(con, q):
    sql, count_sql, params = stable_table_query(con, q)
    page = max(1, to_int(q.get("page"), 1))
    size = getattr(PAGE_LOCAL, "size", None) or 100
    total = count_rows(con, count_sql, params)
    data = rows(con, sql + " limit %d offset %d" % (size, (page - 1) * size), params)
    countries = [r[0] for r in con.execute("""select distinct n.country_name from stables s join cities c on c.city_id=s.stable_city_id
        join countries n on n.country_id=c.city_country_id where n.country_name is not null order by 1""")]
    return {"total": total, "page": page, "page_size": size, "rows": data, "countries": countries}


# --------------------------------------------------------------------------- Pedigrees tab

PED_SORTS = {
    "name": "p.horse_name", "birth": "p.horse_birth_date", "foals": "g.foals", "runners": "g.runners", "winners": "g.winners",
    "winner_pct": "(1.0*g.winners/nullif(g.runners,0))", "stakes_winners": "g.stakes_winners", "g1_winners": "g.g1_winners",
    "wins": "g.wins", "earnings": "g.earnings", "per_runner": "(g.earnings/nullif(g.runners,0))", "stud_fee": "p.horse_stud_fee",
    "rating": "p.horse_international_rating", "own_earnings": "p.horse_career_earnings",
}


def pedigree_query(con, q):
    kind = q.get("kind") or "sires"
    if kind == "dams":
        parent, frm = "o.horse_breeding_parent_mare_id", "horses o"
    elif kind == "damsires":
        parent, frm = "dm.horse_breeding_parent_stallion_id", "horses o join horses dm on dm.horse_horse_id=o.horse_breeding_parent_mare_id"
    else:
        parent, frm = "o.horse_breeding_parent_stallion_id", "horses o"
    inner_where, params = ["%s>0" % parent], []
    if q.get("from"):
        inner_where.append("o.horse_birth_date>=?"); params.append(year_start(to_int(q["from"])))
    if q.get("to"):
        inner_where.append("o.horse_birth_date<?"); params.append(year_start(to_int(q["to"]) + 1))
    if q.get("osex") in ("Male", "Female"):
        inner_where.append("o.horse_sex=?"); params.append(q["osex"])
    inner = """select %s as id, count(*) as foals, sum(coalesce(s.starts,0)>0) as runners, sum(coalesce(s.wins,0)>0) as winners,
        sum(coalesce(s.stakes_wins,0)>0 or coalesce(o.horse_g1_wins,0)+coalesce(o.horse_g2_wins,0)+coalesce(o.horse_g3_wins,0)+coalesce(o.horse_listed_wins,0)>0) as stakes_winners,
        sum(%s>0) as g1_winners, sum(coalesce(s.wins,0)) as wins, sum(coalesce(o.horse_career_earnings,0)) as earnings,
        sum(o.horse_deceased_date is null) as alive_foals
        from %s left join hrmv_horse_stats s on s.horse_id=o.horse_horse_id
        where %s group by %s""" % (parent, gwins("o", "s", "g1"), frm, " and ".join(inner_where), parent)
    outer_where = []
    if q.get("q"):
        outer_where.append("p.horse_name like ?"); params.append("%" + q["q"] + "%")
    if (q.get("status") or "all") == "alive":
        outer_where.append("p.horse_deceased_date is null and p.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')")
    elif q.get("status") == "dead":
        outer_where.append("(p.horse_deceased_date is not null or p.horse_horse_id in (select pk from hrmv_removed where tbl='horses'))")
    if to_int(q.get("minrunners")):
        outer_where.append("g.runners>=?"); params.append(to_int(q["minrunners"]))
    if q.get("mine") == "1":                # only those in stables you own
        ids = owned_stable_ids(con)
        outer_where.append("p.horse_stable_id in (%s)" % ",".join(str(int(i)) for i in ids) if ids else "0=1")
    base = "from (%s) g join horses p on p.horse_horse_id=g.id left join stables st on st.stable_stable_id=p.horse_stable_id" % inner
    w = (" where " + " and ".join(outer_where)) if outer_where else ""
    sel = """select g.*, p.horse_name as name, p.horse_birth_date as birth, p.horse_deceased_date as died, p.horse_stud_fee as stud_fee,
        p.horse_international_rating as rating, p.horse_career_earnings as own_earnings, p.horse_stable_id as stable_id, st.stable_name as stable,
        p.horse_breeding_parent_stallion_id as sire_id, p.horse_breeding_parent_mare_id as dam_id """
    sort, d = sort_args(q, PED_SORTS, "earnings")
    return kind, sel + base + w + " order by " + order_sql(sort, d), "select count(*) " + base + w, params


def year_start(y):
    import calendar
    return calendar.timegm((y, 1, 1, 0, 0, 0))


def api_pedigrees(con, q):
    kind, sql, count_sql, params = pedigree_query(con, q)
    page = max(1, to_int(q.get("page"), 1))
    size = getattr(PAGE_LOCAL, "size", None) or 50
    # one pass: the window count gives the total alongside the page of rows
    sql = sql.replace("select g.*,", "select count(*) over () as _total, g.*,", 1)
    data = rows(con, sql + " limit %d offset %d" % (size, (page - 1) * size), params)
    total = data[0]["_total"] if data else (con.execute(count_sql, params).fetchone()[0] if page > 1 else 0)
    for r in data:
        if kind == "damsires":
            best = one(con, """select o.horse_horse_id as id, o.horse_name as name, o.horse_career_earnings as earnings from horses o
                join horses dm on dm.horse_horse_id=o.horse_breeding_parent_mare_id where dm.horse_breeding_parent_stallion_id=?
                order by o.horse_career_earnings desc limit 1""", (r["id"],))
        else:
            col = "horse_breeding_parent_mare_id" if kind == "dams" else "horse_breeding_parent_stallion_id"
            best = one(con, "select horse_horse_id as id, horse_name as name, horse_career_earnings as earnings from horses where %s=? order by horse_career_earnings desc limit 1" % col, (r["id"],))
        r["best"] = best
    names = name_map(con, "horses", "horse_horse_id", "horse_name", [r["sire_id"] for r in data] + [r["dam_id"] for r in data])
    for r in data:
        r["sire"] = names.get(r["sire_id"]); r["dam"] = names.get(r["dam_id"])
    return {"kind": kind, "total": total, "page": page, "page_size": size, "rows": data}


def horse_brief(con, ids):
    ids = [i for i in set(ids) if realid(i)]
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_sex as sex, h.horse_birth_date as birth,
            h.horse_deceased_date as died, h.horse_color as color, h.horse_career_earnings as earnings,
            h.horse_breeding_parent_stallion_id as sire_id, h.horse_breeding_parent_mare_id as dam_id,
            %s as g1, coalesce(s.starts,0) as starts, coalesce(s.wins,0) as wins, coalesce(s.stakes_wins,0) as stakes_wins,
            h.horse_international_rating as rating
            from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id where h.horse_horse_id in (%s)"""
                         % (gwins("h", "s", "g1"), ",".join("?" * len(chunk))), chunk):
            out[r["id"]] = r
    return out


def realid(v):
    return v not in (None, 0, -1, "")


PED_GENS = (4, 8, 12, 16)


def ancestry(con, hid, depth):
    """Walk back `depth` generations. Returns (info by id, per-generation {id: times it appears}, first generation each id appears)."""
    info = horse_brief(con, [hid])
    if hid not in info:
        return None, None, None
    per_gen, mingen = [], {hid: 0}
    gen = {hid: 1}
    for g in range(1, depth + 1):
        nxt = {}
        for i, n in gen.items():
            h = info.get(i)
            if not h:
                continue
            for p in (h["sire_id"], h["dam_id"]):
                if realid(p):
                    nxt[p] = nxt.get(p, 0) + n
        new = [i for i in nxt if i not in info]
        if new:
            info.update(horse_brief(con, new))
        nxt = {i: n for i, n in nxt.items() if i in info}
        if not nxt:
            break
        for i in nxt:
            mingen.setdefault(i, g)
        per_gen.append(nxt)
        gen = nxt
    return info, per_gen, mingen


def inbreeding(info, mingen, hid, depth):
    """Wright's coefficient of inbreeding over `depth` generations (tabular kinship with memory)."""
    import sys as _sys
    _sys.setrecursionlimit(max(_sys.getrecursionlimit(), 10000))
    order = sorted(mingen, key=lambda i: ((info[i]["birth"] if isinstance(info[i]["birth"], (int, float)) else 0), i))
    idx = {i: k for k, i in enumerate(order)}
    n = len(order)
    sire, dam = [-1] * n, [-1] * n
    for i, k in idx.items():
        h = info[i]
        for arr, p in ((sire, h["sire_id"]), (dam, h["dam_id"])):
            if p in idx and mingen[p] <= depth and mingen.get(i, 0) < depth:
                arr[k] = idx[p]
    memo_k, memo_f = {}, {}

    def F(x):
        v = memo_f.get(x)
        if v is None:
            v = K(sire[x], dam[x]) if sire[x] >= 0 and dam[x] >= 0 else 0.0
            memo_f[x] = v
        return v

    def K(a, b):
        if a < 0 or b < 0:
            return 0.0
        if a == b:
            return 0.5 * (1.0 + F(a))
        if a > b:
            a, b = b, a          # b is the younger: expand it
        key = a * n + b
        v = memo_k.get(key)
        if v is None:
            v = 0.5 * (K(a, sire[b]) + K(a, dam[b]))
            memo_k[key] = v
        return v

    return F(idx[hid])


def api_coi(con, hid, q):
    depth = to_int(q.get("gens"), 4)
    depth = depth if depth in PED_GENS else 4
    info, per_gen, mingen = ancestry(con, hid, depth)
    if info is None:
        return None
    return {"gens": depth, "coi": inbreeding(info, mingen, hid, depth)}


def api_pedigree(con, hid, q=None):
    q = q or {}
    depth = to_int(q.get("gens"), 4)
    depth = depth if depth in PED_GENS else 4
    me = horse_brief(con, [hid]).get(hid)
    if not me:
        return None
    deep = None
    if depth > 4:
        info, per_gen, mingen = ancestry(con, hid, depth)
        anc = {}
        for g, counts in enumerate(per_gen, 1):
            for i, c in counts.items():
                a = anc.setdefault(i, {"id": i, "gens": {}, "times": 0, "blood": 0.0})
                a["gens"][g] = c
                a["times"] += c
                a["blood"] += c * 0.5 ** g
        ranked = sorted(anc.values(), key=lambda a: -a["blood"])
        top = ranked[:300]
        top_ids = {a["id"] for a in top}
        top += [a for a in ranked if a["times"] > 1 and a["id"] not in top_ids][:300]
        for a in top:
            h = info[a["id"]]
            a.update({"name": h["name"], "sex": h["sex"], "birth": h["birth"], "earnings": h["earnings"], "g1": h["g1"],
                      "starts": h["starts"], "wins": h["wins"], "stakes_wins": h["stakes_wins"]})
        def line(key):
            out, x = [], me
            for _ in range(depth):
                p = x.get(key)
                if not realid(p) or p not in info:
                    break
                x = info[p]
                out.append({"id": x["id"], "name": x["name"], "birth": x["birth"], "earnings": x["earnings"], "g1": x["g1"], "starts": x["starts"], "wins": x["wins"]})
            return out
        keep = ("id", "name", "sex", "birth", "died", "sire_id", "dam_id", "starts", "wins", "earnings", "g1", "stakes_wins")
        deep = {
            "depth": depth,
            "generations": [{"gen": g, "known": sum(c.values()), "possible": 2 ** g, "distinct": len(c)} for g, c in enumerate(per_gen, 1)],
            "ancestors": top,
            "ancestor_total": len(anc),
            "repeated_total": sum(1 for a in anc.values() if a["times"] > 1),
            "sire_line": line("sire_id"),
            "dam_line": line("dam_id"),
            "nodes": {str(i): {k: h.get(k) for k in keep} for i, h in info.items() if mingen.get(i, 99) <= depth},
            "times": {str(i): a["times"] for i, a in anc.items() if a["times"] > 1},
        }
    gens = 5
    tree = {"": me}
    frontier = {"": me}
    for g in range(1, gens):
        want = {}
        for path, h in frontier.items():
            if h:
                want[path + "s"] = h["sire_id"]
                want[path + "d"] = h["dam_id"]
        info = horse_brief(con, list(want.values()))
        frontier = {p: info.get(i) for p, i in want.items()}
        tree.update(frontier)
    # ancestors appearing more than once (inbreeding)
    seen = {}
    for path, h in tree.items():
        if path and h:
            seen.setdefault(h["id"], {"id": h["id"], "name": h["name"], "gens": []})["gens"].append(len(path))
    repeats = sorted([v for v in seen.values() if len(v["gens"]) > 1], key=lambda v: min(v["gens"]))
    for v in repeats:
        v["gens"].sort()

    def sib_query(where, params, limit=60):
        return rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth,
            h.horse_deceased_date as died, h.horse_career_earnings as earnings, %s as g1, coalesce(s.starts,0) as starts,
            coalesce(s.wins,0) as wins, coalesce(s.stakes_wins,0) as stakes_wins,
            h.horse_breeding_parent_stallion_id as sire_id, h.horse_breeding_parent_mare_id as dam_id
            from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id
            where %s and h.horse_horse_id<>? order by h.horse_career_earnings desc limit %d""" % (gwins("h", "s", "g1"), where, limit), params + [hid])

    out = {"horse": me, "tree": tree, "repeats": repeats, "depth": depth, "deep": deep}
    sire_id, dam_id = me["sire_id"], me["dam_id"]
    out["full_siblings"] = sib_query("h.horse_breeding_parent_stallion_id=? and h.horse_breeding_parent_mare_id=?", [sire_id, dam_id]) if realid(sire_id) and realid(dam_id) else []
    out["half_dam"] = sib_query("h.horse_breeding_parent_mare_id=? and h.horse_breeding_parent_stallion_id<>?", [dam_id, sire_id or -99]) if realid(dam_id) else []
    out["half_sire"] = sib_query("h.horse_breeding_parent_stallion_id=? and h.horse_breeding_parent_mare_id<>?", [sire_id, dam_id or -99], 25) if realid(sire_id) else []
    out["half_sire_total"] = con.execute("select count(*) from horses where horse_breeding_parent_stallion_id=? and horse_breeding_parent_mare_id<>? and horse_horse_id<>?",
                                         (sire_id, dam_id or -99, hid)).fetchone()[0] if realid(sire_id) else 0
    names = name_map(con, "horses", "horse_horse_id", "horse_name", [r["sire_id"] for r in out["half_dam"]] + [r["dam_id"] for r in out["half_sire"]])
    for r in out["half_dam"]:
        r["other"] = names.get(r["sire_id"]); r["other_id"] = r["sire_id"]
    for r in out["half_sire"]:
        r["other"] = names.get(r["dam_id"]); r["other_id"] = r["dam_id"]

    col = "horse_breeding_parent_mare_id" if me["sex"] == "Female" else "horse_breeding_parent_stallion_id"
    out["progeny_summary"] = one(con, """select count(*) as foals, sum(coalesce(s.starts,0)>0) as runners, sum(coalesce(s.wins,0)>0) as winners,
        sum(coalesce(s.stakes_wins,0)>0) as stakes_winners, sum(%s>0) as g1_winners, sum(coalesce(o.horse_career_earnings,0)) as earnings
        from horses o left join hrmv_horse_stats s on s.horse_id=o.horse_horse_id where o.%s=?""" % (gwins("o", "s", "g1"), col), (hid,))
    out["progeny_col"] = "dam" if me["sex"] == "Female" else "sire"
    for side, pid in (("sire_summary", sire_id), ("dam_summary", dam_id)):
        if realid(pid):
            c2 = "horse_breeding_parent_stallion_id" if side == "sire_summary" else "horse_breeding_parent_mare_id"
            out[side] = one(con, """select count(*) as foals, sum(coalesce(s.starts,0)>0) as runners, sum(coalesce(s.wins,0)>0) as winners,
                sum(coalesce(s.stakes_wins,0)>0) as stakes_winners, sum(coalesce(o.horse_career_earnings,0)) as earnings
                from horses o left join hrmv_horse_stats s on s.horse_id=o.horse_horse_id where o.%s=?""" % c2, (pid,))
    return out



# --------------------------------------------------------------------------- Meetings (Races tab) and stable race history

TOP_RACE_SQL = """(select x.races_race_id from races x where x.races_race_day_id=d.raceday_race_day_id and x.races_type_of_race in ('G1','G2','G3','listed')
    order by case x.races_type_of_race when 'G1' then 1 when 'G2' then 2 when 'G3' then 3 else 4 end, x.races_prize_money_total desc limit 1)"""
MEET_SORTS = {"date": "d.raceday_date", "course": "c.racecourse_name", "name": "d.raceday_raceseries_name", "races": "races", "purse": "purse"}


def api_meetings(con, q):
    gd = META.get("game_date") or time.time()
    where, params = [], []
    when = q.get("when") or "past"
    if when == "past":
        where.append("d.raceday_date<=?"); params.append(gd)
    elif when == "upcoming":
        where.append("d.raceday_date>?"); params.append(gd)
    if q.get("q"):
        where.append("(d.raceday_raceseries_name like ? or c.racecourse_name like ?)"); params += ["%" + q["q"] + "%"] * 2
    if q.get("country"):
        where.append("c.racecourse_location_country=?"); params.append(q["country"])
    if q.get("course"):
        where.append("d.raceday_racecourse_id=?"); params.append(to_int(q["course"]))
    if q.get("group") == "1":
        where.append("exists (select 1 from races g where g.races_race_day_id=d.raceday_race_day_id and g.races_type_of_race in ('G1','G2','G3'))")
    sort, dr = sort_args(q, MEET_SORTS, "date")
    if not q.get("sort") and when == "upcoming":
        dr = "asc"
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    base = " from race_days d left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id"
    total = count_rows(con, "select count(*)" + base + w, params)
    data = rows(con, """select d.raceday_race_day_id as id, d.raceday_date as date, d.raceday_raceseries_name as name,
        d.raceday_weather_condition as weather, d.raceday_temperature as temp, c.racecourse_racecourse_id as course_id,
        c.racecourse_name as course, c.racecourse_location_country as country,
        (select count(*) from races x where x.races_race_day_id=d.raceday_race_day_id) as races,
        (select sum(x.races_prize_money_total) from races x where x.races_race_day_id=d.raceday_race_day_id) as purse,
        %s as top_race_id,
        coalesce(d.raceday_vip_sold,0)+coalesce(d.raceday_normal_sold,0)+coalesce(d.raceday_standing_sold,0) as crowd,
        d.raceday_betting_handle as handle""" % TOP_RACE_SQL + base + w +
                " order by %s limit %d offset %d" % (order_sql(sort, dr), page_size(), off), params)
    ids = [r["top_race_id"] for r in data if r["top_race_id"]]
    tops = {}
    if ids:
        for r in con.execute("select races_race_id, races_race_name, races_type_of_race from races where races_race_id in (%s)" % ",".join("?" * len(ids)), ids):
            tops[r[0]] = (r[1], r[2])
    for r in data:
        r["top_race_name"], r["top_grade"] = tops.get(r["top_race_id"], (None, None))
    countries = [x[0] for x in con.execute("select distinct racecourse_location_country from racecourses where racecourse_location_country is not null order by 1")]
    return {"total": total, "page": page, "page_size": page_size(), "rows": data, "countries": countries}


def api_meeting(con, mid):
    day = one(con, "select * from race_days where raceday_race_day_id=?", (mid,))
    if not day:
        return None
    out = {"day": clean_blob(day)}
    out["course"] = one(con, """select racecourse_racecourse_id as id, racecourse_name as name, racecourse_location_country as country,
        racecourse_location_city as city, racecourse_outer_oval_track_surface as surface from racecourses where racecourse_racecourse_id=?""", (day["raceday_racecourse_id"],))
    races = rows(con, """select x.races_race_id as race_id, x.races_race_name as race_name, x.races_race_number as number,
        x.races_race_date_time as race_time, x.races_distance as distance, x.races_type_of_race as race_type, x.races_track as track,
        x.races_prize_money_total as purse, x.races_gender_restriction as sex, x.races_max_participants as max_runners
        from races x where x.races_race_day_id=? order by x.races_race_date_time, x.races_race_number""", (mid,))
    for r in races:
        r["results"] = rows(con, """select r.race_result_rank as rank, r.race_result_time as time, r.race_result_cash_received as prize,
            r.race_result_win_odds as odds, r.race_result_starting_position as gate, r.race_result_rating as rating,
            r.race_result_horse_id as horse_id, h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth,
            h.horse_color as color, r.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey,
            r.race_result_trainer_id as trainer_id, t.person_full_name as trainer, r.race_result_running_style as style,
            r.race_result_stable_id as stable_id, s.stable_name as stable
            from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
            left join persons j on j.person_person_id=r.race_result_person_jockey_id
            left join persons t on t.person_person_id=r.race_result_trainer_id
            left join stables s on s.stable_stable_id=r.race_result_stable_id
            where r.race_result_race_id=? order by r.race_result_rank""", (r["race_id"],))
        add_prerace_form(con, r["results"], r["race_time"])
        r["sectionals"] = race_sectionals(con, r["race_id"]) if r["results"] else []
        if not r["results"] and has_table(con, "race_participants"):
            r["entries"] = rows(con, """select p.race_participant_starting_position as gate, p.race_participant_horse_id as horse_id,
                h.horse_name as horse, h.horse_gender as gender, h.horse_birth_date as birth, h.horse_international_rating as rating,
                h.horse_form as form, p.race_participant_person_jockey_id as jockey_id, j.person_full_name as jockey,
                h.horse_color as color, h.horse_trainer_id as trainer_id, t.person_full_name as trainer,
                p.race_participant_stable_id as stable_id, s.stable_name as stable
                from race_participants p left join horses h on h.horse_horse_id=p.race_participant_horse_id
                left join persons j on j.person_person_id=p.race_participant_person_jockey_id
                left join persons t on t.person_person_id=h.horse_trainer_id
                left join stables s on s.stable_stable_id=p.race_participant_stable_id
                where p.race_participant_race_id=? order by p.race_participant_starting_position""", (r["race_id"],))
            add_prerace_form(con, r["entries"], r["race_time"])
    out["races"] = races
    nb = one(con, """select d.raceday_race_day_id as id, d.raceday_date as date from race_days d where d.raceday_racecourse_id=? and d.raceday_date<?
        order by d.raceday_date desc limit 1""", (day["raceday_racecourse_id"], day["raceday_date"]))
    na = one(con, """select d.raceday_race_day_id as id, d.raceday_date as date from race_days d where d.raceday_racecourse_id=? and d.raceday_date>?
        order by d.raceday_date asc limit 1""", (day["raceday_racecourse_id"], day["raceday_date"]))
    out["prev_meeting"], out["next_meeting"] = nb, na
    return out


SR_SORTS = {"date": "r.race_result_date", "rank": "r.race_result_rank", "prize": "r.race_result_cash_received",
            "horse": "h.horse_name", "race": "x.races_race_name", "distance": "x.races_distance", "jockey": "j.person_full_name"}


def stable_races_query(con, q):
    sid = to_int(q.get("stable"))
    where, params = ["r.race_result_stable_id=?"], [sid]
    if q.get("q"):
        where.append("(h.horse_name like ? or x.races_race_name like ?)"); params += ["%" + q["q"] + "%"] * 2
    if q.get("type"):
        where.append("x.races_type_of_race=?"); params.append(q["type"])
    if q.get("result") == "wins":
        where.append("r.race_result_rank=1")
    elif q.get("result") == "placed":
        where.append("r.race_result_rank<=3")
    if q.get("year"):
        y = to_int(q["year"])
        if y:
            where.append("r.race_result_date>=? and r.race_result_date<?"); params += [year_start(y), year_start(y + 1)]
    base = """ from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
        left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        left join persons j on j.person_person_id=r.race_result_person_jockey_id"""
    w = " where " + " and ".join(where)
    sel = """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_time as time, r.race_result_cash_received as prize,
        r.race_result_win_odds as odds, r.race_result_horse_id as horse_id, h.horse_name as horse, r.race_result_race_id as race_id,
        x.races_race_name as race_name, x.races_type_of_race as race_type, x.races_distance as distance,
        c.racecourse_racecourse_id as course_id, c.racecourse_name as course, d.raceday_race_day_id as meeting_id,
        r.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey,
        (select count(*) from race_results rr where rr.race_result_race_id=r.race_result_race_id and r.race_result_race_id>0) as runners"""
    sort, dr = sort_args(q, SR_SORTS, "date")
    return sel + base + w + " order by %s, r.race_result_id desc" % order_sql(sort, dr), "select count(*)" + base + w, params


def api_stable_races(con, sid, q):
    q = dict(q, stable=str(sid))
    st = one(con, "select stable_stable_id as id, stable_name as name from stables where stable_stable_id=?", (sid,))
    if not st:
        return None
    sql, count_sql, params = stable_races_query(con, q)
    page = max(1, to_int(q.get("page"), 1))
    size = getattr(PAGE_LOCAL, "size", None) or 100
    total = count_rows(con, count_sql, params)
    data = rows(con, sql + " limit %d offset %d" % (size, (page - 1) * size), params)
    years = [r[0] for r in con.execute("""select distinct cast(strftime('%Y', race_result_date, 'unixepoch') as integer) from race_results
        where race_result_stable_id=? order by 1 desc""", (sid,)) if r[0]]
    rec = one(con, "select * from hrmv_stable_stats where stable_id=?", (sid,)) if has_table(con, "hrmv_stable_stats") else None
    return {"stable": st, "record": rec, "total": total, "page": page, "page_size": size, "rows": data, "years": years}


# --------------------------------------------------------------------------- runner form (race pages)

SURFACE_COL = {"Outer Oval": "racecourse_outer_oval_track_surface", "Center Oval": "racecourse_center_oval_track_surface",
               "Inner Oval": "racecourse_inner_oval_track_surface", "Straight Track": "racecourse_straight_track_material"}
SPELL_DAYS = 60   # a gap longer than this starts a new preparation ("1st up")


def rec_str(rs):
    """(starts, wins, 2nds, 3rds) for a list of finishing positions."""
    return [len(rs), sum(1 for r in rs if r == 1), sum(1 for r in rs if r == 2), sum(1 for r in rs if r == 3)]


def form_digit(rank):
    if not isinstance(rank, (int, float)) or rank <= 0:
        return "x"
    return "0" if rank >= 10 else str(int(rank))


def add_prerace_form(con, runners, when):
    """Add last-5 form, career record and last start (all before `when`) to each runner row."""
    when = when or META.get("game_date") or time.time()
    when = (when // 86400) * 86400          # results are stored at midnight on race day: only count earlier days
    for r in runners:
        hist = con.execute("""select race_result_rank, race_result_date, race_result_race_id from race_results
            where race_result_horse_id=? and race_result_date<? order by race_result_date desc, race_result_id desc""", (r["horse_id"], when)).fetchall()
        ranks = [h[0] for h in hist]
        r["form"] = "".join(form_digit(x) for x in reversed(ranks[:5])) if ranks else ""
        r["career"] = rec_str(ranks)
        if hist:
            last = hist[0]
            n = con.execute("select count(*) from race_results where race_result_race_id=?", (last[2],)).fetchone()[0] if last[2] else None
            r["last"] = {"rank": last[0], "runners": n, "days": int((when - last[1]) // 86400) if last[1] else None}
        else:
            r["last"] = None


def api_runner(con, q):
    rid, hid = to_int(q.get("race")), to_int(q.get("horse"))
    race = None if not rid else one(con, """select x.races_race_id as race_id, x.races_race_date_time as date, x.races_distance as distance, x.races_track as track,
        x.races_type_of_race as race_type, d.raceday_weather_condition as weather, d.raceday_racecourse_id as course_id,
        c.racecourse_name as course, c.racecourse_direction as direction, c.racecourse_outer_oval_track_surface as s_outer,
        c.racecourse_center_oval_track_surface as s_center, c.racecourse_inner_oval_track_surface as s_inner,
        c.racecourse_straight_track_material as s_straight
        from races x join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id where x.races_race_id=?""", (rid,))
    h = one(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_birth_date as birth, h.horse_gender as gender, h.horse_color as color,
        h.horse_breed as breed, h.horse_international_rating as rating, h.horse_career_earnings as earnings,
        h.horse_style_front as sf, h.horse_style_press as sp, h.horse_style_mid as sm, h.horse_style_back as sb,
        h.horse_running_style_instruction as instruction, h.horse_distance_preference as dist_pref, h.horse_weather_preference as weather_pref,
        h.horse_breeding_parent_stallion_id as sire_id, sp.horse_name as sire, h.horse_breeding_parent_mare_id as dam_id, dp.horse_name as dam,
        dp.horse_breeding_parent_stallion_id as damsire_id, ds.horse_name as damsire,
        h.horse_stable_id as stable_id, st.stable_name as stable, h.horse_trainer_id as trainer_id, tr.person_full_name as trainer
        from horses h left join horses sp on sp.horse_horse_id=h.horse_breeding_parent_stallion_id
        left join horses dp on dp.horse_horse_id=h.horse_breeding_parent_mare_id
        left join horses ds on ds.horse_horse_id=dp.horse_breeding_parent_stallion_id
        left join stables st on st.stable_stable_id=h.horse_stable_id
        left join persons tr on tr.person_person_id=h.horse_trainer_id where h.horse_horse_id=?""", (hid,))
    if not h or (rid and not race):
        return None
    if race is None:
        # no particular race (horse page): everything up to now, nothing highlighted
        race = {"race_id": None, "date": (META.get("game_date") or time.time()) + 86400, "distance": None, "track": None, "race_type": None,
                "weather": None, "course_id": None, "course": None, "direction": None, "s_outer": None, "s_center": None, "s_inner": None, "s_straight": None}
    when = race["date"] or META.get("game_date") or time.time()
    when = (when // 86400) * 86400          # results are stored at midnight on race day: only count earlier days
    race["surface"] = {"Outer Oval": race["s_outer"], "Center Oval": race["s_center"], "Inner Oval": race["s_inner"], "Straight Track": race["s_straight"]}.get(race["track"])
    # this race's jockey / trainer
    me = one(con, """select race_result_person_jockey_id as jockey_id, race_result_trainer_id as trainer_id, race_result_gear as gear,
        race_result_starting_position as gate from race_results where race_result_race_id=? and race_result_horse_id=?""", (rid, hid)) if rid else None
    if not me and rid and has_table(con, "race_participants"):
        me = one(con, """select race_participant_person_jockey_id as jockey_id, race_participant_starting_position as gate
            from race_participants where race_participant_race_id=? and race_participant_horse_id=?""", (rid, hid))
    me = me or {}
    if not rid:
        # horse page: use its usual jockey (preferred, or the one from its last start)
        pj = con.execute("select horse_prefered_jockey_id from horses where horse_horse_id=?", (hid,)).fetchone()
        lj = con.execute("select race_result_person_jockey_id from race_results where race_result_horse_id=? order by race_result_date desc limit 1", (hid,)).fetchone()
        me = {"jockey_id": (pj[0] if pj and realid(pj[0]) else None) or (lj[0] if lj else None)}
    jockey_id = me.get("jockey_id")
    trainer_id = me.get("trainer_id") or h["trainer_id"]
    surf_case = " ".join("when '%s' then c.%s" % (k, v) for k, v in SURFACE_COL.items())
    runs = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_time as time, r.race_result_win_odds as odds,
        r.race_result_starting_position as gate, r.race_result_running_style as style, r.race_result_gear as gear,
        r.race_result_cash_received as prize_won, r.race_result_rating as rating, r.race_result_person_jockey_id as jockey_id,
        j.person_full_name as jockey, r.race_result_race_id as race_id, x.races_race_name as race_name, x.races_type_of_race as race_type,
        x.races_distance as distance, x.races_track as track, x.races_prize_money_total as purse, d.raceday_weather_condition as weather,
        d.raceday_race_day_id as meeting_id, c.racecourse_racecourse_id as course_id, c.racecourse_name as course,
        c.racecourse_direction as direction, case x.races_track %s end as surface
        from race_results r left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join race_days d on d.raceday_race_day_id=x.races_race_day_id
        left join racecourses c on c.racecourse_racecourse_id=d.raceday_racecourse_id
        left join persons j on j.person_person_id=r.race_result_person_jockey_id
        where r.race_result_horse_id=? and r.race_result_date<? order by r.race_result_date desc, r.race_result_id desc""" % surf_case, (hid, when))
    # first three home + field size + winner's time for the last starts shown
    for r in runs[:30]:
        if r["race_id"]:
            top = con.execute("""select r.race_result_rank, h.horse_name, r.race_result_horse_id, r.race_result_time from race_results r
                left join horses h on h.horse_horse_id=r.race_result_horse_id where r.race_result_race_id=? and r.race_result_rank<=3
                order by r.race_result_rank""", (r["race_id"],)).fetchall()
            r["top3"] = [{"rank": t[0], "name": t[1], "id": t[2]} for t in top]
            r["winner_time"] = top[0][3] if top else None
            r["runners"] = con.execute("select count(*) from race_results where race_result_race_id=?", (r["race_id"],)).fetchone()[0]
    # days since previous run and preparation run number (1st up, 2nd up...)
    chron = list(reversed(runs))
    prep = 0
    for i, r in enumerate(chron):
        gap = (r["date"] - chron[i - 1]["date"]) / 86400 if i else None
        r["days"] = int(gap) if gap is not None else None
        prep = 1 if (gap is None or gap > SPELL_DAYS) else prep + 1
        r["up"] = prep
    gap_now = (when - runs[0]["date"]) / 86400 if runs else None
    if gap_now is not None and not rid:
        gap_now = max(0, gap_now - 1)  # horse page: 'when' is the day after the game date
    up_now = 1 if (gap_now is None or gap_now > SPELL_DAYS) else (runs[0]["up"] + 1)
    ranks = lambda lst: rec_str([r["rank"] for r in lst])
    near = lambda r: r["distance"] and race["distance"] and abs(r["distance"] - race["distance"]) <= 50
    year = datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=when)
    ys, ye = year_start(year.year), year_start(year.year + 1)
    short = {
        "career": ranks(runs),
        "track": ranks([r for r in runs if r["course_id"] == race["course_id"]]),
        "distance": ranks([r for r in runs if near(r)]),
        "track_distance": ranks([r for r in runs if r["course_id"] == race["course_id"] and near(r)]),
        "season": ranks([r for r in runs if ys <= r["date"] < ye]),
        "up": {str(k): ranks([r for r in runs if (r["up"] == k if k < 4 else r["up"] >= 4)]) for k in (1, 2, 3, 4)},
        "weather": {w: ranks([r for r in runs if r["weather"] == w]) for w in ("Sunny", "Cloudy", "Rainy", "Stormy", "Foggy", "Snowy")},
        "surface": {sname: ranks([r for r in runs if r["surface"] == sname]) for sname in ("Turf", "Dirt", "Synthetic", "Clay")},
        "direction": {"CW": ranks([r for r in runs if r["direction"] == "CW"]), "CCW": ranks([r for r in runs if r["direction"] == "CCW"])},
        "jockey_horse": ranks([r for r in runs if jockey_id and r["jockey_id"] == jockey_id]),
        "first_up_now": up_now, "days_since": int(gap_now) if gap_now is not None else None,
    }

    def pct_rec(sql, params):
        rr = [x[0] for x in con.execute(sql, params).fetchall()]
        n = len(rr)
        return {"n": n, "w": sum(1 for x in rr if x == 1), "p": sum(1 for x in rr if x and x <= 3)}

    jockey = None
    if jockey_id:
        jn = con.execute("select person_full_name from persons where person_person_id=?", (jockey_id,)).fetchone()
        last50 = [x[0] for x in con.execute("""select race_result_rank from race_results where race_result_person_jockey_id=? and race_result_date<?
            order by race_result_date desc limit 50""", (jockey_id, when)).fetchall()]
        jockey = {"id": jockey_id, "name": jn[0] if jn else None, "last50": rec_str(last50),
                  "track": pct_rec("""select r.race_result_rank from race_results r where r.race_result_person_jockey_id=? and r.race_result_date<?
                        and r.race_result_racecourse_id=?""", (jockey_id, when, race["course_id"])),
                  "distance": pct_rec("""select r.race_result_rank from race_results r join races x on x.races_race_id=r.race_result_race_id
                        where r.race_result_person_jockey_id=? and r.race_result_date<? and abs(x.races_distance-?)<=50""", (jockey_id, when, race["distance"] or 0))}
    trainer = None
    if trainer_id:
        tn = con.execute("select person_full_name from persons where person_person_id=?", (trainer_id,)).fetchone()
        trainer = {"id": trainer_id, "name": tn[0] if tn else None,
                   "last100": pct_rec("""select race_result_rank from race_results where race_result_trainer_id=? and race_result_date<?
                        order by race_result_date desc limit 100""", (trainer_id, when)),
                   "track": pct_rec("""select race_result_rank from race_results where race_result_trainer_id=? and race_result_date<?
                        and race_result_racecourse_id=?""", (trainer_id, when, race["course_id"])),
                   "jockey": pct_rec("""select race_result_rank from race_results where race_result_trainer_id=? and race_result_date<?
                        and race_result_person_jockey_id=?""", (trainer_id, when, jockey_id or -1))}
    styles = {"Leader": h["sf"] or 0, "On pace": h["sp"] or 0, "Midfield": h["sm"] or 0, "Backmarker": h["sb"] or 0}
    settle = max(styles, key=styles.get) if any(styles.values()) else None
    recent_styles = [r["style"] for r in runs[:6] if r["style"]]
    gear_now = me.get("gear")
    gear_last = runs[0]["gear"] if runs else None
    out = {
        "horse": h, "race": {k: race[k] for k in ("race_id", "date", "distance", "track", "race_type", "weather", "course_id", "course", "direction", "surface")},
        "short": short, "jockey": jockey, "trainer": trainer, "settle": settle, "recent_styles": recent_styles,
        "gear": {"now": gear_now, "last": gear_last}, "prize_before": sum(r["prize_won"] or 0 for r in runs),
        "runs": runs[:30], "runs_total": len(runs), "gate": me.get("gate"),
        "age": int((when - h["birth"]) // (365.2425 * 86400)) if isinstance(h["birth"], (int, float)) else None,
    }
    for k in ("sf", "sp", "sm", "sb"):
        h.pop(k, None)
    return out

# --------------------------------------------------------------------------- CSV export

EXPORTS = {"horse_table": horse_table_query, "stable_table": stable_table_query, "stable_races": stable_races_query}


LIST_EXPORTS = {"horses": lambda con, q: api_horses(con, q), "races": lambda con, q: api_races(con, q),
                "stables": lambda con, q: api_stables(con, q), "people": lambda con, q: api_people(con, q),
                "careers": lambda con, q: api_careers(con, q),
                "courses": lambda con, q: api_courses(con, q), "meetings": lambda con, q: api_meetings(con, q)}


class ListCursor:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols

    def __iter__(self):
        for r in self.rows:
            yield [r.get(c) if not isinstance(r.get(c), (list, dict)) else json.dumps(r.get(c), default=str) for c in self.cols]


def export_rows(con, which, q):
    if which.startswith("raw:"):
        name = which[4:]
        if not has_table(con, name):
            raise ValueError("No such table.")
        cols, w, params, order = raw_where(con, name, q)
        return cols, con.execute("select * from %s%s%s" % (qident(name), w, order), params)
    if which.startswith("list:"):
        PAGE_LOCAL.size = 1000000
        try:
            d = LIST_EXPORTS[which[5:]](con, dict(q, page="1"))
        finally:
            PAGE_LOCAL.size = None
        rows_ = d.get("rows") or []
        for r in rows_:          # the rank in the sorted column is called "rank" in the spreadsheet (16.7.14)
            if "_rank" in r:
                r["rank"] = r.pop("_rank")
        cols = []
        for r in rows_[:200]:
            for k in r.keys():
                if k not in cols:
                    cols.append(k)
        return cols, ListCursor(rows_, cols)
    if which == "pedigrees":
        _, sql, _, params = pedigree_query(con, q)
    else:
        sql, _, params = EXPORTS[which](con, q)
    cur = con.execute(sql, params)
    # the Stable table's rank in the sorted column is called "rank" in the spreadsheet (16.7.11)
    return [("rank" if d[0] == "_rank" else d[0]) for d in cur.description], cur


# --------------------------------------------------------------------------- HTTP

ROUTES = [
    (re.compile(r"^/api/home$"), lambda con, m, q: api_home(con, q)),
    (re.compile(r"^/api/search$"), lambda con, m, q: api_search(con, q)),
    (re.compile(r"^/api/horses$"), lambda con, m, q: api_horses(con, q)),
    (re.compile(r"^/api/horse/(-?\d+)$"), lambda con, m, q: api_horse(con, int(m.group(1)))),
    (re.compile(r"^/api/races$"), lambda con, m, q: api_races(con, q)),
    (re.compile(r"^/api/race/(-?\d+)$"), lambda con, m, q: api_race(con, int(m.group(1)))),
    (re.compile(r"^/api/stables$"), lambda con, m, q: api_stables(con, q)),
    (re.compile(r"^/api/stable/(-?\d+)$"), lambda con, m, q: api_stable(con, int(m.group(1)))),
    (re.compile(r"^/api/stable_finance/(-?\d+)$"), lambda con, m, q: api_stable_finance(con, int(m.group(1)), q)),
    (re.compile(r"^/api/stable_horse_money/(-?\d+)$"), lambda con, m, q: api_stable_horse_money(con, int(m.group(1)), q)),
    (re.compile(r"^/api/stable_awards/(-?\d+)$"), lambda con, m, q: api_stable_awards(con, int(m.group(1)), q)),
    (re.compile(r"^/api/awards_of/(horse|person)/(-?\d+)$"), lambda con, m, q: api_awards_of(con, m.group(1), int(m.group(2)))),
    (re.compile(r"^/api/family/(-?\d+)$"), lambda con, m, q: api_family(con, int(m.group(1)))),
    (re.compile(r"^/api/dynasty/(-?\d+)$"), lambda con, m, q: api_dynasty(con, int(m.group(1)))),
    (re.compile(r"^/api/lifespans/(-?\d+)$"), lambda con, m, q: api_lifespans(con, int(m.group(1)))),
    (re.compile(r"^/api/horse_more/(-?\d+)$"), lambda con, m, q: api_horse_more(con, int(m.group(1)))),
    (re.compile(r"^/api/horse_trials/(-?\d+)$"), lambda con, m, q: api_horse_trials(con, int(m.group(1)))),
    (re.compile(r"^/api/course_trials/(-?\d+)$"), lambda con, m, q: api_course_trials(con, int(m.group(1)), q)),
    (re.compile(r"^/api/auctions$"), lambda con, m, q: api_auctions(con, q)),
    (re.compile(r"^/api/auction/(-?\d+)$"), lambda con, m, q: api_auction(con, int(m.group(1)))),
    (re.compile(r"^/api/auction_houses$"), lambda con, m, q: api_auction_houses(con, q)),
    (re.compile(r"^/api/auction_house/(-?\d+)$"), lambda con, m, q: api_auction_house(con, int(m.group(1)))),
    (re.compile(r"^/api/auction_house_finances/(-?\d+)$"), lambda con, m, q: api_auction_house_finances(con, int(m.group(1)))),
    (re.compile(r"^/api/stable_auctions/(-?\d+)$"), lambda con, m, q: api_stable_auctions(con, int(m.group(1)))),
    (re.compile(r"^/api/stable_shares/(-?\d+)$"), lambda con, m, q: api_stable_shares(con, int(m.group(1)))),
    (re.compile(r"^/api/assets$"), lambda con, m, q: api_assets(con, q)),
    (re.compile(r"^/api/stable_more/(-?\d+)$"), lambda con, m, q: api_stable_more(con, int(m.group(1)))),
    (re.compile(r"^/api/jockey_season/(-?\d+)$"), lambda con, m, q: api_jockey_season(con, int(m.group(1)), q)),
    (re.compile(r"^/api/alerts$"), lambda con, m, q: api_alerts(con)),
    (re.compile(r"^/api/concepts$"), lambda con, m, q: api_concepts(con, q)),
    (re.compile(r"^/api/concept/(-?\d+)$"), lambda con, m, q: api_concept(con, int(m.group(1)), q)),
    (re.compile(r"^/api/qualifying$"), lambda con, m, q: api_qualifying(con, q)),
    (re.compile(r"^/api/horse_fans/(-?\d+)$"), lambda con, m, q: api_horse_fans(con, int(m.group(1)))),
    (re.compile(r"^/api/notes$"), lambda con, m, q: notes_detail(con) if q.get("detail") else notes_load()),
    (re.compile(r"^/api/people_overview$"), lambda con, m, q: api_people_overview(con, q)),
    (re.compile(r"^/api/people$"), lambda con, m, q: api_people(con, q)),
    (re.compile(r"^/api/careers$"), lambda con, m, q: api_careers(con, q)),
    (re.compile(r"^/api/person/(-?\d+)$"), lambda con, m, q: api_person(con, int(m.group(1)))),
    (re.compile(r"^/api/courses$"), lambda con, m, q: api_courses(con, q)),
    (re.compile(r"^/api/course/(-?\d+)$"), lambda con, m, q: api_course(con, int(m.group(1)))),
    (re.compile(r"^/api/course_finances/(-?\d+)$"), lambda con, m, q: api_course_finances(con, int(m.group(1)))),
    (re.compile(r"^/api/stable_courses/(-?\d+)$"), lambda con, m, q: api_stable_courses(con, int(m.group(1)))),
    (re.compile(r"^/api/tables$"), lambda con, m, q: api_tables(con, q)),
    (re.compile(r"^/api/custom_table$"), lambda con, m, q: ct_run(con, json.loads(q.get("def") or "{}"), q)),
    (re.compile(r"^/api/horse_table$"), lambda con, m, q: api_horse_table(con, q)),
    (re.compile(r"^/api/stable_table$"), lambda con, m, q: api_stable_table(con, q)),
    (re.compile(r"^/api/stable_rankings$"), lambda con, m, q: api_stable_rankings(con, q)),
    (re.compile(r"^/api/pedigrees$"), lambda con, m, q: api_pedigrees(con, q)),
    (re.compile(r"^/api/pedigree/(-?\d+)$"), lambda con, m, q: api_pedigree(con, int(m.group(1)), q)),
    (re.compile(r"^/api/coi/(-?\d+)$"), lambda con, m, q: api_coi(con, int(m.group(1)), q)),
    (re.compile(r"^/api/meetings$"), lambda con, m, q: api_meetings(con, q)),
    (re.compile(r"^/api/runner$"), lambda con, m, q: api_runner(con, q)),
    (re.compile(r"^/api/meeting/(-?\d+)$"), lambda con, m, q: api_meeting(con, int(m.group(1)))),
    (re.compile(r"^/api/stable_races/(-?\d+)$"), lambda con, m, q: api_stable_races(con, int(m.group(1)), q)),
    (re.compile(r"^/api/table/([A-Za-z0-9_]+)$"), lambda con, m, q: api_table(con, m.group(1), q)),
    (re.compile(r"^/api/awards$"), lambda con, m, q: api_awards(con, q)),
    (re.compile(r"^/api/card/(horse|person|stable|race|course)/(-?\d+)$"), lambda con, m, q: api_card(con, m.group(1), int(m.group(2)))),
]

MIME = {".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
        ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf"}

# ------------------------------------------------------------------ horse photos (a gallery per horse, kept with each database)
IMG_MAX = 25 * 1024 * 1024
IMG_LOCK = threading.Lock()


# ------------------------------------------------------------------ fans, fan milestones and sponsors (15.7)
# The save keeps each horse's fans (horse_fame_calculated) and the best fan ranking it has reached (horse_fan_band_notified:
# 100, 50, 20, 10 or 1). Your inbox shows what each step brings: a fan website or fan page (top 100), a supporters' club
# (top 50), the fan club's away trips (top 20) and superfans (top 10).
FAN_LEVELS = [(100, "Fan website", "Fans have built a website or fan page about it (top 100 by fans)"),
              (50, "Supporters' club", "It has a supporters' club (top 50 by fans)"),
              (20, "Fan club trips", "Its fan club travels to away races (top 20 by fans)"),
              (10, "Superfans", "Superfans: tattoos and the like (top 10 by fans)"),
              (1, "No. 1 by fans", "The most popular horse in the world")]
FAN_INBOX = {215: "merch", 301: "website", 302: "club", 303: "trips", 304: "superfans", 305: "fans"}
FAN_CACHE = {}


def fan_label(band):
    """The highest fan step a horse has reached (band 100, 50, 20, 10 or 1)."""
    if not band or band <= 0:
        return None
    best = None
    for b, l, _ in FAN_LEVELS:
        if band <= b:
            best = l
    return best


def fan_rankings(con):
    """Fans of every living horse, most first (for a horse's world rank by fans). Kept for the loaded save."""
    k = (DB_GEN, "fans")
    if k not in FAN_CACHE:
        for x in [x for x in FAN_CACHE if x[0] != DB_GEN]:
            FAN_CACHE.pop(x, None)
        hc = set(columns(con, "horses"))
        FAN_CACHE[k] = sorted(r[0] for r in con.execute("select horse_fame_calculated from horses where horse_deceased_date is null and horse_fame_calculated > 0")) \
            if "horse_fame_calculated" in hc else []
    return FAN_CACHE[k]


def fan_inbox(con):
    """Your inbox's fan and merchandise messages, by horse: {horse: [{date, kind, subject, fans, rank, payout, cost}]}."""
    k = (DB_GEN, "inbox")
    if k not in FAN_CACHE:
        for x in [x for x in FAN_CACHE if x[0] != DB_GEN]:
            FAN_CACHE.pop(x, None)
        out = {}
        if has_table(con, "inbox"):
            ic = set(columns(con, "inbox"))
            rp = "inbox_player_replied" if "inbox_player_replied" in ic else "0"
            for t, d, subj, rel, replied in con.execute("select inbox_type, inbox_date, inbox_subject, inbox_related_ids, " + rp + " from inbox where inbox_type in (%s) order by inbox_date"
                                               % ",".join(str(x) for x in FAN_INBOX)):
                try:
                    j = json.loads(rel or "{}")
                except ValueError:
                    continue
                hid = to_int(j.get("horse_1"), None) if isinstance(j, dict) else None
                if not hid:
                    continue
                o = j.get("overrides") or {}
                h1 = o.get("horse_1") or {}
                out.setdefault(hid, []).append({"date": d, "kind": FAN_INBOX[t], "subject": subj, "fans": h1.get("fans"), "rank": to_int(h1.get("rank"), None),
                                                "payout": o.get("payout_raw"), "cost": h1.get("bus_cost_raw") if t == 303 else None,
                                                "replied": bool(replied)})
        FAN_CACHE[k] = out
    return FAN_CACHE[k]


def fan_rank(con, fans, died=None):
    """World rank by fans among living horses (None if dead or without fans)."""
    ranks = fan_rankings(con)
    if died or not fans or not ranks:
        return None
    return len(ranks) - bisect.bisect_right(ranks, fans) + 1


def horse_auto(con, ids):
    """What the save says about these horses' fans and sponsors, for the horse lists: {id: {fans, band, level, sponsor, pay, merch}}."""
    ids = [i for i in ids if i]
    out = {}
    if not ids:
        return out
    if len(ids) > 500:      # a whole-list export: SQLite takes only so many ? at once
        for i in range(0, len(ids), 500):
            out.update(horse_auto(con, ids[i:i + 500]))
        return out
    hc = set(columns(con, "horses"))
    gd = META.get("game_date") or time.time()
    mk = ",".join("?" * len(ids))
    if "horse_fame_calculated" in hc:
        for i, f, b, died in con.execute("select horse_horse_id, horse_fame_calculated, %s, horse_deceased_date from horses where horse_horse_id in (%s)"
                                         % ("horse_fan_band_notified" if "horse_fan_band_notified" in hc else "0", mk), ids):
            out[i] = {"fans": f, "band": b or 0, "level": fan_label(b or 0), "rank": fan_rank(con, f, died) if b else None, "died": bool(died)}
    if has_table(con, "horse_sponsors"):
        for i, brand, pay in con.execute("""select sponsor_horse_id, sponsor_brand_name, sponsor_monthly_payment from horse_sponsors where sponsor_horse_id in (%s)
                and sponsor_contract_start_date<=? and (sponsor_contract_end_date is null or sponsor_contract_end_date>?)""" % mk, ids + [gd, gd]):
            out.setdefault(i, {}).update(sponsor=brand, pay=pay)
    inbox = fan_inbox(con)
    for i in ids:
        if any(m["kind"] == "merch" for m in inbox.get(i, [])):
            out.setdefault(i, {})["merch"] = True
    return out


def auto_filter(con, tag, where, col="h.horse_horse_id"):
    """The automatic tags in the horse lists' tag filter."""
    gd = float(META.get("game_date") or time.time())
    if tag == "auto:sponsored" and has_table(con, "horse_sponsors"):
        where.append("%s in (select sponsor_horse_id from horse_sponsors where sponsor_contract_start_date<=%r and (sponsor_contract_end_date is null or sponsor_contract_end_date>%r))" % (col, gd, gd))
    elif tag in ("auto:website", "auto:club", "auto:trips", "auto:superfans") and "horse_fan_band_notified" in columns(con, "horses"):
        top = {"auto:website": 100, "auto:club": 50, "auto:trips": 20, "auto:superfans": 10}[tag]
        where.append("coalesce(h.horse_fan_band_notified,0) between 1 and %d" % top)
    elif tag == "auto:merch":
        ids = [i for i, ms in fan_inbox(con).items() if any(m["kind"] == "merch" for m in ms)]
        where.append("%s in (%s)" % (col, ",".join(map(str, ids))) if ids else "0=1")
    else:
        where.append("0=1")


def api_horse_fans(con, hid):
    """A horse's Fans, sponsors & notes tab."""
    hc = set(columns(con, "horses"))
    h = one(con, "select horse_horse_id as id, horse_name as name, horse_deceased_date as died, %s as fans, %s as band from horses where horse_horse_id=?"
            % ("horse_fame_calculated" if "horse_fame_calculated" in hc else "null", "horse_fan_band_notified" if "horse_fan_band_notified" in hc else "0"), (hid,))
    if not h:
        return None
    h["rank"] = fan_rank(con, h["fans"], h["died"])
    h["of"] = len(fan_rankings(con))
    h["level"] = fan_label(h["band"] or 0)
    h["levels"] = [{"top": b, "label": l, "about": a, "reached": bool(h["band"]) and h["band"] <= b} for b, l, a in FAN_LEVELS]
    gd = META.get("game_date") or time.time()
    h["sponsors"] = rows(con, """select sponsor_brand_name as brand, sponsor_industry as industry, sponsor_monthly_payment as monthly, sponsor_contract_start_date as start,
            sponsor_contract_end_date as end, sponsor_win_bonus_multiplier as bonus, sponsor_total_payments_made as paid, sponsor_wins_during_contract as wins,
            sponsor_offer_date as offered from horse_sponsors where sponsor_horse_id=? order by sponsor_contract_start_date desc""", (hid,)) if has_table(con, "horse_sponsors") else []
    for r in h["sponsors"]:
        r["current"] = bool(r["start"] and r["start"] <= gd and (not r["end"] or r["end"] > gd))
    h["inbox"] = fan_inbox(con).get(hid, [])
    return h


# ------------------------------------------------------------------ your own notes and tags (15.7)
# Kept with each database (its folder), so they stay when you load a newer save into it. Keys are "horse:<id>".
NOTES_LOCK = threading.Lock()
TAG_COLORS = ("blue", "rose", "amber", "green", "purple", "teal", "red", "orange", "navy", "grey")
TAG_PRESETS = [{"id": "website", "name": "Website", "color": "blue", "icon": "globe"},
               {"id": "fanclub", "name": "Fan club", "color": "rose", "icon": "users"},
               {"id": "merch", "name": "Merchandise", "color": "amber", "icon": "bag"}]
NOTE_MAX, TAG_MAX, TAGS_MAX, LOG_MAX = 20000, 40, 60, 2000
NOTES_REV = [0]


def notes_path():
    return os.path.join(slot_dir(ACTIVE["id"]), "notes.json") if ACTIVE["id"] else None


def notes_load():
    p = notes_path()
    d = read_json(p, None) if p else None
    if not isinstance(d, dict):
        d = {}
    if not isinstance(d.get("tags"), list):
        d["tags"] = [dict(t) for t in TAG_PRESETS]
    if not isinstance(d.get("items"), dict):
        d["items"] = {}
    # each horse keeps a log of notes; the single note box of the first 15.7 becomes its first entry
    for it in d["items"].values():
        if not isinstance(it, dict):
            continue
        if not isinstance(it.get("log"), list):
            old = str(it.get("note") or "").strip()
            it["log"] = [{"id": "n1", "text": old, "at": it.get("updated") or time.time(), "gd": None}] if old else []
        it.pop("note", None)
    d["v"] = 2
    return d


def notes_has(it):
    return bool(it.get("log")) or bool(it.get("tags"))


def notes_ids(kind, tag):
    """The ids of one kind (horse) with this tag, or with notes ("_notes"), or with any tag ("_any")."""
    out = []
    for k, it in notes_load()["items"].items():
        kk, _, i = k.partition(":")
        if kk != kind or not isinstance(it, dict):
            continue
        ok = bool(it.get("log")) if tag == "_notes" else bool(it.get("tags")) if tag == "_any" else tag in (it.get("tags") or [])
        if ok and re.match(r"^-?\d+$", i):
            out.append(int(i))
    return out


def notes_filter(where, q, col="h.horse_horse_id", con=None):
    tag = str(q.get("tag") or "")
    if tag.startswith("auto:"):
        auto_filter(con, tag, where, col)
    elif tag:
        ids = notes_ids("horse", tag)
        where.append("%s in (%s)" % (col, ",".join(map(str, ids))) if ids else "0=1")


def notes_detail(con):
    """Your notes and tags with each horse's name, stable and whether it's still alive, for the Notes & tags page."""
    d = notes_load()
    ids = [int(k.split(":", 1)[1]) for k in d["items"] if k.startswith("horse:") and re.match(r"^-?\d+$", k.split(":", 1)[1])]
    info = {}
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        for r in rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_deceased_date as died, h.horse_gender as gender, h.horse_birth_date as birth,
                h.horse_stable_id as stable_id, s.stable_name as stable from horses h left join stables s on s.stable_stable_id=h.horse_stable_id
                where h.horse_horse_id in (%s)""" % ",".join("?" * len(chunk)), chunk):
            info[r["id"]] = r
    d["horses"] = info
    return d


def notes_slug(name, taken):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "tag"
    sid, n = base, 2
    while sid in taken:
        sid, n = "%s-%d" % (base, n), n + 1
    return sid


def notes_post(path, data):
    """Change one horse's note and tags, or the list of tags."""
    if not notes_path():
        return {"error": "Load a database first."}, 409
    with NOTES_LOCK:
        d = notes_load()
        if path == "/api/notes/item":
            kind = str(data.get("kind") or "horse")
            if kind != "horse" or not re.match(r"^-?\d+$", str(data.get("id") or "")):
                return {"error": "Which horse?"}, 400
            key = "%s:%d" % (kind, int(data["id"]))
            it = dict(d["items"].get(key) or {})
            log = [dict(x) for x in (it.get("log") or [])]
            if "add" in data:            # a new note in the log
                text = str(data.get("add") or "").strip()[:NOTE_MAX]
                if not text:
                    return {"error": "Write something first."}, 400
                if len(log) >= LOG_MAX:
                    return {"error": "That horse already has %d notes." % LOG_MAX}, 400
                n = 1 + max([to_int(str(x.get("id", ""))[1:], 0) for x in log] + [0])
                log.append({"id": "n%d" % n, "text": text, "at": time.time(), "gd": META.get("game_date")})
            if isinstance(data.get("edit"), dict):
                e = data["edit"]
                text = str(e.get("text") or "").strip()[:NOTE_MAX]
                for x in log:
                    if x.get("id") == e.get("id"):
                        if text and text != x.get("text"):
                            x["text"], x["edited"] = text, time.time()
                        elif not text:
                            data["delete"] = x["id"]
                        break
                else:
                    return {"error": "That note isn't there any more."}, 404
            if data.get("delete"):
                log = [x for x in log if x.get("id") != data["delete"]]
            it["log"] = log
            it.pop("note", None)
            if "tags" in data:
                known = {t["id"] for t in d["tags"]}
                it["tags"] = [t for t in dict.fromkeys(str(x) for x in (data.get("tags") or [])) if t in known]
            it["updated"] = time.time()
            if notes_has(it):
                d["items"][key] = it
            else:
                d["items"].pop(key, None)
            write_json(notes_path(), d)
            return {"ok": True, "item": d["items"].get(key), "key": key}, 200
        if path == "/api/notes/tags":
            old = {t["id"]: t for t in d["tags"]}
            new, taken = [], set()
            for t in (data.get("tags") or [])[:TAGS_MAX]:
                name = str((t or {}).get("name") or "").strip()[:TAG_MAX]
                if not name:
                    continue
                tid = str(t.get("id") or "")
                if tid not in old or tid in taken:
                    tid = notes_slug(name, taken | set(old))
                taken.add(tid)
                color = t.get("color") if t.get("color") in TAG_COLORS else (old.get(tid) or {}).get("color") or TAG_COLORS[len(new) % len(TAG_COLORS)]
                row = {"id": tid, "name": name, "color": color}
                icon = (old.get(tid) or {}).get("icon")
                if icon:
                    row["icon"] = icon
                new.append(row)
            keep = {t["id"] for t in new}
            for k in list(d["items"]):
                it = d["items"][k]
                it["tags"] = [x for x in (it.get("tags") or []) if x in keep]
                if not notes_has(it):
                    d["items"].pop(k)
            d["tags"] = new
            write_json(notes_path(), d)
            return {"ok": True, "tags": new}, 200
    return {"error": "Not found."}, 404


def img_root():
    return os.path.join(slot_dir(ACTIVE["id"]), "images", "horses") if ACTIVE["id"] else None


def img_kind(head):
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def horse_gallery(hid):
    d = os.path.join(img_root(), str(hid))
    meta = read_json(os.path.join(d, "gallery.json"), {}) if os.path.isdir(d) else {}
    files = [f for f in (os.listdir(d) if os.path.isdir(d) else []) if re.match(r"^\d+\.(jpg|png|gif|webp)$", f)]
    files.sort(key=lambda f: int(f.split(".")[0]))
    main = meta.get("main") if meta.get("main") in files else (files[0] if files else None)
    banner = meta.get("banner") if meta.get("banner") in files else None     # none chosen: hover cards have no picture
    return {"horse_id": hid, "main": main, "banner": banner, "banner_view": meta.get("banner_view") or {},
            "images": [{"file": f, "url": "/img/horses/%d/%s" % (hid, f), "added": int(f.split(".")[0]) / 1000,
                        "size": os.path.getsize(os.path.join(d, f)), "main": f == main, "banner": f == banner} for f in files]}


def gallery_index():
    """Every horse's profile photo and banner: {horse id: {"main": url, "banner": url}} (11.5–11.7 kept just the profile url)."""
    idx = read_json(os.path.join(img_root(), "index.json"), {}) if img_root() else {}
    return {k: ({"main": v, "banner": None} if isinstance(v, str) else v) for k, v in idx.items()}


BANNER_VIEW_DEFAULT = {"fit": "cover", "x": 50, "y": 50, "zoom": 1, "height": "medium", "crisp": False, "bg": "#1b2130"}


def clean_banner_view(v):
    """How the banner picture is shown on the hover card: fill or whole picture, which part (x/y %), zoom, height, sharp pixels, background."""
    v = v if isinstance(v, dict) else {}
    num = lambda k, lo, hi: max(lo, min(hi, float(v.get(k, BANNER_VIEW_DEFAULT[k])))) if isinstance(v.get(k, 0), (int, float)) else BANNER_VIEW_DEFAULT[k]
    bg = v.get("bg") if isinstance(v.get("bg"), str) and re.match(r"^#[0-9a-fA-F]{6}$", v.get("bg")) else BANNER_VIEW_DEFAULT["bg"]
    return {"fit": "contain" if v.get("fit") == "contain" else "cover", "x": round(num("x", 0, 100), 1), "y": round(num("y", 0, 100), 1),
            "zoom": round(num("zoom", 1, 4), 2), "height": v.get("height") if v.get("height") in ("short", "medium", "tall") else "medium",
            "crisp": bool(v.get("crisp")), "bg": bg}


def gallery_save(hid, main, banner=None, view=None):
    """Remember the horse's profile photo and banner (and how the banner is shown), and keep the list of every horse's."""
    d = os.path.join(img_root(), str(hid))
    if view is None:
        view = read_json(os.path.join(d, "gallery.json"), {}).get("banner_view") if os.path.isdir(d) else None
    if os.path.isdir(d):
        write_json(os.path.join(d, "gallery.json"), {"main": main, "banner": banner, "banner_view": view or {}})
    idx = gallery_index()
    url = lambda f: "/img/horses/%d/%s" % (hid, f) if f else None
    if main or banner:
        idx[str(hid)] = {"main": url(main), "banner": url(banner), "banner_view": view or {}}
    else:
        idx.pop(str(hid), None)
    os.makedirs(img_root(), exist_ok=True)
    write_json(os.path.join(img_root(), "index.json"), idx)


def gallery_add(hid, body):
    kind = img_kind(body[:16])
    if not kind:
        raise ValueError("That file isn't a picture the viewer can show (JPG, PNG, GIF or WebP).")
    with IMG_LOCK:
        d = os.path.join(img_root(), str(hid))
        os.makedirs(d, exist_ok=True)
        stamp = int(time.time() * 1000)
        while os.path.exists(os.path.join(d, "%d%s" % (stamp, kind))):
            stamp += 1
        with open(os.path.join(d, "%d%s" % (stamp, kind)), "wb") as f:
            f.write(body)
        g = horse_gallery(hid)
        gallery_save(hid, g["main"], g["banner"])
    return horse_gallery(hid)


def gallery_main(hid, name):
    with IMG_LOCK:
        g = horse_gallery(hid)
        if name not in [i["file"] for i in g["images"]]:
            raise ValueError("That picture isn't in this horse's gallery.")
        gallery_save(hid, name, g["banner"])
    return horse_gallery(hid)


def gallery_banner_view(hid, view):
    with IMG_LOCK:
        g = horse_gallery(hid)
        if not g["banner"]:
            raise ValueError("Choose a banner first.")
        gallery_save(hid, g["main"], g["banner"], clean_banner_view(view))
    return horse_gallery(hid)


def gallery_banner(hid, name):
    """The wide picture at the top of the horse's hover card; an empty name goes back to using the profile photo."""
    with IMG_LOCK:
        g = horse_gallery(hid)
        if name and name not in [i["file"] for i in g["images"]]:
            raise ValueError("That picture isn't in this horse's gallery.")
        gallery_save(hid, g["main"], name or None, {} if name != g["banner"] else None)   # a new banner starts with the standard view
    return horse_gallery(hid)


def gallery_delete(hid, name):
    with IMG_LOCK:
        g = horse_gallery(hid)
        if name not in [i["file"] for i in g["images"]]:
            raise ValueError("That picture isn't in this horse's gallery.")
        os.remove(os.path.join(img_root(), str(hid), name))
        rest = [i["file"] for i in g["images"] if i["file"] != name]
        gallery_save(hid, g["main"] if g["main"] != name else (rest[-1] if rest else None), g["banner"] if g["banner"] != name else None)
    return horse_gallery(hid)


# ------------------------------------------------------------------ Mac and Linux desktop app helpers
PLATFORM = "windows" if os.name == "nt" else ("mac" if sys.platform == "darwin" else "linux")
# shown in the app's own window on Mac or Linux (WebKit): downloads and outside links are handed to the viewer,
# which saves to Downloads and opens links in the browser (a bare web view does neither by itself)
WINDOWED = os.environ.get("HRMV_WINDOW") == "webkit"


def downloads_dir():
    home = os.path.expanduser("~")
    d = None
    if PLATFORM == "linux" and shutil.which("xdg-user-dir"):
        import subprocess
        try:
            out = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True, text=True, timeout=5).stdout.strip()
            if out and os.path.abspath(out) != os.path.abspath(home):
                d = out
        except Exception:
            pass
    d = d or os.path.join(home, "Downloads")
    os.makedirs(d, exist_ok=True)
    return d


def save_download(name, data):
    """Save a file the page asked to download into the Downloads folder; never overwrites (adds (1), (2)...)."""
    name = os.path.basename((name or "").replace("\\", "/")).strip().lstrip(".") or "download"
    name = re.sub(r'[\x00-\x1f<>:"|?*/]', "_", name)[:180]
    d = downloads_dir()
    stem, ext = os.path.splitext(name)
    path, n = os.path.join(d, name), 1
    while os.path.exists(path):
        path, n = os.path.join(d, "%s (%d)%s" % (stem, n, ext)), n + 1
    with open(path, "wb") as f:
        f.write(data)
    return path


def open_outside(target):
    """Open a web address in the browser, or a folder in Finder / the file manager."""
    import subprocess
    if PLATFORM == "windows":
        os.startfile(target)
    else:
        subprocess.Popen(["open" if PLATFORM == "mac" else "xdg-open", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def linux_menu_entry():
    """Add HRM Viewer to the applications menu (~/.local/share/applications), opening the "HRM Viewer" launcher."""
    launcher = os.environ.get("HRMV_LAUNCHER") or os.path.join(APP_DIR, "HRM Viewer")
    if not os.path.exists(launcher):
        raise OSError("Couldn't find the HRM Viewer launcher next to app.py.")
    esc = lambda v: '"%s"' % re.sub(r'(["`$\\])', r"\\\1", v)
    icon = os.path.join(APP_DIR, "hrm-viewer.png")
    lines = ["[Desktop Entry]", "Type=Application", "Name=HRM Viewer", "Comment=Browse your Horse Racing Manager save",
             "Exec=%s %%f" % esc(launcher), "Icon=%s" % (icon if os.path.exists(icon) else "applications-games"),
             "Terminal=false", "Categories=Game;Utility;", "StartupWMClass=hrm-viewer-window"]
    d = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share"), "applications")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "hrm-viewer.desktop")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(path, 0o755)
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "HRMViewer/1.0"

    def log_message(self, fmt, *args):
        pass

    def send_body(self, body, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_body(json.dumps(obj, default=str).encode("utf-8"), code)

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        if path == "/api/status":
            return self.handle_api(lambda con: api_status(con, q), allow_empty=True)
        if path == "/api/import/progress":
            return self.send_json(job_snapshot())
        if path == "/api/notes/export":       # a backup of your notes and tags (16.5)
            if not notes_path():
                return self.send_json({"error": "Load a database first."}, 409)
            body = json.dumps(dict(notes_load(), backup="HRM Viewer notes", made=time.time()), ensure_ascii=False, indent=1).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="hrm-viewer-notes-%s.json"' % time.strftime("%Y-%m-%d"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/dbs":
            return self.send_json(api_dbs())
        if path == "/api/auto":
            return self.send_json(auto_status())
        if path == "/api/game_display":
            try:
                con = connect_ro() if os.path.exists(CURRENT_DB) else None
                try:
                    return self.send_json(api_game_display(con))
                finally:
                    if con is not None:
                        con.close()
            except Exception as e:
                return self.send_json({"found": False, "error": str(e), "loc": {}, "currencies": []})
        if path == "/api/custom_tables":      # Settings → Custom tables (16.8)
            return self.send_json({"tables": ct_load(), "sources": ct_catalogue()})
        if path == "/api/github":
            return self.send_json(github_check(force=q.get("force") == "1"))
        if path == "/api/github/releases":
            try:
                return self.send_json({"current": VERSION, "repo": github_repo(), "releases": github_releases(force=q.get("force") == "1")})
            except Exception as e:
                return self.send_json({"error": "Couldn't reach GitHub (%s)." % (getattr(e, "reason", None) or getattr(e, "code", None) or e)}, 502)
        if path == "/api/horse_pics":
            return self.send_json(gallery_index())
        m = re.match(r"^/api/horse_images/(-?\d+)$", path)
        if m:
            return self.send_json(horse_gallery(int(m.group(1))))
        m = re.match(r"^/img/horses/(-?\d+)/(\d+\.(?:jpg|png|gif|webp))$", path)
        if m:
            full = os.path.join(img_root() or "", m.group(1), m.group(2))
            if not os.path.isfile(full):
                return self.send_json({"error": "Not found"}, 404)
            body = open(full, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", MIME[os.path.splitext(full)[1]])
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=31536000, immutable")   # each picture has its own name, never reused
            self.end_headers()
            self.wfile.write(body)
            return
        m = re.match(r"^/api/export/(horse_table|stable_table|pedigrees|stable_races)$", path)
        if m:
            return self.send_csv(m.group(1), q)
        m = re.match(r"^/api/export/raw/([A-Za-z0-9_]+)$", path)
        if m:
            return self.send_csv("raw:" + m.group(1), q)
        m = re.match(r"^/api/export/list/(horses|races|stables|people|courses|meetings)$", path)
        if m:
            return self.send_csv("list:" + m.group(1), q)
        for rx, fn in ROUTES:
            m = rx.match(path)
            if m:
                key = path + "?" + "&".join("%s=%s" % kv for kv in sorted(q.items()) if kv[1] != "")
                if path == "/api/notes" or q.get("tag"):
                    key += "#notes%d" % NOTES_REV[0]      # your notes change without the save changing
                size = to_int(q.get("size"))
                PAGE_LOCAL.size = max(10, min(MAX_PAGE_ROWS, size)) if size else None
                try:
                    return self.handle_api(lambda con: fn(con, m, q), cache_key=key)
                finally:
                    PAGE_LOCAL.size = None
        if path.startswith("/api/"):
            return self.send_json({"error": "Unknown address"}, 404)
        self.serve_static(path)

    def handle_api(self, fn, allow_empty=False, cache_key=None):
        refresh_meta_if_changed()
        if cache_key:
            body = cache_get(cache_key)
            if body is not None:
                return self.send_body(body)
        DB_LOCK.acquire_read()
        con = None
        try:
            if os.path.exists(CURRENT_DB):
                con = POOL.get()
            elif not allow_empty:
                return self.send_json({"error": "No database loaded yet."}, 409)
            gen = DB_GEN
            result = fn(con)
            if result is None:
                return self.send_json({"error": "Not found"}, 404)
            body = json.dumps(result, default=str).encode("utf-8")
            self.send_body(body)
            if cache_key and gen == DB_GEN:
                cache_put(cache_key, body)
        except Exception as e:
            traceback.print_exc()
            if con:
                try:
                    con.close()
                except Exception:
                    pass
                con = None
            self.send_json({"error": str(e)}, 500)
        finally:
            if con:
                POOL.put(con)
            DB_LOCK.release_read()

    def handle_dbs(self, action):
        length = to_int(self.headers.get("Content-Length"), 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except ValueError:
            data = {}
        sid = data.get("id")
        try:
            if action == "switch":
                if not valid_slot(sid):
                    return self.send_json({"error": "That database doesn't exist."}, 404)
                start_job(run_switch, sid)
                return self.send_json({"ok": True})
            if action == "rename":
                name = (data.get("name") or "").strip()[:80]
                if not name or not valid_slot(sid) or sid == LEGACY_ID:
                    return self.send_json({"error": "Enter a name."}, 400)
                f = os.path.join(DBS_DIR, sid, "slot.json")
                slot = read_json(f, {})
                slot["name"] = name
                write_json(f, slot)
                return self.send_json({"ok": True})
            if action == "delete":
                if not valid_slot(sid):
                    return self.send_json({"error": "That database doesn't exist."}, 404)
                if sid == ACTIVE["id"]:
                    return self.send_json({"error": "Open a different database before deleting this one."}, 409)
                if sid == LEGACY_ID:
                    for f in ("current.db", "meta.json", "incoming.db", "work.db", "notes.json"):
                        try:
                            os.remove(os.path.join(DATA_DIR, f))
                        except OSError:
                            pass
                else:
                    shutil.rmtree(os.path.join(DBS_DIR, sid))
                return self.send_json({"ok": True})
            if action == "migrate":
                new = migrate_legacy(data.get("name"))
                return self.send_json({"ok": True, "id": new})
            if action == "import":
                move = bool(data.get("move"))
                src_db, src_meta = find_viewer_data(data.get("path"))
                if not src_db:
                    return self.send_json({"error": "No stored data found there. Give the folder of the other HRM Viewer (the one with HRM Viewer.exe in it), its data folder, or a database file."}, 400)
                here = os.path.abspath(DATA_DIR)
                if os.path.abspath(src_db).startswith(here + os.sep):
                    return self.send_json({"error": "That's this viewer's own data. Use the Databases list instead."}, 400)
                name = (data.get("name") or "").strip()
                if not is_viewer_db(src_db):
                    # a game save: load it into a new database through the normal load
                    prev = ACTIVE["id"]
                    sid2 = new_slot(name or os.path.basename(os.path.dirname(src_db)) or "New database")
                    activate(sid2, rebuild=False)
                    start_import("path", src_db, "replace", new_db={"id": sid2, "prev": prev})
                    return self.send_json({"ok": True, "kind": "save"})
                if not name:
                    meta = read_json(src_meta, {}) if src_meta else {}
                    name = meta.get("player_name") or os.path.basename(os.path.dirname(os.path.dirname(src_db))) or "Imported database"
                start_job(run_copy_in, src_db, src_meta, name, move)
                return self.send_json({"ok": True, "kind": "viewer"})
        except Exception as e:
            traceback.print_exc()
            return self.send_json({"error": str(e)}, 500)
        return self.send_json({"error": "Unknown address"}, 404)

    def handle_update(self, check_only):
        length = to_int(self.headers.get("Content-Length"), 0)
        if length <= 0 or length > 50 * 1024 * 1024:
            return self.send_json({"error": "Choose the update .zip file."}, 400)
        self.install_update_bytes(self.rfile.read(length), check_only)

    def install_update_bytes(self, data, check_only=False):
        """Check (or check and install) an update zip, whether it was chosen by hand or downloaded from GitHub."""
        try:
            manifest, files, skipped = read_update_zip(data)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            return self.send_json({"error": "Couldn't read the update: %s" % e}, 400)
        new_v = str(manifest["version"])
        info = {"version": new_v, "current": VERSION, "notes": manifest.get("notes") or "", "files": len(files),
                "older": version_tuple(new_v) < version_tuple(VERSION), "same": version_tuple(new_v) == version_tuple(VERSION),
                "skipped": skipped}
        if check_only:
            return self.send_json(info)
        with UPDATE_LOCK:
            try:
                backup = backup_current("before installing %s" % new_v)
                write_json(UPDATE_PENDING, {"backup": backup, "from": VERSION, "to": new_v,
                                            "message": "Updated from version %s to %s." % (VERSION, new_v)})
                install_files(files)
            except Exception as e:
                traceback.print_exc()
                return self.send_json({"error": "The update couldn't be installed: %s" % e}, 500)
        supervised = os.environ.get("HRMV_SUPERVISED") == "1"
        self.send_json(dict(info, ok=True, restarting=supervised))
        if supervised:
            restart_soon()

    def handle_rollback(self):
        length = to_int(self.headers.get("Content-Length"), 0)
        try:
            want = (json.loads(self.rfile.read(length) or b"{}") if length else {}).get("name")
        except ValueError:
            want = None
        backups = [b for b in list_backups() if b["version"] != VERSION]
        if want:
            backups = [b for b in list_backups() if b["name"] == want]
        if not backups:
            return self.send_json({"error": "There's no earlier version to go back to."}, 409)
        target = backups[0]
        with UPDATE_LOCK:
            try:
                mine = backup_current("before going back to %s" % target["version"])
                write_json(UPDATE_PENDING, {"backup": mine, "from": VERSION, "to": target["version"],
                                            "message": "Went back from version %s to %s." % (VERSION, target["version"])})
                restore_backup(target["path"])
                shutil.rmtree(target["path"], ignore_errors=True)
            except Exception as e:
                traceback.print_exc()
                return self.send_json({"error": "Couldn't go back: %s" % e}, 500)
        supervised = os.environ.get("HRMV_SUPERVISED") == "1"
        self.send_json({"ok": True, "version": target["version"], "restarting": supervised})
        if supervised:
            restart_soon()

    def send_csv(self, which, q):
        import csv
        import io
        refresh_meta_if_changed()
        DB_LOCK.acquire_read()
        con = None
        try:
            if not os.path.exists(CURRENT_DB):
                return self.send_json({"error": "No database loaded yet."}, 409)
            con = connect_ro()
            cols, cur = export_rows(con, which, q)
            date_cols = {i for i, c in enumerate(cols) if c in ("birth", "died", "last_run", "founded", "liquidated", "date", "race_time")} if not which.startswith("raw:") else set()
            fname = "%s.csv" % which.replace("raw:", "").replace("list:", "").replace("_", "-")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
            self.end_headers()
            buf = io.StringIO()
            w = csv.writer(buf)
            self.wfile.write(b"\xef\xbb\xbf")  # BOM so Excel reads the names correctly
            w.writerow(cols)
            for row in cur:
                row = list(row)
                for i in date_cols:
                    if isinstance(row[i], (int, float)):
                        # datetime arithmetic works for dates before 1970 on Windows too
                        row[i] = (datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=row[i])).strftime("%Y-%m-%d")
                w.writerow(["<binary>" if isinstance(v, (bytes, bytearray)) else v for v in row])
                if buf.tell() > 1 << 16:
                    self.wfile.write(buf.getvalue().encode("utf-8")); buf.seek(0); buf.truncate()
            self.wfile.write(buf.getvalue().encode("utf-8"))
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass
        finally:
            if con:
                con.close()
            DB_LOCK.release_read()

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        # the browser keeps its copy and only asks whether it changed, so pages open without re-reading the files
        st = os.stat(full)
        etag = '"%x-%x"' % (int(st.st_mtime_ns), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        # only the viewer's own pages (and the desktop apps, which send no Origin) may change things:
        # a web page elsewhere can't reach into the viewer through your browser
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            return self.send_json({"error": "Not allowed."}, 403)
        if path == "/api/desktop/save":
            if not WINDOWED:
                return self.send_json({"error": "Only for the HRM Viewer window on Mac and Linux."}, 400)
            length = to_int(self.headers.get("Content-Length"), 0)
            if length <= 0 or length > 1024 * 1024 * 1024:
                return self.send_json({"error": "Nothing to save."}, 400)
            data = self.rfile.read(length)
            name = parse_qs(urlparse(self.path).query).get("name", ["download"])[-1]
            try:
                return self.send_json({"ok": True, "path": save_download(name, data)})
            except OSError as e:
                return self.send_json({"error": "Couldn't save it: %s" % e}, 500)
        if path in ("/api/desktop/open", "/api/desktop/reveal"):
            length = to_int(self.headers.get("Content-Length"), 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                data = {}
            if path == "/api/desktop/open":
                url = str(data.get("url") or "")
                if not re.match(r"^https?://", url):
                    return self.send_json({"error": "Only web addresses can be opened."}, 400)
                open_outside(url)
                return self.send_json({"ok": True})
            p = os.path.abspath(str(data.get("path") or ""))
            if not p.startswith(os.path.abspath(downloads_dir()) + os.sep) or not os.path.exists(p):
                return self.send_json({"error": "Only files saved to Downloads can be shown."}, 400)
            if PLATFORM == "mac":
                import subprocess
                subprocess.Popen(["open", "-R", p])
            else:
                open_outside(os.path.dirname(p))
            return self.send_json({"ok": True})
        if path == "/api/notes/import":
            length = to_int(self.headers.get("Content-Length"), 0)
            if length > 64 * 1024 * 1024:
                return self.send_json({"error": "That file is too big to be a notes backup."}, 413)
            if not notes_path():
                return self.send_json({"error": "Load a database first."}, 409)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                return self.send_json({"error": "That isn't an HRM Viewer notes backup."}, 400)
            out, code = notes_import(data if isinstance(data, dict) else {}) if isinstance(data, dict) else ({"error": "That isn't an HRM Viewer notes backup."}, 400)
            return self.send_json(out, code)
        if path == "/api/custom_tables":
            length = to_int(self.headers.get("Content-Length"), 0)
            if length > 1024 * 1024:
                return self.send_json({"error": "That's too much."}, 413)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                data = {}
            return self.send_json({"tables": ct_save((data or {}).get("tables"))})
        if path in ("/api/notes/item", "/api/notes/tags"):
            length = to_int(self.headers.get("Content-Length"), 0)
            if length > 512 * 1024:
                return self.send_json({"error": "That's too long."}, 413)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                data = {}
            out, code = notes_post(path, data if isinstance(data, dict) else {})
            NOTES_REV[0] += 1
            return self.send_json(out, code)
        m = re.match(r"^/api/horse_images/(-?\d+)(?:/(main|banner|bannerview|delete))?$", path)
        if m:
            hid, act = int(m.group(1)), m.group(2)
            length = to_int(self.headers.get("Content-Length"), 0)
            if not img_root():
                return self.send_json({"error": "Load a database first."}, 409)
            try:
                if not act:
                    if length <= 0:
                        return self.send_json({"error": "Empty upload."}, 400)
                    if length > IMG_MAX:
                        return self.send_json({"error": "That picture is too big (the limit is 25 MB)."}, 400)
                    return self.send_json(gallery_add(hid, self.rfile.read(length)))
                data = json.loads(self.rfile.read(length) or b"{}")
                if act == "bannerview":
                    return self.send_json(gallery_banner_view(hid, data.get("view")))
                fn = {"main": gallery_main, "banner": gallery_banner, "delete": gallery_delete}[act]
                return self.send_json(fn(hid, data.get("file")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        if job_busy() and path not in ("/api/auto", "/api/quit", "/api/desktop/shortcut"):
            return self.send_json({"error": "A database is already being loaded."}, 409)
        if path == "/api/import/path":
            length = to_int(self.headers.get("Content-Length"), 0)
            data = json.loads(self.rfile.read(length) or b"{}")
            src = os.path.expandvars(os.path.expanduser((data.get("path") or "").strip().strip('"')))
            if not src:
                return self.send_json({"error": "Enter the full path to database.db."}, 400)
            if os.path.isdir(src):
                src = os.path.join(src, "database.db")
            if not os.path.isfile(src):
                return self.send_json({"error": "No file found at: %s" % src}, 400)
            new_db = None
            if data.get("new_db"):
                prev = ACTIVE["id"]
                sid = new_slot(data.get("new_db"))
                activate(sid, rebuild=False)
                new_db = {"id": sid, "prev": prev}
            start_import("path", src, "replace" if data.get("fresh") else None, new_db=new_db)
            return self.send_json({"ok": True})
        if path == "/api/import/confirm":
            length = to_int(self.headers.get("Content-Length"), 0)
            data = json.loads(self.rfile.read(length) or b"{}")
            if data.get("decision") not in ("replace", "add", "merge", "cancel", "newdb"):
                return self.send_json({"error": "Unknown choice."}, 400)
            if not answer_confirm(data["decision"]):
                return self.send_json({"error": "There's nothing waiting for a choice."}, 409)
            return self.send_json({"ok": True})
        if path.startswith("/api/dbs/"):
            return self.handle_dbs(path[len("/api/dbs/"):])
        if path == "/api/compact":
            length = to_int(self.headers.get("Content-Length"), 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                data = {}
            cfg = read_json(CONFIG_FILE, {})
            cur = dict(cfg.get("compact") or {})
            for k in ("on", "thin", "disk"):
                if k in data:
                    cur[k] = bool(data[k])
            cfg["compact"] = cur
            write_json(CONFIG_FILE, cfg)
            if "disk" in data and os.name == "nt" and os.path.exists(CURRENT_DB) and not job_busy():
                # straight away for the stored data there is (Windows can do it while the viewer has the file open)
                if data["disk"]:
                    disk_compress_later(CURRENT_DB)
                else:
                    threading.Thread(target=lambda: (disk_wait(), disk_compress(CURRENT_DB, False)), daemon=True).start()
            return self.send_json(compact_settings())
        if path == "/api/compact/run":
            if job_busy():
                return self.send_json({"error": "The viewer is busy loading data. Try again when it has finished."}, 409)
            if not os.path.exists(CURRENT_DB):
                return self.send_json({"error": "There's no stored data to compact yet."}, 400)
            if not compact_settings()["on"]:
                return self.send_json({"error": "Switch on Compact stored data first."}, 400)
            start_import("compact")
            return self.send_json({"ok": True})
        if path in ("/api/auto", "/api/auto/check"):
            length = to_int(self.headers.get("Content-Length"), 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except ValueError:
                data = {}
            if path == "/api/auto":
                cfg = read_json(CONFIG_FILE, {})
                cur = dict(AUTO_DEFAULTS)
                cur.update(cfg.get("auto_update") or {})
                if "enabled" in data:
                    cur["enabled"] = bool(data["enabled"])
                if data.get("path"):
                    err = auto_set_path(data["path"])
                    if err:
                        return self.send_json({"error": err}, 400)
                for k, lo, hi in (("quiet", 5, 3600), ("min_gap", 30, 86400)):
                    if k in data and to_int(data[k]) is not None:
                        cur[k] = max(lo, min(hi, to_int(data[k])))
                cfg["auto_update"] = cur
                write_json(CONFIG_FILE, cfg)
                threading.Thread(target=auto_tick, daemon=True).start()
                return self.send_json(auto_status())
            if data.get("wait"):
                # the header's "Update data" button (16.7.17): check now and say straight away what happened
                if not auto_watch_path():
                    return self.send_json(dict(auto_status(), state="nofile"))
                auto_tick(force=True)
                return self.send_json(auto_status())
            threading.Thread(target=auto_tick, kwargs={"force": True}, daemon=True).start()
            return self.send_json({"ok": True})
        if path == "/api/desktop/shortcut":
            # put "HRM Viewer" shortcuts on the desktop and in the Start menu (Windows)
            if PLATFORM == "linux":
                try:
                    return self.send_json({"ok": True, "path": linux_menu_entry()})
                except OSError as e:
                    return self.send_json({"error": "Couldn't add it to the menu: %s" % e}, 500)
            exe = os.path.join(APP_DIR, DESKTOP_EXE)
            if os.name != "nt" or not os.path.exists(exe):
                return self.send_json({"error": "This only works on Windows with HRM Viewer.exe in the viewer's folder."}, 400)
            q_ = lambda v: v.replace("'", "''")
            ps = ("$w = New-Object -ComObject WScript.Shell; "
                  "foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { "
                  "$s = $w.CreateShortcut((Join-Path $d 'HRM Viewer.lnk')); $s.TargetPath = '%s'; $s.WorkingDirectory = '%s'; "
                  "$s.IconLocation = '%s,0'; $s.Description = 'HRM Viewer'; $s.Save() }") % (q_(exe), q_(APP_DIR), q_(exe))
            import subprocess
            try:
                subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], check=True, timeout=60,
                               creationflags=0x08000000)
            except Exception as e:
                return self.send_json({"error": "Couldn't make the shortcuts: %s" % e}, 500)
            return self.send_json({"ok": True})
        if path == "/api/quit":
            # the desktop app closes the viewer when its window is closed
            self.send_json({"ok": True})

            def bye():
                time.sleep(0.3)
                os._exit(0)
            threading.Thread(target=bye, daemon=True).start()
            return
        if path == "/api/update":
            return self.handle_update(parse_qs(urlparse(self.path).query).get("check") == ["1"])
        if path == "/api/github/auto":
            length = to_int(self.headers.get("Content-Length"), 0)
            try:
                on = bool((json.loads(self.rfile.read(length) or b"{}") if length else {}).get("on"))
            except ValueError:
                return self.send_json({"error": "Bad request."}, 400)
            cfg = read_json(CONFIG_FILE, {})
            cfg["github_auto"] = on
            write_json(CONFIG_FILE, cfg)
            return self.send_json(github_check(force=False))
        if path == "/api/github/install":
            length = to_int(self.headers.get("Content-Length"), 0)
            try:
                want = str((json.loads(self.rfile.read(length) or b"{}") if length else {}).get("version") or "")
            except ValueError:
                want = ""
            if want:    # a particular version, newer or older (going back)
                try:
                    rel = next((r for r in github_releases(force=True) if r["version"] == want), None)
                except Exception as e:
                    return self.send_json({"error": "Couldn't reach GitHub (%s)." % (getattr(e, "reason", None) or e)}, 502)
                if not rel:
                    return self.send_json({"error": "Version %s isn't available on GitHub." % want}, 404)
                if rel["current"]:
                    return self.send_json({"error": "You already have version %s." % want}, 409)
                url = rel["update_url"]
            else:
                info = github_check(force=True)
                if not info.get("newer") or not info.get("update_url"):
                    return self.send_json({"error": info.get("error") or "There's no newer version on GitHub."}, 409)
                url = info["update_url"]
            try:
                data = github_get(url, binary=True)
            except Exception as e:
                return self.send_json({"error": "Couldn't download the update from GitHub: %s" % e}, 502)
            return self.install_update_bytes(data, check_only=False)
        if path == "/api/update/rollback":
            return self.handle_rollback()
        if path == "/api/import/upload":
            length = to_int(self.headers.get("Content-Length"), 0)
            if length <= 0:
                return self.send_json({"error": "Empty upload."}, 400)
            name = unquote(self.headers.get("X-Filename") or "uploaded file")
            new_db = None
            if self.headers.get("X-New-Db"):
                prev = ACTIVE["id"]
                sid = new_slot(unquote(self.headers.get("X-New-Db")))
                activate(sid, rebuild=False)
                new_db = {"id": sid, "prev": prev}
            set_job(state="running", step="Receiving the file", pct=0, error=None, started=time.time(), finished=None, confirm=None, result=None,
                    new_db=new_db, auto=False)
            try:
                if os.path.exists(INCOMING_DB):
                    os.remove(INCOMING_DB)
                got = 0
                with open(INCOMING_DB, "wb") as f:
                    while got < length:
                        chunk = self.rfile.read(min(1 << 20, length - got))
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        set_job(pct=int(40 * got / length))
                if got != length:
                    raise ValueError("The upload was cut off. Please try again.")
            except Exception as e:
                cleanup_temp_files()
                undo_new_db()
                set_job(state="error", error=str(e))
                return self.send_json({"error": str(e)}, 400)
            decision = "replace" if self.headers.get("X-Fresh") == "1" else None
            threading.Thread(target=run_import, args=("upload", None, decision, name), daemon=True).start()
            return self.send_json({"ok": True})
        self.send_json({"error": "Unknown address"}, 404)


# --------------------------------------------------------------------------- in-app updates

VERSION = "16.8.2"
BACKUP_DIR = os.path.join(APP_DIR, "backups")
UPDATE_PENDING = os.path.join(DATA_DIR, "update_pending.json")
UPDATE_RESULT = os.path.join(DATA_DIR, "update_result.json")
RESTART_CODE = 3
PORT_BUSY_CODE = 4    # another program has the port: nothing to restart or roll back
UPDATABLE = re.compile(r"^(app\.py|README\.txt|HRM Viewer\.new\.exe|static/[A-Za-z0-9._-]+)$")
DESKTOP_EXE = "HRM Viewer.exe"
UPDATE_LOCK = threading.Lock()


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return (0,)


def read_update_zip(data):
    """Check an update file and return (manifest, {relative_path: bytes}, skipped)."""
    import io
    import zipfile
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("That isn't an update file (it's not a .zip).")
    names = [n for n in z.namelist() if not n.endswith("/")]
    prefix = ""
    if "update.json" not in names:
        tops = {n.split("/", 1)[0] for n in names if "/" in n}
        if len(tops) == 1 and (next(iter(tops)) + "/update.json") in names:
            prefix = next(iter(tops)) + "/"
    if prefix + "update.json" not in names:
        raise ValueError("That zip isn't an HRM Viewer update (it has no update.json).")
    manifest = json.loads(z.read(prefix + "update.json").decode("utf-8"))
    if manifest.get("app") != "hrm-viewer" or not manifest.get("version"):
        raise ValueError("That zip isn't an HRM Viewer update.")
    files, skipped = {}, []
    for n in names:
        if not n.startswith(prefix):
            continue
        rel = n[len(prefix):]
        if rel == "update.json":
            continue
        if not UPDATABLE.match(rel) or ".." in rel:
            skipped.append(rel)
            continue
        info = z.getinfo(n)
        if info.file_size > 20 * 1024 * 1024:
            raise ValueError("The update contains a file that's too large: %s" % rel)
        files[rel] = z.read(n)
    if "app.py" not in files:
        raise ValueError("The update is incomplete (app.py is missing).")
    try:
        compile(files["app.py"].decode("utf-8"), "app.py", "exec")
    except SyntaxError as e:
        raise ValueError("The update is damaged (app.py doesn't run: %s)." % e)
    return manifest, files, skipped


def current_app_files():
    out = ["app.py", "README.txt"]
    if os.path.isdir(STATIC_DIR):
        out += ["static/" + f for f in sorted(os.listdir(STATIC_DIR)) if os.path.isfile(os.path.join(STATIC_DIR, f))]
    return [f for f in out if os.path.exists(os.path.join(APP_DIR, f))]


def backup_current(reason):
    """Copy the program files (never the data) into backups/<version>-<time>/."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, "viewer-%s-%s" % (VERSION, stamp))
    os.makedirs(os.path.join(dest, "static"), exist_ok=True)
    for rel in current_app_files():
        shutil.copy2(os.path.join(APP_DIR, rel), os.path.join(dest, rel))
    write_json(os.path.join(dest, "backup.json"), {"version": VERSION, "made": time.time(), "reason": reason})
    # keep the 5 most recent backups
    for old in list_backups()[5:]:
        shutil.rmtree(old["path"], ignore_errors=True)
    return dest


def list_backups():
    out = []
    if os.path.isdir(BACKUP_DIR):
        for name in os.listdir(BACKUP_DIR):
            p = os.path.join(BACKUP_DIR, name)
            info = read_json(os.path.join(p, "backup.json"), None)
            if info and os.path.exists(os.path.join(p, "app.py")):
                out.append({"path": p, "name": name, "version": info.get("version"), "made": info.get("made")})
    return sorted(out, key=lambda b: b["made"] or 0, reverse=True)


def replace_file(rel, content):
    if rel == "HRM Viewer.new.exe" and not os.path.exists(os.path.join(APP_DIR, DESKTOP_EXE)):
        rel = DESKTOP_EXE   # first time: the desktop app isn't there yet, so put it straight in place
    # (otherwise the running desktop app swaps in "HRM Viewer.new.exe" the next time it starts)
    target = os.path.join(APP_DIR, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".new"
    with open(tmp, "wb") as f:
        f.write(content)
    for attempt in range(10):
        try:
            os.replace(tmp, target)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.3)


def install_files(files, remove_others=True):
    if PLATFORM != "windows":   # updates carry the Windows app too; Mac and Linux have their own
        files = {rel: c for rel, c in files.items() if rel not in ("static/desktop-app.exe", "HRM Viewer.new.exe")}
    for rel, content in files.items():
        replace_file(rel, content)
    if remove_others:
        # static files the new version no longer has
        keep = {rel for rel in files if rel.startswith("static/")}
        for rel in current_app_files():
            if rel.startswith("static/") and rel not in keep:
                try:
                    os.remove(os.path.join(APP_DIR, rel))
                except OSError:
                    pass


def restore_backup(path):
    files = {}
    for rel in ["app.py", "README.txt"]:
        p = os.path.join(path, rel)
        if os.path.exists(p):
            files[rel] = open(p, "rb").read()
    sdir = os.path.join(path, "static")
    if os.path.isdir(sdir):
        for f in os.listdir(sdir):
            files["static/" + f] = open(os.path.join(sdir, f), "rb").read()
    install_files(files)


# ------------------------------------------------------------------ updates from GitHub Releases
# Each release is tagged v<version> and carries HRM-Viewer-update-<version>.zip (for the in-app installer) and
# HRM-Viewer-<version>-full.zip (for new downloads). The viewer asks GitHub for the latest release now and then.
GITHUB_REPO = "HRMViewer/hrm-viewer"   # the public repository the releases come from
GITHUB_API = os.environ.get("HRMV_GITHUB_API", "https://api.github.com")
GH_CACHE = {"at": 0, "repo": None, "data": None}
GH_REL_CACHE = {"at": 0, "data": None}
GH_OLDEST = "12.4"   # going back further would lose the built-in Python, so older releases aren't offered
GH_OLDEST_UNIX = "14.6"   # the first version made for Mac and Linux
FULL_ASSET = {"windows": r"^HRM-Viewer-[\d.]+-full\.zip$", "mac": r"^HRM-Viewer-[\d.]+-mac\.zip$",
              "linux": r"^HRM-Viewer-[\d.]+-linux\.tar\.gz$"}


def github_repo():
    r = (os.environ.get("HRMV_GITHUB_REPO") or GITHUB_REPO).strip()
    return r if re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", r) else ""


def github_get(url, binary=False, limit=60 * 1024 * 1024):
    req = urllib.request.Request(url, headers={"User-Agent": "HRM-Viewer/%s" % VERSION,
                                               "Accept": "application/octet-stream" if binary else "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("The download is larger than expected.")
    return data if binary else json.loads(data.decode("utf-8"))


def github_auto():
    """Whether the viewer looks for new versions by itself (Settings → Updates). On unless switched off."""
    return read_json(CONFIG_FILE, {}).get("github_auto", True) is not False


def github_check(force=False):
    """The newest release on GitHub, and whether it's newer than this viewer. Asked at most every 6 hours unless forced.
    With automatic checks switched off, GitHub is only asked when you press Check now."""
    repo = github_repo()
    if not repo:
        return {"configured": False, "current": VERSION, "auto": github_auto()}
    if not force and not github_auto():
        last = GH_CACHE["data"] if GH_CACHE["repo"] == repo and GH_CACHE["data"] else {}
        return dict(last, configured=True, repo=repo, current=VERSION, page="https://github.com/%s/releases" % repo, auto=False)
    if not force and GH_CACHE["repo"] == repo and GH_CACHE["data"] and time.time() - GH_CACHE["at"] < 6 * 3600:
        return dict(GH_CACHE["data"], auto=True)
    out = {"configured": True, "repo": repo, "current": VERSION, "page": "https://github.com/%s/releases" % repo}
    try:
        rel = github_get("%s/repos/%s/releases/latest" % (GITHUB_API, repo))
        tag = str(rel.get("tag_name") or "").lstrip("vV")
        assets = rel.get("assets") or []
        upd = next((a for a in assets if re.match(r"^HRM-Viewer-update-[\d.]+\.zip$", a.get("name") or "")), None)
        full = next((a for a in assets if re.match(FULL_ASSET[PLATFORM], a.get("name") or "")), None)
        out.update({"latest": tag, "name": rel.get("name") or tag, "notes": (rel.get("body") or "")[:4000],
                    "published": rel.get("published_at"), "release_page": rel.get("html_url"),
                    "update_url": upd and upd.get("browser_download_url"), "update_size": upd and upd.get("size"),
                    "full_url": full and full.get("browser_download_url"),
                    "newer": bool(tag) and version_tuple(tag) > version_tuple(VERSION) and bool(upd)})
    except Exception as e:
        if getattr(e, "code", None) == 404:      # the repository has no releases yet
            out.update({"latest": None, "newer": False})
        else:
            out.update({"error": "Couldn't reach GitHub (%s)." % (getattr(e, "reason", None) or getattr(e, "code", None) or e)})
    GH_CACHE.update({"at": time.time(), "repo": repo, "data": out})
    return dict(out, auto=github_auto())


def github_releases(force=False):
    """Every published version on GitHub (newest first) that can be installed from inside the viewer."""
    repo = github_repo()
    if not force and GH_REL_CACHE["data"] and time.time() - GH_REL_CACHE["at"] < 600:
        return GH_REL_CACHE["data"]
    out = []
    for rel in github_get("%s/repos/%s/releases?per_page=60" % (GITHUB_API, repo)):
        if rel.get("draft") or rel.get("prerelease"):
            continue
        v = str(rel.get("tag_name") or "").lstrip("vV")
        upd = next((a for a in rel.get("assets") or [] if a.get("name") == "HRM-Viewer-update-%s.zip" % v), None)
        oldest = GH_OLDEST if PLATFORM == "windows" else GH_OLDEST_UNIX
        if not v or not upd or not re.match(r"^\d+(\.\d+)*$", v) or version_tuple(v) < version_tuple(oldest):
            continue
        out.append({"version": v, "name": rel.get("name") or v, "notes": (rel.get("body") or "")[:4000],
                    "published": rel.get("published_at"), "page": rel.get("html_url"),
                    "update_url": upd.get("browser_download_url"), "size": upd.get("size"),
                    "current": version_tuple(v) == version_tuple(VERSION), "newer": version_tuple(v) > version_tuple(VERSION)})
    out.sort(key=lambda r: version_tuple(r["version"]), reverse=True)
    GH_REL_CACHE.update({"at": time.time(), "data": out})
    return out


def restart_soon():
    """Exit with the restart code; the supervisor starts the new version."""
    def go():
        time.sleep(0.6)
        os._exit(RESTART_CODE)
    threading.Thread(target=go, daemon=True).start()


def update_status():
    return {
        "version": VERSION,
        "backups": [{"name": b["name"], "version": b["version"], "made": b["made"]}
                    for b in list_backups() if b["version"] != VERSION],
        "last_update": read_json(UPDATE_RESULT, None),
        "supervised": os.environ.get("HRMV_SUPERVISED") == "1",
    }


def supervise(argv):
    """Run the viewer in a child process and restart it after an update.

    If a freshly installed version fails to start, put the previous version back."""
    import subprocess
    args = list(argv)
    first = True
    env = dict(os.environ, HRMV_SUPERVISED="1")
    while True:
        run_args = args
        if not first:
            run_args = []
            skip = False
            for a in args:
                if skip:
                    skip = False
                    continue
                if a == "--import":
                    skip = True
                    continue
                if a.startswith("--import=") or a == "--no-browser":
                    continue
                run_args.append(a)
            run_args.append("--no-browser")
        if not first and os.environ.get("HRMV_PORT_FILE"):
            got = to_int((read_json(os.environ["HRMV_PORT_FILE"], {}) or {}).get("port"))
            if got:
                run_args = [a for i, a in enumerate(run_args) if a != "--port" and (i == 0 or run_args[i - 1] != "--port")] + ["--port", str(got)]
        cmd = [sys.executable, os.path.join(APP_DIR, "app.py"), "--child"] + run_args
        try:
            rc = subprocess.call(cmd, env=env)
        except KeyboardInterrupt:
            return 0
        first = False
        if rc == PORT_BUSY_CODE:     # not a failed update: leave the installed version alone
            return rc
        if rc == RESTART_CODE:
            print("\nRestarting the viewer...\n")
            continue
        pending = read_json(UPDATE_PENDING, None)
        # an update that exits for any reason before it started serving gets undone
        if pending and pending.get("backup") and os.path.isdir(pending["backup"]):
            print("\nThe new version didn't start, so the previous version is being put back...\n")
            try:
                restore_backup(pending["backup"])
                shutil.rmtree(pending["backup"], ignore_errors=True)  # it's the live version again
                write_json(UPDATE_RESULT, {"ok": False, "at": time.time(), "from": pending.get("from"), "to": pending.get("to"),
                                           "message": "Version %s didn't start, so version %s was put back. Nothing else changed."
                                           % (pending.get("to"), pending.get("from"))})
            finally:
                try:
                    os.remove(UPDATE_PENDING)
                except OSError:
                    pass
            continue
        return rc


GUIDE_NAME = "HRM Viewer - Quick Guide.pdf"


def sync_guide():
    """Updates carry the Quick Guide as static/quick-guide.pdf; keep a copy next to HRM Viewer.exe where it's easy to find
    (replacing the older HTML guide from 11.2/11.3)."""
    src = os.path.join(STATIC_DIR, "quick-guide.pdf")
    if not os.path.exists(src):
        return
    dst = os.path.join(APP_DIR, GUIDE_NAME)
    try:
        new = open(src, "rb").read()
        if not (os.path.exists(dst) and open(dst, "rb").read() == new):
            tmp = dst + ".tmp"
            with open(tmp, "wb") as f:
                f.write(new)
            os.replace(tmp, dst)
        old = os.path.join(APP_DIR, "HRM Viewer - Quick Guide.html")
        if os.path.exists(old):
            os.remove(old)
    except OSError as e:     # e.g. the PDF is open in a reader: try again next time
        print("Couldn't put the Quick Guide in place: %s" % e)


def sync_desktop_exe():
    """Updates carry the desktop app as static/desktop-app.exe; put it in place as HRM Viewer.exe.
    If HRM Viewer.exe is open (and so can't be replaced), leave the new one as HRM Viewer.new.exe:
    the app swaps it in the next time it starts."""
    src = os.path.join(STATIC_DIR, "desktop-app.exe")
    if os.name != "nt" or not os.path.exists(src):
        return
    dst = os.path.join(APP_DIR, DESKTOP_EXE)
    try:
        new = open(src, "rb").read()
        if os.path.exists(dst) and open(dst, "rb").read() == new:
            return
        pending = os.path.join(APP_DIR, "HRM Viewer.new.exe")
        if os.path.exists(pending) and open(pending, "rb").read() == new:
            return
        tmp = dst + ".tmp"
        with open(tmp, "wb") as f:
            f.write(new)
        try:
            os.replace(tmp, dst)
        except PermissionError:
            os.replace(tmp, pending)   # the app is running; it picks this up next time
    except OSError as e:
        print("Couldn't put the desktop app in place: %s" % e)


def remove_launchers():
    """HRM Viewer.exe is the only way to open the viewer now: tidy away the old batch files
    (only when the viewer was opened by the app, so a running Start.bat is never pulled from under itself)."""
    if os.environ.get("HRMV_DESKTOP") != "1" or not os.path.exists(os.path.join(APP_DIR, DESKTOP_EXE)):
        return
    for f in ("Start.bat", "Load database.bat"):
        try:
            os.remove(os.path.join(APP_DIR, f))
        except OSError:
            pass


def mark_started():
    """Called once the server is running: a pending update has worked."""
    pending = read_json(UPDATE_PENDING, None)
    if pending:
        write_json(UPDATE_RESULT, {"ok": True, "at": time.time(), "from": pending.get("from"), "to": VERSION,
                                   "message": pending.get("message") or "Updated from version %s to %s." % (pending.get("from"), VERSION)})
        try:
            os.remove(UPDATE_PENDING)
        except OSError:
            pass


def viewer_answering(port):
    """Is HRM Viewer itself (not some other program) answering on this port?"""
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))    # straight to this computer, never via a proxy
        with opener.open("http://127.0.0.1:%d/api/status" % port, timeout=2) as r:
            return r.status == 200 and b'"app"' in r.read(1 << 20)
    except Exception:
        return False


def port_taken(port):
    """Is something listening on this port right now (as opposed to it just being released a moment ago)?"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def bind_viewer(port, auto):
    """Open the viewer's server. Returns (server, None), or (None, "viewer"/"other") when the port can't be had.

    The port asked for is used whenever possible, so the address (and the settings the window keeps for it) stays the
    same. With auto (opened by HRM Viewer.exe) another free port is found instead of giving up: the next 500 above it,
    and failing those, any port the system has free."""
    deadline = time.time() + 8
    while True:
        try:
            return ViewerServer(("127.0.0.1", port), Handler), None
        except OSError as e:
            # Windows keeps some port ranges for itself (Hyper-V, WSL, Docker): "access denied", and no point waiting
            if getattr(e, "winerror", None) == 10013 or e.errno == 13:
                break
        if viewer_answering(port):
            return None, "viewer"
        if port_taken(port) or time.time() > deadline:
            break
        time.sleep(0.5)       # nothing is listening: the port is still being released (e.g. a restart after an update)
    if not auto:
        return None, "other"
    for p in list(range(port + 1, min(port + 501, 65536))):
        try:
            return ViewerServer(("127.0.0.1", p), Handler), None
        except OSError:
            continue
    try:
        return ViewerServer(("127.0.0.1", 0), Handler), None     # any free port at all
    except OSError:
        return None, "other"


class ViewerServer(ThreadingHTTPServer):
    """On Windows, SO_REUSEADDR lets a second program bind a port another one is already using (and the other one keeps
    getting the visitors), so the viewer asks for its port to itself there: if anything else has it, starting says so."""
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def watch_launcher():
    """Mac and Linux app: the launcher keeps a pipe open to the viewer. When the launcher goes away for any reason
    (window closed, Quit from the Dock, a crash), the pipe closes and the viewer stops too, rather than staying behind."""
    if os.environ.get("HRMV_WATCH_STDIN") != "1":
        return

    def run():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        os._exit(0)
    threading.Thread(target=run, daemon=True).start()


def main():
    watch_launcher()
    if "--child" not in sys.argv[1:] and os.environ.get("HRMV_NO_SUPERVISOR") != "1":
        # Run the real viewer in a child process so it can restart itself after an update.
        sys.exit(supervise(sys.argv[1:]))
    ap = argparse.ArgumentParser(description="Horse Racing Manager database viewer")
    ap.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--import", dest="import_path", help="Load this database.db before starting")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(DBS_DIR, exist_ok=True)
    sync_desktop_exe()
    sync_guide()
    remove_launchers()
    set_paths(resolve_active())
    remember_active(ACTIVE["id"])
    for sid in list_slots():
        for f in ("incoming.db", "work.db", "current.db.part"):
            try:
                os.remove(os.path.join(slot_dir(sid), f))
            except OSError:
                pass
    load_meta()
    print("Database: %s" % slot_name(ACTIVE["id"]))
    if ensure_derived(lambda: print("Updating your stored data for this version of the viewer (about 15 seconds)...")):
        print("Done.")

    if args.import_path:
        print("Loading %s ..." % args.import_path)
        start_import("path", args.import_path)
        last = ""
        while True:
            s = job_snapshot()
            if s["state"] == "running":
                line = "  %3d%%  %s" % (s["pct"], s["step"])
                if line != last:
                    print(line)
                    last = line
                time.sleep(0.5)
                continue
            if s["state"] == "confirm":
                c = s["confirm"]
                print()
                print(c["message"])
                keys = {}
                for i, (code, label) in enumerate(c["options"], 1):
                    keys[str(i)] = code
                    print("  %d. %s" % (i, label))
                choice = ""
                while choice not in keys:
                    choice = input("Type a number and press Enter: ").strip()
                answer_confirm(keys[choice])
                if keys[choice] == "cancel":
                    print("Cancelled. Nothing was changed.")
                    break
                time.sleep(0.3)
                continue
            break
        s = job_snapshot()
        if s["state"] == "error":
            print("Could not load the database: %s" % s["error"])
            sys.exit(1)
        if s["state"] == "done":
            r = s.get("result") or {}
            if r.get("kept"):
                print("Kept %s older records that the new save no longer has." % format(r["kept"], ","))
        if job_snapshot()["state"] == "done":
            print("Loaded.")

    auto_port = os.environ.get("HRMV_PORT_AUTO") == "1"    # opened by HRM Viewer.exe: any free port will do
    port_file = os.environ.get("HRMV_PORT_FILE")
    server, why = bind_viewer(args.port, auto_port)
    if server is None:
        if why == "viewer":
            print("Port %d is busy - the viewer is already running. Opening it in your browser." % args.port)
            if port_file:
                write_json(port_file, {"port": args.port, "pid": os.getpid(), "at": time.time()})
            if not args.no_browser:
                webbrowser.open("http://127.0.0.1:%d/" % args.port)
            return
        print("Port %d is already in use by another program (not the viewer), so the viewer can't start there. "
              "Close that program or restart your PC, then open the viewer again." % args.port)
        sys.exit(PORT_BUSY_CODE)
    if server.server_address[1] != args.port:
        print("Port %d is used by another program, so the viewer is using port %d instead." % (args.port, server.server_address[1]))
        args.port = server.server_address[1]
    if port_file:     # tells HRM Viewer.exe (and a restart after an update) where the viewer is
        write_json(port_file, {"port": args.port, "pid": os.getpid(), "at": time.time()})
    server.daemon_threads = True
    global PORT
    PORT = args.port
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=auto_watcher, daemon=True).start()
    mark_started()
    warm_up()
    url = "http://127.0.0.1:%d/" % args.port
    print("HRM Database Viewer is running at %s" % url)
    print("Leave this window open while you use it. Close it (or press Ctrl+C) to stop.")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

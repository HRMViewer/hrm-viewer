"""HRM Database Viewer - a local viewer for Horse Racing Manager save databases.

Run:  python app.py            (opens the viewer in your browser)
      python app.py --import "C:\\path\\to\\database.db"   (load a database, then start)

Only the Python standard library is used. The stored copy lives in the "data" folder
next to this file. Loading a new database replaces it.
"""

import argparse
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
    ("race_participants", "race_participant_race_id"),
    ("race_participants", "race_participant_horse_id"),
    ("race_participants", "race_participant_person_jockey_id"),
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
        pages = ["home", "meetings", "horses", "races", "races?when=upcoming", "stables", "people", "awards", "courses", "pedigrees",
                 "pedigrees?kind=dams", "pedigrees?kind=damsires", "horse_table", "stable_table", "tables"]
        if META.get("player_id"):
            pages.append("person/%s" % META["player_id"])
        if META.get("player_stable_id"):
            pages += ["stable/%s" % META["player_stable_id"], "horse_table?stable=%s" % META["player_stable_id"],
                      "stable_races/%s" % META["player_stable_id"]]
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


def set_job(**kw):
    with JOB_LOCK:
        JOB.update(kw)


def job_snapshot():
    with JOB_LOCK:
        return dict(JOB)


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


def process_incoming(source_label, source_path, decision=None, validated=False):
    """Validate data/incoming.db, merge with the stored data, add indexes and stats, then swap it in.

    decision: None = merge automatically (asking first if the file is from another save or older),
    "merge" = newest wins, "add" = only add missing rows, "replace" = start fresh from this file."""
    if not validated:
        validate_incoming()
    new = read_save_info(INCOMING_DB)
    mode = "fresh"
    added = {}
    if os.path.exists(CURRENT_DB):
        old = stored_save_info()
        same = bool(old.get("save_id")) and old.get("save_id") == new.get("save_id")
        older = same and new["game_date"] is not None and old["game_date"] is not None and new["game_date"] < old["game_date"]
        # each database follows one player: a different player name (or a different save) means asking first
        player_changed = bool(old.get("player")) and bool(new.get("player")) and old["player"] != new["player"]
        if decision is None:
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
            added = merge_missing(INCOMING_DB, CURRENT_DB, new["game_date"], old["game_date"])
        elif mode == "merge_old":
            set_job(step="Copying the stored data", pct=40)
            shutil.copyfile(CURRENT_DB, WORK_DB)
            added = merge_missing(WORK_DB, INCOMING_DB, old["game_date"], new["game_date"])
            os.replace(WORK_DB, INCOMING_DB)

    con = sqlite3.connect(INCOMING_DB)
    try:
        ensure_removed_table(con)
        todo = []
        for table, col in INDEXES:
            if has_table(con, table) and col in columns(con, table):
                todo.append((table, col))
        for i, (table, col) in enumerate(todo):
            set_job(step="Building fast lookups (%d of %d)" % (i + 1, len(todo)), pct=60 + int(22 * i / max(1, len(todo))))
            con.execute("create index if not exists %s on %s(%s)" % (qident("hrmv_%s_%s" % (table, col)), qident(table), qident(col)))
        con.commit()

        set_job(step="Working out career and stable stats", pct=84)
        build_derived(con)

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

    set_job(step="Saving", pct=97)
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
        build_derived(con)
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
        for f in ("current.db", "meta.json"):
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

AUTO_DEFAULTS = {"enabled": False, "quiet": 30, "min_gap": 300}
AUTO = {"state": "off", "message": "", "last_check": None, "changed_at": None, "seen_sig": None, "last_import": None,
        "last_result": None, "running": False}
AUTO_LOCK = threading.Lock()


def auto_settings():
    cfg = read_json(CONFIG_FILE, {})
    out = dict(AUTO_DEFAULTS)
    out.update(cfg.get("auto_update") or {})
    return out


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
    return dict(a, settings=st, path=path, exists=exists, file_mtime=mtime, loaded_at=META.get("loaded_at"),
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
           "has_exe": os.path.exists(os.path.join(APP_DIR, DESKTOP_EXE))}
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
    return {"results": res}


HORSE_SORTS = {"earnings": "h.horse_career_earnings", "rating": "h.horse_international_rating", "name": "h.horse_name",
               "birth": "h.horse_birth_date", "value": "h.horse_value_calculated", "g1": "h.horse_g1_wins"}


def api_horses(con, q):
    where, params = [], []
    if q.get("q"):
        where.append("h.horse_name like ?")
        params.append("%" + q["q"] + "%")
    status = q.get("status") or "alive"
    if status == "alive":
        where.append("h.horse_deceased_date is null and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')")
    elif status == "dead":
        where.append("h.horse_deceased_date is not null")
    if q.get("gender"):
        where.append("h.horse_gender=?")
        params.append(q["gender"])
    if q.get("stable"):
        where.append("h.horse_stable_id=?")
        params.append(to_int(q["stable"]))
    sort, d = sort_args(q, HORSE_SORTS, "earnings")
    page, off = page_args(q)
    w = (" where " + " and ".join(where)) if where else ""
    total = count_rows(con, "select count(*) from horses h" + w, params)
    data = rows(con, """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth,
        h.horse_deceased_date as died, h.horse_career_earnings as earnings, h.horse_international_rating as rating,
        h.horse_value_calculated as value, h.horse_g1_wins as g1, h.horse_form as form, h.horse_color as color,
        h.horse_stable_id as stable_id, s.stable_name as stable_name
        from horses h left join stables s on s.stable_stable_id=h.horse_stable_id""" + w +
                " order by %s limit %d offset %d" % (order_sql(sort, d), page_size(), off), params)
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


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
        out["health"] = rows(con, """select h.illness_injury_history_start_date as start, h.illness_injury_history_end_date as end,
            i.injury_illness_name as name, i.injury_illness_type as type, i.injury_illness_severity as severity
            from illness_injury_history h left join injury_illness i on i.injury_illness_id=h.illness_injury_history_injury_illness_id
            where h.illness_injury_entity_id=? and h.illness_injury_entity_type='horse' order by h.illness_injury_history_start_date desc""", (hid,))
    out["traits"] = entity_traits(con, hid, "horse")
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
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


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


def api_stable(con, sid):
    s = one(con, "select * from stables where stable_stable_id=?", (sid,))
    if not s:
        return None
    out = {"stable": clean_blob(s), "removed": removed_info(con, "stables", sid)}
    out["record"] = one(con, "select * from hrmv_stable_stats where stable_id=?", (sid,)) if has_table(con, "hrmv_stable_stats") else None
    out["owner"] = one(con, "select person_person_id as id, person_full_name as name from persons where person_person_id=?", (s.get("stable_owner_id"),))
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
    out["recent_results"] = rows(con, """select r.race_result_date as date, r.race_result_rank as rank, r.race_result_cash_received as prize,
        r.race_result_horse_id as horse_id, h.horse_name as horse, r.race_result_race_id as race_id, x.races_race_name as race_name,
        x.races_type_of_race as race_type, r.race_result_person_jockey_id as jockey_id, j.person_full_name as jockey
        from race_results r left join horses h on h.horse_horse_id=r.race_result_horse_id
        left join races x on x.races_race_id=r.race_result_race_id and r.race_result_race_id>0
        left join persons j on j.person_person_id=r.race_result_person_jockey_id
        where r.race_result_stable_id=? order by r.race_result_date desc limit 100""", (sid,))
    if has_table(con, "stable_investors"):
        out["investors"] = rows(con, """select i.investor_person_id as id, p.person_full_name as name, sum(i.investor_shares_owned) as shares
            from stable_investors i left join persons p on p.person_person_id=i.investor_person_id
            where i.investor_stable_id=? group by i.investor_person_id order by shares desc limit 15""", (sid,))
    out["courses"] = rows(con, "select racecourse_racecourse_id as id, racecourse_name as name from racecourses where racecourse_owner_stable_id=?", (sid,))
    return out


FIN_YEAR = "cast(strftime('%Y', {0}, 'unixepoch') as int)"


def api_stable_finance(con, sid, q):
    """Financials tab: income and expenses per year from the monthly snapshots (one column per category, as the game stores them),
    plus the expense detail for one year from the transaction log (category -> type -> individual payments)."""
    if not one(con, "select 1 as x from stables where stable_stable_id=?", (sid,)):
        return None
    out = {"income_cats": [], "expense_cats": [], "years": [], "detail": None, "detail_years": []}
    if has_table(con, "stable_financial_snapshots"):
        cols = columns(con, "stable_financial_snapshots")
        inc = [c for c in cols if c.startswith("snapshot_income_") and c != "snapshot_income_total"]
        exp = [c for c in cols if c.startswith("snapshot_expense_") and c != "snapshot_expense_total"]
        out["income_cats"] = [c[len("snapshot_income_"):] for c in inc]
        out["expense_cats"] = [c[len("snapshot_expense_"):] for c in exp]
        sums = ", ".join("sum(%s) as %s" % (qident(c), qident(c)) for c in inc + exp + ["snapshot_income_total", "snapshot_expense_total"])
        for r in rows(con, "select %s as year, count(*) as months, %s from stable_financial_snapshots where snapshot_stable_id=? group by 1 order by 1"
                      % (FIN_YEAR.format("snapshot_date"), sums), (sid,)):
            out["years"].append({
                "year": r["year"], "months": r["months"],
                "income": {c[len("snapshot_income_"):]: r[c] or 0 for c in inc}, "income_total": r["snapshot_income_total"] or 0,
                "expenses": {c[len("snapshot_expense_"):]: r[c] or 0 for c in exp}, "expense_total": r["snapshot_expense_total"] or 0,
            })
        # a year still in progress is compared with the same months of the year before ("prev_same")
        part = [y for y in out["years"] if y["months"] < 12]
        if part:
            cols_sel = ", ".join(qident(c) for c in inc + exp + ["snapshot_income_total", "snapshot_expense_total"])
            monthly = rows(con, "select %s as year, cast(strftime('%%m', snapshot_date, 'unixepoch') as int) as month, %s from stable_financial_snapshots where snapshot_stable_id=?"
                           % (FIN_YEAR.format("snapshot_date"), cols_sel), (sid,))
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
        # money paid out by the stable; the game's "Yearly Summary" rows roll up years it no longer keeps in detail, so they're left out
        base = """from transactions where transaction_from_entity_type='stable' and transaction_from_entity_id=?
            and coalesce(transaction_type,'') <> 'Yearly Summary'"""
        yr = FIN_YEAR.format("transaction_date")
        out["detail_years"] = [r["year"] for r in rows(con, "select distinct %s as year %s order by 1" % (yr, base), (sid,))]
        year = to_int(q.get("year"), 0) or (out["detail_years"][-1] if out["detail_years"] else 0)
        if year in out["detail_years"]:
            lo, hi = calendar.timegm((year, 1, 1, 0, 0, 0)), calendar.timegm((year + 1, 1, 1, 0, 0, 0))
            cats = {}
            for r in rows(con, """select transaction_category as cat, transaction_type as type, count(*) as n, sum(transaction_amount) as total
                    %s and transaction_date >= ? and transaction_date < ? group by 1, 2""" % base, (sid, lo, hi)):
                c = cats.setdefault(r["cat"] or "", {"cat": r["cat"] or "", "total": 0, "n": 0, "types": []})
                c["total"] += r["total"] or 0
                c["n"] += r["n"]
                c["types"].append({"type": r["type"] or "", "n": r["n"], "total": r["total"] or 0, "items": []})
            items = rows(con, """select transaction_category as cat, transaction_type as type, transaction_date as date, transaction_amount as amount,
                    transaction_note as note, transaction_to_entity_type as to_type, transaction_to_entity_id as to_id
                    %s and transaction_date >= ? and transaction_date < ? order by transaction_date desc, transaction_transaction_id desc""" % base, (sid, lo, hi))
            # names for who was paid (people and stables; other payees are the bank, a racecourse and so on)
            def to_int_id(v):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
            pn = name_map(con, "persons", "person_person_id", "person_full_name", [to_int_id(i["to_id"]) for i in items if i["to_type"] == "person"])
            sn = name_map(con, "stables", "stable_stable_id", "stable_name", [to_int_id(i["to_id"]) for i in items if i["to_type"] == "stable"])
            for it in items:
                it["to_id"] = to_int_id(it["to_id"])
                it["to_name"] = (pn if it["to_type"] == "person" else sn if it["to_type"] == "stable" else {}).get(it["to_id"])
            find = {(c["cat"], t["type"]): t for c in cats.values() for t in c["types"]}
            for it in items:
                t = find.get((it["cat"] or "", it["type"] or ""))
                if t is not None and len(t["items"]) < 200:      # newest 200 payments per type
                    t["items"].append(it)
            for c in cats.values():
                c["types"].sort(key=lambda t: -(t["total"] or 0))
            out["detail"] = {"year": year, "categories": sorted(cats.values(), key=lambda c: -(c["total"] or 0)),
                             "total": sum(c["total"] for c in cats.values())}
    return out


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


def api_stable_horse_money(con, sid, q):
    """Horse finances tab: money in and out for every horse the stable has had, now or in the past.
    Each horse's figures only count what happened while it was with this stable (as far as the save can tell)."""
    if not one(con, "select 1 as x from stables where stable_stable_id=?", (sid,)):
        return None
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

    yr = lambda ts: datetime.datetime.utcfromtimestamp(ts).year if isinstance(ts, (int, float)) and ts > -2e10 else None
    # income: prize money while racing for the stable, sales, stud fees, and named payments
    for r in rows(con, """select race_result_horse_id as id, cast(strftime('%Y', race_result_date, 'unixepoch') as int) as year, sum(race_result_cash_received) as prize
            from race_results where race_result_stable_id=? group by 1, 2""", (sid,)):
        put(r["id"], "inc", "Prize money", r["year"], r["prize"] or 0)
    for a in auctions:
        if a["frm"] == sid:
            put(a["id"], "inc", "Sale (after auction house cut)", yr(a["date"]), (a["price"] or 0) - (a["cut"] or 0))
        if a["too"] == sid:
            put(a["id"], "exp", "Purchase", yr(a["date"]), a["price"] or 0)
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
    role = q.get("role")
    if role:
        join = " join staff f on f.staff_person_id=p.person_person_id and f.staff_end_date is null and f.staff_current_role=?"
        params.insert(0, role)
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
    return {"total": total, "page": page, "page_size": page_size(), "rows": data}


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
    out["awards"] = rows(con, """select award_category as category, award_year as year, award_rank as rank, award_value as value, award_description as description
        from awards where award_entity_id=? and award_entity_type='person' order by award_date desc""", (pid,)) if has_table(con, "awards") else []
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


# --------------------------------------------------------------------------- derived stats (v2)

DERIVED_VERSION = 6
YEAR = 365.2425 * 86400
STAKES_TYPES = "('G1','G2','G3','listed')"


def build_derived(con):
    """Precompute per-horse race records and per-stable totals into hrmv_* tables."""
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
    build_sectionals(con)
    con.commit()


def build_sectionals(con):
    """Sectional times from the race position snapshots (taken at 25%, 50%, 75%, 90% and 100% of the race)."""
    con.executescript("drop table if exists hrmv_sectionals; drop table if exists hrmv_section_records;")
    if not has_table(con, "race_position_snapshots"):
        return
    pick = lambda col, name: ", ".join("max(case when k=%d then %s end) as %s%d" % (k, col, name, k) for k in range(1, 6))
    con.executescript("""
        create table hrmv_sectionals as
        select race_position_race_id as race_id, race_position_horse_id as horse_id, %s, %s, %s, %s, %s,
            max(case when k=5 then race_position_stamina_percentage end) as stamina
        from (select *, case when race_position_completion_percentage between 0.24 and 0.26 then 1
                             when race_position_completion_percentage between 0.49 and 0.51 then 2
                             when race_position_completion_percentage between 0.74 and 0.76 then 3
                             when race_position_completion_percentage between 0.89 and 0.91 then 4
                             when race_position_completion_percentage >= 0.99 then 5 end as k
              from race_position_snapshots not indexed)
        where k is not null group by 1, 2;
        create index hrmv_sectionals_race on hrmv_sectionals(race_id);
        create table hrmv_section_records as
        with s as (
            select d.raceday_racecourse_id as course_id, x.races_track as track, cast(round(x.races_distance) as integer) as distance,
                x.races_race_date_time as date, s.race_id, s.horse_id, s.t1, s.t2, s.t3, s.t4, s.t5
            from hrmv_sectionals s join races x on x.races_race_id=s.race_id
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
        select course_id, track, distance, sec, time, horse_id, race_id, date, runs from rk where rn=1;
        create index hrmv_section_records_course on hrmv_section_records(course_id);
    """ % (pick("race_position_snapshot_time", "t"), pick("race_position_current_rank", "r"), pick("race_position_meters_from_leader", "m"),
           pick("race_position_current_speed", "v"), pick("race_position_distance_completed", "d")))


def gwins(alias_h, alias_s, g):
    return "max(coalesce(%s.horse_%s_wins,0), coalesce(%s.%s,0))" % (alias_h, g, alias_s, g)


# --------------------------------------------------------------------------- Horse table tab

HT_SORTS = {
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
    if status == "alive":
        where.append("h.horse_deceased_date is null and h.horse_horse_id not in (select pk from hrmv_removed where tbl='horses')")
    elif status == "dead":
        where.append("h.horse_deceased_date is not null")
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
    if q.get("stakes") == "1":
        where.append("(coalesce(s.stakes_wins,0)>0 or coalesce(h.horse_g1_wins,0)+coalesce(h.horse_g2_wins,0)+coalesce(h.horse_g3_wins,0)+coalesce(h.horse_listed_wins,0)>0)")
    base = """from horses h left join hrmv_horse_stats s on s.horse_id=h.horse_horse_id
        left join stables st on st.stable_stable_id=h.horse_stable_id
        left join horses sp on sp.horse_horse_id=h.horse_breeding_parent_stallion_id
        left join horses dp on dp.horse_horse_id=h.horse_breeding_parent_mare_id"""
    w = (" where " + " and ".join(where)) if where else ""
    sel = """select h.horse_horse_id as id, h.horse_name as name, h.horse_gender as gender, h.horse_birth_date as birth,
        h.horse_deceased_date as died, h.horse_stable_id as stable_id, st.stable_name as stable,
        h.horse_breeding_parent_stallion_id as sire_id, sp.horse_name as sire, h.horse_breeding_parent_mare_id as dam_id, dp.horse_name as dam,
        h.horse_international_rating as rating, h.horse_peak_rating as peak, coalesce(s.starts,0) as starts, coalesce(s.wins,0) as wins,
        coalesce(s.seconds,0) as seconds, coalesce(s.thirds,0) as thirds, %s as g1, %s as g2, %s as g3, %s as listed,
        h.horse_career_earnings as earnings, h.horse_value_calculated as value, h.horse_form as form, s.last_run as last_run,
        h.horse_distance_preference as distance_pref, h.horse_condition as condition, h.horse_breeding_ability as breeding,
        h.horse_color as color, h.horse_breed as breed """ % (gwins("h", "s", "g1"), gwins("h", "s", "g2"), gwins("h", "s", "g3"), gwins("h", "s", "listed"))
    sort, d = sort_args(q, HT_SORTS, "earnings")
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
    order = " order by " + order_sql(sort, d)
    return sel + base + w + order, "select count(*) " + base + w, params


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
    if to_int(q.get("minrunners")):
        outer_where.append("g.runners>=?"); params.append(to_int(q["minrunners"]))
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
    return [d[0] for d in cur.description], cur


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
    (re.compile(r"^/api/people$"), lambda con, m, q: api_people(con, q)),
    (re.compile(r"^/api/careers$"), lambda con, m, q: api_careers(con, q)),
    (re.compile(r"^/api/person/(-?\d+)$"), lambda con, m, q: api_person(con, int(m.group(1)))),
    (re.compile(r"^/api/courses$"), lambda con, m, q: api_courses(con, q)),
    (re.compile(r"^/api/course/(-?\d+)$"), lambda con, m, q: api_course(con, int(m.group(1)))),
    (re.compile(r"^/api/tables$"), lambda con, m, q: api_tables(con, q)),
    (re.compile(r"^/api/horse_table$"), lambda con, m, q: api_horse_table(con, q)),
    (re.compile(r"^/api/stable_table$"), lambda con, m, q: api_stable_table(con, q)),
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
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        if path == "/api/status":
            return self.handle_api(lambda con: api_status(con, q), allow_empty=True)
        if path == "/api/import/progress":
            return self.send_json(job_snapshot())
        if path == "/api/dbs":
            return self.send_json(api_dbs())
        if path == "/api/auto":
            return self.send_json(auto_status())
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
                    for f in ("current.db", "meta.json", "incoming.db", "work.db"):
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
            threading.Thread(target=auto_tick, kwargs={"force": True}, daemon=True).start()
            return self.send_json({"ok": True})
        if path == "/api/desktop/shortcut":
            # put "HRM Viewer" shortcuts on the desktop and in the Start menu (Windows)
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

VERSION = "13.2"
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
        full = next((a for a in assets if re.match(r"^HRM-Viewer-[\d.]+-full\.zip$", a.get("name") or "")), None)
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
        if not v or not upd or not re.match(r"^\d+(\.\d+)*$", v) or version_tuple(v) < version_tuple(GH_OLDEST):
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
    if not os.path.exists(src):
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


def main():
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

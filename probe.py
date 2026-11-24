import importlib.util, os, sqlite3, time, random, threading, shutil
spec = importlib.util.spec_from_file_location("hv", "app.py"); hv = importlib.util.module_from_spec(spec); spec.loader.exec_module(hv)
def log(*a): print(*a, flush=True)
p = os.path.abspath("current.db")
c = sqlite3.connect(p)
c.execute("create table horses (horse_horse_id INTEGER PRIMARY KEY NOT NULL UNIQUE, horse_name text, horse_breed text, horse_color text, horse_rating real, horse_value real, horse_note text)")
c.execute("create table transactions (transaction_transaction_id INTEGER PRIMARY KEY NOT NULL UNIQUE, transaction_from_entity_type text, transaction_to_entity_type text, transaction_date real, transaction_amount real, transaction_type text, transaction_note text)")
r = random.Random(1)
names = ["Polar", "Piece", "Bold", "Garnet", "Rain", "Luna", "Fleet", "Dusky", "Highest", "Candy", "Sierra", "Cay", "Habin", "Saance"]
c.executemany("insert into horses values (?,?,?,?,?,?,?)", ((i, " ".join(r.choice(names) for _ in range(2)), "Thoroughbred", r.choice(["Bay", "Chestnut", "Grey", "Black"]), r.random() * 120, r.random() * 1e7, "Bred by %s Stables" % r.choice(names)) for i in range(1000000)))
c.executemany("insert into transactions values (?,?,?,?,?,?,?)", ((i, "stable", "person", 1.4e9 + i * 60, round(r.random() * 5000, 2), r.choice(["Salary", "Win Share"]), "Win share for %s in %s Stakes" % (r.choice(names), r.choice(names))) for i in range(5000000)))
c.execute("create index tx_date on transactions(transaction_date)")
c.commit(); c.close()
size = os.path.getsize(p); log("size_mb", round(size / 1e6))
shutil.copyfile(p, "copy.db")
t = time.time(); d = hv.disk_compress(os.path.abspath("copy.db")); log("compress_closed_seconds", round(time.time() - t, 1), "disk_mb", round(d / 1e6), "MB/s", round(size / 1e6 / (time.time() - t)))
# background compression while the viewer keeps reading
done = {"n": 0, "max": 0, "err": None}
def worker():
    con = sqlite3.connect(p)
    while not stop.is_set():
        t0 = time.time()
        try:
            x = r.randint(0, 4900000)
            con.execute("select count(*), sum(transaction_amount) from transactions where transaction_date between ? and ?", (1.4e9 + x * 60, 1.4e9 + (x + 50000) * 60)).fetchone()
            con.execute("select * from horses where horse_horse_id=?", (r.randint(1, 999999),)).fetchone()
        except Exception as e:
            done["err"] = repr(e); break
        done["n"] += 1; done["max"] = max(done["max"], time.time() - t0)
    con.close()
stop = threading.Event()
w = threading.Thread(target=worker); w.start(); time.sleep(2); before = done["n"]; time.sleep(3); base_rate = (done["n"] - before) / 3
t = time.time(); th = threading.Thread(target=hv.disk_compress, args=(p,)); th.start()
n0 = done["n"]; time.sleep(1.5)
# replacing the file while Windows is still compressing it
open("incoming.db", "wb").write(b"x" * 1000)
try:
    os.replace("incoming.db", "other.db"); shutil.copyfile("other.db", "incoming.db")
    os.replace("incoming.db", p + ".probe"); log("replace_other_file_during_compress", "ok")
except Exception as e:
    log("replace_other_file_during_compress", repr(e))
th.join(); took = time.time() - t
rate_during = (done["n"] - n0) / took
stop.set(); w.join()
log("compress_open_seconds", round(took, 1), "disk_mb", round(hv.disk_size(p) / 1e6))
log("queries_per_s_before", round(base_rate), "during", round(rate_during), "slowest_query_s", round(done["max"], 2), "error", done["err"])
c = sqlite3.connect(p); log("integrity", c.execute("pragma quick_check").fetchone()[0]); c.close()
# a held-open file being compressed in the background, then replaced by the next load
th = threading.Thread(target=hv.disk_compress, args=(p, False)); th.start(); time.sleep(1)
shutil.copyfile("copy.db", "incoming.db")
try:
    os.replace("incoming.db", p); log("replace_current_during_compress", "ok (no wait needed)")
except Exception as e:
    log("replace_current_during_compress", repr(e)); th.join(); os.replace("incoming.db", p); log("replace_after_wait", "ok")
th.join()

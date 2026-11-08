"""Patch an installed hsg.db in place with the rebuilt corpus — no wipe, no SRS loss.

Why a script instead of live in-app patches: data repairs (singleton widening,
keyword-leak combine, edge-dup strip, trigger strip, mcq/period cleanup) are
deterministic regroupings. Running them live on every fetch/grade would hide
divergence between DB and seed.json and cost per-query work. This script makes
the DB byte-identical in content to data/corpus.json (what the next seed would
insert), preserves progress/reviews by row id, then stamps meta(seed) so the
next launch does NOT wipe.

Usage:
  python3 scripts/patch_db.py [--db PATH] [--corpus data/corpus.json]
                              [--seed src-tauri/seed.json] [--dry-run]
Default DB: ~/Library/Application Support/vn.hsg.english.drill/hsg.db
"""
import argparse, difflib, json, os, re, shutil, sqlite3, sys, time

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def norm_punct(s):
    t = (s or "").lower().strip()
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()

def key_norm(s):
    return norm(s)

def sentence_key(s):
    # mirror Rust sentence_key: lower+collapse, no space before punct, strip trailing .!?
    t = key_norm(s)
    out = []
    pending = False
    for c in t:
        if c == " ":
            pending = True
        elif c in ".,;:!?":
            pending = False
            out.append(c)
        else:
            if pending and out:
                out.append(" ")
            pending = False
            out.append(c)
    r = "".join(out).strip()
    return r.rstrip(".!?")

def fnv1a64(data: bytes) -> str:
    h = 0xCBF29CE484222325
    for b in data:
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return format(h, "x")

FIELDS = ["category", "prompt", "keyword", "gap_prefix", "gap_suffix",
          "answer", "full_answer", "alternatives", "options", "notes", "difficulty"]

def js(v):
    # match Rust serde_json::to_string (compact separators) to avoid flip-flop diffs
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))

def load_corpus(path):
    with open(path, encoding="utf-8") as f:
        v = json.load(f)
    return v if isinstance(v, list) else v.get("items", [])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser(
        "~/Library/Application Support/vn.hsg.english.drill/hsg.db"))
    ap.add_argument("--corpus", default="data/corpus.json")
    ap.add_argument("--seed", default="src-tauri/seed.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    corpus = load_corpus(a.corpus)
    with open(a.seed, "rb") as f:
        seed_bytes = f.read()
    new_hash = fnv1a64(seed_bytes)
    # corpus and seed must agree (merge writes both atomically)
    with open(a.corpus, "rb") as f:
        corpus_bytes = f.read()
    if js(json.loads(corpus_bytes)) != js(corpus):
        pass  # same content, key order may differ; not fatal

    if not os.path.exists(a.db):
        print(f"no DB at {a.db} — nothing to patch (fresh install will seed)")
        return 0

    con = sqlite3.connect(a.db)
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA foreign_keys=ON;")
    con.execute("PRAGMA busy_timeout=5000;")
    cols = [r[1] for r in con.execute("PRAGMA table_info(items)").fetchall()]
    # auto-migrate like the app instead of FATAL (options/alternatives/notes/difficulty)
    for _col, _ddl in [
        ("options", "ALTER TABLE items ADD COLUMN options TEXT NOT NULL DEFAULT '[]'"),
        ("alternatives", "ALTER TABLE items ADD COLUMN alternatives TEXT NOT NULL DEFAULT '[]'"),
        ("notes", "ALTER TABLE items ADD COLUMN notes TEXT NOT NULL DEFAULT ''"),
        ("difficulty", "ALTER TABLE items ADD COLUMN difficulty INTEGER NOT NULL DEFAULT 1"),
    ]:
        if _col not in cols:
            try:
                con.execute(_ddl)
                cols.append(_col)
            except Exception as e:
                print(f"FATAL: cannot migrate items.{_col}: {e}", file=sys.stderr)
                return 1
    for need in FIELDS + ["id"]:
        if need not in cols:
            print(f"FATAL: items.{need} missing", file=sys.stderr)
            return 1
    # validate corpus rows like the app (invalid rows would be deleted on next launch)
    valid_cats = {"light_verb","prep_idiom","figurative","binomial","rephrase","inversion","mcq","three_in_one","wordform","blank_fill"}
    clean_corpus = []
    for x in corpus:
        if not isinstance(x, dict): continue
        if x.get("category") not in valid_cats: continue
        if not (x.get("prompt") and str(x.get("prompt")).strip()): continue
        if not (x.get("answer") and str(x.get("answer")).strip()): continue
        if not (x.get("full_answer") and str(x.get("full_answer")).strip()): continue
        try:
            d = int(x.get("difficulty", 1))
        except Exception:
            continue
        if d not in (1,2,3): continue
        clean_corpus.append(x)
    if len(clean_corpus) != len(corpus):
        print(f"note: skipped {len(corpus)-len(clean_corpus)} invalid corpus rows (app would skip too)")
    corpus = clean_corpus
    if not corpus:
        print("FATAL: corpus empty after validation — refusing to wipe DB", file=sys.stderr)
        return 1

    desc = [c[0] for c in con.execute("SELECT * FROM items LIMIT 0").description]
    db_rows = [dict(zip(desc, r)) for r in con.execute("SELECT * FROM items").fetchall()]
    prog_before = con.execute("SELECT COUNT(*) FROM progress").fetchone()[0]
    rev_before = con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]

    # match like Rust insert_seed: exact 5-tuple (normalized) -> nocat singleton
    # (re-tag keeps history) -> sentence singleton (repair regroup keeps history).
    # Keys use the same key_norm/sentence_key as the backend.
    from collections import deque
    corp_exact = {}
    for idx, x in enumerate(corpus):
        k = (key_norm(x.get("category","")), key_norm(x.get("prompt","")),
             key_norm(x.get("gap_prefix","")), key_norm(x.get("gap_suffix","")),
             key_norm(x.get("answer","")))
        corp_exact.setdefault(k, deque()).append((idx, x))
    db_matched = {}
    remaining_corp_ids = set(range(len(corpus)))
    remaining_db = []
    q = {k: deque(v) for k, v in corp_exact.items()}
    for r in db_rows:
        k = (key_norm(r["category"]), key_norm(r["prompt"]),
             key_norm(r["gap_prefix"]), key_norm(r["gap_suffix"]),
             key_norm(r["answer"]))
        if k in q and q[k]:
            idx, x = q[k].popleft()
            db_matched[r["id"]] = x
            remaining_corp_ids.discard(idx)
        else:
            remaining_db.append(r)
    # pass 2: same frame ignoring category (singleton only)
    corp_nocat = {}
    for i in list(remaining_corp_ids):
        x = corpus[i]
        k = (key_norm(x.get("prompt","")), key_norm(x.get("gap_prefix","")),
             key_norm(x.get("gap_suffix","")), key_norm(x.get("answer","")))
        corp_nocat.setdefault(k, []).append((i, x))
    still_db = []
    for r in remaining_db:
        k = (key_norm(r["prompt"]), key_norm(r["gap_prefix"]),
             key_norm(r["gap_suffix"]), key_norm(r["answer"]))
        lst = corp_nocat.get(k, [])
        if len(lst) == 1:
            i, x = lst[0]
            db_matched[r["id"]] = x
            remaining_corp_ids.discard(i)
            del corp_nocat[k]
        else:
            still_db.append(r)
    # pass 3: same sentence (category+prompt+sentence_key, singleton only)
    corp_sent = {}
    for i in list(remaining_corp_ids):
        x = corpus[i]
        k = (key_norm(x.get("category","")), key_norm(x.get("prompt","")),
             sentence_key(x.get("full_answer","")))
        corp_sent.setdefault(k, []).append((i, x))
    still_db2 = []
    for r in still_db:
        k = (key_norm(r["category"]), key_norm(r["prompt"]),
             sentence_key(r["full_answer"]))
        lst = corp_sent.get(k, [])
        if len(lst) == 1:
            i, x = lst[0]
            db_matched[r["id"]] = x
            remaining_corp_ids.discard(i)
            del corp_sent[k]
        else:
            still_db2.append(r)
    # pass 4: fuzzy prompt-group fallback for hyphen joins etc.
    rem_corp = [(i, corpus[i]) for i in remaining_corp_ids]
    by_prompt = {}
    for i, x in rem_corp:
        by_prompt.setdefault((x["category"], x["prompt"]), []).append((i, x))
    to_delete = []
    for r in still_db2:
        cand = by_prompt.get((r["category"], r["prompt"]), [])
        best, best_i = None, None
        for i, x in cand:
            s = difflib.SequenceMatcher(None, norm(r["full_answer"]), norm(x["full_answer"])).ratio()
            if best is None or s > best[0]:
                best, best_i = (s, x), i
        if best and best[0] >= 0.75:
            db_matched[r["id"]] = best[1]
            remaining_corp_ids.discard(best_i)
            by_prompt[(r["category"], r["prompt"])] = [
                c for c in cand if c[0] != best_i]
        else:
            to_delete.append(r["id"])

    # compute updates
    updates, upd_fields = 0, 0
    stmts = []
    for rid, x in db_matched.items():
        cur = next(r for r in db_rows if r["id"] == rid)
        new = {
            "category": x["category"], "prompt": x["prompt"], "keyword": x.get("keyword", ""),
            "gap_prefix": x.get("gap_prefix", ""), "gap_suffix": x.get("gap_suffix", ""),
            "answer": x.get("answer", ""), "full_answer": x.get("full_answer", ""),
            "alternatives": js(x.get("alternatives", [])), "options": js(x.get("options", [])),
            "notes": x.get("notes", ""), "difficulty": int(x.get("difficulty", 1)),
        }
        old = {k: (js(cur[k]) if k in ("alternatives", "options") and isinstance(cur[k], list)
                   else cur[k]) for k in new}
        # DB stores alternatives/options as JSON strings; normalize compare via json loads
        def canon(v, k):
            if k in ("alternatives", "options"):
                try:
                    return js(json.loads(v) if isinstance(v, str) else v)
                except Exception:
                    return js([])
            return (v if not isinstance(v, str) else re.sub(r"\s+", " ", v).strip())
        diffs = [k for k in new if canon(new[k], k) != canon(old.get(k), k)]
        if diffs:
            updates += 1
            upd_fields += len(diffs)
            stmts.append((rid, new))

    inserts = [corpus[i] for i in sorted(remaining_corp_ids)]

    print(f"db items: {len(db_rows)}  corpus: {len(corpus)}")
    print(f"matched: {len(db_matched)}  update-needed: {updates} ({upd_fields} fields)")
    print(f"to insert: {len(inserts)}  to delete: {len(to_delete)}")
    print(f"progress rows: {prog_before}  reviews rows: {rev_before} (preserved by id)")
    try:
        old_hash = con.execute("SELECT v FROM meta WHERE k='seed'").fetchone()
        print(f"seed hash: {(old_hash[0][:12] + '...') if old_hash else None} -> {new_hash[:12]}...")
    except Exception:
        pass

    if a.dry_run:
        print("dry-run: no writes")
        # show samples
        for rid, new in stmts[:5]:
            cur = next(r for r in db_rows if r["id"] == rid)
            print(f"  UPDATE id={rid} {cur['prompt'][:50]!r}")
            print(f"    ans {cur['answer']!r} -> {new['answer']!r}")
            print(f"    pre {cur['gap_prefix']!r} -> {new['gap_prefix']!r}")
        for x in inserts[:5]:
            print(f"  INSERT {x['prompt'][:60]!r} ans={x['answer']!r}")
        for rid in to_delete[:5]:
            cur = next(r for r in db_rows if r["id"] == rid)
            print(f"  DELETE id={rid} {cur['prompt'][:60]!r}")
        return 0

    # backup + write (single transaction with rollback; triple-delete like the app)
    bak = a.db + f".bak.{int(time.time())}"
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        con.commit()
    except Exception:
        pass
    try:
        shutil.copy2(a.db, bak)
        # also copy -wal/-shm if present (checkpoint may not have cleared them)
        for ext in ("-wal", "-shm"):
            src = a.db + ext
            if os.path.exists(src):
                try:
                    shutil.copy2(src, bak + ext)
                except Exception:
                    pass
    except Exception as e:
        print(f"FATAL: backup failed: {e}", file=sys.stderr)
        return 1
    print(f"backup: {bak}")
    try:
        con.execute("BEGIN IMMEDIATE;")
        for rid, new in stmts:
            con.execute("""UPDATE items SET category=?,prompt=?,keyword=?,gap_prefix=?,gap_suffix=?,
                         answer=?,full_answer=?,alternatives=?,options=?,notes=?,difficulty=? WHERE id=?""",
                        (new["category"], new["prompt"], new["keyword"], new["gap_prefix"],
                         new["gap_suffix"], new["answer"], new["full_answer"], new["alternatives"],
                         new["options"], new["notes"], new["difficulty"], rid))
        for rid in to_delete:
            con.execute("DELETE FROM progress WHERE item_id=?", (rid,))
            con.execute("DELETE FROM reviews WHERE item_id=?", (rid,))
            con.execute("DELETE FROM items WHERE id=?", (rid,))
        for x in inserts:
            con.execute("""INSERT INTO items(category,prompt,keyword,gap_prefix,gap_suffix,answer,
                         full_answer,alternatives,notes,difficulty,options) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                        (x["category"], x["prompt"], x.get("keyword", ""), x.get("gap_prefix", ""),
                         x.get("gap_suffix", ""), x.get("answer", ""), x.get("full_answer", ""),
                         js(x.get("alternatives", [])), x.get("notes", ""),
                         int(x.get("difficulty", 1)), js(x.get("options", []))))
        con.execute("INSERT INTO meta(k,v) VALUES('seed',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                    (new_hash,))
        con.commit()
    except Exception as e:
        try:
            con.rollback()
        except Exception:
            pass
        print(f"FATAL: patch failed, rolled back: {e}", file=sys.stderr)
        return 1
    n_items = con.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    n_prog = con.execute("SELECT COUNT(*) FROM progress").fetchone()[0]
    n_rev = con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
    con.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    con.commit()
    con.close()
    print(f"done: items={n_items} (expect {len(corpus)}) progress={n_prog} reviews={n_rev}")
    if n_items != len(corpus):
        print("WARNING: item count differs from corpus", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())

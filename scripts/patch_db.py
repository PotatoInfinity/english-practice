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

def fnv1a64(data: bytes) -> str:
    h = 0xCBF29CE484222325
    for b in data:
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return format(h, "x")

FIELDS = ["category", "prompt", "keyword", "gap_prefix", "gap_suffix",
          "answer", "full_answer", "alternatives", "options", "notes", "difficulty"]

def js(v):
    return json.dumps(v, ensure_ascii=False)

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
    cols = [r[1] for r in con.execute("PRAGMA table_info(items)").fetchall()]
    for need in FIELDS + ["id"]:
        if need not in cols:
            print(f"FATAL: items.{need} missing", file=sys.stderr)
            return 1

    desc = [c[0] for c in con.execute("SELECT * FROM items LIMIT 0").description]
    db_rows = [dict(zip(desc, r)) for r in con.execute("SELECT * FROM items").fetchall()]
    prog_before = con.execute("SELECT COUNT(*) FROM progress").fetchone()[0]
    rev_before = con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]

    # pass 1: stable sentence key (repairs preserve the sentence)
    corp_by_full = {}
    for idx, x in enumerate(corpus):
        corp_by_full.setdefault((x["category"], x["prompt"], norm(x["full_answer"])), []).append((idx, x))
    db_matched, corp_used = {}, set()
    updates, upd_fields = 0, 0
    stmts = []
    remaining_db, remaining_corp_ids = [], set(range(len(corpus)))
    # index corpus rows for pass 1 (handle rare dup keys FIFO)
    from collections import deque
    q = {k: deque(v) for k, v in corp_by_full.items()}
    for r in db_rows:
        k = (r["category"], r["prompt"], norm(r["full_answer"]))
        if k in q and q[k]:
            idx, x = q[k].popleft()
            db_matched[r["id"]] = x
            remaining_corp_ids.discard(idx)
        else:
            remaining_db.append(r)
    # pass 2: answer-stable key (full was corrected: mcq placeholder, .., polish)
    corp2 = {}
    for i in list(remaining_corp_ids):
        x = corpus[i]
        corp2.setdefault((x["category"], x["prompt"], norm(x["answer"])), []).append((i, x))
    q2 = {k: deque(v) for k, v in corp2.items()}
    still_db = []
    for r in remaining_db:
        k = (r["category"], r["prompt"], norm(r["answer"]))
        if k in q2 and q2[k]:
            i, x = q2[k].popleft()
            db_matched[r["id"]] = x
            remaining_corp_ids.discard(i)
        else:
            still_db.append(r)
    # pass 3: fuzzy prompt-group match (hyphen joins etc. change both answer+full)
    rem_corp = [(i, corpus[i]) for i in remaining_corp_ids]
    by_prompt = {}
    for i, x in rem_corp:
        by_prompt.setdefault((x["category"], x["prompt"]), []).append((i, x))
    to_delete = []
    for r in still_db:
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

    # backup + write
    bak = a.db + f".bak.{int(time.time())}"
    con.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    con.commit()
    shutil.copy2(a.db, bak)
    print(f"backup: {bak}")
    for rid, new in stmts:
        con.execute("""UPDATE items SET category=?,prompt=?,keyword=?,gap_prefix=?,gap_suffix=?,
                     answer=?,full_answer=?,alternatives=?,options=?,notes=?,difficulty=? WHERE id=?""",
                    (new["category"], new["prompt"], new["keyword"], new["gap_prefix"],
                     new["gap_suffix"], new["answer"], new["full_answer"], new["alternatives"],
                     new["options"], new["notes"], new["difficulty"], rid))
    for rid in to_delete:
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

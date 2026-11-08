"""Robust merge for HSG drill corpus.
Run: python3 scripts/merge.py
Reads data/part-*.json + data/extra-*.json (array, {items:[...]}, or JSONL).
Writes atomically: data/corpus.json + src-tauri/seed.json, quarantine to data/quarantine.json.
Combination rules: schema validation -> canonicalization -> repair -> exact dedup ->
token-bag near-dup -> gap-conflict quarantine -> deterministic sort.
Exit non-zero on structural failure; prints report.
"""
import json, glob, re, os, sys
from collections import Counter

VALID_CATS = {"light_verb", "prep_idiom", "figurative", "binomial", "rephrase", "inversion"}
PREPS = {"of", "with", "to", "for", "in", "on", "above", "about", "after", "against",
         "among", "around", "at", "before", "behind", "below", "beneath", "beside",
         "between", "beyond", "by", "despite", "down", "during", "except", "from",
         "into", "like", "near", "off", "out", "over", "past", "since", "through",
         "toward", "towards", "under", "until", "up", "upon", "within", "without",
         "that", "which", "who", "when", "where", "and", "or", "than", "as"}
AUX = {"had", "have", "has", "did", "does", "do", "was", "were", "is", "are",
       "will", "would", "should", "could", "can", "may", "might", "must"}

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def load_file(path):
    """Tolerant loader: JSON array | {items:[...]} | JSONL. Returns (items, error)."""
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
    except OSError as e:
        return [], f"unreadable: {e}"
    try:
        v = json.loads(txt)
        if isinstance(v, list):
            return v, None
        if isinstance(v, dict) and isinstance(v.get("items"), list):
            return v["items"], None
        return [], "top-level JSON is not array nor {items:[]}"
    except json.JSONDecodeError:
        pass
    rows, bad = [], 0
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            rows.append(r)
        except json.JSONDecodeError:
            bad += 1
    if rows:
        return rows, (f"{bad} bad JSONL lines" if bad else None)
    return [], "unparseable as JSON or JSONL"

def validate(e):
    """Returns list of fatal reasons (empty = ok)."""
    if not isinstance(e, dict):
        return ["not an object"]
    reasons = []
    if e.get("category") not in VALID_CATS:
        reasons.append(f"bad category {e.get('category')!r}")
    for f in ("prompt", "answer", "full_answer"):
        if not isinstance(e.get(f), str) or not e.get(f).strip():
            reasons.append(f"empty {f}")
    for f in ("gap_prefix", "gap_suffix"):
        if not isinstance(e.get(f), str):
            reasons.append(f"{f} not a string")
    alts = e.get("alternatives", [])
    if not isinstance(alts, list) or any(not isinstance(a, str) for a in alts):
        reasons.append("alternatives malformed")
    if not isinstance(e.get("difficulty", 1), int):
        reasons.append("difficulty not int")
    return reasons

def canon(e):
    """Canonicalize whitespace/case/difficulty/alternatives."""
    try:
        diff = int(e.get("difficulty") or 1)
    except (TypeError, ValueError):
        diff = 1
    alts = sorted({re.sub(r"\s+", " ", a).strip() for a in (e.get("alternatives") or []) if a and a.strip()})
    ans = re.sub(r"\s+", " ", e["answer"]).strip()
    alts = [a for a in alts if norm(a) != norm(ans)]
    kw = re.sub(r"\s+", " ", (e.get("keyword") or "")).strip()
    if not kw:
        # derive from exam-style "(WORD)" bracket in prompt, else answer head word
        m = re.search(r"\(([A-Za-z' -]{1,30})\)\s*[.?]?\s*$", (e.get("prompt") or "").strip())
        kw = m.group(1).strip() if m else ans.split(" ")[0]
    return {
        "category": e["category"],
        "prompt": re.sub(r"\s+", " ", e["prompt"]).strip(),
        "keyword": kw,
        "gap_prefix": re.sub(r"\s+", " ", e.get("gap_prefix") or "").strip(),
        "gap_suffix": re.sub(r"\s+", " ", e.get("gap_suffix") or "").strip(),
        "answer": ans,
        "full_answer": re.sub(r"\s+", " ", e["full_answer"]).strip(),
        "alternatives": alts,
        "notes": re.sub(r"\s+", " ", e.get("notes") or "").strip(),
        "difficulty": max(1, min(3, diff)),
    }

def warn(e):
    """Non-fatal per-category sanity warnings."""
    w = []
    cat = e["category"]
    if cat == "binomial" and len(e["answer"].split()) > 3:
        w.append("binomial answer unusually long")
    if cat == "inversion":
        combined = norm(e["gap_prefix"] + " " + e["answer"]).split(" ")
        if not any(t in AUX for t in combined[:6]):
            w.append("inversion frame lacks auxiliary (check word order)")
    if norm(e["keyword"]) not in norm(e["full_answer"]) and norm(e["keyword"]) not in norm(e["answer"]):
        w.append("keyword appears in neither answer nor full (pun-style ok)")
    return w

def main():
    files = sorted(glob.glob("data/part-*.json") + glob.glob("data/extra-*.json"))
    if not files:
        print("FATAL: no input files", file=sys.stderr)
        sys.exit(1)
    raw, quarantine, stats = [], [], Counter()
    for f in files:
        rows, err = load_file(f)
        stats[f] = len(rows)
        if err:
            quarantine.append({"file": f, "entry": None, "reasons": [err]})
        for i, r in enumerate(rows):
            bad = validate(r) if isinstance(r, dict) else ["not an object"]
            if bad:
                quarantine.append({"file": f, "index": i, "entry": r, "reasons": bad})
                stats["invalid"] += 1
                continue
            e = canon(r)
            # repair 1: prep formal-phrase with empty affixes -> split full on answer
            if e["category"] == "prep_idiom" and not e["gap_prefix"] and not e["gap_suffix"]:
                fl, al = e["full_answer"].lower(), e["answer"].lower()
                if fl.startswith(al):
                    e["gap_suffix"] = e["full_answer"][len(e["answer"]):].strip()
                    stats["repaired_affix"] += 1
            # repair 2: binomial leftover-word suffix -> sentence ends at binomial
            if e["category"] == "binomial" and e["gap_suffix"] not in ("", "."):
                first = norm(e["gap_suffix"]).split(" ")[0].rstrip(",.")
                if first not in PREPS and not e["gap_suffix"].startswith(","):
                    e["gap_suffix"] = "."
                    e["full_answer"] = (e["gap_prefix"] + " " + e["answer"] + ".").strip()
                    stats["repaired_binomial"] += 1
            if e["full_answer"] and e["full_answer"][-1].isalnum():
                e["full_answer"] += "."
            for x in warn(e):
                stats["warn:" + x] += 1
            raw.append((f, i, e))

    # dedup 1: exact normalized gap triple
    seen_exact, uniq = set(), []
    for f, i, e in raw:
        k = (e["category"], norm(e["gap_prefix"]), norm(e["answer"]), norm(e["gap_suffix"]))
        if k in seen_exact:
            quarantine.append({"file": f, "index": i, "entry": e, "reasons": ["exact duplicate"]})
            stats["dup_exact"] += 1
            continue
        seen_exact.add(k)
        uniq.append((f, i, e))
    # dedup 2: token-bag near-duplicate within category (catches reworded dupes)
    seen_bag, deduped = set(), []
    for f, i, e in uniq:
        bag = (e["category"], tuple(sorted(norm(e["full_answer"]).split())))
        if bag in seen_bag:
            quarantine.append({"file": f, "index": i, "entry": e, "reasons": ["near duplicate (same token bag)"]})
            stats["dup_near"] += 1
            continue
        seen_bag.add(bag)
        deduped.append((f, i, e))
    # conflict: same prompt AND same gap frame, different answer -> keep first, quarantine rest
    # (prompt is in the key: shared triggers like "Hardly ___" across items are legitimate)
    seen_gap, out = {}, []
    for f, i, e in deduped:
        gk = (e["category"], norm(e["prompt"]), norm(e["gap_prefix"]), norm(e["gap_suffix"]))
        if gk in seen_gap and norm(seen_gap[gk]["answer"]) != norm(e["answer"]):
            quarantine.append({"file": f, "index": i, "entry": e,
                               "reasons": [f"gap conflict: kept {seen_gap[gk]['answer']!r}"]})
            stats["conflict"] += 1
            continue
        seen_gap.setdefault(gk, e)
        out.append(e)

    out.sort(key=lambda e: (e["category"], norm(e["full_answer"])))
    os.makedirs("data", exist_ok=True)
    for path, payload in (("data/corpus.json", out),
                          ("src-tauri/seed.json", out),
                          ("data/quarantine.json", quarantine)):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)  # atomic

    print(f"inputs: {len(files)} files, raw rows: {sum(v for k, v in stats.items() if k.endswith('.json'))}")
    print(f"final: {len(out)}  quarantined: {len(quarantine)}")
    print("by_category:", dict(Counter(e['category'] for e in out)))
    print("stats:", {k: v for k, v in sorted(stats.items()) if not k.endswith(".json")})

if __name__ == "__main__":
    main()

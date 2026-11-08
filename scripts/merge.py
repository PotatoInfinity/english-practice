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

VALID_CATS = {"light_verb", "prep_idiom", "figurative", "binomial", "rephrase", "inversion",
              "mcq", "three_in_one", "wordform", "blank_fill"}
PREPS = {"of", "with", "to", "for", "in", "on", "above", "about", "after", "against",
         "among", "around", "at", "before", "behind", "below", "beneath", "beside",
         "between", "beyond", "by", "despite", "down", "during", "except", "from",
         "into", "like", "near", "off", "out", "over", "past", "since", "through",
         "toward", "towards", "under", "until", "up", "upon", "within", "without",
         "that", "which", "who", "when", "where", "and", "or", "than", "as"}
# absorbable collocate edges for keyword-gap widening (articles, prepositions, "to")
FUNC_CW = {"a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "from",
           "by", "about", "into", "over", "after", "before", "between", "through",
           "during", "against", "among", "around", "off", "out", "away", "along",
           "across", "behind", "beyond", "upon", "under", "without", "within",
           "toward", "towards", "plus", "except"}
AUX = {"had", "have", "has", "did", "does", "do", "was", "were", "is", "are",
       "will", "would", "should", "could", "can", "may", "might", "must"}

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

# irregular verb families for keyword-leak detection (bore==bear, took==take, ...)
# base -> all known forms; reverse index built below.
IRREG = {
    "bear": {"bear", "bears", "bore", "borne", "bearing"},
    "take": {"take", "takes", "took", "taken", "taking"},
    "go": {"go", "goes", "went", "gone", "going"},
    "come": {"come", "comes", "came", "coming"},
    "get": {"get", "gets", "got", "gotten", "getting"},
    "put": {"put", "puts", "putting"},
    "set": {"set", "sets", "setting"},
    "stand": {"stand", "stands", "stood", "standing"},
    "steal": {"steal", "steals", "stole", "stolen", "stealing"},
    "choose": {"choose", "chooses", "chose", "chosen", "choosing"}
    ,
    "speak": {"speak", "speaks", "spoke", "spoken", "speaking"}
    ,
    "write": {"write", "writes", "wrote", "written", "writing"}
    ,
    "drive": {"drive", "drives", "drove", "driven", "driving"}
    ,
    "drink": {"drink", "drinks", "drank", "drunk", "drinking"}
    ,
    "sing": {"sing", "sings", "sang", "sung", "singing"}
    ,
    "swim": {"swim", "swims", "swam", "swum", "swimming"}
    ,
    "begin": {"begin", "begins", "began", "begun", "beginning"}
    ,
    "break": {"break", "breaks", "broke", "broken", "breaking"}
    ,
    "do": {"do", "does", "did", "done", "doing"}
    ,
    "have": {"have", "has", "had", "having"}
    ,
    "be": {"be", "am", "is", "are", "was", "were", "been", "being"}
    ,
    "teach": {"teach", "teaches", "taught", "teaching"}
    ,
    "catch": {"catch", "catches", "caught", "catching"}
    ,
    "buy": {"buy", "buys", "bought", "buying"}
    ,
    "bring": {"bring", "brings", "brought", "bringing"}
    ,
    "think": {"think", "thinks", "thought", "thinking"}
    ,
    "seek": {"seek", "seeks", "sought", "seeking"}
    ,
    "send": {"send", "sends", "sent", "sending"}
    ,
    "spend": {"spend", "spends", "spent", "spending"}
    ,
    "build": {"build", "builds", "built", "building"}
    ,
    "sleep": {"sleep", "sleeps", "slept", "sleeping"}
    ,
    "shoot": {"shoot", "shoots", "shot", "shooting"}
    ,
    "hide": {"hide", "hides", "hid", "hidden", "hiding"}
    ,
    "shake": {"shake", "shakes", "shook", "shaken", "shaking"}
    ,
    "draw": {"draw", "draws", "drew", "drawn", "drawing"}
    ,
    "grow": {"grow", "grows", "grew", "grown", "growing"}
    ,
    "throw": {"throw", "throws", "threw", "thrown", "throwing"}
    ,
    "blow": {"blow", "blows", "blew", "blown", "blowing"}
    ,
    "eat": {"eat", "eats", "ate", "eaten", "eating"}
    ,
    "fall": {"fall", "falls", "fell", "fallen", "falling"}
    ,
    "give": {"give", "gives", "gave", "given", "giving"}
    ,
    "know": {"know", "knows", "knew", "known", "knowing"}
    ,
    "see": {"see", "sees", "saw", "seen", "seeing"}
    ,
    "run": {"run", "runs", "ran", "running"}
    ,
    "sit": {"sit", "sits", "sat", "sitting"}
    ,
    "win": {"win", "wins", "won", "winning"}
    ,
    "hold": {"hold", "holds", "held", "holding"}
    ,
    "find": {"find", "finds", "found", "finding"}
    ,
    "make": {"make", "makes", "made", "making"}
    ,
    "say": {"say", "says", "said", "saying"}
    ,
    "pay": {"pay", "pays", "paid", "paying"}
    ,
    "hear": {"hear", "hears", "heard", "hearing"}
    ,
    "keep": {"keep", "keeps", "kept", "keeping"}
    ,
    "leave": {"leave", "leaves", "left", "leaving"}
    ,
    "lose": {"lose", "loses", "lost", "losing"}
    ,
    "meet": {"meet", "meets", "met", "meeting"}
    ,
    "pull": {"pull", "pulls", "pulled", "pulling"}
    ,
    "twist": {"twist", "twists", "twisted", "twisting"}
    ,
    "drop": {"drop", "drops", "dropped", "dropping"}
    ,
    "cast": {"cast", "casts", "casting"}
    ,
    "cut": {"cut", "cuts", "cutting"}
    ,
    "hit": {"hit", "hits", "hitting"}
    ,
    "hurt": {"hurt", "hurts", "hurting"}
    ,
    "shut": {"shut", "shuts", "shutting"}
    ,
    "burst": {"burst", "bursts", "bursting"}
    ,
}
_FORM2BASE = {}
for _b, _fs in IRREG.items():
    for _f in _fs:
        _FORM2BASE[_f] = _b

def _base(w):
    w = (w or "").lower().strip(".,;:!?\"'()")
    if not w:
        return w
    if w in _FORM2BASE:
        return _FORM2BASE[w]
    # regular suffixes: -ies -> y, -es, -s, -ing, -ed/-d
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith(("ches", "shes", "sses", "xes", "zes", "oes")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        # puts->put, stands->stand (keep e-drop/doubling out: stem-only)
        return w[:-1]
    if len(w) > 5 and w.endswith("ing"):
        st = w[:-3]
        # doubling: running->run, putting->put
        if len(st) > 3 and st[-1] == st[-2]:
            st = st[:-1]
        return st
    if len(w) > 4 and w.endswith("ed"):
        st = w[:-2]
        if len(st) > 3 and st[-1] == st[-2]:
            st = st[:-1]
        return st
    if len(w) > 4 and w.endswith("d") and w.endswith("e"):
        return w  # keep; e-drop handled by equality below
    return w

def same_lemma(a, b):
    """True when two single words are the same lexeme (bore==bear, puts==put)."""
    if not a or not b:
        return False
    na, nb = a.lower(), b.lower()
    if na == nb:
        return True
    if len(na) < 2 or len(nb) < 2:
        return False
    if na in _FORM2BASE and nb in _FORM2BASE and _FORM2BASE[na] == _FORM2BASE[nb]:
        return True
    ba, bb = _base(na), _base(nb)
    if ba == bb and len(ba) >= 3:
        return True
    # e-drop: making==make, taking==take
    if ba + "e" == bb or bb + "e" == ba:
        return True
    return False

def word_tokens(s):
    return [t.strip(".,;:!?\"'()") for t in (s or "").split()]

def clean_word(t):
    return (t or "").strip(".,;:!?\"'()")

def ans_word(t):
    """Form answer tokens: keep intra-phrase , ; : (preserves sentence identity),
    strip only sentence-final . ! ? (re-added to full_answer)."""
    t = (t or "").strip()
    return re.sub(r"[.!?]+$", "", t)

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
    opts = e.get("options", [])
    if opts is not None and (not isinstance(opts, list) or any(not isinstance(a, str) for a in opts)):
        reasons.append("options malformed")
    if e.get("category") == "mcq":
        clean = [re.sub(r"\s+", " ", a).strip() for a in (opts or []) if a and a.strip()]
        if len(clean) != 4:
            reasons.append("mcq needs exactly 4 options")
        elif norm(e.get("answer", "")) not in [norm(a) for a in clean]:
            reasons.append("mcq answer matches no option")
    if e.get("category") == "three_in_one":
        clean = [re.sub(r"\s+", " ", a).strip() for a in (opts or []) if a and a.strip()]
        if len(clean) != 3 or not all("____" in a for a in clean):
            reasons.append("three_in_one needs 3 sentences with ____")
    if e.get("category") == "inversion" and len(str(e.get("answer", "")).split()) < 3:
        reasons.append("fragment answer (<3 tokens)")
    if not isinstance(e.get("difficulty", 1), int):
        reasons.append("difficulty not int")
    return reasons

def derive_full(r):
    """Synthesize full_answer for types whose spec omits it (mcq, three_in_one)."""
    if r.get("full_answer") and str(r["full_answer"]).strip():
        return r
    cat, ans = r.get("category"), re.sub(r"\s+", " ", str(r.get("answer", ""))).strip()
    if not ans:
        return r
    if cat == "mcq":
        pre = re.sub(r"\s+", " ", str(r.get("gap_prefix", ""))).strip()
        suf = re.sub(r"\s+", " ", str(r.get("gap_suffix", ""))).strip()
        r["full_answer"] = (pre + " " + ans + " " + suf).strip()
        if r["full_answer"] in ("", ans):
            p = re.sub(r"\s+", " ", str(r.get("prompt", ""))).strip()
            r["full_answer"] = p.replace("____", ans) if "____" in p else (p + " " + ans).strip()
    elif cat == "three_in_one":
        opts = [re.sub(r"\s+", " ", a).strip() for a in (r.get("options") or []) if a and a.strip()]
        r["full_answer"] = " / ".join(s.replace("____", ans.upper()) for s in opts[:3]) if opts else ans
    return r

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
        "options": list(dict.fromkeys(re.sub(r"\s+", " ", a).strip() for a in (e.get("options") or []) if a and a.strip())),
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
    # purge lists load once (matched on pre-repair prompt+answer so repaired
    # rows cannot evade their auditor flag by renaming the answer)
    purged_keys = set()
    for pf in sorted(glob.glob("data/purge-*.json")):
        try:
            rows, err = load_file(pf)
        except Exception:
            continue
        if err:
            print(f"purge list {pf}: {err}")
            continue
        for r in rows:
            if isinstance(r, dict) and r.get("prompt") and r.get("answer"):
                purged_keys.add((norm(r["prompt"]), norm(r["answer"])))
    raw, quarantine, stats = [], [], Counter()
    for f in files:
        rows, err = load_file(f)
        stats[f] = len(rows)
        if err:
            quarantine.append({"file": f, "entry": None, "reasons": [err]})
        for i, r in enumerate(rows):
            r = derive_full(r) if isinstance(r, dict) else r
            if isinstance(r, dict) and (norm(r.get("prompt", "")), norm(r.get("answer", ""))) in purged_keys:
                quarantine.append({"file": f, "index": i, "entry": r, "reasons": ["purged: auditor-flagged trivial"]})
                stats["purged"] += 1
                continue
            bad = validate(r) if isinstance(r, dict) else ["not an object"]
            if bad:
                quarantine.append({"file": f, "index": i, "entry": r, "reasons": bad})
                stats["invalid"] += 1
                continue
            e = canon(r)
            # repair 0: answer must not start with a conjunction ("and parcel") -
            # the conjunction belongs to the frame ("part and ___")
            na0 = norm(e.get("answer", "")).split(" ")
            if len(na0) > 1 and na0[0] in ("and", "or", "nor", "but"):
                e["gap_prefix"] = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + na0[0])).strip()
                e["answer"] = re.sub(r"\s+", " ", " ".join(e["answer"].split(" ")[1:])).strip()
                e["full_answer"] = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                if e["full_answer"] and e["full_answer"][-1].isalnum():
                    e["full_answer"] += "."
                stats["repaired_lead_conj"] += 1
            # repair 2: binomial leftover-word suffix -> sentence ends at binomial
            if e["category"] == "binomial" and e["gap_suffix"] not in ("", "."):
                first = norm(e["gap_suffix"]).split(" ")[0].rstrip(",.")
                if first not in PREPS and not e["gap_suffix"].startswith(","):
                    e["gap_suffix"] = "."
                    e["full_answer"] = (e["gap_prefix"] + " " + e["answer"] + ".").strip()
                    stats["repaired_binomial"] += 1
            # repair 3: duplicated trigger word across prefix/answer boundary.
            # Generalised from "Not until" to all fronted triggers (Only after/by,
            # Only if/when, Not until, etc.): "Only after" + "after ..." -> strip.
            _TRIG = {"until", "after", "by", "if", "when", "in", "then", "through", "with", "on", "as"}
            _pre_last = norm(e["gap_prefix"]).split(" ")[-1:] if norm(e["gap_prefix"]) else []
            if _pre_last and _pre_last[0].rstrip(",.") in _TRIG:
                _tw = _pre_last[0].rstrip(",.")
                if norm(e["answer"]).startswith(_tw + " "):
                    e["answer"] = e["answer"].strip()[len(_tw):].strip()
                    e["full_answer"] = (e["gap_prefix"] + " " + e["answer"] + (" " + e["gap_suffix"] if e["gap_suffix"] not in ("", ".") else "")).strip()
                    stats["repaired_dup_trigger"] += 1
            if e["full_answer"] and e["full_answer"][-1].isalnum():
                e["full_answer"] += "."
            # repair 4: keyword (or its inflected form: bore==BEAR) leaked into the
            # frame while the answer lacks it. Combine the leak with the answer so
            # the user must produce the keyword form ("He still bore a" + "grudge
            # against" -> "He still" + "bore a grudge against"). Mid-frame only,
            # wordform exempt by design (Choosing/choice is intentional).
            if e["category"] not in ("inversion", "mcq", "three_in_one", "wordform"):
                kw = (e.get("keyword") or "").strip()
                ans_toks4 = [clean_word(t).lower() for t in e["answer"].split() if clean_word(t)]
                kw_leaked = bool(kw) and not any(same_lemma(t, kw) for t in ans_toks4 if t)
                if kw_leaked:
                    for side in ("gap_prefix", "gap_suffix"):
                        found = None
                        for m4 in re.finditer(r"[A-Za-z']+", e[side]):
                            if same_lemma(m4.group(0), kw):
                                found = m4
                                break
                        if not found:
                            continue
                        before, hit, after = e[side][:found.start()], found.group(0), e[side][found.end():]
                        if not before.strip() and not after.strip():
                            break  # isolated trigger position: leave alone
                        old_full4 = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                        orig4 = (e["gap_prefix"], e["answer"], e["gap_suffix"])
                        if side == "gap_prefix":
                            new_pre = before
                            new_ans = (hit + " " + after + " " + e["answer"])
                            new_suf = e["gap_suffix"]
                        else:
                            new_pre = e["gap_prefix"]
                            new_ans = (e["answer"] + " " + before + " " + hit)
                            new_suf = after
                        new_ans = re.sub(r"\s+", " ", new_ans).strip()
                        # cap runaway length: keep answers <= 6 words, else single-hit fallback
                        if len(new_ans.split()) > 6:
                            if side == "gap_prefix":
                                new_ans2 = hit
                                new_suf2 = (after + " " + e["answer"] + " " + e["gap_suffix"])
                                new_pre2 = before
                            else:
                                new_ans2 = hit
                                new_pre2 = (e["gap_prefix"] + " " + e["answer"] + " " + before)
                                new_suf2 = after
                            new_pre, new_ans, new_suf = new_pre2, new_ans2, new_suf2
                        else:
                            new_pre = re.sub(r"\s+", " ", new_pre).strip()
                            new_suf = re.sub(r"\s+", " ", new_suf).strip()
                        e["gap_prefix"] = re.sub(r"\s+", " ", new_pre).strip()
                        e["answer"] = re.sub(r"\s+", " ", new_ans).strip()
                        e["gap_suffix"] = re.sub(r"\s+", " ", new_suf).strip()
                        new_full4 = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                        def _pol(s):
                            return re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\s+", " ", s).strip())
                        if norm(_pol(new_full4)) == norm(_pol(old_full4)):
                            e["full_answer"] = new_full4
                            if e["full_answer"] and e["full_answer"][-1].isalnum():
                                e["full_answer"] += "."
                            stats["repaired_kw_gap"] += 1
                            break
                        else:
                            e["gap_prefix"], e["answer"], e["gap_suffix"] = orig4
                            continue
            # repair 6 (user rule): the answer must never be just the bracket word.
            # If single-word answer == keyword (lemma-equal: date==date, bore==BEAR):
            # - gap after 0-1 words  -> take next 2 words from suffix ("They set a" + date + "for the wedding" -> "a date for")
            # - gap before 0-1 words (or end) -> take prev 2 words from prefix
            # - middle -> take 1 before + keyword + 1 after.
            # Pure regrouping: bail unless the sentence is identical after.
            CONJ = {"and", "or", "nor", "but", "yet", "so"}
            if e["category"] not in ("inversion", "mcq", "three_in_one"):
                kw6 = (e.get("keyword") or "").strip()
                ans6 = (e.get("answer") or "").strip()
                ans_toks = [t for t in ans6.split() if clean_word(t)]
                # hyphen split: "bushy-" + "tailed" -> "bushy-tailed" (one word, harder)
                if kw6 and len(ans_toks) == 1 and same_lemma(ans_toks[0], kw6):
                    if e["gap_prefix"].endswith("-") and ans6 and re.fullmatch(r"[A-Za-z']+", ans6):
                        _pre = e["gap_prefix"]
                        _m = re.search(r"([A-Za-z']+)-$", _pre)
                        if _m:
                            _stem = _m.group(1)
                            old_full_h = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                            e["gap_prefix"] = re.sub(r"\s+", " ", _pre[:_m.start()] + " ").strip()
                            # drop trailing fragment already consumed? keep simple: remove last token incl hyphen
                            _pt = _pre.split()
                            if _pt:
                                _pt = _pt[:-1]
                                e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(_pt)).strip()
                            e["answer"] = (_stem + "-" + ans6).strip()
                            new_full_h = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                            def _polh(s):
                                return re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\s+", " ", s.replace("-", " ")).strip())
                            if norm(_polh(new_full_h)) == norm(_polh(old_full_h)):
                                e["full_answer"] = new_full_h
                                if e["full_answer"] and e["full_answer"][-1].isalnum():
                                    e["full_answer"] += "."
                                stats["repaired_kw_widen"] += 1
                                ans6 = e["answer"]
                                ans_toks = [t for t in ans6.split() if clean_word(t)]
                if kw6 and len(ans_toks) == 1 and same_lemma(ans_toks[0], kw6):
                    pre_t = e["gap_prefix"].split()
                    suf_t = e["gap_suffix"].split()
                    pre_w = [w for w in word_tokens(e["gap_prefix"]) if w and re.search(r"[A-Za-z0-9]", w)]
                    suf_w = [w for w in word_tokens(e["gap_suffix"]) if w and re.search(r"[A-Za-z0-9]", w)]
                    # locate word-token positions in raw splits for popping
                    def pop_left(n):
                        idxs = [i for i, t in enumerate(pre_t) if clean_word(t) and re.fullmatch(r"[A-Za-z']+", clean_word(t))]
                        return idxs[-n:] if len(idxs) >= n else idxs
                    def pop_right(n):
                        idxs = [i for i, t in enumerate(suf_t) if clean_word(t) and re.fullmatch(r"[A-Za-z']+", clean_word(t))]
                        return idxs[:n] if len(idxs) >= n else idxs
                    old_full = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                    orig = (e["gap_prefix"], e["answer"], e["gap_suffix"])
                    did = False
                    if len(pre_w) <= 1 and len(suf_w) >= 2:
                        # start: keyword + next 2
                        take = pop_right(2)
                        if len(take) == 2:
                            parts = [ans6] + [ans_word(suf_t[i]) for i in take]
                            e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                            e["gap_suffix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(suf_t) if j not in take)).strip()
                            did = True
                    elif len(suf_w) <= 1 and len(pre_w) >= 2:
                        # end / before-single: prev 2 + keyword
                        take = pop_left(2)
                        if len(take) == 2:
                            parts = [ans_word(pre_t[i]) for i in take] + [ans6]
                            # avoid leading conjunction: extend by one more if starts with and/or
                            if parts and clean_word(parts[0]).lower() in CONJ:
                                take2 = pop_left(3)
                                if len(take2) == 3:
                                    take = take2
                                    parts = [ans_word(pre_t[i]) for i in take] + [ans6]
                            e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                            e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(pre_t) if j not in take)).strip()
                            did = True
                    else:
                        # middle: 1 before + keyword + 1 after, with conjunction guards.
                        # If suffix starts with , ; : then R sits across punctuation:
                        # take left 2 + keyword instead (keeps comma in place).
                        suf_stripped = e["gap_suffix"].lstrip()
                        if suf_stripped and suf_stripped[0] in ",;:":
                            take = pop_left(2)
                            if len(take) == 2:
                                parts = [ans_word(pre_t[i]) for i in take] + [ans6]
                                if parts and clean_word(parts[0]).lower() in CONJ:
                                    take3 = pop_left(3)
                                    if len(take3) == 3:
                                        take = take3
                                        parts = [ans_word(pre_t[i]) for i in take] + [ans6]
                                e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                                e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(pre_t) if j not in take)).strip()
                                did = True
                            else:
                                li = pop_left(1)
                                if li:
                                    Lraw = ans_word(pre_t[li[0]])
                                    parts = [Lraw, ans6]
                                    e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                                    e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(pre_t) if j not in li)).strip()
                                    did = True
                        else:
                            li = pop_left(1)
                            ri = pop_right(1)
                            if li and ri:
                                Lraw, Rraw = ans_word(pre_t[li[0]]), ans_word(suf_t[ri[0]])
                                if clean_word(Rraw).lower() in CONJ:
                                    # "fair" + "and square": take keyword + next 2 instead
                                    take2 = pop_right(2)
                                    if len(take2) == 2:
                                        parts = [ans6] + [ans_word(suf_t[i]) for i in take2]
                                        e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                                        e["gap_suffix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(suf_t) if j not in take2)).strip()
                                        did = True
                                elif clean_word(Lraw).lower() in CONJ:
                                    take2 = pop_left(2)
                                    if len(take2) == 2:
                                        parts = [ans_word(pre_t[i]) for i in take2] + [ans6, Rraw]
                                        e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                                        e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(pre_t) if j not in take2)).strip()
                                        e["gap_suffix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(suf_t) if j not in ri)).strip()
                                        did = True
                                else:
                                    parts = [Lraw, ans6, Rraw]
                                    e["answer"] = re.sub(r"\s+", " ", " ".join(parts)).strip()
                                    e["gap_prefix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(pre_t) if j not in li)).strip()
                                    e["gap_suffix"] = re.sub(r"\s+", " ", " ".join(t for j, t in enumerate(suf_t) if j not in ri)).strip()
                                    did = True
                    if did:
                        new_full = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                        def _pol6(s):
                            _p = re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\s+", " ", s).strip())
                            return re.sub(r"[.!?]+$", "", _p).strip()
                        if norm(_pol6(new_full)) == norm(_pol6(old_full)):
                            if new_full and new_full[-1].isalnum():
                                new_full += "."
                            e["full_answer"] = new_full
                            stats["repaired_kw_widen"] += 1
                        else:
                            e["gap_prefix"], e["answer"], e["gap_suffix"] = orig
            # repair 5: answer edge-word duplicated adjacent to the gap
            # ("ran away with with the budget" -> drop frame "with";
            #  "Only after after ..." handled by repair 3, this is the overlap guard)
            if True:
                ans_t = e["answer"].split()
                touched5 = False
                if ans_t:
                    # suffix head == answer tail
                    st = e["gap_suffix"].split()
                    if st and ans_t and st[0] and ans_t[-1]:
                        if clean_word(st[0]) and clean_word(ans_t[-1]) and clean_word(st[0]).lower() == clean_word(ans_t[-1]).lower():
                            e["gap_suffix"] = " ".join(st[1:])
                            stats["repaired_dup_edge_suf"] += 1
                            touched5 = True
                    # prefix tail == answer head (re-read after possible suffix change: prefix unchanged)
                    pt = e["gap_prefix"].split()
                    if pt and ans_t and pt[-1] and ans_t[0]:
                        if clean_word(pt[-1]) and clean_word(ans_t[0]) and clean_word(pt[-1]).lower() == clean_word(ans_t[0]).lower():
                            e["gap_prefix"] = " ".join(pt[:-1])
                            stats["repaired_dup_edge_pre"] += 1
                            touched5 = True
                    if touched5:
                        new_full5 = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                        e["full_answer"] = new_full5
                        if e["full_answer"] and e["full_answer"][-1].isalnum():
                            e["full_answer"] += "."
            # second-pass repair 0: widening must not reintroduce a leading conjunction
            na0b = norm(e.get("answer", "")).split(" ")
            if len(na0b) > 1 and na0b[0] in ("and", "or", "nor", "but"):
                e["gap_prefix"] = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + na0b[0])).strip()
                e["answer"] = re.sub(r"\s+", " ", " ".join(e["answer"].split(" ")[1:])).strip()
                e["full_answer"] = re.sub(r"\s+", " ", (e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])).strip()
                if e["full_answer"] and e["full_answer"][-1].isalnum():
                    e["full_answer"] += "."
                stats["repaired_lead_conj2"] += 1
            if e["category"] == "mcq":
                # "..." placeholder frames are dead data (frontend ignores frame for mcq);
                # clear them and rebuild a sane full for reveal.
                if e["gap_prefix"].strip() in ("...", "…"):
                    e["gap_prefix"] = ""
                if e["gap_suffix"].strip() in ("...", "…"):
                    e["gap_suffix"] = ""
                if e["full_answer"].strip().startswith("..."):
                    e["full_answer"] = re.sub(r"\s+", " ", (e["prompt"] + " " + e["answer"])).strip()
                    if e["full_answer"] and e["full_answer"][-1].isalnum():
                        e["full_answer"] += "."
                    stats["repaired_mcq_full"] += 1
            if e["category"] == "prep_idiom" and not e["gap_prefix"] and not e["gap_suffix"]:
                fl, al = e["full_answer"].lower(), e["answer"].lower()
                if fl.startswith(al):
                    e["gap_suffix"] = e["full_answer"][len(e["answer"]):].strip()
                    stats["repaired_affix"] += 1
                if e["full_answer"] and e["full_answer"][-1] != ".":
                    e["full_answer"] += "."
            # polish: no space before closing punctuation in the stored sentence
            e["full_answer"] = re.sub(r"\s+([.,;:!?])", r"\1", e["full_answer"])
            for x in warn(e):
                stats["warn:" + x] += 1
            raw.append((f, i, e))

    # dedup 1: exact normalized gap triple (+options: mcq/3-in-1 frames live in options)
    seen_exact, uniq = set(), []
    for f, i, e in raw:
        optk = tuple(norm(a) for a in e["options"])
        k = (e["category"], norm(e["gap_prefix"]), norm(e["answer"]), norm(e["gap_suffix"]), optk)
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
    # conflict: same prompt AND same gap frame AND same options, different answer -> keep first
    # (shared triggers like "Hardly ___" are legitimate; t3/mcq frames include their options)
    seen_gap, out = {}, []
    for f, i, e in deduped:
        optk = tuple(norm(a) for a in e["options"])
        gk = (e["category"], norm(e["prompt"]), norm(e["gap_prefix"]), norm(e["gap_suffix"]), optk)
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

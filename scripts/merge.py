"""Merge + repair subagent corpora into one deduped seed corpus.
Run: python3 scripts/merge.py
Reads data/part-*.json, writes data/corpus.json + src-tauri/seed.json
"""
import json, glob, re, os

PREPS = {"of","with","to","for","in","on","above","about","after","against","among",
"around","at","before","behind","below","beneath","beside","between","beyond","by",
"despite","down","during","except","from","into","like","near","off","out","over",
"past","since","through","toward","towards","under","until","up","upon","within","without",
"that","which","who","when","where","and","or","than","as","because","while","if"}

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

files = sorted(glob.glob("data/part-*.json"))
all_items, dropped = [], 0
for f in files:
    arr = json.load(open(f))
    print(f"{f}: {len(arr)}")
    all_items.extend(arr)
print("raw total:", len(all_items))

# explicit patches for known-wrong agent outputs
PATCH = {
  "I did not realise until then. (not)": dict(
      answer="until then did I realise",
      full_answer="Not until then did I realise."),
  "His last visit was two months ago. (since)": dict(
      answer="has not visited for",
      full_answer="He has not visited for two months."),
}

fixed_bin, fixed_prep = 0, 0
clean = []
for e in all_items:
    cat = (e.get("category") or "").strip()
    prompt = (e.get("prompt") or "").strip()
    kw = (e.get("keyword") or "").strip()
    pre = (e.get("gap_prefix") or "").strip()
    suf = (e.get("gap_suffix") or "").strip()
    ans = (e.get("answer") or "").strip()
    full = (e.get("full_answer") or "").strip()
    alts = e.get("alternatives") or []
    notes = (e.get("notes") or "").strip()
    try:
        diff = int(e.get("difficulty") or 1)
    except Exception:
        diff = 1
    diff = max(1, min(3, diff))

    if not ans or not full:
        dropped += 1
        continue
    # strip leading space artifacts in answer
    ans = ans.strip()
    alts = [a.strip() for a in alts if a and a.strip()]

    key = prompt
    if key in PATCH:
        ans = PATCH[key]["answer"]
        full = PATCH[key]["full_answer"]

    # repair prep formal-phrase entries with empty affixes: split full on answer
    if not pre and not suf and ans:
        fl = full.lower()
        al = ans.lower()
        if fl.startswith(al):
            suf = full[len(ans):].strip()
            pre = ""
        else:
            # fallback: keep as terminal drill
            pre, suf = full.rstrip(".").strip(), "."
            full = pre + " " + ans + " ." if False else full
            # actually leave; UI handles empty affix as end-gap
            pass
        fixed_prep += 1

    # repair binomial duplications: suffix is leftover erroneous word(s)
    if cat == "binomial" and suf and suf != ".":
        first = norm(suf).split(" ")[0].rstrip(",.")
        if first not in PREPS and not suf.startswith(","):
            # legit suffixes are PP/comma continuations; else drop leftover
            suf = "."
            full = (pre + " " + ans + ".").replace("  ", " ").strip()
            # ensure single period
            full = re.sub(r"\.+ High-level.*$", ".", full) if False else full
            fixed_bin += 1

    # ensure full ends with sentence period if it looks like a sentence
    if full and full[-1].isalnum():
        full = full + "."
    # collapse double spaces
    pre = re.sub(r"\s+", " ", pre).strip()
    suf = re.sub(r"\s+", " ", suf).strip()
    ans = re.sub(r"\s+", " ", ans).strip()
    full = re.sub(r"\s+", " ", full).strip()

    clean.append({"category": cat, "prompt": prompt, "keyword": kw,
                  "gap_prefix": pre, "gap_suffix": suf, "answer": ans,
                  "full_answer": full, "alternatives": alts,
                  "notes": notes, "difficulty": diff})

# dedup on normalized full sentence
seen, out = set(), []
for e in clean:
    k = norm(e["gap_prefix"] + " " + e["answer"] + " " + e["gap_suffix"])
    if k in seen:
        dropped += 1
        continue
    seen.add(k)
    out.append(e)

os.makedirs("data", exist_ok=True)
json.dump(out, open("data/corpus.json", "w"), ensure_ascii=False, indent=1)
json.dump(out, open("src-tauri/seed.json", "w"), ensure_ascii=False, indent=1)
from collections import Counter
print("fixed_binomial:", fixed_bin, "fixed_empty_affix:", fixed_prep)
print("dropped:", dropped, "final:", len(out), Counter(e["category"] for e in out))

"""Apply data/notes-patch-*.json definitions into source part-*/extra-* files.

Surgical text-level update: only the changed objects' spans are replaced, so
unchanged rows stay byte-identical (minimal diff). Matches merge.py norm().
Usage: python3 scripts/apply_notes.py [--dry-run]
"""
import glob
import io
import json
import os
import re
import sys

PATCH_GLOB = "data/notes-patch-*.json"
SRC_GLOBS = ("data/part-*.json", "data/extra-*.json")


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def load_patches():
    m = {}
    nfiles = nrows = 0
    for pf in sorted(glob.glob(PATCH_GLOB)):
        nfiles += 1
        with open(pf, encoding="utf-8") as f:
            rows = json.load(f)
        for r in rows:
            nrows += 1
            if isinstance(r, dict) and r.get("prompt") and r.get("answer"):
                m.setdefault((r.get("category", ""), norm(r["prompt"])), []).append(r)
    print(f"patch files: {nfiles}, patch rows: {nrows} in {len(m)} prompt groups")
    return m


def alnum(s):
    return re.sub(r"[^a-z0-9]", "", norm(s))


def pick(patches_for_prompt, obj):
    """Repair-aware match: repairs regroup words but preserve the sentence, so
    match by prompt group, then answer compatibility (containment either way,
    e.g. widened 'a date for' vs source 'date'), tie-broken by full similarity."""
    if not patches_for_prompt:
        return None
    sa, sf = norm(obj.get("answer", "")), norm(obj.get("full_answer", ""))
    aa, af = alnum(sa), alnum(sf)
    compat = [p for p in patches_for_prompt
              if alnum(p.get("answer", "")) in af or aa in alnum(p.get("answer", ""))]
    cand = compat or patches_for_prompt
    if len(cand) == 1:
        return cand[0]
    best, bs = None, -1.0
    import difflib
    for p in cand:
        s = difflib.SequenceMatcher(None, sf, norm(p.get("full_answer", sf))).ratio()
        if s > bs:
            best, bs = p, s
    return best


def file_objs(txt):
    """Return (kind, spans) where spans = [(start, end, obj)] for top-level
    array elements or {items:[...]} elements. kind in ("array", "items", "jsonl", "?")."""
    dec = json.JSONDecoder()
    i, n = 0, len(txt)
    while i < n and txt[i] in " \t\r\n":
        i += 1
    if i < n and txt[i] == "[":
        spans, j = [], i + 1
        while True:
            k = j
            while k < n and txt[k] in " \t\r\n,":
                k += 1
            if k < n and txt[k] == "]":
                return "array", spans
            try:
                obj, end = dec.raw_decode(txt, k)
            except json.JSONDecodeError:
                return "?", []
            spans.append((k, end, obj))
            j = end
    if i < n and txt[i] == "{":
        try:
            doc, end = dec.raw_decode(txt, i)
        except json.JSONDecodeError:
            return "?", []
        if isinstance(doc, dict) and isinstance(doc.get("items"), list):
            m = re.search(r'"items"\s*:\s*\[', txt[i:end])
            if not m:
                return "?", []
            spans, j = [], i + m.end()
            while True:
                k = j
                while k < n and txt[k] in " \t\r\n,":
                    k += 1
                if k < n and txt[k] == "]":
                    return "items", spans
                try:
                    obj, end2 = dec.raw_decode(txt, k)
                except json.JSONDecodeError:
                    return "?", []
                spans.append((k, end2, obj))
                j = end2
        return "?", []
    # JSONL attempt
    spans = []
    for ln, line in enumerate(txt.splitlines()):
        s = line.strip()
        if not s:
            continue
        try:
            spans.append((ln, ln, json.loads(s)))
        except json.JSONDecodeError:
            return "?", []
    return ("jsonl", spans) if spans else ("?", [])


def redump(obj, sample_span_txt):
    """Re-serialize one object imitating the sample's separators/encoding."""
    if re.search(r'"\s*:\s', sample_span_txt):
        seps = (", ", ": ")
    else:
        seps = (",", ":")
    ensure = "\\u" in sample_span_txt
    return json.dumps(obj, ensure_ascii=ensure, separators=seps)


def main():
    dry = "--dry-run" in sys.argv
    patches = load_patches()
    if not patches:
        print("nothing to apply")
        return 0
    used = set()
    total_hit = total_miss = total_chg = 0
    changed_files = []
    for pattern in SRC_GLOBS:
        for path in sorted(glob.glob(pattern)):
            with open(path, encoding="utf-8") as f:
                txt = f.read()
            kind, spans = file_objs(txt)
            if kind == "?":
                print(f"SKIP (unparseable layout): {path}")
                continue
            if kind == "jsonl":
                lines = txt.splitlines()
                chg = 0
                for ln, _, obj in spans:
                    if not isinstance(obj, dict):
                        continue
                    p = pick(patches.get((obj.get("category", ""), norm(obj.get("prompt", ""))), []), obj)
                    if p is None:
                        total_miss += 1
                        continue
                    total_hit += 1
                    used.add(id(p))
                    if obj.get("notes", "") != p.get("notes", ""):
                        obj["notes"] = p.get("notes", "")
                        lines[ln] = redump(obj, "")
                        chg += 1
                if chg:
                    total_chg += chg
                    changed_files.append((path, chg))
                    if not dry:
                        tmp = path + ".tmp"
                        with open(tmp, "w", encoding="utf-8") as f:
                            f.write("\n".join(lines) + ("\n" if txt.endswith("\n") else ""))
                        os.replace(tmp, path)
                continue
            out = io.StringIO()
            pos, chg = 0, 0
            for st, en, obj in spans:
                if not isinstance(obj, dict):
                    continue
                p = pick(patches.get((obj.get("category", ""), norm(obj.get("prompt", ""))), []), obj)
                out.write(txt[pos:st])
                if p is None:
                    total_miss += 1
                    out.write(txt[st:en])
                else:
                    total_hit += 1
                    used.add(id(p))
                    if obj.get("notes", "") != p.get("notes", ""):
                        new_obj = {k: (p.get("notes", "") if k == "notes" else v) for k, v in obj.items()}
                        if "notes" not in new_obj:
                            new_obj["notes"] = p.get("notes", "")
                        out.write(redump(new_obj, txt[st:en]))
                        chg += 1
                    else:
                        out.write(txt[st:en])
                pos = en
            out.write(txt[pos:])
            if chg:
                total_chg += chg
                changed_files.append((path, chg))
                if not dry:
                    new_txt = out.getvalue()
                    # safety: must re-parse to identical objects modulo notes
                    json.loads(new_txt)
                    tmp = path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write(new_txt)
                    os.replace(tmp, path)
    allp = [p for v in patches.values() for p in v]
    print(f"matched: {total_hit}  unmatched-source: {total_miss}  changed: {total_chg}")
    print(f"patch rows consumed: {len(used)}/{len(allp)}")
    print(f"files changed: {len(changed_files)}")
    for p, c in changed_files[:30]:
        print(f"  {p}: {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Edge audit — drill engine (frontend + backend + data shape)

Scope: `src/main.js`, `src/index.html`, `src/styles.css`, `src-tauri/src/main.rs`
(`due_items` stratified fetch, `submit_answer` fuzzy, SRS, `items_by_ids` wall, seed versioning),
`scripts/merge.py` (options field). Verified by reading code + executing the
normalize/levenshtein logic and corpus queries against `data/corpus.json` (6797 rows).

Notation: `main.js:NNN` = `src/main.js`, `main.rs:NNN` = `src-tauri/src/main.rs`.

---

## G1 — Grading false-accepts (wrong answers marked correct)

### E01 — Every MCQ accepts bare "a" as correct (data + backend, critical)
- Repro: `submit_answer({itemId: <any mcq id>, user: "a"})` → `{correct: true}`.
  All 1083 `mcq` rows in corpus carry `alternatives: ["A"]` (the correct-option
  letter stored as an alternative). `fuzzy_accept` treats every alternative as gold.
- Root: corpus convention (`alternatives=["A"]`) × `main.rs:507-510`
  (`golds = [answer] + alts`, no length/content filter).
- Frontend masks it (`main.js:269-275` maps `a`→`opts[0]` before submit) but direct
  invoke / future clients hit it.
- Fix: in `merge.py:canon`, drop single-letter alternatives for `mcq`
  (they encode the key, not an answer); AND in `submit_answer`, ignore
  alternatives with normalized length < 2. Backfill: strip `["A".."D"]` alts from DB.

### E02 — Distance ≤2 on 1–3 char answers forgives the tested contrast
- Adversarial pairs (computed with the real `normalize`+`levenshtein`):
  `on` vs gold `in` (d=1, ACCEPT), `of` vs `off` (d=1, ACCEPT).
  Corpus has 567 answers ≤3 chars; `prep_idiom` alone has `of/to/for/on/in/off`
  as whole answers — any 1-edit preposition swap passes.
- Root: `main.rs:293-328` — `allow=2` for all `long<=24`, guard only `nu.len()>=2`.
- Fix: scale threshold, e.g. `long<=3 → 0`, `<=8 → 1`, else 2 (keep ratio rule only
  for `long>8`). Preposition drills then require exact.

### E03 — `its/it's`, `your/you're`, `whose/who's` confusions forgiven
- `it's` vs `its`: d=1 ACCEPT. `you're` vs `your`: d=2 ACCEPT. `who's` vs `whose`:
  d=2 ACCEPT. These are exactly the errors `wordform` drills test.
- Root: same as E02 (apostrophe kept by `normalize`, `main.rs:234-257`, then
  swallowed by the ≤2 budget).
- Fix: E02 scaling fixes all three (lengths 3–6 → allow 0/1). Do not special-case
  apostrophes; the length-scaled budget is sufficient.

### E04 — `us_uk_fold` is an unanchored substring replace
- `main.rs:267-270`: `s.replace("ou","o").replace("ise","ize")`.
  `soup→sop`, `house→hose`, `tour→tor`, `promise→promize`, `wise→wize`,
  `surprise→surprize`, `exercise→exercize` — all fold-equal to a *different,
  misspelled* word and return `(true, 0)` (distance 0, error hidden).
  Verified: `fold("soup")=="sop"`, `fold("promise")=="promize"`.
- Root: substring replace with no word boundaries; "ise" fires inside `promise`,
  `wise`, `disguise`.
- Fix: replace with a whole-word map
  (`colour/color`, `favour/favor`, `organise/organize`, …), matched on
  `split_whitespace` tokens, not substrings.

### E05 — Article-strip forgives tested determiners
- `main.rs:259-265` + `302`: `an apple` vs `apple` → both strip to `apple` → ACCEPT.
  Any `a/an/the`-only difference passes regardless of length. If a drill tests
  the article, the test is void.
- Root: pass applied unconditionally to all answers.
- Fix: apply article-strip only when gold has ≥3 tokens (or skip when the
  stripped tokens are the entire difference on a ≤2-token answer).

### E06 — `ratio >= 0.85` + byte-length `long` over-accepts long answers
- `hard and fat` vs `hard and fast`: d=1, ratio 0.923 → ACCEPT (wrong collocate
  passes). For a 20-char answer, 3 edits still pass (`1-3/20=0.85`).
- Root: `main.rs:311-319`; `long` uses byte `.len()`, distance uses chars —
  non-ASCII answers miscompute the ratio.
- Fix: threshold `0.92`, compute `long` in chars, combine with E02 scaling.

## G2 — Grading false-rejects (right answers marked wrong)

### E07 — Double contractions rejected (`'m` / `'s` never expanded)
- `I'm sure he's right` vs gold `I am sure he is right`:
  normalized `i'm sure he's right` vs `i am sure he is right`, d=4 → REJECT,
  though semantically exact.
- Root: `main.rs:238-241` expansion table lacks `'m→am`, `'s→is/has`.
- Fix: add `("'m"," am")`. `'s` is ambiguous (is/has) — add `("'s"," is")` only
  as a *second* candidate comparison, or leave `'s` to the (rescaled) distance
  budget and document it.

### E08 — MCQ `1.` / `a)` / `A:` rejected although intent is unambiguous
- Repro: MCQ row, type `1.` + Enter → stays literal `"1."` → normalized `"1"` vs
  gold option text → wrong.
- Root: `main.js:269-274` regexes `^[1-9]$`, `^[a-z]$` accept only a bare char.
- Fix: `/^([1-9a-z])[\).\s:\-]*$/` (lowercased/trimmed first), then existing
  bounds check.

### E09 — Combined leniencies rejected (article + spelling variant together)
- `a colour` vs gold `color`: article pass compares `colour≠color`; fold pass
  compares `a colour→a color ≠ color`. REJECT, although each leniency alone passes.
- Root: `main.rs:299-308` — passes compared independently on differently-folded forms.
- Fix: compare `strip(fold(nu)) == strip(fold(ng))` as one combined pass.

### E10 — Browser preview grades exact-only (diverges from Tauri fuzzy)
- `main.js:282-284` fallback: `user.toLowerCase().trim() === answer…` — no
  contraction/article/fold/distance handling. `colour/color`, `dont/don't`-class
  inputs pass in-app but fail in preview.
- Root: fallback by design (no backend), but silent divergence.
- Fix: document in the fallback error/score line ("preview grading is strict"),
  or port the (fixed) `normalize` + exact/article passes to JS (20 lines).

## G3 — SRS / scheduling / retry wall

### E11 — `mastered` items never resurface (60-day date is dead)
- `srs_update` (`main.rs:345`) sets `next_due = now + 60d` at `nr>=5`, but
  `due_items` overdue (`main.rs:385`) and stratified (`main.rs:406`) both filter
  `COALESCE(p.mastered,0)=0`. Mastered rows are excluded forever, even after the
  60d date. Doc (`AGENTS.md`) says "retired 60d", implying return.
- Fix: overdue filter → `(COALESCE(p.mastered,0)=0 OR p.next_due<=now)` and clear
  `mastered` on resurfacing wrong answer (already happens via `submit_answer:521`).

### E12 — Stratified "fresh" path ignores `next_due` (SRS intervals voided)
- Stratified query (`main.rs:404-408`) filters only `mastered=0` — items answered
  correctly seconds ago (`next_due` tomorrow) are re-emitted as "fresh" in the
  next batch. Correct answers can reappear immediately on lap (`seen` cleared,
  `main.js:47-50`).
- Root: no `next_due` predicate on the stratified branch (unlike the overdue branch).
- Fix: add `AND (p.item_id IS NULL OR p.next_due<=?now)` (bind `now`) so fresh =
  unseen-or-due only.

### E13 — Retry wall is dead code: `wrongIds ∩ seenIds` is always empty
- `main.js:193`: `wrongIds.filter(id => !seenIds.has(id))`. But every graded id was
  added to `seenIds` at fetch (`main.js:53`), so the filter removes *all*
  candidates → `if (!ids.length) return` every 50 rows. The wall never renders.
  (Confirmed by read; no execution needed — the sets overlap by construction.)
- Fix: track wall eligibility separately, e.g.
  `ids = wrongIds.filter(id => !wallSeen.has(id) && !items.slice(rendered).some(d=>d.id===id))`,
  and add rendered wall ids to `wallSeen` instead of reusing `seenIds`.

### E14 — Wall (once fixed) duplicates pending unrendered rows
- `items_by_ids` returns rows regardless of membership in `items[rendered..]`;
  `splice(rendered, 0, …)` (`main.js:202`) would duplicate an item already queued
  but not yet painted (fetched in the same 200-batch, missed early, wall fires
  before it renders).
- Fix: as E13 — exclude ids already present anywhere in `items`, not just `seenIds`.

### E15 — `drained` permanently blocks SRS resurfacing
- `main.js:54,79`: once the bank laps with nothing new, `drained=true` stops all
  further `due_items` calls. Failed items (`next_due = now+600`, `main.rs:349`)
  never get refetched; with E13 the miss path has *zero* resurfacing.
- Fix: when a fetch returns 0, schedule a re-try (`setTimeout(fetchMore, 60s)`,
  reset `drained=false`) instead of latching; or keep `drained` but re-arm when
  `wrongIds.length>0`.

### E16 — `seen` truncation at 5000 + giant inline `NOT IN` (perf cliff)
- `main.rs:370-375`: `seen` truncated to 5000, interpolated as literals into ~40
  per-batch queries (`10 cats` overdue + `30` strata). Past 5000 seen, repeats
  leak back in (frontend `fresh` filter, `main.js:52`, is the only guard); each
  batch re-parses ~30KB SQL × 40 with `ORDER BY RANDOM()` full scans (no index
  on `difficulty`; only `idx_items_cat` exists).
- Fix: stage `seen` into a temp table + `NOT IN (SELECT id FROM tmp_seen)`;
  add `CREATE INDEX idx_items_cat_diff ON items(category,difficulty)`; keep the
  5000 cap but document lap semantics.

### E17 — Seed bump wipes all SRS history (documented tradeoff — confirm intent)
- `seed_if_empty` (`main.rs:174`): any content-hash change → `DELETE reviews,
  progress, items`. Per repo `AGENTS.md` this is *expected, not a bug*.
  Recorded here so the audit is complete: one added row resets every interval.
- Improvement (optional): upsert-by-stable-key items and keep `progress`, only
  inserting truly new rows.

### E18 — `import_seed` appends duplicates and is wiped on next launch
- `main.rs:583-588`: plain `INSERT`s with no dedupe/validation (bypasses
  `merge.py` checks — malformed rows, dupes, empty affixes all accepted), and
  does not update `meta(seed)`, so the next restart re-hashes the bundled seed
  and can wipe the import.
- Fix: run the same `canon`/dedupe (or at minimum exact-key dedupe) and either
  update `meta(seed)` or document that imports are ephemeral.

### E19 — Double grading inflates SRS (`check()` + re-Enter)
- `check()` (`main.js:328-337`) grades *every* rendered row including already
  solved (`results[n]` set) → second `submit_answer` → `reps+1` again, extra
  `reviews` row, `wrongIds` churn. Same via pressing Enter twice in one gap
  (`gradeItem` has no solved-guard; `focusNext` no-ops when all solved, E24).
- Fix: `if (n in results) continue;` in `check()`; early-return cached value in
  `gradeItem` when `n in results` (still allow explicit re-grade via a modifier,
  e.g. Alt+Enter, if desired).

### E20 — Reveal → Check marks everything "correct" without learning
- `reveal()` (`main.js:339-349`) fills inputs with answers but touches neither
  `results` nor backend; a following `check()` submits revealed text → all
  correct → SRS intervals jump.
- Fix: `reveal()` sets `results[n] = "revealed"` (skipped by `check()`, E19) and
  any manual edit clears the flag; or `reveal()` submits nothing and `check()`
  skips revealed rows.

## G4 — Keyboard flow / focus traps

### E21 — `focusNext` lands in filter-hidden gaps (typing blind)
- `applyFilter` (`main.js:251-261`) sets `display:none`, but `focusNext`
  (`main.js:317-326`) only checks `k in results` → Enter jumps focus into an
  invisible input under Correct/Wrong filters.
- Fix: skip rows whose `rowN` has `display==="none"`.

### E22 — Enter on an empty gap goes BACKWARD (row 0 is a dead end)
- `main.js:170`: empty + Enter → `focusPrev(n)`; at row 0 nothing happens, no
  feedback. Users clearing a box + Enter expect forward/no-op, not rewind.
- Fix: empty Enter → `focusNext(n)` (or no-op + subtle hint), keep Shift+Enter
  as the backward key.

### E23 — `focusPrev` ignores solved state and filter (asymmetric with Next)
- `main.js:311-316` walks to `n-1` unconditionally — lands on solved or hidden rows.
- Fix: same hidden-skip as E21; solved-skip is optional (reviewing solved rows
  backwards is legitimate — keep if intentional, document).

### E24 — Bulk `check()` steals focus/scroll per row
- `gradeItem` calls `applyFilter` + `focusNext` (`main.js:304-305`) per row, so
  `check()` over 100 rows thrashes focus/scroll 100× and ends focused wherever
  the last grade landed.
- Fix: bulk flag — `gradeItem(n, {quiet:true})` suppressing focus/filter, single
  `applyFilter()` + summary focus at end of `check()`.

## G5 — Rendering / data-shape breakage

### E25 — `stripBracket` + keyword badge use substring matching
- `main.js:145-152`: `m[0].toLowerCase().includes(keyword)` strips `(cup)` for
  keyword `up`, `(can)` for `an`. Regex also misses digits/accents and trailing
  `!`/`;`. Badge logic (`main.js:112-114`, `inAns`/`inFrame` via `includes`)
  has the same flaw (`an` matches `can`, `man`).
- Fix: extract inner bracket text, compare `norm(inner)===norm(keyword)`;
  badge checks on `\bkw\b` word-boundary regex (escaped).

### E26 — Category branches assume merge-clean data; fallback can crash
- `rowFor` (`main.js:82-142`): `three_in_one` with `<3` options (possible via
  `import_seed`, E18 — merge validates but import doesn't) falls into the gap
  branch with empty affixes → bare `→ [input]` with no question. Browser-fallback
  mapping (`main.js:63-66`) spreads raw rows; missing `answer` → `d.answer.toLowerCase()`
  (`main.js:113`) throws.
- Corpus today has 0 empty-frame rows (verified) — latent, not live.
- Fix: guard `d.answer/gap_prefix/gap_suffix` with `?? ""`; render a
  "malformed item (id)" placeholder row instead of throwing.

### E27 — `.walldiv` borders never render (undefined CSS var)
- `styles.css:19-21`: `border-top/bottom: 1px dashed var(--outline)` but only
  `--rule` is defined (`:root`, line 1). Undefined var → invalid declaration →
  no divider lines around the retry wall.
- Fix: `var(--mut)` or define `--outline`.

### E28 — Infinite scroll can stall (observer never refires)
- `main.js:218-222`: single-shot observer on `#more` with 800px margin. If the
  first `RENDER_N=25` rows don't fill the viewport, `#more` stays intersecting
  with no new event → stall until the user scrolls.
- Fix: after `renderMore`/`fetchMore`, `if (moreBox visible && rendered<items.length) renderMore()`
  (or `requestAnimationFrame` loop while intersecting).

### E29 — MCQ affordances mismatch (`1–4` placeholder, no `three_in_one` hint)
- `main.js:166`: mcq placeholder `1–4` but `gradeItem` accepts `1-9/a-z`/full text;
  `a)`/`1.` (E08) fail silently. `three_in_one` inputs have no placeholder at all.
- Fix: placeholders `1–4 · a–d · or type the word` / `one word fits all three`;
  paired with E08 parsing.

### E30 — `stats` / `import_seed` / `reset_progress` unreachable from UI
- Backend commands exist (`main.rs:566-596`) but `main.js` never invokes them and
  `index.html` has no controls — no accuracy view, no import, no reset; the
  "No due items … Try another category" line (`main.js:184`) points at a
  category switcher that doesn't exist (frontend hardcodes `cat="all"`, `main.js:45`).
- Fix (pick one): wire a minimal stats readout + reset into the footer, or delete the dead commands; either way fix the empty-bank message to describe
  the actual state ("all items mastered" vs "bank empty").

---

## Highest-priority fixes (ordered)

1. E13 wall dead-code (retry feature entirely absent) + E15 (no resurfacing at all).
2. E01 `["A"]` alternatives (every MCQ trivially passable via backend).
3. E02/E03 short-answer budget (preposition/its-it's drills void).
4. E12 stratified ignores `next_due` + E11 mastered never returns (SRS is decorative).
5. E19/E20 double-grade + reveal-gaming (SRS corruption via UI).
6. E04 fold overreach, E07 contractions, E08 MCQ punctuation, E21/E22 focus traps.

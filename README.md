# HSG English Drill (Tauri v2 + SQLite)

Deadpan monochrome sentence-transformation drill for Vietnamese Gifted English Exam
(HSG Quoc gia / Chuyen Anh). Paper test aesthetic. Local-first.

## Data
- `data/part-*.json` — raw subagent-curated banks + `data/extra-*.json`
- `data/corpus.json` — merged, repaired, deduped master (6810 items)
- `src-tauri/seed.json` — bundled copy seeded into SQLite on first run
- Categories (10): `light_verb` 600 · `prep_idiom` 662 · `figurative` 740 ·
  `binomial` 511 · `rephrase` 1056 · `inversion` 504 · `mcq` 1092 ·
  `three_in_one` 536 · `wordform` 570 · `blank_fill` 539

Rebuild corpus: `python3 scripts/merge.py --dry-run` (preview) then
`python3 scripts/merge.py` (writes corpus+seed+quarantine atomically,
refuses to write if <1000 rows). Must run from repo root.

## Run (zero-config)
```sh
npm install
npx tauri dev
```
Backend: Rust + rusqlite (bundled), WAL mode. DB at app-data `hsg.db`.
No server, no env, no keys.

## Drill engine
- `due_items(limit, category)` — stable curriculum wall: stratified id-ordered
  paging (round-robin category × difficulty), `seen` ids excluded, top-up to
  full `limit`. Same query → same order every launch.
- `submit_answer(item_id, user)` — fuzzy accept: lowercase, collapse spaces,
  strip punctuation (keep `'`), expand contractions (incl. `'m`→am, `'s`→is),
  combined article+spelling leniency (article-only diffs need a 3+ token gold),
  whole-word US/UK map (one-way UK→US, idempotent), length-scaled Levenshtein
  (0 if ≤3 chars, 2 if ≤24, 3 if >24; or ratio ≥0.85, char-counted) plus a per-word cap
  (aligned words may differ by at most len/3 letters, so "set"≠"hit" and
  "on"≠"in" fail while one-letter typos pass). Single-letter
  alternatives never count as gold. Binomial order strict via distance.
- SM-2-lite SRS: correct → reps+1, interval 1/6/`e*interval`, mastered at reps≥5
  (repeats ~60d); wrong → easiness−0.25, resurface in ~10 min, lapses+1.
  Progress survives bank updates via stable-key upsert (exact 5-tuple →
  nocat singleton re-tag → sentence fallback keeps repair-regrouped rows;
  prompt is part of the UPDATE so prompt fixes propagate); malformed rows are
  skipped + counted, intra-import dupes skipped; `import_seed(json)` is additive
  (never deletes) and caps at 10MB / 500-char answers.
- `stats`, `import_seed(json)`, `reset_progress`.

## Lookup (on-demand, not stored)
Word input → `https://api.dictionaryapi.dev` fetch + `dict://` link
(Dictionary.app). Keeps DB footprint on test items only.

## Verify
```sh
python3 scripts/merge.py --dry-run  # corpus preview (no writes)
python3 scripts/merge.py            # corpus rebuild
python3 scripts/patch_db.py --dry-run
node --check src/main.js
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
# npx tauri build                   # release build
```

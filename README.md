# HSG English Drill (Tauri v2 + SQLite)

Deadpan monochrome sentence-transformation drill for Vietnamese Gifted English Exam
(HSG Quoc gia / Chuyen Anh). Paper test aesthetic. Local-first.

## Data
- `data/part-*.json` — raw subagent-curated banks (5 x ~150-200)
- `data/corpus.json` — merged, repaired, deduped master (909 items)
- `src-tauri/seed.json` — bundled copy seeded into SQLite on first run
- Categories: `light_verb` 182 · `prep_idiom` 197 · `figurative` 181 ·
  `binomial` 150 · `rephrase` 100 · `inversion` 99

Rebuild corpus: `python3 scripts/merge.py`

## Run (zero-config)
```sh
npm install
npx tauri dev
```
Backend: Rust + rusqlite (bundled), WAL mode. DB at app-data `hsg.db`.
No server, no env, no keys.

## Drill engine
- `due_items(limit, category)` — failed/overdue first, top-up with fresh items.
- `submit_answer(item_id, user)` — fuzzy accept: lowercase, collapse spaces,
  strip punctuation (keep `'`), expand contractions, article-optional pass,
  US/UK fold (`ou→o`, `ise→ize`), Levenshtein ≤2 (≤3 if len>24) or ratio ≥0.85.
  Binomial order strict (distance handles it); inversion auxiliary strict.
- SM-2-lite SRS: correct → reps+1, interval 1/6/`e*interval`, mastered at reps≥5
  (retired 60d); wrong → easiness−0.25, resurface in ~10 min, lapses+1.
- `stats`, `import_seed(json)`, `reset_progress`.

## Lookup (on-demand, not stored)
Word input → `https://api.dictionaryapi.dev` fetch + `dict://` link
(Dictionary.app). Keeps DB footprint on test items only.

## Verify
```sh
python3 scripts/merge.py          # corpus rebuild
node --check src/main.js
npx tauri build                   # or cargo check --manifest-path src-tauri/Cargo.toml
```

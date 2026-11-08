# AGENTS.md

Tauri v2 desktop drill app. Vanilla JS frontend (no framework, no bundler) + Rust + SQLite backend. Local-first, zero-config: no server, env, or keys.

## Layout

- `src/main.js`, `src/index.html`, `src/styles.css` — entire frontend. `main.js` calls Rust via `window.__TAURI__.core.invoke`.
- `src-tauri/src/main.rs` — backend: commands `due_items`, `submit_answer`, `items_by_ids`, `stats`, `import_seed`, `reset_progress`.
- `src-tauri/tauri.conf.json` — `frontendDist: ../src`, no `beforeDevCommand`/`beforeBuildCommand`. Bundles `seed.json` as resource.
- `scripts/merge.py` — corpus build pipeline. `data/part-*.json` + `data/extra-*.json` → `data/corpus.json` + `src-tauri/seed.json` (+ `data/quarantine.json`).
- `data/purge-*.json` — blocklists matched pre-repair on normalized prompt+answer.

## Commands (run from repo root)

```sh
npm install
npx tauri dev        # dev run (also `npm run dev`)
npx tauri build      # release build
python3 scripts/merge.py                          # rebuild corpus + seed (must run from root; uses relative `data/` / `src-tauri/` paths)
python3 scripts/patch_db.py --dry-run           # preview in-place DB patch (no wipe, SRS preserved)
python3 scripts/patch_db.py                     # patch installed hsg.db + stamp seed hash
node --check src/main.js                          # frontend sanity check (no test suite)
cargo check --manifest-path src-tauri/Cargo.toml  # fast backend check
```

No tests, linter, formatter, or CI.

## Data gotchas

- `merge.py` writes atomically (`*.tmp` + rename), exits non-zero on structural failure, prints category counts. Valid categories: `light_verb prep_idiom figurative binomial rephrase inversion mcq three_in_one wordform blank_fill`.
- Never hand-edit `src-tauri/seed.json` or `data/corpus.json` — edit/add `data/part-*.json` / `data/extra-*.json`, then run `merge.py`.
- Changing `seed.json` content bumps its FNV-1a hash in the `meta(seed)` row and triggers **wipe + reload of `items`, `progress`, and `reviews`** on next launch (`seed_if_empty` in `main.rs:144`). Expected, not a bug.
- DB is SQLite WAL at app-data `hsg.db`, never in repo (`.gitignore` covers `*.db`). Old DBs are migrated for the `items.options` column at startup (`open_conn`, `main.rs:114`).

## Backend notes

- Fuzzy accept lives in `fuzzy_accept` (`main.rs:293`): lowercase, collapse spaces, strip punctuation (keep `'`), expand contractions, article-optional pass, US/UK fold, Levenshtein ≤2 (≤3 if len>24) or ratio ≥0.85. Keep thresholds in sync with `README.md` if changed.
- SRS (`srs_update`, `main.rs:331`): correct → reps+1, interval 1/6/`e*interval`; mastered at reps≥5 (retired 60d). Wrong → easiness−0.25, resurface in ~10 min.
- `due_items` caps at 200/batch, excludes caller-passed `seen` ids, mixes overdue (≤50%) with stratified fresh rows. Frontend pages with `FETCH_N=200`, renders `RENDER_N=25` per scroll step.

## Frontend notes

- Browser preview without Tauri works: falls back to CDN `@tauri-apps/api` import, then to fetching `seed.json` directly (exact/CI grading only). Don't break that path.

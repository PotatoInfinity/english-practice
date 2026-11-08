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
- Changing `seed.json` content bumps its FNV-1a hash in the `meta(seed)` row and triggers an **upsert merge** on next launch (`seed_if_empty` in `main.rs`): matched rows keep ids so `progress`/`reviews` survive, new rows insert, vanished rows delete. Use `scripts/patch_db.py` to apply the same merge to an installed DB without relaunch.
- DB is SQLite WAL at app-data `hsg.db`, never in repo (`.gitignore` covers `*.db`). Old DBs are migrated for the `items.options` column at startup (`open_conn`, `main.rs:114`).

## Backend notes

- Fuzzy accept lives in `fuzzy_accept` (`main.rs`): lowercase, collapse spaces, strip punctuation (keep `'`), expand contractions, article-optional pass, US/UK fold, Levenshtein ≤2 (≤3 if len>24) or ratio ≥0.85. Keep thresholds in sync with `README.md` if changed.
- SRS (`srs_update`): correct → reps+1, interval 1/6/`e*interval`; mastered at reps≥5 (repeats ~60d). Wrong → easiness−0.25, resurface in ~10 min. Reps/lapses/next_due drive the frontend's green hydration + stats; the wall itself never filters on them.
- `due_items` is a stable curriculum wall: stratified id-ordered paging (round-robin category x difficulty), caps at 200/batch, excludes caller-passed `seen` ids only. Same query → same order every launch. Frontend pages with `FETCH_N=200`, renders `RENDER_N=25` per scroll step; misses repeat as copies at every 50-row retry wall (`items_by_ids`).

## Frontend notes

- Solved rows hydrate green from `reps>0 && next_due>now`; due reviews and fresh rows stay blank for re-solving.
- `wrongIds` + `lastSolvedId` persist in `localStorage`, so Jump-to-last-solve resumes after restart (ids are stable across rebuilds).
- Browser preview without Tauri works: falls back to CDN `@tauri-apps/api` import, then to fetching `seed.json` directly (exact/CI grading only). Don't break that path.

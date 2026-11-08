# AGENTS.md

Tauri v2 desktop drill app. Vanilla JS frontend (no framework, no bundler) + Rust + SQLite backend. Local-first, zero-config: no server, env, or keys.

## Layout

- `src/main.js`, `src/index.html`, `src/styles.css` — entire frontend. `main.js` calls Rust via `window.__TAURI__.core.invoke`.
- `src-tauri/src/main.rs` — backend: commands `due_items`, `submit_answer`, `items_by_ids`, `stats`, `import_seed`, `reset_progress`.
- `src-tauri/tauri.conf.json` — `frontendDist: ../src`, no `beforeDevCommand`/`beforeBuildCommand`. Bundles `seed.json` as resource.
- `scripts/merge.py` — corpus build pipeline. `data/part-*.json` + `data/extra-*.json` → `data/corpus.json` + `src-tauri/seed.json` (+ `data/quarantine.json`).
- `data/purge-*.json` — blocklists matched pre-repair on punctuation-insensitive prompt+answer. Corrupt lists fail closed (merge aborts).

## Commands (run from repo root)

```sh
npm install
npx tauri dev        # dev run (also `npm run dev`)
npx tauri build      # release build
python3 scripts/merge.py --dry-run                  # preview rebuild (no writes)
python3 scripts/merge.py                            # rebuild corpus + seed (must run from root; uses relative `data/` / `src-tauri/` paths)
python3 scripts/patch_db.py --dry-run           # preview in-place DB patch (no wipe, SRS preserved)
python3 scripts/patch_db.py                     # patch installed hsg.db + stamp seed hash
node --check src/main.js                          # frontend sanity check
cargo test --manifest-path src-tauri/Cargo.toml   # backend tests (fuzzy grading)
cargo check --manifest-path src-tauri/Cargo.toml  # fast backend check
```

5 backend tests (`grading_tests`), no linter/formatter/CI.

## Data gotchas

- `merge.py` writes two-phase atomically (stage all `*.tmp`, then rename corpus+seed+quarantine), `--dry-run` previews with no writes, refuses to write if output < `--min-output` (default 1000), exits non-zero on structural failure or empty input, prints category counts. Valid categories: `light_verb prep_idiom figurative binomial rephrase inversion mcq three_in_one wordform blank_fill`. Dedup keys include prompt; blank_fill exempt from single-word widening; binomial long-suffix quarantined, not truncated.
- Never hand-edit `src-tauri/seed.json` or `data/corpus.json` — edit/add `data/part-*.json` / `data/extra-*.json`, then run `merge.py`.
- Changing `seed.json` content bumps its FNV-1a hash in the `meta(seed)` row and triggers an **upsert merge** on next launch (`seed_if_empty` in `main.rs`): exact 5-tuple → nocat singleton re-tag → sentence fallback keep ids so `progress`/`reviews` survive, new rows insert, vanished rows delete (bundled path only). `import_seed` is additive (never deletes) + skips malformed/intra-batch dupes. Use `scripts/patch_db.py` to apply the same merge to an installed DB without relaunch.
- DB is SQLite WAL at app-data `hsg.db`, never in repo (`.gitignore` covers `*.db`). Startup migrates all post-v1 columns (`options/alternatives/notes/difficulty`), enables `foreign_keys=ON` + `busy_timeout=5000`, verifies WAL (`open_conn`, `main.rs`). `patch_db.py` mirrors the same 3-pass keys, triple-deletes orphans, transacts with rollback + `.bak` + `-wal/-shm` backup.

## Backend notes

- Fuzzy accept lives in `fuzzy_accept` (`main.rs`): lowercase, collapse spaces, strip punctuation (keep `'`), expand contractions (incl. `'s`→is), article-optional pass (3+ token gold gate), one-way UK→US fold (idempotent), Levenshtein ≤2 (≤3 if len>24) or ratio ≥0.85. Keep thresholds in sync with `README.md` if changed.
- SRS (`srs_update`): correct → reps+1, interval 1/6/`e*interval` cap 180d, easiness+0.1 cap 3.0; mastered at reps≥5 (repeats ~60d). Wrong → easiness−0.25 floor 1.3, streak reset, resurface in ~10 min. Reps/lapses/next_due drive the frontend's green hydration + stats; the wall itself never filters on them. `submit_answer`/`reset_progress` are transactional; answers capped 500 chars, imports capped 10MB.
- `due_items` is a stable curriculum wall: single-query id-ordered window stratified in memory (round-robin category x difficulty, L3/L2/L1 rotation), caps at 200/batch, excludes caller-passed `seen` ids only. Same query → same order every launch. Frontend pages with `FETCH_N=200`, renders `RENDER_N=25` per scroll step; misses repeat as copies at every 50-row retry wall (`items_by_ids`, up to 200 ids, caller order preserved).

## Frontend notes

- Solved rows hydrate green from `reps>0 && next_due>now` (✓/✗ markers, not color-only); due reviews and fresh rows stay blank for re-solving.
- `wrongIds` + `lastSolvedId` persist in `localStorage` (queue capped 200 stored / 500 memory, dequeued on solve not render), so Jump-to-last-solve resumes after restart (ids are stable across rebuilds; duplicate wall copies resolve to last occurrence).
- Browser preview without Tauri works: no CDN import, direct `seed.json` fetch (`./seed.json` → `../src-tauri/seed.json` → `seed.json` with `r.ok` check) + full-fuzzy mirror grading with preview badge. Don't break that path. MCQ options shuffle deterministically per id (stable wall order).

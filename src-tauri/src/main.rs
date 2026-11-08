// HSG English Drill — Tauri v2 backend
// SQLite (rusqlite, bundled) + SM-2-lite SRS + fuzzy validation. Zero-config local.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

struct DbState(Mutex<Connection>);

// ---------- models ----------
#[derive(Debug, Serialize, Deserialize, Clone)]
struct Item {
  id: i64,
  category: String,
  prompt: String,
  keyword: String,
  gap_prefix: String,
  gap_suffix: String,
  answer: String,
  full_answer: String,
  alternatives: Vec<String>,
  options: Vec<String>,
  notes: String,
  difficulty: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DueItem {
  #[serde(flatten)]
  item: Item,
  reps: i64,
  lapses: i64,
  interval_days: f64,
  next_due: i64,
}

#[derive(Debug, Serialize)]
struct Verdict {
  correct: bool,
  normalized_user: String,
  normalized_gold: String,
  expected: String,
  full_answer: String,
  alternatives: Vec<String>,
  distance: usize,
  reps: i64,
  lapses: i64,
  next_due: i64,
}

#[derive(Debug, Serialize)]
struct Stats {
  total: i64,
  due_now: i64,
  mastered: i64,
  reviews_today: i64,
  accuracy_7d: f64,
}

// ---------- paths / schema ----------
fn db_path(app: &tauri::AppHandle) -> PathBuf {
  let dir = app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir());
  std::fs::create_dir_all(&dir).ok();
  dir.join("hsg.db")
}

fn fallback_db_path() -> PathBuf {
  dirs::data_dir()
    .unwrap_or_else(std::env::temp_dir)
    .join("hsg-english-drill")
    .join("hsg.db")
}

const SCHEMA: &str = r#"
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  prompt TEXT NOT NULL,
  keyword TEXT NOT NULL,
  gap_prefix TEXT NOT NULL,
  gap_suffix TEXT NOT NULL,
  answer TEXT NOT NULL,
  full_answer TEXT NOT NULL,
  alternatives TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 1,
  options TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_items_cat ON items(category);
CREATE TABLE IF NOT EXISTS progress(
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  easiness REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  next_due INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  mastered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prog_due ON progress(next_due, mastered);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  correct INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta(
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
"#;

fn open_conn(path: &PathBuf) -> Connection {
  if let Some(p) = path.parent() {
    std::fs::create_dir_all(p).ok();
  }
  let conn = Connection::open(path).expect("open sqlite");
  conn.execute_batch(SCHEMA).expect("schema");
  // migrate older DBs: options column for MCQ / 3-in-1 rows
  let has_opts: bool = conn
    .prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='options'")
    .and_then(|mut s| s.exists([]))
    .unwrap_or(false);
  if !has_opts {
    let _ = conn.execute("ALTER TABLE items ADD COLUMN options TEXT NOT NULL DEFAULT '[]'", []);
  }
  conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA cache_size=-64000;")
    .ok();
  conn
}

fn fnv1a64(bytes: &[u8]) -> u64 {
  let mut h: u64 = 0xcbf29ce484222325;
  for b in bytes {
    h ^= *b as u64;
    h = h.wrapping_mul(0x100000001b3);
  }
  h
}

/// Seed the bank; re-seed (wipe + reload) whenever the bundled bank changes,
/// so installed apps pick up bigger banks without manual DB resets.
fn seed_if_empty(conn: &Connection, resource_dir: &PathBuf) {
  let candidates = [
    resource_dir.join("seed.json"),
    PathBuf::from("src-tauri/seed.json"),
    PathBuf::from("data/seed.json"),
    PathBuf::from("seed.json"),
  ];
  let mut txt_opt: Option<String> = None;
  for c in candidates {
    if let Ok(txt) = std::fs::read_to_string(&c) {
      if !txt.trim().is_empty() {
        txt_opt = Some(txt);
        break;
      }
    }
  }
  let txt = txt_opt.or_else(|| {
    std::fs::read_to_string(env!("CARGO_MANIFEST_DIR").to_owned() + "/seed.json").ok()
  });
  let txt = match txt {
    Some(t) => t,
    None => return,
  };
  let ver = format!("{:x}", fnv1a64(txt.as_bytes()));
  let cur: String = conn
    .query_row("SELECT v FROM meta WHERE k='seed'", [], |r| r.get(0))
    .unwrap_or_default();
  if cur == ver {
    return;
  }
  let _ = conn.execute_batch("DELETE FROM reviews; DELETE FROM progress; DELETE FROM items;");
  if insert_seed(conn, &txt).is_ok() {
    let _ = conn.execute("INSERT INTO meta(k,v) VALUES('seed',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v", params![ver]);
  }
}

#[derive(Debug, Deserialize)]
struct SeedItem {
  category: String,
  prompt: String,
  keyword: String,
  gap_prefix: String,
  gap_suffix: String,
  answer: String,
  full_answer: String,
  #[serde(default)]
  alternatives: Vec<String>,
  #[serde(default)]
  options: Vec<String>,
  #[serde(default)]
  notes: String,
  #[serde(default = "one")]
  difficulty: i64,
}
fn one() -> i64 {
  1
}

fn insert_seed(conn: &Connection, txt: &str) -> Result<usize, String> {
  let v: serde_json::Value = serde_json::from_str(txt).map_err(|e| e.to_string())?;
  let arr = if v.is_array() {
    v.as_array().unwrap().clone()
  } else if v.get("items").is_some() {
    v["items"].as_array().cloned().unwrap_or_default()
  } else {
    return Err("seed: expected array or {items:[]}".into());
  };
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  {
    let mut stmt = tx
      .prepare("INSERT INTO items(category,prompt,keyword,gap_prefix,gap_suffix,answer,full_answer,alternatives,notes,difficulty,options) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .map_err(|e| e.to_string())?;
    for raw in arr {
      let s: SeedItem = serde_json::from_value(raw).map_err(|e| e.to_string())?;
      stmt
        .execute(params![
          s.category, s.prompt, s.keyword, s.gap_prefix, s.gap_suffix, s.answer,
          s.full_answer,
          serde_json::to_string(&s.alternatives).unwrap(),
          s.notes, s.difficulty,
          serde_json::to_string(&s.options).unwrap()
        ])
        .map_err(|e| e.to_string())?;
    }
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(0)
}

// ---------- fuzzy validation ----------
fn normalize(s: &str) -> String {
  let mut t = s.to_lowercase();
  t = t.replace(|c: char| c == '’' || c == '`', "'");
  // expand common contractions
  let pairs = [
    ("can't", "can not"), ("won't", "will not"), ("n't", " not"),
    ("'re", " are"), ("'ve", " have"), ("'ll", " will"), ("'d", " would"),
  ];
  for (a, b) in pairs {
    t = t.replace(a, b);
  }
  // strip punctuation except apostrophe, collapse spaces
  let mut out = String::with_capacity(t.len());
  for c in t.chars() {
    if c.is_alphanumeric() || c == '\'' || c == ' ' {
      out.push(c);
    } else if c == '-' || c == '/' || c == '_' {
      out.push(' ');
    } else {
      out.push(' ');
    }
  }
  out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_optional_articles(s: &str) -> String {
  // for lenient pass: remove a/an/the tokens
  s.split_whitespace()
    .filter(|w| *w != "a" && *w != "an" && *w != "the")
    .collect::<Vec<_>>()
    .join(" ")
}

fn us_uk_fold(s: &str) -> String {
  s.replace("ou", "o") // colour->color-ish fold (lenient only)
    .replace("ise", "ize")
}

fn levenshtein(a: &str, b: &str) -> usize {
  let a: Vec<char> = a.chars().collect();
  let b: Vec<char> = b.chars().collect();
  if a.is_empty() {
    return b.len();
  }
  if b.is_empty() {
    return a.len();
  }
  let mut prev: Vec<usize> = (0..=b.len()).collect();
  for i in 1..=a.len() {
    let mut cur = vec![i; b.len() + 1];
    for j in 1..=b.len() {
      let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
      cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
    }
    prev = cur;
  }
  prev[b.len()]
}

fn fuzzy_accept(user: &str, golds: &[String]) -> (bool, usize) {
  let nu = normalize(user);
  let mut best = usize::MAX;
  for g in golds {
    let ng = normalize(g);
    if nu == ng {
      return (true, 0);
    }
    // article-optional pass
    if strip_optional_articles(&nu) == strip_optional_articles(&ng) {
      return (true, 0);
    }
    // us/uk fold pass
    if us_uk_fold(&nu) == us_uk_fold(&ng) {
      return (true, 0);
    }
    let d = levenshtein(&nu, &ng);
    best = best.min(d);
    let long = nu.len().max(ng.len());
    // thresholds: <=2 short, <=3 long (>24 chars), or ratio >=0.85
    let ratio = if long == 0 {
      1.0
    } else {
      1.0 - (d as f64 / long as f64)
    };
    let allow = if long > 24 { 3 } else { 2 };
    if d <= allow || ratio >= 0.85 {
      // guard: single-word binomial order is strict — distance handles it,
      // but reject empty/1-char answers
      if nu.len() >= 2 {
        return (true, d);
      }
    }
  }
  (false, if best == usize::MAX { 999 } else { best })
}

// ---------- SRS ----------
fn srs_update(reps: i64, easiness: f64, interval: f64, correct: bool) -> (i64, f64, f64, i64) {
  let now = Utc::now().timestamp();
  if correct {
    let nr = reps + 1;
    let ni = if nr == 1 {
      1.0
    } else if nr == 2 {
      6.0
    } else {
      (interval * easiness).min(180.0)
    };
    let ne = (easiness + 0.1).min(3.0);
    let mastered = if nr >= 5 { 1 } else { 0 };
    let next = now + (ni * 86400.0) as i64;
    (nr, ne, ni, if mastered == 1 { now + 60 * 86400 } else { next })
  } else {
    let ne = (easiness - 0.25).max(1.3);
    // resurface failed items fast: +10 minutes
    (0, ne, 1.0, now + 600)
  }
}

// ---------- commands ----------
const COLS: &str = "i.id,i.category,i.prompt,i.keyword,i.gap_prefix,i.gap_suffix,i.answer,i.full_answer,i.alternatives,i.notes,i.difficulty,i.options,COALESCE(p.reps,0),COALESCE(p.lapses,0),COALESCE(p.interval_days,0),COALESCE(p.next_due,0)";
const CATS: [&str; 10] = ["light_verb", "prep_idiom", "figurative", "binomial", "rephrase", "inversion", "mcq", "three_in_one", "wordform", "blank_fill"];

/// Fetch loop: overdue SRS items interleaved 1:3 with stratified fresh rows
/// (round-robin across category x difficulty), so every 20-chunk is mixed.
/// `seen` ids are never repeated — the frontend can page to 200 without dupes.
#[tauri::command]
fn due_items(
  state: State<DbState>,
  limit: Option<i64>,
  category: Option<String>,
  seen: Option<Vec<i64>>,
) -> Result<Vec<DueItem>, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  let now = Utc::now().timestamp();
  let lim = limit.unwrap_or(50).clamp(1, 200) as usize;
  let seen_ids: Vec<i64> = seen.unwrap_or_default().into_iter().take(5000).collect();
  let excl = if seen_ids.is_empty() {
    String::new()
  } else {
    format!("AND i.id NOT IN ({})", seen_ids.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","))
  };
  let cats: Vec<&str> = match category {
    Some(ref c) if !c.is_empty() && c != "all" && CATS.contains(&c.as_str()) => vec![c.as_str()],
    _ => CATS.to_vec(),
  };

  // 1) overdue SRS rows (failed/unseen first), excluding seen
  let mut due: Vec<DueItem> = vec![];
  for c in cats.iter().copied() {
    let sql = format!(
      "SELECT {} FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE i.category=?1 AND COALESCE(p.mastered,0)=0 AND COALESCE(p.next_due,0)<=?2 {} ORDER BY COALESCE(p.next_due,0) ASC, RANDOM() LIMIT ?3",
      COLS, excl
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    for r in stmt.query_map(params![c, now, lim as i64], row_to_due).map_err(|e| e.to_string())? {
      due.push(r.map_err(|e| e.to_string())?);
    }
  }
  due.sort_by_key(|d| (d.next_due, d.item.id));
  due.truncate(lim);

  // 2) stratified fresh rows: round-robin across category x difficulty (mixed by construction)
  let mut strata: Vec<Vec<DueItem>> = vec![];
  if due.len() < lim {
    let per = ((lim - due.len()) / (cats.len() * 3) + 2).min(6) as i64;
    for c in cats.iter().copied() {
      for d in 1..=3 {
        let sql = format!(
          "SELECT {} FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE i.category=?1 AND i.difficulty=?2 AND COALESCE(p.mastered,0)=0 {} ORDER BY RANDOM() LIMIT ?3",
          COLS, excl
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Vec<DueItem> = stmt
          .query_map(params![c, d, per], row_to_due)
          .map_err(|e| e.to_string())?
          .collect::<Result<_, _>>()
          .map_err(|e| e.to_string())?;
        if !rows.is_empty() {
          strata.push(rows);
        }
      }
    }
  }
  // 3) interleave 1 due : 3 fresh so every 20-window mixes types, levels, and reviews
  let mut out: Vec<DueItem> = Vec::with_capacity(lim);
  let mut di = 0usize;
  let mut si = vec![0usize; strata.len()];
  let mut made_progress = true;
  while out.len() < lim && made_progress {
    made_progress = false;
    if di < due.len() && (out.len() % 4 == 0 || strata.iter().enumerate().all(|(k, s)| si[k] >= s.len())) {
      out.push(due[di].clone());
      di += 1;
      made_progress = true;
    }
    for (k, s) in strata.iter().enumerate() {
      if out.len() >= lim {
        break;
      }
      if si[k] < s.len() && out.len() % 4 != 0 || (si[k] < s.len() && di >= due.len()) {
        out.push(s[si[k]].clone());
        si[k] += 1;
        made_progress = true;
      }
    }
    if di >= due.len() && si.iter().enumerate().all(|(k, _)| si[k] >= strata[k].len()) {
      break;
    }
  }
  // any leftover due rows still need review — append
  for d in due.into_iter().skip(di) {
    if out.len() >= lim {
      break;
    }
    out.push(d);
  }
  Ok(out)
}

fn row_to_due(r: &rusqlite::Row) -> rusqlite::Result<DueItem> {
  let alt_s: String = r.get(8)?;
  let alternatives: Vec<String> = serde_json::from_str(&alt_s).unwrap_or_default();
  let opt_s: String = r.get(11)?;
  let options: Vec<String> = serde_json::from_str(&opt_s).unwrap_or_default();
  Ok(DueItem {
    item: Item {
      id: r.get(0)?, category: r.get(1)?, prompt: r.get(2)?, keyword: r.get(3)?,
      gap_prefix: r.get(4)?, gap_suffix: r.get(5)?, answer: r.get(6)?,
      full_answer: r.get(7)?, alternatives, options, notes: r.get(9)?, difficulty: r.get(10)?,
    },
    reps: r.get(12)?, lapses: r.get(13)?, interval_days: r.get(14)?, next_due: r.get(15)?,
  })
}

#[tauri::command]
fn submit_answer(state: State<DbState>, item_id: i64, user: String) -> Result<Verdict, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  let (answer, full_answer, alt_s): (String, String, String) = conn
    .query_row("SELECT answer, full_answer, alternatives FROM items WHERE id=?1", params![item_id], |r| {
      Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
    .map_err(|e| e.to_string())?;
  let mut golds = vec![answer.clone()];
  let alts: Vec<String> = serde_json::from_str(&alt_s).unwrap_or_default();
  golds.extend(alts.clone());
  let (correct, dist) = fuzzy_accept(&user, &golds);
  let now = Utc::now().timestamp();
  let (reps, lapses, easiness, interval, next_due): (i64, i64, f64, f64, i64) = conn
    .query_row("SELECT reps,lapses,easiness,interval_days,next_due FROM progress WHERE item_id=?1", params![item_id], |r| {
      Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    })
    .optional()
    .map_err(|e| e.to_string())?
    .unwrap_or((0, 0, 2.5, 0.0, 0));
  let (nr, ne, ni, nd) = srs_update(reps, easiness, interval, correct);
  let nl = if correct { lapses } else { lapses + 1 };
  let mastered = if correct && nr >= 5 { 1 } else { 0 };
  conn.execute(
    "INSERT INTO progress(item_id,reps,lapses,easiness,interval_days,next_due,last_seen,mastered) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(item_id) DO UPDATE SET reps=excluded.reps,lapses=excluded.lapses,easiness=excluded.easiness,interval_days=excluded.interval_days,next_due=excluded.next_due,last_seen=excluded.last_seen,mastered=excluded.mastered",
    params![item_id, nr, nl, ne, ni, nd, now, mastered],
  ).map_err(|e| e.to_string())?;
  conn.execute("INSERT INTO reviews(item_id,ts,correct) VALUES(?1,?2,?3)", params![item_id, now, if correct {1} else {0}])
    .map_err(|e| e.to_string())?;
  let _ = (reps, next_due);
  Ok(Verdict {
    correct,
    normalized_user: normalize(&user),
    normalized_gold: normalize(&answer),
    expected: answer,
    full_answer,
    alternatives: alts,
    distance: dist,
    reps: nr,
    lapses: nl,
    next_due: nd,
  })
}

#[tauri::command]
fn stats(state: State<DbState>) -> Result<Stats, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  let now = Utc::now().timestamp();
  let total: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  let mastered: i64 = conn.query_row("SELECT COUNT(*) FROM progress WHERE mastered=1", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  let due_now: i64 = conn.query_row(
    "SELECT COUNT(*) FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE COALESCE(p.mastered,0)=0 AND COALESCE(p.next_due,0)<=?1",
    params![now], |r| r.get(0)).map_err(|e| e.to_string())?;
  let day_ago = now - 86400;
  let rev: i64 = conn.query_row("SELECT COUNT(*) FROM reviews WHERE ts>=?1", params![day_ago], |r| r.get(0)).map_err(|e| e.to_string())?;
  let ok7: i64 = conn.query_row("SELECT COUNT(*) FROM reviews WHERE ts>=?1 AND correct=1", params![now - 7*86400], |r| r.get(0)).map_err(|e| e.to_string())?;
  let all7: i64 = conn.query_row("SELECT COUNT(*) FROM reviews WHERE ts>=?1", params![now - 7*86400], |r| r.get(0)).map_err(|e| e.to_string())?;
  Ok(Stats { total, due_now, mastered, reviews_today: rev, accuracy_7d: if all7==0 {0.0} else {ok7 as f64/all7 as f64} })
}

#[tauri::command]
fn import_seed(state: State<DbState>, json: String) -> Result<String, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  insert_seed(&conn, &json)?;
  let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  Ok(format!("ok total={}", n))
}

#[tauri::command]
fn reset_progress(state: State<DbState>) -> Result<String, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  conn.execute("DELETE FROM progress", []).map_err(|e| e.to_string())?;
  conn.execute("DELETE FROM reviews", []).map_err(|e| e.to_string())?;
  Ok("reset ok".into())
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      // Prefer app-data dir; fall back to dirs::data_dir for dev (`cargo run`)
      let p = db_path(app.handle());
      let conn = if p.to_string_lossy().contains("tauri") || std::env::var("TAURI_ENV_DEBUG").is_ok() {
        open_conn(&p)
      } else {
        // dev run without bundle id: use fallback stable path
        let f = fallback_db_path();
        open_conn(&f)
      };
      let rd = app.path().resource_dir().unwrap_or_else(|_| std::env::temp_dir());
      seed_if_empty(&conn, &rd);
      app.manage(DbState(Mutex::new(conn)));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![due_items, submit_answer, stats, import_seed, reset_progress])
    .run(tauri::generate_context!())
    .expect("tauri run");
}

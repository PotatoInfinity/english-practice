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

/// Seed the bank; merge bundled bank changes WITHOUT wiping SRS history.
/// Rows match by stable content key (category,prompt,frame,answer): matched rows
/// keep their id so progress/reviews survive; new rows insert; rows gone from
/// the bank delete (progress cascades). The wall order is id-stable, and solved
/// items stay solved across restarts.
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

/// Merge key: case/whitespace-insensitive like merge.py norm() (dedup key).
fn key_norm(s: &str) -> String {
  s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Polish-insensitive sentence form: mirrors merge.py's polish step
/// (no space before closing punctuation, no trailing end mark).
fn sentence_key(s: &str) -> String {
  let t = key_norm(s);
  let mut out = String::with_capacity(t.len());
  let mut pending_space = false;
  for c in t.chars() {
    if c == ' ' {
      pending_space = true;
    } else if ".,;:!?".contains(c) {
      pending_space = false;
      out.push(c);
    } else {
      if pending_space && !out.is_empty() {
        out.push(' ');
      }
      pending_space = false;
      out.push(c);
    }
  }
  out.trim_end_matches(|c| c == '.' || c == '!' || c == '?').to_string()
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
  // existing rows by stable content key -> id (progress lives on the id).
  // Keys are normalized (merge.py dedups on norm), plus a sentence fallback
  // so repair-regrouped rows (same sentence, regrouped frame) keep their id.
  let mut have: std::collections::HashMap<(String, String, String, String, String), i64> =
    std::collections::HashMap::new();
  let mut have_nocat: std::collections::HashMap<(String, String, String, String), Vec<i64>> =
    std::collections::HashMap::new();
  let mut have_sent: std::collections::HashMap<(String, String, String), Vec<i64>> =
    std::collections::HashMap::new();
  {
    let mut q = conn
      .prepare("SELECT id,category,prompt,gap_prefix,gap_suffix,answer,full_answer FROM items")
      .map_err(|e| e.to_string())?;
    let rows = q
      .query_map([], |r| {
        Ok((
          r.get::<_, i64>(0)?,
          r.get::<_, String>(1)?,
          r.get::<_, String>(2)?,
          r.get::<_, String>(3)?,
          r.get::<_, String>(4)?,
          r.get::<_, String>(5)?,
          r.get::<_, String>(6)?,
        ))
      })
      .map_err(|e| e.to_string())?;
    for r in rows {
      let (id, c, p, pre, suf, a, full) = r.map_err(|e| e.to_string())?;
      have.insert((key_norm(&c), key_norm(&p), key_norm(&pre), key_norm(&suf), key_norm(&a)), id);
      have_nocat.entry((key_norm(&p), key_norm(&pre), key_norm(&suf), key_norm(&a))).or_default().push(id);
      have_sent.entry((key_norm(&c), key_norm(&p), sentence_key(&full))).or_default().push(id);
    }
  }
  // validated import: reuse the merge pipeline's shape rules so one malformed
  // row can't poison the bank (it is skipped + counted, like quarantine)
  fn valid_seed(s: &SeedItem) -> bool {
    const CATS: [&str; 10] = ["light_verb", "prep_idiom", "figurative", "binomial", "rephrase", "inversion",
      "mcq", "three_in_one", "wordform", "blank_fill"];
    if !CATS.contains(&s.category.as_str()) || s.prompt.trim().is_empty()
      || s.answer.trim().is_empty() || s.full_answer.trim().is_empty() { return false; }
    if !(1..=3).contains(&s.difficulty) { return false; }
    if s.category == "mcq" {
      let clean: Vec<String> = s.options.iter().map(|a| key_norm(a)).filter(|a| !a.is_empty()).collect();
      if clean.len() != 4 || !clean.contains(&key_norm(&s.answer)) { return false; }
    }
    if s.category == "three_in_one" {
      let clean: Vec<String> = s.options.iter().map(|a| key_norm(a)).filter(|a| !a.is_empty()).collect();
      if clean.len() != 3 || !s.options.iter().all(|a| a.contains("____")) { return false; }
    }
    true
  }
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  let mut n_new = 0usize;
  let mut n_bad = 0usize;
  let mut matched: std::collections::HashSet<i64> = std::collections::HashSet::new();
  {
    let mut upd = tx
      .prepare("UPDATE items SET category=?,keyword=?,gap_prefix=?,gap_suffix=?,answer=?,full_answer=?,alternatives=?,notes=?,difficulty=?,options=? WHERE id=?")
      .map_err(|e| e.to_string())?;
    let mut ins = tx
      .prepare("INSERT INTO items(category,prompt,keyword,gap_prefix,gap_suffix,answer,full_answer,alternatives,notes,difficulty,options) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .map_err(|e| e.to_string())?;
    for raw in arr {
      let s: SeedItem = serde_json::from_value(raw).map_err(|e| e.to_string())?;
      if !valid_seed(&s) {
        n_bad += 1;
        continue;
      }
      let key = (key_norm(&s.category), key_norm(&s.prompt), key_norm(&s.gap_prefix), key_norm(&s.gap_suffix), key_norm(&s.answer));
      // 1) exact (normalized) frame key; 2) same key ignoring category
      // (re-tag keeps history + updates category); 3) same sentence
      // (repair regroup keeps history)
      let mut id = have.remove(&key);
      if id.is_none() {
        let nk = (key.1.clone(), key.2.clone(), key.3.clone(), key.4.clone());
        let take = match have_nocat.get(&nk) {
          Some(v) if v.len() == 1 => Some(v[0]),
          _ => None,
        };
        if let Some(take) = take {
          have_nocat.remove(&nk);
          // drop the stale exact+sentence entries for the kept row
          have.retain(|_, kept| *kept != take);
          if let Some(v) = have_sent.get(&(key.0.clone(), key.1.clone(), sentence_key(&s.full_answer))) {
            if v.contains(&take) {
              have_sent.remove(&(key.0.clone(), key.1.clone(), sentence_key(&s.full_answer)));
            }
          }
          id = Some(take);
        }
      }
      if id.is_none() {
        let sk = (key.0.clone(), key.1.clone(), sentence_key(&s.full_answer));
        let take = match have_sent.get(&sk) {
          Some(v) if v.len() == 1 => Some(v[0]),
          _ => None,
        };
        if let Some(take) = take {
          have_sent.remove(&sk);
          have.retain(|_, kept| *kept != take);
          id = Some(take);
        }
      }
      if let Some(id) = id {
        matched.insert(id);
        upd.execute(params![
          s.category, s.keyword, s.gap_prefix, s.gap_suffix, s.answer, s.full_answer,
          serde_json::to_string(&s.alternatives).unwrap(),
          s.notes, s.difficulty,
          serde_json::to_string(&s.options).unwrap(),
          id
        ]).map_err(|e| e.to_string())?;
      } else {
        ins.execute(params![
          s.category, s.prompt, s.keyword, s.gap_prefix, s.gap_suffix, s.answer,
          s.full_answer,
          serde_json::to_string(&s.alternatives).unwrap(),
          s.notes, s.difficulty,
          serde_json::to_string(&s.options).unwrap()
        ]).map_err(|e| e.to_string())?;
        n_new += 1;
      }
    }
  }
  // rows never matched by any pass vanished from the bank: drop them (progress
  // cascades, orphan reviews cleaned explicitly as reviews has no FK)
  let mut gone: Vec<i64> = have.values().copied().collect();
  for v in have_nocat.values().flatten().chain(have_sent.values().flatten()) {
    if !matched.contains(v) && !gone.contains(v) {
      gone.push(*v);
    }
  }
  for id in gone {
    let _ = tx.execute("DELETE FROM progress WHERE item_id=?1", params![id]);
    let _ = tx.execute("DELETE FROM reviews WHERE item_id=?1", params![id]);
    let _ = tx.execute("DELETE FROM items WHERE id=?1", params![id]);
  }
  tx.commit().map_err(|e| e.to_string())?;
  let _ = n_bad;
  Ok(n_new)
}

// ---------- fuzzy validation ----------
fn normalize(s: &str) -> String {
  let mut t = s.to_lowercase();
  t = t.replace(|c: char| c == '’' || c == '`', "'");
  // expand common contractions
  let pairs = [
    ("can't", "can not"), ("won't", "will not"), ("n't", " not"),
    ("'re", " are"), ("'ve", " have"), ("'ll", " will"), ("'d", " would"),
    ("'m", " am"),
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

// whole-word US/UK map (substring replace over-accepts: soup->sop, promise->promize)
fn us_uk_fold(s: &str) -> String {
  const PAIRS: &[(&str, &str)] = &[
    ("colour", "color"), ("colours", "colors"), ("favour", "favor"),
    ("favours", "favors"), ("favourite", "favorite"), ("favourites", "favorites"),
    ("honour", "honor"), ("honours", "honors"), ("labour", "labor"),
    ("neighbour", "neighbor"), ("neighbours", "neighbors"),
    ("organise", "organize"), ("organised", "organized"), ("organising", "organizing"),
    ("realise", "realize"), ("realised", "realized"), ("realising", "realizing"),
    ("recognise", "recognize"), ("recognised", "recognized"), ("recognising", "recognizing"),
    ("apologise", "apologize"), ("apologised", "apologized"),
    ("emphasise", "emphasize"), ("emphasised", "emphasized"),
    ("behaviour", "behavior"), ("behaviours", "behaviors"),
    ("cancelled", "canceled"), ("cancelling", "canceling"),
    ("travelled", "traveled"), ("travelling", "traveling"),
    ("cheque", "check"), ("cheques", "checks"), ("grey", "gray"),
    ("pyjamas", "pajamas"), ("theatre", "theater"), ("centre", "center"),
    ("metre", "meter"), ("litre", "liter"), ("defence", "defense"),
    ("licence", "license"), ("offence", "offense"), ("practise", "practice"),
  ];
  s.split_whitespace()
    .map(|w| {
      for (uk, us) in PAIRS {
        if w == *uk {
          return us.to_string();
        }
        if w == *us {
          return uk.to_string();
        }
      }
      w.to_string()
    })
    .collect::<Vec<_>>()
    .join(" ")
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
    // combined article + spelling pass (either leniency alone is not enough)
    let fu = us_uk_fold(&nu);
    let fg = us_uk_fold(&ng);
    if strip_optional_articles(&fu) == strip_optional_articles(&fg) {
      // article-only differences still void article drills: require a
      // substantive answer (gold of 3+ tokens) for the article pass
      if ng.split_whitespace().count() >= 3 || fu == fg {
        return (true, 0);
      }
    }
    // us/uk fold pass
    if fu == fg {
      return (true, 0);
    }
    let d = levenshtein(&nu, &ng);
    best = best.min(d);
    // char (not byte) length; short answers forgive nothing, mid one typo
    let long = nu.chars().count().max(ng.chars().count());
    let ratio = if long == 0 {
      1.0
    } else {
      1.0 - (d as f64 / long as f64)
    };
    let allow = if long <= 3 { 0 } else if long <= 8 { 1 } else { 2 };
    // word-concentration guard: the budget must not be spent wiping out one
    // short word ("set the hay" vs "hit the hay" differs by 2 letters in a
    // 3-letter word = a different word, not a typo; "on" vs "in" likewise).
    // Aligned words may differ by at most len/3 letters (0 for 2-letter
    // words, 1 for 3-5 letters, 2 for 6+).
    let words_ok = {
      let uw: Vec<&str> = nu.split(' ').collect();
      let gw: Vec<&str> = ng.split(' ').collect();
      if uw.len() != gw.len() {
        true // different shape: article drops etc. — total budget decides
      } else {
        uw.iter().zip(gw.iter()).all(|(a, b)| {
          let cap = a.chars().count().max(b.chars().count()) / 3;
          levenshtein(a, b) <= cap
        })
      }
    };
    if words_ok && (d <= allow || (long > 8 && ratio >= 0.92)) && nu.chars().count() >= 2 {
      return (true, d);
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

/// Stable curriculum wall: stratified id-ordered paging (round-robin across
/// category x difficulty), so every chunk is mixed and the order is IDENTICAL
/// across restarts/reinstalls. Solved state is NOT filtered here — the frontend
/// hydrates greens from each row's reps/next_due, and misses repeat via the
/// 50-row retry wall. `seen` ids page forward without dupes.
#[tauri::command]
fn due_items(
  state: State<DbState>,
  limit: Option<i64>,
  category: Option<String>,
  seen: Option<Vec<i64>>,
) -> Result<Vec<DueItem>, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  let lim = limit.unwrap_or(50).clamp(1, 200) as usize;
  let seen_ids: Vec<i64> = seen.unwrap_or_default().into_iter().take(20000).collect();
  let excl = if seen_ids.is_empty() {
    String::new()
  } else {
    format!("AND i.id NOT IN ({})", seen_ids.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","))
  };
  let cats: Vec<&str> = match category {
    Some(ref c) if !c.is_empty() && c != "all" && CATS.contains(&c.as_str()) => vec![c.as_str()],
    _ => CATS.to_vec(),
  };

  // stratified pages: fixed id order per category x difficulty (mixed by construction)
  let mut strata: Vec<Vec<DueItem>> = vec![];
  {
    let per = (lim / (cats.len() * 3).max(1) + 2).min(6) as i64;
    for c in cats.iter().copied() {
      for d in 1..=3 {
        let sql = format!(
          "SELECT {} FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE i.category=?1 AND i.difficulty=?2 {} ORDER BY i.id ASC LIMIT ?3",
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
  // runs of 3 per category, cycling CATS in fixed order; difficulty mixed
  // inside each run (L3/L2/L1 rotation)
  let mut fresh: Vec<Vec<Vec<DueItem>>> = cats.iter().map(|_| vec![vec![], vec![], vec![]]).collect();
  for s in strata.into_iter().flatten() {
    let di = (s.item.difficulty.clamp(1, 3) - 1) as usize;
    if let Some(ci) = cats.iter().position(|c| *c == s.item.category.as_str()) {
      fresh[ci][di].push(s);
    }
  }
  const DORD: [usize; 3] = [2, 1, 0]; // L3, L2, L1 rotation
  let mut out: Vec<DueItem> = Vec::with_capacity(lim);
  let mut fcur = vec![vec![0usize; 3]; cats.len()];
  let mut fdiff = vec![0usize; cats.len()];
  while out.len() < lim {
    let mut moved = false;
    for ci in 0..cats.len() {
      for _slot in 0..3 {
        if out.len() >= lim {
          break;
        }
        for k in 0..3 {
          let dxi = DORD[(fdiff[ci] + k) % 3];
          if fcur[ci][dxi] < fresh[ci][dxi].len() {
            out.push(fresh[ci][dxi][fcur[ci][dxi]].clone());
            fcur[ci][dxi] += 1;
            fdiff[ci] = (fdiff[ci] + 1) % 3;
            moved = true;
            break;
          }
        }
      }
      if out.len() >= lim {
        break;
      }
    }
    if !moved {
      break;
    }
  }
  // top-up: strata caps (6 per cell) can leave the batch short of `lim`;
  // fill the rest with plain id-ordered unseen rows so every batch is full
  if out.len() < lim {
    let mut picked: Vec<String> = seen_ids.iter().map(|n| n.to_string()).collect();
    picked.extend(out.iter().map(|d| d.item.id.to_string()));
    let sql = format!(
      "SELECT {} FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE i.id NOT IN ({}) ORDER BY i.id ASC LIMIT ?1",
      COLS,
      if picked.is_empty() { "0".to_string() } else { picked.join(",") }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map(params![(lim - out.len()) as i64], row_to_due)
      .map_err(|e| e.to_string())?;
    for r in rows {
      out.push(r.map_err(|e| e.to_string())?);
    }
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
  // single-letter alternatives are MCQ key letters (A/B/C/D), not answers —
  // never grade them as gold (direct-invoke backdoor)
  golds.extend(alts.iter().filter(|a| normalize(a).chars().count() >= 2).cloned());
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

/// Fetch specific rows by id — powers the 100-question retry wall.
/// Wrong answers get a 2nd chance; wrong again and they queue for the next wall.
#[tauri::command]
fn items_by_ids(state: State<DbState>, ids: Vec<i64>) -> Result<Vec<DueItem>, String> {
  let conn = state.0.lock().map_err(|e| e.to_string())?;
  let ids: Vec<i64> = ids.into_iter().take(200).collect();
  if ids.is_empty() {
    return Ok(vec![]);
  }
  let list = ids.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",");
  let sql = format!("SELECT {} FROM items i LEFT JOIN progress p ON p.item_id=i.id WHERE i.id IN ({})", COLS, list);
  let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
  let rows = stmt.query_map([], row_to_due).map_err(|e| e.to_string())?;
  let mut out = vec![];
  for r in rows {
    out.push(r.map_err(|e| e.to_string())?);
  }
  // preserve caller order (retry queues are meaningful)
  out.sort_by_key(|d: &DueItem| ids.iter().position(|id| *id == d.item.id).unwrap_or(usize::MAX));
  Ok(out)
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
      // Single stable home: bundle-id app-data dir, in dev and prod alike.
      let p = db_path(app.handle());
      let conn = open_conn(&p);
      let rd = app.path().resource_dir().unwrap_or_else(|_| std::env::temp_dir());
      seed_if_empty(&conn, &rd);
      app.manage(DbState(Mutex::new(conn)));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![due_items, submit_answer, stats, import_seed, reset_progress, items_by_ids])
    .run(tauri::generate_context!())
    .expect("tauri run");
}

#[cfg(test)]
mod grading_tests {
  use super::*;
  fn ok(user: &str, gold: &str) -> bool {
    fuzzy_accept(user, &vec![gold.to_string()]).0
  }
  #[test]
  fn wrong_word_rejected() {
    assert!(!ok("set the hay", "hit the hay")); // 2-letter diff inside 3-letter word
    assert!(!ok("on the mat", "in the mat"));
  }
  #[test]
  fn typo_accepted() {
    assert!(ok("hit the hay", "hit the hay"));
    assert!(ok("hiy the hay", "hit the hay")); // 1-letter typo
    assert!(ok("bore a grudge against", "bore a grudge against"));
    assert!(ok("colour", "color")); // us/uk fold
    assert!(ok("a grudge against", "grudge against")); // article pass on 3-token gold
  }
}

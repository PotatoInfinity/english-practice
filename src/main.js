// Vanilla frontend — invokes Rust backend. No framework, instant load.
let previewMode = false;
async function call(cmd, args) {
  const w = window.__TAURI__?.core;
  if (w?.invoke) return w.invoke(cmd, args);
  previewMode = true;
  paintPreviewBadge();
  throw new Error("backend unavailable (preview mode)");
}
function paintPreviewBadge() {
  const el = document.getElementById("bankstat");
  if (el && !document.getElementById("previewBadge")) {
    const b = document.createElement("span");
    b.id = "previewBadge";
    b.textContent = " · preview (exact grading)";
    b.style.fontStyle = "italic";
    el.appendChild(b);
  }
}

let items = [];
let seenIds = new Set();
let rendered = 0;
let fetching = false;
let drained = false;
let lastSolvedId = null; // persisted: Jump to last solve works after restart
let lastSolved = -1;
let wrongIds = [];    // miss queue -> retried at every 50-row wall, re-queued if missed again
let nextWallAt = 50;
let wallBusy = false;
const FETCH_N = 200;   // rows pulled into memory per batch (tiny JSON, SRS state stays in SQLite)
const RENDER_N = 25;   // rows painted per scroll step (keeps DOM light)
const list = document.getElementById("list");
const score = document.getElementById("score");
const moreBox = document.getElementById("more");

async function load() {
  items = [];
  seenIds = new Set();
  rendered = 0;
  drained = false;
  fetching = false;
  wallBusy = false;
  pendingRender = false;
  fetchFailed = false;
  inFlight.clear();
  lastSolved = -1;
  lastSolvedId = null;
  wrongIds = [];
  nextWallAt = 50;
  results = {};
  gradedUser = {};
  revealedSet = {};
  // resume: miss queue + last position survive restarts (ids are stable)
  try {
    const w = JSON.parse(localStorage.getItem("wrongIds") || "[]");
    if (Array.isArray(w)) wrongIds = w.filter(n => Number.isInteger(n) && n > 0).slice(-200);
    const l = JSON.parse(localStorage.getItem("lastSolvedId") || "null");
    if (Number.isInteger(l) && l > 0) lastSolvedId = l;
  } catch (e) { console.error("load resume failed:", e); }
  list.innerHTML = "";
  score.textContent = "";
  score.setAttribute("aria-live", "polite");
  paintSolveStat();
  await fetchMore();
  // persistent progress readout (backend-backed: survives restarts/reinstalls)
  try {
    const s = await call("stats", {});
    if (s && typeof s.total === "number") {
      bankstat(s);
      // backfill only when local is empty (backend reset must lower frontend too)
      if (totalSolves === 0 && Number.isInteger(s.reviews_correct) && s.reviews_correct > 0) {
        totalSolves = s.reviews_correct;
        saveSolveTimes();
        paintSolveStat();
      }
    }
  } catch (e) { console.error("stats failed:", e); }
}

function bankstat(s) {
  const el = document.getElementById("bankstat");
  if (!el) return;
  // preserve preview badge if present
  const hadPreview = !!document.getElementById("previewBadge");
  el.textContent = `${s.mastered}/${s.total} mastered · ${s.due_now} due · ${s.reviews_today} today`;
  if (hadPreview || previewMode) paintPreviewBadge();
}

let previewBank = null; // browser fallback: full seed cached, paged like due_items
let fetchFailed = false;
let pendingRender = false;
const inFlight = new Set();
async function fetchMore() {
  if (fetching || drained) return;
  fetching = true;
  moreBox.textContent = "loading…";
  try {
    try {
      const cat = "all"; // single mixed stream: all 10 types, all levels
      const got = await call("due_items", { limit: FETCH_N, category: cat, seen: [...seenIds] });
      const fresh = got.filter(d => d && d.id != null && !seenIds.has(d.id));
      fresh.forEach(d => seenIds.add(d.id));
      if (fresh.length === 0) {
        // whole bank paged exactly once (stable order) — green finish line
        drained = true;
        renderMore();
        showEndLine();
        return;
      }
      const end = document.getElementById("endline");
      if (end) end.remove();
      items.push(...fresh);
      if (wallBusy) pendingRender = true;
      else renderMore();
    } catch (e1) {
      // browser preview without Tauri: load seed.json directly, page it
      if (!previewBank) {
        const candidates = ["./seed.json", "../src-tauri/seed.json", "seed.json"];
        let lastErr = null;
        for (const u of candidates) {
          try {
            const r = await fetch(u);
            if (!r.ok) { lastErr = new Error(`HTTP ${r.status} for ${u}`); continue; }
            const j = await r.json();
            const arr = Array.isArray(j) ? j : j.items;
            if (!Array.isArray(arr)) { lastErr = new Error(`bad shape for ${u}`); continue; }
            let k = 0;
            // positive synthetic ids so miss-queue filter (>0) and retry work in preview
            previewBank = arr.map(a => ({ id: a.id ?? (1000000 + (++k)), ...a }));
            break;
          } catch (e) { lastErr = e; }
        }
        if (!previewBank) throw lastErr || new Error("preview seed not found");
      }
      const fresh = previewBank.filter(d => !seenIds.has(d.id)).slice(0, FETCH_N);
      fresh.forEach(d => seenIds.add(d.id));
      if (fresh.length === 0) {
        drained = true;
        renderMore();
        showEndLine();
        return;
      }
      items.push(...fresh);
      if (wallBusy) pendingRender = true;
      else renderMore();
    }
  } catch (e2) {
    console.error("fetchMore failed:", e2);
    fetchFailed = true;
    const li = document.createElement("li");
    li.className = "fetcherr";
    const msg = document.createElement("span");
    msg.textContent = `Could not load drill items (${e2?.message || e2}). `;
    const btn = document.createElement("button");
    btn.textContent = "Retry";
    btn.setAttribute("aria-label", "Retry loading drill items");
    btn.onclick = () => { li.remove(); fetchFailed = false; fetching = false; fetchMore(); };
    li.append(msg, btn);
    list.appendChild(li);
    // do NOT set drained: bank is not complete, retry stays possible
  } finally {
    fetching = false;
    moreBox.textContent = drained ? "Bank complete for now — reviews keep cycling." : (fetchFailed ? "Load failed — retry above." : "");
  }
}

// green ending line: the whole bank is on the wall exactly once (stable order).
// Solved stay green via reps hydration; misses get their 50-wall second chance.
async function showEndLine() {
  if (document.getElementById("endline")) return;
  let label = "Bank complete — entire wall loaded. Retry walls appear every 50 rows for misses.";
  try {
    const s = await call("stats", {});
    if (s && typeof s.total === "number") {
      label = `Bank complete — all ${s.total} on the wall · ${s.mastered} mastered · ${s.due_now} due for review`;
    }
  } catch (e) { console.error("showEndLine stats failed:", e); }
  const li = document.createElement("li");
  li.className = "enddiv";
  li.id = "endline";
  li.textContent = label;
  list.appendChild(li);
}

function hashId(id) {
  // deterministic 32-bit hash for stable per-row shuffling (same order every launch)
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function shuffledOpts(d) {
  const opts = (d.options || []).slice();
  let seed = hashId(d.id ?? d.prompt);
  for (let i = opts.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  return opts;
}

function rowFor(d, n) {
  const li = document.createElement("li");
  li.id = "row" + n;
  li.className = "row";
  const p1 = document.createElement("div");
  const answer = (d.answer || "").toString();
  const pre = (d.gap_prefix || "").toString();
  const suf = (d.gap_suffix || "").toString();
  if (d.category === "mcq" && d.options?.length) {
    p1.textContent = stripBracket(d);
    const ol = document.createElement("div");
    ol.className = "opts";
    ol.setAttribute("role", "list");
    shuffledOpts(d).forEach((o) => {
      const r = document.createElement("div");
      r.setAttribute("role", "listitem");
      // find stable 1-based index in original order for keyboard mapping transparency
      const origIdx = (d.options || []).indexOf(o);
      r.textContent = `${origIdx + 1}. ${o}`;
      ol.appendChild(r);
    });
    li.append(p1, ol);
  } else if (d.category === "three_in_one" && d.options?.length) {
    if ((d.options || []).length >= 3) {
      p1.textContent = "Fill ONE word that fits all three sentences:";
      const box = document.createElement("div");
      box.className = "s3";
      (d.options || []).slice(0, 3).forEach(s => {
        const r = document.createElement("div");
        r.innerHTML = `• ${escapeHtml(s).replaceAll("____", "<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>")}`;
        box.appendChild(r);
      });
      li.append(p1, box);
    } else {
      // defensive: <3 options would render a bare input with no sentence
      p1.textContent = stripBracket(d) || "Fill ONE word:";
      li.append(p1);
    }
  } else {
    // keyword badge: show only when the bracket word is part of the answer.
    // If it's already sitting in the frame the badge is noise -> hide it.
    const kw = (d.keyword || "").trim();
    const stem = d.category === "wordform";
    const inAns = wordHit(answer, kw, stem);
    const inFrame = wordHit((pre || "") + " " + (suf || ""), kw, stem);
    let ptext = d.prompt;
    if (inFrame || inAns) ptext = stripBracket(d);
    p1.innerHTML = escapeHtml(ptext) + (inAns && !inFrame && kw ? ` <span class="kw">(${escapeHtml(d.keyword)})</span>` : "");
    // blank_fill prompts usually duplicate the frame — hide only the true
    // duplicates; prompts with extra context (different blank, no blank,
    // ___ vs ____) must stay visible or the item is unsolvable
    const frameBlank = (pre + " ____ " + suf).replace(/_+/g, "____").replace(/\s+/g, " ").trim().toLowerCase();
    const promptBlank = (d.prompt || "").replace(/_+/g, "____").replace(/\s+/g, " ").trim().toLowerCase();
    if (d.category !== "blank_fill" || promptBlank !== frameBlank) li.append(p1);
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.innerHTML = `&rarr; ${escapeHtml(pre)} `;
    p2.appendChild(inpFor(d, n));
    const tail = document.createElement("span");
    tail.textContent = suf && /^[.,;:!?)"'\]\u2014\u2013\(\-—–]/.test(suf) ? suf : " " + (suf || "");
    p2.appendChild(tail);
    li.append(p2);
  }
  if (d.category === "mcq" || d.category === "three_in_one") {
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.appendChild(inpFor(d, n));
    li.append(p2);
  }
  const ans = document.createElement("div");
  ans.className = "ans";
  ans.id = "ans" + n;
  li.append(ans);
  return li;
}

// prompts already end in "(WORD)"; the keyword badge would print it twice
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordHit(hay, kw, stemOk) {
  kw = (kw || "").trim();
  if (!kw) return false;
  hay = hay || "";
  if (stemOk) {
    // wordform: stem prefix counts (USE/useful) but require >=3 letters overlap
    // to avoid false positives like ILL in illegal
    const m = hay.match(/[A-Za-z']+/g) || [];
    const k = kw.toLowerCase();
    if (k.length < 3) return m.some(w => w.toLowerCase() === k);
    return m.some(w => {
      const wl = w.toLowerCase();
      return wl === k || (wl.startsWith(k) && wl.length >= k.length + 2) || (k.startsWith(wl) && k.length >= wl.length + 2);
    });
  }
  // no lookbehind (breaks older Safari): manual word-boundary scan
  const lk = kw.toLowerCase();
  const lh = hay.toLowerCase();
  let idx = 0;
  while (true) {
    idx = lh.indexOf(lk, idx);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : lh[idx - 1];
    const after = lh[idx + lk.length] || "";
    const isWord = c => /[a-z0-9_]/.test(c);
    if (!isWord(before) && !isWord(after)) return true;
    idx += lk.length;
  }
}
function stripBracket(d) {
  const p = d.prompt || "";
  const kw = (d.keyword || "").trim();
  const m = p.match(/\s*\(([^()]+)\)\s*[.?!;:,—–"')\]]*\s*$/);
  if (m && m[1].trim().toLowerCase() === kw.toLowerCase()) {
    return p.slice(0, m.index).trim();
  }
  return p;
}

// normalized compare key: same logical text never double-submits
function normKey(s) { return (s ?? "").trim().toLowerCase(); }

function inpFor(d, n) {
  const wrap = document.createElement("span");
  wrap.className = "gapwrap";
  wrap.id = "wrap" + n;
  const inp = document.createElement("input");
  inp.className = "gap";
  inp.id = "gap" + n;
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("aria-label", `${d.category} answer, item ${n + 1}`);
  inp.setAttribute("aria-describedby", "ans" + n);
  if (d.category === "mcq") inp.setAttribute("title", "Type 1–4, A–D, or the full option text");
  inp.addEventListener("input", () => {
    // typing after a verdict clears stale state so row can be re-answered;
    // guards (gradedUser) reset only when text actually changed
    const cur = inp.value;
    if (normKey(gradedUser[n] ?? "") !== normKey(cur) && n in results) {
      delete results[n];
      delete gradedUser[n];
      if (showFilter !== "all") applyFilter();
    }
    const wrap = document.getElementById("wrap" + n);
    if (wrap) wrap.classList.remove("correct", "wrong");
  });
  inp.addEventListener("keydown", e => {
    if (e.isComposing) return; // IME composition: do not grade mid-compose
    if (e.key !== "Enter") return;
    if (e.shiftKey) { focusPrev(n); return; }
    if (!inp.value.trim()) { focusNext(n); return; }  // blank box: Enter moves forward
    gradeItem(n);
  });
  wrap.appendChild(inp);
  // segmented underline: one dash per word, same total width
  // (2 words = 2 long dashes, 3 = 3 shorter ones, ...)
  const nw = d.category === "mcq" ? 1
    : Math.max(1, (d.answer || "").trim().split(/\s+/).filter(Boolean).length);
  const ul = document.createElement("span");
  ul.className = "uline";
  ul.setAttribute("aria-hidden", "true");
  for (let i = 0; i < nw; i++) ul.appendChild(document.createElement("i"));
  wrap.appendChild(ul);
  return wrap;
}

function renderMore() {
  if (wallBusy) { pendingRender = true; return; } // wall splice owns DOM: queue, don't drop
  const next = items.slice(rendered, rendered + RENDER_N);
  if (!next.length && pendingRender) pendingRender = false;
  const frag = document.createDocumentFragment();
  next.forEach((d, k) => frag.appendChild(rowFor(d, rendered + k)));
  list.appendChild(frag);
  // hydrate solved state from the backend: reps>0 and not yet due -> green
  // WITH answer key + definition (same block fresh solves get).
  // Due reviews (reps>0 but next_due passed) and fresh rows stay blank.
  const nowS = Date.now() / 1000;
  next.forEach((d, k) => {
    const n = rendered + k;
    if (!(n in results) && (d.reps || 0) > 0 && (d.next_due || 0) > nowS) {
      results[n] = true;
      const wrap = document.getElementById("wrap" + n);
      if (wrap) wrap.classList.add("correct");
      const ansEl = document.getElementById("ans" + n);
      if (ansEl) {
        const note = (d.notes || "").trim();
        ansEl.innerHTML = (d.full_answer && d.full_answer !== d.answer)
          ? `<b>${escapeHtml(d.answer)}</b> — ${escapeHtml(d.full_answer)}${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`
          : `<b>${escapeHtml(d.answer)}</b>${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`;
        ansEl.classList.add("show");
      }
    }
  });
  rendered += next.length;
  if (showFilter !== "all") applyFilter(); // new rows obey the active filter
  if (!items.length && !list.children.length) {
    const li = document.createElement("li");
    li.textContent = "No due items — bank empty or all mastered. Try another category.";
    list.appendChild(li);
  }
  maybeWall();
  pumpMore();
}

// stall guard: one viewport-filling pass while the sentinel is still visible
function pumpMore() {
  requestAnimationFrame(() => {
    const r = moreBox.getBoundingClientRect();
    if (r.top > innerHeight + 800 || r.bottom < 0) return;
    if (rendered < items.length) renderMore();
    else if (items.length - rendered < 10 && !drained && !fetching) fetchMore();
  });
}

function saveQueue() {
  try {
    localStorage.setItem("wrongIds", JSON.stringify(wrongIds.slice(-200)));
    localStorage.setItem("lastSolvedId", JSON.stringify(lastSolvedId));
  } catch (e) { console.error("saveQueue failed:", e); }
}

// every 50 rows: second-chance copies of the miss queue (miss again -> next wall).
// Copies are intentional duplicates: the stable wall keeps every item in place.
// Queue is dequeued on SOLVE (gradeItem), not on render — unattempted copies stay queued.
async function maybeWall() {
  if (wallBusy || rendered < nextWallAt) return;
  const ids = [...new Set(wrongIds)].slice(-200);
  if (!ids.length) { nextWallAt = rendered + 50; return; }
  wallBusy = true;
  try {
    let rows;
    try {
      rows = await call("items_by_ids", { ids });
    } catch {
      // browser preview: serve retries from the cached bank
      if (!previewBank) throw new Error("no preview bank");
      rows = previewBank.filter(d => ids.includes(d.id));
    }
    // intentional copies (same id twice in the wall): the retry, then the
    // stable original later. Wall copies always start blank.
    const fresh = rows.filter(d => ids.includes(d.id));
    if (fresh.length) {
      // keep the miss queue intact until solved; advance cadence off pre-wall rendered
      nextWallAt = rendered + 50;
      items.splice(rendered, 0, ...fresh);
      const div = document.createElement("li");
      div.className = "walldiv";
      div.textContent = `— retry wall: ${fresh.length} second chance${fresh.length > 1 ? "s" : ""} —`;
      const endline = document.getElementById("endline");
      if (endline) list.insertBefore(div, endline);
      else list.appendChild(div);
      const frag = document.createDocumentFragment();
      fresh.forEach((d, k) => frag.appendChild(rowFor(d, rendered + k)));
      if (endline) list.insertBefore(frag, endline);
      else list.appendChild(frag);
      rendered += fresh.length;
      if (showFilter !== "all") applyFilter();
    } else {
      nextWallAt = rendered + 50;
    }
  } catch (e) {
    console.error("retry wall skipped:", e);
    // wall skipped this block: keep the queue, advance cadence off rendered
    nextWallAt = rendered + 50;
  }
  wallBusy = false;
  if (pendingRender) { pendingRender = false; renderMore(); return; }
  pumpMore();
}

// infinite scroll: paint more as the sentinel nears the viewport, fetch when low
new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  if (rendered < items.length) renderMore();
  else if (items.length - rendered < 10) fetchMore();
}, { rootMargin: "800px" }).observe(moreBox);

function findLastIdxById(id) {
  // duplicate wall copies share the same item id: prefer the last rendered
  // occurrence so Jump lands on the retry copy, not the stale original
  let found = -1;
  const lim = Math.min(rendered, items.length);
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.id === id) {
      found = i;
      if (i >= lim) break;
    }
  }
  // if the last occurrence is beyond rendered, return it so paging continues
  if (found >= 0) return found;
  return items.findIndex(d => d?.id === id);
}

async function scrollLatest() {
  // resume across restarts: lastSolvedId persists, wall order is stable.
  // Prefer the live in-memory index when it still points at the same row.
  let idx = -1;
  if (lastSolved >= 0 && items[lastSolved] && items[lastSolved].id === lastSolvedId) {
    idx = lastSolved;
  } else if (lastSolvedId != null) {
    idx = findLastIdxById(lastSolvedId);
  } else if (lastSolved >= 0 && items[lastSolved]) {
    idx = lastSolved;
  }
  // page forward until the row is rendered (or the bank is drained)
  for (let guard = 0; (idx < 0 || idx >= rendered) && guard < 2000; guard++) {
    if (rendered < items.length) renderMore();
    else if (drained) break;
    else await fetchMore();
    if (lastSolvedId != null) idx = findLastIdxById(lastSolvedId);
    else if (lastSolved >= 0) idx = lastSolved;
  }
  const el = idx >= 0 && idx < rendered ? document.getElementById("gap" + idx) : null;
  if (el && el.offsetParent !== null) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  else score.textContent = "Solve an item first (Enter in a gap).";
}

function escapeHtml(s) { return (s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

let showFilter = "all";   // all | ok | no
let results = {};         // idx -> true (correct) | false (wrong)
let gradedUser = {};      // idx -> last submitted text (stops double SRS on re-Enter)
let revealedSet = {};     // idx -> true once revealed (terminal: no SRS gaming)

// topbar solve stats: correct-solve count (persisted) + trailing-120s rate.
// New page load = new session: warmup 120s per session, not once-ever.
let sessionStart = Date.now();
try {
  localStorage.setItem("sessionStart", JSON.stringify(sessionStart));
} catch (e) { console.error("sessionStart save failed:", e); }
let solveTimes = [];
let totalSolves = 0;
try {
  const saved = JSON.parse(localStorage.getItem("solveTimes") || "[]");
  if (Array.isArray(saved)) {
    const now = Date.now();
    solveTimes = saved.filter(t => typeof t === "number" && t <= now + 5000 && now - t < 180000).slice(-1000);
  }
  const tot = JSON.parse(localStorage.getItem("totalSolves") || "null");
  if (Number.isInteger(tot) && tot >= 0 && tot <= 10000000) totalSolves = tot;
} catch (e) { console.error("solveTimes load failed:", e); }
function saveSolveTimes() {
  try {
    localStorage.setItem("solveTimes", JSON.stringify(solveTimes.slice(-1000)));
    localStorage.setItem("totalSolves", JSON.stringify(totalSolves));
  } catch (e) { console.error("saveSolveTimes failed:", e); }
}
function paintSolveStat() {
  const el = document.getElementById("solvestat");
  if (!el) return;
  const now = Date.now();
  const cutoff = now - 120000;
  while (solveTimes.length && solveTimes[0] < cutoff - 60000) solveTimes.shift();
  const rate = now - sessionStart < 120000 ? "_" : (solveTimes.filter(t => t >= cutoff).length / 2).toFixed(1);
  el.textContent = `${totalSolves} · ${rate}/min`;
  el.title = "Correct solves, all time · per minute (last 120s; _ = warming up)";
  saveSolveTimes();
}
setInterval(paintSolveStat, 5000);

function applyFilter() {
  for (let n = 0; n < rendered; n++) {
    const li = document.getElementById("row" + n);
    if (!li) continue;
    const r = results[n];
    li.style.display =
      showFilter === "all" ? "" :
      showFilter === "ok" ? (r === true ? "" : "none") :
      (r === false ? "" : "none");
  }
}

function previewFuzzy(user, golds) {
  // mirror of backend fuzzy_accept (normalize + contractions + article + US/UK + Levenshtein)
  const pairs = [["can't","can not"],["won't","will not"],["n't"," not"],["'re"," are"],["'ve"," have"],["'ll"," will"],["'d"," would"],["'m"," am"],["'s"," is"]];
  const norm = s => {
    let t = (s ?? "").toLowerCase().replace(/[’`]/g, "'");
    for (const [a,b] of pairs) t = t.split(a).join(b);
    let out = "";
    for (const c of t) {
      if (/[a-z0-9' ]/.test(c)) out += c;
      else if (c === "-" || c === "/" || c === "_") out += " ";
      else out += " ";
    }
    return out.split(/\s+/).filter(Boolean).join(" ");
  };
  const stripArt = s => norm(s).split(" ").filter(w => w !== "a" && w !== "an" && w !== "the").join(" ");
  const uk2us = new Map([["colour","color"],["colours","colors"],["favour","favor"],["favourite","favorite"],["honour","honor"],["labour","labor"],["neighbour","neighbor"],["organise","organize"],["realise","realize"],["recognise","recognize"],["apologise","apologize"],["behaviour","behavior"],["cancelled","canceled"],["travelled","traveled"],["cheque","check"],["cheques","checks"],["grey","gray"],["theatre","theater"],["centre","center"],["metre","meter"],["litre","liter"],["defence","defense"],["licence","license"],["offence","offense"]]);
  const fold = s => norm(s).split(" ").map(w => uk2us.get(w) || w).join(" ");
  const lev = (a,b) => {
    const A=[...a], B=[...b];
    if (!A.length) return B.length;
    if (!B.length) return A.length;
    let prev=[...Array(B.length+1).keys()];
    for (let i=1;i<=A.length;i++){let cur=[i];for(let j=1;j<=B.length;j++){const c=A[i-1]===B[j-1]?0:1;cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c);}prev=cur;}
    return prev[B.length];
  };
  const nu = norm(user);
  for (const g of golds) {
    const ng = norm(g);
    if (nu === ng) return true;
    const fu=fold(nu), fg=fold(ng);
    if (stripArt(fu)===stripArt(fg) && (ng.split(" ").length>=3 || fu===fg)) return true;
    if (fu===fg) return true;
    const d=lev(nu,ng), L=Math.max([...nu].length,[...ng].length);
    const ratio=L===0?1:1-d/L;
    const allow=L<=3?0:L>24?3:2;
    let ok=true;
    const uw=nu.split(" "), gw=ng.split(" ");
    if (uw.length===gw.length) {
      for (let i=0;i<uw.length;i++){const cap=Math.floor(Math.max(uw[i].length,gw[i].length)/3);if(lev(uw[i],gw[i])>cap){ok=false;break;}}
    }
    if (ok && (d<=allow || ratio>=0.85) && nu.length>=2) return true;
  }
  return false;
}

async function gradeItem(n, quiet = false) {
  if (!Number.isInteger(n) || n < 0 || !items[n]) return null;
  const inp = document.getElementById("gap" + n);
  if (!inp) return null;
  let user = inp.value;
  if (!user.trim()) return null;
  if (revealedSet[n]) {
    // revealed once = given up on this row: never submits, just move on
    if (!quiet) focusNext(n);
    return "revealed";
  }
  if (inFlight.has(n)) return null; // double-Enter race: second submit dropped
  if (n in results && normKey(gradedUser[n]) === normKey(user)) {
    // same logical text re-submitted: restore color, no double SRS hit; advance if solved
    const wrap0 = document.getElementById("wrap" + n);
    if (wrap0) { wrap0.classList.remove("correct", "wrong"); wrap0.classList.add(results[n] ? "correct" : "wrong"); }
    if (results[n] === true && !quiet) {
      const curRow = document.getElementById("row" + n);
      focusNext(n, curRow ? curRow.getBoundingClientRect().top : null);
    }
    return results[n];
  }
  const prev = results[n];
  // pure keyboard MCQ: type 1-4 or A-D, graded as the option text (strict range)
  const opts = items[n].options || [];
  if (items[n].category === "mcq" && opts.length) {
    const t = user.trim().toLowerCase();
    const m = t.match(/^([1-4a-d])[\).\s:\-]*$/);
    if (m) {
      const c = m[1];
      let idx = -1;
      if (/[1-4]/.test(c)) idx = +c - 1;
      else idx = c.charCodeAt(0) - 97;
      if (idx >= 0 && idx < opts.length) user = opts[idx];
      // out-of-range (5-9/z) falls through as literal text: graded wrong with hint
    }
  }
  inFlight.add(n);
  gradedUser[n] = user;
  let correct, expected = items[n].answer, full = items[n].full_answer;
  try {
    const verdict = await call("submit_answer", { itemId: items[n].id, user });
    correct = verdict.correct;
    expected = verdict.expected;
    full = verdict.fullAnswer ?? verdict.full_answer ?? full;
  } catch {
    // browser preview: full-fuzzy mirror so preview ≈ app grading
    const golds = [items[n].answer, ...((items[n].alternatives || []).filter(a => (a||"").trim().length >= 2))];
    correct = previewFuzzy(user, golds);
  } finally {
    inFlight.delete(n);
  }
  inp.classList.remove("correct", "wrong");
  const wrap = document.getElementById("wrap" + n);
  if (wrap) { wrap.classList.remove("correct", "wrong"); wrap.classList.add(correct ? "correct" : "wrong"); }
  // answer key always shown (correct or not), with definition note
  const ans = document.getElementById("ans" + n);
  if (ans) {
    const note = (items[n].notes || "").trim();
    ans.innerHTML = (full && full !== expected)
      ? `<b>${escapeHtml(expected)}</b> — ${escapeHtml(full)}${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`
      : `<b>${escapeHtml(expected)}</b>${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`;
    ans.classList.add("show");
  }
  lastSolved = n;
  lastSolvedId = items[n].id;
  results[n] = correct;
  if (correct) { totalSolves++; solveTimes.push(Date.now()); paintSolveStat(); }
  const wid = items[n].id;
  if (!correct) {
    if (!wrongIds.includes(wid)) {
      wrongIds.push(wid);
      if (wrongIds.length > 500) wrongIds = wrongIds.slice(-500);
    }
  } else if (prev !== false) {
    // first-try or wall-retry correct: dequeue. In-place fix after a miss
    // (prev === false) stays queued so the 50-wall still drills it once.
    wrongIds = wrongIds.filter(x => x !== wid);
  }
  saveQueue();
  // anchor scroll: next question lands where this one was (skipped in bulk Check).
  // Measure AFTER filtering: if the graded row itself got hidden, no anchor.
  if (!quiet) {
    applyFilter();
    const curRow = document.getElementById("row" + n);
    const anchorTop = (curRow && curRow.offsetParent !== null) ? curRow.getBoundingClientRect().top : null;
    focusNext(n, anchorTop);
  }
  return correct;
}

// Enter grades, then jumps to the next unsolved gap — pure keyboard flow
// The next row is scrolled to the graded row's viewport position (no jump).
// Shift+Enter jumps back to the previous gap
function focusPrev(n) {
  for (let k = n - 1; k >= 0; k--) {
    if (k in results || revealedSet[k]) continue;
    const el = document.getElementById("gap" + k);
    if (el && el.offsetParent !== null) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); return; }
  }
}
function visTop(el) {
  const li = el.closest("li");
  return (li || el).getBoundingClientRect().top;
}
async function focusNext(n, anchorTop = null) {
  for (let pass = 0; pass < 2; pass++) {
    const wrapped = pass > 0; // teleported to wall start: smooth + centered
    for (let k = (pass ? 0 : n + 1); k < (pass ? n + 1 : rendered); k++) {
      if (k in results || revealedSet[k]) continue;
      const el = document.getElementById("gap" + k);
      if (el && el.offsetParent !== null) {
        el.focus({ preventScroll: true });
        if (anchorTop !== null && !wrapped) {
          window.scrollBy(0, visTop(el) - anchorTop);
          // content-visibility estimates shift layout: re-measure and correct
          requestAnimationFrame(() => window.scrollBy(0, visTop(el) - anchorTop));
        } else {
          el.scrollIntoView({ behavior: wrapped ? "smooth" : undefined, block: wrapped ? "center" : "nearest" });
        }
        return;
      }
    }
  }
  // everything rendered is solved: page the wall forward and continue there
  if (rendered < items.length) { renderMore(); return focusNext(n); }
  if (!drained) { await fetchMore(); return focusNext(n); }
}

async function check() {
  const total = rendered;
  let ok = 0, done = 0;
  for (let n = 0; n < total; n++) {
    if (!items[n]) continue;
    if (results[n] === true || revealedSet[n]) continue; // solved or given up: untouched
    // unsolved + missed rows re-grade; unchanged text returns cached, no double SRS
    const r = await gradeItem(n, true);
    if (r === null || r === "revealed") continue;
    done++;
    if (r) ok++;
  }
  applyFilter();
  score.textContent = done ? `${ok}/${done} correct. Wrong ones resurface at the retry wall.` : "Type an answer first.";
  score.setAttribute("aria-live", "polite");
}

function reveal() {
  // reveal = give up on UNSOLVED rows only; solved rows and prior states kept.
  // Revealed rows are terminal (no SRS submit afterwards) to block free solves.
  for (let n = 0; n < rendered; n++) {
    if (n in results || revealedSet[n]) continue;
    const d = items[n];
    if (!d) continue;
    const ans = document.getElementById("ans" + n);
    const inp = document.getElementById("gap" + n);
    if (!ans || !inp) continue;
    inp.value = d.answer;
    revealedSet[n] = true;
    const note = (d.notes || "").trim();
    const fa = (d.full_answer || "").trim();
    ans.innerHTML = (fa && fa !== d.answer)
      ? `<b>${escapeHtml(d.answer)}</b> — ${escapeHtml(fa)}${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`
      : `<b>${escapeHtml(d.answer)}</b>${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}`;
    ans.classList.add("show");
  }
  applyFilter();
}

document.getElementById("check").onclick = check;
document.getElementById("reveal").onclick = reveal;
document.getElementById("latest").onclick = scrollLatest;
document.getElementById("theme").onclick = () => {
  const dark = document.body.classList.toggle("dark");
  document.getElementById("theme").textContent = dark ? "Light" : "Dark";
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) { console.error("theme save failed:", e); }
};
try { if (localStorage.getItem("theme") === "dark") document.getElementById("theme").onclick(); } catch (e) { console.error("theme load failed:", e); }
try {
  const fs = parseInt(localStorage.getItem("fs") || "", 10);
  if (Number.isInteger(fs) && fs >= 10 && fs <= 20) {
    document.getElementById("fs").value = String(fs);
    document.getElementById("fs").setAttribute("aria-label", `Text size ${fs} pixels`);
    document.documentElement.style.setProperty("--fs", fs + "px");
  }
} catch (e) { console.error("fs load failed:", e); }
document.getElementById("fs").oninput = e => {
  const v = Math.min(20, Math.max(10, parseInt(e.target.value, 10) || 16));
  document.documentElement.style.setProperty("--fs", v + "px");
  e.target.setAttribute("aria-label", `Text size ${v} pixels`);
  try { localStorage.setItem("fs", String(v)); } catch (err) { console.error("fs save failed:", err); }
};
document.querySelectorAll("#filters button").forEach(b => {
  b.onclick = () => {
    showFilter = b.dataset.f;
    document.querySelectorAll("#filters button").forEach(x => {
      const on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    applyFilter();
  };
});

// Pomodoro focus timer: 25 focus / 5 rest, long 15 every 4th. Text-only,
// drift-free (fractional seconds kept internally), phase persisted (paused).
const POMO = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
let pomo = { mode: "focus", left: POMO.focus, endAt: 0, running: false, block: 0 };
try {
  const saved = JSON.parse(localStorage.getItem("pomo") || "{}");
  if (Number.isInteger(saved.done) && saved.done >= 0 && saved.done <= 100000) pomoDoneSet(saved.done);
  if (typeof saved.left === "number" && saved.left > 0 && saved.left <= POMO.focus
      && ["focus", "short", "long"].includes(saved.mode)
      && Number.isInteger(saved.block) && saved.block >= 0) {
    pomo.left = saved.left;
    pomo.mode = saved.mode;
    pomo.block = saved.block;
  }
} catch (e) { console.error("pomo load failed:", e); }
function pomoDoneGet() { return parseInt(document.getElementById("pomoDone").dataset.n || "0", 10); }
function pomoDoneSet(n) {
  const el = document.getElementById("pomoDone");
  el.dataset.n = String(n);
  el.textContent = n > 0 ? `${n}` : "";
  pomoSave();
}
function pomoSave() {
  try {
    localStorage.setItem("pomo", JSON.stringify({
      done: pomoDoneGet(), left: Math.round(pomo.left), mode: pomo.mode, block: pomo.block,
    }));
  } catch (e) { console.error("pomo save failed:", e); }
}
function fmt(s) { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function pomoPaint() {
  const label = pomo.mode === "focus" ? "Focus" : (pomo.mode === "short" ? "Rest" : "Long rest");
  document.getElementById("pomoTime").textContent = `${label} ${fmt(pomo.left)}`;
  // title shows the clock only while running; idle restores the app name
  document.title = pomo.running ? `${fmt(pomo.left)} — HSG English Drill` : "HSG English Drill";
  document.getElementById("pomoStart").textContent = pomo.running ? "Pause" : "Start";
  const dots = pomo.mode === "long" ? 4 : pomo.block % 4; // long rest keeps all 4 lit
  document.getElementById("pomoDots").textContent = "●".repeat(dots) + "○".repeat(4 - dots);
}
let beepCtx = null;
function beep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (beepCtx.state === "suspended") beepCtx.resume();
    [0, 0.35].forEach((t, i) => {
      const o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.connect(g); g.connect(beepCtx.destination);
      o.frequency.value = i ? 660 : 880;
      g.gain.setValueAtTime(0.12, beepCtx.currentTime + t);
      o.start(beepCtx.currentTime + t); o.stop(beepCtx.currentTime + t + 0.3);
    });
  } catch { /* silent */ }
}
function pomoAdvance(credit) {
  if (credit && pomo.mode === "focus") {
    pomo.block++;
    pomoDoneSet(pomoDoneGet() + 1);
  }
  pomo.mode = pomo.mode === "focus" ? ((pomo.block % 4 === 0 && pomo.block > 0) ? "long" : "short") : "focus";
  pomo.left = POMO[pomo.mode];
  pomo.running = false;
  pomoPaint();
  pomoSave();
}
setInterval(() => {
  if (!pomo.running) return;
  pomo.left = Math.max(0, (pomo.endAt - Date.now()) / 1000); // float: no pause drift
  if (pomo.left <= 0) { beep(); pomoAdvance(true); }
  else pomoPaint();
}, 500);
document.getElementById("pomoStart").onclick = () => {
  if (beepCtx && beepCtx.state === "suspended") beepCtx.resume();
  pomo.running = !pomo.running;
  if (pomo.running) pomo.endAt = Date.now() + pomo.left * 1000;
  pomoPaint();
  pomoSave();
};
document.getElementById("pomoSkip").onclick = () => { pomoAdvance(false); pomoSave(); };
pomoPaint();
load();

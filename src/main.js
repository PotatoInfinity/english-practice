// Vanilla frontend — invokes Rust backend. No framework, instant load.
async function call(cmd, args) {
  const w = window.__TAURI__?.core;
  if (w?.invoke) return w.invoke(cmd, args);
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/core.js");
    return mod.invoke(cmd, args);
  } catch (e) { throw new Error("backend unavailable: " + e); }
}

let items = [];
let seenIds = new Set();
let rendered = 0;
let fetching = false;
let drained = false;
let lastSolvedId = null; // persisted: Jump to last solve works after restart
let lastSolved = -1;
let wrongIds = [];    // miss queue -> retried at every 50-row wall, re-queued if missed again
let everWrong = new Set(); // ids missed at least once: stay queued even after in-place fix
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
  lastSolved = -1;
  lastSolvedId = null;
  wrongIds = [];
  everWrong = new Set();
  nextWallAt = 50;
  results = {};
  gradedUser = {};
  // resume: miss queue + last position survive restarts (ids are stable)
  try {
    const w = JSON.parse(localStorage.getItem("wrongIds") || "[]");
    if (Array.isArray(w)) wrongIds = w.filter(n => typeof n === "number").slice(-200);
    const l = JSON.parse(localStorage.getItem("lastSolvedId") || "null");
    if (typeof l === "number") lastSolvedId = l;
  } catch { /* fresh */ }
  list.innerHTML = "";
  score.textContent = "";
  await fetchMore();
  // persistent progress readout (backend-backed: survives restarts/reinstalls)
  try {
    const s = await call("stats", {});
    if (s && typeof s.total === "number") {
      score.textContent = `${s.mastered}/${s.total} mastered · ${s.due_now} due · ${s.reviews_today} today`;
    }
  } catch { /* browser preview: no backend */ }
}

async function fetchMore() {
  if (fetching || drained) return;
  fetching = true;
  moreBox.textContent = "loading…";
  try {
    const cat = "all"; // single mixed stream: all 10 types, all levels
    const got = await call("due_items", { limit: FETCH_N, category: cat, seen: [...seenIds] });
    const fresh = got.filter(d => !seenIds.has(d.id));
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
    renderMore();
  } catch (e1) {
    try {
      // browser preview without Tauri: load seed.json directly
      const r = await fetch("../src-tauri/seed.json").catch(() => fetch("./seed.json"));
      const j = await r.json();
      const arr = Array.isArray(j) ? j : j.items;
      const fresh = arr
        .filter(a => !seenIds.has(a.id ?? -1))
        .slice(0, FETCH_N)
        .map((a, i) => ({ id: a.id ?? Date.now() + i, ...a }));
      fresh.forEach(d => seenIds.add(d.id));
      drained = true;
      items.push(...fresh);
      renderMore();
    } catch (e2) {
      const li = document.createElement("li");
      li.textContent = `Could not load drill items (${String(e1).slice(0, 120)}). Restart the app.`;
      list.appendChild(li);
      drained = true;
    }
  }
  fetching = false;
  moreBox.textContent = drained ? "Bank complete for now — reviews keep cycling." : "";
}

// green ending line: the whole bank is on the wall exactly once (stable order).
// Solved stay green via reps hydration; misses get their 50-wall second chance.
async function showEndLine() {
  if (document.getElementById("endline")) return;
  let label = "Bank complete — entire wall loaded.";
  try {
    const s = await call("stats", {});
    if (s && typeof s.total === "number") {
      label = `Bank complete — all ${s.total} on the wall · ${s.mastered} mastered · ${s.due_now} due for review`;
    }
  } catch { /* preview fallback keeps the static label */ }
  const li = document.createElement("li");
  li.className = "enddiv";
  li.id = "endline";
  li.textContent = label;
  list.appendChild(li);
}

function rowFor(d, n) {
  const li = document.createElement("li");
  li.id = "row" + n;
  const p1 = document.createElement("div");
  if (d.category === "mcq" && d.options?.length) {
    p1.textContent = stripBracket(d);
    const ol = document.createElement("div");
    ol.className = "opts";
    d.options.forEach((o, i) => {
      const r = document.createElement("div");
      r.textContent = `${i + 1}. ${o}`;
      ol.appendChild(r);
    });
    li.append(p1, ol);
  } else if (d.category === "three_in_one" && d.options?.length >= 3) {
    p1.textContent = "Fill ONE word that fits all three sentences:";
    const box = document.createElement("div");
    box.className = "s3";
    d.options.slice(0, 3).forEach(s => {
      const r = document.createElement("div");
      r.innerHTML = `• ${escapeHtml(s).replaceAll("____", "<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>")}`;
      box.appendChild(r);
    });
    li.append(p1, box);
  } else {
    // keyword badge: show only when the bracket word is part of the answer.
    // If it's already sitting in the frame the badge is noise -> hide it.
    const kw = (d.keyword || "").trim();
    const inAns = wordHit(d.answer, kw, d.category === "wordform");
    const inFrame = wordHit((d.gap_prefix || "") + " " + (d.gap_suffix || ""), kw, false);
    let ptext = d.prompt;
    if (inFrame || inAns) ptext = stripBracket(d);
    p1.innerHTML = escapeHtml(ptext) + (inAns && !inFrame && kw ? ` <span class="kw">(${escapeHtml(d.keyword)})</span>` : "");
    // blank_fill prompts usually duplicate the frame — hide only the true
    // duplicates; prompts with extra context (different blank, no blank,
    // ___ vs ____) must stay visible or the item is unsolvable
    const frameBlank = ((d.gap_prefix || "") + " ____ " + (d.gap_suffix || "")).replace(/_+/g, "____").replace(/\s+/g, " ").trim().toLowerCase();
    const promptBlank = (d.prompt || "").replace(/_+/g, "____").replace(/\s+/g, " ").trim().toLowerCase();
    if (d.category !== "blank_fill" || promptBlank !== frameBlank) li.append(p1);
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.innerHTML = `&rarr; ${escapeHtml(d.gap_prefix)} `;
    p2.appendChild(inpFor(d, n));
    const tail = document.createElement("span");
    tail.textContent = d.gap_suffix && /^[.,;:!?]/.test(d.gap_suffix) ? d.gap_suffix : " " + (d.gap_suffix || "");
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
    // wordform: stem prefix counts (USE/useful, ILL/illness)
    const m = hay.match(/[A-Za-z']+/g) || [];
    const k = kw.toLowerCase();
    return m.some(w => w.toLowerCase() === k || w.toLowerCase().startsWith(k));
  }
  return new RegExp(`(?<![A-Za-z0-9_])${escRe(kw)}(?![A-Za-z0-9_])`, "i").test(hay);
}
function stripBracket(d) {
  const p = d.prompt || "";
  const kw = (d.keyword || "").trim();
  const m = p.match(/\s*\(([^()]+)\)\s*[.?!;:,]*\s*$/);
  if (m && m[1].trim().toLowerCase() === kw.toLowerCase()) {
    return p.slice(0, m.index).trim();
  }
  return p;
}

function inpFor(d, n) {
  const wrap = document.createElement("span");
  wrap.className = "gapwrap";
  wrap.id = "wrap" + n;
  const inp = document.createElement("input");
  inp.className = "gap";
  inp.id = "gap" + n;
  inp.setAttribute("autocomplete", "off");
  inp.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) { focusPrev(n); return; }
    if (!inp.value.trim()) { focusPrev(n); return; }  // blank box: Enter goes back
    gradeItem(n);
  });
  wrap.appendChild(inp);
  // segmented underline: one dash per word, same total width
  // (2 words = 2 long dashes, 3 = 3 shorter ones, ...)
  const nw = d.category === "mcq" ? 1
    : Math.max(1, (d.answer || "").trim().split(/\s+/).filter(Boolean).length);
  const ul = document.createElement("span");
  ul.className = "uline";
  for (let i = 0; i < nw; i++) ul.appendChild(document.createElement("i"));
  wrap.appendChild(ul);
  return wrap;
}

function renderMore() {
  const next = items.slice(rendered, rendered + RENDER_N);
  const frag = document.createDocumentFragment();
  next.forEach((d, k) => frag.appendChild(rowFor(d, rendered + k)));
  list.appendChild(frag);
  // hydrate solved state from the backend: reps>0 and not yet due -> green.
  // Due reviews (reps>0 but next_due passed) and fresh rows stay blank.
  const nowS = Date.now() / 1000;
  next.forEach((d, k) => {
    const n = rendered + k;
    if (!(n in results) && (d.reps || 0) > 0 && (d.next_due || 0) > nowS) {
      results[n] = true;
      const wrap = document.getElementById("wrap" + n);
      if (wrap) wrap.classList.add("correct");
    }
  });
  rendered += next.length;
  if (!items.length && !list.children.length) {
    const li = document.createElement("li");
    li.textContent = "No due items — bank empty or all mastered. Try another category.";
    list.appendChild(li);
  }
  maybeWall();
}

function saveQueue() {
  try {
    localStorage.setItem("wrongIds", JSON.stringify(wrongIds.slice(-200)));
    localStorage.setItem("lastSolvedId", JSON.stringify(lastSolvedId));
  } catch { /* private mode */ }
}

// every 50 rows: second-chance copies of the miss queue (miss again -> next wall).
// Copies are intentional duplicates: the stable wall keeps every item in place.
async function maybeWall() {
  if (wallBusy || rendered < nextWallAt) return;
  const ids = [...new Set(wrongIds)];
  nextWallAt += 50;
  if (!ids.length) return;
  wallBusy = true;
  // dequeue what we are about to render; misses re-queue on next grade
  wrongIds = [];
  saveQueue();
  try {
    const rows = await call("items_by_ids", { ids });
    // intentional copies (same id twice in the wall): the retry, then the
    // stable original later. Wall copies always start blank.
    const fresh = rows.filter(d => ids.includes(d.id));
    if (fresh.length) {
      items.splice(rendered, 0, ...fresh);
      const div = document.createElement("li");
      div.className = "walldiv";
      div.textContent = `— retry wall: ${fresh.length} second chance${fresh.length > 1 ? "s" : ""} —`;
      list.appendChild(div);
      const frag = document.createDocumentFragment();
      fresh.forEach((d, k) => frag.appendChild(rowFor(d, rendered + k)));
      list.appendChild(frag);
      rendered += fresh.length;
    }
  } catch { /* wall skipped this block */ }
  wallBusy = false;
}

// infinite scroll: paint more as the sentinel nears the viewport, fetch when low
new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  if (rendered < items.length) renderMore();
  else if (items.length - rendered < 10) fetchMore();
}, { rootMargin: "800px" }).observe(moreBox);

async function scrollLatest() {
  // resume across restarts: lastSolvedId persists, wall order is stable
  let sid = lastSolvedId;
  if (sid == null) {
    if (lastSolved < 0 || !items[lastSolved]) { score.textContent = "Solve an item first (Enter in a gap)."; return; }
    sid = items[lastSolved].id;
  }
  let idx = items.findIndex(d => d.id === sid);
  // page forward until the row is rendered (or the bank is drained)
  for (let guard = 0; (idx < 0 || idx >= rendered) && guard < 40; guard++) {
    if (rendered < items.length) renderMore();
    else if (drained) break;
    else await fetchMore();
    idx = items.findIndex(d => d.id === sid);
  }
  const el = idx >= 0 ? document.getElementById("row" + idx) : null;
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  else score.textContent = "Solve an item first (Enter in a gap).";
}

function escapeHtml(s) { return (s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

let showFilter = "all";   // all | ok | no
let results = {};         // idx -> true (correct) | false (wrong)
let gradedUser = {};      // idx -> last submitted text (stops double SRS on re-Enter)

// topbar solve stats: correct-solve count + trailing-120s solves/min
// ("_" until the session is 120s old). Count persists across restarts.
let sessionStart = Date.now();
let solveTimes = [];
try {
  const saved = JSON.parse(localStorage.getItem("solveTimes") || "[]");
  if (Array.isArray(saved)) solveTimes = saved.filter(t => typeof t === "number" && Date.now() - t < 180000).slice(-1000);
} catch { /* fresh */ }
function saveSolveTimes() {
  try { localStorage.setItem("solveTimes", JSON.stringify(solveTimes.slice(-1000))); } catch { /* private mode */ }
}
function paintSolveStat() {
  const el = document.getElementById("solvestat");
  if (!el) return;
  const n = solveTimes.length;
  const age = Date.now() - sessionStart;
  const cutoff = Date.now() - 120000;
  while (solveTimes.length && solveTimes[0] < cutoff - 60000) solveTimes.shift();
  const rate = age < 120000 ? "_" : (solveTimes.filter(t => t >= cutoff).length / 2).toFixed(1);
  el.textContent = `${n} · ${rate}/min`;
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

async function gradeItem(n, quiet = false) {
  const inp = document.getElementById("gap" + n);
  let user = inp.value;
  if (!user.trim()) return null;
  if (results[n] === "revealed") {
    // unedited reveal fill is not a solve — user must type something first
    if (user === items[n].answer) return null;
    delete results[n];
  } else if (n in results && gradedUser[n] === user) {
    return results[n]; // same text re-submitted: no double SRS hit
  }
  const prev = results[n];
  // pure keyboard MCQ: type 1-4 or A-D, graded as the option text
  const opts = items[n].options || [];
  if (items[n].category === "mcq" && opts.length) {
    const t = user.trim().toLowerCase();
    const m = t.match(/^([1-9a-z])[\).\s:\-]*$/);
    if (m) {
      const c = m[1];
      let idx = -1;
      if (/[1-9]/.test(c)) idx = +c - 1;
      else idx = c.charCodeAt(0) - 97;
      if (idx >= 0 && idx < opts.length) user = opts[idx];
    }
  }
  let correct, expected = items[n].answer, full = items[n].full_answer;
  try {
    const verdict = await call("submit_answer", { itemId: items[n].id, user });
    correct = verdict.correct;
    expected = verdict.expected;
    full = verdict.fullAnswer ?? verdict.full_answer ?? full;
  } catch {
    // browser fallback: exact/ci compare
    correct = user.toLowerCase().trim() === items[n].answer.toLowerCase().trim();
  }
  inp.classList.remove("correct", "wrong");
  const wrap = document.getElementById("wrap" + n);
  if (wrap) { wrap.classList.remove("correct", "wrong"); wrap.classList.add(correct ? "correct" : "wrong"); }
  // answer key always shown (correct or not), with definition note
  const ans = document.getElementById("ans" + n);
  if (ans) {
    ans.innerHTML = `<b>${escapeHtml(expected)}</b> — ${escapeHtml(full)}<div class="note">${escapeHtml(items[n].notes || "")}</div>`;
    ans.classList.add("show");
  }
  lastSolved = n;
  lastSolvedId = items[n].id;
  results[n] = correct;
  gradedUser[n] = user;
  if (correct) { solveTimes.push(Date.now()); paintSolveStat(); }
  const wid = items[n].id;
  if (!correct) {
    everWrong.add(wid);
    if (!wrongIds.includes(wid)) wrongIds.push(wid);
  } else if (prev !== false) {
    // first-try or wall-retry correct: dequeue. In-place fix after a miss
    // (prev === false) stays queued so the 50-wall still drills it once.
    wrongIds = wrongIds.filter(x => x !== wid);
  }
  saveQueue();
  // anchor scroll: next question lands where this one was (skipped in bulk Check)
  if (!quiet) {
    const curRow = document.getElementById("row" + n);
    const anchorTop = curRow ? curRow.getBoundingClientRect().top : null;
    applyFilter();
    focusNext(n, anchorTop);
  }
  return correct;
}

// Enter grades, then jumps to the next unsolved gap — pure keyboard flow
// The next row is scrolled to the graded row's viewport position (no jump).
// Shift+Enter jumps back to the previous gap
function focusPrev(n) {
  for (let k = n - 1; k >= 0; k--) {
    const el = document.getElementById("gap" + k);
    if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); return; }
  }
}
async function focusNext(n, anchorTop = null) {
  for (let pass = 0; pass < 2; pass++) {
    for (let k = (pass ? 0 : n + 1); k < (pass ? n + 1 : rendered); k++) {
      if (!(k in results)) {
        const el = document.getElementById("gap" + k);
        if (el) {
          el.focus();
          if (anchorTop !== null) {
            const li = el.closest("li");
            const t = (li || el).getBoundingClientRect().top;
            window.scrollBy(0, t - anchorTop);
          } else {
            el.scrollIntoView({ block: "nearest" });
          }
          return;
        }
      }
    }
  }
  // everything rendered is solved: page the wall forward and continue there
  if (rendered < items.length) { renderMore(); focusNext(n); return; }
  if (!drained) { await fetchMore(); focusNext(n); }
}

async function check() {
  let ok = 0, done = 0;
  for (let n = 0; n < rendered; n++) {
    if (results[n] === true || results[n] === "revealed") {
      done++;
      if (results[n] === true) ok++;
      continue;
    }
    // unsolved + missed rows re-grade; unchanged text returns cached, no double SRS
    const r = await gradeItem(n, true);
    if (r === null) continue;
    done++;
    if (r) ok++;
  }
  applyFilter();
  score.textContent = done ? `${ok}/${done} correct. Wrong ones resurface first. Reveal shows answers.` : "Type an answer first.";
}

function reveal() {
  for (let n = 0; n < rendered; n++) {
    const d = items[n];
    const ans = document.getElementById("ans" + n);
    const inp = document.getElementById("gap" + n);
    if (!ans || !inp) continue;
    inp.value = d.answer;
    // mark revealed so Check won't grade it as a genuine solve
    results[n] = "revealed";
    const wrap = document.getElementById("wrap" + n);
    if (wrap) wrap.classList.remove("correct", "wrong");
    ans.innerHTML = `<b>${escapeHtml(d.answer)}</b> — ${escapeHtml(d.full_answer)}`;
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
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch { /* private mode */ }
};
try { if (localStorage.getItem("theme") === "dark") document.getElementById("theme").onclick(); } catch { /* fresh */ }
document.getElementById("fs").oninput = e => {
  document.documentElement.style.setProperty("--fs", e.target.value + "px");
  try { localStorage.setItem("fs", e.target.value); } catch { /* private mode */ }
};
try {
  const fs = localStorage.getItem("fs");
  if (fs) { document.getElementById("fs").value = fs; document.documentElement.style.setProperty("--fs", fs + "px"); }
} catch { /* fresh */ }
document.querySelectorAll("#filters button").forEach(b => {
  b.onclick = () => {
    showFilter = b.dataset.f;
    document.querySelectorAll("#filters button").forEach(x => x.classList.toggle("on", x === b));
    applyFilter();
  };
});

// Pomodoro focus timer: 25 focus / 5 rest, long 15 every 4th. Text-only,
// deadline-based (no drift), completions persisted in localStorage.
const POMO = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
let pomo = { mode: "focus", left: POMO.focus, endAt: 0, running: false, block: 0 };
try {
  const saved = JSON.parse(localStorage.getItem("pomo") || "{}");
  if (typeof saved.done === "number") pomoDoneSet(saved.done);
} catch { /* fresh */ }
function pomoDoneGet() { return parseInt(document.getElementById("pomoDone").dataset.n || "0", 10); }
function pomoDoneSet(n) {
  const el = document.getElementById("pomoDone");
  el.dataset.n = String(n);
  el.textContent = n > 0 ? `${n}` : "";
  try { localStorage.setItem("pomo", JSON.stringify({ done: n })); } catch { /* private mode */ }
}
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function pomoPaint() {
  const label = pomo.mode === "focus" ? "Focus" : (pomo.mode === "short" ? "Rest" : "Long rest");
  document.getElementById("pomoTime").textContent = `${label} ${fmt(pomo.left)}`;
  document.title = `${fmt(pomo.left)} — HSG English Drill`;
  document.getElementById("pomoStart").textContent = pomo.running ? "Pause" : "Start";
  document.getElementById("pomoDots").textContent =
    "●".repeat(pomo.block % 4) + "○".repeat(4 - (pomo.block % 4));
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = i ? 660 : 880;
      g.gain.setValueAtTime(0.12, ctx.currentTime + t);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
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
}
setInterval(() => {
  if (!pomo.running) return;
  pomo.left = Math.max(0, Math.round((pomo.endAt - Date.now()) / 1000));
  if (pomo.left <= 0) { beep(); pomoAdvance(true); }
  else pomoPaint();
}, 500);
document.getElementById("pomoStart").onclick = () => {
  pomo.running = !pomo.running;
  if (pomo.running) pomo.endAt = Date.now() + pomo.left * 1000;
  pomoPaint();
};
document.getElementById("pomoSkip").onclick = () => pomoAdvance(false);
pomoPaint();
load();

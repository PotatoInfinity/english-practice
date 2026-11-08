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
let lastSolved = -1;
let wrongIds = [];    // miss queue -> retried at every 50-row wall, re-queued if missed again
let nextWallAt = 50;
let wallBusy = false;
const FETCH_N = 200;   // rows pulled into memory per batch (tiny JSON, SRS state stays in SQLite)
const RENDER_N = 25;   // rows painted per scroll step (keeps DOM light)
const CAP = 400;       // in-memory/DOM ceiling per set; Next starts a fresh 200
const list = document.getElementById("list");
const score = document.getElementById("score");
const moreBox = document.getElementById("more");

async function load() {
  items = [];
  seenIds = new Set();
  rendered = 0;
  drained = false;
  lastSolved = -1;
  wrongIds = [];
  nextWallAt = 50;
  results = {};
  list.innerHTML = "";
  score.textContent = "";
  await fetchMore();
}

async function fetchMore() {
  if (fetching || drained) return;
  fetching = true;
  moreBox.textContent = "loading…";
  try {
    const cat = document.getElementById("cat").value;
    const got = await call("due_items", { limit: FETCH_N, category: cat, seen: [...seenIds] });
    const fresh = got.filter(d => !seenIds.has(d.id));
    fresh.forEach(d => seenIds.add(d.id));
    if (got.length === 0 || items.length + fresh.length >= CAP) drained = true;
    items.push(...fresh);
    renderMore();
  } catch (e1) {
    try {
      // browser preview without Tauri: load seed.json directly
      const r = await fetch("../src-tauri/seed.json").catch(() => fetch("./seed.json"));
      const j = await r.json();
      const arr = Array.isArray(j) ? j : j.items;
      const fresh = arr
        .filter(a => (document.getElementById("cat").value === "all" || a.category === document.getElementById("cat").value) && !seenIds.has(a.id ?? -1))
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
  moreBox.textContent = drained ? (items.length >= CAP ? "400 loaded — Next starts a fresh set." : "") : "";
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
    p1.innerHTML = `${escapeHtml(stripBracket(d))} <span class="kw">(${escapeHtml(d.keyword)})</span>`;
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.innerHTML = `&rarr; ${escapeHtml(d.gap_prefix)} `;
    p2.appendChild(dotFor(n));
    p2.appendChild(inpFor(d, n));
    const tail = document.createElement("span");
    tail.textContent = " " + d.gap_suffix;
    p2.appendChild(tail);
    li.append(p1, p2);
  }
  if (d.category === "mcq" || d.category === "three_in_one") {
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.appendChild(dotFor(n));
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
function stripBracket(d) {
  const p = d.prompt || "";
  const m = p.match(/\s*\([A-Za-z' -]+\)\s*[.?]?\s*$/);
  if (m && d.keyword && m[0].toLowerCase().includes(d.keyword.toLowerCase())) {
    return p.slice(0, m.index).trim();
  }
  return p;
}

function dotFor(n) {
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.id = "dot" + n;
  dot.textContent = "●";
  return dot;
}

function inpFor(d, n) {  const inp = document.createElement("input");
  inp.className = "gap";
  inp.id = "gap" + n;
  inp.setAttribute("autocomplete", "off");
  if (d.category === "mcq") inp.setAttribute("placeholder", "1–4");
  inp.addEventListener("keydown", e => { if (e.key === "Enter") gradeItem(n); });
  return inp;
}

function renderMore() {
  const next = items.slice(rendered, rendered + RENDER_N);
  const frag = document.createDocumentFragment();
  next.forEach((d, k) => frag.appendChild(rowFor(d, rendered + k)));
  list.appendChild(frag);
  rendered += next.length;
  if (!items.length && !list.children.length) {
    const li = document.createElement("li");
    li.textContent = "No due items — bank empty or all mastered. Try another category.";
    list.appendChild(li);
  }
  maybeWall();
}

// every 50 rows: splice the miss queue in for a 2nd chance (miss again -> next wall)
async function maybeWall() {
  if (wallBusy || rendered < nextWallAt) return;
  const ids = wrongIds.filter(id => !seenIds.has(id));
  wrongIds = [];
  nextWallAt += 50;
  if (!ids.length) return;
  wallBusy = true;
  try {
    const rows = await call("items_by_ids", { ids });
    const fresh = rows.filter(d => !seenIds.has(d.id));
    if (fresh.length) {
      fresh.forEach(d => seenIds.add(d.id));
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

function scrollLatest() {
  if (lastSolved < 0) { score.textContent = "Solve an item first (Enter in a gap)."; return; }
  const el = document.getElementById("row" + lastSolved);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function escapeHtml(s) { return (s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

let showFilter = "all";   // all | ok | no
let results = {};         // idx -> true (correct) | false (wrong)

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

async function gradeItem(n) {
  const inp = document.getElementById("gap" + n);
  let user = inp.value;
  if (!user.trim()) return null;
  // pure keyboard MCQ: type 1-4 or A-D, graded as the option text
  const opts = items[n].options || [];
  if (items[n].category === "mcq" && opts.length) {
    const t = user.trim().toLowerCase();
    const m = t.match(/^[1-9]$/);
    const l = t.match(/^[a-z]$/);
    if (m && +m[0] >= 1 && +m[0] <= opts.length) user = opts[+m[0] - 1];
    else if (l && l[0].charCodeAt(0) - 97 < opts.length) user = opts[l[0].charCodeAt(0) - 97];
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
  inp.classList.add(correct ? "correct" : "wrong");
  const dot = document.getElementById("dot" + n);
  if (dot) { dot.classList.remove("ok", "no"); dot.classList.add(correct ? "ok" : "no"); }
  if (!correct) {
    // wrong: show the correct answer right below the gap (single submit, no double grade)
    const ans = document.getElementById("ans" + n);
    if (ans) {
      ans.innerHTML = `<b>${escapeHtml(expected)}</b> — ${escapeHtml(full)}<div class="note">${escapeHtml(items[n].notes || "")}</div>`;
      ans.classList.add("show");
    }
  }
  lastSolved = n;
  results[n] = correct;
  const wid = items[n].id;
  if (correct) wrongIds = wrongIds.filter(x => x !== wid);
  else if (!wrongIds.includes(wid)) wrongIds.push(wid);
  applyFilter();
  focusNext(n);
  return correct;
}

// Enter grades, then jumps to the next unsolved gap — pure keyboard flow
function focusNext(n) {
  for (let pass = 0; pass < 2; pass++) {
    for (let k = (pass ? 0 : n + 1); k < (pass ? n + 1 : rendered); k++) {
      if (!(k in results)) {
        const el = document.getElementById("gap" + k);
        if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); return; }
      }
    }
  }
}

async function check() {
  let ok = 0, done = 0;
  for (let n = 0; n < rendered; n++) {
    const r = await gradeItem(n);
    if (r === null) continue;
    done++;
    if (r) ok++;
  }
  score.textContent = done ? `${ok}/${done} correct. Wrong ones resurface first. Reveal shows answers.` : "Type an answer first.";
}

function reveal() {
  for (let n = 0; n < rendered; n++) {
    const d = items[n];
    const ans = document.getElementById("ans" + n);
    const inp = document.getElementById("gap" + n);
    if (!ans || !inp) continue;
    inp.value = d.answer;
    ans.innerHTML = `<b>${escapeHtml(d.answer)}</b> — ${escapeHtml(d.full_answer)}`;
    ans.classList.add("show");
  }
}

document.getElementById("next").onclick = load;
document.getElementById("cat").onchange = load;
document.getElementById("check").onclick = check;
document.getElementById("reveal").onclick = reveal;
document.getElementById("latest").onclick = scrollLatest;
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
  el.textContent = n > 0 ? `✓${n}` : "";
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

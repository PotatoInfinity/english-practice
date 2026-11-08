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
    const got = await call("due_items", { limit: FETCH_N, category: cat });
    const fresh = got.filter(d => !seenIds.has(d.id));
    fresh.forEach(d => seenIds.add(d.id));
    if (got.length < FETCH_N || items.length + fresh.length >= CAP) drained = true;
    items.push(...fresh);
    renderMore();
  } catch (e1) {
    try {
      // browser preview without Tauri: load seed.json directly
      const r = await fetch("../src-tauri/seed.json").catch(() => fetch("./seed.json"));
      const j = await r.json();
      const arr = Array.isArray(j) ? j : j.items;
      const fresh = arr
        .filter(a => (document.getElementById("cat").value === "all" || a.category === document.getElementById("cat").value) && !seenIds.has(a.id))
        .slice(0, FETCH_N)
        .map(a => ({ ...a }));
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
  p1.innerHTML = `${escapeHtml(d.prompt)} <span class="kw">(${escapeHtml(d.keyword)})</span>`;
  const p2 = document.createElement("div");
  p2.className = "rewrite";
  p2.innerHTML = `&rarr; ${escapeHtml(d.gap_prefix)} `;
  const inp = document.createElement("input");
  inp.className = "gap";
  inp.id = "gap" + n;
  inp.setAttribute("autocomplete", "off");
  inp.addEventListener("keydown", e => { if (e.key === "Enter") gradeItem(n); });
  p2.appendChild(inp);
  const tail = document.createElement("span");
  tail.textContent = " " + d.gap_suffix;
  p2.appendChild(tail);
  const ans = document.createElement("div");
  ans.className = "ans";
  ans.id = "ans" + n;
  li.append(p1, p2, ans);
  return li;
}

function renderMore() {
  const next = items.slice(rendered, rendered + RENDER_N);
  next.forEach((d, k) => list.appendChild(rowFor(d, rendered + k)));
  rendered += next.length;
  if (!items.length && !list.children.length) {
    const li = document.createElement("li");
    li.textContent = "No due items — bank empty or all mastered. Try another category.";
    list.appendChild(li);
  }
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

async function gradeItem(n) {
  const inp = document.getElementById("gap" + n);
  const user = inp.value;
  if (!user.trim()) return null;
  let correct;
  try {
    const verdict = await call("submit_answer", { itemId: items[n].id, user });
    correct = verdict.correct;
  } catch {
    // browser fallback: exact/ci compare
    correct = user.toLowerCase().trim() === items[n].answer.toLowerCase().trim();
  }
  inp.classList.remove("correct", "wrong");
  inp.classList.add(correct ? "correct" : "wrong");
  lastSolved = n;
  return correct;
}

async function check() {
  let ok = 0, done = 0;
  for (let n = 0; n < items.length; n++) {
    const r = await gradeItem(n);
    if (r === null) continue;
    done++;
    if (r) ok++;
  }
  score.textContent = done ? `${ok}/${done} correct. Wrong ones resurface first. Reveal shows answers.` : "Type an answer first.";
}

function reveal() {
  items.forEach((d, n) => {
    const ans = document.getElementById("ans" + n);
    const inp = document.getElementById("gap" + n);
    inp.value = d.answer;
    ans.innerHTML = `<b>${escapeHtml(d.answer)}</b> — ${escapeHtml(d.full_answer)}`;
    ans.classList.add("show");
  });
}

document.getElementById("next").onclick = load;
document.getElementById("cat").onchange = load;
document.getElementById("check").onclick = check;
document.getElementById("reveal").onclick = reveal;
document.getElementById("latest").onclick = scrollLatest;

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

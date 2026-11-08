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
const list = document.getElementById("list");
const statline = document.getElementById("statline");
const score = document.getElementById("score");

async function load() {
  const cat = document.getElementById("cat").value;
  try {
    items = await call("due_items", { limit: 10, category: cat });
  } catch (e) {
    // browser preview without Tauri: load seed.json directly
    const r = await fetch("../src-tauri/seed.json").catch(() => fetch("./seed.json"));
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.items;
    items = arr.filter(a => cat === "all" || a.category === cat).slice(0, 10)
      .map((a, i) => ({ item: { id: i + 1, ...a }, reps: 0, lapses: 0 }));
  }
  render();
  refreshStats();
}

function render() {
  list.innerHTML = "";
  items.forEach((d, n) => {
    const li = document.createElement("li");
    const p1 = document.createElement("div");
    p1.innerHTML = `${escapeHtml(d.item.prompt)} <span class="kw">(${escapeHtml(d.item.keyword)})</span>`;
    const p2 = document.createElement("div");
    p2.className = "rewrite";
    p2.innerHTML = `&rarr; ${escapeHtml(d.item.gap_prefix)} `;
    const inp = document.createElement("input");
    inp.className = "gap";
    inp.id = "gap" + n;
    inp.setAttribute("autocomplete", "off");
    inp.addEventListener("keydown", e => { if (e.key === "Enter") check(); });
    p2.appendChild(inp);
    const tail = document.createElement("span");
    tail.textContent = " " + d.item.gap_suffix;
    p2.appendChild(tail);
    const ans = document.createElement("div");
    ans.className = "ans";
    ans.id = "ans" + n;
    li.append(p1, p2, ans);
    list.appendChild(li);
  });
}

function escapeHtml(s) { return (s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function check() {
  let ok = 0;
  for (let n = 0; n < items.length; n++) {
    const inp = document.getElementById("gap" + n);
    const ans = document.getElementById("ans" + n);
    const user = inp.value;
    let verdict;
    try {
      verdict = await call("submit_answer", { itemId: items[n].item.id, user });
    } catch {
      // browser fallback: exact/ci compare
      const gold = items[n].item.answer.toLowerCase().trim();
      const good = user.toLowerCase().trim() === gold;
      verdict = { correct: good, expected: items[n].item.answer, fullAnswer: items[n].item.full_answer, full_answer: items[n].item.full_answer };
    }
    const expected = verdict.expected;
    const full = verdict.fullAnswer ?? verdict.full_answer ?? items[n].item.full_answer;
    if (verdict.correct) { ok++; inp.classList.add("correct"); }
    else inp.classList.add("wrong");
    ans.innerHTML = `<b>${escapeHtml(expected)}</b> — ${escapeHtml(full)}<div class="note">${escapeHtml(items[n].item.notes || "")}</div>`;
    ans.classList.add("show");
  }
  score.textContent = `${ok}/${items.length} correct. Failed items resurface first.`;
  refreshStats();
}

function reveal() {
  items.forEach((d, n) => {
    const ans = document.getElementById("ans" + n);
    const inp = document.getElementById("gap" + n);
    inp.value = d.item.answer;
    ans.innerHTML = `<b>${escapeHtml(d.item.answer)}</b> — ${escapeHtml(d.item.full_answer)}`;
    ans.classList.add("show");
  });
}

async function refreshStats() {
  try {
    const s = await call("stats", {});
    statline.textContent = `bank ${s.total} · due ${s.due_now} · mastered ${s.mastered} · 7-day ${(s.accuracy_7d * 100).toFixed(0)}%`;
  } catch { statline.textContent = `${items.length} loaded`; }
}

// Expandable lookup: on-demand, nothing cached in DB (keeps footprint on test items)
async function lookup() {
  const w = document.getElementById("lw").value.trim();
  if (!w) return;
  document.getElementById("dictapp").href = "dict://" + encodeURIComponent(w);
  const def = document.getElementById("def");
  def.textContent = "…";
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(w));
    const j = await r.json();
    def.textContent = j[0]?.meanings?.slice(0, 3).map(m => `(${m.partOfSpeech}) ` + m.definitions.slice(0, 2).map(d => d.definition).join("; ")).join("\n") || JSON.stringify(j).slice(0, 800);
  } catch (e) { def.textContent = "Offline. Use Dictionary.app link."; }
}

document.getElementById("next").onclick = load;
document.getElementById("cat").onchange = load;
document.getElementById("check").onclick = check;
document.getElementById("reveal").onclick = reveal;
document.getElementById("lookupToggle").onclick = () => { const p = document.getElementById("lookup"); p.hidden = !p.hidden; };
document.getElementById("go").onclick = lookup;

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

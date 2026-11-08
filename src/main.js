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
load();

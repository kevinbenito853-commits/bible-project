import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const state = { verses: [], chapters: [], entities: [], store: null, name: load("name", ""), group: load("group", "") };

/* ---------- notes storage: Supabase when configured, else this browser ---------- */

function localStore() {
  const read = () => JSON.parse(load("notes", "[]"));
  const listeners = [];
  const fire = () => listeners.forEach((f) => f());
  return {
    mode: "Saved in this browser only",
    async list(grp, book, chapters) { return read().filter((n) => n.book === book && chapters.includes(n.chapter)); },
    async add(n) { save("notes", JSON.stringify([...read(), { ...n, id: crypto.randomUUID(), created_at: new Date().toISOString(), mine: true }])); fire(); },
    async remove(id) { save("notes", JSON.stringify(read().filter((n) => n.id !== id))); fire(); },
    subscribe(f) { listeners.push(f); },
  };
}

async function remoteStore() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  let { data: { session } } = await sb.auth.getSession();
  if (!session) ({ data: { session } } = await sb.auth.signInAnonymously());
  const uid = session.user.id;
  const listeners = [];
  sb.channel("notes").on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => listeners.forEach((f) => f())).subscribe();
  return {
    mode: "Shared with your group",
    async list(grp, book, chapters) {
      const { data, error } = await sb.from("notes").select("*").eq("grp", grp).eq("book", book).in("chapter", chapters).order("created_at");
      if (error) throw error;
      return data.map((n) => ({ ...n, mine: n.owner === uid }));
    },
    async add(n) { const { error } = await sb.from("notes").insert({ ...n, owner: uid }); if (error) throw error; },
    async remove(id) { const { error } = await sb.from("notes").delete().eq("id", id); if (error) throw error; },
    subscribe(f) { listeners.push(f); },
  };
}

/* ---------- passage ---------- */

async function loadPassage(ref, tr) {
  $("text").innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=${tr}`);
    if (!res.ok) throw new Error("Passage not found. Try something like “John 3:16-21” or “Psalm 23”.");
    const data = await res.json();
    state.verses = data.verses;
    state.book = data.verses[0].book_name;
    state.bookId = data.verses[0].book_id;
    $("commWrap").hidden = true;
    state.chapters = [...new Set(data.verses.map((v) => v.chapter))];
    $("title").textContent = data.reference;
    $("sub").textContent = data.translation_name;
    $("runL").textContent = state.book;
    $("runR").textContent = state.chapters.length > 1 ? `Chapters ${state.chapters[0]}–${state.chapters.at(-1)}` : `Chapter ${state.chapters[0]}`;
    render();
    fillVerseSelect();
    refreshNotes();
  } catch (e) {
    $("text").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function entitiesFor() {
  const keys = state.chapters.map((c) => `${state.book} ${c}`);
  return state.entities.filter((e) => e.global || (e.chapters || []).some((k) => keys.includes(k)));
}

function render() {
  const ents = entitiesFor();
  const byAlias = new Map();
  ents.forEach((e) => e.aliases.forEach((a) => { if (!byAlias.has(a)) byAlias.set(a, e); }));
  const aliases = [...byAlias.keys()].sort((a, b) => b.length - a.length);
  const re = aliases.length ? new RegExp(`\\b(${aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g") : null;
  $("text").innerHTML = state.verses.map((v) => {
    const safe = esc(v.text.replace(/\s+/g, " ").trim());
    const body = re ? safe.replace(re, (m) => `<span class="e" data-k="${byAlias.get(m).id}">${m}</span>`) : safe;
    return `<p class="v" data-ch="${v.chapter}" data-v="${v.verse}"><sup>${state.chapters.length > 1 ? v.chapter + ":" : ""}${v.verse}</sup>${body}</p>`;
  }).join("");
}

function showCard(id) {
  document.querySelectorAll(".e").forEach((x) => x.classList.toggle("on", x.dataset.k === id));
  const d = state.entities.find((e) => e.id === id);
  const src = (d.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(" · ");
  const refs = (d.refs || []).map((r) => `<a href="#" data-ref="${esc(r)}">${esc(r)}</a>`).join(" · ");
  $("card").innerHTML =
    `<span class="tag">${esc(d.type)}</span><h2>${esc(d.name)}</h2><p><i>${esc(d.summary)}</i></p>` +
    `<ul class="facts">${d.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
    (refs ? `<div class="refs">Related: ${refs}</div>` : "") +
    (src ? `<div class="refs">Check the facts: ${src}</div>` : `<div class="refs">No outside sources listed yet.</div>`);
}

/* ---------- selection, copy and commentary ---------- */

const commCache = new Map();
async function commentaryChapter(id, book, chapter) {
  const key = `${id}/${book}/${chapter}`;
  if (!commCache.has(key)) {
    commCache.set(key, fetch(`https://bible.helloao.org/api/c/${id}/${book}/${chapter}.json`).then((r) => {
      if (!r.ok) throw new Error("No commentary on this chapter from this author.");
      return r.json();
    }));
  }
  try { return await commCache.get(key); } catch (e) { commCache.delete(key); throw e; }
}

// What the reader has selected: the text (without verse numbers) and which verses it touches.
function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const para = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(".v");
  const a = para(range.startContainer), b = para(range.endContainer);
  if (!a || !b || !$("text").contains(a) || !$("text").contains(b)) return null;
  const box = document.createElement("div");
  box.appendChild(range.cloneContents());
  box.querySelectorAll("sup").forEach((s) => s.remove());
  const text = box.textContent.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const all = [...$("text").querySelectorAll(".v")];
  const picked = all.slice(all.indexOf(a), all.indexOf(b) + 1).map((p) => ({ chapter: +p.dataset.ch, verse: +p.dataset.v }));
  const f = picked[0], l = picked.at(-1);
  const same = f.chapter === l.chapter;
  const label = `${state.book} ${f.chapter}:${f.verse}` + (picked.length > 1 ? `–${same ? "" : l.chapter + ":"}${l.verse}` : "");
  return { text, picked, label, rect: range.getBoundingClientRect() };
}

let current = null;
function updatePop() {
  const s = readSelection();
  if (!s) { $("pop").hidden = true; return; }
  current = s;
  $("pop").hidden = false;
  const w = $("pop").offsetWidth;
  const x = Math.min(Math.max(s.rect.left + s.rect.width / 2, w / 2 + 6), window.innerWidth - w / 2 - 6);
  $("pop").style.left = x + "px";
  $("pop").style.top = Math.max(6, s.rect.top - $("pop").offsetHeight - 8) + "px";
}

async function copyCurrent() {
  if (!current) return;
  const out = `“${current.text}” — ${current.label} (${$("tr").value.toUpperCase()})`;
  try { await navigator.clipboard.writeText(out); }
  catch { const t = document.createElement("textarea"); t.value = out; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  for (const b of [$("popCopy"), $("copyQ")]) { const old = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = old), 1200); }
}

async function showCommentary() {
  if (!current) return;
  const sel = current, id = $("commSel").value, name = $("commSel").selectedOptions[0].textContent;
  $("commWrap").hidden = false;
  $("quote").innerHTML = `“${esc(sel.text)}”<small>${esc(sel.label)} · ${esc($("tr").value.toUpperCase())}</small>`;
  $("comm").innerHTML = '<div class="empty">Loading commentary…</div>';
  try {
    const out = [], seen = new Set();
    for (const chapter of [...new Set(sel.picked.map((p) => p.chapter))]) {
      const data = await commentaryChapter(id, state.bookId, chapter);
      const entries = data.chapter.content.filter((c) => c.type === "verse").sort((x, y) => x.number - y.number);
      for (const p of sel.picked.filter((q) => q.chapter === chapter)) {
        const i = entries.findLastIndex((e) => e.number <= p.verse);
        if (i < 0 || seen.has(`${chapter}:${entries[i].number}`)) continue;
        seen.add(`${chapter}:${entries[i].number}`);
        const from = entries[i].number, to = entries[i + 1] ? entries[i + 1].number - 1 : data.chapter.numberOfVerses;
        const body = entries[i].content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n").trim();
        if (body) out.push(`<div class="cm"><b>${esc(name)} on ${esc(state.book)} ${chapter}:${from}${to > from ? "–" + to : ""}</b>${esc(body)}</div>`);
      }
    }
    $("comm").innerHTML = out.length ? out.join("") + `<div class="credit">Commentary text from public-domain works, served by bible.helloao.org.</div>`
      : `<div class="empty">${esc(name)} has nothing on this verse. Try another commentary.</div>`;
  } catch (e) {
    $("comm").innerHTML = `<div class="empty">${esc(e.message)} Try another commentary.</div>`;
  }
  $("commWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- notes UI ---------- */

function fillVerseSelect() {
  $("vs").innerHTML = state.verses.map((v) => `<option value="${v.chapter}:${v.verse}">${esc(state.book)} ${v.chapter}:${v.verse}</option>`).join("");
}

async function refreshNotes() {
  if (!state.store || !state.chapters.length) return;
  try {
    const notes = await state.store.list(state.group, state.book, state.chapters);
    $("notes").innerHTML = notes.length
      ? notes.map((n) => `<div class="note"><b>${esc(n.author)} · ${esc(state.book)} ${n.chapter}:${n.verse}${n.mine ? `<button class="del" data-id="${esc(n.id)}" title="Delete">✕</button>` : ""}</b>${esc(n.body)}</div>`).join("")
      : '<div class="empty">No notes on this passage yet.</div>';
  } catch (e) {
    $("notes").innerHTML = `<div class="empty">Could not load notes: ${esc(e.message)}</div>`;
  }
}

function updateWho() {
  $("who").textContent = state.name ? `${state.name}${state.group ? " · " + state.group : ""}` : "Set name & group";
  $("grp").textContent = state.group ? `· ${state.group}` : "";
  $("mode").textContent = state.store?.mode ?? "";
}

/* ---------- wiring ---------- */

$("go").addEventListener("submit", (e) => { e.preventDefault(); loadPassage($("ref").value.trim(), $("tr").value); });
$("text").addEventListener("click", (e) => { const t = e.target.closest(".e"); if (t) showCard(t.dataset.k); });
$("card").addEventListener("click", (e) => {
  const a = e.target.closest("[data-ref]");
  if (!a) return;
  e.preventDefault();
  $("ref").value = a.dataset.ref;
  loadPassage(a.dataset.ref, $("tr").value);
});
document.addEventListener("selectionchange", () => { clearTimeout(updatePop.t); updatePop.t = setTimeout(updatePop, 150); });
document.addEventListener("scroll", () => { $("pop").hidden = true; }, { passive: true });
// keep the selection alive when the buttons are pressed
$("pop").addEventListener("mousedown", (e) => e.preventDefault());
$("popComm").addEventListener("click", () => { showCommentary(); $("pop").hidden = true; });
$("popCopy").addEventListener("click", copyCurrent);
$("copyQ").addEventListener("click", copyCurrent);
$("commSel").addEventListener("change", showCommentary);
$("notes").addEventListener("click", async (e) => {
  const b = e.target.closest(".del");
  if (b && confirm("Delete this note?")) { await state.store.remove(b.dataset.id); refreshNotes(); }
});
$("add").addEventListener("click", async () => {
  const body = $("nt").value.trim();
  if (!body) return;
  if (!state.name) return openSettings();
  const [chapter, verse] = $("vs").value.split(":").map(Number);
  try {
    await state.store.add({ grp: state.group, book: state.book, chapter, verse, author: state.name, body });
    $("nt").value = "";
    refreshNotes();
  } catch (e) { alert("Could not save note: " + e.message); }
});

function openSettings() {
  $("name").value = state.name;
  $("group").value = state.group;
  $("dlgNote").textContent = SUPABASE_URL ? "Everyone who enters the same group code sees the same notes." : "Shared notes are not set up yet, so notes stay in this browser. See the README.";
  $("dlg").showModal();
}
$("who").addEventListener("click", openSettings);
$("settings").addEventListener("submit", () => {
  state.name = $("name").value.trim();
  state.group = $("group").value.trim().toLowerCase();
  save("name", state.name);
  save("group", state.group);
  updateWho();
  refreshNotes();
});

(async function init() {
  state.entities = await (await fetch("data/entities.json")).json();
  try { state.store = SUPABASE_URL ? await remoteStore() : localStore(); }
  catch (e) { console.warn("Shared notes unavailable, using local notes:", e); state.store = localStore(); }
  state.store.subscribe(refreshNotes);
  updateWho();
  loadPassage($("ref").value, $("tr").value);
})();

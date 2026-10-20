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
    return `<p class="v"><sup>${state.chapters.length > 1 ? v.chapter + ":" : ""}${v.verse}</sup>${body}</p>`;
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

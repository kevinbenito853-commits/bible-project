import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const state = {
  verses: [], chapters: [], book: "", reference: "", loadId: 0,
  entities: [], words: [], store: null,
  name: load("name", ""), group: load("group", ""),
};

/* ---------- notes storage: Supabase when configured, else this browser ---------- */

function localStore() {
  const read = () => JSON.parse(load("notes", "[]"));
  const listeners = [];
  const fire = () => listeners.forEach((f) => f());
  return {
    mode: "Saved in this browser only",
    async list(grp, book, chapters) { return read().filter((n) => n.book === book && chapters.includes(n.chapter)); },
    async listAll() { return read(); },
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
  sb.channel("notes").on("postgres_changes", { event: "*", schema: "public", table: "notes" }, (p) => {
    // Ignore other groups' changes when the payload says which group it is for.
    const g = p.new?.grp ?? p.old?.grp;
    if (g === undefined || g === state.group) listeners.forEach((f) => f());
  }).subscribe();
  return {
    mode: "Shared with your group",
    async list(grp, book, chapters) {
      const { data, error } = await sb.from("notes").select("*").eq("grp", grp).eq("book", book).in("chapter", chapters).order("created_at");
      if (error) throw error;
      return data.map((n) => ({ ...n, mine: n.owner === uid }));
    },
    async listAll(grp) {
      const { data, error } = await sb.from("notes").select("*").eq("grp", grp).order("created_at");
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
  const myId = ++state.loadId;
  $("text").innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=${tr}`);
    if (!res.ok) throw new Error("Passage not found. Try something like “John 3:16-21” or “Psalm 23”.");
    const data = await res.json();
    if (myId !== state.loadId) return; // a newer lookup started; ignore this one
    if (!data.verses?.length) throw new Error("Passage not found. Try something like “John 3:16-21” or “Psalm 23”.");
    state.verses = data.verses;
    state.book = data.verses[0].book_name;
    state.reference = data.reference;
    state.chapters = [...new Set(data.verses.map((v) => v.chapter))];
    $("title").textContent = data.reference;
    $("sub").textContent = data.translation_name;
    $("runL").textContent = state.book;
    $("runR").textContent = state.chapters.length > 1 ? `Chapters ${state.chapters[0]}–${state.chapters.at(-1)}` : `Chapter ${state.chapters[0]}`;
    render();
    fillVerseSelect();
    refreshNotes();
  } catch (e) {
    if (myId !== state.loadId) return;
    $("text").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

const inScope = (list) => {
  const keys = state.chapters.map((c) => `${state.book} ${c}`);
  return list.filter((e) => e.global || (e.chapters || []).some((k) => keys.includes(k)));
};

// Wrap matches in raw text, escaping everything else, so names with apostrophes or & still work.
function markup(text, re, lookup) {
  if (!re) return esc(text);
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const hit = lookup(m[0]);
    out += esc(text.slice(last, m.index));
    out += hit
      ? `<span class="${hit.t}" data-t="${hit.t}" data-k="${esc(hit.id)}" role="button" tabindex="0">${esc(m[0])}</span>`
      : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function render() {
  const entMap = new Map(); // names: exact capitalization
  inScope(state.entities).forEach((e) => e.aliases.forEach((a) => { if (!entMap.has(a)) entMap.set(a, e); }));
  const wordMap = new Map(); // words: any capitalization
  inScope(state.words).forEach((w) => w.aliases.forEach((a) => { const k = a.toLowerCase(); if (!wordMap.has(k)) wordMap.set(k, w); }));
  const aliases = [...new Set([...entMap.keys(), ...wordMap.keys()])].sort((a, b) => b.length - a.length);
  const re = aliases.length ? new RegExp(`\\b(?:${aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi") : null;
  const lookup = (m) => {
    if (entMap.has(m)) return { t: "e", id: entMap.get(m).id };
    const w = wordMap.get(m.toLowerCase());
    return w ? { t: "w", id: w.id } : null;
  };
  const multi = state.chapters.length > 1;
  $("text").innerHTML = state.verses.map((v) => {
    const cv = `${v.chapter}:${v.verse}`;
    const body = markup(v.text.replace(/\s+/g, " ").trim(), re, lookup);
    return `<div class="vw" data-cv="${cv}"><p class="v"><sup><button type="button" class="vn" data-cv="${cv}" title="Add a note or question on this verse">${multi ? cv : v.verse}</button></sup>${body}<button type="button" class="vb" data-cv="${cv}" hidden></button></p><div class="slot"></div></div>`;
  }).join("");
}

/* ---------- inline study cards (open right under the verse) ---------- */

function sourceLinks(list) {
  return (list || []).map((s) => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(" · ");
}
function refLinks(list) {
  return (list || []).map((r) => `<a href="#" data-ref="${esc(r)}">${esc(r)}</a>`).join(" · ");
}

function entityCard(d) {
  const refs = refLinks(d.refs), src = sourceLinks(d.sources);
  return `<span class="tag">${esc(d.type)}</span><h2>${esc(d.name)}</h2><p><i>${esc(d.summary)}</i></p>` +
    `<ul class="facts">${(d.facts || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
    (refs ? `<div class="refs">Related: ${refs}</div>` : "") +
    (src ? `<div class="refs">Check the facts: ${src}</div>` : `<div class="refs">No outside sources listed yet.</div>`);
}

function wordCard(d) {
  const refs = refLinks(d.refs), src = sourceLinks(d.sources);
  const orig = [d.original, d.translit && `(${d.translit})`, d.strongs && `Strong’s ${d.strongs}`].filter(Boolean).map(esc).join(" · ");
  return `<span class="tag w">Word · ${esc(d.language || "original language")}</span><h2>${esc(d.word)}</h2>` +
    (orig ? `<p class="orig">${orig}</p>` : "") +
    `<p><i>${esc(d.meaning)}</i></p>` +
    `<ul class="facts">${(d.facts || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
    (refs ? `<div class="refs">Related: ${refs}</div>` : "") +
    (src ? `<div class="refs">Check the facts: ${src}</div>` : "");
}

function closeCards() {
  document.querySelectorAll("#text .icard").forEach((c) => c.remove());
  document.querySelectorAll("#text .on").forEach((x) => x.classList.remove("on"));
}

function toggleCard(term) {
  const wrap = term.closest(".vw");
  const key = `${term.dataset.t}:${term.dataset.k}`;
  const open = wrap.querySelector(".icard");
  const same = open && open.dataset.key === key;
  closeCards();
  if (same) return;
  const isWord = term.dataset.t === "w";
  const d = (isWord ? state.words : state.entities).find((x) => x.id === term.dataset.k);
  if (!d) return;
  wrap.querySelector(".slot").innerHTML =
    `<div class="icard" data-key="${esc(key)}"><button type="button" class="x" data-close title="Close" aria-label="Close">✕</button>${isWord ? wordCard(d) : entityCard(d)}</div>`;
  wrap.querySelectorAll(`[data-t="${term.dataset.t}"]`).forEach((x) => x.classList.toggle("on", x.dataset.k === term.dataset.k));
  wrap.querySelector(".icard").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---------- notes & questions UI ---------- */

const kindNow = () => document.querySelector('input[name="kind"]:checked').value;

function fillVerseSelect() {
  $("vs").innerHTML = state.verses.map((v) => `<option value="${v.chapter}:${v.verse}">${esc(state.book)} ${v.chapter}:${v.verse}</option>`).join("");
}

function noteHTML(n) {
  const q = n.kind === "question";
  return `<div class="note${q ? " q" : ""}"><b>${q ? '<span class="qt">Question</span> ' : ""}${esc(n.author)}${n.mine ? `<button class="del" data-id="${esc(n.id)}" title="Delete" aria-label="Delete">✕</button>` : ""}</b>${esc(n.body)}</div>`;
}

async function refreshNotes() {
  if (!state.store || !state.chapters.length) return;
  const myId = state.loadId;
  try {
    const all = await state.store.list(state.group, state.book, state.chapters);
    if (myId !== state.loadId) return;
    // General questions belong to the exact passage on screen; everything else is per verse.
    const general = all.filter((n) => n.verse === 0 && n.passage === state.reference);
    $("gq").innerHTML = general.length ? general.map(noteHTML).join("") : '<div class="empty">No questions on this passage yet.</div>';

    const groups = new Map(state.verses.map((v) => [`${v.chapter}:${v.verse}`, []]));
    all.filter((n) => n.verse > 0).forEach((n) => groups.get(`${n.chapter}:${n.verse}`)?.push(n));
    const filled = [...groups].filter(([, list]) => list.length);
    $("notes").innerHTML = filled.length
      ? filled.map(([cv, list]) => `<div class="vg" id="n-${cv.replace(":", "-")}"><h4>${esc(state.book)} ${esc(cv)}</h4>${list.map(noteHTML).join("")}</div>`).join("")
      : '<div class="empty">No notes or questions on these verses yet.</div>';

    document.querySelectorAll("#text .vb").forEach((b) => {
      const n = groups.get(b.dataset.cv)?.length || 0;
      b.hidden = !n;
      b.textContent = n;
      b.title = `${n} ${n === 1 ? "note or question" : "notes and questions"} on this verse`;
    });
  } catch (e) {
    $("notes").innerHTML = `<div class="empty">Could not load notes: ${esc(e.message)}</div>`;
  }
}

function updateWho() {
  $("who").textContent = state.name ? `${state.name}${state.group ? " · " + state.group : ""}` : "Set name & group";
  $("grp").textContent = state.group ? `· ${state.group}` : "";
  $("mode").textContent = state.store?.mode ?? "";
}

function pickVerse(cv) {
  $("vs").value = cv;
  $("nt").focus();
  $("nt").scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------- printable report: put notes and questions in order, then print ---------- */

const BOOKS = ["Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation"];
const bookIdx = (b) => { const i = BOOKS.findIndex((x) => x.toLowerCase() === String(b).toLowerCase()); return i < 0 ? 999 : i; };
const loadJSON = (k, d) => { try { return JSON.parse(load(k, "")) ?? d; } catch { return d; } };
const refOf = (n) => (n.verse === 0 ? `Whole passage (${n.passage || `${n.book} ${n.chapter}`})` : `${n.book} ${n.chapter}:${n.verse}`);
const reportKey = () => ($("rScope").value === "all" ? "all" : `p:${state.reference}`);
const reportRows = () => [...$("rList").querySelectorAll(".ri")];

async function reportItems() {
  if (!state.store) return [];
  const everything = $("rScope").value === "all";
  let list = everything
    ? await state.store.listAll(state.group)
    : (await state.store.list(state.group, state.book, state.chapters))
      .filter((n) => (n.verse === 0 ? n.passage === state.reference : state.verses.some((v) => v.chapter === n.chapter && v.verse === n.verse)));
  if ($("rWho").value === "mine") list = list.filter((n) => n.mine);
  // Default order: Bible order, with whole-passage questions first. Your own order wins once you move things.
  const byDefault = [...list].sort((a, b) => bookIdx(a.book) - bookIdx(b.book) || a.chapter - b.chapter || a.verse - b.verse || String(a.created_at).localeCompare(String(b.created_at)));
  const saved = loadJSON("reportOrder", {})[reportKey()] || [];
  const byId = new Map(byDefault.map((n) => [n.id, n]));
  return [...saved.filter((id) => byId.has(id)).map((id) => byId.get(id)), ...byDefault.filter((n) => !saved.includes(n.id))];
}

function rowHTML(n, off) {
  const q = n.kind === "question";
  return `<li class="ri${off ? " off" : ""}" data-id="${esc(n.id)}" data-kind="${q ? "question" : "note"}">` +
    `<span class="rh" title="Drag to move" aria-hidden="true">⠿</span>` +
    `<input type="checkbox" class="rinc" aria-label="Include in report"${off ? "" : " checked"}>` +
    `<span class="rn"></span>` +
    `<div class="rbody"><div class="rmeta"><span class="qt${q ? "" : " n"}">${q ? "Question" : "Note"}</span> <span class="rm">${esc(refOf(n))} · ${esc(n.author)}</span></div><div class="rtext">${esc(n.body)}</div></div>` +
    `<span class="rbtns"><button type="button" data-up aria-label="Move up">▲</button><button type="button" data-down aria-label="Move down">▼</button></span></li>`;
}

async function buildReport() {
  const off = new Set(loadJSON("reportOff", []));
  let items;
  try { items = await reportItems(); }
  catch (e) { $("rList").innerHTML = `<li class="empty">Could not load notes: ${esc(e.message)}</li>`; return; }
  const scope = $("rScope").value === "all" ? "All passages" : state.reference;
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("rSub").textContent = [scope, state.name, state.group, today].filter(Boolean).join(" · ");
  $("rList").innerHTML = items.length ? items.map((n) => rowHTML(n, off.has(n.id))).join("") : '<li class="empty">Nothing to print yet. Add a note or a question first.</li>';
  renumber();
}

function renumber() {
  let n = 0;
  reportRows().forEach((li) => {
    const on = li.querySelector(".rinc").checked;
    li.classList.toggle("off", !on);
    li.querySelector(".rn").textContent = on ? `${++n}.` : "–";
  });
}

function saveReport() {
  const rows = reportRows();
  const ids = rows.map((li) => li.dataset.id);
  const order = loadJSON("reportOrder", {});
  order[reportKey()] = [...ids, ...(order[reportKey()] || []).filter((id) => !ids.includes(id))];
  save("reportOrder", JSON.stringify(order));
  const off = rows.filter((li) => !li.querySelector(".rinc").checked).map((li) => li.dataset.id);
  save("reportOff", JSON.stringify([...loadJSON("reportOff", []).filter((id) => !ids.includes(id)), ...off]));
}

function moveRow(li, dir) {
  const sib = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
  if (!sib?.classList.contains("ri")) return;
  if (dir < 0) li.parentNode.insertBefore(li, sib); else li.parentNode.insertBefore(sib, li);
  saveReport();
  renumber();
  li.querySelector(dir < 0 ? "[data-up]" : "[data-down]")?.focus();
}

// Drag by the ⠿ handle. The row follows your finger and only moves into place when you let go.
let drag = null;
const dropTarget = (y) => reportRows().filter((x) => x !== drag.li).find((s) => { const r = s.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;

function dragTick() {
  if (!drag) return;
  const y = drag.y;
  if (y < 90) window.scrollBy(0, -12); else if (y > window.innerHeight - 90) window.scrollBy(0, 12);
  drag.li.style.transform = `translateY(${y - drag.startY + (window.scrollY - drag.startScroll)}px)`;
  const t = dropTarget(y);
  reportRows().forEach((x) => x.classList.toggle("over", x === t));
  $("rList").classList.toggle("over-end", !t);
  drag.raf = requestAnimationFrame(dragTick);
}

function endDrag(commit, y) {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  const { li } = drag;
  const t = commit ? dropTarget(y ?? drag.y) : li;
  li.style.transform = "";
  li.classList.remove("drag");
  reportRows().forEach((x) => x.classList.remove("over"));
  $("rList").classList.remove("over-end");
  if (commit) {
    if (t) $("rList").insertBefore(li, t); else $("rList").appendChild(li);
    saveReport();
    renumber();
  }
  drag = null;
}

function reportText() {
  const lines = [`Study report: ${$("rSub").textContent}`, ""];
  reportRows().filter((li) => !li.classList.contains("off")).forEach((li) => {
    const label = li.dataset.kind === "question" ? "Question" : "Note";
    lines.push(`${li.querySelector(".rn").textContent} [${label}] ${li.querySelector(".rm").textContent}`, `   ${li.querySelector(".rtext").textContent}`, "");
  });
  return `${lines.join("\n").trim()}\n`;
}

/* ---------- wiring ---------- */

$("rep").addEventListener("click", async () => { document.body.classList.add("reporting"); window.scrollTo(0, 0); await buildReport(); });
$("rBack").addEventListener("click", () => document.body.classList.remove("reporting"));
["rScope", "rWho"].forEach((id) => $(id).addEventListener("change", buildReport));
$("rPrint").addEventListener("click", () => { try { window.print(); } catch { /* not available here */ } });
$("rCopy").addEventListener("click", async () => {
  const text = reportText();
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* nothing more to try */ }
    ta.remove();
  }
  $("rCopy").textContent = "Copied";
  setTimeout(() => { $("rCopy").textContent = "Copy text"; }, 1500);
});
$("rList").addEventListener("change", (e) => { if (e.target.closest(".rinc")) { renumber(); saveReport(); } });
$("rList").addEventListener("click", (e) => {
  const up = e.target.closest("[data-up]"), down = e.target.closest("[data-down]");
  if (up) moveRow(up.closest(".ri"), -1);
  if (down) moveRow(down.closest(".ri"), 1);
});
$("rList").addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".rh");
  if (!h) return;
  e.preventDefault();
  const li = h.closest(".ri");
  drag = { li, y: e.clientY, startY: e.clientY, startScroll: window.scrollY, raf: 0 };
  li.classList.add("drag");
  drag.raf = requestAnimationFrame(dragTick);
});
window.addEventListener("pointermove", (e) => { if (drag) drag.y = e.clientY; });
window.addEventListener("pointerup", (e) => endDrag(true, e.clientY));
window.addEventListener("pointercancel", () => endDrag(false));

$("go").addEventListener("submit", (e) => { e.preventDefault(); loadPassage($("ref").value.trim(), $("tr").value); });

$("text").addEventListener("click", (e) => {
  const term = e.target.closest(".e, .w");
  if (term) return toggleCard(term);
  if (e.target.closest("[data-close]")) return closeCards();
  const ref = e.target.closest("[data-ref]");
  if (ref) { e.preventDefault(); $("ref").value = ref.dataset.ref; return loadPassage(ref.dataset.ref, $("tr").value); }
  const vn = e.target.closest(".vn");
  if (vn) return pickVerse(vn.dataset.cv);
  const vb = e.target.closest(".vb");
  if (vb) document.getElementById("n-" + vb.dataset.cv.replace(":", "-"))?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const term = e.target.closest(".e, .w");
  if (term) { e.preventDefault(); toggleCard(term); }
});

async function onDelete(e) {
  const b = e.target.closest(".del");
  if (b && confirm("Delete this?")) { await state.store.remove(b.dataset.id); refreshNotes(); }
}
$("notes").addEventListener("click", onDelete);
$("gq").addEventListener("click", onDelete);

document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", () => {
  const q = kindNow() === "question";
  $("add").textContent = q ? "Add question" : "Add note";
  $("nt").placeholder = q ? "Ask a question about this verse…" : "Write a note for your study group…";
}));

async function addEntry(fields, box) {
  const body = box.value.trim();
  if (!body) return;
  if (!state.name) return openSettings();
  try {
    await state.store.add({ grp: state.group, book: state.book, author: state.name, body, ...fields });
    box.value = "";
    refreshNotes();
  } catch (e) { alert("Could not save: " + e.message); }
}

$("add").addEventListener("click", () => {
  const [chapter, verse] = $("vs").value.split(":").map(Number);
  addEntry({ chapter, verse, kind: kindNow(), passage: state.reference }, $("nt"));
});
$("gqa").addEventListener("click", () => {
  addEntry({ chapter: state.chapters[0], verse: 0, kind: "question", passage: state.reference }, $("gqt"));
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

const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }).catch((e) => { console.warn("Could not load", e); return []; });

(async function init() {
  [state.entities, state.words] = await Promise.all([getJSON("data/entities.json"), getJSON("data/words.json")]);
  try { state.store = SUPABASE_URL ? await remoteStore() : localStore(); }
  catch (e) { console.warn("Shared notes unavailable, using local notes:", e); state.store = localStore(); }
  state.store.subscribe(refreshNotes);
  updateWho();
  loadPassage($("ref").value, $("tr").value);
})();

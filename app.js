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
    async update(id, body) { save("notes", JSON.stringify(read().map((n) => (n.id === id ? { ...n, body } : n)))); fire(); },
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
    async update(id, body) {
      const { data, error } = await sb.from("notes").update({ body }).eq("id", id).select();
      if (error) throw error;
      if (!data.length) throw new Error("Editing is not turned on yet. Run the update policy in supabase/schema.sql.");
    },
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
    if (myId !== state.loadId) return null; // a newer lookup started; ignore this one
    if (!data.verses?.length) throw new Error("Passage not found. Try something like “John 3:16-21” or “Psalm 23”.");
    state.verses = data.verses;
    state.book = data.verses[0].book_name;
    state.bookId = data.verses[0].book_id;
    $("commWrap").hidden = true;
    state.reference = data.reference;
    state.tr = tr;
    state.chapters = [...new Set(data.verses.map((v) => v.chapter))];
    $("title").textContent = data.reference;
    $("sub").textContent = data.translation_name;
    $("runL").textContent = state.book;
    $("runR").textContent = state.chapters.length > 1 ? `Chapters ${state.chapters[0]}–${state.chapters.at(-1)}` : `Chapter ${state.chapters[0]}`;
    render();
    fillVerseSelect();
    refreshNotes();
    return true;
  } catch (e) {
    if (myId !== state.loadId) return null;
    $("text").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return false;
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
    return `<div class="vw" data-cv="${cv}"><p class="v" data-ch="${v.chapter}" data-v="${v.verse}"><sup><button type="button" class="vn" data-cv="${cv}" title="Add a note or question on this verse">${multi ? cv : v.verse}</button></sup>${body}<button type="button" class="vb" data-cv="${cv}" hidden></button></p><div class="slot"></div></div>`;
  }).join("");
  applyHighlights();
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

// Verse text without the number button, so offsets stay the same however the verse is marked up.
function plainText(el) {
  el.querySelectorAll("sup, .vb, .slot").forEach((x) => x.remove());
  return el.textContent;
}
function plainOffset(p, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(p);
  r.setEnd(node, offset);
  const box = document.createElement("div");
  box.appendChild(r.cloneContents());
  return plainText(box).length;
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
  box.querySelectorAll("sup, .vb, .slot").forEach((s) => s.remove());
  const text = box.textContent.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const all = [...$("text").querySelectorAll(".v")];
  const paras = all.slice(all.indexOf(a), all.indexOf(b) + 1);
  const picked = paras.map((p) => ({ chapter: +p.dataset.ch, verse: +p.dataset.v }));
  const f = picked[0], l = picked.at(-1);
  const same = f.chapter === l.chapter;
  const label = `${state.book} ${f.chapter}:${f.verse}` + (picked.length > 1 ? `–${same ? "" : l.chapter + ":"}${l.verse}` : "");
  const segs = paras.map((p, i) => {
    const pt = plainText(p.cloneNode(true));
    let s = i === 0 ? plainOffset(p, range.startContainer, range.startOffset) : 0;
    let e = i === paras.length - 1 ? plainOffset(p, range.endContainer, range.endOffset) : pt.length;
    while (s < e && /\s/.test(pt[s])) s++;
    while (e > s && /\s/.test(pt[e - 1])) e--;
    return { chapter: picked[i].chapter, verse: picked[i].verse, s, e, text: pt.slice(s, e) };
  }).filter((x) => x.e > x.s);
  const ref = `${state.book} ${f.chapter}:${f.verse}` + (picked.length > 1 ? `-${same ? "" : l.chapter + ":"}${l.verse}` : "");
  return { text, picked, label, ref, segs, rect: range.getBoundingClientRect() };
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

/* ---------- highlights (saved in this browser) ---------- */

function loadHl() { try { return JSON.parse(load("highlights", "[]")); } catch { return []; } }
function saveHl(list) { save("highlights", JSON.stringify(list)); updateHBtn(); }

function highlightCurrent() {
  if (!current?.segs.length) return;
  const list = loadHl();
  list.push({
    id: crypto.randomUUID(), tr: state.tr, book: state.book, ref: current.ref, label: current.label, created: Date.now(),
    text: current.segs.map((s) => s.text).join(" … "),
    segs: current.segs.map(({ chapter, verse, s, e }) => ({ chapter, verse, s, e })),
  });
  saveHl(list);
  window.getSelection().removeAllRanges();
  $("pop").hidden = true;
  applyHighlights();
}

function wrapRange(p, s, e, id) {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("sup, .vb, .slot") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let n; (n = walker.nextNode());) nodes.push(n);
  let pos = 0;
  for (const n of nodes) {
    const len = n.length, a = Math.max(s - pos, 0), b = Math.min(e - pos, len);
    if (b > a) {
      const mid = a > 0 ? n.splitText(a) : n;
      if (b - a < mid.length) mid.splitText(b - a);
      const mk = document.createElement("mark");
      mk.className = "hl"; mk.dataset.id = id;
      mid.replaceWith(mk);
      mk.appendChild(mid);
    }
    pos += len;
  }
}

function applyHighlights() {
  document.querySelectorAll("#text mark.hl").forEach((m) => m.replaceWith(...m.childNodes));
  $("text").normalize();
  for (const h of loadHl()) {
    if (h.tr !== state.tr || h.book !== state.book) continue;
    for (const sg of h.segs) {
      const p = document.querySelector(`#text .v[data-ch="${sg.chapter}"][data-v="${sg.verse}"]`);
      if (p) wrapRange(p, sg.s, sg.e, h.id);
    }
  }
}

function updateHBtn() {
  const n = loadHl().length;
  $("hcount").textContent = n;
  $("hcount").hidden = !n;
}

function showHighlights() {
  const list = loadHl().sort((a, b) => b.created - a.created);
  $("hlist").innerHTML = list.length
    ? list.map((h) => `<div class="hi"><button type="button" class="hx" data-rm="${esc(h.id)}" title="Remove highlight" aria-label="Remove highlight">✕</button>` +
      `<a href="#" data-go="${esc(h.id)}"><b>${esc(h.label)}</b> <small>${esc(String(h.tr).toUpperCase())}</small></a><div class="ht">${esc(h.text)}</div></div>`).join("")
    : '<div class="empty">Nothing highlighted yet. Select some text and tap Highlight.</div>';
  if (!$("hdlg").open) $("hdlg").showModal();
}

async function gotoHighlight(id) {
  const h = loadHl().find((x) => x.id === id);
  if (!h) return;
  $("hdlg").close();
  $("tr").value = h.tr;
  $("ref").value = h.ref;
  await loadPassage(h.ref, h.tr);
  const marks = document.querySelectorAll(`#text mark[data-id="${id}"]`);
  marks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  marks.forEach((m) => m.classList.add("flash"));
  setTimeout(() => marks.forEach((m) => m.classList.remove("flash")), 1800);
}

/* ---------- next / previous chapter ---------- */

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($("toast").hidden = true), 2200);
}

async function turnChapter(delta) {
  if (!state.chapters.length || state.turning) return;
  const target = delta > 0 ? state.chapters.at(-1) + 1 : state.chapters[0] - 1;
  if (target < 1) return toast("That's the first chapter.");
  state.turning = true;
  const prev = state.reference;
  $("ref").value = `${state.book} ${target}`;
  toast(`Opening ${$("ref").value}…`);
  try {
    const ok = await loadPassage($("ref").value, state.tr);
    if (ok === false) {
      await loadPassage(prev, state.tr);
      $("ref").value = prev;
      toast(delta > 0 ? "That's the last chapter." : "That's the first chapter.");
    } else if (ok) { $("toast").hidden = true; window.scrollTo(0, 0); }
  } finally { state.turning = false; }
}

async function copyCurrent() {
  if (!current) return;
  const out = `“${current.text}” — ${current.label} (${$("tr").value.toUpperCase()})`;
  try { await navigator.clipboard.writeText(out); }
  catch { const t = document.createElement("textarea"); t.value = out; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  for (const b of [$("popCopy"), $("copyQ")]) { const old = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = old), 1200); }
}

const commCtx = [];

// Open claude.ai with a ready-made prompt (also copied, in case the page ignores the link text).
function askClaude(prompt) {
  try { navigator.clipboard?.writeText(prompt); } catch { /* the link still carries it */ }
  window.open(`https://claude.ai/new?q=${encodeURIComponent(prompt)}`, "_blank", "noopener");
}
const trName = () => $("tr").selectedOptions[0].textContent;

function questionPrompt(question, ch, v) {
  let where;
  if (v > 0) {
    const verse = state.verses.find((x) => x.chapter === ch && x.verse === v);
    where = `${state.book} ${ch}:${v}${verse ? ` (${trName()}): “${verse.text.replace(/\s+/g, " ").trim()}”` : ""}`;
  } else {
    where = `${state.reference} (${trName()}), the passage as a whole`;
  }
  return `I'm studying the Bible with a small group. One of us wrote a question about ${where}

Question: “${question}”

` +
    `Please do two things:
1. Study the question itself. Does it make sense? Is it clear, fair to what the text says, and answerable from Scripture? If not, say what's off and suggest a better wording.
` +
    `2. Give me some ideas toward an answer: what the text says, related verses, background that matters, and where thoughtful Christians read it differently. Don't hand me one final verdict; help me think it through and check it myself.`;
}

function commentPrompt(c) {
  return `I'm studying the Bible with a small group. We selected “${c.quote}” (${c.label}, ${trName()}) and read ${c.who} on ${c.ref}. Here is an excerpt:

${c.body}${c.body.length >= 900 ? "…" : ""}

` +
    `Please study this: does the commentary actually fit what the verse says? What is it assuming, and where might other readers disagree? Then give me some questions and ideas worth discussing, with related verses, so I can check it myself.`;
}

async function showCommentary() {
  if (!current) return;
  const sel = current, id = $("commSel").value, name = $("commSel").selectedOptions[0].textContent;
  $("commWrap").hidden = false;
  $("quote").innerHTML = `“${esc(sel.text)}”<small>${esc(sel.label)} · ${esc($("tr").value.toUpperCase())}</small>`;
  $("comm").innerHTML = '<div class="empty">Loading commentary…</div>';
  try {
    const out = [], seen = new Set();
    commCtx.length = 0;
    for (const chapter of [...new Set(sel.picked.map((p) => p.chapter))]) {
      const data = await commentaryChapter(id, state.bookId, chapter);
      const entries = data.chapter.content.filter((c) => c.type === "verse").sort((x, y) => x.number - y.number);
      for (const p of sel.picked.filter((q) => q.chapter === chapter)) {
        const i = entries.findLastIndex((e) => e.number <= p.verse);
        if (i < 0 || seen.has(`${chapter}:${entries[i].number}`)) continue;
        seen.add(`${chapter}:${entries[i].number}`);
        const from = entries[i].number, to = entries[i + 1] ? entries[i + 1].number - 1 : data.chapter.numberOfVerses;
        const body = entries[i].content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n").trim();
        if (body) commCtx.push({ kind: "c", who: name, ref: `${state.book} ${chapter}:${from}${to > from ? "–" + to : ""}`, quote: sel.text, label: sel.label, body: body.slice(0, 900) });
        if (body) out.push(`<div class="cm"><b>${esc(name)} on ${esc(state.book)} ${chapter}:${from}${to > from ? "–" + to : ""}</b>${esc(body)}</div><button type="button" class="cbtn" data-kind="c" data-i="${commCtx.length - 1}">Comments</button>`);
      }
    }
    $("comm").innerHTML = out.length ? out.join("") + `<div class="credit">Commentary text from public-domain works, served by bible.helloao.org.</div>`
      : `<div class="empty">${esc(name)} has nothing on this verse. Try another commentary.</div>`;
  } catch (e) {
    $("comm").innerHTML = `<div class="empty">${esc(e.message)} Try another commentary.</div>`;
  }
  $("commWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  return `<div class="note${q ? " q" : ""}"><b>${q ? '<span class="qt">Question</span> ' : ""}${esc(n.author)}${n.mine ? `<button class="del" data-id="${esc(n.id)}" title="Delete" aria-label="Delete">✕</button><button class="edit" data-id="${esc(n.id)}" title="Edit" aria-label="Edit">✎</button>` : ""}</b><span class="nb">${esc(n.body)}</span>${q ? `<button type="button" class="cbtn" data-kind="q" data-ch="${esc(n.chapter)}" data-v="${esc(n.verse)}">Comments</button>` : ""}</div>`;
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
document.addEventListener("selectionchange", () => { clearTimeout(updatePop.t); updatePop.t = setTimeout(updatePop, 150); });
document.addEventListener("scroll", () => { $("pop").hidden = true; }, { passive: true });
// keep the selection alive when the buttons are pressed
$("pop").addEventListener("mousedown", (e) => e.preventDefault());
$("popHl").addEventListener("click", highlightCurrent);
$("hbtn").addEventListener("click", showHighlights);
$("hdlg").addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]"), rm = e.target.closest("[data-rm]");
  if (go) { e.preventDefault(); gotoHighlight(go.dataset.go); }
  else if (rm && confirm("Remove this highlight?")) { saveHl(loadHl().filter((h) => h.id !== rm.dataset.rm)); applyHighlights(); showHighlights(); }
  else if (e.target === $("hdlg")) $("hdlg").close();
});
$("prevCh").addEventListener("click", () => turnChapter(-1));
$("nextCh").addEventListener("click", () => turnChapter(1));
document.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || document.body.classList.contains("reporting")) return;
  if (e.target.closest?.("input, textarea, select, dialog, button")) return;
  if (e.key === "ArrowRight") turnChapter(1);
  else if (e.key === "ArrowLeft") turnChapter(-1);
});
// swipe left / right on the passage to turn the chapter
let swipe = null;
const book = document.querySelector(".book");
book.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && !e.target.closest("textarea, input, select, .icard, .cm") ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
book.addEventListener("touchend", (e) => {
  const s = swipe;
  swipe = null;
  if (!s) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (Date.now() - s.at > 1500 || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
  turnChapter(dx < 0 ? 1 : -1);
}, { passive: true });
book.addEventListener("touchcancel", () => { swipe = null; }, { passive: true });
$("popComm").addEventListener("click", () => { showCommentary(); $("pop").hidden = true; });
$("popCopy").addEventListener("click", copyCurrent);
$("copyQ").addEventListener("click", copyCurrent);
$("commSel").addEventListener("change", showCommentary);
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
async function onEdit(e) {
  const b = e.target.closest(".edit, .esave, .ecancel");
  if (!b) return;
  const note = b.closest(".note");
  if (b.classList.contains("ecancel")) return refreshNotes();
  if (b.classList.contains("esave")) {
    const body = note.querySelector("textarea").value.trim();
    if (!body) return;
    try { await state.store.update(b.dataset.id, body); refreshNotes(); }
    catch (err) { alert("Could not save: " + err.message); }
    return;
  }
  const old = note.querySelector(".nb").textContent;
  note.querySelector(".nb").innerHTML =
    `<textarea class="eta" maxlength="2000"></textarea><span class="erow"><button class="esave" data-id="${esc(b.dataset.id)}">Save</button><button class="ecancel ghost2">Cancel</button></span>`;
  const ta = note.querySelector("textarea");
  ta.value = old; ta.focus();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".cbtn");
  if (!b) return;
  if (b.dataset.kind === "c") return askClaude(commentPrompt(commCtx[+b.dataset.i]));
  const q = b.closest(".note").querySelector(".nb").textContent;
  askClaude(questionPrompt(q, +b.dataset.ch, +b.dataset.v));
});
for (const id of ["notes", "gq"]) { $(id).addEventListener("click", onDelete); $(id).addEventListener("click", onEdit); }

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

updateHBtn();

(async function init() {
  [state.entities, state.words] = await Promise.all([getJSON("data/entities.json"), getJSON("data/words.json")]);
  try { state.store = SUPABASE_URL ? await remoteStore() : localStore(); }
  catch (e) { console.warn("Shared notes unavailable, using local notes:", e); state.store = localStore(); }
  state.store.subscribe(refreshNotes);
  updateWho();
  loadPassage($("ref").value, $("tr").value);
})();

#!/usr/bin/env node
/* Local approve/annotate review app for a batch of generated items.
 * Dependency-free: Node's http module only. Binds loopback and checks Origin
 * on the write route, because CORS stops a page reading the reply, not the
 * request arriving.
 *
 *   node review-server.js --items review-items.json [--out decisions.json]
 *                         [--port 4173] [--title "..."] [--subtitle "..."]
 *
 * Items file is either a JSON/JS array of items, or an object:
 *   { title, subtitle, reviewMode, groups: [{ key, name, dek }], items: [ ... ] }
 * reviewMode:
 *   "verdict"   Approve / Needs changes / Reject (default)
 *   "selection" "Use this description" checkbox + optional changes field
 * Item shape - every field except id is optional:
 *   { id, group, title, prompt, chips: [],
 *     meta:  { Label: value },
 *     tags:  { Label: ["a", "b"] },
 *     lists: { Label: ["..."] | { style: "fail", items: ["..."] } } }
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*|^ \* ?/gm, ""));
  process.exit(0);
}

const ITEMS_PATH = path.resolve(arg("--items", ""));
if (!ITEMS_PATH || !fs.existsSync(ITEMS_PATH)) {
  console.error("error: --items <file.json|file.js> is required and must exist");
  process.exit(1);
}
const PORT = Number(arg("--port", 4173));
const HOST = "127.0.0.1";
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const OUT = path.resolve(arg("--out", path.join(path.dirname(ITEMS_PATH), "decisions.json")));

const raw = /\.js$/.test(ITEMS_PATH)
  ? require(ITEMS_PATH)
  : JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));
const DOC = Array.isArray(raw) ? { items: raw } : raw;
const ITEMS = DOC.items || [];
if (!ITEMS.length) { console.error("error: no items found"); process.exit(1); }
const dupes = ITEMS.map((i) => i.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) { console.error("error: duplicate ids: " + dupes.join(", ")); process.exit(1); }

const TITLE = arg("--title", DOC.title || `${ITEMS.length} items for review`);
const SUBTITLE = arg("--subtitle", DOC.subtitle || "");
const REVIEW_MODE = DOC.reviewMode || "verdict";
if (!["verdict", "selection"].includes(REVIEW_MODE)) {
  console.error(`error: unsupported reviewMode '${REVIEW_MODE}'`);
  process.exit(1);
}
const GROUPS = DOC.groups || [...new Set(ITEMS.map((i) => i.group).filter(Boolean))]
  .map((k) => ({ key: k, name: k, dek: "" }));

const readDecisions = () => {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return {}; }
};
const writeDecisions = (d) => fs.writeFileSync(OUT, JSON.stringify(d, null, 2) + "\n");

const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const tagRow = (vals) => (vals && vals.length)
  ? vals.map((v) => `<span class="tag">${esc(v)}</span>`).join("")
  : `<span class="tag tag-none">none</span>`;

function listBlock(label, spec) {
  const items = Array.isArray(spec) ? spec : spec.items || [];
  const fail = !Array.isArray(spec) && spec.style === "fail";
  const inner = items.map((r) => `<li>${esc(r)}</li>`).join("");
  return `<div class="field"><div class="label">${esc(label)}</div>
    ${fail ? `<ul class="fails">${inner}</ul>` : `<ol class="rubric">${inner}</ol>`}</div>`;
}

function card(e) {
  const meta = Object.entries(e.meta || {})
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const chips = (e.chips || [])
    .map((c, i) => `<span class="chip${i === 0 ? " lead" : " ghost"}">${esc(c)}</span>`).join("");
  const tags = Object.entries(e.tags || {})
    .map(([k, v]) => `<div class="field"><div class="label">${esc(k)}</div>
      <div class="tags">${tagRow(v)}</div></div>`).join("");
  const lists = Object.entries(e.lists || {});
  const listHtml = lists.length
    ? `<div class="cols">${lists.map(([k, v]) => listBlock(k, v)).join("")}</div>`
    : "";
  const reviewControls = REVIEW_MODE === "selection"
    ? `<div class="selection-row">
        <label class="selection-control">
          <input class="select-description" type="checkbox">
          <span>Use this description</span>
        </label>
        <span class="saved" aria-live="polite"></span>
      </div>
      <label class="note-field">
        <span class="label">Additional changes requested <em>Optional</em></span>
        <textarea class="note" rows="3" placeholder="Add any optional wording or boundary changes."></textarea>
      </label>`
    : `<div class="verdict">
        <div class="btns">
          <button class="v" data-v="approve">Approve</button>
          <button class="v" data-v="revise">Needs changes</button>
          <button class="v" data-v="reject">Reject</button>
        </div>
        <span class="saved" aria-live="polite"></span>
      </div>
      <textarea class="note" rows="2" placeholder="Feedback - what would you change?"></textarea>`;
  return `
<article class="card" data-id="${esc(e.id)}">
  <div class="meta">
    <div class="id">${esc(e.id)}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ""}
    ${meta ? `<dl>${meta}</dl>` : ""}
  </div>
  <div class="body">
    ${e.title ? `<h3>${esc(e.title)}</h3>` : ""}
    ${e.prompt ? `<p class="prompt">${esc(e.prompt)}</p>` : ""}
    ${tags}
    ${listHtml}
    ${reviewControls}
  </div>
</article>`;
}

function page() {
  const sections = GROUPS.map((g) => {
    const list = ITEMS.filter((e) => String(e.group) === String(g.key));
    if (!list.length) return "";
    return `<section>
      <header class="sec">
        <div class="brandline">${esc(g.key)} &middot; ${list.length} item${list.length === 1 ? "" : "s"}</div>
        <h2>${esc(g.name)}</h2>
        ${g.dek ? `<p class="dek">${esc(g.dek)}</p>` : ""}
      </header>
      ${list.map(card).join("")}
    </section>`;
  }).join("");
  const ungrouped = ITEMS.filter((e) => !GROUPS.some((g) => String(g.key) === String(e.group)));
  const loose = ungrouped.length ? `<section>${ungrouped.map(card).join("")}</section>` : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#fbfaf7;--backdrop:#d8d5cc;--selected:#f2f0ea;--ink:#111;--muted:#444;--faint:#888;
 --rule:#eee;--rule2:#ddd;--border:#111;--navy:#2c3e6b;--teal:#5b8a82;--warn:#b5502e;
 --sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
*{box-sizing:border-box}
body,button,input,textarea,select{font-family:var(--sans)}
body{margin:0;background:var(--backdrop);color:var(--ink);font-size:12px;line-height:1.5}
.sheet{max-width:1120px;margin:0 auto;background:var(--paper);border-left:1px solid var(--rule2);border-right:1px solid var(--rule2);min-height:100vh}
.brandline{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--faint)}
.top{position:sticky;top:0;z-index:10;background:var(--paper);border-bottom:1px solid var(--border);padding:18px 32px 14px}
.wordmark{font-size:24px;font-weight:700;letter-spacing:-.03em;margin:2px 0 0}
.topgrid{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap}
.tally{display:flex;border:1px solid var(--border)}
.tally div{padding:6px 14px;border-right:1px solid var(--rule2);min-width:92px}
.tally div:last-child{border-right:0}
.tally b{display:block;font-size:24px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.tally span{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--faint)}
.t-appr b{color:var(--teal)}.t-rev b{color:var(--warn)}.t-rej b{color:var(--muted)}
section{padding:0 32px}
.sec{padding:34px 0 16px;border-bottom:1px solid var(--border)}
.sec h2{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:6px 0}
.dek{font-size:12px;line-height:1.5;color:var(--muted);max-width:74ch;margin:0}
.card{display:grid;grid-template-columns:184px 1fr;gap:28px;padding:24px 0;border-bottom:1px solid var(--rule)}
.card[data-v]{background:var(--selected);margin:0 -32px;padding:24px 32px}
.card[data-v="approve"]{box-shadow:inset 3px 0 0 0 var(--teal)}
.card[data-v="revise"]{box-shadow:inset 3px 0 0 0 var(--warn)}
.card[data-v="reject"]{box-shadow:inset 3px 0 0 0 var(--faint)}
.card[data-selected="true"]{background:var(--selected);margin:0 -32px;padding:24px 32px;box-shadow:inset 3px 0 0 0 var(--teal)}
.id{font-size:12px}
.chips{display:flex;gap:6px;margin:8px 0 12px;flex-wrap:wrap}
.chip{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:4px 8px;border:1px solid var(--border);line-height:1}
.chip.lead{background:var(--ink);color:#fff}
.chip.ghost{border-color:var(--rule2);color:var(--muted)}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px}
dt{color:var(--faint)}dd{margin:0}
.body h3{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px}
.prompt{font-size:16px;line-height:1.55;margin:0 0 18px;max-width:72ch;border-left:2px solid var(--navy);padding-left:14px}
.field{margin-bottom:16px}
.label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin-bottom:6px}
.tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:12px;font-weight:500;line-height:1;padding:7px 9px;background:#fff;border:1px solid var(--rule2)}
.tag-none{color:var(--faint);background:transparent;border-style:dashed}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.rubric,.fails{margin:0;font-size:16px;line-height:1.55}
.rubric{padding-left:18px}
.rubric li,.fails li{margin-bottom:4px}
.fails{list-style:none;padding-left:0}
.fails li{color:var(--warn);padding-left:14px;position:relative}
.fails li::before{content:"\\00d7";position:absolute;left:0;font-weight:700}
.verdict{display:flex;align-items:center;gap:12px;margin:18px 0 8px}
.selection-row{display:flex;align-items:center;gap:12px;margin:18px 0 12px}
.selection-control{display:inline-flex;align-items:center;gap:9px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
.selection-control input{appearance:none;width:20px;height:20px;margin:0;background:#fff;border:1px solid var(--border);border-radius:0;display:grid;place-content:center;cursor:pointer}
.selection-control input::before{content:"";width:10px;height:10px;transform:scale(0);background:var(--teal)}
.selection-control input:checked::before{transform:scale(1)}
.selection-control input:focus-visible{outline:2px solid var(--navy);outline-offset:2px}
.note-field{display:block;max-width:74ch}
.note-field .label{display:flex;align-items:baseline;gap:8px}
.note-field em{font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:none;color:var(--faint)}
.btns{display:flex}
button.v{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
 height:35px;padding:0 16px;background:#fff;color:var(--ink);border:1px solid var(--border);border-right-width:0;cursor:pointer}
button.v:last-child{border-right-width:1px}
button.v:hover{background:var(--selected)}
button.v[aria-pressed="true"][data-v="approve"]{background:var(--teal);border-color:var(--teal);color:#fff}
button.v[aria-pressed="true"][data-v="revise"]{background:var(--warn);border-color:var(--warn);color:#fff}
button.v[aria-pressed="true"][data-v="reject"]{background:var(--muted);border-color:var(--muted);color:#fff}
.saved{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--teal);opacity:0;transition:opacity .2s}
.saved.on{opacity:1}
textarea.note{width:100%;max-width:74ch;font-size:12px;line-height:1.5;padding:10px 12px;
 background:#fff;border:1px solid var(--rule2);border-radius:0;resize:vertical}
textarea.note:focus{outline:none;border-color:var(--border)}
footer{padding:28px 32px 56px;border-top:1px solid var(--border);margin-top:24px}
footer code{font-size:12px;background:#fff;border:1px solid var(--rule2);padding:3px 6px}
@media (max-width:820px){.card{grid-template-columns:1fr}.cols{grid-template-columns:1fr}}
</style></head><body>
<div class="sheet">
  <div class="top"><div class="topgrid">
    <div>
      <div class="brandline">Staged for review</div>
      <h1 class="wordmark">${esc(TITLE)}</h1>
      ${SUBTITLE ? `<div class="brandline" style="color:var(--muted);margin-top:6px">${esc(SUBTITLE)}</div>` : ""}
    </div>
    ${REVIEW_MODE === "selection"
      ? `<div class="tally">
          <div class="t-appr"><b id="n-selected">0</b><span>Selected</span></div>
          <div class="t-rev"><b id="n-noted">0</b><span>With changes</span></div>
          <div><b id="n-open">${ITEMS.length}</b><span>Not selected</span></div>
        </div>`
      : `<div class="tally">
          <div class="t-appr"><b id="n-approve">0</b><span>Approved</span></div>
          <div class="t-rev"><b id="n-revise">0</b><span>Changes</span></div>
          <div class="t-rej"><b id="n-reject">0</b><span>Rejected</span></div>
          <div><b id="n-open">${ITEMS.length}</b><span>Undecided</span></div>
        </div>`}
  </div></div>
  ${sections}${loose}
  <footer><div class="brandline" style="color:var(--muted)">Every verdict autosaves to <code>${esc(path.basename(OUT))}</code></div></footer>
</div>
<script>
const TOTAL = ${ITEMS.length};
const REVIEW_MODE = ${JSON.stringify(REVIEW_MODE)};
const state = ${JSON.stringify(readDecisions())};
function paint(card){
  const id=card.dataset.id, d=state[id]||{};
  if(REVIEW_MODE==="selection"){
    card.querySelector(".select-description").checked=d.selected===true;
    if(d.selected===true)card.dataset.selected="true";else delete card.dataset.selected;
  }else{
    card.querySelectorAll("button.v").forEach(b=>b.setAttribute("aria-pressed",String(d.verdict===b.dataset.v)));
    if(d.verdict) card.dataset.v=d.verdict; else delete card.dataset.v;
  }
  const note=card.querySelector("textarea.note");
  // Never rewrite the box the reviewer is typing in - it resets the caret.
  if(document.activeElement!==note) note.value=d.note||"";
}
function tally(){
  if(REVIEW_MODE==="selection"){
    const selected=Object.values(state).filter(d=>d.selected===true).length;
    const noted=Object.values(state).filter(d=>d.note&&d.note.trim()).length;
    n("n-selected",selected);n("n-noted",noted);n("n-open",TOTAL-selected);
    return;
  }
  const c={approve:0,revise:0,reject:0};
  Object.values(state).forEach(d=>{if(d.verdict)c[d.verdict]++;});
  n("n-approve",c.approve);n("n-revise",c.revise);n("n-reject",c.reject);
  n("n-open",TOTAL-(c.approve+c.revise+c.reject));
}
const n=(id,v)=>document.getElementById(id).textContent=v;
const timers={};
function save(card,flash){
  const id=card.dataset.id;
  clearTimeout(timers[id]);
  const go=()=>fetch("/api/decision",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({id,...state[id]})}).then(()=>{
      if(!flash)return;
      const s=card.querySelector(".saved");
      s.textContent="saved";s.classList.add("on");setTimeout(()=>s.classList.remove("on"),1200);
    });
  flash?go():(timers[id]=setTimeout(go,500));
}
document.querySelectorAll(".card").forEach(card=>{
  const id=card.dataset.id;
  paint(card);
  if(REVIEW_MODE==="selection"){
    card.querySelector(".select-description").addEventListener("change",ev=>{
      state[id]={...(state[id]||{}),selected:ev.target.checked};
      paint(card);tally();save(card,true);
    });
  }else{
    card.querySelectorAll("button.v").forEach(b=>b.addEventListener("click",()=>{
      const cur=(state[id]||{}).verdict;
      state[id]={...(state[id]||{}),verdict:cur===b.dataset.v?null:b.dataset.v};
      paint(card);tally();save(card,true);
    }));
  }
  card.querySelector("textarea.note").addEventListener("input",ev=>{
    state[id]={...(state[id]||{}),note:ev.target.value};
    save(card,false);
  });
});
tally();
</script></body></html>`;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/")
    return send(res, 200, "text/html; charset=utf-8", page());
  if (req.method === "GET" && url.pathname === "/api/decisions")
    return send(res, 200, "application/json", JSON.stringify(readDecisions(), null, 2));
  if (req.method === "POST" && url.pathname === "/api/decision") {
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) return send(res, 403, "text/plain", "bad origin");
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const { id, verdict, selected, note } = JSON.parse(body);
        if (!ITEMS.some((e) => e.id === id)) return send(res, 404, "text/plain", "unknown id");
        const all = readDecisions();
        if (REVIEW_MODE === "selection") {
          if (!selected && !note) delete all[id];
          else all[id] = { selected: selected === true, note: note || "", at: new Date().toISOString() };
        } else if (!verdict && !note) delete all[id];
        else all[id] = { verdict: verdict || null, note: note || "", at: new Date().toISOString() };
        writeDecisions(all);
        send(res, 200, "application/json", JSON.stringify({ ok: true }));
      } catch { send(res, 400, "text/plain", "bad request"); }
    });
    return;
  }
  send(res, 404, "text/plain", "not found");
}).listen(PORT, HOST, () => {
  console.log(`review app  http://${HOST}:${PORT}`);
  console.log(`items       ${ITEMS_PATH} (${ITEMS.length})`);
  console.log(`verdicts    ${OUT}`);
});

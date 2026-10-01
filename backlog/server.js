#!/usr/bin/env node
/* Crew backlog - a local, shared, reorderable backlog with approve/decline.
 *
 *   node backlog/server.js [--file backlog/backlog.json] [--port 4190]
 *
 * Unlike a one-shot review app, this is durable: items, their rank, their
 * status and their notes all live in one committed JSON file, so the backlog
 * travels with the repo and is reviewable in a diff.
 *
 * Security posture matches the house review app: loopback-only bind, and an
 * Origin check on every mutating route, because CORS stops a page reading the
 * reply - it does not stop the request arriving.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*|^ \* ?/gm, ""));
  process.exit(0);
}

const FILE = path.resolve(arg("--file", path.join(__dirname, "backlog.json")));
const PORT = Number(arg("--port", 4190));
const HOST = "127.0.0.1";
const STATUSES = ["approved", "declined", "done"];
// Populated once the socket is bound, so --port 0 (used by the tests) still
// gets an accurate allow-list rather than one built from the requested port.
let ORIGINS = new Set();

if (!fs.existsSync(FILE)) {
  console.error(`error: ${FILE} does not exist`);
  process.exit(1);
}

function load() {
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  doc.items = doc.items || [];
  doc.state = doc.state || {};
  const dupes = doc.items.map((i) => i.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new Error(`duplicate ids: ${dupes.join(", ")}`);
  // Order is advisory: unknown ids drop out, new items land at the end, so
  // hand-editing items[] can never strand or duplicate a card.
  const ids = doc.items.map((i) => i.id);
  const ranked = (doc.order || []).filter((id) => ids.includes(id));
  doc.order = [...ranked, ...ids.filter((id) => !ranked.includes(id))];
  return doc;
}

/* Write through a temp file in the same directory, then rename. A crash or a
 * concurrent read can then never observe a half-written backlog - this file is
 * the only copy of the decisions. */
function save(doc) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, FILE);
}

let DOC = load();

const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function card(e, index) {
  const meta = [
    e.size ? ["Size", e.size] : null,
    e.group ? ["Area", e.group] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return `
<article class="card" data-id="${esc(e.id)}" draggable="true">
  <div class="rail">
    <div class="handle" title="Drag to re-rank">::</div>
    <div class="rank"><span class="rank-n">${index + 1}</span></div>
    <div class="id">${esc(e.id)}</div>
    ${meta ? `<dl>${meta}</dl>` : ""}
    <div class="moves">
      <button class="mv" data-mv="up" aria-label="Move up">&uarr;</button>
      <button class="mv" data-mv="down" aria-label="Move down">&darr;</button>
    </div>
  </div>
  <div class="body">
    <h3>${esc(e.title)}</h3>
    ${e.detail ? `<p class="detail">${esc(e.detail)}</p>` : ""}
    ${e.why ? `<div class="field"><div class="label">Why it matters</div><p class="why">${esc(e.why)}</p></div>` : ""}
    ${e.evidence ? `<div class="field"><div class="label">Evidence</div><div class="tags"><span class="tag">${esc(e.evidence)}</span></div></div>` : ""}
    <div class="verdict">
      <div class="btns">
        <button class="v" data-v="approved">Approve</button>
        <button class="v" data-v="declined">Decline</button>
        <button class="v" data-v="done">Done</button>
      </div>
      <span class="saved" aria-live="polite"></span>
    </div>
    <textarea class="note" rows="2" placeholder="Note - scope, caveats, who picks it up"></textarea>
  </div>
</article>`;
}

function page() {
  const byId = new Map(DOC.items.map((i) => [i.id, i]));
  const ordered = DOC.order.map((id) => byId.get(id)).filter(Boolean);
  const total = ordered.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(DOC.title || "Backlog")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#fbfaf7;--backdrop:#d8d5cc;--selected:#f2f0ea;--ink:#111;--muted:#444;--faint:#888;
 --rule:#eee;--rule2:#ddd;--border:#111;--navy:#2c3e6b;--teal:#5b8a82;--warn:#b5502e;--tan:#c9a084;
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
.t-appr b{color:var(--teal)}.t-dec b{color:var(--warn)}.t-done b{color:var(--navy)}
main{padding:0 32px}
.card{display:grid;grid-template-columns:184px 1fr;gap:28px;padding:24px 0;border-bottom:1px solid var(--rule);background:var(--paper)}
.card[data-v]{background:var(--selected);margin:0 -32px;padding:24px 32px}
.card[data-v="approved"]{box-shadow:inset 3px 0 0 0 var(--teal)}
.card[data-v="declined"]{box-shadow:inset 3px 0 0 0 var(--warn);opacity:.62}
.card[data-v="done"]{box-shadow:inset 3px 0 0 0 var(--navy);opacity:.62}
.card.dragging{opacity:.4}
.card.over{box-shadow:inset 0 3px 0 0 var(--navy)}
.handle{font-size:16px;font-weight:700;letter-spacing:.14em;color:var(--faint);cursor:grab;line-height:1;user-select:none}
.rank{margin:8px 0 10px}
.rank-n{display:inline-block;min-width:28px;padding:4px 7px;border:1px solid var(--border);font-size:12px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums}
.id{font-size:12px;color:var(--muted);margin-bottom:8px}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px}
dt{color:var(--faint)}dd{margin:0}
.moves{display:flex;margin-top:12px}
button.mv{font-size:12px;width:30px;height:28px;background:#fff;border:1px solid var(--border);border-right-width:0;cursor:pointer;line-height:1}
button.mv:last-child{border-right-width:1px}
button.mv:hover{background:var(--selected)}
.body h3{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px}
.detail{font-size:16px;line-height:1.55;margin:0 0 18px;max-width:72ch;border-left:2px solid var(--navy);padding-left:14px}
.field{margin-bottom:16px}
.label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin-bottom:6px}
.why{font-size:12px;line-height:1.55;margin:0;max-width:74ch;color:var(--muted)}
.tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:12px;font-weight:500;line-height:1;padding:7px 9px;background:#fff;border:1px solid var(--rule2);color:var(--muted)}
.verdict{display:flex;align-items:center;gap:12px;margin:18px 0 8px}
.btns{display:flex}
button.v{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
 height:35px;padding:0 16px;background:#fff;color:var(--ink);border:1px solid var(--border);border-right-width:0;cursor:pointer}
button.v:last-child{border-right-width:1px}
button.v:hover{background:var(--selected)}
button.v[aria-pressed="true"][data-v="approved"]{background:var(--teal);border-color:var(--teal);color:#fff}
button.v[aria-pressed="true"][data-v="declined"]{background:var(--warn);border-color:var(--warn);color:#fff}
button.v[aria-pressed="true"][data-v="done"]{background:var(--navy);border-color:var(--navy);color:#fff}
.saved{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--teal);opacity:0;transition:opacity .2s}
.saved.on{opacity:1}
textarea.note,input.f{width:100%;max-width:74ch;font-size:12px;line-height:1.5;padding:10px 12px;
 background:#fff;border:1px solid var(--rule2);border-radius:0;resize:vertical}
textarea.note:focus,input.f:focus{outline:none;border-color:var(--border)}
.adder{padding:28px 32px;border-top:1px solid var(--border);margin-top:24px}
.adder h2{font-size:16px;font-weight:700;margin:6px 0 14px}
.adder .row{display:flex;gap:10px;align-items:flex-start;max-width:74ch;margin-bottom:10px}
button.add{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;height:35px;padding:0 18px;
 background:var(--ink);color:#fff;border:1px solid var(--ink);cursor:pointer}
button.add:hover{background:#333}
footer{padding:22px 32px 56px}
footer code{font-size:12px;background:#fff;border:1px solid var(--rule2);padding:3px 6px}
@media (max-width:820px){.card{grid-template-columns:1fr}}
</style></head><body>
<div class="sheet">
  <div class="top"><div class="topgrid">
    <div>
      <div class="brandline">Shared backlog &middot; ${total} item${total === 1 ? "" : "s"}</div>
      <h1 class="wordmark">${esc(DOC.title || "Backlog")}</h1>
      ${DOC.subtitle ? `<div class="brandline" style="color:var(--muted);margin-top:6px">${esc(DOC.subtitle)}</div>` : ""}
    </div>
    <div class="tally">
      <div class="t-appr"><b id="n-approved">0</b><span>Approved</span></div>
      <div class="t-dec"><b id="n-declined">0</b><span>Declined</span></div>
      <div class="t-done"><b id="n-done">0</b><span>Done</span></div>
      <div><b id="n-open">${total}</b><span>Undecided</span></div>
    </div>
  </div></div>
  <main id="list">${ordered.map(card).join("")}</main>
  <section class="adder">
    <div class="brandline">Add to the backlog</div>
    <h2>Propose another next step</h2>
    <div class="row"><input class="f" id="f-title" placeholder="Title - what we would do"></div>
    <div class="row"><input class="f" id="f-detail" placeholder="Detail - what it actually involves"></div>
    <div class="row"><input class="f" id="f-why" placeholder="Why it matters"></div>
    <div class="row">
      <input class="f" id="f-group" placeholder="Area" style="max-width:220px">
      <input class="f" id="f-size" placeholder="Size" style="max-width:220px">
      <button class="add" id="f-add">Add item</button>
    </div>
  </section>
  <footer><div class="brandline" style="color:var(--muted)">Rank, status and notes autosave to <code>${esc(path.basename(FILE))}</code> &mdash; commit it to share</div></footer>
</div>
<script>
const state = ${JSON.stringify(DOC.state)};
const list = document.getElementById("list");
const n = (id, v) => document.getElementById(id).textContent = v;

function renumber(){
  [...list.querySelectorAll(".card")].forEach((c,i) => c.querySelector(".rank-n").textContent = i + 1);
}
function tally(){
  const c = {approved:0, declined:0, done:0};
  Object.values(state).forEach(d => { if (d.status && c[d.status] !== undefined) c[d.status]++; });
  n("n-approved", c.approved); n("n-declined", c.declined); n("n-done", c.done);
  n("n-open", list.querySelectorAll(".card").length - (c.approved + c.declined + c.done));
}
function paint(card){
  const d = state[card.dataset.id] || {};
  card.querySelectorAll("button.v").forEach(b =>
    b.setAttribute("aria-pressed", String(d.status === b.dataset.v)));
  if (d.status) card.dataset.v = d.status; else delete card.dataset.v;
  const note = card.querySelector("textarea.note");
  // Never rewrite the box the reviewer is typing in - it resets the caret.
  if (document.activeElement !== note) note.value = d.note || "";
}

const timers = {};
function saveItem(card, flash){
  const id = card.dataset.id;
  clearTimeout(timers[id]);
  const go = () => fetch("/api/item", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({ id, ...state[id] })
  }).then(() => {
    if (!flash) return;
    const s = card.querySelector(".saved");
    s.textContent = "saved"; s.classList.add("on");
    setTimeout(() => s.classList.remove("on"), 1200);
  });
  flash ? go() : (timers[id] = setTimeout(go, 500));
}
function saveOrder(){
  const order = [...list.querySelectorAll(".card")].map(c => c.dataset.id);
  renumber();
  return fetch("/api/order", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({ order })
  });
}

function wire(card){
  const id = card.dataset.id;
  paint(card);
  card.querySelectorAll("button.v").forEach(b => b.addEventListener("click", () => {
    const cur = (state[id] || {}).status;
    // Clicking the active status clears it - reviewers change their minds.
    state[id] = { ...(state[id] || {}), status: cur === b.dataset.v ? null : b.dataset.v };
    paint(card); tally(); saveItem(card, true);
  }));
  card.querySelector("textarea.note").addEventListener("input", ev => {
    state[id] = { ...(state[id] || {}), note: ev.target.value };
    saveItem(card, false);
  });
  card.querySelectorAll("button.mv").forEach(b => b.addEventListener("click", () => {
    const sib = b.dataset.mv === "up" ? card.previousElementSibling : card.nextElementSibling;
    if (!sib) return;
    b.dataset.mv === "up" ? list.insertBefore(card, sib) : list.insertBefore(sib, card);
    card.querySelector('button.mv[data-mv="' + b.dataset.mv + '"]').focus();
    saveOrder();
  }));
  card.addEventListener("dragstart", ev => {
    dragged = card; card.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", id);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    list.querySelectorAll(".over").forEach(c => c.classList.remove("over"));
    dragged = null; saveOrder();
  });
  card.addEventListener("dragover", ev => {
    if (!dragged || dragged === card) return;
    ev.preventDefault();
    const mid = card.getBoundingClientRect().top + card.offsetHeight / 2;
    list.insertBefore(dragged, ev.clientY < mid ? card : card.nextElementSibling);
  });
}
let dragged = null;
list.addEventListener("dragover", ev => ev.preventDefault());
document.querySelectorAll(".card").forEach(wire);

document.getElementById("f-add").addEventListener("click", () => {
  const val = id => document.getElementById(id).value.trim();
  if (!val("f-title")) { document.getElementById("f-title").focus(); return; }
  fetch("/api/new", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({
      title: val("f-title"), detail: val("f-detail"), why: val("f-why"),
      group: val("f-group"), size: val("f-size")
    })
  }).then(r => r.json()).then(res => {
    if (res.ok) location.reload();
  });
});
tally(); renumber();
</script></body></html>`;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
});

function nextId(doc) {
  const nums = doc.items
    .map((i) => /^CB-(\d+)$/.exec(i.id))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return `CB-${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  if (req.method === "GET" && url.pathname === "/") {
    DOC = load();
    return send(res, 200, "text/html; charset=utf-8", page());
  }
  if (req.method === "GET" && url.pathname === "/api/backlog")
    return send(res, 200, "application/json", JSON.stringify(load(), null, 2));

  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) return send(res, 403, "text/plain", "bad origin");
    let payload;
    try { payload = await readBody(req); } catch { return send(res, 400, "text/plain", "bad request"); }
    const doc = load();

    if (url.pathname === "/api/item") {
      const { id, status, note } = payload;
      if (!doc.items.some((i) => i.id === id)) return send(res, 404, "text/plain", "unknown id");
      if (status && !STATUSES.includes(status)) return send(res, 400, "text/plain", "bad status");
      if (!status && !note) delete doc.state[id];
      else doc.state[id] = { status: status || null, note: note || "", at: new Date().toISOString() };
      save(doc);
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/api/order") {
      const ids = doc.items.map((i) => i.id);
      const incoming = Array.isArray(payload.order) ? payload.order : [];
      // Accept only a permutation of the known ids; anything else would drop
      // or duplicate an item, and this file is the only copy.
      const clean = incoming.filter((id, i) => ids.includes(id) && incoming.indexOf(id) === i);
      if (clean.length !== ids.length) return send(res, 400, "text/plain", "bad order");
      doc.order = clean;
      save(doc);
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/api/new") {
      const title = String(payload.title || "").trim();
      if (!title) return send(res, 400, "text/plain", "title required");
      const id = nextId(doc);
      const item = { id, title };
      for (const k of ["group", "size", "detail", "why"]) {
        const v = String(payload[k] || "").trim();
        if (v) item[k] = v;
      }
      doc.items.push(item);
      doc.order.push(id);
      save(doc);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, id }));
    }
  }
  send(res, 404, "text/plain", "not found");
});

server.on("listening", () => {
  const port = server.address().port;
  ORIGINS = new Set([`http://${HOST}:${port}`, `http://localhost:${port}`]);
  console.log(`crew backlog  http://${HOST}:${port}`);
  console.log(`file          ${FILE} (${DOC.items.length} items)`);
});

/* This machine routinely has a handful of local tools listening, so a fixed
 * port is a coin flip. Walk upward a few slots rather than dying on a port
 * nobody chose deliberately; --port 0 is left alone, since that means "any". */
let attempts = 0;
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE" || PORT === 0 || attempts >= 9) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  attempts += 1;
  server.listen(PORT + attempts, HOST);
});

server.listen(PORT, HOST);

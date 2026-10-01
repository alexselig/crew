# Crew backlog

A shared, ordered backlog that lives in this repo. Items, their rank, their
status and their notes are all in [`backlog.json`](backlog.json), so the backlog
travels with the code, shows up in a diff, and can be reviewed in a PR.

```bash
npm run backlog          # then open http://127.0.0.1:4190
```

If that port is busy the server walks upward a few slots and prints the URL it
actually bound; pass `--port` to pin one.

## Working with it

- **Rank it.** Drag a card by its `::` handle, or use the arrow buttons on the
  left rail. Position *is* priority — the top of the list is what we do next.
- **Decide.** Approve, Decline, or mark Done. Clicking the active status clears
  it again.
- **Annotate.** The note is for scope, caveats, or who picks it up.
- **Add.** The form at the bottom appends a new item with the next free id.

Everything autosaves: statuses and ranks immediately, notes 500 ms after you
stop typing. There is no export step.

## Sharing it

`backlog.json` is the shared artifact. After a session with the app:

```bash
git add backlog/backlog.json && git commit -m "Backlog: re-rank and triage"
```

Ids are stable and the file is keyed by id, so two people editing different
items produce a readable conflict rather than a lost decision.

## Reading it without the app

```bash
# What we agreed to do next, in order
node -e 'const d=require("./backlog/backlog.json");
  d.order.map(id=>[id,d.items.find(i=>i.id===id)]).
  filter(([id])=>d.state[id]?.status==="approved").
  forEach(([id,i],n)=>console.log(`${n+1}. ${id}  ${i.title}`))'
```

`GET /api/backlog` serves the same document while the app is running.

## Notes

- Binds `127.0.0.1` only, and checks `Origin` on every write — CORS stops a page
  reading the reply, not the request arriving.
- Writes go through a temp file and a rename, because this file is the only copy
  of the decisions.
- A reorder is accepted only if it is a permutation of the known ids, so a stale
  tab cannot drop an item.
- Hand-editing `items` is fine: ids missing from `order` are appended, and ids in
  `order` that no longer exist are ignored. Changing an id orphans its status.
- Covered by `test/backlog-app.test.ts`.

The look is the house style from `ToolsUI-Design.md` — paper, 1px rules, no
border radius, teal for approved, rust for declined, navy for done.

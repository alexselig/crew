# Durable session preservation and low-loss continuation

Date: 2026-09-11
Status: Architecture approved; detailed specification awaiting user review.

## 1. Decision and approval boundary

Build a Crew-owned session vault. Preserve exact captured originals independently
of the agent provider. Compact the working context, not the only surviving copy
of history.

The user approved:

- Exact originals in a losslessly compressed archive, without automatic deletion.
- Coverage for Copilot, Claude Code, shell, and custom-command sessions.
- The vault-first architecture and writing this specification.

The numerical defaults and detailed capture/recovery contract below are proposed
defaults. The user became unavailable before reviewing them. This document does
not authorize implementation, an installer change, a migration of live data,
background inference, or a destructive recovery exercise. Obtain written-spec
approval before implementation planning.

## 2. What the audit established

This is a preservation-focused audit of storage, lifecycle, restore UX, and
handoffs, not a claim that every unrelated Crew feature has been audited.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Crew's roster is a JSON store in Electron userData; provider histories live elsewhere. | `src/main/index.ts:927-929`; `src/main/store.ts:28-45`; `src/main/agent-transcript.ts:22-44` | A surviving roster is not proof that its conversation is recoverable. |
| The roster is replaced as a collection when saved. | `src/main/store.ts:406-408`; `src/main/session-manager.ts:758-785` | An incomplete in-memory roster can become a persisted omission. |
| The store has rotating backups, corrupt-file quarantine, and dated snapshots. | `src/main/store.ts:205-249,275-303,332-348` | Useful recovery exists, but it is not an immutable session archive. |
| Dated snapshots retain 14 files. | `src/main/store.ts:332-348` | These are a bounded metadata recovery window, not permanent history. |
| Local terminal recording is optional and buffered. | `src/main/transcripts.ts:18-87` | Historical terminal output cannot be assumed to exist, and buffered output has a crash-loss window. |
| Handoffs read the Copilot session database and write extracted briefs. | `scripts/handoff.mjs:31-38,108-176,252-288` | Briefs are derived views, not backups of the source corpus. |
| Auto restore switches at 2 MiB of transcript bytes when a brief exists. | `src/main/handoff.ts:52-54,71-103` | Physical event-log bytes are not a model-context measurement. |
| Brief lookup uses an eight-character session-ID filename suffix. | `src/main/handoff.ts:15-33` | The new vault must use full identifiers and validated manifests. |
| Restore is lazy and preserves current/prior provider IDs. | `src/main/session-manager.ts:801-854`; `test/restore-lazy.test.ts:159-253` | Keep lazy restore, but extend lineage beyond one prior ID. |
| Install scripts replace the application bundle; in-app updates are notification-only. | `install.sh:54-69`; `install-crew.sh:27-45`; `src/main/updater.ts:20-62` | Data durability must not depend on retaining the old application bundle. |

Additional bounded follow-up findings:

- Installers already poll for exit for up to 15 seconds and abort if Crew remains
  running (`install.sh:52-60`; `install-crew.sh:27-31`). Preserve this safeguard.
  The remaining replacement gap is deleting the old bundle before copying the
  new one (`install.sh:64-65`; `install-crew.sh:41`), not an absent quit check.
- Teardown disposes/flushes recording before disposing session producers
  (`src/main/index.ts:470-475`; `src/main/transcripts.ts:72-79`). The new protocol
  must account for final output after that initial flush.
- Migration persistence uses ordinary rotating backups, not a dedicated
  immutable pre-migration snapshot (`src/main/store.ts:193-203,271-299`).
- The inspected snapshot API lists dated backups, but has no corresponding
  snapshot-restore IPC/UI flow (`src/main/store.ts:352-366`).
- Handoffs include both sides of only the last 14 turns, with a combined
  14,000-character tail budget; touched files are limited to 12 paths and
  references to 8 entries (`scripts/handoff.mjs:66-83,147-155,216-236`).
  Tool results are not preserved as structured records, pending work appears
  only through checkpoint text, and attachments are not captured as objects.
- The existing handoff generator is Copilot-specific; launching/resuming Claude,
  shells, or custom commands does not give those sessions equivalent brief
  coverage (`scripts/handoff.mjs:1-6`; `src/main/presets.ts:17-58`).
- The optional recorder clears each buffered chunk even if `appendFileSync`
  fails; it also strips ANSI and flushes on a 1.5-second timer
  (`src/main/transcripts.ts:1-43`). This is a concrete data-loss path on write
  failure, not just a theoretical corruption concern.
- Closing a session removes its map entry and persists the remaining roster;
  the existing `archiveSession()` instead clears workspace membership while
  leaving the session running (`src/main/session-manager.ts:500-506,634-650,758-785`).
  Neither behavior is a durable closed-session archive.
- Renderer delivery coalesces output every 40 ms and drops oldest pending output
  past its 512 KiB cap (`src/main/session-manager.ts:1-120`). This is a display
  limit, not an acceptable preservation limit.
- The transcript view reads provider files in place and may inline referenced
  images in memory, subject to a 3 MiB per-image and 6 MiB total image budget
  (`src/main/agent-transcript.ts:46-77`). This does not persist those attachments.

Existing tests cover corruption fallback, migration idempotence, snapshot
retention, lazy restore, lineage, handoff selection, and generated-brief cleanup.
They do not establish end-to-end power-loss, reinstall, archive-integrity, or
compaction-fidelity guarantees.

The README's claim that a 0.5 MB history costs more than a million tokens must
not become a design assumption. Neither file size nor serialized event volume
alone proves what a provider replays, compacts, or charges for.

## 3. Preservation contract

### Meaning of "100%"

For every item Crew marks **Preserved**, recovery must return the exact captured
bytes plus the associated identity, order, and provenance. Lossless compression
must round-trip byte-for-byte. Compaction never replaces those bytes.

The guarantee applies to committed data on a functioning storage device across
normal app quit, process crash, supported upgrade/reinstall, and OS restart.
It does not claim that an executing process, unsaved editor buffer, provider's
unexposed internal state, or bytes not yet delivered to Crew survive a reboot.
Protection against disk loss requires an independently located backup.

Distinguish three outcomes:

1. **Exact history recovery:** retrieve captured history and artifacts unchanged.
2. **Native resume:** the provider resumes a compatible conversation it owns.
3. **Reconstructed continuation:** a new provider conversation receives a
   source-linked working-context package; it is not labeled native resume.

Shell and unsupported custom commands receive exact captured output and launch
metadata, not a promise to serialize arbitrary process memory or shell state.
Never rerun a command merely because its session was restored.

### Capture scope

Include logical session metadata, workspace membership, launch descriptors,
provider conversation lineage, Crew-observed terminal output, available native
provider histories/checkpoints, and explicitly session-owned attachments and
artifacts. Preserve unknown provider records opaquely even if the UI cannot
interpret them.

Do not log raw stdin, environment variables, credentials from authentication
stores, or entire repositories. Submitted prompts are captured from provider
records when available; no-password-input capture is not a claim that terminal
output or provider records cannot themselves contain secrets.

The preservation setting and privacy copy must explain that exact output and
attachments may contain sensitive material. Restrict vault directory/file
permissions to the current user where supported. Do not send archive content
to a remote service, enable sync, or start inference implicitly. Existing OS disk
encryption is a deployment property, not an encryption feature supplied by Crew.

A referenced repository file is a reference, not a backup. Preserve attachments
and session-owned artifacts as immutable versions when discovered; mark files
already missing as unavailable. Never claim that every intermediate version of
an externally edited file was captured.

## 4. Architecture and boundaries

Use a fixed, application-version-independent root: `~/.crew/vault/v1/`.
Resolve the user's home directory with the platform API. A future explicit
location setting must carry a verified relocation protocol, not a silent path
fallback. Keep development and test vaults isolated from this root.

```text
Crew session lifecycle / provider adapters
                   |
             capture coordinator
                   |
        durable journal + immutable objects
                   |
      transactional catalog and source cursors
            /                    \
   paged history/recovery     continuation builder
            |                    |
      renderer views       native resume / new branch
```

| Component | Responsibility | Depends on |
| --- | --- | --- |
| Vault repository | Transactions, schema versions, identities, metadata revisions, durable cursors | SQLite and filesystem |
| Capture coordinator | Ordered ingest, source boundaries, write barriers, explicit failure state | Vault repository; provider adapters |
| Object store | Immutable history segments/artifacts, lossless compression, hashes, reads | Filesystem and compression codec |
| Provider adapter | Discover history, identify session, describe resume capabilities, import native records | Provider-owned formats, read-only by default |
| Archive maintenance | Seal/compress chunks, enforce hot-data targets, integrity checks | Object store; catalog |
| Recovery service | Reconcile incomplete writes, restore metadata, verify exports/imports | Vault repository; object store |
| Continuation builder | Bounded, source-linked working context; fidelity/coverage report | Captured source records; provider capability data |
| IPC/renderer | Paged access, lazy wake, health and recovery actions | Typed services; no direct vault file mutation |

Use a single writer with an OS-level vault lock. A second Crew process cannot
migrate or write the same vault. SQLite should use WAL and `synchronous=FULL`;
the implementation plan must select an Electron-compatible binding and verify
macOS and Windows packaging before production rollout. A worker owns storage
I/O so renderer/main event handling is not blocked by compression or fsync.

### Identity and schema

- A logical session has one immutable, full UUID. It survives restore, rename,
  Close/archive, and provider-context replacement.
- A run is one execution attempt under that session.
- A conversation branch maps the logical session to a provider's complete
  conversation ID and its parent branch. Preserve every branch, not just one
  `priorSessionId`.
- `(presetId, cwd)` may remain an identity-styling preference key, never the
  uniqueness key of a conversation.
- Records carry schema version, source kind, full source ID, source generation,
  byte/event range, ingest sequence, timestamps, length, and integrity hash.
- Store metadata changes as revisions/tombstones. A partial roster or filtered
  view cannot be interpreted as deletion.
- Distinguish observed time, source-provided time, and ordering; do not infer
  recency from a provider timestamp that does not update on new turns.

The catalog indexes sessions, runs, branches, source cursors, segments, objects,
metadata revisions, compaction packages, coverage gaps, and recovery operations.
Each sealed segment has a versioned manifest sufficient to rebuild its catalog
entries without the provider folder. A SQLite backup plus the referenced
immutable objects forms a portable snapshot.
Metadata revisions and lineage changes also belong in the durable journal, not
only in the catalog, so rebuilding a damaged index does not erase the roster.

## 5. Durable write protocol

### Capture and commit

1. Assign a stable ingest identity and monotonic per-source sequence.
2. Append records to a framed journal with lengths and checksums.
3. Flush and sync the journal before advancing the catalog's committed cursor.
4. Commit metadata/cursor changes transactionally.
5. Acknowledge the durable high-water mark to the UI.

Duplicate imports must be idempotent. A provider log rewrite/truncation creates
a new source generation; it never overwrites previously captured history.
Keep incomplete live JSONL records as pending source bytes until a complete
record is available; unknown/malformed records remain retrievable with an
interpretation error, not silently dropped.
Pending source bytes can be journaled losslessly before interpretation; their
parse cursor and durable-byte cursor are separate. Reconcile them idempotently
when the remainder arrives.

The normal terminal-render path receives output after the durable commit
barrier, with a proposed batching window of at most 50 ms under healthy storage.
Treat this as a latency target, not proof of fsync latency. If a user explicitly
chooses to continue after capture fails, show **Not preserved** persistently;
never silently revert to a best-effort recorder.
Capture before renderer coalescing, pending-output truncation, ANSI stripping,
or image-display budgets. Those presentation optimizations must not change the
originals. Keep failed writes pending for explicit retry/recovery; do not clear
their buffers and report a successful flush.

Bound ingress memory. When persistence cannot keep up, stop accepting new
session launches and apply supported stream backpressure. Do not claim that
backpressure freezes every external process. Report the last durable position
and any undurable/in-flight range.

### Seal and compress

Seal at complete record boundaries, targeting 4 MiB of uncompressed history per
segment; a larger individual record remains whole. Use a versioned standard
lossless codec (gzip initially, using Node's built-in support).

Write a new temporary object, flush/sync it, decompress it and verify length
and SHA-256 against the original, publish by atomic rename on the same volume,
then commit its manifest/reference. Sync the directory where the platform
supports it. Only after verified publication and catalog commit may redundant
uncompressed storage be reclaimed. Never remove the only verified copy.

Recovery reconciles all crash boundaries: temporary objects, published objects
without catalog rows, catalog rows with missing objects, and torn journal tails.
Do not delete unexplained orphan objects automatically; quarantine and report.
Retain valid committed prefixes and expose damaged ranges explicitly.

### Failures and shutdown

Disk-full, permissions, corruption, unsupported schema, and failed sync are
visible protection failures. Do not open an empty writable vault as a fallback.
Read-only recovery is acceptable if it is clearly labeled.

On normal quit, stop new inputs/launches, establish capture barriers for active
runs, drain observed output and adapter imports, then shut down processes with
the existing user-confirmation policy. Capture final exit output before closing
the writer. Do not dispose the recorder before its producers. A timeout is an
incomplete checkpoint, not a successful preservation acknowledgment.

On startup, reconcile interrupted transactions before restoring the roster.
Restore metadata first, histories on demand, and processes only on explicit wake.

## 6. Retention limits: hot data is bounded; originals are not deleted

Proposed defaults:

| Limit | Default | Behavior |
| --- | --- | --- |
| Per-session hot history target | 256 MiB | Seal/compress older complete segments first. |
| Global hot-history target | 2 GiB | Evict least-recently-read eligible uncompressed segments after verification. |
| Segment target | 4 MiB uncompressed | Complete records only; exceptional oversized records are permitted. |
| Archive retention | No automatic age/count/size deletion | Preserve compressed originals and manifests. |
| Low-space warning | Available space below the larger of 5 GiB or 5% of volume capacity | Show storage health and offer verified export/relocation. |

Hot targets are not maximum archive sizes and do not delete sessions. Keep the
current append journal and active read leases safe even if a target is temporarily
exceeded. Artifact versions remain in the object store and are accounted for
separately; do not decompress a large artifact merely to count it as "hot."

Before compression, reserve sufficient temporary workspace. If that cannot be
obtained, retain the original and report the blocked maintenance operation.
Actual write failure triggers the failure contract in section 5.

Close becomes **Archive session**, not history deletion. Explicit permanent
deletion is a separate confirmed operation identifying all branches/artifacts
and any shared-object reference effects. Do not add automatic permanent deletion
in this release. Existing historical losses cannot be retroactively repaired.
Keep process shutdown and workspace removal distinct: the new archive action
stops a running session only after the existing confirmation and capture barrier.
Rename the old workspace-only archive action to **Remove from workspaces**.

## 7. Provider adapters and restart semantics

| Session type | Preserve | Resume behavior |
| --- | --- | --- |
| Copilot | Available native events, database-derived turns/checkpoints/references, session-owned artifacts, terminal output | Native resume when supported data is available; otherwise an explicitly labeled continuation |
| Claude Code | Available native conversation records and associated session-owned artifacts, terminal output | Native resume with validated provider ID/format; otherwise continuation |
| Shell | Crew-observed terminal output, launch directory/command, observed shell-integration records | Restore historical view; explicitly start a new shell |
| Custom command | Terminal output, launch descriptor, optional registered provider adapter data | No generic resume promise; explicit new execution unless adapter proves support |

Read live provider databases with a consistent read transaction or supported
backup API. Never copy only the main SQLite file while ignoring its WAL.
Snapshot a bounded source high-water mark and continue tailing afterwards.

An adapter publishes a capability/result object, including resume availability,
source completeness, provider version, context-budget knowledge, and reasons
for degradation. Missing support is not the same as a corrupt session.

Do not mutate provider stores during routine ingest. If native data is missing,
first offer the archived transcript and continuation. A future native-data
rehydration path must validate format/version, stop if the provider is actively
using that destination, and never overwrite newer provider history.

## 8. Low-loss working-context compaction

### Separate two limits

Storage limits control local representation. Provider context limits control
what an agent can use in the next request. They must never share a byte-based
threshold.

Prefer a provider's supported native resume/compaction mechanism. For a
Crew-built continuation, use a reliable provider-reported context budget and
token accounting where available. A proposed trigger is 80% of usable input
budget, after reserving provider overhead and output capacity. Do not hard-code
model limits from memory.

Where the provider exposes neither reliable limits nor context usage, label the
budget **Unknown** and offer an explicit continuation action or react to an
identified context-capacity failure. Do not pretend that a file-size threshold
proves exhaustion, or automatically force a fresh conversation based on it.

### Continuation package

Every package names its logical session, branch lineage, source high-water
marks, source manifest hashes, builder version, and build time. It contains:

- Exact active user instructions and constraints with source references.
- Current goal, confirmed decisions, unresolved questions, and pending work.
- Relevant files/commits with timestamps; distinguish historical state from
  current repository state.
- Recent complete conversation turns, keeping tool calls/results paired.
- Failures and successful validation evidence, without converting "not run" into
  success.
- Attachment/artifact inventory, availability, and vault retrieval references.
- A compact timeline and retrieval index for older history.
- A coverage report: verbatim ranges, summarized ranges, omitted from working
  context but archived ranges, unknown/unavailable records, and budget usage.

Long mandatory content is not silently clipped. If exact active constraints,
an unresolved tool exchange, or a required artifact cannot fit, stop and ask for
scope selection or a larger supported budget.

Each summary claim carries its source range. Rebuild from original records or
independently verified extraction records, never recursively from a previous
summary alone. Mark contradictory or superseded instructions rather than
silently selecting one with a heuristic.
When the adapter cannot reliably classify which instructions remain active,
retain the relevant source messages or require user review. Do not advertise
exhaustive constraint extraction from arbitrary prose as a deterministic fact.

Start with deterministic extraction of structured records and exact references.
Optional model-generated semantic summaries require explicit user enablement,
use the user's configured supported provider path, and are derived/untrusted
content. Do not add an API-key requirement or change provider/model merely to
build summaries. Preserve source links and report uncertainty.

The primer must describe the package as historical evidence, not authoritative
instructions. Tool output, file content, and quoted past messages do not gain
instructional authority because they appear in a brief.

### Retrieval and lineage

Provide bounded local retrieval by full session/branch ID and record range.
Read decompressed ranges without launching a PTY or loading the full archive
into renderer memory. The continuation agent must have an explicit supported
way to read cited ranges; a bare inaccessible ID is not sufficient.

Creating a continuation appends a branch. Keep the previous branch, its native
ID, and all originals intact. Show the selected restore mode before wake and
allow the user to choose native resume when available. A missing or stale
package is a visible condition; build a new package or wait rather than silently
using an unrelated brief.

## 9. Migration, install, and recovery

### Migration

1. Acquire the writer lock and verify available space.
2. Create a timestamped, checksummed backup of existing Crew metadata. Inventory
   existing transcripts, handoffs, and discoverable provider sources read-only.
3. Import into a new vault without altering originals. Preserve existing Crew
   UUIDs and full current/prior provider IDs. Record ambiguous identities rather
   than merging by directory, label, or an eight-character prefix.
4. Verify session/branch counts, required metadata fields, object hashes, and
   source-range coverage. A partial import remains visibly partial and retryable.
5. Publish the migration completion marker transactionally only after verification.
6. Leave legacy data in place. Repeated migration is idempotent.

Import current/prior branches for saved Crew sessions first. Expose discovery of
other provider sessions as an explicit import, not an automatic flood of the
roster. Recoverable legacy snapshots are selectable evidence; do not blindly
replace newer live metadata with an older backup.

Old versions that cannot understand the vault must not write it. Downgrading
the application retains the vault; old code may show legacy metadata, but that
is not a rollback of vault state. No dual-write design may let an old partial
roster prune the vault.

### Installs and updates

Keep the fixed vault root outside the app bundle, repository, and Chromium
caches. Install/reinstall/uninstall scripts must not delete it.

Before replacement, require confirmed application exit rather than a fixed
sleep. Stage and validate the new bundle before switching it into place.
Retain the previous bundle until the new one can launch. If shutdown or staging
fails, abort replacement without clearing a live instance's locks.

Bundle rollback and vault-schema rollback are different operations. Make
migrations forward-compatible where practical; otherwise fail read-only with a
clear version requirement, never silently downgrade a vault schema.

### Backup and recovery center

Offer verified portable export/import of catalog snapshots, manifests, and
referenced objects. An export is complete only after every object is present
and checked. Export from a consistent catalog snapshot and preserve object
leases until the operation ends.
Treat imported paths and manifests as untrusted: reject traversal, external
symlinks, inconsistent lengths, and invalid hashes. Bound decompression memory
and check available disk space before materializing objects. Import into staging
and reconcile by full identity; never overwrite a live vault from archive paths.

Track the last successful integrity check, last verified export, source coverage,
and recovery errors. Rebuild indexes from manifests where possible. Recovery
must never start arbitrary restored commands or overwrite live provider files.

A backup on the same disk helps logical recovery, not disk-failure recovery.
Copying files to another folder is not advertised as independent redundancy.

## 10. User-visible behavior

Follow Crew's Obsidian tokens and existing interaction patterns. No new visual
theme is required.

- Show **Preserved**, **Saving**, **Archive maintenance**, **Degraded**, or
  **Not preserved**, backed by real durable cursors and coverage data.
- Show restore mode: **Native resume**, **Continuation**, or **History only**.
- Separate archived sessions from live/asleep sessions without hiding history
  behind an active workspace filter. Provide an explicit all-session view.
- Offer full-history search, source-range inspection, storage usage, integrity
  status, backup/export, and actionable recovery errors.
- Show capture gaps and missing artifacts rather than empty success-shaped views.
- Keep startup lazy. Viewing history is read-only and does not incur inference
  or execute a command.
- Treat archive maintenance as background work; never label lossy working-context
  summarization "lossless compression."

## 11. Acceptance criteria

Use isolated fixture vaults/provider homes. No test may reboot the user's machine,
kill their Crew instance, reinstall their app, or mutate real session data.

| Area | Required proof |
| --- | --- |
| Exact archive recovery | Generated binary, Unicode, ANSI, long-record, and artifact fixtures round-trip byte-for-byte by hash. |
| Crash consistency | Kill an isolated writer at every journal/object/catalog publication boundary; recover every acknowledged item exactly once. |
| Honest capture status | Uncommitted/pending source data is never labeled preserved; ENOSPC/EACCES/fsync failures remain visible and block false success. |
| Capture before display limits | Output bursts beyond the 512 KiB renderer cap, ANSI records, and over-budget display images remain exact in the archive. |
| Import consistency | Concurrent append, partial JSONL record, source rotation/truncation, database WAL activity, and retry cannot silently drop/duplicate records. |
| Identity | Same cwd/preset, same eight-character ID prefix, multiple branches, rename, archive, and repeated asleep restore preserve distinct identities. |
| Retention | Exercise exact limits and one-byte-over boundaries; only representation changes, with identical original hashes and record counts. |
| Corruption | Corrupt journal tails, catalog, compressed chunks, and manifests; quarantine damage, recover valid data, and report missing ranges. |
| Migration | Empty/partial/corrupt legacy stores, backups, duplicate imports, interruption, retry, and downgrade preserve originals and correct lineage. |
| Lifecycle | In isolated integration environments, clean quit, forced crash, simulated restart, app replacement failure, and supported upgrade preserve acknowledged state. |
| Native resume | Provider-version fixtures plus explicit adapter integration tests prove claimed capabilities; unsupported versions report degradation. |
| Compaction fidelity | Gold fixtures require all designated active constraints, pending tasks, decision provenance, tool pairing, and artifact references to survive. |
| No recursive loss | Rebuild multiple continuation generations and verify all citations still resolve to immutable original records. |
| Insufficient context | Mandatory-content-over-budget and unknown provider budgets do not silently truncate or force a false native resume. |
| No execution on restore | Restoring, searching, exporting, and reading archived sessions spawn no PTYs and submit no inference requests. |
| Performance | Large synthetic corpus stays paged; startup does not scan/decompress all objects; renderer requests have bounded page sizes. |
| Packaging | Storage binding, lock behavior, atomic publication, and compression work in packaged builds on supported macOS/Windows targets. |

"Low loss" is not a fabricated universal percentage. Report fixture results and
coverage omissions. Hard invariants (exact originals, critical constraints, valid
citations) require 100% pass; semantic recall across arbitrary future tasks cannot
be guaranteed from a bounded summary alone.

## 12. Delivery boundaries

Implement in dependency order after this specification is approved:

1. Vault primitives, crash recovery, identity, and isolated fault-injection tests.
2. Read-only legacy/provider import, continuous capture, and honest health state.
3. Lazy restore, archive/history UX, migration and install/reinstall safeguards.
4. Verified compression/export and source-linked continuation packages.

These are increments of one preservation architecture, not permission to ship
an "everything preserved" claim after metadata-only work. Optional model-assisted
summaries and a persistent PTY daemon are not prerequisites. The daemon can be a
later design for surviving an app-only restart; it does not solve OS reboot.

Before enabling capture/migration on an existing install, create a verified
backup and make the expanded persistence/privacy behavior clear to the user.
Do not delete existing records or regenerate their only briefs during rollout.

## 13. Specification self-review

- Exact retention and bounded working context are separate throughout.
- Preserved means durably acknowledged data, not merely visible/live data.
- Provider-owned process state and missing historical content are not promised.
- Thresholds are specified as proposed defaults, not falsely attributed approval.
- No implementation or live migration has occurred as part of this design.
- Remaining gate: user review of this written specification.

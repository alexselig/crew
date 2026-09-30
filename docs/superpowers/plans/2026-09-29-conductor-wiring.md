# Conductor Phase 1.5 — Wiring

Phase 1 (PR #28) landed the whole Conductor machine **dark**: runtime,
journal, recovery classifier, lane manager, composer logic, IPC and renderer
components all exist and are tested, but `src/main/index.ts:824` passes
`createShippedConductorBackend(null)`, so the shipped conductor is
permanently `enabled: false`. Nothing constructs a `ConductorRuntime`,
nothing mounts the composer, and the plan's own manual verification
(publish/sync in a real repo) cannot be run.

This plan wires it up, and closes the deferred findings from the Phase 1
whole-branch review (findings 3, 4, 8, 10, 12 and the two logged caveats).

## The design decision this plan makes

**The app has no repository concept.** `Workspace` is
`{ id, name, description?, order, createdAt }` (`src/shared/types.ts:154`) —
no path. Session `cwd` is free text defaulting to `homedir()`. There is no
directory picker anywhere in `src/main` (`showOpenDialog` appears nowhere).

So `ConductorSettings.repo` / `integrationBranch` / `integrationWorktree` /
`lanesDir` have no existing source. This plan establishes one:

> **The composer draft is the source of truth.** `RosterDraft` already
> carries `repo` and `integrationBranch` (today validated, then ignored —
> review finding 4). Composing a conducted workspace captures those into a
> persisted `ConductorConfig` for that workspace. `integrationWorktree` and
> `lanesDir` are **derived**, never typed, so the user cannot point them at
> something destructive.

Derivation (fixed, not configurable in this phase):

```
integrationWorktree = <userData>/conductor/<workspaceId>/integration
lanesDir            = <userData>/conductor/<workspaceId>/lanes
journal path        = <userData>/conductor/<workspaceId>/journal.ndjson
```

Keeping all three under `userData` means Conductor never writes anything
into the user's repo except commits on the integration branch, and a
`git clean -fdx` in the user's repo cannot destroy Conductor state.

## Global constraints (bind every task)

- `npm run lint` **does not exist**. The gate is exactly
  `npx vitest run && npm run typecheck && npm run build`.
- **No DOM test infrastructure.** `vitest.config.ts` is
  `environment: 'node'`, `include: ['test/**/*.test.ts']`; no
  jsdom/testing-library. Never add a test stack, never add a dependency,
  never edit `vitest.config.ts`. Cover renderer decisions with pure
  exported functions and source-text assertions.
- `src/shared` and `src/renderer` must **never** import from `src/main`.
- Busy semantics are settled and asymmetric: `publishLane()`/`syncLane()`
  **return** `{ ok: false, reason: 'busy' }`; `conductor.reconcile()`
  **throws** `ConductorBusyError`. Task 3 converts that throw into a
  structured result **at the backend boundary only** — the runtime's
  contract does not change.
- Conductor is **fail-closed**. Nothing may advance state it cannot prove
  succeeded, and the journal must never record something that did not
  happen.
- Every new test must be load-bearing: revert the change, show it fails,
  restore, show it passes.
- `test/supervise.test.ts` and `test/release-scripts.test.ts` flake under
  parallel load — re-run a failing file alone before calling it a
  regression.
- Commits: `git commit -F -` with a `<<'MSG'` heredoc, never `-m`, and
  every commit carries the `Co-authored-by: Copilot` and
  `Copilot-Session:` trailers.

## Existing interfaces (verified, quote these)

```ts
createLaneManager(settings: ConductorSettings): LaneManager        // src/main/lanes.ts:36
createJournal(path: string): Journal                               // src/main/conductor-journal.ts:113
createConductor(deps: ConductorDeps): Conductor                    // src/main/conductor.ts:83
  // ConductorDeps: { lanes, journal, settings, runTests?, now?, newOpId? }

// LaneManager (src/main/lanes.ts:11-27)
ensureIntegrationWorktree(): Promise<void>
create(name: string, agent: LaneAgent): Promise<ConductorLane>
facts(lane): Promise<LaneFacts>
destroy(lane, opts: { force: boolean }): Promise<void>

// SessionManager (src/main/session-manager.ts:212, :760) — SYNCHRONOUS
create(req: CreateSessionRequest, restore?): SessionInfo
close(id: string): void

// ComposeDeps (src/main/conductor-compose.ts:15-27) — async, narrower
createSession(request: { cwd: string; presetId: string; model: string | null; label: string }): Promise<{ id: string }>
closeSession(id: string): void

// Store persistence analogue to imitate (src/main/store.ts:908-915)
getWorkspaces(): Workspace[]
saveWorkspaces(list: Workspace[]): Workspace[]

// Pure, already built, currently unimported by src/ (src/shared/conductor-membership.ts:112, :151)
canConduct(workspaces, sessions, wsId): MembershipVerdict
validateMembershipChange(workspaces, sessions, change): MembershipVerdict
```

---

## Task 1 — Persist conductor config and lanes in `Store`

**Files:** `src/main/store.ts`, `src/shared/conductor.ts` (type only),
`test/store.test.ts` (or a new `test/store-conductor.test.ts`).

Add a persisted, per-workspace conductor record and a persisted lane roster.
Today `lanesById` is an in-memory `Map` in `conductor-ipc.ts:134`, so a
restart **orphans every lane worktree and every lane session** — the single
worst consequence of shipping the wiring without this.

Add to `src/shared/conductor.ts`:

```ts
export interface ConductorConfig {
  workspaceId: string
  repo: string
  integrationBranch: string
  integrationWorktree: string
  lanesDir: string
  maxLanes: number
  test: TestRecipe | null
}
```

Add to `Store`, modelled **exactly** on the `workspaces` collection
(`store.ts:103`, `:118`, `:347`, `:350`, `:549`, `:908-915`) — same
validator style, same persist path through `atomicWriteFile`, same `.bak`
rotation:

```ts
getConductorConfigs(): ConductorConfig[]
saveConductorConfigs(list: ConductorConfig[]): ConductorConfig[]
getConductorLanes(): ConductorLane[]
saveConductorLanes(list: ConductorLane[]): ConductorLane[]
```

Requirements:
- Per-field validation on load, matching the strictness of the neighbouring
  validators: a malformed record is **dropped**, never coerced. A lane whose
  `id`, `worktree` or `branch` is empty is malformed.
- The journal deliberately does **not** live in `Store`
  (`conductor-journal.ts:1-4` explains why: `Store` quarantines the whole
  file on corruption and the journal must not risk the session roster). Do
  not move it.

**Tests:** round-trip both collections; a malformed record is dropped, not
coerced; persistence survives a reload of the store from the same file.

---

## Task 2 — The runtime factory

**New file:** `src/main/conductor-runtime.ts`. **Tests:**
`test/conductor-runtime-factory.test.ts`.

```ts
export function conductorPaths(userDataDir: string, workspaceId: string): {
  integrationWorktree: string
  lanesDir: string
  journal: string
}

export function createConductorRuntime(deps: {
  config: ConductorConfig
  journalPath: string
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
}): ConductorRuntime
```

`conductorPaths` is pure and must be tested directly: it encodes the
derivation above, and it is the guarantee that Conductor never writes
scratch state into the user's repo. Assert that both derived paths are
**inside** `userDataDir` and **outside** `config.repo`, including when
`workspaceId` contains path-traversal characters (`../`) — reject or
sanitise, do not interpolate blindly.

`createConductorRuntime` assembles `createLaneManager(settings)`,
`createJournal(journalPath)` and `createConductor({ lanes, journal, settings })`
and returns the `ConductorRuntime` shape `conductor-ipc.ts:113-119` already
declares.

---

## Task 3 — Bridge `SessionManager` to `ComposeDeps`

**New file:** `src/main/conductor-sessions.ts`. **Tests:**
`test/conductor-sessions.test.ts`.

```ts
export function createLaneSessionBridge(deps: {
  manager: Pick<SessionManager, 'create' | 'close'>
  resolvePreset: (presetId: string) => { command: string; args: string[] } | null
}): { createSession: ComposeDeps['createSession']; closeSession: ComposeDeps['closeSession'] }
```

The two shapes are genuinely far apart, and each gap is a decision:
- `SessionManager.create` is **synchronous**; `ComposeDeps.createSession` is
  async. Wrap, do not change either contract.
- `ComposeDeps` requires a non-null `presetId`; `CreateSessionRequest` allows
  null. Keep the strict side strict.
- `ComposeDeps` has no `command`/`args`; they come from the preset. **An
  unknown `presetId` must reject** — never fall back to a default shell, which
  would silently spawn the wrong agent in a lane worktree.
- `ComposeDeps` carries `model`, which `CreateSessionRequest` has no field
  for. Thread it the same way the existing New Session flow threads a model
  selection; if there is no such mechanism, pass it through `extraArgs` on
  the `restore` argument and **document the choice in a comment**. Do not
  silently drop it — a lane running the wrong model is a wrong-answer bug.

**Tests:** preset resolution failure rejects and creates nothing; a created
session receives the preset's command/args and the lane worktree as `cwd`;
`closeSession` delegates; the model reaches the spawned session.

---

## Task 4 — Compose builds settings from the draft (review finding 4)

**Files:** `src/main/conductor-compose.ts`, `src/main/conductor-ipc.ts`,
`test/conductor-compose.test.ts`.

Today `composeRun` validates `draft.repo` and `draft.integrationBranch`, then
ignores them and creates lanes in `runtime.settings` — which could be an
entirely different repository. That is a silent wrong-target bug.

Make the draft authoritative: compose derives the `ConductorConfig` (and
therefore the `ConductorSettings`) from the draft, or **rejects** a draft
that does not match the runtime it was handed. Rejecting is acceptable and
simpler; silently ignoring is not.

Also restore the test-recipe fields the composer dropped in Phase 1 (plan
line 3735), now that a runtime exists to carry them: the recipe is part of
`ConductorConfig`, so the composer can finally plumb it.

**Tests:** a draft whose `repo` differs from the runtime's is rejected with a
clear reason and creates nothing; a test recipe entered in the composer
reaches the persisted config.

---

## Task 5 — Backend: real lock holder, persistence, and the deferred findings

**Files:** `src/main/conductor-ipc.ts`, `src/main/conductor.ts`,
`test/conductor-ipc.test.ts`.

Close review findings 3, 8, 10 and the two logged caveats:

1. **`publishingLaneId` is a lie** (`conductor-ipc.ts:163`, `:173`). It is
   assigned by the backend before `conductor.publishLane` runs, clobbered by
   a second busy call whose `finally` then nulls it while the first publish
   is still running, is also set by *sync*, and is only ever broadcast after
   a publish finishes — so the panel never sees `publishing: true`.
   **Fix:** expose `lockHolder(): string | null` on `Conductor` (it already
   tracks `publishing` internally, `conductor.ts:92`), have the backend read
   that instead of maintaining its own, and broadcast when the lock is
   **taken**, not only when it is released.
2. **`destroyLane` skips every safeguard** (`conductor-ipc.ts:148`). It does
   not take the single-flight lock and does not close the lane's session
   first — precisely the orphan that compose's rollback goes to such lengths
   to prevent. **Fix:** take the lock, close the session, then destroy; and
   when `lanes.destroy` leaves the lane in the map, keep state coherent.
3. **`createLane` skips `validateRoster` and `maxLanes`**
   (`conductor-ipc.ts:154`). **Fix:** enforce both.
4. **`CONDUCTOR_RECONCILE` busy handling.** `conductor.reconcile()` throws
   `ConductorBusyError`; catch it **in the backend** and return a structured
   `{ needsAttention: false, operations: [], busy: true }`-style result so
   the renderer never string-matches a message. The runtime's throwing
   contract is unchanged.
5. **Gate on attention** (logged caveat b): while `lastReconcile.needsAttention`
   is true, refuse `publishLane`/`syncLane` with a clear reason. An
   unacknowledged interrupted operation must not be papered over by a new
   publish.
6. **Newest-operation selection** (logged caveat a) is already fixed to use
   journal order; verify it still holds after these changes.
7. **Hydrate and persist `lanesById`** from Task 1's store on every mutation
   (create, compose, destroy).

**Tests:** each of the seven, individually load-bearing.

---

## Task 6 — Wire `src/main/index.ts` and reconcile on launch

**Files:** `src/main/index.ts`, `test/` as reachable.

Replace `createShippedConductorBackend(null)` (`index.ts:824`) with a real
backend built from the persisted config (Task 1), the runtime factory
(Task 2) and the session bridge (Task 3), following the local
`register*Ipc(ipcMain, deps, broadcast)` convention at `index.ts:817-824`.

- If no workspace has a `ConductorConfig`, the backend is still the
  **disabled** one — `enabled: false` must remain a supported, non-error
  state (`available()`-style capability gating, not an exception).
- **Run `reconcile()` once at launch**, after the window exists so the
  result can be broadcast. This is the plan's own global rule: a run never
  auto-resumes, and an interrupted operation must be surfaced to the human
  before anything else touches the integration branch.
- Guard the launch reconcile so a throw (including `ConductorBusyError` or a
  `MalformedJournalError`) can never prevent the app from starting.

---

## Task 7 — Mount the composer and enforce exclusivity

**Files:** `src/renderer/App.tsx`, `src/renderer/components/*`,
`src/main/store.ts` (membership enforcement), tests.

- Mount `ConductorComposer` / `ConductorPlanDialog` (today nothing renders
  either — review finding 12), wiring `onCompose` to
  `window.crew.composeConductedWorkspace`. Follow the conditional-mount
  pattern `AgentRunPanel` uses in `App.tsx`.
- `ConductorPanel`'s publish/sync calls have no `.catch`, so a rejection is
  an unhandled rejection and the user sees nothing. Surface the failure.
- Import `src/shared/conductor-membership.ts` (built in Phase 1 Task 7,
  currently imported by nothing but its test) and enforce
  `validateMembershipChange` on the store's session-membership save path, so
  a session cannot join two conducted workspaces.
- Remove the genuinely dead `PlanDocument.canCreate` / `blockingCount` if
  they are still unused after this task (review finding 12).
- Fix the `journal-failed` message that claims "nothing was run" — false on
  the tests-failed path.
- Renderer coverage stays pure-function + source-text assertions. No DOM
  test stack.

---

## Manual verification (now finally possible)

1. Compose a conducted workspace against a scratch git repo with two lanes.
2. Confirm lane worktrees appear under `<userData>/conductor/<id>/lanes`
   and **nothing** new appears inside the user's repo.
3. Make a commit in lane A; publish it; confirm `crew/integration` advances
   and the journal records `intent → merged → tests → published`.
4. Sync lane B; confirm it picks up A's commit.
5. Kill the app mid-publish (during tests); relaunch; confirm the launch
   reconcile reports the interrupted operation and publish/sync are refused
   until it is resolved.
6. Restart normally; confirm lanes survive the restart with their sessions.

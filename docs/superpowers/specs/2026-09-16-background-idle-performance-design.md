# Background Idle Performance Design

## Goal

Make Crew inexpensive when it is open but no Crew window is focused, without
stopping sessions, delaying needs-you detection, or losing terminal output.

## Evidence and Scope

A live process snapshot of the installed signed app showed:

- Crew GPU helper at approximately 59% CPU.
- Two Crew renderer helpers at approximately 34% and 17% CPU.
- Crew's main process at approximately 3% CPU.

The main process was not the dominant cost. Code inspection found continuous
renderer work from live xterm emulators, per-card terminal previews, transcript
polling, one-second elapsed-time intervals, and CSS/xterm animation. Output is
broadcast to every Crew window, multiplying renderer work.

This first performance push targets the state where no Crew window is focused.
It does not redesign multi-window output ownership, Project Tracker scanning,
asset watchers, or main-process session detection.

## Activity State

The main process owns one authoritative boolean: whether any Crew
`BrowserWindow` is focused.

- Recompute the value on window focus, blur, close, show, hide, minimize, and
  restore.
- Send the current value to a newly ready renderer.
- Broadcast changes only when the value changes.
- Expose a typed preload subscription for renderers.
- If the renderer has not received a value, default to active. A missed event
  may consume more power but must never hide output or freeze the UI.

The state is global. If any Crew window is focused, renderers remain active in
this first version. Per-window output ownership is a later optimization.

## Terminal Suspension

When global activity becomes inactive, every renderer suspends terminal
emulation:

1. Dispose each live xterm emulator, including an attached selected terminal.
2. Preserve its existing bounded raw-output tail and last-used metadata in the
   dormant terminal map.
3. While suspended, `writeTo()` appends output only to dormant tails and never
   creates an xterm instance.
4. Do not change PTYs, state detection, transcript capture, cost parsing, or
   needs-you transitions in the main process.

When activity becomes active:

1. The visible terminal component reacquires a pooled emulator.
2. The pool replays its bounded tail through the existing rebuild path.
3. The terminal refits and focuses only when normal UI behavior requests focus.
4. Other sessions remain dormant until they become visible.

Suspension must be idempotent. Repeated inactive events do not duplicate tails
or dispose the same emulator twice. A late output event after session deletion
continues to respect terminal tombstones.

## Renderer Wakeup Budget

Background inactivity pauses UI-only recurring work:

- `TerminalPreview` stops its 1.5-second polling interval. On resume, it refreshes
  once immediately before restarting the interval.
- `TranscriptPane` stops its 500 ms polling interval. On resume, it performs one
  immediate guarded refresh before restarting.
- `Since` instances use one shared one-second clock rather than one interval per
  component. The shared clock stops when Crew is inactive and emits one fresh
  timestamp on resume.
- Decorative CSS animations and transitions are paused under an app-level
  inactive class. Semantic status remains visible and unchanged.

All timers must be created only while active and cleared on inactivity or
unmount. Resume must not create duplicate intervals or overlapping transcript
requests.

## Data Flow

1. Electron window lifecycle changes.
2. Main recomputes `anyWindowFocused`.
3. Main sends a typed activity event only if the value changed.
4. Renderer activity state updates.
5. Terminal pool suspends or enables emulator creation.
6. Preview, transcript, shared clock, and animation consumers stop or resume.
7. Main continues PTY processing and state notifications throughout.

The renderer activity state should have one hook/provider boundary so components
do not add their own focus listeners.

## Correctness and Failure Handling

- Activity IPC failure defaults to active behavior.
- Suspending terminal rendering must not pause PTYs or discard the bounded replay
  tail.
- Needs-you state transitions and native notification policy remain main-process
  concerns and continue while Crew is inactive.
- Resume failures must surface through existing renderer error handling; they
  must not silently show an empty terminal as if no output occurred.
- No background optimization may change session lifecycle, roster order,
  workspace membership, Custom Views, transcript persistence, or cost tracking.

## Testing

### Main activity coordination

- No windows focused produces `false`.
- Focusing any Crew window produces `true`.
- Repeated same-state lifecycle events do not rebroadcast.
- A newly ready renderer receives current state.

### Terminal pool

- Suspending moves all live terminals to dormant bounded tails.
- Output received while suspended does not create a terminal.
- Resuming and reopening creates one terminal and replays recent output.
- Repeated suspend/resume does not duplicate output or exceed the live-terminal
  cap.
- Session deletion while suspended preserves tombstone behavior.

### Renderer timers

With fake timers:

- Preview polling produces no callbacks while inactive and refreshes immediately
  on resume.
- Transcript polling produces no IPC calls while inactive, performs one guarded
  resume fetch, and never overlaps requests.
- Multiple `Since` components share one timer.
- The shared clock has no active interval while Crew is inactive.

### Regression verification

- Run all unit tests.
- Run both TypeScript checks.
- Run the production build.
- Run `git diff --check`.
- Do not launch unsigned Crew, Electron, Playwright, or GUI E2E on this host.

## Performance Acceptance

Measure the already-installed signed app with the same session/window workload
before and after:

- Within five seconds of the last Crew window losing focus, combined Crew
  main/renderer/GPU CPU falls by at least 80% from its foreground baseline.
- With sessions idle, combined Crew CPU has a 30-second median below 5%.
- Needs-you detection and native notifications still work while Crew is
  backgrounded.
- Returning to Crew restores the selected terminal with recent output and no
  blank or frozen view.

Use read-only `ps`, `top`, and `sample` measurements against existing signed-app
processes. Do not launch an unsigned build to gather the acceptance evidence.

## Out of Scope

- Sending full PTY output to only one renderer.
- Throttling or pausing main-process state detection.
- Project Tracker scan changes.
- Asset watcher changes.
- App preview/webview suspension.
- Version bumping, publishing, or releasing.

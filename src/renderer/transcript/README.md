# Transcript — typed session scrollback

Drop-in module rendering an agent session as typed blocks on a hairline rail,
in the Obsidian design system. Built against the tokens in `styles.css` and the
`CharacterDef` / status grammar already in the app.

## Install

Copy this folder to `src/renderer/transcript/`. No new dependencies; the CSS is
imported by `Transcript.tsx` (Vite handles it), and it reuses the bundled
Newsreader + JetBrains Mono fonts from `fonts/fonts.css`.

One token addition (optional): the diff/plan greens reference `var(--ok)` with a
`#5fb85f` fallback baked in. Add `--ok: #5fb85f;` to `:root` in `styles.css` if
you want it themeable.

## Use

```tsx
import { Transcript } from './transcript'
import type { TranscriptBlock } from './transcript'

<Transcript
  blocks={blocks}
  character={character}          // the session's CharacterDef — attributes agent prose
  agentLabel="claude code"
  handlers={{
    onDecide: (blockId, optionId) => writeToSession(sessionId, optionId),
    onPermission: (blockId, res) => resolveApproval(sessionId, res),
    onAction: (blockId, actionId) => runFix(actionId),
    onOpenImage: (blockId) => openViewer(blockId)
  }}
/>
```

To see every block type immediately, render `DEMO_BLOCKS` from `fixtures.ts`.

## Behavior baked in

- **Line-art faces** — agent blocks render the session character's illustrated
  face from `character-art.tsx`, tinted with its identity color; emoji glyph is
  the fallback for characters without art (`CharacterTick` is exported if you
  want the same treatment elsewhere).
- **Attention grammar** — unresolved decisions and permission asks use the
  inverted-ivory chip, matching `StatusTag`'s WAITING treatment; resolved ones
  go quiet with the chosen option held in cobalt.
- **Keyboard** — digits 1–9 answer the oldest unresolved decision (ignored while
  an input/textarea/terminal has focus).
- **Pin to bottom** — the view follows the stream unless the human scrolls up
  more than ~40px.
- **Tool runs** — output folds closed on success, auto-opens on nonzero exit;
  `exitCode: undefined` renders a RUNNING state.

## Feeding it from the PTY

The renderer never parses raw terminal output — build `TranscriptBlock[]` in
whatever watches the stream (alongside the working/waiting detection in main).
Practical mapping for Claude Code sessions: run with `--output-format
stream-json` and translate events — user turns → `user`, assistant text →
`agent`, thinking deltas → `thinking`, tool_use Bash → `tool` (fill `exitCode`
from the matching tool_result), tool_use Edit → `diff`, permission prompts →
`permission`, TodoWrite → `plan`. Update blocks in place by `id` as results
stream in; React reconciles by key.

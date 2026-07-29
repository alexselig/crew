# Enhanced Terminal — Visual Verification Checklist

A **visual, click-through checklist** for the new session terminal UI (the
"Beta: Enhanced Terminal Interface"). Companion to
`enhanced-terminal-test-map.md` (automated coverage) and
`2026-07-28-custom-terminal-design.md` (design). Every item below says exactly
**how to trigger it** and **what you should see**, with the real colors/keys
pulled from the code so you can eyeball each one.

> Source of truth: `src/renderer/terminal/{pool.ts,xterm-engine.ts}` and
> `src/renderer/components/CrewTerminal.tsx`.

---

## Setup (do this first)

1. Launch **Crew-EnhancedTerminal-beta.app** (notarized — no Gatekeeper warning).
2. **Settings** (gear icon) → toggle **“Beta: Enhanced Terminal Interface”** ON.
   - Setting description reads: *“Use Crew’s own terminal engine for every
     session — command blocks, jump-to-prompt (⌘↑/⌘↓), exit-code marks and GPU
     rendering. Experimental; toggling reloads open terminals.”*
   - Open terminals **re-render** when you toggle (they remount under the new engine).
3. Create a **New Session → Shell** preset (exit-code ticks need the Shell preset,
   whose `crew-hook` OSC 133 integration auto-installs).
4. Run a few commands, e.g.: `echo a`, `false`, `echo b`, `ls`.

Legend: ⬜ = to verify · ✅ = looks right · ❌ = looks wrong (note what you saw).

---

## A. Headline visuals (the three from the beta note)

### A1. ⬜ Yellow highlight on each input row
Press **Enter** on any command. The row you just submitted is highlighted as a
scannable landmark (it’s an overlay — no bytes are written to the shell):

| Element | What you see | Exact value |
|---|---|---|
| Row background | full-width **light-yellow** band | `#FFF9C4` |
| Row text | **black** text on that row | `#000000` |
| Left edge | solid **amber** accent bar (~3px) | `#E8A317` |
| Scrollbar | **yellow/gold** tick at that row | `#FFCC00` |

Every submitted input row gets its own band + tick, so your prompts stand out
from agent/shell output. *(pool.ts → `markPrompt`)*

### A2. ⬜ Jump-to-prompt with ⌘↑ / ⌘↓
Scroll up in the scrollback, then:
- **⌘↑** (Ctrl↑ on Win/Linux) → viewport jumps to the **previous** prompt landmark.
- **⌘↓** (Ctrl↓) → jumps to the **next** one.
- The arrow key is **consumed** — it must **not** be typed into the shell, and
  no character appears at the prompt.
- Requires no Shift/Alt held. Landmarks = OSC 133 prompt starts **+** your Enter
  submits. *(CrewTerminal.tsx key handler → pool.ts `jumpToPrompt`)*

### A3. ⬜ Green / red exit-code ticks in the scrollbar
After each command **completes**, a tick appears in the right-hand overview ruler:

| Command result | Tick color | Exact value |
|---|---|---|
| Exit **0** (`echo a`) | **green** | `#43b581` |
| **Non-zero** (`false` → exit 1) | **red** | `#e5484d` |

Run `echo a; false; echo b` and confirm you get **green, red, green**. Needs the
Shell preset’s OSC 133 `;D` marks. *(pool.ts → `onBoundary` / `OK_RULER` / `ERR_RULER`)*

---

## B. Rendering upgrades

### B4. ⬜ GPU (WebGL) rendering stays smooth
Run high-volume output, e.g. `yes | head -100000` or `cat` a large file. Scrolling
and redraw stay fluid (WebGL renderer; silently falls back to DOM on GL context
loss — never goes blank). *(xterm-engine.ts `mount` → WebglAddon)*

### B5. ⬜ Correct emoji / wide-glyph widths (Unicode 11)
`printf '👩‍💻🚀✅ 你好 |\n'` (or `cat` a file with emoji/CJK). Wide glyphs occupy
the right cell count and the trailing `|` stays aligned — no overlap or clipping.
*(Unicode11Addon; upgrade over legacy v6 width tables)*

### B6. ⬜ Inline images (Sixel + iTerm2)
If you have `img2sixel` (or an agent that emits iTerm2 OSC 1337 images), the image
renders **inline** in the terminal. *(ImageAddon — pure-JS decode)*

### B7. ⬜ Cursor & theme
Blinking cursor in **blue** (`#2B4CF2`), JetBrains Mono 12px on the near-black
background (`#0A0A0B`). Selection is a translucent blue. *(xterm-engine.ts `THEME`)*

---

## C. Interactions (parity — should match the legacy terminal)

### C8. ⬜ Clickable asset paths → Assets panel
When output contains a previewable file path, it’s **underlined** with a pointer
cursor; clicking it opens that file in the **Assets** panel (not a new window).
*(pool.ts link provider → `previewToken`)*

### C9. ⬜ OSC 8 hyperlinks → external browser
A terminal hyperlink (OSC 8) opens in your **default browser**, not an in-app
window. Only `http(s)://` is allowed (validated in the main process).

### C10. ⬜ Finder drag-and-drop inserts a quoted path
Drag file(s) from Finder onto the terminal. You see a **“Drop to insert file
path”** overlay; on drop, a **shell-quoted** path (plus a trailing space) is
inserted at the prompt and focus returns to the terminal. *(CrewTerminal.tsx `onDrop`)*

### C11. ⬜ Scrollback + focus survive tab / grid switches
Switch tabs / reorder grid tiles / regroup. Scrollback is preserved and the
terminal keeps (or reclaims) keyboard focus — you can keep typing without
clicking. *(engine pooled per session; focus reclaim in CrewTerminal)*

### C12. ⬜ Bottom row never clipped on resize
Resize the window small/large; the bottom input row stays fully visible (row-cap
fix). *(xterm-engine.ts `fit`)*

---

## D. Safety / regression gates

### D13. ⬜ Toggle OFF = byte-for-byte legacy
Turn the setting **OFF**. Terminals remount to the **original** engine; none of
A1–A3 appear; everything behaves exactly as before. Toggle on/off repeatedly →
no crash, no duplicate terminals, input still focuses.

### D14. ⬜ Shell config preserved (crew-hook safety)
Put a marker in `~/.zshrc` (e.g. `export CREW_RC_OK=1`) and a custom prompt. In a
Shell session with the beta ON, your prompt shows and `echo $CREW_RC_OK` prints
`1`; `echo $ZDOTDIR` shows your normal value (restored). Turn beta OFF → new
Shell sessions get no injection.

---

## Quick pass/fail summary

| # | Feature | Result |
|---|---|---|
| A1 | Yellow input-row highlight (bg `#FFF9C4` + amber bar `#E8A317` + tick `#FFCC00`) | ⬜ |
| A2 | ⌘↑/⌘↓ jump-to-prompt (key consumed) | ⬜ |
| A3 | Green/red exit-code ruler ticks (`#43b581` / `#e5484d`) | ⬜ |
| B4 | WebGL smooth high-volume output | ⬜ |
| B5 | Unicode 11 emoji/wide-glyph widths | ⬜ |
| B6 | Inline images (Sixel / iTerm2) | ⬜ |
| B7 | Blue blinking cursor + JetBrains Mono theme | ⬜ |
| C8 | Clickable asset paths → Assets panel | ⬜ |
| C9 | OSC 8 links → external browser | ⬜ |
| C10 | Finder drag-drop → shell-quoted path | ⬜ |
| C11 | Scrollback + focus survive switches | ⬜ |
| C12 | Bottom row never clipped | ⬜ |
| D13 | Toggle OFF = legacy, no change | ⬜ |
| D14 | Shell rc/prompt preserved | ⬜ |

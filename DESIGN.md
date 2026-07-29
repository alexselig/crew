# Crew — Design System

The visual language of Crew, a menu-bar mission control for AI terminal sessions.
Each session gets a **character** and a **status**; the loudest UI treatment is
reserved for the one thing that matters — *a session waiting on you*.

Crew is built on a single design system — **Obsidian**: warm near-black, ivory
type, a single cobalt accent. It covers the main app chrome (roster, cards,
terminal, modals) *and* the full-screen **Project Tracker** overlay (`.tracker`),
which reuses the same `:root` tokens — no separate palette or fonts.

> **History:** the Project Tracker was previously a distinct "editorial" theme
> (espresso / cream / gold, Instrument Serif + Space Grotesk). As of the Obsidian
> redesign it was folded into the main system; those two typefaces are no longer
> referenced (see §3).

Tokens live in [`src/renderer/styles.css`](src/renderer/styles.css) (`:root`, with the
Project Tracker overlay scoped under `.tracker`), the character palette in
[`src/shared/palette.ts`](src/shared/palette.ts), webfonts in
[`src/renderer/fonts/fonts.css`](src/renderer/fonts/fonts.css), and the semantic state
model in [`src/renderer/state-meta.ts`](src/renderer/state-meta.ts).

---

## 1. Design principles

1. **Obsidian, not black.** The base is a *warm* near-black (`#0a0a0b`) with *ivory*
   (`#f2f1ea`) type — never pure `#000`/`#fff`.
2. **Hairlines over fills.** Surfaces separate with translucent 1px borders, not
   background blocks. `--panel` is the same color as `--bg` on purpose.
3. **One accent.** A single cobalt (`#2b4cf2`) carries all "active/primary" meaning,
   and it is used for **solid fills only**. Small cobalt text uses a lighter tint.
4. **Attention is earned.** The loudest treatment — an inverted ivory chip — is spent
   only on the *"needs you"* states. Everything else stays quiet (dim/faint text).
5. **Restraint.** Small radii (2–4px), one soft shadow, short motion (~0.1–0.18s).
6. **Character & color identity.** A 15-hue vivid palette gives every session a face
   and a color, so the roster is scannable at a glance.
7. **No faux styles.** `font-synthesis: none` — every weight/italic is a real webfont.

---

## 2. Color tokens — Obsidian (`:root`)

### Surfaces
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0a0b` | App background (warm near-black) |
| `--bg-elev` | `#131315` | Subtle raised surface: inputs, menus, hovers |
| `--bg-elev-2` | `#191a1d` | Second elevation step |
| `--panel` | `#0a0a0b` | Panels — separated by hairlines, not fill |
| `--term-bg` | `#0a0a0b` | Terminal background |

### Type & lines (ivory-derived)
| Token | Value | Use |
|---|---|---|
| `--ivory` / `--text` | `#f2f1ea` | Primary text / brand ivory |
| `--text-dim` | `rgba(242,241,234,0.55)` | Secondary text |
| `--text-faint` | `rgba(242,241,234,0.40)` | Tertiary / muted text |
| `--icon` | `#8f8e88` | Icon default |
| `--border` | `rgba(242,241,234,0.14)` | Standard hairline |
| `--border-soft` | `rgba(242,241,234,0.08)` | Faint divider |
| `--hair-strong` | `rgba(242,241,234,0.35)` | Emphasized border / hover |
| `--near-black` | `#0a0a0b` | Text on inverted (ivory) surfaces |

### Accent & signal
| Token | Value | Use |
|---|---|---|
| `--accent` | `#2b4cf2` | Cobalt — **solid fills only** |
| `--accent-hover` | `#2743d6` | ~8% darker, for hovers |
| `--accent-text` | `#5f79ff` | Lighter cobalt for small text on black |
| `--danger` | `#e5484d` | Errors / destructive |

### Character & group palette
15 vivid hues + a neutral grey ([`palette.ts`](src/shared/palette.ts)), assigned to a
session's character (random at creation, editable) and hashed onto group labels. Bright
enough to read against Obsidian.

`#ff5a5a` `#ff7a3c` `#ff9f2e` `#ffd23c` `#c6e04a` `#7ed957` `#45c98a` `#34d0c3`
`#37c0e6` `#4aa8ff` `#8a6dff` `#b57cff` `#d86fe0` `#ff6fb5` `#ff6f8f` · `#9aa4ad` (grey)

---

## 3. Typography

`font-synthesis: none` globally. Default UI text is **system sans** at **13px**,
`-webkit-font-smoothing: antialiased`.

| Role | Family | Weights | Where |
|---|---|---|---|
| UI / body | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | 400–700 | All chrome, incl. Project Tracker UI |
| Serif accent / display | **Newsreader** *(italic)*, Georgia fallback | 500 | Headers, wordmark, Project Tracker titles |
| Terminal & mono UI | **JetBrains Mono**, `ui-monospace, SFMono-Regular, Menlo` | 400/500/600/700 | xterm terminal, code/mono labels, tracker meta |

> **Removed:** **Instrument Serif** and **Space Grotesk** (the old editorial
> Project Tracker theme) are gone — their `@font-face` blocks have been deleted
> from `fonts.css`, which now bundles only Newsreader + JetBrains Mono. (The
> stale `.woff2` files still sit in `fonts/` and can be pruned.)

### Type treatments
- **Eyebrows / section labels:** uppercase, `letter-spacing` 0.08–0.2em, weight 600–700.
- **Status chips:** uppercase, `letter-spacing` 0.12–0.14em.
- **Serif accents:** Newsreader *italic*, `letter-spacing` ~0.01em.
- Fonts are bundled and served from the app origin (CSP `font-src 'self'`).

---

## 4. Shape, elevation & spacing

| Token | Value | Use |
|---|---|---|
| `--radius` | `4px` | Cards, buttons, inputs |
| `--radius-sm` | `2px` | Chips, small controls, tags |
| `--shadow` | `0 10px 44px rgba(0,0,0,0.6)` | Floating surfaces (menus, modals) |

- **Elevation** is expressed by hairline borders + the single shadow token; raised
  surfaces may also step up to `--bg-elev` / `--bg-elev-2`.
- **Layout:** the app is a CSS grid, `--nav-width` (default **300px**) + `1fr`. The
  roster (left nav) has fixed, **floating** (`--nav-expanded`), and **collapsed rail**
  variants.

---

## 5. Motion

Fast and restrained. Standard transitions are **0.1–0.18s**, `ease` / `ease-out`, on
`background`, `border-color`, `color`, `transform`, `opacity`.

| Animation | Duration | Use |
|---|---|---|
| `roster-float-in` | 0.18s ease-out | Floating roster reveal |
| `tracker-in` | 0.18s ease | Project Tracker overlay fade |
| `char-run` | 2.4s ∞ | Character "working" opacity pulse |
| `char-work` | 1.5s ∞ | Illustrated face bob + slight scale |
| `char-blink` | 1.6s ∞ (steps) | Idle/waiting blink |

> **Accessibility:** `@media (prefers-reduced-motion: reduce)` disables all character
> animation.

---

## 6. Semantic state model — the heart of the UI

Each session has a `SessionState` that maps to a **tone**, a **dot color**, and a
**character animation** ([`state-meta.ts`](src/renderer/state-meta.ts)).

| State | Chip | Tone | Dot | Character anim |
|---|---|---|---|---|
| `STARTING` | STARTING | idle | `#8F8E88` grey | start |
| `WORKING` | WORKING | working | `#5F79FF` cobalt | run |
| `WAITING_INPUT` | WAITING | **attention** | `#F2F1EA` ivory | wait |
| `WAITING_APPROVAL` | APPROVE | **attention** | `#F2F1EA` ivory | wait |
| `IDLE` | IDLE | idle | `#8F8E88` grey | sleep |
| `EXITED` | EXITED | idle | `#8F8E88` grey | gone |
| `ERROR` | ERROR | error | `#e5484d` danger | gone |

### Tone → visual treatment
- **working** — cobalt label/chip (`--accent` fill, `--accent-text` label).
- **attention** — *inverted ivory chip* (ivory bg, near-black text). The **loudest**
  treatment; reserved for "needs you."
- **idle** — muted `--text-faint`, optionally a bordered chip.
- **error** — restrained `--danger`.

### Roster sort priority
Who needs you first, then who's busy, then the rest:
`WAITING_APPROVAL → WAITING_INPUT → WORKING → STARTING → IDLE → ERROR → EXITED`.

---

## 7. Components & patterns

**Buttons** (`.btn`, transitions ~0.12s):
- `.btn--newsession` — uppercase eyebrow (0.2em), `--hair-strong` border → cobalt fill on hover.
- `.btn--primary` — cobalt fill → `--accent-hover`.
- `.btn--danger` — `--danger` border on hover.
- `.btn--outline` — hairline border → `--hair-strong` on hover.
- `.btn--lg`, `.mini-btn--icon` — size / icon-only variants.

**Session cards** — `--radius` corners, `--compact` density variant; selected card gets
a **2px cobalt outline**.

**Status tags/chips** (`StatusTag`) — uppercase; `working` = cobalt fill, `attention` =
inverted ivory, `idle` = bordered, `error` = danger. See §6.

**Character** — mascot art/glyph + colored status **dot**; autopilot sessions get a
cobalt `drop-shadow` glow.

**Roster** — fixed 300px nav, or floating/collapsed rail showing character dots.

---

## 8. Project Tracker overlay (`.tracker`)

A full-screen (`position: fixed; inset: 0`), `z-index: 200` overlay that fades in via
`tracker-in` (0.18s). Since the Obsidian redesign it introduces **no palette of its
own** — it reuses the app's `:root` tokens (`--bg`, `--text`, `--ivory`, `--accent`,
`--accent-text`, hairline borders, etc.).

| Aspect | Treatment |
|---|---|
| Background / text | `var(--bg)` / `var(--text)` |
| Column | centered, `max-width: 980px`, padding `56px 32px 80px` |
| Display title | **Newsreader** italic 500, 38px, `--ivory`; emphasis (`em`) in `--accent-text` |
| Eyebrows / labels | uppercase, `letter-spacing` ~0.18em, `--text-faint` |
| Meta / numbers | `ui-monospace, 'JetBrains Mono'`, ~11.5px |
| Selection | `var(--accent)` background, white text |

This replaced the earlier "editorial project index" theme (espresso / cream / gold,
`--pt-*` tokens, Instrument Serif + Space Grotesk), which has been fully removed.

---

## 9. Source of truth

| Concern | File |
|---|---|
| Obsidian tokens, components, motion | `src/renderer/styles.css` (`:root`) |
| Project Tracker overlay (uses `:root` tokens) | `src/renderer/styles.css` (`.tracker`, ~L4092) |
| Character / group color palette | `src/shared/palette.ts` |
| Bundled webfonts (Newsreader + JetBrains Mono) | `src/renderer/fonts/fonts.css` |
| Session state → tone / color / anim | `src/renderer/state-meta.ts` |

When adding UI, reuse `:root` tokens rather than raw hex, keep cobalt to solid fills,
prefer hairlines to fills, and reserve the inverted-ivory "attention" treatment for
states that genuinely need the user.

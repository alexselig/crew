"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_os = require("node:os");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const node_child_process = require("node:child_process");
const pty = require("node-pty");
const node_crypto = require("node:crypto");
const node_events = require("node:events");
const net = require("node:net");
const http = require("node:http");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
const NEEDS_YOU = ["WAITING_INPUT", "WAITING_APPROVAL"];
const IPC = {
  // renderer -> main (invoke)
  SESSION_CREATE: "session:create",
  SESSION_CLOSE: "session:close",
  SESSION_RESTART: "session:restart",
  SESSION_INPUT: "session:input",
  SESSION_RESIZE: "session:resize",
  SESSION_RENAME: "session:rename",
  SESSION_SET_CHARACTER: "session:setCharacter",
  SESSION_SET_COLOR: "session:setColor",
  SESSION_SET_TAG: "session:setTag",
  SESSION_SET_WORKSPACES: "session:setWorkspaces",
  SESSION_REORDER: "session:reorder",
  WINDOW_OPEN: "window:open",
  ROSTER_GET: "roster:get",
  PRESETS_GET: "presets:get",
  CHARACTERS_GET: "characters:get",
  HOME_DIR_GET: "home:get",
  AGENTS_DETECT: "agents:detect",
  SKILLS_LIST: "skills:list",
  SETTINGS_GET: "settings:get",
  SETTINGS_UPDATE: "settings:update",
  SETS_GET: "sets:get",
  SETS_SAVE: "sets:save",
  SETS_LAUNCH: "sets:launch",
  SETS_DELETE: "sets:delete",
  EVENTS_GET: "events:get",
  ASSETS_LIST: "assets:list",
  ASSET_REVEAL: "assets:reveal",
  ASSET_OPEN: "assets:open",
  ASSET_RESOLVE: "assets:resolve",
  TRANSCRIPT_SEARCH: "transcript:search",
  TRANSCRIPT_GET: "transcript:get",
  TRANSCRIPT_EXPORT: "transcript:export",
  AGENT_TRANSCRIPT_GET: "agentTranscript:get",
  TRACKER_SCAN: "tracker:scan",
  TRACKER_PAST_WEEK: "tracker:pastWeek",
  USAGE_ANALYTICS: "usage:analytics",
  UPDATE_CHECK: "update:check",
  OPEN_EXTERNAL: "shell:openExternal",
  GITHUB_URL: "session:githubUrl",
  ACTIVITY_COMMITS: "activity:commits",
  TRACKER_LAUNCH: "tracker:launch",
  TRACKER_STOP: "tracker:stop",
  TRACKER_STATUS: "tracker:status",
  WORKSPACES_GET: "workspaces:get",
  WORKSPACE_CREATE: "workspace:create",
  WORKSPACE_RENAME: "workspace:rename",
  WORKSPACE_DESCRIBE: "workspace:describe",
  WORKSPACE_DELETE: "workspace:delete",
  WORKSPACE_REORDER: "workspace:reorder",
  SESSION_SET_WORKSPACE_IDS: "session:setWorkspaceIds",
  SESSION_ADD_WORKSPACE: "session:addWorkspace",
  SESSION_REMOVE_WORKSPACE: "session:removeWorkspace",
  SESSION_MOVE_WORKSPACE: "session:moveWorkspace",
  SESSION_ARCHIVE: "session:archive",
  SESSION_DUPLICATE: "session:duplicate",
  SESSION_DESCRIBE: "session:describe",
  AGENTS_GET: "agents:get",
  AGENT_UPSERT: "agent:upsert",
  AGENT_DELETE: "agent:delete",
  AGENTS_REORDER: "agents:reorder",
  AGENT_RUN: "agent:run",
  AGENT_RUN_CANCEL: "agent:runCancel",
  AGENT_SAVE_RESULT: "agent:saveResult",
  // main -> renderer (send)
  EVT_OUTPUT: "evt:output",
  EVT_STATE: "evt:state",
  EVT_ROSTER: "evt:roster",
  EVT_JUMP: "evt:jump",
  EVT_NEW: "evt:new",
  EVT_WORKSPACE: "evt:workspace",
  EVT_WORKSPACES: "evt:workspaces",
  EVT_OPEN_WORKSPACES: "evt:openWorkspaces",
  EVT_AGENTS: "evt:agents",
  EVT_AGENT_RUN: "evt:agentRun",
  EVT_ASSETS: "evt:assets",
  EVT_UPDATE: "evt:update"
};
const DEFAULT_SPINNER_REGEX = /[\u2800-\u28FF\u2580-\u259F\u25E2-\u25E5◐◓◑◒◴◷◶◵]/;
const DEFAULT_DETECTION = {
  quietMs: 800,
  confirmMs: 0,
  assumeWaitingAfterMs: 1500,
  inputGraceMs: 2500,
  promptRegex: null,
  approvalRegex: null,
  spinnerRegex: DEFAULT_SPINNER_REGEX
};
const TERMINAL_STATES = ["EXITED", "ERROR"];
function stripAnsi(input) {
  return input.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001B[@-Z\\-_]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
class StateDetector {
  cfg;
  onChange;
  _state = "STARTING";
  _reason = "none";
  buf = "";
  lastOutputAt;
  hasOutput = false;
  // After the user sends input, the agent is working — suppress any "waiting"
  // verdict until it actually produces output again (SPEC §6: "waiting ≈ … and
  // we haven't sent input since"). Prevents a false red dot + notification
  // during think-time / a tool or network stall right after your prompt.
  awaitingOutputSinceInput = false;
  // When the user last sent input. Used to grant a post-input grace window
  // during which the low-confidence silence fallback is suppressed.
  lastInputAt = Number.NEGATIVE_INFINITY;
  // Debounce bookkeeping for the WORKING → WAITING transition.
  pending = null;
  pendingSince = 0;
  constructor(now, cfg, onChange) {
    this.cfg = { ...DEFAULT_DETECTION, ...cfg };
    this.onChange = onChange;
    this.lastOutputAt = now;
  }
  get state() {
    return this._state;
  }
  get reason() {
    return this._reason;
  }
  set(next, reason) {
    this._reason = reason;
    if (next !== this._state) {
      this._state = next;
      this.onChange(next, reason);
    }
  }
  /** Called when the PTY emits data. Flowing output always means WORKING. */
  pushOutput(chunk, now) {
    if (TERMINAL_STATES.includes(this._state)) return;
    this.lastOutputAt = now;
    this.hasOutput = true;
    this.awaitingOutputSinceInput = false;
    const animating = this.cfg.spinnerRegex ? this.cfg.spinnerRegex.test(chunk) : false;
    this.buf = (this.buf + stripAnsi(chunk)).slice(-4e3);
    this.pending = null;
    this.set("WORKING", animating ? "spinner" : "streaming");
  }
  /** Called when the user sends input; the agent is about to work. */
  notifyInput(now) {
    if (TERMINAL_STATES.includes(this._state)) return;
    this.lastOutputAt = now;
    this.lastInputAt = now;
    this.pending = null;
    this.awaitingOutputSinceInput = true;
    this.set("WORKING", "streaming");
  }
  markExited(code) {
    this.set(code && code !== 0 ? "ERROR" : "EXITED", "none");
  }
  /** Periodic evaluation of quiescence timers. Call every ~200-300ms. */
  tick(now) {
    if (TERMINAL_STATES.includes(this._state)) return;
    const quietFor = now - this.lastOutputAt;
    if (quietFor < this.cfg.quietMs) {
      this.pending = null;
      return;
    }
    if (this.awaitingOutputSinceInput) {
      this.pending = null;
      return;
    }
    const tail = this.buf.slice(-600);
    if (this.cfg.approvalRegex && this.cfg.approvalRegex.test(tail)) {
      this.commit("WAITING_APPROVAL", "approval-prompt", now);
      return;
    }
    if (this.cfg.promptRegex && this.cfg.promptRegex.test(tail)) {
      this.commit("WAITING_INPUT", "input-prompt", now);
      return;
    }
    if (now - this.lastInputAt < this.cfg.inputGraceMs) {
      this.pending = null;
      return;
    }
    if (this.hasOutput && this.cfg.assumeWaitingAfterMs != null && quietFor >= this.cfg.assumeWaitingAfterMs) {
      this.commit("WAITING_INPUT", "silence", now);
      return;
    }
    this.pending = null;
    if (this.hasOutput && this._state === "WORKING") {
      this.set("IDLE", "idle");
    }
  }
  /** Apply confirmMs debounce hysteresis before committing a WAITING_* verdict. */
  commit(next, reason, now) {
    if (this.pending !== next) {
      this.pending = next;
      this.pendingSince = now;
    }
    if (now - this.pendingSince >= this.cfg.confirmMs) {
      this.set(next, reason);
    }
  }
}
const DEV_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s"'<>）)]*)?/gi;
function detectDevUrl(text) {
  if (!text) return null;
  const clean = stripAnsi(text);
  const matches = clean.match(DEV_URL_RE);
  if (!matches || matches.length === 0) return null;
  let url = matches[matches.length - 1];
  url = url.replace(/[.,;]+$/, "");
  url = url.replace(/:\/\/0\.0\.0\.0:/, "://127.0.0.1:");
  return url;
}
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
function isLoopbackHttp(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    return LOOPBACK_HOSTS.has(host) || host === "[::1]";
  } catch {
    return false;
  }
}
const DEFAULT_COST_REGEX_SRC = "(?:cost|spent|billed|charge[ds]?|total)[^\\n$]{0,40}\\$\\s?(\\d+(?:\\.\\d+)?)";
const DEFAULT_CREDITS_REGEX_SRC = "(\\d+(?:\\.\\d+)?)\\s*(?:AIC|credits?|premium\\s+requests?)";
class CostParser {
  buf = "";
  _usd = 0;
  re;
  constructor(cfg) {
    this.re = cfg.costRegex ? new RegExp(cfg.costRegex.source, "gi") : null;
  }
  /** Feed an ANSI-stripped chunk. Returns true if the tracked value increased. */
  push(clean) {
    if (!this.re) return false;
    this.buf = (this.buf + clean).slice(-6e3);
    this.re.lastIndex = 0;
    let max = this._usd;
    let m;
    while ((m = this.re.exec(this.buf)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v > max) max = v;
    }
    if (max !== this._usd) {
      this._usd = max;
      return true;
    }
    return false;
  }
  get usd() {
    return this._usd;
  }
  /** Generic accessor (the tracked cumulative maximum) — used for credits too. */
  get value() {
    return this._usd;
  }
}
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
process.platform === "linux";
function defaultShell() {
  if (isWindows) return process.env.CREW_SHELL || "powershell.exe";
  return process.env.SHELL || (isMac ? "/bin/zsh" : "/bin/bash");
}
const APPROVAL = "(\\(y/n\\)|\\[y/N\\]|\\by/n\\b|\\bY/n\\b|Do you want|Would you like to proceed|Allow\\b|permission to|Proceed\\?|Continue\\?|Approve\\b|Yes/No)";
function builtinPresets() {
  return [
    {
      // Copilot CLI is the default preset for new sessions (listed first).
      id: "copilot-cli",
      name: "Copilot CLI",
      command: "copilot",
      args: [],
      approvalRegex: APPROVAL,
      approveKeys: "y\r",
      denyKeys: "n\r",
      installHint: "npm i -g @github/copilot",
      // Copilot's --session-id both sets a new session's UUID and resumes an
      // existing one by ID, so Crew controls each session's id and resumes a
      // saved set precisely. --continue stays as a fallback for legacy sessions
      // started before Crew tracked ids.
      sessionIdFlag: "--session-id=",
      resumeArgs: ["--continue"],
      quietMs: 800,
      confirmMs: 400,
      // Agent produced output (since your last input) then went quiet for >1.5s
      // with no recognized prompt ⇒ almost certainly your turn. The detector
      // separately suppresses this while the agent is still answering you.
      assumeWaitingAfterMs: 1500
    },
    {
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      args: [],
      approvalRegex: APPROVAL,
      approveKeys: "y\r",
      denyKeys: "n\r",
      installHint: "Install from https://claude.com/claude-code",
      resumeArgs: ["--continue"],
      quietMs: 800,
      confirmMs: 400,
      assumeWaitingAfterMs: 1500
    },
    {
      id: "shell",
      name: "Shell",
      command: defaultShell(),
      args: [],
      // A shell sitting at its prompt IS waiting for you — match a trailing
      // prompt sigil so the dot appears the instant a command finishes.
      promptRegex: "[$%#>❯]\\s*$",
      approvalRegex: "(\\(y/n\\)|\\[y/N\\]|\\by/n\\b)",
      quietMs: 500,
      confirmMs: 0,
      assumeWaitingAfterMs: null
    }
  ];
}
function getPreset(id) {
  if (!id) return null;
  return builtinPresets().find((p) => p.id === id) ?? null;
}
const CHARACTERS = [
  { id: "fox", name: "Fox", glyph: "🦊", color: "#e8833a" },
  { id: "bear", name: "Bear", glyph: "🐻", color: "#8a5a2b" },
  { id: "deer", name: "Deer", glyph: "🦌", color: "#a9744e" },
  { id: "owl", name: "Owl", glyph: "🦉", color: "#b08968" },
  { id: "rabbit", name: "Rabbit", glyph: "🐰", color: "#b8b2a8" },
  { id: "squirrel", name: "Squirrel", glyph: "🐿️", color: "#c56b3e" },
  { id: "raccoon", name: "Raccoon", glyph: "🦝", color: "#8b8b8b" },
  { id: "hedgehog", name: "Hedgehog", glyph: "🦔", color: "#b5835a" },
  { id: "lion", name: "Lion", glyph: "🦁", color: "#d1a33a" },
  { id: "monkey", name: "Monkey", glyph: "🐵", color: "#9c6b4a" },
  { id: "frog", name: "Frog", glyph: "🐸", color: "#5fb85f" },
  { id: "elephant", name: "Elephant", glyph: "🐘", color: "#9098a0" },
  { id: "koala", name: "Koala", glyph: "🐨", color: "#9ba7b0" },
  { id: "panda", name: "Panda", glyph: "🐼", color: "#9aa0a6" },
  { id: "penguin", name: "Penguin", glyph: "🐧", color: "#6c8ebf" },
  { id: "duck", name: "Duck", glyph: "🦆", color: "#e0b84a" },
  { id: "cat", name: "Cat", glyph: "🐱", color: "#a7a2ad" },
  { id: "dog", name: "Dog", glyph: "🐶", color: "#cf9b62" },
  { id: "tiger", name: "Tiger", glyph: "🐯", color: "#db7f2b" },
  { id: "pig", name: "Pig", glyph: "🐷", color: "#e6a0ab" },
  { id: "wolf", name: "Wolf", glyph: "🐺", color: "#8b95a1" },
  { id: "cow", name: "Cow", glyph: "🐮", color: "#d5cabb" },
  { id: "horse", name: "Horse", glyph: "🐴", color: "#a5673a" },
  { id: "mouse", name: "Mouse", glyph: "🐭", color: "#b6aeb0" },
  { id: "hamster", name: "Hamster", glyph: "🐹", color: "#cf9f5a" },
  { id: "sheep", name: "Sheep", glyph: "🐑", color: "#e4ded3" },
  { id: "goat", name: "Goat", glyph: "🐐", color: "#bcae97" },
  { id: "rooster", name: "Rooster", glyph: "🐔", color: "#cf5245" },
  { id: "hippo", name: "Hippo", glyph: "🦛", color: "#a291a8" },
  { id: "rhino", name: "Rhino", glyph: "🦏", color: "#94969c" },
  { id: "giraffe", name: "Giraffe", glyph: "🦒", color: "#d6a03e" },
  { id: "llama", name: "Llama", glyph: "🦙", color: "#c9a878" }
];
function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id);
}
function isCharacterId(id) {
  return id != null && CHARACTERS.some((c) => c.id === id);
}
function pickCharacter(used, preferred) {
  const counts = /* @__PURE__ */ new Map();
  for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1);
  const countOf = (id) => counts.get(id) ?? 0;
  if (preferred && isCharacterId(preferred) && countOf(preferred) === 0) return preferred;
  for (const c of CHARACTERS) {
    if (countOf(c.id) === 0) return c.id;
  }
  const min = Math.min(...CHARACTERS.map((c) => countOf(c.id)));
  const leastUsed = CHARACTERS.filter((c) => countOf(c.id) === min);
  return leastUsed[Math.floor(Math.random() * leastUsed.length)].id;
}
const HANDOFF_DIR = process.env.CREW_HANDOFF_DIR || node_path.join(node_os.homedir(), ".crew", "handoffs");
function briefPathFor(agentSessionId, dir = HANDOFF_DIR) {
  if (!agentSessionId) return null;
  const suffix = `--${agentSessionId.slice(0, 8)}.md`;
  try {
    const hit = node_fs.readdirSync(dir).find((f) => f.endsWith(suffix));
    return hit ? node_path.join(dir, hit) : null;
  } catch {
    return null;
  }
}
function primerFor(briefPath) {
  return `Read ${briefPath} first — it is the context brief for this session, distilled from our previous conversation. Treat it as the current state of the work and continue from there; re-read any files it cites rather than trusting them to be unchanged.`;
}
function resolveContext(opts) {
  const { agentSessionId, resume, contextMode, resumeArgs } = opts;
  const supersede = { agentSessionId: void 0, priorSessionId: agentSessionId, extraArgs: [] };
  if (!resume) return supersede;
  if (contextMode === "brief" && agentSessionId) return supersede;
  return { agentSessionId, priorSessionId: void 0, extraArgs: resumeArgs ?? [] };
}
function normalizeSetNames(input) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of input) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
function workspaceNames(setNames, sessionMemberships) {
  const all = [...setNames];
  for (const m of sessionMemberships) if (m) all.push(...m);
  return normalizeSetNames(all).sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase())
  );
}
function addToSets(sets, name) {
  return normalizeSetNames([...sets ?? [], name]);
}
function removeFromSets(sets, name) {
  const key = name.trim().toLowerCase();
  return normalizeSetNames((sets ?? []).filter((s) => s.trim().toLowerCase() !== key));
}
function makeWorkspaceId() {
  return "ws_" + Math.random().toString(36).slice(2, 10);
}
const norm = (s) => s.trim().toLowerCase();
function createWorkspace(list2, name, now) {
  const trimmed = name.trim();
  if (!trimmed || list2.some((w) => norm(w.name) === norm(trimmed))) {
    return { list: [...list2], created: null };
  }
  const order = list2.reduce((max, w) => Math.max(max, w.order), -1) + 1;
  const created = { id: makeWorkspaceId(), name: trimmed, order, createdAt: now };
  return { list: [...list2, created], created };
}
function renameWorkspace(list2, id, name) {
  const trimmed = name.trim();
  if (!trimmed) return [...list2];
  if (list2.some((w) => w.id !== id && norm(w.name) === norm(trimmed))) return [...list2];
  return list2.map((w) => w.id === id ? { ...w, name: trimmed } : w);
}
function describeWorkspace(list2, id, description) {
  const trimmed = description.trim();
  return list2.map((w) => w.id === id ? { ...w, description: trimmed || void 0 } : w);
}
function deleteWorkspace(list2, id) {
  return list2.filter((w) => w.id !== id);
}
function reorderWorkspaces(list2, orderedIds) {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  return list2.map((w) => ({ ...w, order: rank.has(w.id) ? rank.get(w.id) : w.order })).sort((a, b) => a.order - b.order);
}
function addMembership(ids, wsId) {
  const cur = ids ?? [];
  return cur.includes(wsId) ? [...cur] : [...cur, wsId];
}
function removeMembership(ids, wsId) {
  return (ids ?? []).filter((x) => x !== wsId);
}
function moveMembership(ids, fromId, toId) {
  return addMembership(removeMembership(ids, fromId), toId);
}
function nameToIdMap(list2) {
  return new Map(list2.map((w) => [norm(w.name), w.id]));
}
const CHARACTER_COLORS = [
  "#ff5a5a",
  // red
  "#ff7a3c",
  // orange
  "#ff9f2e",
  // amber
  "#ffd23c",
  // yellow
  "#c6e04a",
  // lime
  "#7ed957",
  // green
  "#45c98a",
  // emerald
  "#34d0c3",
  // teal
  "#37c0e6",
  // cyan
  "#4aa8ff",
  // sky
  "#8a6dff",
  // violet
  "#b57cff",
  // purple
  "#d86fe0",
  // magenta
  "#ff6fb5",
  // pink
  "#ff6f8f",
  // rose
  "#9aa4ad"
  // grey
];
function randomCharacterColor() {
  return CHARACTER_COLORS[Math.floor(Math.random() * CHARACTER_COLORS.length)];
}
function fallbackCharacterColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) >>> 0;
  return CHARACTER_COLORS[h % CHARACTER_COLORS.length];
}
function makeAgentId() {
  return "ag_" + Math.random().toString(36).slice(2, 10);
}
function makeRunId() {
  return "run_" + Math.random().toString(36).slice(2, 10);
}
const BUILTIN_AGENTS = [
  {
    id: "ag_ux",
    name: "UX Critique",
    icon: "spark",
    color: "#c879ff",
    base: "copilot-cli",
    writes: false,
    contextMode: "cwd",
    order: 0,
    builtin: true,
    persona: "You are a senior product designer doing a UX critique. Inspect the app/code in this working directory (read only — do NOT edit any files). Report the top usability, hierarchy, accessibility and copy issues, each with a concrete fix. Be specific and concise."
  },
  {
    id: "ag_review",
    name: "Code Review",
    icon: "check",
    color: "#3fb950",
    base: "copilot-cli",
    writes: false,
    contextMode: "cwd",
    order: 1,
    builtin: true,
    persona: "You are a meticulous staff engineer. Review the recent changes in this repository (read only — do NOT edit). Report high-confidence correctness bugs, risky logic, and design issues, with file references. Skip style nits."
  },
  {
    id: "ag_sec",
    name: "Security Review",
    icon: "shield",
    color: "#e5a13a",
    base: "copilot-cli",
    writes: false,
    contextMode: "cwd",
    order: 2,
    builtin: true,
    persona: "You are an application security reviewer. Read the code in this working directory (read only — do NOT edit). Report only high-confidence, exploitable vulnerabilities with severity, location and remediation."
  },
  {
    id: "ag_docs",
    name: "Doc Writer",
    icon: "doc",
    color: "#5f79ff",
    base: "copilot-cli",
    writes: true,
    contextMode: "cwd",
    order: 3,
    builtin: true,
    persona: "You are a technical writer. Draft or update clear documentation for the code in this working directory. Prefer a concise README/section with usage examples."
  }
];
const COPILOT_WRITE_TOOLS = ["write", "edit", "shell"];
const CLAUDE_WRITE_TOOLS = ["Write", "Edit", "Bash"];
function buildPrompt(agent, task, extra) {
  const parts = [agent.persona];
  if (task.trim()) parts.push("Task: " + task.trim());
  if (extra.trim()) parts.push("Context:\n" + extra.trim());
  return parts.join("\n\n");
}
function buildAgentInvocation(base, agent, task, extra) {
  const prompt = buildPrompt(agent, task, extra);
  const cmd = base.command;
  if (cmd.includes("claude")) {
    const args2 = ["-p", prompt, "--output-format", "text"];
    if (agent.writes) args2.push("--dangerously-skip-permissions");
    else args2.push("--disallowedTools", CLAUDE_WRITE_TOOLS.join(","));
    return { args: args2 };
  }
  const args = ["-p", prompt];
  if (agent.writes) args.push("--allow-all-tools");
  else args.push("--allow-all-paths", "--deny-tool", COPILOT_WRITE_TOOLS.join(","));
  return { args };
}
function upsertAgent(list2, a) {
  const exists2 = list2.some((x) => x.id === a.id);
  return exists2 ? list2.map((x) => x.id === a.id ? a : x) : [...list2, a];
}
function deleteAgent(list2, id) {
  return list2.filter((x) => x.id !== id);
}
function reorderAgents(list2, orderedIds) {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  return list2.map((a) => ({ ...a, order: rank.has(a.id) ? rank.get(a.id) : a.order })).sort((x, y) => x.order - y.order);
}
const DEFAULT_SETTINGS = {
  notifications: true,
  sound: false,
  notifyOnlyWhenUnfocused: false,
  sortNeedsYouFirst: true,
  launchAtLogin: false,
  showSpend: true,
  showCredits: false,
  costMode: "auto",
  aicPerUsd: 100,
  resumeConversations: true,
  contextMode: "transcript",
  budgetUsd: 0,
  inputTokenWarn: 1e5,
  captureTranscripts: false,
  staleHideHours: 72,
  minimizedAsList: true,
  enhancedTerminal: false,
  showGithubButton: true,
  githubButtonOpensRepo: true
};
const EMPTY = {
  characters: {},
  settings: { ...DEFAULT_SETTINGS },
  recentDirs: [],
  sessions: [],
  sets: [],
  workspaces: [],
  agents: []
};
const MIGRATIONS = [
  {
    // Bump the previous 12h stale-hide default to 72h so a session last prompted
    // on Friday still shows on Monday. Only nudges stores still sitting on the
    // old default; any other value the user picked is left untouched.
    id: "2026-07-stale-hide-72h",
    apply: (d) => {
      if (d.settings.staleHideHours === 12) d.settings.staleHideHours = 72;
    }
  },
  {
    // Promote name-based workspaces (session.sets + empty SessionSets) to
    // first-class Workspace entities with stable ids, and rewrite each session's
    // membership to workspaceIds. Non-empty resume bundles in `sets` are left
    // untouched (they power Save & Park).
    id: "2026-08-workspaces-firstclass",
    apply: (d) => {
      if ((d.workspaces?.length ?? 0) > 0) return;
      const names = [];
      for (const s of d.sessions) if (s.sets) names.push(...s.sets);
      for (const set of d.sets) if (set.sessions.length === 0) names.push(set.name);
      let list2 = [];
      let now = Date.now();
      for (const name of normalizeSetNames(names)) {
        list2 = createWorkspace(list2, name, now++).list;
      }
      d.workspaces = list2;
      const byName = nameToIdMap(list2);
      for (const s of d.sessions) {
        if (s.workspaceIds) continue;
        s.workspaceIds = (s.sets ?? []).map((n) => byName.get(n.trim().toLowerCase())).filter((x) => !!x);
      }
    }
  },
  {
    // Seed the built-in specialist agents once. Users can edit/delete them after.
    id: "2026-08-agents-seed",
    apply: (d) => {
      if ((d.agents?.length ?? 0) > 0) return;
      d.agents = BUILTIN_AGENTS.map((a) => ({ ...a }));
    }
  }
];
function runMigrations(data) {
  const applied = new Set(data.migrations ?? []);
  let changed = false;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    m.apply(data);
    applied.add(m.id);
    changed = true;
  }
  data.migrations = [...applied];
  return changed;
}
function identityKey(presetId, cwd) {
  return `${presetId ?? "custom"}::${cwd}`;
}
const SNAPSHOT_DIR = "backups";
const SNAPSHOT_KEEP = 14;
const SNAPSHOT_PREFIX = "crew-store-";
class Store {
  constructor(path) {
    this.path = path;
    const { data, migrated } = this.load();
    this.data = data;
    this.snapshot();
    if (migrated) this.persist();
  }
  data;
  load() {
    try {
      return this.readFrom(this.path);
    } catch {
      if (node_fs.existsSync(this.path)) {
        const backup = `${this.path}.corrupt-${Date.now()}`;
        try {
          node_fs.renameSync(this.path, backup);
          console.warn(`[crew] store unreadable; preserved corrupt file at ${backup}`);
        } catch (err) {
          console.warn("[crew] store unreadable and could not be backed up:", err instanceof Error ? err.message : err);
        }
        for (const candidate of [`${this.path}.bak`, `${this.path}.bak2`]) {
          if (!node_fs.existsSync(candidate)) continue;
          try {
            const recovered = this.readFrom(candidate);
            console.warn(`[crew] recovered store from ${candidate}`);
            return { ...recovered, migrated: true };
          } catch {
          }
        }
      }
      return {
        data: {
          ...EMPTY,
          characters: {},
          recentDirs: [],
          sessions: [],
          sets: [],
          workspaces: [],
          agents: BUILTIN_AGENTS.map((a) => ({ ...a })),
          migrations: MIGRATIONS.map((m) => m.id)
        },
        migrated: false
      };
    }
  }
  /** Parse a store file into a fully-defaulted StoreData. Throws when the file
   * is missing or unparseable, so callers can fall through to a backup. */
  readFrom(path) {
    const raw = JSON.parse(node_fs.readFileSync(path, "utf8"));
    const data = {
      characters: raw.characters ?? {},
      settings: { ...DEFAULT_SETTINGS, ...raw.settings ?? {} },
      recentDirs: raw.recentDirs ?? [],
      sessions: raw.sessions ?? [],
      sets: raw.sets ?? [],
      workspaces: raw.workspaces ?? [],
      agents: raw.agents ?? [],
      windowBounds: raw.windowBounds,
      migrations: [...raw.migrations ?? []]
    };
    const migrated = runMigrations(data);
    return { data, migrated };
  }
  persist() {
    try {
      node_fs.mkdirSync(node_path.dirname(this.path), { recursive: true });
      this.rotateBackups();
      node_fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn("[crew] failed to persist store:", err instanceof Error ? err.message : err);
    }
  }
  /** Rotate <path> -> <path>.bak -> <path>.bak2. Best-effort and never throws:
   * a failed backup must not block the save itself. */
  rotateBackups() {
    if (!node_fs.existsSync(this.path)) return;
    try {
      if (node_fs.existsSync(`${this.path}.bak`)) {
        node_fs.copyFileSync(`${this.path}.bak`, `${this.path}.bak2`);
      }
      node_fs.copyFileSync(this.path, `${this.path}.bak`);
    } catch {
    }
  }
  /** The directory holding dated snapshots. */
  get snapshotDir() {
    return node_path.join(node_path.dirname(this.path), SNAPSHOT_DIR);
  }
  /** Existing snapshots, oldest first. The filename carries the date, so a
   * plain lexical sort is chronological. */
  snapshots() {
    try {
      return node_fs.readdirSync(this.snapshotDir).filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  /**
   * Write at most one dated snapshot per day, keeping the last SNAPSHOT_KEEP.
   *
   * Deliberately refuses to snapshot an empty roster: the failure this exists to
   * catch is the roster being silently pruned, and snapshotting that state would
   * spend a retention slot recording the damage instead of the last good copy.
   *
   * Best-effort — a failed snapshot must never stop the app from starting.
   */
  snapshot() {
    if (this.data.sessions.length === 0) return;
    try {
      const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const file = node_path.join(this.snapshotDir, `${SNAPSHOT_PREFIX}${day}.json`);
      if (node_fs.existsSync(file)) return;
      node_fs.mkdirSync(this.snapshotDir, { recursive: true });
      node_fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
      for (const stale of this.snapshots().slice(0, -SNAPSHOT_KEEP)) {
        try {
          node_fs.unlinkSync(node_path.join(this.snapshotDir, stale));
        } catch {
        }
      }
    } catch (err) {
      console.warn("[crew] failed to snapshot store:", err instanceof Error ? err.message : err);
    }
  }
  /** Dated snapshots available to restore from, newest first, with the session
   * count each one holds so a caller can tell a healthy roster from a pruned one. */
  listSnapshots() {
    const out = [];
    for (const name of this.snapshots().reverse()) {
      const file = node_path.join(this.snapshotDir, name);
      try {
        const raw = JSON.parse(node_fs.readFileSync(file, "utf8"));
        out.push({
          file,
          day: node_path.basename(name, ".json").slice(SNAPSHOT_PREFIX.length),
          sessions: raw.sessions?.length ?? 0
        });
      } catch {
      }
    }
    return out;
  }
  getAssignment(key) {
    return this.data.characters[key];
  }
  setAssignment(key, assignment) {
    this.data.characters[key] = assignment;
    this.persist();
  }
  get settings() {
    return this.data.settings;
  }
  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.persist();
    return this.data.settings;
  }
  get recentDirs() {
    return this.data.recentDirs;
  }
  addRecentDir(dir) {
    const next = [dir, ...this.data.recentDirs.filter((d) => d !== dir)].slice(0, 10);
    this.data.recentDirs = next;
    this.persist();
  }
  /** The set of sessions to re-launch on next startup. */
  getSessions() {
    return this.data.sessions;
  }
  saveSessions(list2) {
    this.data.sessions = list2;
    this.persist();
  }
  get sets() {
    return this.data.sets;
  }
  upsertSet(set) {
    this.data.sets = [...this.data.sets.filter((s) => s.name !== set.name), set];
    this.persist();
    return this.data.sets;
  }
  deleteSet(name) {
    this.data.sets = this.data.sets.filter((s) => s.name !== name);
    this.persist();
    return this.data.sets;
  }
  /** First-class workspaces (id-based). */
  getWorkspaces() {
    return this.data.workspaces;
  }
  saveWorkspaces(list2) {
    this.data.workspaces = list2;
    this.persist();
    return this.data.workspaces;
  }
  /** Specialist agent definitions (Agents shelf). */
  getAgents() {
    return this.data.agents;
  }
  saveAgents(list2) {
    this.data.agents = list2;
    this.persist();
    return this.data.agents;
  }
  /** Register workspace names as (possibly empty) sets so they persist and show
   *  up in menus/pickers even before a snapshot of open sessions is saved. */
  ensureSets(names) {
    let changed = false;
    const existing = new Set(this.data.sets.map((s) => s.name.toLowerCase()));
    for (const name of normalizeSetNames(names)) {
      if (existing.has(name.toLowerCase())) continue;
      this.data.sets.push({ name, sessions: [] });
      existing.add(name.toLowerCase());
      changed = true;
    }
    if (changed) this.persist();
  }
  /** Union of all known workspace names: explicit sets + every session's membership. */
  workspaceNames() {
    return workspaceNames(
      this.data.sets.map((s) => s.name),
      this.data.sessions.map((s) => s.sets)
    );
  }
  get windowBounds() {
    return this.data.windowBounds;
  }
  setWindowBounds(bounds) {
    this.data.windowBounds = bounds;
    this.persist();
  }
}
const PROJECTS_DIR = node_path.join(node_os.homedir(), ".claude", "projects");
const COPILOT_STATE_DIR = node_path.join(node_os.homedir(), ".copilot", "session-state");
const AUTOPILOT_MODES = /* @__PURE__ */ new Set(["acceptEdits", "bypassPermissions"]);
const TAIL_BYTES = 512 * 1024;
const PERMISSION_MODE_RE = /"permissionMode":"([a-zA-Z]+)"/g;
const COPILOT_MODE_RE = /"session\.mode_changed"[^\n]*?"newMode":"([a-zA-Z]+)"/g;
function isClaudeSession(info) {
  return info.presetId === "claude-code" || node_path.basename(info.command) === "claude";
}
function isCopilotSession(info) {
  return info.presetId === "copilot-cli" || node_path.basename(info.command) === "copilot";
}
function copilotEventsPath(agentSessionId, baseDir = COPILOT_STATE_DIR) {
  return node_path.join(baseDir, agentSessionId, "events.jsonl");
}
function latestCopilotMode(text) {
  COPILOT_MODE_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = COPILOT_MODE_RE.exec(text)) !== null) last = m[1];
  return last;
}
function isCopilotAutopilotMode(mode) {
  return mode === "autopilot";
}
function projectDirFor(cwd, projectsDir = PROJECTS_DIR) {
  return node_path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
function latestTranscript(dir) {
  let files;
  try {
    files = node_fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = node_fs.statSync(node_path.join(dir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: node_path.join(dir, f), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
    }
  }
  return best;
}
function readTail$1(path, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  if (len <= 0) return "";
  const fd = node_fs.openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const read = node_fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, read);
  } finally {
    node_fs.closeSync(fd);
  }
}
function latestPermissionMode(text) {
  PERMISSION_MODE_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = PERMISSION_MODE_RE.exec(text)) !== null) last = m[1];
  return last;
}
function isAutopilotMode(mode) {
  return mode != null && AUTOPILOT_MODES.has(mode);
}
class AutopilotWatcher {
  /** @param projectsDir base dir for Claude transcripts (override in tests). */
  constructor(projectsDir = PROJECTS_DIR) {
    this.projectsDir = projectsDir;
  }
  cache = /* @__PURE__ */ new Map();
  /** Current autopilot state for a Claude session at `cwd`. */
  isAutopilot(sessionId, cwd) {
    const latest = latestTranscript(projectDirFor(cwd, this.projectsDir));
    if (!latest) {
      this.cache.delete(sessionId);
      return false;
    }
    const prev = this.cache.get(sessionId);
    if (prev && prev.path === latest.path && prev.size === latest.size && prev.mtimeMs === latest.mtimeMs) {
      return isAutopilotMode(prev.mode);
    }
    const mode = latestPermissionMode(readTail$1(latest.path, latest.size)) ?? prev?.mode ?? null;
    this.cache.set(sessionId, { ...latest, mode });
    return isAutopilotMode(mode);
  }
  /** Drop cached state for a closed session. */
  forget(sessionId) {
    this.cache.delete(sessionId);
  }
}
function readRange(path, start, end) {
  const len = end - start;
  if (len <= 0) return "";
  const fd = node_fs.openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const read = node_fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, read);
  } finally {
    node_fs.closeSync(fd);
  }
}
class CopilotAutopilotWatcher {
  /** @param stateDir base dir for Copilot session state (override in tests). */
  constructor(stateDir = COPILOT_STATE_DIR) {
    this.stateDir = stateDir;
  }
  cache = /* @__PURE__ */ new Map();
  /** Current autopilot state for a Copilot session with the given agent UUID. */
  isAutopilot(sessionId, agentSessionId) {
    if (!agentSessionId) return false;
    const path = copilotEventsPath(agentSessionId, this.stateDir);
    let size;
    try {
      size = node_fs.statSync(path).size;
    } catch {
      return false;
    }
    const prev = this.cache.get(sessionId);
    if (!prev || prev.path !== path || size < prev.offset) {
      this.cache.set(sessionId, { path, offset: size, mode: "interactive" });
      return false;
    }
    if (size === prev.offset) return isCopilotAutopilotMode(prev.mode);
    const mode = latestCopilotMode(readRange(path, prev.offset, size)) ?? prev.mode;
    this.cache.set(sessionId, { path, offset: size, mode });
    return isCopilotAutopilotMode(mode);
  }
  /** Drop cached state for a closed session. */
  forget(sessionId) {
    this.cache.delete(sessionId);
  }
}
const ZSHENV = `# Crew shell integration (zsh) — chain to the user's real startup files.
CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zshenv" ] && source "$CREW_ZDOTDIR/.zshenv"
`;
const ZPROFILE = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zprofile" ] && source "$CREW_ZDOTDIR/.zprofile"
`;
const ZLOGIN = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zlogin" ] && source "$CREW_ZDOTDIR/.zlogin"
`;
const ZSHRC = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zshrc" ] && source "$CREW_ZDOTDIR/.zshrc"

# OSC 133 semantic prompt marks (interactive shells only).
if [[ -o interactive ]]; then
  __crew_osc() { printf '\\033]133;%s\\007' "$1" }
  __crew_precmd() { local __crew_e=$?; __crew_osc "D;\${__crew_e}"; __crew_osc "A" }
  __crew_preexec() { __crew_osc "C" }
  if autoload -Uz add-zsh-hook 2>/dev/null; then
    add-zsh-hook precmd __crew_precmd
    add-zsh-hook preexec __crew_preexec
  fi
fi

# Restore the user's ZDOTDIR so subshells and tools see the real value.
if [ "$CREW_ZDOTDIR" = "$HOME" ]; then
  unset ZDOTDIR
else
  export ZDOTDIR="$CREW_ZDOTDIR"
fi
`;
const BASHRC = `# Crew shell integration (bash) — sourced via \`bash --rcfile\`.
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

if [[ $- == *i* ]]; then
  __crew_osc() { printf '\\033]133;%s\\007' "$1"; }
  __crew_precmd() { local __crew_e=$?; __crew_osc "D;\${__crew_e}"; __crew_osc "A"; }
  case ";\${PROMPT_COMMAND};" in
    *";__crew_precmd;"*) ;;
    *) PROMPT_COMMAND="__crew_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
  __crew_preexec() {
    [ -n "$COMP_LINE" ] && return
    case "$BASH_COMMAND" in __crew_precmd|__crew_preexec) return ;; esac
    __crew_osc "C"
  }
  trap '__crew_preexec' DEBUG
fi
`;
function ensureCrewHookDir(userDataDir) {
  const dir = node_path.join(userDataDir, "crew-hook");
  try {
    node_fs.mkdirSync(dir, { recursive: true });
    node_fs.writeFileSync(node_path.join(dir, ".zshenv"), ZSHENV);
    node_fs.writeFileSync(node_path.join(dir, ".zprofile"), ZPROFILE);
    node_fs.writeFileSync(node_path.join(dir, ".zlogin"), ZLOGIN);
    node_fs.writeFileSync(node_path.join(dir, ".zshrc"), ZSHRC);
    node_fs.writeFileSync(node_path.join(dir, "crew-hook.bash"), BASHRC);
  } catch {
  }
  return dir;
}
function crewHookFor(command, hookDir) {
  const shell = node_path.basename(command).replace(/^-/, "").toLowerCase();
  if (shell === "zsh") {
    return { env: { ZDOTDIR: hookDir, CREW_ZDOTDIR: process.env.ZDOTDIR || node_os.homedir() } };
  }
  if (shell === "bash") {
    return { extraArgs: ["--rcfile", node_path.join(hookDir, "crew-hook.bash")] };
  }
  return null;
}
const TICK_MS = 250;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const EVENT_CAP = 2e3;
const AUTOPILOT_POLL_TICKS = 4;
const RESTORE_BATCH = 4;
const RESTORE_BATCH_GAP_MS = 400;
const OUTPUT_FLUSH_MS = 40;
const PENDING_CAP = 512 * 1024;
class SessionManager extends node_events.EventEmitter {
  constructor(store2, recorder2, crewHookDir) {
    super();
    this.store = store2;
    this.recorder = recorder2;
    this.crewHookDir = crewHookDir;
  }
  sessions = /* @__PURE__ */ new Map();
  timer = null;
  events = [];
  // Coalesces cost-driven roster updates into the tick loop (max ~4/s).
  rosterDirty = false;
  // Set when session metadata that must survive restart changes (e.g. a prompt
  // stamps lastPromptAt); flushed to disk on the tick so we don't writeFile on
  // every keystroke.
  persistDirty = false;
  // Detects autopilot from each agent's own state: Claude Code's acceptEdits from
  // its transcript; Copilot's "autopilot" mode from its session event log.
  autopilot = new AutopilotWatcher();
  copilotAutopilot = new CopilotAutopilotWatcher();
  autopilotTick = 0;
  // Set during shutdown so PTY exit handlers don't overwrite the saved session
  // list with an empty one (which would defeat resume-on-next-launch).
  disposing = false;
  // Pending batches from restore(), so shutdown can cancel them instead of
  // spawning agents into a tearing-down app.
  restoreTimers = /* @__PURE__ */ new Set();
  // Saved sessions that restore() has not spawned yet. They are NOT in
  // `sessions` and so would be invisible to persistSessions() — which saves the
  // live map — and a save triggered mid-restore (or a quit before the last
  // batch lands) would silently prune them from the roster for good.
  pendingRestore = [];
  /** Per-session output waiting to be sent to the renderer (see OUTPUT_FLUSH_MS). */
  pendingOutput = /* @__PURE__ */ new Map();
  flushTimer = null;
  roster() {
    return [...this.sessions.values()].map((m) => ({ ...m.info }));
  }
  create(req, restore) {
    const preset = getPreset(req.presetId);
    const command = req.command || preset?.command || defaultShell();
    const args = req.args && req.args.length ? req.args : preset?.args ?? [];
    const cwd = req.cwd || node_os.homedir() || process.cwd();
    const id = restore?.id ?? node_crypto.randomUUID();
    const agentSessionId = restore?.agentSessionId ?? node_crypto.randomUUID();
    const now = Date.now();
    const key = identityKey(req.presetId, cwd);
    const usedChars = [...this.sessions.values()].filter((m) => m.info.status === "active").map((m) => m.info.characterId);
    const saved = this.store.getAssignment(key);
    const requested = restore?.characterId;
    const characterId = isCharacterId(requested) ? requested : pickCharacter(usedChars, saved?.characterId);
    const color = restore?.color ?? randomCharacterColor();
    const sets = normalizeSetNames(restore?.sets ?? req.sets ?? []);
    if (sets.length) this.store.ensureSets(sets);
    const base = node_path.basename(cwd) || "session";
    const label = req.label?.trim() || saved?.lastLabel || `${preset ? preset.name + " · " : ""}${base}`;
    const info = {
      id,
      label,
      characterId,
      color,
      presetId: req.presetId,
      command,
      args,
      agentSessionId,
      priorSessionId: restore?.priorSessionId,
      cwd,
      state: "STARTING",
      status: "active",
      pid: null,
      exitCode: null,
      costUsd: 0,
      creditsUsed: 0,
      autopilot: false,
      tag: restore?.tag ?? (req.tag && req.tag.trim() ? req.tag.trim() : void 0),
      sets,
      workspaceIds: restore?.workspaceIds ?? req.workspaceIds ?? [],
      description: restore?.description,
      createdAt: restore?.createdAt ?? now,
      stateChangedAt: now,
      lastPromptAt: restore?.lastPromptAt ?? now
    };
    const cfg = {
      quietMs: preset?.quietMs ?? DEFAULT_DETECTION.quietMs,
      confirmMs: preset?.confirmMs ?? DEFAULT_DETECTION.confirmMs,
      inputGraceMs: preset?.inputGraceMs ?? DEFAULT_DETECTION.inputGraceMs,
      assumeWaitingAfterMs: preset?.assumeWaitingAfterMs === void 0 ? DEFAULT_DETECTION.assumeWaitingAfterMs : preset.assumeWaitingAfterMs,
      promptRegex: compileRegex(preset?.promptRegex),
      approvalRegex: compileRegex(preset?.approvalRegex),
      spinnerRegex: DEFAULT_DETECTION.spinnerRegex
    };
    const cost = new CostParser({ costRegex: compileRegex(preset?.costRegex ?? DEFAULT_COST_REGEX_SRC) });
    const credits = new CostParser({ costRegex: compileRegex(DEFAULT_CREDITS_REGEX_SRC) });
    let proc;
    try {
      let idArgs = [];
      let resumeExtra = restore?.extraArgs ?? [];
      if (preset?.sessionIdFlag && (restore?.agentSessionId || !restore)) {
        idArgs = [preset.sessionIdFlag + agentSessionId];
        resumeExtra = [];
      }
      const hook = this.store.settings.enhancedTerminal && req.presetId === "shell" && this.crewHookDir ? crewHookFor(command, this.crewHookDir) : null;
      const spawnArgs = [...args, ...idArgs, ...resumeExtra, ...hook?.extraArgs ?? []];
      proc = pty__namespace.spawn(command, spawnArgs, {
        name: "xterm-256color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env, TERM: "xterm-256color", ...hook?.env ?? {} }
      });
    } catch (err) {
      info.state = "ERROR";
      info.status = "error";
      info.exitCode = 127;
      info.errorMessage = `Failed to launch ${command} in ${cwd}: ${err instanceof Error ? err.message : String(err)}`;
      this.sessions.set(id, { info, proc: null, detector: null, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
      this.store.setAssignment(key, { characterId, lastLabel: label });
      this.emitRoster();
      const message = err instanceof Error ? err.message : String(err);
      this.emit("output", { id, data: `\r
\x1B[31mFailed to launch \x1B[1m${command}\x1B[0m\x1B[31m: ${message}\x1B[0m\r
` });
      return { ...info };
    }
    info.pid = proc.pid;
    const detector = new StateDetector(now, cfg, (state, reason) => this.onState(id, state, reason));
    const managed = { info, proc, detector, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const brief = briefPathFor(restore?.priorSessionId);
    if (brief) managed.pendingPrimer = primerFor(brief);
    this.sessions.set(id, managed);
    this.store.setAssignment(key, { characterId, lastLabel: label });
    proc.onData((data) => {
      if (!this.sessions.has(id)) return;
      this.bufferOutput(id, data);
      managed.detector?.pushOutput(data, Date.now());
      const clean = stripAnsi(data);
      if (this.recorder && this.store.settings.captureTranscripts) this.recorder.append(id, clean);
      if (managed.cost.push(clean)) {
        managed.info.costUsd = managed.cost.usd;
        this.rosterDirty = true;
      }
      if (managed.credits.push(clean)) {
        managed.info.creditsUsed = managed.credits.value;
        this.rosterDirty = true;
      }
      const url = detectDevUrl(clean);
      if (url && url !== managed.info.appUrl) {
        managed.info.appUrl = url;
        this.rosterDirty = true;
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      const errored = Boolean(exitCode) || Boolean(signal);
      managed.info.exitCode = exitCode;
      managed.info.status = errored ? "error" : "exited";
      if (errored && !managed.info.errorMessage) {
        managed.info.errorMessage = signal ? `${managed.info.command} was terminated by signal ${signal}` : `${managed.info.command} exited with code ${exitCode}`;
      }
      managed.detector?.markExited(errored ? exitCode || 1 : 0);
      this.stopTimerIfIdle();
      this.persistSessions();
    });
    if (req.initialPrompt && req.initialPrompt.length) {
      const text = req.initialPrompt;
      setTimeout(() => {
        try {
          proc.write(text.endsWith("\n") ? text : text + "\r");
        } catch {
        }
      }, 700);
    }
    this.ensureTimer();
    this.emitRoster();
    this.persistSessions();
    return { ...info };
  }
  input(id, data) {
    const m = this.sessions.get(id);
    if (!m || !m.proc) return;
    try {
      m.proc.write(data);
    } catch {
    }
    m.detector?.notifyInput(Date.now());
    if (data.includes("\r") || data.includes("\n")) {
      m.info.lastPromptAt = Date.now();
      this.rosterDirty = true;
      this.persistDirty = true;
    }
  }
  setTag(id, tag) {
    const m = this.sessions.get(id);
    if (!m) return;
    const next = tag.trim() || void 0;
    if (m.info.tag === next) return;
    m.info.tag = next;
    this.sessions.delete(id);
    this.sessions.set(id, m);
    this.emitRoster();
    this.persistSessions();
  }
  /** Replace a session's workspace membership with `names` (deduped/validated). */
  setWorkspaces(id, names) {
    const m = this.sessions.get(id);
    if (!m) return;
    const sets = normalizeSetNames(names);
    m.info.sets = sets;
    if (sets.length) this.store.ensureSets(sets);
    this.emitRoster();
    this.persistSessions();
  }
  /** Add workspace `name` to every currently-active session (used when saving a
   *  snapshot set, so existing sessions become members of that workspace). */
  addWorkspaceToActive(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    for (const m of this.sessions.values()) {
      if (m.info.status !== "active") continue;
      m.info.sets = addToSets(m.info.sets, trimmed);
    }
    this.store.ensureSets([trimmed]);
    this.emitRoster();
    this.persistSessions();
  }
  /** Strip workspace `name` from every session's membership (used on set delete). */
  removeWorkspaceEverywhere(name) {
    for (const m of this.sessions.values()) {
      m.info.sets = removeFromSets(m.info.sets, name);
    }
    this.emitRoster();
    this.persistSessions();
  }
  // ── First-class workspace membership (by id) ──────────────────────────────
  /** Replace a session's workspace-id membership wholesale. */
  setWorkspaceIds(id, workspaceIds) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.workspaceIds = [...new Set(workspaceIds)];
    this.emitRoster();
    this.persistSessions();
  }
  /** Add a session to a workspace (non-destructive; keeps existing memberships). */
  addToWorkspace(id, wsId) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.workspaceIds = addMembership(m.info.workspaceIds, wsId);
    this.emitRoster();
    this.persistSessions();
  }
  /** Remove a session from a single workspace. */
  removeFromWorkspace(id, wsId) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId);
    this.emitRoster();
    this.persistSessions();
  }
  /** Move a session from one workspace to another (drop from, add to). */
  moveToWorkspace(id, fromId, toId) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.workspaceIds = moveMembership(m.info.workspaceIds, fromId, toId);
    this.emitRoster();
    this.persistSessions();
  }
  /** Archive a session: remove it from every workspace (keeps it running). */
  archiveSession(id) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.workspaceIds = [];
    this.emitRoster();
    this.persistSessions();
  }
  /** Set (or clear, when blank) a session's freeform description. */
  setDescription(id, description) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.description = description.trim() || void 0;
    this.emitRoster();
    this.persistSessions();
  }
  /** Strip a workspace id from every session's membership (on workspace delete). */
  removeWorkspaceFromAll(wsId) {
    for (const m of this.sessions.values()) {
      m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId);
    }
    this.emitRoster();
    this.persistSessions();
  }
  /** Spawn a fresh session reusing another's recipe, optionally into a workspace. */
  duplicateSession(id, wsId) {
    const m = this.sessions.get(id);
    if (!m) return null;
    const info = this.create({
      presetId: m.info.presetId,
      command: m.info.command,
      args: m.info.args,
      cwd: m.info.cwd,
      label: m.info.label,
      tag: m.info.tag,
      workspaceIds: wsId ? [wsId] : []
    });
    return info;
  }
  resize(id, cols, rows) {
    const m = this.sessions.get(id);
    if (!m || !m.proc) return;
    if (cols < 1 || rows < 1) return;
    m.cols = cols;
    m.rows = rows;
    try {
      m.proc.resize(cols, rows);
    } catch {
    }
  }
  rename(id, label) {
    const m = this.sessions.get(id);
    if (!m) return;
    m.info.label = label;
    this.store.setAssignment(identityKey(m.info.presetId, m.info.cwd), {
      characterId: m.info.characterId,
      lastLabel: label
    });
    this.emitRoster();
    this.persistSessions();
  }
  setCharacter(id, characterId) {
    const m = this.sessions.get(id);
    if (!m) return;
    if (!isCharacterId(characterId)) return;
    const previous = m.info.characterId;
    if (previous === characterId) return;
    const other = [...this.sessions.values()].find(
      (s) => s !== m && s.info.status === "active" && s.info.characterId === characterId
    );
    m.info.characterId = characterId;
    this.store.setAssignment(identityKey(m.info.presetId, m.info.cwd), {
      characterId,
      lastLabel: m.info.label
    });
    if (other) {
      other.info.characterId = previous;
      this.store.setAssignment(identityKey(other.info.presetId, other.info.cwd), {
        characterId: previous,
        lastLabel: other.info.label
      });
    }
    this.emitRoster();
    this.persistSessions();
  }
  setColor(id, color) {
    const m = this.sessions.get(id);
    if (!m) return;
    if (m.info.color === color) return;
    m.info.color = color;
    this.emitRoster();
    this.persistSessions();
  }
  /** Apply an explicit display order (drag-to-reorder). Unknown ids are ignored;
   * any existing sessions not listed are kept at the end. */
  reorder(orderedIds) {
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of orderedIds) {
      const m = this.sessions.get(id);
      if (m && !seen.has(id)) {
        ordered.push([id, m]);
        seen.add(id);
      }
    }
    for (const [id, m] of this.sessions) {
      if (!seen.has(id)) ordered.push([id, m]);
    }
    this.sessions.clear();
    for (const [id, m] of ordered) this.sessions.set(id, m);
    this.emitRoster();
    this.persistSessions();
  }
  close(id) {
    this.pendingRestore = this.pendingRestore.filter((p) => p.id !== id);
    this.pendingOutput.delete(id);
    const m = this.sessions.get(id);
    if (!m) return;
    if (m.proc) {
      try {
        m.proc.kill();
      } catch {
      }
    }
    this.sessions.delete(id);
    this.autopilot.forget(id);
    this.copilotAutopilot.forget(id);
    this.stopTimerIfIdle();
    this.emitRoster();
    this.persistSessions();
  }
  restart(id) {
    const m = this.sessions.get(id);
    if (!m) return null;
    const req = {
      presetId: m.info.presetId,
      command: m.info.command,
      args: m.info.args,
      cwd: m.info.cwd,
      label: m.info.label
    };
    const character = m.info.characterId;
    const color = m.info.color;
    const idx = [...this.sessions.keys()].indexOf(id);
    this.close(id);
    const info = this.create(req);
    this.setCharacter(info.id, character);
    this.setColor(info.id, color);
    if (idx >= 0) {
      const ids = [...this.sessions.keys()].filter((x) => x !== info.id);
      ids.splice(idx, 0, info.id);
      this.reorder(ids);
    }
    const healed = this.sessions.get(info.id);
    return healed ? { ...healed.info } : { ...info, color };
  }
  /**
   * Queue a session's output for the renderer instead of sending it immediately.
   * Keeps at most PENDING_CAP bytes per session, dropping the OLDEST first: a
   * session dumping megabytes (a resumed agent replaying its conversation) can
   * outrun any renderer, and what it ultimately displays is the tail.
   */
  bufferOutput(id, data) {
    let buf = this.pendingOutput.get(id);
    if (!buf) {
      buf = { parts: [], len: 0, dropped: false };
      this.pendingOutput.set(id, buf);
    }
    buf.parts.push(data);
    buf.len += data.length;
    while (buf.len > PENDING_CAP && buf.parts.length > 1) {
      buf.len -= buf.parts.shift().length;
      buf.dropped = true;
    }
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushOutput(), OUTPUT_FLUSH_MS);
    }
  }
  /** Send each session's buffered output as a single message, then idle. */
  flushOutput() {
    if (this.pendingOutput.size === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      return;
    }
    for (const [id, buf] of this.pendingOutput) {
      const data = buf.parts.join("");
      this.pendingOutput.delete(id);
      if (!data) continue;
      const notice = buf.dropped ? "\r\n\x1B[2m… earlier output trimmed …\x1B[0m\r\n" : "";
      this.emit("output", { id, data: notice + data });
    }
  }
  disposeAll() {
    this.persistSessions();
    this.disposing = true;
    for (const t of this.restoreTimers) clearTimeout(t);
    this.restoreTimers.clear();
    this.flushOutput();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const m of this.sessions.values()) {
      if (m.proc) {
        try {
          m.proc.kill();
        } catch {
        }
      }
    }
    this.sessions.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** Snapshot the current active sessions so they can be resumed next launch. */
  persistSessions() {
    if (this.disposing) return;
    const list2 = [...this.sessions.values()].map((m) => ({
      id: m.info.id,
      presetId: m.info.presetId,
      command: m.info.command,
      args: m.info.args,
      cwd: m.info.cwd,
      label: m.info.label,
      characterId: m.info.characterId,
      color: m.info.color,
      tag: m.info.tag,
      sets: m.info.sets,
      workspaceIds: m.info.workspaceIds,
      description: m.info.description,
      agentSessionId: m.info.agentSessionId,
      priorSessionId: m.info.priorSessionId,
      createdAt: m.info.createdAt,
      lastPromptAt: m.info.lastPromptAt
    }));
    const live = new Set(list2.map((s) => s.id));
    for (const p of this.pendingRestore) if (!live.has(p.id)) list2.push(p);
    this.store.saveSessions(list2);
  }
  /**
   * Decide how a saved session regains its context on relaunch.
   *
   * 'transcript' reattaches the original conversation, so the agent replays its
   * log. 'brief' deliberately does not: it starts a fresh agent and seeds it
   * with the distilled handoff instead, which is the only way a session whose
   * log has outgrown the context window can come back at all.
   *
   * Either way the original conversation id survives — as agentSessionId when
   * reattaching, as priorSessionId when superseding — so a relaunch can never
   * orphan a transcript. That matters even with resume switched off, where the
   * id used to be dropped and then overwritten by the next persist.
   */
  contextFor(agentSessionId, presetId) {
    return resolveContext({
      agentSessionId,
      resume: this.store.settings.resumeConversations,
      contextMode: this.store.settings.contextMode,
      resumeArgs: getPreset(presetId)?.resumeArgs
    });
  }
  /**
   * Re-launch the sessions saved from a previous run. A live agent process can't
   * literally be frozen, so this restores the workspace layout — same agent, cwd,
   * label and character — by spawning each session fresh. Call once on startup.
   *
   * Spawns in small batches rather than all at once. Every session brings up a
   * PTY that immediately streams its agent's boot output into its own terminal
   * engine; doing that for a whole roster in a single tick pegs the renderer and
   * makes the entire window flicker while it catches up — and the bigger the
   * roster, the longer it lasts. Batching keeps the UI responsive and lets the
   * roster fill in visibly instead of freezing until it's done.
   *
   * Returns the first batch synchronously; the rest arrive via roster events.
   */
  restore() {
    const persisted = this.store.getSessions();
    const first = persisted.slice(0, RESTORE_BATCH).map((p) => this.restoreOne(p));
    const rest = persisted.slice(RESTORE_BATCH);
    if (rest.length) {
      this.pendingRestore = [...rest];
      this.scheduleRestore(rest);
    }
    return first;
  }
  /** Spawn the next batch after a gap, then queue the one after it. */
  scheduleRestore(queue) {
    const timer = setTimeout(() => {
      this.restoreTimers.delete(timer);
      if (this.disposing) return;
      const batch = queue.slice(0, RESTORE_BATCH);
      for (const p of batch) {
        if (!this.pendingRestore.some((q) => q.id === p.id)) continue;
        try {
          this.restoreOne(p);
        } catch (err) {
          console.warn(
            `[crew] failed to restore session ${p.label}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      const done = new Set(batch.map((p) => p.id));
      this.pendingRestore = this.pendingRestore.filter((p) => !done.has(p.id));
      this.emitRoster();
      const rest = queue.slice(RESTORE_BATCH);
      if (rest.length) this.scheduleRestore(rest);
    }, RESTORE_BATCH_GAP_MS);
    this.restoreTimers.add(timer);
  }
  restoreOne(p) {
    const ctx = this.contextFor(p.agentSessionId ?? p.priorSessionId, p.presetId);
    return this.create(
      { presetId: p.presetId, command: p.command, args: p.args, cwd: p.cwd, label: p.label },
      {
        id: p.id,
        agentSessionId: ctx.agentSessionId,
        priorSessionId: ctx.priorSessionId,
        characterId: p.characterId,
        color: p.color ?? fallbackCharacterColor(p.id),
        extraArgs: ctx.extraArgs,
        tag: p.tag,
        sets: p.sets,
        workspaceIds: p.workspaceIds,
        description: p.description,
        createdAt: p.createdAt,
        lastPromptAt: p.lastPromptAt
      }
    );
  }
  /**
   * Re-launch a saved named set of sessions (see Store.sets). Like restore(),
   * this spawns each session fresh and applies the preset's resume args
   * (e.g. --continue) when conversation resume is enabled, so relaunching a set
   * genuinely resumes its agents rather than starting them cold.
   */
  launchSet(name) {
    const set = this.store.sets.find((s) => s.name === name);
    if (!set) return [];
    return set.sessions.map((d) => {
      const ctx = this.contextFor(d.agentSessionId, d.presetId);
      return this.create(
        { presetId: d.presetId, command: d.command, args: d.args, cwd: d.cwd, label: d.label },
        {
          id: d.id,
          agentSessionId: ctx.agentSessionId,
          priorSessionId: ctx.priorSessionId,
          characterId: d.characterId,
          color: d.color,
          extraArgs: ctx.extraArgs.length ? ctx.extraArgs : void 0,
          tag: d.tag,
          sets: d.sets
        }
      );
    });
  }
  onState(id, state, reason) {
    const m = this.sessions.get(id);
    if (!m) return;
    const from = m.info.state;
    const now = Date.now();
    m.info.state = state;
    m.info.stateChangedAt = now;
    if (reason) m.info.detectionReason = reason;
    if (m.pendingPrimer && (state === "WAITING_INPUT" || state === "IDLE")) {
      const primer = m.pendingPrimer;
      m.pendingPrimer = void 0;
      m.proc?.write(primer);
    }
    this.events.push({ id, ts: now, from, to: state });
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    const snapshot = { ...m.info };
    this.emit("state", snapshot);
    this.emitRoster();
    this.emit("transition", { session: snapshot, from, to: state });
  }
  getEvents() {
    return [...this.events];
  }
  emitRoster() {
    this.emit("roster", this.roster());
  }
  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const m of this.sessions.values()) m.detector?.tick(now);
      this.pollAutopilot();
      if (this.rosterDirty) {
        this.rosterDirty = false;
        this.emitRoster();
      }
      if (this.persistDirty) {
        this.persistDirty = false;
        this.persistSessions();
      }
    }, TICK_MS);
  }
  /** Refresh autopilot state for active agent sessions (throttled). */
  pollAutopilot() {
    this.autopilotTick = (this.autopilotTick + 1) % AUTOPILOT_POLL_TICKS;
    if (this.autopilotTick !== 0) return;
    for (const m of this.sessions.values()) {
      if (m.info.status !== "active") continue;
      let on;
      if (isClaudeSession(m.info)) {
        on = this.autopilot.isAutopilot(m.info.id, m.info.cwd);
      } else if (isCopilotSession(m.info)) {
        on = this.copilotAutopilot.isAutopilot(m.info.id, m.info.agentSessionId);
      } else {
        continue;
      }
      if (on !== m.info.autopilot) {
        m.info.autopilot = on;
        this.rosterDirty = true;
      }
    }
  }
  stopTimerIfIdle() {
    const anyActive = [...this.sessions.values()].some((m) => m.info.status === "active");
    if (!anyActive && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
function compileRegex(src) {
  if (!src) return null;
  try {
    return new RegExp(src, "m");
  } catch {
    return null;
  }
}
const EXT_KIND = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  html: "html",
  htm: "html",
  pdf: "pdf",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  md: "text",
  markdown: "text",
  txt: "text"
};
const EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8"
};
function assetExt(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
function assetKind(name) {
  return EXT_KIND[assetExt(name)] ?? null;
}
function assetMime(name) {
  return EXT_MIME[assetExt(name)] ?? "application/octet-stream";
}
const BUILD_OUTPUT_DIRS = /* @__PURE__ */ new Set(["dist", "build", "out", "coverage", "target", "vendor"]);
const HARD_IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "venv",
  "__pycache__",
  "Library",
  "Applications"
]);
function isIgnoredDir(name) {
  return name.startsWith(".") || HARD_IGNORED_DIRS.has(name) || BUILD_OUTPUT_DIRS.has(name);
}
function isHardIgnoredDir(name) {
  return name.startsWith(".") || HARD_IGNORED_DIRS.has(name);
}
function isIgnoredRelPath(rel) {
  const segs = rel.split(/[\\/]/);
  for (let i = 0; i < segs.length - 1; i++) {
    if (isHardIgnoredDir(segs[i])) return true;
  }
  const base = segs[segs.length - 1];
  return base.startsWith(".");
}
const MAX_ITEMS = 60;
const SCAN_MAX_DIRS = 800;
const SCAN_MAX_DEPTH = 4;
const EMIT_DEBOUNCE_MS = 250;
class AssetWatchers {
  constructor(onChange) {
    this.onChange = onChange;
  }
  byId = /* @__PURE__ */ new Map();
  /** Reconcile watchers with the current roster (call on every roster event). */
  sync(roster) {
    const wanted = new Map(roster.map((s) => [s.id, s.cwd]));
    for (const id of [...this.byId.keys()]) {
      if (!wanted.has(id)) this.remove(id);
    }
    for (const [id, cwd] of wanted) {
      if (!this.byId.has(id)) this.add(id, cwd);
    }
  }
  /** Newest-first asset list for a session. */
  list(id) {
    const w = this.byId.get(id);
    if (!w) return [];
    return [...w.items.values()].sort((a, b) => b.mtime - a.mtime);
  }
  /** Is this absolute path a currently-known asset? (crew-asset:// allowlist) */
  has(path) {
    for (const w of this.byId.values()) {
      if (w.items.has(path)) return true;
    }
    return false;
  }
  /** The watched cwd for a session (for resolving relative path tokens). */
  cwdOf(id) {
    return this.byId.get(id)?.cwd ?? null;
  }
  /**
   * Explicitly add one file (e.g. a path the agent printed and the user
   * clicked) to a session's asset list — even outside the scan depth or cwd.
   * Returns the item, or null if the file is missing or not previewable.
   */
  async pin(id, absPath) {
    const w = this.byId.get(id);
    if (!w || !assetKind(absPath)) return null;
    try {
      const st = await promises.stat(absPath);
      if (!st.isFile()) return null;
      let rel = node_path.relative(w.cwd, absPath).split(node_path.sep).join("/");
      if (rel.startsWith("..")) rel = absPath;
      this.upsert(w, absPath, rel, st.size, st.mtimeMs);
      this.scheduleEmit(id, w);
      return w.items.get(absPath) ?? null;
    } catch {
      return null;
    }
  }
  disposeAll() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }
  add(id, cwd) {
    const w = { cwd, watcher: null, items: /* @__PURE__ */ new Map(), timer: null, disposed: false };
    this.byId.set(id, w);
    try {
      w.watcher = node_fs.watch(cwd, { recursive: true }, (_event, filename) => {
        if (!filename || w.disposed) return;
        const rel = filename.toString();
        if (isIgnoredRelPath(rel) || !assetKind(rel)) return;
        void this.refreshOne(id, w, rel);
      });
      w.watcher.on("error", () => {
      });
    } catch {
    }
    void this.scan(id, w);
  }
  remove(id) {
    const w = this.byId.get(id);
    if (!w) return;
    w.disposed = true;
    if (w.timer) clearTimeout(w.timer);
    try {
      w.watcher?.close();
    } catch {
    }
    this.byId.delete(id);
  }
  /** Stat one changed file and upsert/remove it, then emit (debounced). */
  async refreshOne(id, w, rel) {
    const abs = node_path.join(w.cwd, rel);
    try {
      const st = await promises.stat(abs);
      if (!st.isFile()) return;
      this.upsert(w, abs, rel, st.size, st.mtimeMs);
    } catch {
      if (!w.items.delete(abs)) return;
    }
    this.scheduleEmit(id, w);
  }
  /** Bounded BFS over cwd for existing assets (newest MAX_ITEMS win). */
  async scan(id, w) {
    const queue = [
      { dir: w.cwd, rel: "", depth: 0 }
    ];
    let dirs = 0;
    while (queue.length > 0 && dirs < SCAN_MAX_DIRS) {
      const { dir, rel, depth } = queue.shift();
      if (w.disposed) return;
      dirs++;
      let entries;
      try {
        entries = await promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (depth < SCAN_MAX_DEPTH && !isIgnoredDir(e.name)) {
            queue.push({ dir: node_path.join(dir, e.name), rel: rel ? rel + "/" + e.name : e.name, depth: depth + 1 });
          }
        } else if (e.isFile() && !e.name.startsWith(".") && assetKind(e.name)) {
          const abs = node_path.join(dir, e.name);
          try {
            const st = await promises.stat(abs);
            this.upsert(w, abs, rel ? rel + "/" + e.name : e.name, st.size, st.mtimeMs);
          } catch {
          }
        }
      }
    }
    if (!w.disposed && w.items.size > 0) this.scheduleEmit(id, w);
  }
  upsert(w, abs, rel, size, mtime) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const relDir = rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
    const kind = assetKind(name);
    if (!kind) return;
    w.items.set(abs, {
      path: abs,
      name,
      relDir,
      ext: name.slice(name.lastIndexOf(".") + 1).toLowerCase(),
      kind,
      size,
      mtime
    });
    if (w.items.size > MAX_ITEMS) {
      const sorted = [...w.items.values()].sort((a, b) => b.mtime - a.mtime);
      for (const item of sorted.slice(MAX_ITEMS)) w.items.delete(item.path);
    }
  }
  scheduleEmit(id, w) {
    if (w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = null;
      if (!w.disposed) this.onChange(id, this.list(id));
    }, EMIT_DEBOUNCE_MS);
  }
}
const ICON_B64 = "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAdklEQVR4nMWVSw7AIAhEPTa3b/dmPqVMLQkbxTeiImv9aEV8DLyItwUc8JWAgj6Zk2C0oLYYJELBDNrJDsaXgaoxClbKaPE+T3ftwOiy2mAHdXHnwZ8dRfTyUDqR58aUIwWi4KOSZruIfEIOfuRfjnWSWGsa2Q2gcsWV6PXr7AAAAABJRU5ErkJggg==";
function buildTrayIcon() {
  const img = electron.nativeImage.createFromDataURL("data:image/png;base64," + ICON_B64);
  if (isMac) {
    img.setTemplateImage(true);
    return img;
  }
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  for (let i = 0; i < bmp.length; i += 4) {
    bmp[i] = 255;
    bmp[i + 1] = 255;
    bmp[i + 2] = 255;
  }
  return electron.nativeImage.createFromBitmap(bmp, { width, height });
}
const STATE_LABEL = {
  STARTING: "starting",
  WORKING: "working",
  WAITING_INPUT: "waiting for you",
  WAITING_APPROVAL: "needs approval",
  IDLE: "idle",
  EXITED: "exited",
  ERROR: "error"
};
class CrewTray {
  constructor(cb) {
    this.cb = cb;
    this.tray = new electron.Tray(buildTrayIcon());
    this.tray.setToolTip("Crew");
    this.tray.on("click", () => this.cb.onShow());
    this.update([]);
  }
  tray;
  destroyed = false;
  update(roster) {
    if (this.destroyed || this.tray.isDestroyed()) return;
    const active = roster.filter((s) => s.status === "active");
    const waiting = active.filter((s) => NEEDS_YOU.includes(s.state));
    const onlyApprovals = waiting.length > 0 && waiting.every((s) => s.state === "WAITING_APPROVAL");
    const working = active.filter((s) => s.state === "WORKING");
    if (waiting.length > 0) {
      this.tray.setTitle(`${onlyApprovals ? "🟠" : "🔴"} ${waiting.length}`);
    } else if (working.length > 0) {
      this.tray.setTitle("🟢");
    } else {
      this.tray.setTitle("");
    }
    this.tray.setToolTip(
      waiting.length > 0 ? `Crew — ${waiting.length} need${waiting.length > 1 ? "" : "s"} you` : working.length > 0 ? `Crew — ${working.length} working` : "Crew"
    );
    this.tray.setContextMenu(this.buildMenu(active, waiting));
  }
  notify(session, silent = false) {
    if (this.destroyed) return;
    if (!electron.Notification.isSupported()) return;
    const ch = getCharacter(session.characterId);
    const n = new electron.Notification({
      title: `${ch?.glyph ?? "●"}  ${session.label}`,
      body: session.state === "WAITING_APPROVAL" ? "needs your approval" : "needs your input",
      silent
    });
    n.on("click", () => this.cb.onJump(session.id));
    n.show();
  }
  destroy() {
    this.destroyed = true;
    this.tray.destroy();
  }
  buildMenu(active, waiting) {
    const items = [
      { label: "＋  New Session", click: () => this.cb.onNewSession() },
      { label: "⧉  New Window", click: () => this.cb.onNewWindow() },
      { type: "separator" }
    ];
    if (waiting.length > 0) {
      items.push({ label: "Needs you", enabled: false });
      for (const s of waiting) {
        const ch = getCharacter(s.characterId);
        items.push({
          label: `${ch?.glyph ?? "●"}  ${s.label} — ${STATE_LABEL[s.state]}`,
          click: () => this.cb.onJump(s.id)
        });
      }
      items.push({ type: "separator" });
    }
    const others = active.filter((s) => !waiting.includes(s));
    if (others.length > 0) {
      items.push({ label: "Sessions", enabled: false });
      for (const s of others) {
        const ch = getCharacter(s.characterId);
        items.push({
          label: `${ch?.glyph ?? "●"}  ${s.label} — ${STATE_LABEL[s.state]}`,
          click: () => this.cb.onJump(s.id)
        });
      }
      items.push({ type: "separator" });
    }
    items.push(
      { label: "Show Crew", click: () => this.cb.onShow() },
      { label: "Quit Crew", click: () => this.cb.onQuit() }
    );
    return electron.Menu.buildFromTemplate(items);
  }
}
const FLUSH_MS = 1500;
const MAX_MATCHES = 300;
class TranscriptRecorder {
  constructor(dir) {
    this.dir = dir;
    try {
      node_fs.mkdirSync(dir, { recursive: true });
    } catch {
    }
  }
  buffers = /* @__PURE__ */ new Map();
  timer = null;
  append(id, text) {
    if (!text) return;
    this.buffers.set(id, (this.buffers.get(id) ?? "") + text);
    if (!this.timer) this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }
  flush() {
    for (const [id, text] of this.buffers) {
      if (!text) continue;
      try {
        node_fs.appendFileSync(node_path.join(this.dir, `${id}.log`), text);
      } catch {
      }
      this.buffers.set(id, "");
    }
  }
  read(id) {
    this.flush();
    try {
      return node_fs.readFileSync(node_path.join(this.dir, `${id}.log`), "utf8");
    } catch {
      return "";
    }
  }
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    this.flush();
    const out = [];
    let files = [];
    try {
      files = node_fs.readdirSync(this.dir).filter((f) => f.endsWith(".log"));
    } catch {
      return [];
    }
    for (const f of files) {
      const id = f.slice(0, -4);
      let lines = [];
      try {
        lines = node_fs.readFileSync(node_path.join(this.dir, f), "utf8").split("\n");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          out.push({ sessionId: id, lineNo: i + 1, line: lines[i].slice(0, 300).trim() });
          if (out.length >= MAX_MATCHES) return out;
        }
      }
    }
    return out;
  }
  dispose() {
    this.flush();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
function skillsLocation(agent) {
  const a = (agent || "").toLowerCase();
  if (a.includes("claude")) return { dir: node_path.join(node_os.homedir(), ".claude", "skills"), source: "claude" };
  if (a.includes("copilot") || a === "") return { dir: node_path.join(node_os.homedir(), ".copilot", "skills"), source: "copilot" };
  return { dir: node_path.join(node_os.homedir(), ".copilot", "skills"), source: "copilot" };
}
function readHead(file, bytes = 8192) {
  const fd = node_fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = node_fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    node_fs.closeSync(fd);
  }
}
function frontmatter(md) {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  const fm = end === -1 ? md.slice(3) : md.slice(3, end);
  const lines = fm.split("\n");
  const nameLine = lines.find((l) => /^name:/.test(l));
  const name = nameLine ? nameLine.replace(/^name:\s*/, "").trim().replace(/^["']|["']$/g, "") : void 0;
  let description = "";
  const descIdx = lines.findIndex((l) => /^description:/.test(l));
  if (descIdx >= 0) {
    const inline = lines[descIdx].replace(/^description:\s*/, "").trim();
    if (inline && inline !== "|" && inline !== ">" && !inline.startsWith("|") && !inline.startsWith(">")) {
      description = inline;
    } else {
      const buf = [];
      for (let i = descIdx + 1; i < lines.length; i++) {
        if (/^\s+\S/.test(lines[i])) buf.push(lines[i].trim());
        else if (lines[i].trim() === "") continue;
        else break;
      }
      description = buf.join(" ");
    }
  }
  return { name, description: shorten(description) };
}
function shorten(raw, max = 160) {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const dot = clean.indexOf(". ");
  let s = dot > 20 && dot < max ? clean.slice(0, dot + 1) : clean;
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}
function listInstalledSkills(agent) {
  const loc = skillsLocation(agent);
  if (!loc) return [];
  let entries;
  try {
    entries = node_fs.readdirSync(loc.dir);
  } catch {
    return [];
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const dir = node_path.join(loc.dir, entry);
    const md = node_path.join(dir, "SKILL.md");
    let head;
    try {
      if (!node_fs.statSync(dir).isDirectory()) continue;
      head = readHead(md);
    } catch {
      continue;
    }
    const { name, description } = frontmatter(head);
    const skillName = (name || entry).trim();
    if (!skillName || seen.has(skillName)) continue;
    seen.add(skillName);
    out.push({ id: `${loc.source}:${skillName}`, name: skillName, description: description || "", source: loc.source });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function githubUrlFrom(raw) {
  if (!raw) return null;
  let u = raw.trim();
  if (u.startsWith("git@")) u = u.replace(":", "/").replace("git@", "https://");
  u = u.replace(/\.git$/, "");
  return u.startsWith("http") ? u : null;
}
function isGithubUrl(url) {
  return !!url && /^https?:\/\/(www\.)?github\.com\//i.test(url);
}
const HOME = node_os.homedir();
const SESSION_STATE_DIR$1 = node_path.join(HOME, ".copilot", "session-state");
const TAG_ORDER = ["work", "tools", "crew", "game", "games", "other"];
const TAG_META = {
  work: { label: "Work", blurb: "Shipping for the PowerPoint Copilot motion" },
  tools: { label: "Tools", blurb: "Internal tools & creator utilities" },
  crew: { label: "Crew", blurb: "The agent mission-control app & its assets" },
  game: { label: "Games", blurb: "Side games & interactive experiments" },
  games: { label: "Games", blurb: "Side games & interactive experiments" },
  other: { label: "Other", blurb: "Personal projects & everything else" }
};
function git(args, cwd) {
  return new Promise((resolve) => {
    node_child_process.execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5e3, killSignal: "SIGKILL" },
      (err, stdout) => resolve(err ? "" : String(stdout).trim())
    );
  });
}
function sqlite3Json$2(dbPath, query) {
  return new Promise((resolve) => {
    const uri = `file:${dbPath}?mode=ro`;
    const attempt = (bin, fallback) => {
      node_child_process.execFile(
        bin,
        ["-json", uri, query],
        { encoding: "utf8", timeout: 4e3, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout) => {
          if (err) {
            if (fallback) fallback();
            else resolve([]);
            return;
          }
          try {
            const j = JSON.parse(String(stdout || "[]"));
            resolve(Array.isArray(j) ? j : []);
          } catch {
            resolve([]);
          }
        }
      );
    };
    attempt("/usr/bin/sqlite3", () => attempt("sqlite3", null));
  });
}
async function getAgentTodos(agentSessionId) {
  if (!agentSessionId) return [];
  const db = node_path.join(SESSION_STATE_DIR$1, agentSessionId, "session.db");
  if (!await exists$2(db)) return [];
  const rows = await sqlite3Json$2(
    db,
    "SELECT title FROM todos WHERE status != 'done' ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 8"
  );
  const out = [];
  for (const r of rows) {
    const title = typeof r.title === "string" ? r.title.trim().replace(/\s+/g, " ") : "";
    if (title.length > 2 && !out.some((s) => s.text === title)) out.push({ text: title, source: "session tasks" });
  }
  return out;
}
async function readJSON(p) {
  try {
    return JSON.parse(await promises.readFile(p, "utf8"));
  } catch {
    return null;
  }
}
async function readText(p) {
  try {
    return await promises.readFile(p, "utf8");
  } catch {
    return "";
  }
}
async function listDir(p) {
  try {
    return await promises.readdir(p);
  } catch {
    return [];
  }
}
async function exists$2(p) {
  try {
    await promises.access(p);
    return true;
  } catch {
    return false;
  }
}
function findFile(entries, dir, names) {
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return node_path.join(dir, hit);
  }
  return null;
}
function relTime(ms) {
  if (!ms) return null;
  const d = Math.floor((Date.now() - ms) / 1e3);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  const days = Math.floor(d / 86400);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
function displayDir(cwd) {
  return cwd.startsWith(HOME + "/") ? cwd.slice(HOME.length + 1) : cwd === HOME ? "~" : cwd;
}
const BUMP_RE = /(bump|release|v?\d+\.\d+\.\d+|changelog)/i;
const COMMIT_CACHE_N = 12;
const FRESH_MS = 15e3;
const commitCache = /* @__PURE__ */ new Map();
async function fetchRawCommits(cwd) {
  const cached = commitCache.get(cwd);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.commits;
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (cached && head && cached.head === head) {
    cached.at = Date.now();
    return cached.commits;
  }
  const raw = await git(["log", `-n${COMMIT_CACHE_N}`, "--no-merges", "--pretty=format:%H%s%cI%an"], cwd);
  const commits = raw ? raw.split("\n").map((line) => {
    const [sha, subject, iso, author] = line.split("");
    return {
      sha: (sha || "").slice(0, 7),
      subject: subject || "",
      iso: iso || null,
      author: author || null,
      isRelease: BUMP_RE.test(subject || "")
    };
  }) : [];
  commitCache.set(cwd, { head, at: Date.now(), commits });
  return commits;
}
async function getCommits(cwd) {
  const raw = await fetchRawCommits(cwd);
  return raw.map((c) => ({
    sha: c.sha,
    subject: c.subject,
    date: c.iso,
    when: relTime(c.iso ? Date.parse(c.iso) : 0),
    author: c.author,
    isRelease: c.isRelease
  }));
}
function originOf(github) {
  if (!github) return null;
  if (/github\.com\/alexselig[-_]microsoft\//i.test(github)) return "work";
  if (/github\.com\/alexselig\//i.test(github)) return "personal";
  return "external";
}
async function getChangelog(entries, cwd) {
  const p = findFile(entries, cwd, ["CHANGELOG.md", "CHANGELOG", "changelog.md"]);
  if (!p) return [];
  const text = await readText(p);
  if (!text) return [];
  const sections = [];
  let cur = null;
  const head = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/i;
  for (const line of text.split("\n")) {
    const m = line.match(head);
    if (m) {
      if (cur) sections.push(cur);
      cur = { version: `v${m[1]}`, items: [] };
      continue;
    }
    if (cur) {
      const im = line.match(/^\s*[-*]\s+(.*\S)/);
      if (im && cur.items.length < 8) cur.items.push(im[1].replace(/\*\*/g, ""));
    }
  }
  if (cur) sections.push(cur);
  return sections.slice(0, 6);
}
const TASK_FILES = ["TODO.md", "TODO", "STATUS.md", ".crew-progress.md", "ROADMAP.md", "NEXT.md", "TASKS.md", "PLAN.md"];
const SECTION_RE = /^#{1,6}\s*(next steps?|to ?do|todo|roadmap|remaining|up next|what'?s (next|left)|open (tasks|items)|backlog|phases?|milestones?|in[-\s]?progress|upcoming)\b/i;
async function getOpenTasks(entries, cwd) {
  const steps = [];
  const pushItem = (text, source) => {
    const t = text.trim().replace(/\*\*/g, "").replace(/`/g, "");
    if (/^(✅|✔️?|✓|☑️?|~~|\[x\])/i.test(t)) return;
    if (t && t.length > 2 && steps.length < 8 && !steps.some((s) => s.text === t)) {
      steps.push({ text: t, source });
    }
  };
  for (const fname of TASK_FILES) {
    const p = findFile(entries, cwd, [fname]);
    if (!p) continue;
    const src = node_path.basename(p);
    let inSec = false;
    for (const line of (await readText(p)).split("\n")) {
      const cb = line.match(/^\s*[-*]\s*\[ \]\s+(.*\S)/);
      if (cb) {
        pushItem(cb[1], src);
      } else if (/^#{1,6}\s/.test(line)) {
        inSec = SECTION_RE.test(line);
      } else if (inSec) {
        const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)/);
        if (m && !/^\[[ x]\]/i.test(m[1])) pushItem(m[1], src);
      }
      if (steps.length >= 8) break;
    }
    if (steps.length >= 8) break;
  }
  return steps;
}
async function countCodeMarkers(cwd, isGit) {
  if (!isGit) return 0;
  const out = await git(["grep", "-I", "-c", "-E", "TODO|FIXME|HACK"], cwd);
  if (!out) return 0;
  let n = 0;
  for (const line of out.split("\n")) {
    const m = line.match(/:(\d+)$/);
    if (m) n += Number(m[1]);
  }
  return n;
}
async function getProposedSteps(cwd, stats, ctx) {
  const s = [];
  const add = (priority, text) => {
    s.push({ priority, text });
  };
  const fw = ctx.launch.framework;
  const deployable = ctx.launch.opensUrl;
  if (stats.uncommitted > 0) add(1, `Commit or stash ${stats.uncommitted} uncommitted change${stats.uncommitted > 1 ? "s" : ""}`);
  if (!stats.isGit && !stats.specOnly) add(1, "Put it under version control — git init & push to GitHub");
  if (stats.ahead > 0) add(2, `Push ${stats.ahead} unpushed commit${stats.ahead > 1 ? "s" : ""} to GitHub`);
  if (stats.specOnly) add(2, "Start implementation — this is spec/plan-only so far");
  if (!ctx.github && stats.isGit && !stats.specOnly) add(3, "Add a GitHub remote so the code is backed up");
  if (!stats.hasTests && stats.isNode) add(4, "Add automated tests (no test setup detected)");
  if (!ctx.live && deployable && stats.isGit) add(4, "Deploy it so you have a shareable live link");
  if (!ctx.live && fw === "static" && stats.isGit) add(4, "Publish via GitHub Pages for a live link");
  if (!stats.hasReadme && !stats.specOnly) add(5, "Write a README describing what it does & how to run it");
  const markers = await countCodeMarkers(cwd, stats.isGit);
  if (markers > 0) add(5, `Resolve ${markers} TODO/FIXME marker${markers > 1 ? "s" : ""} left in the code`);
  if (stats.isNode && stats.isGit && !stats.hasTag && stats.commitCount > 8) add(6, "Tag a release (git tag) to snapshot this version");
  if (!stats.hasChangelog && stats.commitCount > 15 && stats.isNode) add(6, "Start a CHANGELOG to track what ships each release");
  if (stats.daysSinceCommit != null && stats.daysSinceCommit > 14) add(7, `Revisit — no commits in ${stats.daysSinceCommit} days`);
  if (stats.isNode && !stats.hasLicense && ctx.github && /github\.com\/[^/]+\/[^/]+$/.test(ctx.github)) add(8, "Add a LICENSE file");
  return s.sort((a, b) => a.priority - b.priority).slice(0, 3).map((x) => ({ text: x.text, source: "suggested" }));
}
async function projectStats(entries, cwd, pkg) {
  const isGit = await exists$2(node_path.join(cwd, ".git"));
  const [lastCommitIso, commitCountRaw, weekRaw, porcelain, aheadRaw, tag] = isGit ? await Promise.all([
    git(["log", "-1", "--pretty=format:%cI"], cwd),
    git(["rev-list", "--count", "HEAD"], cwd),
    git(["rev-list", "--count", "--since=7 days ago", "HEAD"], cwd),
    git(["status", "--porcelain"], cwd),
    git(["rev-list", "--count", "@{u}..HEAD"], cwd),
    git(["describe", "--tags", "--abbrev=0"], cwd)
  ]) : ["", "", "", "", "", ""];
  const scripts = pkg?.scripts || {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const hasTests = !!(scripts.test && !/no test specified/i.test(scripts.test)) || entries.includes("test") || entries.includes("tests") || entries.includes("__tests__") || !!deps.vitest || !!deps.jest || !!deps.mocha || !!deps.playwright;
  const isNode = !!pkg;
  const htmlFiles = entries.filter((e) => /\.html$/i.test(e));
  const CODE_DIRS = ["src", "app", "lib", "pages", "components", "analysis", "scripts", "scenes", "src-tauri", "cmd", "internal"];
  const CODE_FILE = /\.(py|gd|js|mjs|cjs|ts|tsx|jsx|go|rs|java|cs|cpp|cc|c|swift|sh|rb|php|vue|svelte)$/i;
  const GAME_ENGINE = entries.some((e) => e === "project.godot" || /\.(uproject|unity|sln|xcodeproj)$/i.test(e));
  const hasCodeDir = entries.some((e) => CODE_DIRS.includes(e.toLowerCase()));
  const hasCodeFile = entries.some((e) => CODE_FILE.test(e));
  const codeish = isNode || htmlFiles.length > 0 || hasCodeDir || hasCodeFile || GAME_ENGINE;
  const mdCount = entries.filter((e) => /\.md$/i.test(e)).length;
  const commitCount = Number(commitCountRaw) || 0;
  const lastMs = lastCommitIso ? Date.parse(lastCommitIso) : 0;
  return {
    commitCount,
    commitsLastWeek: Number(weekRaw) || 0,
    lastCommitIso: lastCommitIso || null,
    lastCommitWhen: relTime(lastMs),
    daysSinceCommit: lastCommitIso ? Math.floor((Date.now() - lastMs) / 864e5) : null,
    uncommitted: porcelain ? porcelain.split("\n").filter(Boolean).length : 0,
    ahead: Number(aheadRaw) || 0,
    hasTests,
    isGit,
    framework: detectFramework(pkg, entries),
    specOnly: !codeish && mdCount > 0,
    hasReadme: !!findFile(entries, cwd, ["README.md", "README", "readme.md"]),
    hasChangelog: !!findFile(entries, cwd, ["CHANGELOG.md", "CHANGELOG"]),
    hasLicense: !!findFile(entries, cwd, ["LICENSE", "LICENSE.md", "LICENSE.txt"]),
    hasTag: !!tag,
    isNode
  };
}
function detectFramework(pkg, entries) {
  const scripts = pkg?.scripts || {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return "next";
  if (deps.vite || scripts.dev === "vite") return "vite";
  if (deps.electron || /electron/.test(scripts.dev || "")) return "electron";
  if (scripts.dev || scripts.start) return "node";
  if (entries.some((e) => /^index\.html?$/i.test(e))) return "static";
  return null;
}
function detectLaunch(framework, hasDevScript) {
  const launchable = !!framework;
  const opensUrl = framework != null && framework !== "electron";
  let cmdPreview = null;
  if (framework === "next") cmdPreview = "npm run dev -- -p <port>";
  else if (framework === "vite") cmdPreview = "npm run dev -- --port <port>";
  else if (framework === "electron") cmdPreview = "npm run dev";
  else if (framework === "node") cmdPreview = hasDevScript ? "npm run dev" : "npm start";
  else if (framework === "static") cmdPreview = "python3 -m http.server <port>";
  return { framework, launchable, opensUrl, cmdPreview };
}
async function deriveProject(input) {
  const cwd = input.cwd;
  const found = await exists$2(cwd);
  const base = {
    id: input.id,
    kind: "session",
    label: input.label,
    tag: input.tag,
    color: input.color,
    character: input.character,
    createdAt: input.createdAt,
    lastActive: input.lastPromptAt,
    lastActiveWhen: relTime(input.lastPromptAt ?? 0),
    dir: displayDir(cwd),
    note: null,
    found,
    origin: null,
    github: null,
    live: null,
    version: "—",
    versionSource: null,
    pkgName: null,
    branch: null,
    commits: [],
    changelog: [],
    nextSteps: [],
    proposedNextSteps: [],
    stats: null,
    launch: { framework: null, launchable: false, opensUrl: false, cmdPreview: null },
    status: "unknown"
  };
  if (!found) {
    base.status = "no-folder";
    return base;
  }
  const entries = await listDir(cwd);
  const pkg = await readJSON(node_path.join(cwd, "package.json"));
  const stats = await projectStats(entries, cwd, pkg);
  const [commits, changelog, fileSteps, agentSteps, remoteRaw, branch, tag] = await Promise.all([
    getCommits(cwd),
    getChangelog(entries, cwd),
    getOpenTasks(entries, cwd),
    getAgentTodos(input.agentSessionId),
    git(["remote", "get-url", "origin"], cwd),
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["describe", "--tags", "--abbrev=0"], cwd)
  ]);
  const nextSteps = [];
  for (const s of [...agentSteps, ...fileSteps]) {
    if (nextSteps.length >= 8) break;
    if (!nextSteps.some((x) => x.text === s.text)) nextSteps.push(s);
  }
  const github = githubUrlFrom(remoteRaw);
  const pkgVersion = pkg?.version ? `v${pkg.version}` : null;
  const shortSha = commits[0]?.sha || await git(["rev-parse", "--short", "HEAD"], cwd);
  let version = "—";
  let versionSource = null;
  if (pkgVersion) {
    version = pkgVersion;
    versionSource = "package.json";
  } else if (tag) {
    version = tag.startsWith("v") ? tag : `v${tag}`;
    versionSource = "git tag";
  } else if (stats.commitCount && shortSha) {
    version = `${stats.commitCount} commits · ${shortSha}`;
    versionSource = "git";
  }
  const scripts = pkg?.scripts || {};
  const launch2 = detectLaunch(stats.framework, !!scripts.dev);
  const pkgHome = typeof pkg?.homepage === "string" ? pkg.homepage : null;
  const live = pkgHome && /^https?:\/\//.test(pkgHome) ? pkgHome : /\.github\.io$/i.test(node_path.basename(cwd)) ? `https://${node_path.basename(cwd)}/` : null;
  const proposed = (await getProposedSteps(cwd, stats, { github, live, launch: launch2 })).filter((s) => !nextSteps.some((x) => x.text === s.text));
  let status2;
  if (stats.specOnly) status2 = "spec";
  else if (stats.daysSinceCommit == null) status2 = "unknown";
  else if (stats.daysSinceCommit <= 7) status2 = "active";
  else if (stats.daysSinceCommit <= 30) status2 = "recent";
  else status2 = "stale";
  base.origin = originOf(github);
  base.github = github;
  base.live = live;
  base.version = version;
  base.versionSource = versionSource;
  base.pkgName = pkg?.name || null;
  base.branch = branch || null;
  base.commits = commits;
  base.changelog = changelog;
  base.nextSteps = nextSteps;
  base.proposedNextSteps = proposed;
  base.launch = launch2;
  base.status = status2;
  base.stats = {
    commitCount: stats.commitCount,
    commitsLastWeek: stats.commitsLastWeek,
    lastCommitWhen: stats.lastCommitWhen,
    lastCommitIso: stats.lastCommitIso,
    daysSinceCommit: stats.daysSinceCommit,
    uncommitted: stats.uncommitted,
    ahead: stats.ahead,
    hasTests: stats.hasTests,
    isGit: stats.isGit,
    framework: stats.framework
  };
  return base;
}
const canonicalTag = (tag) => {
  const key = tag.trim().toLowerCase();
  return TAG_ORDER.includes(key) ? key : tag.trim();
};
async function scanProjects(inputs) {
  const projects = await Promise.all(inputs.map(deriveProject));
  const byTag = /* @__PURE__ */ new Map();
  for (const p of projects) {
    const key = canonicalTag(p.tag);
    const arr = byTag.get(key);
    if (arr) arr.push(p);
    else byTag.set(key, [p]);
  }
  const keys = [...byTag.keys()].sort((a, b) => {
    const ia = TAG_ORDER.indexOf(a.toLowerCase());
    const ib = TAG_ORDER.indexOf(b.toLowerCase());
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  const recencyKey = (p) => p.lastActive || (p.stats?.lastCommitIso ? Date.parse(p.stats.lastCommitIso) : 0);
  const groups = keys.map((key) => {
    const meta = TAG_META[key.toLowerCase()];
    return {
      tag: key,
      label: meta?.label || (key ? key[0].toUpperCase() + key.slice(1) : key),
      blurb: meta?.blurb || "",
      projects: byTag.get(key).sort((a, b) => recencyKey(b) - recencyKey(a))
    };
  });
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    totals: {
      projects: projects.length,
      sessions: projects.filter((p) => p.kind === "session").length,
      repos: projects.filter((p) => p.stats?.isGit).length,
      found: projects.filter((p) => p.found).length,
      groups: groups.length,
      openTasks: projects.reduce((n, p) => n + p.nextSteps.length, 0),
      shippedWeek: projects.reduce((n, p) => n + (p.stats?.commitsLastWeek ?? 0), 0)
    },
    groups
  };
}
async function recentCommits(projects) {
  const perProject = await Promise.all(
    projects.map(async ({ cwd, name }) => {
      const raw = await fetchRawCommits(cwd);
      return raw.map((c) => ({
        cwd,
        project: name,
        sha: c.sha,
        subject: c.subject,
        ts: c.iso ? Date.parse(c.iso) : 0,
        isRelease: c.isRelease
      }));
    })
  );
  return perProject.flat().filter((c) => c.ts > 0 && c.sha).sort((a, b) => b.ts - a.ts);
}
async function resolveLaunch(cwd) {
  if (!await exists$2(cwd)) return { framework: null, launchable: false, opensUrl: false, cmdPreview: null };
  const entries = await listDir(cwd);
  const pkg = await readJSON(node_path.join(cwd, "package.json"));
  const scripts = pkg?.scripts || {};
  return detectLaunch(detectFramework(pkg, entries), !!scripts.dev);
}
const TTL_MS = 3e4;
const cache$1 = /* @__PURE__ */ new Map();
const inFlight = /* @__PURE__ */ new Map();
function run(cwd) {
  return new Promise((resolve) => {
    node_child_process.execFile(
      "git",
      ["remote", "get-url", "origin"],
      { cwd, encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout) => {
        if (err) return resolve(null);
        const url = githubUrlFrom(String(stdout).trim());
        resolve(isGithubUrl(url) ? url : null);
      }
    );
  });
}
function resolveGithubUrl(cwd) {
  if (!cwd || typeof cwd !== "string") return Promise.resolve(null);
  const hit = cache$1.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const pending = inFlight.get(cwd);
  if (pending) return pending;
  const p = run(cwd).then((value) => {
    cache$1.set(cwd, { at: Date.now(), value });
    return value;
  }).finally(() => {
    inFlight.delete(cwd);
  });
  inFlight.set(cwd, p);
  return p;
}
const DEFAULTS = {
  maxBlocks: 600,
  maxText: 8e3,
  maxInlineImageBytes: 16 * 1024 * 1024,
  maxSingleImageBytes: 4 * 1024 * 1024
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
function isRecord(v) {
  return typeof v === "object" && v !== null;
}
function str$2(o, k) {
  const v = o[k];
  return typeof v === "string" ? v : void 0;
}
function num$2(o, k) {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function rec(o, k) {
  const v = o[k];
  return isRecord(v) ? v : void 0;
}
function list(o, k) {
  const v = o[k];
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
function toTs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Date.parse(v);
    if (!Number.isNaN(p)) return p;
  }
  return void 0;
}
function clip(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n) + `
… (${s.length - n} more chars)`;
}
function pathFromDescription(desc) {
  if (!desc) return void 0;
  const m = desc.match(/at path\s+(.+?)\s*$/i);
  const p = m ? m[1] : desc;
  return IMAGE_EXT.test(p) ? p : void 0;
}
function baseName(p) {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
function toolLabel(toolName, args) {
  const name = toolName || "tool";
  if (args) {
    const command = str$2(args, "command");
    if (command) return command;
    const target = str$2(args, "path") || str$2(args, "pattern") || str$2(args, "query") || str$2(args, "url") || str$2(args, "filePath") || str$2(args, "description");
    if (target) return `${name} ${target}`;
  }
  return name;
}
function parseCopilotEvents(text, opts) {
  const o = { ...DEFAULTS, ...opts ?? {} };
  const lines = text.split("\n");
  const assets2 = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.indexOf("binary_asset") === -1) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isRecord(ev) || ev["type"] !== "session.binary_asset") continue;
    const d = rec(ev, "data");
    if (!d) continue;
    const mimeType = str$2(d, "mimeType") ?? "";
    if (!mimeType.startsWith("image/")) continue;
    const assetId = str$2(d, "assetId");
    if (!assetId) continue;
    assets2.set(assetId, {
      mimeType,
      data: str$2(d, "data"),
      byteLength: num$2(d, "byteLength"),
      path: pathFromDescription(str$2(d, "description"))
    });
  }
  const blocks = [];
  const toolById = /* @__PURE__ */ new Map();
  const permById = /* @__PURE__ */ new Map();
  const emittedAssets = /* @__PURE__ */ new Set();
  const emittedSrc = /* @__PURE__ */ new Set();
  let inlineBudget = o.maxInlineImageBytes;
  const srcForAsset = (a) => {
    const b = a.byteLength ?? (a.data ? Math.floor(a.data.length * 3 / 4) : 0);
    if (a.data && b <= o.maxSingleImageBytes && b <= inlineBudget) {
      inlineBudget -= b;
      return `data:${a.mimeType};base64,${a.data}`;
    }
    if (a.path) return `file://${a.path}`;
    return void 0;
  };
  const pushImage = (src, caption, ts, id) => {
    if (emittedSrc.has(src)) return;
    emittedSrc.add(src);
    blocks.push({ kind: "image", id, src, alt: caption, caption, ts });
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    const type = str$2(ev, "type");
    const id = str$2(ev, "id") ?? `e${blocks.length}`;
    const ts = toTs(ev["timestamp"]);
    const d = rec(ev, "data") ?? {};
    switch (type) {
      case "user.message": {
        const text2 = (str$2(d, "content") ?? "").trim();
        if (text2) blocks.push({ kind: "user", id: `u:${id}`, text: clip(text2, o.maxText), ts });
        for (const att of list(d, "attachments")) {
          const p = str$2(att, "path");
          if (p && IMAGE_EXT.test(p)) {
            pushImage(`file://${p}`, str$2(att, "displayName") ?? baseName(p), ts, `att:${id}:${p}`);
          }
        }
        break;
      }
      case "assistant.message": {
        const reasoning = (str$2(d, "reasoningText") ?? "").trim();
        if (reasoning) {
          blocks.push({ kind: "thinking", id: `t:${id}`, body: clip(reasoning, o.maxText), ts });
        }
        const content = (str$2(d, "content") ?? "").trim();
        if (content) blocks.push({ kind: "agent", id: `a:${id}`, text: clip(content, o.maxText), ts });
        break;
      }
      case "tool.execution_start": {
        const callId = str$2(d, "toolCallId");
        if (!callId) break;
        const block = {
          kind: "tool",
          id: `tool:${callId}`,
          command: clip(toolLabel(str$2(d, "toolName"), rec(d, "arguments")), 400),
          ts
        };
        toolById.set(callId, block);
        blocks.push(block);
        break;
      }
      case "tool.execution_complete": {
        const callId = str$2(d, "toolCallId");
        const block = callId ? toolById.get(callId) : void 0;
        const result = rec(d, "result");
        if (block) {
          block.exitCode = d["success"] === false ? 1 : 0;
          const out = result ? str$2(result, "content") : void 0;
          if (out) block.output = clip(out.trim(), o.maxText);
          if (ts && block.ts) block.durationMs = Math.max(0, ts - block.ts);
        }
        if (result) {
          for (const bin of list(result, "binaryResultsForLlm")) {
            if ((str$2(bin, "mimeType") ?? "").startsWith("image/") === false) continue;
            const assetId = str$2(bin, "assetId");
            if (!assetId || emittedAssets.has(assetId)) continue;
            const asset = assets2.get(assetId);
            if (!asset) continue;
            emittedAssets.add(assetId);
            const src = srcForAsset(asset);
            if (src) {
              const caption = asset.path ? baseName(asset.path) : str$2(bin, "description");
              pushImage(src, caption, ts, `img:${assetId}`);
            }
          }
        }
        break;
      }
      case "permission.requested": {
        const pr = rec(d, "permissionRequest") ?? rec(d, "promptRequest");
        const requestId = str$2(d, "requestId");
        const callId = pr ? str$2(pr, "toolCallId") : void 0;
        const key = requestId ?? callId;
        if (!key) break;
        const block = {
          kind: "permission",
          id: `perm:${key}`,
          command: clip(pr && (str$2(pr, "intention") || str$2(pr, "url")) || "permission request", 400),
          ts
        };
        permById.set(key, block);
        if (callId && callId !== key) permById.set(callId, block);
        blocks.push(block);
        break;
      }
      case "permission.completed": {
        const key = str$2(d, "requestId") ?? str$2(d, "toolCallId");
        const block = key ? permById.get(key) : void 0;
        if (block) {
          const kind = rec(d, "result") && str$2(rec(d, "result"), "kind") || "";
          block.resolution = /den|reject|no/i.test(kind) ? "deny" : /always/i.test(kind) ? "always" : "once";
        }
        break;
      }
    }
  }
  return blocks.length > o.maxBlocks ? blocks.slice(blocks.length - o.maxBlocks) : blocks;
}
const SESSION_STATE_DIR = node_path.join(node_os.homedir(), ".copilot", "session-state");
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CACHE = 64;
const IMG_TOTAL_BUDGET = 6 * 1024 * 1024;
const IMG_SINGLE_MAX = 3 * 1024 * 1024;
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif"
};
const cache = /* @__PURE__ */ new Map();
async function readTail(file, size) {
  const fh = await promises.open(file, "r");
  try {
    const start = Math.max(0, size - MAX_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}
async function resolveImages(blocks) {
  let budget = IMG_TOTAL_BUDGET;
  const drop = /* @__PURE__ */ new Set();
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "image" || !b.src.startsWith("file://")) continue;
    const path = decodeURIComponent(b.src.slice("file://".length));
    const mime = MIME[node_path.extname(path).toLowerCase()];
    if (!mime) {
      drop.add(b);
      continue;
    }
    try {
      const st = await promises.stat(path);
      if (!st.isFile() || st.size > IMG_SINGLE_MAX || st.size > budget) {
        drop.add(b);
        continue;
      }
      const bytes = await promises.readFile(path);
      budget -= st.size;
      b.src = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      drop.add(b);
    }
  }
  return drop.size ? blocks.filter((b) => !drop.has(b)) : blocks;
}
async function readAgentTranscript(agentSessionId, knownVersion) {
  if (!agentSessionId || !/^[A-Za-z0-9._-]+$/.test(agentSessionId)) return { version: "", blocks: [] };
  const file = node_path.join(SESSION_STATE_DIR, agentSessionId, "events.jsonl");
  try {
    const st = await promises.stat(file);
    const version = `${st.mtimeMs}:${st.size}`;
    if (knownVersion && knownVersion === version) return { version, blocks: null };
    const cached = cache.get(agentSessionId);
    if (cached && cached.version === version) return { version, blocks: cached.blocks };
    const text = st.size > MAX_BYTES ? await readTail(file, st.size) : await promises.readFile(file, "utf8");
    const blocks = await resolveImages(
      parseCopilotEvents(text, { maxInlineImageBytes: IMG_TOTAL_BUDGET, maxSingleImageBytes: IMG_SINGLE_MAX })
    );
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== void 0) cache.delete(oldest);
    }
    cache.set(agentSessionId, { version, blocks });
    return { version, blocks };
  } catch {
    return { version: "", blocks: [] };
  }
}
const COPILOT_DB$1 = node_path.join(node_os.homedir(), ".copilot", "session-store.db");
const PROJECT_DENYLIST$1 = /* @__PURE__ */ new Set([
  ".copilot",
  ".claude",
  ".config",
  ".cache",
  ".git",
  "tmp",
  "node_modules",
  "Downloads",
  "Desktop",
  "Documents",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Library",
  "Applications",
  ".Trash"
]);
const HOME_RE$1 = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\](.+)$/;
const MAX_FOLLOWUPS = 30;
const MONTHS$1 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS$1 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
async function exists$1(p) {
  try {
    await promises.access(p);
    return true;
  } catch {
    return false;
  }
}
function sqlite3Json$1(dbPath, query) {
  return new Promise((resolve) => {
    const uri = `file:${dbPath}?mode=ro`;
    const attempt = (bin, fallback) => {
      node_child_process.execFile(
        bin,
        ["-json", uri, query],
        { encoding: "utf8", timeout: 8e3, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout) => {
          if (err) {
            if (fallback) fallback();
            else resolve([]);
            return;
          }
          try {
            const j = JSON.parse(String(stdout || "[]"));
            resolve(Array.isArray(j) ? j : []);
          } catch {
            resolve([]);
          }
        }
      );
    };
    attempt("/usr/bin/sqlite3", () => attempt("sqlite3", null));
  });
}
function fmtLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function toDate(ts) {
  if (ts == null) return null;
  let s = String(ts).trim();
  if (!s) return null;
  if (!s.includes("T")) {
    s = s.replace(" ", "T");
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function timeLabel(ts) {
  const d = toDate(ts);
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayLabel(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS$1[dt.getDay()]} ${MONTHS$1[dt.getMonth()]} ${dt.getDate()}`;
}
function rangeLabel(from, to) {
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  const s = `${MONTHS$1[from.getMonth()]} ${from.getDate()}`;
  if (sameMonth) return `${s} – ${to.getDate()}, ${to.getFullYear()}`;
  if (sameYear) return `${s} – ${MONTHS$1[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`;
  return `${s}, ${from.getFullYear()} – ${MONTHS$1[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`;
}
function projectOf$1(filePath) {
  if (!filePath) return null;
  const m = HOME_RE$1.exec(filePath);
  if (m) return m[1].split(/[/\\]/)[0] || null;
  const parts = String(filePath).split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}
const LIST_MARKER = /^\s*(?:\d{1,3}[.)]|[-*•·])\s+/;
const LEADING_ENUM = /^\s*(?:\*\*)?\s*(?:\d{1,3}[.)]|[-*•·])\s*(?:\*\*)?\s*/;
const IMPERATIVE = /* @__PURE__ */ new Set([
  "add",
  "fix",
  "update",
  "remove",
  "confirm",
  "review",
  "check",
  "verify",
  "implement",
  "test",
  "write",
  "create",
  "refactor",
  "decide",
  "finalize",
  "finish",
  "ship",
  "deploy",
  "investigate",
  "wire",
  "build",
  "rename",
  "move",
  "delete",
  "document",
  "ensure",
  "handle",
  "run",
  "send",
  "follow",
  "schedule",
  "email",
  "ask",
  "draft",
  "prepare"
]);
function stripMarkdown(line) {
  return line.replace(/`+/g, "").replace(/\*\*/g, "").replace(/(^|\s)[_*]([^_*]+)[_*](?=\s|$)/g, "$1$2").replace(/^#+\s*/, "");
}
function extractFollowups(text) {
  if (!text) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const isList = LIST_MARKER.test(line);
    let cleaned = stripMarkdown(isList ? line.replace(LEADING_ENUM, "") : line).replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const isHeading = !isList && /:$/.test(cleaned) && !/[.?!]/.test(cleaned.slice(0, -1));
    if (isHeading) continue;
    const first = cleaned.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!isList && !IMPERATIVE.has(first)) continue;
    cleaned = cleaned.replace(/:$/, "").trim();
    if (cleaned.length < 4) continue;
    if (cleaned.length > 200) cleaned = cleaned.slice(0, 199).trimEnd() + "…";
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) >>> 0;
  return h.toString(36);
}
const str$1 = (v) => typeof v === "string" ? v : v == null ? "" : String(v);
const num$1 = (v) => typeof v === "number" ? v : Number(v) || 0;
async function buildPastWeek() {
  const empty = {
    available: false,
    weekStart: "",
    rangeLabel: "",
    stats: { sessions: 0, activeDays: 0, projects: 0, messages: 0, tokens: 0, topModel: null },
    days: [],
    projects: [],
    followups: []
  };
  if (!await exists$1(COPILOT_DB$1)) return empty;
  const now = /* @__PURE__ */ new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  const fromKey = fmtLocal(from);
  const toKey = fmtLocal(today);
  const cushLo = new Date(from);
  cushLo.setDate(cushLo.getDate() - 1);
  const cushHi = new Date(today);
  cushHi.setDate(cushHi.getDate() + 1);
  const fromDayUTC = cushLo.toISOString().slice(0, 10);
  const toDayUTC = cushHi.toISOString().slice(0, 10);
  const inWindow = `IN (SELECT id FROM sessions WHERE substr(created_at,1,10) BETWEEN '${fromDayUTC}' AND '${toDayUTC}')`;
  const [sessionRows, turnRows, fileRows, cpRows, usageRows, usageBySessionRows] = await Promise.all([
    sqlite3Json$1(
      COPILOT_DB$1,
      `SELECT id, summary, created_at FROM sessions WHERE substr(created_at,1,10) BETWEEN '${fromDayUTC}' AND '${toDayUTC}' ORDER BY created_at ASC`
    ),
    sqlite3Json$1(COPILOT_DB$1, `SELECT session_id, COUNT(*) AS n FROM turns WHERE session_id ${inWindow} GROUP BY session_id`),
    sqlite3Json$1(COPILOT_DB$1, `SELECT session_id, file_path FROM session_files WHERE session_id ${inWindow}`),
    sqlite3Json$1(
      COPILOT_DB$1,
      `SELECT session_id, next_steps FROM checkpoints WHERE session_id ${inWindow} ORDER BY checkpoint_number ASC`
    ),
    sqlite3Json$1(
      COPILOT_DB$1,
      `SELECT model, COUNT(*) AS calls FROM assistant_usage_events WHERE session_id ${inWindow} GROUP BY model`
    ),
    sqlite3Json$1(
      COPILOT_DB$1,
      `SELECT session_id, COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) AS tok FROM assistant_usage_events WHERE session_id ${inWindow} GROUP BY session_id`
    )
  ]);
  const sessions = sessionRows.map((r) => ({ id: str$1(r.id), summary: str$1(r.summary), created_at: str$1(r.created_at) })).filter((s) => {
    const d = toDate(s.created_at);
    if (!d) return false;
    const key = fmtLocal(d);
    return key >= fromKey && key <= toKey;
  });
  const keep = new Set(sessions.map((s) => s.id));
  const turns = /* @__PURE__ */ new Map();
  for (const r of turnRows) turns.set(str$1(r.session_id), num$1(r.n));
  const tokensBySession = /* @__PURE__ */ new Map();
  for (const r of usageBySessionRows) tokensBySession.set(str$1(r.session_id), num$1(r.tok));
  const filesBySession = /* @__PURE__ */ new Map();
  const projectAgg = /* @__PURE__ */ new Map();
  for (const r of fileRows) {
    const sid = str$1(r.session_id);
    if (!keep.has(sid)) continue;
    const proj = projectOf$1(str$1(r.file_path));
    if (!proj || PROJECT_DENYLIST$1.has(proj)) continue;
    if (!filesBySession.has(sid)) filesBySession.set(sid, /* @__PURE__ */ new Map());
    const per = filesBySession.get(sid);
    per.set(proj, (per.get(proj) || 0) + 1);
    if (!projectAgg.has(proj)) projectAgg.set(proj, { name: proj, sessions: /* @__PURE__ */ new Set(), files: 0 });
    const agg = projectAgg.get(proj);
    agg.sessions.add(sid);
    agg.files += 1;
  }
  const projects = [...projectAgg.values()].map((p) => ({
    name: p.name,
    sessions: p.sessions.size,
    files: p.files,
    tokens: [...p.sessions].reduce((a, sid) => a + (tokensBySession.get(sid) || 0), 0)
  })).sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions || b.files - a.files || a.name.localeCompare(b.name));
  const sessionTitle = /* @__PURE__ */ new Map();
  const enriched = sessions.map((s) => {
    const per = filesBySession.get(s.id);
    const topProjects = per ? [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name) : [];
    const t = turns.get(s.id) || 0;
    const hasSummary = !!(s.summary && s.summary.trim());
    const title = hasSummary ? s.summary.trim() : topProjects.length ? `Worked in ${topProjects[0]}` : "Untitled session";
    return { s, topProjects, turns: t, title, noise: !hasSummary && t === 0 && topProjects.length === 0 };
  }).filter((e) => !e.noise);
  const byDay = /* @__PURE__ */ new Map();
  for (const e of enriched) {
    sessionTitle.set(e.s.id, e.title);
    const d = toDate(e.s.created_at);
    const key = fmtLocal(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({
      id: e.s.id,
      time: timeLabel(e.s.created_at),
      title: e.title,
      projects: e.topProjects,
      turns: e.turns,
      tokens: tokensBySession.get(e.s.id) || 0
    });
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list2]) => ({ date, label: dayLabel(date), sessions: list2 }));
  const followups = [];
  const seenSug = /* @__PURE__ */ new Set();
  for (const cp of cpRows) {
    const sid = str$1(cp.session_id);
    if (!keep.has(sid)) continue;
    for (const text of extractFollowups(str$1(cp.next_steps) || null)) {
      const id = hashId(`${sid}|${text}`);
      if (seenSug.has(id)) continue;
      seenSug.add(id);
      followups.push({ id, text, sessionTitle: sessionTitle.get(sid) || "session" });
      if (followups.length >= MAX_FOLLOWUPS) break;
    }
    if (followups.length >= MAX_FOLLOWUPS) break;
  }
  let topModel = null;
  let bestCalls = -1;
  for (const r of usageRows) {
    const calls = num$1(r.calls);
    if (calls > bestCalls) {
      bestCalls = calls;
      topModel = str$1(r.model) || null;
    }
  }
  let tokens = 0;
  for (const e of enriched) tokens += tokensBySession.get(e.s.id) || 0;
  let messages = 0;
  for (const e of enriched) messages += e.turns;
  return {
    available: true,
    weekStart: fromKey,
    rangeLabel: rangeLabel(from, today),
    stats: {
      sessions: enriched.length,
      activeDays: days.length,
      projects: projects.length,
      messages,
      tokens,
      topModel
    },
    days,
    projects,
    followups
  };
}
const COPILOT_DB = node_path.join(node_os.homedir(), ".copilot", "session-store.db");
const PROJECT_DENYLIST = /* @__PURE__ */ new Set([
  ".copilot",
  ".claude",
  ".config",
  ".cache",
  ".git",
  "tmp",
  "node_modules",
  "Downloads",
  "Desktop",
  "Documents",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Library",
  "Applications",
  ".Trash"
]);
const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\](.+)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR = 36e5;
const DAY = 864e5;
const TOP_SLICES = 8;
async function exists(p) {
  try {
    await promises.access(p);
    return true;
  } catch {
    return false;
  }
}
function sqlite3Json(dbPath, query) {
  return new Promise((resolve) => {
    const uri = `file:${dbPath}?mode=ro`;
    const attempt = (bin, fallback) => {
      node_child_process.execFile(
        bin,
        ["-json", uri, query],
        { encoding: "utf8", timeout: 8e3, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout) => {
          if (err) {
            if (fallback) fallback();
            else resolve([]);
            return;
          }
          try {
            const j = JSON.parse(String(stdout || "[]"));
            resolve(Array.isArray(j) ? j : []);
          } catch {
            resolve([]);
          }
        }
      );
    };
    attempt("/usr/bin/sqlite3", () => attempt("sqlite3", null));
  });
}
const str = (v) => typeof v === "string" ? v : v == null ? "" : String(v);
const num = (v) => typeof v === "number" ? v : Number(v) || 0;
function projectOf(filePath) {
  if (!filePath) return null;
  const m = HOME_RE.exec(filePath);
  if (m) return m[1].split(/[/\\]/)[0] || null;
  const parts = String(filePath).split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}
function two(n) {
  return String(n).padStart(2, "0");
}
function hourLabel(d) {
  const h = d.getHours();
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${am ? "a" : "p"}`;
}
const RANGES = [
  {
    key: "hour",
    short: "1h",
    title: "Past hour",
    bucketLabel: "5-minute buckets",
    windowMs: HOUR,
    keyOf: (d) => String(Math.floor(d.getTime() / (5 * 6e4))),
    buckets: (now) => {
      const step = 5 * 6e4;
      const last = Math.floor(now.getTime() / step);
      const out = [];
      for (let i = 11; i >= 0; i--) {
        const start = (last - i) * step;
        const d = new Date(start);
        out.push({ key: String(last - i), label: `${two(d.getHours())}:${two(d.getMinutes())}` });
      }
      return out;
    }
  },
  {
    key: "day",
    short: "24h",
    title: "Past 24 hours",
    bucketLabel: "hourly buckets",
    windowMs: DAY,
    keyOf: (d) => String(Math.floor(d.getTime() / HOUR)),
    buckets: (now) => {
      const last = Math.floor(now.getTime() / HOUR);
      const out = [];
      for (let i = 23; i >= 0; i--) {
        const d = new Date((last - i) * HOUR);
        out.push({ key: String(last - i), label: hourLabel(d) });
      }
      return out;
    }
  },
  {
    key: "week",
    short: "7d",
    title: "Past 7 days",
    bucketLabel: "daily buckets",
    windowMs: 7 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    buckets: (now) => {
      const out = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, label: WEEKDAYS[d.getDay()] });
      }
      return out;
    }
  },
  {
    key: "month",
    short: "30d",
    title: "Past 30 days",
    bucketLabel: "daily buckets",
    windowMs: 30 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    buckets: (now) => {
      const out = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const label = i % 5 === 0 || i === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : "";
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, label });
      }
      return out;
    }
  },
  {
    key: "year",
    short: "1y",
    title: "Past 12 months",
    bucketLabel: "monthly buckets",
    windowMs: 366 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}`,
    buckets: (now) => {
      const out = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}`, label: MONTHS[d.getMonth()] });
      }
      return out;
    }
  }
];
function buildRange(spec, events, now, labelOf) {
  const defs = spec.buckets(now);
  const idx = /* @__PURE__ */ new Map();
  defs.forEach((b, i) => idx.set(b.key, i));
  const series = defs.map((b) => ({ label: b.label, tokens: 0 }));
  const cutoff = now.getTime() - spec.windowMs;
  let totalTokens = 0;
  let totalAiu = 0;
  const bySlice = /* @__PURE__ */ new Map();
  const bucketsBySlice = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.ms < cutoff) continue;
    const i = idx.get(spec.keyOf(new Date(e.ms)));
    if (i === void 0) continue;
    series[i].tokens += e.tokens;
    totalTokens += e.tokens;
    totalAiu += e.aiu;
    const slice = labelOf(e.session);
    const acc = bySlice.get(slice.name);
    if (acc) acc.tokens += e.tokens;
    else bySlice.set(slice.name, { name: slice.name, tokens: e.tokens, kind: slice.kind });
    let arr = bucketsBySlice.get(slice.name);
    if (!arr) {
      arr = new Array(defs.length).fill(0);
      bucketsBySlice.set(slice.name, arr);
    }
    arr[i] += e.tokens;
  }
  let peakLabel = null;
  let peak = 0;
  for (const b of series) {
    if (b.tokens > peak && b.label) {
      peak = b.tokens;
      peakLabel = b.label;
    }
  }
  const ranked = [...bySlice.values()].sort((a, b) => b.tokens - a.tokens);
  const projects = ranked.slice(0, TOP_SLICES);
  const topNames = new Set(projects.map((p) => p.name));
  if (ranked.length > TOP_SLICES) {
    const rest = ranked.slice(TOP_SLICES).reduce((a, s) => a + s.tokens, 0);
    if (rest > 0) projects.push({ name: "Other", tokens: rest, kind: "session" });
  }
  const seriesByProject = {};
  for (const p of projects) {
    if (p.name === "Other" && !topNames.has("Other")) {
      const agg = new Array(defs.length).fill(0);
      for (const [name, arr] of bucketsBySlice) {
        if (topNames.has(name)) continue;
        for (let i = 0; i < arr.length; i++) agg[i] += arr[i];
      }
      seriesByProject.Other = defs.map((b, i) => ({ label: b.label, tokens: agg[i] }));
    } else {
      const arr = bucketsBySlice.get(p.name) ?? new Array(defs.length).fill(0);
      seriesByProject[p.name] = defs.map((b, i) => ({ label: b.label, tokens: arr[i] }));
    }
  }
  return {
    key: spec.key,
    short: spec.short,
    title: spec.title,
    bucketLabel: spec.bucketLabel,
    series,
    totalTokens,
    totalAiu,
    peakLabel,
    projects,
    seriesByProject
  };
}
async function buildUsageAnalytics() {
  const now = /* @__PURE__ */ new Date();
  const empty = { available: false, generatedAt: now.getTime(), ranges: [] };
  if (!await exists(COPILOT_DB)) return empty;
  const cutoffISO = new Date(now.getTime() - 370 * DAY).toISOString();
  const [usageRows, fileRows, sessionRows] = await Promise.all([
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, created_at, COALESCE(input_tokens,0) + COALESCE(output_tokens,0) AS tok, COALESCE(total_nano_aiu,0) AS aiu FROM assistant_usage_events WHERE created_at >= '${cutoffISO}'`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, file_path FROM session_files WHERE session_id IN (SELECT id FROM sessions WHERE created_at >= '${cutoffISO}')`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT id, summary FROM sessions WHERE created_at >= '${cutoffISO}'`
    )
  ]);
  if (usageRows.length === 0) return { available: true, generatedAt: now.getTime(), ranges: RANGES.map((s) => buildRange(s, [], now, () => ({ name: "Other", tokens: 0, kind: "session" }))) };
  const repoCounts = /* @__PURE__ */ new Map();
  for (const r of fileRows) {
    const sid = str(r.session_id);
    const proj = projectOf(str(r.file_path));
    if (!proj || PROJECT_DENYLIST.has(proj)) continue;
    if (!repoCounts.has(sid)) repoCounts.set(sid, /* @__PURE__ */ new Map());
    const per = repoCounts.get(sid);
    per.set(proj, (per.get(proj) || 0) + 1);
  }
  const repoOf = /* @__PURE__ */ new Map();
  for (const [sid, per] of repoCounts) {
    let best = null;
    let n = -1;
    for (const [name, c] of per) {
      if (c > n) {
        n = c;
        best = name;
      }
    }
    if (best) repoOf.set(sid, best);
  }
  const summaryOf = /* @__PURE__ */ new Map();
  for (const r of sessionRows) {
    const s = str(r.summary).trim();
    if (s) summaryOf.set(str(r.id), s);
  }
  const sliceCache = /* @__PURE__ */ new Map();
  const labelOf = (session) => {
    const cached = sliceCache.get(session);
    if (cached) return cached;
    const repo = repoOf.get(session);
    const slice = repo ? { name: repo, tokens: 0, kind: "repo" } : { name: summaryOf.get(session) || "Untitled session", tokens: 0, kind: "session" };
    sliceCache.set(session, slice);
    return slice;
  };
  const events = [];
  for (const r of usageRows) {
    const ms = Date.parse(str(r.created_at));
    if (Number.isNaN(ms)) continue;
    events.push({ ms, tokens: num(r.tok), aiu: num(r.aiu), session: str(r.session_id) });
  }
  return {
    available: true,
    generatedAt: now.getTime(),
    ranges: RANGES.map((spec) => buildRange(spec, events, now, labelOf))
  };
}
function compareVersions(a, b) {
  const parse = (v) => String(v).trim().replace(/^v/i, "").split(".").map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}
const REPO = "alexselig/crew";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
async function checkForUpdate() {
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Crew/${electron.app.getVersion()}`
      },
      // Guard against a hung request keeping a handle alive.
      signal: AbortSignal.timeout(8e3)
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.draft || json.prerelease || !json.tag_name) return null;
    const version = json.tag_name.replace(/^v/i, "");
    if (!isNewer(version, electron.app.getVersion())) return null;
    return {
      version,
      url: json.html_url || `https://github.com/${REPO}/releases/latest`,
      publishedAt: json.published_at ?? null
    };
  } catch {
    return null;
  }
}
function startUpdateChecks(onUpdate) {
  let stopped = false;
  const run2 = async () => {
    const info = await checkForUpdate();
    if (!stopped && info) onUpdate(info);
  };
  const first = setTimeout(() => void run2(), 8e3);
  const timer = setInterval(() => void run2(), CHECK_INTERVAL_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
const running = /* @__PURE__ */ new Map();
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
function probe(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
function buildCommand(framework, port, launch2) {
  switch (framework) {
    case "next":
      return { cmd: "npm", args: ["run", "dev", "--", "-p", String(port)] };
    case "vite":
      return { cmd: "npm", args: ["run", "dev", "--", "--port", String(port), "--strictPort"] };
    case "electron":
      return { cmd: "npm", args: ["run", "dev"] };
    case "static":
      return { cmd: "python3", args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"] };
    case "node":
      return { cmd: "npm", args: ["run", launch2.cmdPreview?.includes("run dev") ? "dev" : "start"] };
    default:
      return null;
  }
}
function view(r) {
  return { id: r.id, label: r.label, port: r.port, url: r.url, framework: r.framework, status: r.status, startedAt: r.startedAt, pid: r.pid, external: !!r.external };
}
function status() {
  return [...running.values()].map(view);
}
function getRunning(id) {
  const r = running.get(id);
  return r ? view(r) : null;
}
async function recoverFromLog(rec2, skipPort) {
  await new Promise((r) => setTimeout(r, 300));
  const ports = [...new Set((rec2.log.match(/localhost:(\d+)/gi) || []).map((m) => Number(m.split(":")[1])))];
  for (const port of ports) {
    if (port === skipPort) continue;
    if (await probe(port)) {
      rec2.port = port;
      rec2.url = `http://localhost:${port}/`;
      rec2.status = "running";
      rec2.external = true;
      return true;
    }
  }
  return false;
}
async function launch(id, cwd, label, launchMeta) {
  const existing = running.get(id);
  if (existing && existing.status !== "exited") {
    return { ok: true, already: true, ...getRunning(id) };
  }
  if (!cwd) return { ok: false, error: "No local folder mapped for this project." };
  if (!launchMeta.launchable) return { ok: false, error: "No dev server detected for this project." };
  const framework = launchMeta.framework;
  const opensUrl = launchMeta.opensUrl;
  const forcedPort = framework === "next" || framework === "vite" || framework === "static" ? await freePort() : null;
  const spec = buildCommand(framework, forcedPort, launchMeta);
  if (!spec) return { ok: false, error: `Don't know how to launch framework "${framework}".` };
  const env = { ...process.env, BROWSER: "none", FORCE_COLOR: "0" };
  if (forcedPort) env.PORT = String(forcedPort);
  let child;
  try {
    child = node_child_process.spawn(spec.cmd, spec.args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { ok: false, error: `Failed to spawn ${spec.cmd}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rec2 = {
    id,
    child,
    pid: child.pid ?? 0,
    port: forcedPort,
    url: null,
    framework,
    label,
    startedAt: Date.now(),
    log: "",
    status: "starting"
  };
  running.set(id, rec2);
  const capture = (buf) => {
    rec2.log = (rec2.log + buf.toString()).slice(-8e3);
    if (!forcedPort) {
      const m = rec2.log.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
      if (m) rec2.port = Number(m[1]);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("exit", (code) => {
    rec2.status = "exited";
    rec2.exitCode = code;
  });
  if (!opensUrl) {
    await new Promise((r) => setTimeout(r, 1200));
    if (rec2.status === "exited") {
      return { ok: false, error: "Process exited immediately.", log: rec2.log.slice(-1200) };
    }
    rec2.status = "running";
    return { ok: true, ...getRunning(id), note: "Desktop app — no browser URL." };
  }
  const deadline = Date.now() + 55e3;
  while (Date.now() < deadline) {
    if (rec2.status === "exited") {
      if (await recoverFromLog(rec2, forcedPort)) {
        return { ok: true, already: true, ...getRunning(id), note: "Already running outside the tracker — linked to it." };
      }
      return { ok: false, error: "Dev server exited during startup.", log: rec2.log.slice(-1500) };
    }
    if (rec2.port && await probe(rec2.port)) {
      rec2.url = `http://localhost:${rec2.port}/`;
      rec2.status = "running";
      return { ok: true, ...getRunning(id) };
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  rec2.status = rec2.port ? "running" : "starting";
  if (rec2.port) rec2.url = `http://localhost:${rec2.port}/`;
  return { ok: true, slow: true, ...getRunning(id), note: "Still compiling — try the link in a moment.", log: rec2.log.slice(-800) };
}
function stop(id) {
  const rec2 = running.get(id);
  if (!rec2) return { ok: false, error: "Not running." };
  if (rec2.external) {
    running.delete(id);
    return { ok: true, external: true };
  }
  try {
    if (rec2.pid > 0) process.kill(-rec2.pid, "SIGTERM");
  } catch {
    try {
      if (rec2.pid > 0) process.kill(rec2.pid, "SIGTERM");
    } catch {
    }
  }
  running.delete(id);
  return { ok: true };
}
function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}
const TIMEOUT_MS = 18e4;
class AgentRunner extends node_events.EventEmitter {
  constructor(resolveBase) {
    super();
    this.resolveBase = resolveBase;
  }
  recs = /* @__PURE__ */ new Map();
  get(runId) {
    return this.recs.get(runId)?.run;
  }
  run(agent, ctx) {
    const run2 = {
      id: makeRunId(),
      agentId: agent.id,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      task: ctx.task,
      status: "running",
      output: "",
      startedAt: Date.now()
    };
    const fail = (msg) => {
      run2.status = "error";
      run2.error = msg;
      run2.endedAt = Date.now();
      this.recs.set(run2.id, { run: run2, child: null, timer: null });
      queueMicrotask(() => this.emit("run", { ...run2 }));
      return run2;
    };
    const base = this.resolveBase(agent.base);
    if (!base) return fail(`Unknown base agent "${agent.base}".`);
    const { args } = buildAgentInvocation(base, agent, ctx.task, ctx.extra ?? "");
    let child;
    try {
      child = node_child_process.spawn(base.command, [...base.args, ...args], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const timer = setTimeout(() => this.kill(run2.id, "Timed out."), TIMEOUT_MS);
    this.recs.set(run2.id, { run: run2, child, timer });
    const append = (buf) => {
      run2.output = (run2.output + buf.toString()).slice(-2e5);
      this.emit("run", { ...run2 });
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (run2.status !== "running") return;
      run2.status = code === 0 ? "done" : "error";
      if (code !== 0 && !run2.error) run2.error = `Exited with code ${code}.`;
      run2.endedAt = Date.now();
      this.emit("run", { ...run2 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (run2.status !== "running") return;
      run2.status = "error";
      run2.error = err instanceof Error ? err.message : String(err);
      run2.endedAt = Date.now();
      this.emit("run", { ...run2 });
    });
    queueMicrotask(() => this.emit("run", { ...run2 }));
    return run2;
  }
  cancel(runId) {
    this.kill(runId, "Cancelled.");
  }
  kill(runId, reason) {
    const rec2 = this.recs.get(runId);
    if (!rec2 || rec2.run.status !== "running") return;
    rec2.run.status = "error";
    rec2.run.error = reason;
    rec2.run.endedAt = Date.now();
    if (rec2.timer) clearTimeout(rec2.timer);
    try {
      if (rec2.child?.pid && rec2.child.pid > 0) process.kill(-rec2.child.pid, "SIGTERM");
    } catch {
    }
    this.emit("run", { ...rec2.run });
  }
  disposeAll() {
    for (const id of this.recs.keys()) this.kill(id, "Shutting down.");
  }
}
let tray = null;
let manager;
let store;
let agentRunner;
let recorder;
let assets;
let isQuitting = false;
let sessionsRestored = false;
let activeWorkspace = null;
function crashLog(kind, detail) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${kind}: ${detail}
`;
  let dir = node_os.tmpdir();
  try {
    dir = electron.app.getPath("userData");
  } catch {
  }
  try {
    node_fs.appendFileSync(node_path.join(dir, "crew-crash.log"), line);
  } catch {
  }
  console.error("[crew]", kind, detail);
}
process.on("uncaughtException", (err) => crashLog("uncaughtException", err && err.stack || String(err)));
process.on("unhandledRejection", (reason) => crashLog("unhandledRejection", String(reason)));
electron.app.on(
  "render-process-gone",
  (_e, _wc, details) => crashLog("render-process-gone", JSON.stringify(details))
);
electron.app.on("child-process-gone", (_e, details) => crashLog("child-process-gone", JSON.stringify(details)));
const usedWindowSlots = /* @__PURE__ */ new Set();
function allocWindowSlot() {
  let s = 0;
  while (usedWindowSlots.has(s)) s++;
  usedWindowSlots.add(s);
  return s;
}
electron.protocol.registerSchemesAsPrivileged([
  { scheme: "crew-asset", privileges: { secure: true, supportFetchAPI: true, stream: true } }
]);
function broadcast(channel, payload) {
  for (const w of electron.BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}
function focusedWindow() {
  return electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0] ?? null;
}
function debounce(fn, ms) {
  let t;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
function boundsOnSomeDisplay(b) {
  return electron.screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 60 && b.x + b.width > a.x + 60 && b.y < a.y + a.height - 24 && b.y + b.height > a.y + 24;
  });
}
function centeredOn(display, width, height) {
  const a = display.workArea;
  const w = Math.min(width, a.width - 80);
  const h = Math.min(height, a.height - 80);
  return {
    x: Math.round(a.x + (a.width - w) / 2),
    y: Math.round(a.y + (a.height - h) / 2),
    width: w,
    height: h
  };
}
function defaultBounds() {
  const primary = electron.screen.getPrimaryDisplay();
  const saved = store.windowBounds;
  if (saved && boundsOnSomeDisplay(saved)) {
    const savedDisplay = electron.screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    if (savedDisplay.id === primary.id) return saved;
    return centeredOn(primary, saved.width, saved.height);
  }
  return centeredOn(primary, 1120, 740);
}
function newWindowBounds() {
  const usedIds = new Set(
    electron.BrowserWindow.getAllWindows().map((w) => electron.screen.getDisplayMatching(w.getBounds()).id)
  );
  const free = electron.screen.getAllDisplays().find((d) => !usedIds.has(d.id));
  if (free) return centeredOn(free, 1120, 740);
  const f = focusedWindow()?.getBounds();
  if (f) return { x: f.x + 40, y: f.y + 40, width: f.width, height: f.height };
  return defaultBounds();
}
function createWindow(opts = {}) {
  const intro = opts.intro ?? true;
  const w = new electron.BrowserWindow({
    ...opts.bounds ?? defaultBounds(),
    minWidth: 860,
    minHeight: 540,
    title: "Crew",
    backgroundColor: "#0A0A0B",
    show: false,
    // macOS hides the titlebar and insets the traffic lights so the renderer
    // draws its own chrome. Windows/Linux keep a native frame so the standard
    // min/max/close controls work — the renderer's own right-side titlebar
    // controls would collide with a Windows title-bar overlay.
    ...isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 18 } } : {},
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      // Enables the <webview> tag used by the session "App" pane to render a
      // session's local dev server. Hardened below in will-attach-webview.
      webviewTag: true
    }
  });
  w.on("ready-to-show", () => {
    w.show();
    w.focus();
  });
  w.webContents.on("will-attach-webview", (_e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    params.partition = "persist:crewapp";
    if (!isLoopbackHttp(params.src)) {
      params.src = "about:blank";
    }
  });
  w.webContents.on("did-attach-webview", (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
      return { action: "deny" };
    });
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    let external = true;
    try {
      external = new URL(url).origin !== new URL(w.webContents.getURL()).origin;
    } catch {
      external = true;
    }
    if (external) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
    }
  });
  const slot = allocWindowSlot();
  w.on("closed", () => usedWindowSlots.delete(slot));
  w.on("close", (e) => {
    if (!isQuitting && electron.BrowserWindow.getAllWindows().length === 1) {
      e.preventDefault();
      w.hide();
    }
  });
  const saveBounds = debounce(() => {
    if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen()) {
      store.setWindowBounds(w.getBounds());
    }
  }, 400);
  w.on("resize", saveBounds);
  w.on("move", saveBounds);
  w.webContents.once("did-finish-load", () => {
    if (activeWorkspace != null) w.webContents.send(IPC.EVT_WORKSPACE, activeWorkspace);
    if (sessionsRestored) return;
    sessionsRestored = true;
    manager.restore();
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    const params = new URLSearchParams({ w: String(slot) });
    if (!intro) params.set("intro", "0");
    void w.loadURL(`${devUrl}?${params.toString()}`);
  } else {
    const query = { w: String(slot) };
    if (!intro) query.intro = "0";
    void w.loadFile(node_path.join(__dirname, "../renderer/index.html"), { query });
  }
  return w;
}
function openWindow() {
  createWindow({ intro: false, bounds: newWindowBounds() });
}
function revealWindow(w) {
  const primary = electron.screen.getPrimaryDisplay();
  const b = w.getBounds();
  const onPrimary = electron.screen.getDisplayNearestPoint({ x: b.x, y: b.y }).id === primary.id;
  if (!onPrimary || !boundsOnSomeDisplay(b)) {
    w.setBounds(centeredOn(primary, b.width, b.height));
  }
}
function showWindow() {
  const w = focusedWindow();
  if (!w) {
    createWindow();
    return;
  }
  if (w.isMinimized()) w.restore();
  revealWindow(w);
  w.show();
  w.focus();
}
function jumpTo(id) {
  showWindow();
  focusedWindow()?.webContents.send(IPC.EVT_JUMP, id);
}
function openNewSession() {
  showWindow();
  focusedWindow()?.webContents.send(IPC.EVT_NEW);
}
function setActiveWorkspace(name) {
  activeWorkspace = name;
  focusedWindow()?.webContents.send(IPC.EVT_WORKSPACE, name);
  rebuildAppMenu();
}
function rebuildAppMenu() {
  const wss = store ? store.getWorkspaces() : [];
  const workspaceItems = [
    {
      label: "All Sessions",
      type: "radio",
      checked: activeWorkspace == null,
      click: () => setActiveWorkspace(null)
    }
  ];
  if (wss.length) {
    workspaceItems.push({ type: "separator" });
    for (const w of [...wss].sort((a, b) => a.order - b.order)) {
      workspaceItems.push({
        label: w.name,
        type: "radio",
        checked: activeWorkspace === w.id,
        click: () => setActiveWorkspace(w.id)
      });
    }
  }
  const isMac2 = process.platform === "darwin";
  const template = [
    ...isMac2 ? [{ role: "appMenu" }] : [],
    {
      label: "File",
      submenu: [
        { label: "New Session", click: () => openNewSession() },
        { label: "New Window", click: () => openWindow() },
        { type: "separator" },
        {
          label: "Workspaces…",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => focusedWindow()?.webContents.send(IPC.EVT_OPEN_WORKSPACES)
        },
        { label: "Change Workspace", submenu: workspaceItems },
        { type: "separator" },
        isMac2 ? { role: "close" } : { role: "quit" }
      ]
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
let quitDialogOpen = false;
function quitConfirmDisabled() {
  return process.env.CREW_NO_QUIT_CONFIRM === "1" || electron.app.commandLine.hasSwitch("remote-debugging-port");
}
function teardown() {
  crashLog("quit", "tearing down");
  recorder?.dispose();
  manager?.disposeAll();
  agentRunner?.disposeAll();
  assets?.disposeAll();
  stopAll();
  tray?.destroy();
}
function reallyQuit() {
  isQuitting = true;
  electron.app.quit();
}
async function confirmQuit() {
  if (isQuitting) return;
  if (quitConfirmDisabled()) {
    reallyQuit();
    return;
  }
  if (quitDialogOpen) {
    electron.BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus();
    return;
  }
  quitDialogOpen = true;
  const active = manager?.roster().filter((s) => s.status === "active").length ?? 0;
  const parent = electron.BrowserWindow.getAllWindows().find((w) => w.isVisible()) ?? null;
  const opts = {
    type: "question",
    buttons: ["Quit Crew", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Quit Crew?",
    detail: active > 0 ? `${active} running session${active === 1 ? "" : "s"} will be stopped.` : "Crew will stop running and won’t watch your sessions until reopened."
  };
  const { response } = parent ? await electron.dialog.showMessageBox(parent, opts) : await electron.dialog.showMessageBox(opts);
  quitDialogOpen = false;
  if (response === 0) reallyQuit();
}
function hydrateShellPath() {
  if (process.platform === "win32") return;
  const shell2 = process.env.SHELL || "/bin/zsh";
  const M = "__CREW_PATH__";
  try {
    const res = node_child_process.spawnSync(shell2, ["-ilc", `printf '%s' "${M}\${PATH}${M}"`], {
      encoding: "utf8",
      timeout: 5e3,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" }
    });
    const shellPath = (res.stdout || "").match(new RegExp(`${M}(.*)${M}`))?.[1]?.trim();
    if (!shellPath) return;
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
    for (const p of [...shellPath.split(":"), ...(process.env.PATH || "").split(":")]) {
      if (p && !seen.has(p)) {
        seen.add(p);
        merged.push(p);
      }
    }
    process.env.PATH = merged.join(":");
  } catch {
  }
}
function applyLoginItem(enabled) {
  try {
    electron.app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
  }
}
function whichSync(cmd) {
  if (!cmd) return null;
  if (cmd.includes("/")) {
    try {
      node_fs.accessSync(cmd, node_fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const p = node_path.join(dir, cmd);
    try {
      node_fs.accessSync(p, node_fs.constants.X_OK);
      return p;
    } catch {
    }
  }
  return null;
}
function wireManager() {
  manager.on("output", (p) => broadcast(IPC.EVT_OUTPUT, p));
  manager.on(
    "state",
    (info) => broadcast(IPC.EVT_STATE, {
      id: info.id,
      state: info.state,
      stateChangedAt: info.stateChangedAt
    })
  );
  manager.on("roster", (roster) => {
    if (isQuitting) return;
    broadcast(IPC.EVT_ROSTER, roster);
    tray?.update(roster);
    assets.sync(roster);
  });
  manager.on("transition", ({ session, from, to }) => {
    if (!NEEDS_YOU.includes(to) || NEEDS_YOU.includes(from)) return;
    const s = store.settings;
    if (!s.notifications) return;
    if (s.notifyOnlyWhenUnfocused && electron.BrowserWindow.getAllWindows().some((w) => w.isFocused())) return;
    tray?.notify(session, !s.sound);
  });
}
function registerIpc() {
  electron.ipcMain.handle(IPC.SESSION_CREATE, (_e, req) => {
    const info = manager.create(req);
    if (req.sets && req.sets.length) rebuildAppMenu();
    return info;
  });
  electron.ipcMain.handle(IPC.SESSION_CLOSE, (_e, id) => {
    manager.close(id);
  });
  electron.ipcMain.handle(IPC.SESSION_RESTART, (_e, id) => manager.restart(id));
  electron.ipcMain.handle(
    IPC.SESSION_RENAME,
    (_e, p) => manager.rename(p.id, p.label)
  );
  electron.ipcMain.handle(
    IPC.SESSION_SET_CHARACTER,
    (_e, p) => manager.setCharacter(p.id, p.characterId)
  );
  electron.ipcMain.handle(
    IPC.SESSION_SET_COLOR,
    (_e, p) => manager.setColor(p.id, p.color)
  );
  electron.ipcMain.handle(
    IPC.SESSION_SET_TAG,
    (_e, p) => manager.setTag(p.id, p.tag)
  );
  electron.ipcMain.handle(IPC.SESSION_SET_WORKSPACES, (_e, p) => {
    manager.setWorkspaces(p.id, p.sets);
    rebuildAppMenu();
  });
  electron.ipcMain.handle(IPC.SESSION_REORDER, (_e, orderedIds) => manager.reorder(orderedIds));
  electron.ipcMain.handle(IPC.WINDOW_OPEN, () => {
    openWindow();
  });
  electron.ipcMain.handle(IPC.ROSTER_GET, () => manager.roster());
  electron.ipcMain.handle(IPC.PRESETS_GET, () => builtinPresets());
  electron.ipcMain.handle(IPC.CHARACTERS_GET, () => CHARACTERS);
  electron.ipcMain.handle(IPC.HOME_DIR_GET, () => node_os.homedir());
  electron.ipcMain.handle(
    IPC.AGENTS_DETECT,
    () => builtinPresets().map((p) => {
      const path = whichSync(p.command);
      return {
        presetId: p.id,
        name: p.name,
        command: p.command,
        available: path != null,
        path,
        installHint: p.installHint
      };
    })
  );
  electron.ipcMain.handle(IPC.SKILLS_LIST, (_e, agent) => listInstalledSkills(agent));
  electron.ipcMain.handle(IPC.SETTINGS_GET, () => store.settings);
  electron.ipcMain.handle(IPC.SETTINGS_UPDATE, (_e, patch) => {
    const next = store.updateSettings(patch);
    if ("launchAtLogin" in patch) applyLoginItem(next.launchAtLogin);
    return next;
  });
  electron.ipcMain.handle(IPC.SETS_GET, () => store.sets);
  electron.ipcMain.handle(IPC.SETS_SAVE, (_e, name) => {
    const sessions = manager.roster().filter((s) => s.status === "active").map((s) => ({
      presetId: s.presetId,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      label: s.label,
      id: s.id,
      agentSessionId: s.agentSessionId,
      characterId: s.characterId,
      color: s.color,
      tag: s.tag,
      sets: s.sets
    }));
    const sets = store.upsertSet({ name, sessions });
    manager.addWorkspaceToActive(name);
    rebuildAppMenu();
    return sets;
  });
  electron.ipcMain.handle(IPC.SETS_LAUNCH, (_e, name) => {
    manager.launchSet(name);
  });
  electron.ipcMain.handle(IPC.SETS_DELETE, (_e, name) => {
    const sets = store.deleteSet(name);
    manager.removeWorkspaceEverywhere(name);
    if (activeWorkspace === name) setActiveWorkspace(null);
    rebuildAppMenu();
    return sets;
  });
  electron.ipcMain.handle(IPC.EVENTS_GET, () => manager.getEvents());
  electron.ipcMain.handle(IPC.ASSETS_LIST, (_e, id) => assets.list(id));
  electron.ipcMain.handle(IPC.ASSET_REVEAL, (_e, path) => {
    if (assets.has(path)) electron.shell.showItemInFolder(path);
  });
  electron.ipcMain.handle(IPC.ASSET_OPEN, async (_e, path) => {
    if (assets.has(path)) await electron.shell.openPath(path);
  });
  electron.ipcMain.handle(IPC.ASSET_RESOLVE, (_e, p) => {
    const cwd = assets.cwdOf(p.id);
    if (!cwd || typeof p.token !== "string" || p.token.length > 1024) return null;
    let t = p.token;
    if (t === "~" || t.startsWith("~/")) t = node_path.join(node_os.homedir(), t.slice(1));
    const abs = node_path.resolve(node_path.isAbsolute(t) ? t : node_path.join(cwd, t));
    return assets.pin(p.id, abs);
  });
  electron.ipcMain.handle(IPC.TRANSCRIPT_SEARCH, (_e, query) => recorder.search(query));
  electron.ipcMain.handle(IPC.TRANSCRIPT_GET, (_e, id) => recorder.read(id));
  electron.ipcMain.handle(
    IPC.AGENT_TRANSCRIPT_GET,
    (_e, p) => readAgentTranscript(p.agentSessionId, p.knownVersion)
  );
  electron.ipcMain.handle(IPC.TRANSCRIPT_EXPORT, async (_e, p) => {
    const text = recorder.read(p.id);
    const safe = p.label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "session";
    const res = await electron.dialog.showSaveDialog({
      title: "Export transcript",
      defaultPath: node_path.join(node_os.homedir(), `crew-${safe}.txt`)
    });
    if (res.canceled || !res.filePath) return false;
    try {
      node_fs.writeFileSync(res.filePath, text);
      return true;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle(IPC.TRACKER_SCAN, () => {
    const inputs = manager.roster().filter((s) => s.status === "active").map((s) => ({
      id: s.id,
      label: s.label,
      tag: s.tag && s.tag.trim() ? s.tag.trim() : "Other",
      color: s.color,
      character: s.characterId ?? null,
      createdAt: s.createdAt ?? null,
      lastPromptAt: s.lastPromptAt ?? s.createdAt ?? null,
      cwd: s.cwd,
      agentSessionId: s.agentSessionId ?? null
    }));
    return scanProjects(inputs);
  });
  electron.ipcMain.handle(IPC.TRACKER_PAST_WEEK, () => buildPastWeek());
  electron.ipcMain.handle(IPC.USAGE_ANALYTICS, () => buildUsageAnalytics());
  electron.ipcMain.handle(IPC.UPDATE_CHECK, () => checkForUpdate());
  electron.ipcMain.handle(IPC.OPEN_EXTERNAL, (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) void electron.shell.openExternal(url);
  });
  electron.ipcMain.handle(IPC.GITHUB_URL, (_e, cwd) => resolveGithubUrl(cwd));
  electron.ipcMain.handle(IPC.ACTIVITY_COMMITS, () => {
    const seen = /* @__PURE__ */ new Map();
    for (const s of manager.roster()) {
      if (s.status !== "active" || seen.has(s.cwd)) continue;
      seen.set(s.cwd, node_path.basename(s.cwd) || s.cwd);
    }
    return recentCommits([...seen].map(([cwd, name]) => ({ cwd, name })));
  });
  electron.ipcMain.handle(IPC.TRACKER_LAUNCH, async (_e, id) => {
    const s = manager.roster().find((x) => x.id === id);
    if (!s) return { ok: false, error: "Unknown project id." };
    const meta = await resolveLaunch(s.cwd);
    return launch(id, s.cwd, s.label, meta);
  });
  electron.ipcMain.handle(IPC.TRACKER_STOP, (_e, id) => stop(id));
  electron.ipcMain.handle(IPC.TRACKER_STATUS, () => status());
  const pushWorkspaces = () => {
    const list2 = store.getWorkspaces();
    broadcast(IPC.EVT_WORKSPACES, list2);
    rebuildAppMenu();
    return list2;
  };
  electron.ipcMain.handle(IPC.WORKSPACES_GET, () => store.getWorkspaces());
  electron.ipcMain.handle(IPC.WORKSPACE_CREATE, (_e, name) => {
    const { list: list2, created } = createWorkspace(store.getWorkspaces(), name, Date.now());
    store.saveWorkspaces(list2);
    pushWorkspaces();
    return created;
  });
  electron.ipcMain.handle(IPC.WORKSPACE_RENAME, (_e, p) => {
    store.saveWorkspaces(renameWorkspace(store.getWorkspaces(), p.id, p.name));
    return pushWorkspaces();
  });
  electron.ipcMain.handle(IPC.WORKSPACE_DESCRIBE, (_e, p) => {
    store.saveWorkspaces(describeWorkspace(store.getWorkspaces(), p.id, p.description));
    return pushWorkspaces();
  });
  electron.ipcMain.handle(IPC.WORKSPACE_DELETE, (_e, id) => {
    store.saveWorkspaces(deleteWorkspace(store.getWorkspaces(), id));
    manager.removeWorkspaceFromAll(id);
    if (activeWorkspace === id) setActiveWorkspace(null);
    return pushWorkspaces();
  });
  electron.ipcMain.handle(IPC.WORKSPACE_REORDER, (_e, ids) => {
    store.saveWorkspaces(reorderWorkspaces(store.getWorkspaces(), ids));
    return pushWorkspaces();
  });
  electron.ipcMain.handle(
    IPC.SESSION_SET_WORKSPACE_IDS,
    (_e, p) => manager.setWorkspaceIds(p.id, p.workspaceIds)
  );
  electron.ipcMain.handle(
    IPC.SESSION_ADD_WORKSPACE,
    (_e, p) => manager.addToWorkspace(p.id, p.wsId)
  );
  electron.ipcMain.handle(
    IPC.SESSION_REMOVE_WORKSPACE,
    (_e, p) => manager.removeFromWorkspace(p.id, p.wsId)
  );
  electron.ipcMain.handle(
    IPC.SESSION_MOVE_WORKSPACE,
    (_e, p) => manager.moveToWorkspace(p.id, p.fromId, p.toId)
  );
  electron.ipcMain.handle(IPC.SESSION_ARCHIVE, (_e, id) => manager.archiveSession(id));
  electron.ipcMain.handle(IPC.SESSION_DUPLICATE, (_e, p) => {
    manager.duplicateSession(p.id, p.wsId);
  });
  electron.ipcMain.handle(
    IPC.SESSION_DESCRIBE,
    (_e, p) => manager.setDescription(p.id, p.description)
  );
  const pushAgents = () => {
    const l = store.getAgents();
    broadcast(IPC.EVT_AGENTS, l);
    return l;
  };
  electron.ipcMain.handle(IPC.AGENTS_GET, () => store.getAgents());
  electron.ipcMain.handle(IPC.AGENT_UPSERT, (_e, a) => {
    const agent = a.id ? a : { ...a, id: makeAgentId() };
    store.saveAgents(upsertAgent(store.getAgents(), agent));
    return pushAgents();
  });
  electron.ipcMain.handle(IPC.AGENT_DELETE, (_e, id) => {
    store.saveAgents(deleteAgent(store.getAgents(), id));
    return pushAgents();
  });
  electron.ipcMain.handle(IPC.AGENTS_REORDER, (_e, ids) => {
    store.saveAgents(reorderAgents(store.getAgents(), ids));
    return pushAgents();
  });
  electron.ipcMain.handle(IPC.AGENT_RUN, (_e, p) => {
    const agent = store.getAgents().find((a) => a.id === p.agentId);
    const errRun = (error) => ({
      id: "",
      agentId: p.agentId,
      sessionId: p.sessionId,
      cwd: "",
      task: p.task,
      status: "error",
      output: "",
      startedAt: Date.now(),
      error
    });
    if (!agent) return errRun("Agent not found.");
    const s = p.sessionId ? manager.roster().find((x) => x.id === p.sessionId) : null;
    const cwd = s?.cwd ?? "";
    if (!cwd || cwd === node_os.homedir()) return errRun("Pick a session with a project folder to run against.");
    return agentRunner.run(agent, { sessionId: p.sessionId, cwd, task: p.task });
  });
  electron.ipcMain.handle(IPC.AGENT_RUN_CANCEL, (_e, runId) => agentRunner.cancel(runId));
  electron.ipcMain.handle(IPC.AGENT_SAVE_RESULT, async (_e, runId) => {
    const run2 = agentRunner.get(runId);
    if (!run2 || !run2.cwd) return { ok: false, error: "No result to save." };
    const agent = store.getAgents().find((a) => a.id === run2.agentId);
    const slug = (agent?.name ?? "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const stamp = new Date(run2.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, "");
    const dir = node_path.join(run2.cwd, "agents");
    const file = node_path.join(dir, `${slug}-${stamp}.md`);
    try {
      await promises.mkdir(dir, { recursive: true });
      await promises.writeFile(file, `# ${agent?.name ?? "Agent"} — ${run2.task || "run"}

${run2.output}
`);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  electron.ipcMain.on(
    IPC.SESSION_INPUT,
    (_e, p) => manager.input(p.id, p.data)
  );
  electron.ipcMain.on(
    IPC.SESSION_RESIZE,
    (_e, p) => manager.resize(p.id, p.cols, p.rows)
  );
}
if (!electron.app.requestSingleInstanceLock()) {
  isQuitting = true;
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => showWindow());
  electron.app.whenReady().then(() => {
    hydrateShellPath();
    store = new Store(node_path.join(electron.app.getPath("userData"), "crew-store.json"));
    recorder = new TranscriptRecorder(node_path.join(electron.app.getPath("userData"), "transcripts"));
    manager = new SessionManager(store, recorder, ensureCrewHookDir(electron.app.getPath("userData")));
    agentRunner = new AgentRunner((baseId) => {
      const p = getPreset(baseId);
      return p ? { command: p.command, args: p.args } : null;
    });
    agentRunner.on("run", (run2) => broadcast(IPC.EVT_AGENT_RUN, run2));
    assets = new AssetWatchers((id, list2) => broadcast(IPC.EVT_ASSETS, { id, assets: list2 }));
    applyLoginItem(store.settings.launchAtLogin);
    startUpdateChecks((info) => broadcast(IPC.EVT_UPDATE, info));
    electron.protocol.handle("crew-asset", async (request) => {
      try {
        const url = new URL(request.url);
        const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (!assets.has(path)) return new Response("Not found", { status: 404 });
        const body = await promises.readFile(path);
        return new Response(body, {
          headers: { "content-type": assetMime(path), "cache-control": "no-cache" }
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    registerIpc();
    rebuildAppMenu();
    createWindow();
    tray = new CrewTray({
      onShow: showWindow,
      onNewWindow: openWindow,
      onNewSession: openNewSession,
      onJump: jumpTo,
      onQuit: () => {
        void confirmQuit();
      }
    });
    wireManager();
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}
electron.app.on("before-quit", (e) => {
  if (isQuitting) {
    teardown();
    return;
  }
  if (quitConfirmDisabled()) {
    isQuitting = true;
    teardown();
    return;
  }
  e.preventDefault();
  void confirmQuit();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});

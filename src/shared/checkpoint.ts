// The "Save & park" broadcast preset: tells every selected agent to persist its
// work so the machine can be safely rebooted or shut down. Crew resumes sessions
// (and their conversations) on the next launch, so once each agent has committed
// its progress, a reboot loses nothing.
//
// IMPORTANT: keep this a SINGLE line. Broadcast input is written straight to the
// PTY, where an embedded newline reads as Enter and would submit the message
// early — splitting one instruction into several half-typed ones. Sentences are
// separated with "; " and numbered inline instead of with line breaks.
//
// Git policy is commit-only (never push): a park should be safe and offline, and
// these repos use a bespoke personal-token push flow an agent can't assume.
export const CHECKPOINT_PROMPT =
  'Checkpoint before I reboot my machine: 1) commit all work-in-progress to git ' +
  'with a clear message — do NOT push; 2) if a progress or TODO notes file exists, ' +
  'update it with the current status and the next steps; 3) reply with one line — ' +
  'the commit hash and what is next. Then stop and wait for my next message; do not ' +
  'start any new work.'

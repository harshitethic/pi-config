---
title: "Session-log hooks: guarded settle nudge in pi, prompt-time check in Claude Code"
type: decision
status: done
date: 2026-10-12
---

# Session-log hooks

**What:** `extensions/session-log/` wires tfd's `scripts/session_log.py hook …` into both harnesses. pi: `session_start`→`start`, `session_compact`→`compact`, `agent_settled`→`stop`, where a non-empty nudge starts one guarded turn. Claude Code: `SessionStart`→`start`/`compact` chosen by the hook input's `source`, and the `stop` check on `UserPromptSubmit`. Design: `docs/design/session-log-hooks.md`.

**Why:** the session log is the owner's window into a working session; keeping it current should not depend on asking. The tfd script owns the text and the policy, so the harness layers stay thin: run it, inject exactly what it printed.

**Refuting the obvious framing:** "Claude's Stop event is the natural place for the before-stopping nudge." Any Stop-hook output Claude can see — `additionalContext`, or `decision:"block"` — *continues the turn*. Claude Code documents `additionalContext` as the "working as designed" feedback channel, but it still runs the conversation with no human prompt. Decision 003 rejected exactly that mechanism for peer-link under Consumer Terms §3.7 / ordinary use; a log nudge has no claim to an exemption. Deferring the check to `UserPromptSubmit` costs one human turn and keeps the invariant. (tfd's design session confirmed it did not intend a turn-continuing Stop hook; the owner left the default to this side.)

**Alternatives considered:**

- **Claude `Stop` hook + `additionalContext`.** Rejected: auto-continuation, contra 003.
- **Claude `Stop` hook + `systemMessage`.** Rejected as the whole answer: it reaches the user, not the agent, and the agent is who appends the log. Nothing here precludes adding it later.
- **Injecting the start text at `before_agent_start` instead of at `session_start`.** Rejected: it would re-run the script and re-inject on every prompt, turning a once-per-session cost into a per-turn one.
- **Nudging on every `agent_settled` without a guard.** Rejected: a nudge starts a turn, so an unconvinced model would ping-pong (burning tokens) until some cap.

**Tradeoffs accepted:**

- pi's settle nudge starts one turn. An ignored nudge is not retried until the user prompts again; enforcement stays with tfd's `docs_validate`.
- Claude's stop nudge arrives with the next human prompt rather than at stop.
- Subagent sessions skip: a subagent is a worker, not the session the owner tracks, and the parent's check sees the same repo changes.
- The `stop` check is repo-wide over active logs: a change another session made but has not recorded yet will nudge this session too. That is the script's policy, not the harness's.

**Files changed:**

- `extensions/session-log/lib.ts` (new): walk-up script discovery, subprocess run, failure-as-empty.
- `extensions/session-log/index.ts` (new): pi extension.
- `extensions/session-log/external.ts` (new): Claude Code hook CLI.
- `tests/session-log.test.ts` (new): 22 tests.
- `docs/design/session-log-hooks.md` (new).
- `README.md`: extension bullet.
- `~/.claude/settings.json` (user config, outside this repo): `SessionStart` + `UserPromptSubmit` entries.

**References:**

- tfd contract: `tfd/docs/sessions/README.md`; script `tfd/scripts/session_log.py` (`d8a92461`, `stop` pointer-matching `ef211be3`).
- Claude Code hooks reference (fetched 2026-10-12): Stop decision control and `additionalContext`.
- `decisions/external-tools/003-claude-code-external-peer.md` (the compliance rule this reuses).

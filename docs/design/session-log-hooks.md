---
title: "Session-log hooks (Claude Code and pi)"
type: design
status: active
date: 2026-10-12
feature: session-log
---

# Session-log hooks (Claude Code and pi)

Keeps a working session's log (`tfd`'s `docs/sessions/`) current without the owner asking. A repo that carries `scripts/session_log.py` gets its log's state at session start and again after a compaction, and a nudge when the log needs reconciling or it is about to move on with decision/registry changes the log does not record. Everywhere else the hooks are silent.

The log is also the session's work list: `extensions/todo.ts` is retired (`decisions/todo/001`). Agents append events with `python3 scripts/session_log.py append --session <id> '<event line>'` — aligned, `ref: HEAD` becomes the commit's sha, and a malformed line or a new `check` error writes nothing (tfd `decisions/session-logs/005`) — and read state back with `summary --session <id> [--current]`; start and compact inject the full summary.

Code: `extensions/session-log/` — `lib.ts` (shared plumbing), `index.ts` (pi extension), `external.ts` (Claude Code hook CLI, not a pi extension). Decision: `decisions/external-tools/004-session-log-hooks.md`. Script contract: `tfd/docs/sessions/README.md`.

## Contract

`python3 scripts/session_log.py hook <start|compact|stop> --session <id> --harness <pi|claude-code> --cwd <session cwd>` prints the text to inject (empty only when `stop` finds nothing) and always exits 0. The harness passes its own session id, its name, and the session's working directory — the start text names all three when it asks the agent to open a log. The script finds a session's log by writer: the latest `adopt` event, else the `agent-session:` frontmatter (tfd `decisions/session-logs/003`).

| moment | tfd event | text |
|---|---|---|
| session start | `start` | the session's log and how to append to it (the `append` command), with its full `summary` (log errors included), or how to open or `adopt` one; then a count of other active logs and of logs with no clear current version across clones, pointing at `project --text` |
| after compaction | `compact` | the same text, prefixed with the script's "Context was compacted. Re-read your session log before continuing." |
| moving on with unrecorded changes | `stop` | the log's append-only and other-clone errors first, then changed decision/registry files no active log points at via `ref:` (tfd `decisions/session-logs/004`) |

Only repos carrying `scripts/session_log.py` participate: the helpers walk up from the session cwd, and an absent script, a missing interpreter, a timeout or a non-zero exit all read as "nothing to say". The start/compact text ends by pointing at `project --text`, the project view rendered for an agent: every session across clones with goal/area states and copy warnings, open registry rows, recent decisions. The script's stdout is injected verbatim (trailing whitespace trimmed) — no wrapper text, so the context cost is exactly the script's cost. A hook runs the script from the repo root but passes `--cwd` as the session's own directory; the `stop` check matches changed decision/registry files against the `ref:` pointers in every active log, so edits another session has already recorded stay quiet.

## pi (`index.ts`)

- `session_start` → `start`, injected as a custom message (`session-log`); it enters context immediately.
- `session_compact` → `compact`, injected the same way: mid-run it queues ahead of the next LLM call, idle it simply sits in context after the compaction entry.
- `agent_settled` → `stop`. A non-empty nudge starts one turn (`triggerTurn`), because pi would otherwise sit idle until the user typed. Once nudged, the session is quiet for the rest of the turn: further settles neither run the hook nor start another turn. The guard clears at the next user prompt or session start (pi emits `before_agent_start` only for user prompts, not for extension-triggered turns — the re-arm depends on that). An ignored nudge is not retried — enforcement is tfd's `docs_validate`, not this hook. In a one-shot `pi -p` session the harness disposes as soon as its run settles, so the nudge turn is best-effort there; the start and compact injections are unaffected.
- Subagents (`PI_SUBAGENT_DEPTH` set) skip entirely: the top-level session owns the log, and its own check sees the same repo changes.

## Claude Code (`external.ts`)

Merge into the `hooks` block of `~/.claude/settings.json` (keep the peer-link hooks):

```json
"SessionStart": [
  { "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/session-log/external.ts hook session-start" }] }
],
"UserPromptSubmit": [
  { "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/session-log/external.ts hook prompt" }] }
]
```

- `SessionStart` (`hook session-start`): `start`, or `compact` when the hook input's `source` is `"compact"`. A matcherless entry fires for every source.
- `UserPromptSubmit` (`hook prompt`): runs the `stop` check and adds its text to the prompt as context.

The stop check deliberately rides the user's prompt, not Claude Code's `Stop` event. Any Stop-hook output Claude can see (`additionalContext`, `decision:"block"`) *continues the turn*; that is the mechanism `decisions/external-tools/003-claude-code-external-peer.md` rejected ("nothing starts a Claude turn"; Consumer Terms §3.7 / ordinary use). Waiting costs one human turn and loses nothing material: the next prompt is when someone can act on the nudge.

## Invariants

- Never break the session: every failure mode reads as empty output, and handlers swallow errors.
- Inject exactly the script's stdout, nothing else.
- No hook work outside a repo that carries the script.

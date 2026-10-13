---
title: "Retire the todo extension — the session log is the work list"
type: decision
status: done
date: 2026-10-13
---

# Retire the todo extension

**What:** `extensions/todo.ts` — the `todo` tool, its widget and `/todos` — is gone, with its tests (`tests/todo-injection.test.ts`, `tests/todo-render.test.ts`) and its doc (`docs/todo-injection-fix.md`). Repos without a session log get no replacement. No event mirroring and no `session_log.py append`: agents append log events directly. Prompt text that told agents to use the tool now points at the session log's state query (`extensions/modes.ts`, `agents/bug-triage.md`).

**Why:** the owner's ruling (2026-10-13): sessions wrote to the list but never read it back or kept it current. The session log already records goals, areas, questions and commits, and tfd answers "where is this session?" from it; a second work-list mechanism only drifts.

**Refuting the obvious alternative:** "keep `todo.ts` as a fallback for repos without a session log." A list nothing reads back is the failure being removed, and a per-repo fallback doubles the instruction text again. The owner accepted no replacement where there is no log.

**Alternatives considered:**

- **View-from-log** — the tool as a controller over the log's open chunks, reading the log and appending through a new `session_log.py append`. Rejected: the log is the work list itself; agents append events with their normal editing tools, so no append subcommand, no second parser in pi-config, no step-level shadow list.
- **Mirroring todo actions as log events** — same rejection; the mutable local queue stays as a second source.
- **Keeping the widget fed by `summary --session <id>`** — the widget's only feed was the local list, and the log's summary shows the same state on demand.

**Tradeoffs accepted:**

- No widget, no `/todos`; a session's work items are log events, and step-level detail lives in the plan doc those events point at.
- Repos without `scripts/session_log.py` lose the tool with no replacement (owner's call).
- tfd carries the load: `close C<n>`/`close G<n>` and `summary --session <id> [--current]` (tfd `decisions/session-logs/002`).

**Files changed:** `extensions/todo.ts`, `tests/todo-injection.test.ts`, `tests/todo-render.test.ts`, `docs/todo-injection-fix.md` (removed); `extensions/modes.ts` and `agents/bug-triage.md` (instruction text), `docs/design/session-log-hooks.md` (the log as work list), `tests/setup.sh` (stale example), `docs/investigations/structure-trend.md` (snapshot), this record + README.

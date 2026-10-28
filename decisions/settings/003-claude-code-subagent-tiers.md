---
title: "Claude Code subagents default to Haiku; Opus is escalation"
type: decision
status: done
date: 2026-10-10
---

# Claude Code subagents default to Haiku; Opus is escalation

**What:** Claude Code (2.1.296) routes delegated work by agent definition in `~/.claude/agents/`
plus two keys in `~/.claude/settings.json`:

| Agent | Model / effort | Use |
|---|---|---|
| `worker` | Haiku 5.5, medium | Default for all delegated work; the caller passes `effort: "high"` for long multi-step work, strict instruction following, careful reasoning, or a retry after an early stop |
| `worker-opus` | Opus, medium | After a Haiku run performed poorly or got stuck; up front only for a genuinely complicated reasoning investigation |
| `scout` | Haiku 5.5, medium, read-only | Codebase search (replaces Explore) |

- `env.CLAUDE_CODE_SUBAGENT_MODEL = "haiku"` puts the built-ins (`general-purpose`, `claude`) on
  Haiku too. Per-invocation `model` still overrides it (verified: `worker` + `model: opus` → Opus).
- `permissions.deny: ["Agent(Explore)"]`: on a subscription, Explore runs on Opus and ignores
  `CLAUDE_CODE_SUBAGENT_MODEL`.
- The routing policy, including "avoid forks", lives in the agent `description`s (read when an
  agent is picked) and in a Claude Code section of `~/.claude/CLAUDE.md`. That file is now a real
  file that `@`-imports `APPEND_SYSTEM.md`, not a symlink to it, so the shared rules keep one source
  and pi never sees the Claude-only section. The CLAUDE.md section also tells the session to
  delegate without being asked, overriding Claude Code's built-in "only when the user asks" default.
  Steps that depend on each other are still delegated, one after another. Work is done inline only
  when writing the brief would cost more than doing it.

Verified headless: `worker`, `worker` at high effort, `scout`, `general-purpose` → `claude-haiku-5-5`;
`worker-opus` → `claude-opus-5-5`; Explore → permission denial.

**Why:** Haiku 5.5 at medium handles agentic coding (Anthropic's prompting guide gives medium as its
default, with high for longer agent tasks and strict instruction following), at a fraction of Opus
cost. The Haiku agents' prompts adopt the guide's two fixes for the failure modes it documents
under long system prompts: early stopping ("keep working until done") and unchecked "done" claims
("run a real check that exercises the change"). They also tell the agent to report "stuck at X
because Y" rather than guess, so the orchestrator can see when to escalate. `worker-opus` omits the
verification paragraph, because the Opus 5 guide reports that verification instructions cause
over-verification.

**Alternatives rejected.**
- *`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`*: also moves Explore to Haiku, but it forces every
  subagent to the one model, which blocks the Opus escalation path.
- *Separate `worker-high` agent*: needed before 2.1.292, which added per-call `effort`; now it
  duplicates `worker`.
- *Forks for delegated work*: a fork runs on the parent's model (Opus) and can't be moved to Haiku.
  Keep forks for tasks that need the full conversation.
- *Policy in `APPEND_SYSTEM.md`*: pi also reads it (`~/.claude/CLAUDE.md` is a symlink to it), and
  these agent names and fork semantics are Claude Code only. A pathless `~/.claude/rules/` file is
  warned about and skipped by pi (`docs/design/rules.md`).

**Tradeoffs:** Explore's built-in search prompt is lost; `scout` is a short replacement. `Plan`
(plan mode) still inherits the main model. The keys are mirrored in `settings.standard.json` so
`switch-config.sh standard` keeps them.

**Reopening triggers:** Haiku runs needing Opus escalation for routine tasks → raise `worker`'s
default effort, or re-tier. Explore gains a model override that honours the env var → drop the deny
and `scout`.

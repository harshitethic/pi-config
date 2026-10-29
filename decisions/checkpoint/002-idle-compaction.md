---
title: "Idle compaction fires before the prompt cache expires, not after"
type: decision
status: active
date: 2026-10-29
---

# Idle compaction fires before the prompt cache expires, not after

**Ruling.** `extensions/auto-checkpoint.ts` compacts a settled session when
context ≥ threshold and it has been idle `0.9 × cacheTtlMs`; `cacheTtlMs` is a
config value per model, defaulting to Anthropic's 5 min. `idleCompaction: false`
or `cacheTtlMs: 0` disables it. The timer arms on `agent_settled`, is cancelled
by `turn_start`/`before_agent_start`, and is re-checked at fire time (idle, no
queued input, still above threshold). Interactive (`tui`) sessions only.

**Why before expiry.** The summarization request is the one call that must read
the entire context; before expiry it reads at cache-read price, after expiry at
the full input price — the exact cost the feature exists to avoid. Compacting
after expiry therefore cannot beat doing nothing for the first resumed turn, and
only wins if the session continues several turns. Claude Code uses the same
shape: 54 minutes of a 1 h cache, ≥200k tokens.

**Why a TTL knob rather than a fixed idle window.** Cache lifetimes differ by
more than an order of magnitude: Anthropic 5 min (1 h with `ttl: "1h"`),
DeepSeek's disk cache "a few hours to a few days", z.ai and MiMo publish no TTL.
A fixed 5-minute window would compact a DeepSeek session whose cache was still
warm hours later, losing detail for no saving. The repo config sets DeepSeek
(`deepseek*`) to 3 h — the low end of its documented range; GLM and MiMo stay on
the default because assuming a short TTL errs toward cheap summaries.

**Why TUI only.** Subagent and RPC sessions are settled between commands their
driver may issue at any moment; compacting under one would summarize context
that driver is still using. Claude Code also requires an interactive terminal.

**Rejected:** a model-driven nudge ("consider checkpointing when idle") — the
extension already nudges on threshold crossings, and an idle session has no model
turn in which to act on it. A fixed idle window with no TTL notion — see above.
Compacting after expiry — pays full price for the summary read.

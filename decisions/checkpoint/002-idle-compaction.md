---
title: "Idle compaction fires before the prompt cache expires, not after"
type: decision
status: active
date: 2026-10-29
---

# Idle compaction fires before the prompt cache expires, not after

**Ruling.** `extensions/auto-checkpoint.ts` compacts a settled session when
context ≥ threshold and it has been idle `0.9 × cacheTtlMs`. `idleCompaction:
false` or `cacheTtlMs: 0` disables it. The timer arms on `agent_settled`, is
cancelled by `turn_start`/`before_agent_start`, and is re-checked at fire time
(idle, no queued input, still above threshold). Interactive (`tui`) sessions
only.

**Model identification.** A config pattern is matched against `model.id` *and*
`provider/model.id`, case-insensitively, first match wins. `deepseek*` therefore
covers `deepseek-v4.1-flash` through opencode-go and
`deepseek/deepseek-v4-pro` through openrouter; `opencode-go/*` or `z.ai/*` scope
a whole route. Thresholds and every other per-model field use the same matcher.

**TTL resolution.** `FAMILY_CACHE_TTL_MS` holds documented lifetimes keyed by
family token (any version, any route): DeepSeek 3 h — the low end of "a few
hours to a few days" (api-docs.deepseek.com/guides/kv_cache) — and Claude /
Anthropic 5 min, the default that only rises to 1 h when the request asks for
`ttl: "1h"`. Everything else gets `cacheTtlMs`, default **1 h**. A config
`models` entry beats both.

**Why before expiry.** The summarization request is the one call that must read
the entire context; before expiry it reads at cache-read price, after expiry at
the full input price — the exact cost the feature exists to avoid. Compacting
after expiry therefore cannot beat doing nothing for the first resumed turn, and
only wins if the session continues several turns. Claude Code uses the same
shape: 54 minutes of a 1 h cache, ≥200k tokens.

**Why 1 h for an unknown family.** The documented lifetimes span 5 min to days,
and z.ai and MiMo publish none. Guessing short compacts sessions whose cache was
still warm (detail lost for a summary that cost pennies); guessing long can pay
the full input price for the summary read. An hour sits between the extremes and
matches the session lengths this repo actually has. 5 min would be wrong here:
it is Anthropic's number, Claude is not used through pi, and it is the outlier.

**Why TUI only.** Subagent and RPC sessions are settled between commands their
driver may issue at any moment; compacting under one would summarize context
that driver is still using. Claude Code also requires an interactive terminal.

**Rejected:** per-provider TTL tables (the cache belongs to the model vendor,
not the route — the same DeepSeek cache serves requests whichever gateway they
arrive through); version-numbered patterns (`deepseek-v4.1-*`) that go stale on
each release; matching `model.name` (display text, unstable); a fixed idle
window with no TTL notion; compacting after expiry (pays full price for the
summary read); a model-driven idle nudge (an idle session has no model turn in
which to act on it).

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

**TTL resolution.** `FAMILY_CACHE_TTL_MS` holds lifetimes that are documented
as *facts*, keyed by family token (any version, any route): Claude / Anthropic
5 min, rising to 1 h only when the request asks for `ttl: "1h"`. Everything else
gets `cacheTtlMs`, default **1 h**. A config `models` entry beats both.

DeepSeek is deliberately not in that table, on any route. Its docs say the cache
"works on a best-effort basis" and is cleared "usually within a few hours to a
few days" (api-docs.deepseek.com/guides/kv_cache) — a typical range, not a
minimum — and OpenCode Go's DeepSeek route publishes no lifetime of its own (its
inference docs only report `cache_read` / `cache_write_5m` / `cache_write_1h`
accounting, and the Go price list mirrors DeepSeek's own peak/off-peak rates, so
the cache is DeepSeek's with no added guarantee). "Usually hours" is not "always
more than an hour", so DeepSeek runs the 1 h default too. Do not raise it
without evidence of a floor.

**What the user sees.** pi already renders compaction itself: a
`Compacting context…` status indicator (with the interrupt hint), then the
transcript rebuilt around the compaction summary block. That covers "it
happened", not "it happened while you were away". Idle compaction therefore
writes a durable, TUI-only marker on completion — `pi.appendEntry` plus a
`registerEntryRenderer`, which never enters LLM context — reading
`compacted while idle — 312,400 tokens (29.8%) after 54 min idle`. A toast
(`ui.notify`) is useless for this: by definition the user is not watching. The
idle path is the only place a marker is added; threshold/overflow/`/compact`
compaction keeps pi's own presentation.

**Why before expiry.** The summarization request is the one call that must read
the entire context; before expiry it reads at cache-read price, after expiry at
the full input price — the exact cost the feature exists to avoid. Compacting
after expiry therefore cannot beat doing nothing for the first resumed turn, and
only wins if the session continues several turns. Claude Code uses the same
shape: 54 minutes of a 1 h cache, ≥200k tokens.

**Why 1 h rather than a family guess.** The documented lifetimes span 5 min to
days, and only Anthropic publishes a number that binds. Guessing short compacts
sessions whose cache was still warm (detail lost for a summary that cost
pennies); guessing long can pay the full input price for the summary read — but
guessing a family long on a *typical range* rather than a floor silently assumes
the case we cannot verify. One hour is the assumption we can defend for every
route we use, and it matches the session lengths this repo actually has. 5 min
would be wrong: it is Anthropic's number, Claude is not used through pi, and it
is the outlier.

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

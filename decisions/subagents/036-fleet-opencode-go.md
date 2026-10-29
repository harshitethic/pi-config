---
title: "DeepSeek fleet rides the OpenCode Go plan quota — seats off OpenRouter first-party"
type: decision
status: done
date: 2026-10-18
---

# DeepSeek fleet → `opencode-go/deepseek-v4.1-flash` (plan quota)

**What:** Every DeepSeek seat moves from OpenRouter to OpenCode Go (owner directive, 2026-10-18):
implement `:high`, orchestrator `:max`, oracle `:max`, scout-code/scout-web `:low` (frontmatter),
plus compaction and the no-frontmatter fallback via `FLEET_PROVIDER`/`FLEET_MODEL`. Seat split and
effort levels are unchanged (022's audit survives — the SKU supports the same `low/high/max` map).
The three MiMo reviewer seats stay on OpenRouter's Xiaomi first-party pin (023). `models.json`
keeps both OpenRouter pins: `xiaomi/mimo-v2.6-flash` (reviewers) and
`deepseek/deepseek-v4.1-flash-1017` (the 1017 checkpoint stays reachable for manual main-session
use, still first-party-guarded).

**Why:** the plan quota, not a token discount — OpenCode Go's per-token prices match DeepSeek
first-party's list ($0.15/$0.60 off-peak, $0.003 cache-read). V4.1 Flash is the plan's most
usage-generous DeepSeek bucket: **$80/month of list-price usage on Go ($10), $160/month on Go
Plus ($40)**, ~34,670 est. requests/5h (69,330 Plus). The $15 buckets are the trap — DeepSeek V4
Pro, GLM-5.3, MiMo V2.6/V2.5-Pro, Luna, Haiku 5.5, Grok 4.7, Qwen3.8 Max, Kimi K3 all give only
$15/month (Go) — and no fleet seat touches any of them; V4.1 Flash avoids the trap by
construction. Full 29-model table (2026-10-18): opencode.ai/v2/docs/console/go.

**Routing consequence (031 interplay):** top-level orchestrators inherit the caller's model, and
`settings.json` defaults to `opencode-go/glm-5.3-flash` — so orchestration traffic rides the
GLM-5.3-Flash bucket ($60/mo, 6,320 req/5h), *not* GLM-5.3's $15 bucket; the DeepSeek bucket
serves implement/oracle/scout/compaction volume. Orchestrator frontmatter stays the level donor.

> **Clarified (2026-10-22, owner):** the main session is owner-managed — its model is a manual
> per-session `/model` choice, and the `settings.json` default is only the initial value. The
> GLM-5.3-Flash line above records the 2026-10-18 setting (stale now in any case), not a
> standing assignment.

**Tradeoffs accepted:**
- **022's first-party-unquantized pin is abandoned for fleet traffic.** OpenCode Go's DeepSeek
  upstreams (observed 2026-10-18 via `x-opencode-upstream-model-id`: `orcarouter` →
  OpenRouter's `deepseek/deepseek-v4.1-flash` slug; `luminal` → `deepseek-ai/DeepSeek-V4.1-Flash`)
  do not advertise unquantized first-party weights, and which host serves is router-chosen. The
  benchmarks 022/035 measured may no longer describe exactly what runs. The `-1017` slug remains
  the fidelity escape hatch via OpenRouter when a seat or session needs it.
- **Peak windows burn quota 2×** (01:00–04:00, 06:00–10:00 UTC weekdays; token prices double,
  bucket unchanged) — heavy weekday-morning fleet work eats the $80 bucket twice as fast.
- **One gateway dependency, and it can be flaky:** transient upstream "Invalid credential"
  failures observed 2026-10-18 morning (resolved within hours; OpenCode Go's upstream credential,
  not our request shape — probes with pi's exact client shape succeeded after recovery). No
  fallback routing exists on this provider; failures are loud, consistent with 022's stance.
- **ZDR/provenance:** DS models on Go are "not used for training", 0-day retention; the ZDR
  agreement renews monthly (valid through 2026-10-31 at fetch time).

**Supersedes:** 022's OpenRouter-only routing for the DeepSeek seats (routing only — the effort
audit, seat split, and reviewer pins stand); 035's OpenCode Go addendum is moot in its
scout-sweep form (seat deleted same day) except its catalog hand-merge note.

## Rollback

`git revert` of this commit restores the five frontmatter lines, `FLEET_PROVIDER`/`FLEET_MODEL`
and the doc rows to the OpenRouter 1017 state.

**Files changed:** `agents/{implement,orchestrator,math-algo-oracle,scout-code,scout-web}.md`
(model lines), `extensions/lib/fleet-model.ts` (provider + model constants),
`tests/subagent-model-inheritance.test.ts` (fleet-slug literals), `README.md`,
`docs/TODO.md`, `docs/thinking-levels.md`, `docs/model-role-scores.md`, decisions index,
supersession line on 035, this decision.

**Verification:** `bun test tests/subagent-model-inheritance.test.ts` — its live-spawn tool-boundary
tests exercise a real `opencode-go/deepseek-v4.1-flash:high` implement spawn (meta.json + child
argv), so the suite doubles as the E2E of the new route.

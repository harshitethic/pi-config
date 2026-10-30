---
title: "Reviewer tier → opencode-go/glm-5.3-flash; oracle → opencode-go/deepseek-v4-pro — plan-quota seat repick"
type: decision
status: done
date: 2026-10-18
---

# Seat repick on the OpenCode Go menu (037)

**What:** Two seat changes after the model-tiers/003 scorechart (owner rulings,
2026-10-18). The implementer stays on `opencode-go/deepseek-v4.1-flash:high` — the
DS bucket ($160/mo on Go Plus) is sized for the fleet's largest volume seat and the
owner explicitly keeps it there. Orchestrator tracks the caller's model (031) with
the owner trialing `step-5-preview` manually — no config change.

1. **Reviewers ×3 → `opencode-go/glm-5.3-flash:high`.** The 023 reviewer seat
   (MiMo V2.6 Flash) scored 40/40 on the 2026-10-18 scorechart — the weakest
   reviewer row on the Go menu. GLM-5.3-Flash: 65.4/62.2 (~25-pt upgrade), $0.016/M
   blended (3.4× cheaper than MiMo-V2.6-Pro's $0.055), $60 bucket (vs Pro's $15 —
   at 2+ review sessions per implementation the Pro bucket binds; GLM-Flash's is
   effectively inexhaustible), 6,320 req/5h. Zhipu lab keeps reviewer↔implementer
   decorrelation (DeepSeek implementer). Qwen3.8 Flash (66.8/63.6, $30 bucket) was
   the runner-up — within noise on scores, 2.5× the token cost, half the bucket.
   **Watch item:** GLM-5.3-Flash's hallucination rate is unmeasured — the judge-seat
   risk 017 named; mitigations are the prove-each-finding and citation-validation
   rules already in the reviewer prompts; observable is verdict quality on the next
   gated tasks. With the reviewer tier off Xiaomi, the `models.json` MiMo pin is
   pruned (dead config); the `deepseek/deepseek-v4.1-flash-1017` pin remains
   (manual main-session escape hatch, first-party-guarded).

2. **Oracle → `opencode-go/deepseek-v4-pro:max`.** Its 91.9 hard/algo composite is
   the only solid math/algo row on the menu (LCB 93.5 / IMO-HMMT 89.8); the
   "planning-weak" flag (008) doesn't bind on a pure math/algo seat. The seat is
   rare and low-volume, so V4 Pro's $15 Go bucket ($60 Plus) and 1,050 req/5h fit —
   and it stops sharing the implementer's $160 bucket with a `:max` seat. The
   1017-vendor-card story (022's basis) is unmeasured granular; V4 Pro is the
   measured pick.

**Bucket map after 037:** implementer+scouts+compaction → DS V4.1 Flash $160/mo;
reviewers → GLM-5.3-Flash $60/mo; oracle → DS V4 Pro $15/mo (Plus); user session +
orchestrators → owner's choice (step-5 trial, $60/mo bucket). No $15-trap collision
except the oracle's, which is volume-appropriate.

> **Note (2026-10-18, [model-tiers/004](../model-tiers/004-monthly-cap-only-cost-metric.md)):** cost is
> evaluated on monthly caps only; the request-rate figures above are informational, and rate-cap
> tiebreakers in this rationale carry zero weight going forward.

**Supersedes:** 023's Xiaomi-lab reviewer experiment (the decorrelation axis is
preserved — Zhipu vs DeepSeek — but the Xiaomi premise and its `models.json` pin
are gone); 036's oracle seat (V4.1 Flash → V4 Pro).

## Rollback

`git revert` of this commit restores the four model lines and the `models.json` MiMo pin.

**Files changed:** `agents/review-{code,plan,tests}.md`, `agents/math-algo-oracle.md`,
`models.json`, `docs/model-role-scores.md`, `docs/thinking-levels.md`, `README.md`,
decisions index, supersession footnote on 023, this decision.

**Verification:** `bun test tests/subagent-model-inheritance.test.ts` (seat resolver
pins unaffected — reviewer seats aren't resolver inputs; run confirms no drift), plus
the next gated implementation records reviewer spawns on `opencode-go/glm-5.3-flash:*`
in their `meta.json`.

---

> **Addendum (2026-10-22, [decision 041](041-glm-review-seats-openrouter.md)):** item 1's provider is
> superseded — the three review seats now run `openrouter/z-ai/glm-5.3-flash:high` (off OpenCode Go
> extra-usage billing). The model, the `:high` level, the 037 rationale and the Zhipu-vs-DeepSeek
> decorrelation are unchanged; item 2 (oracle) stands.

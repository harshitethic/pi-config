---
title: "Go plan allowance is shared + weighted — per-model figures are solo capacity, not buckets"
type: decision
status: done
date: 2026-10-18
---

# Shared normalized allowance (mechanism correction to 004's framing)

**Finding (verified 2026-10-18, source + vendor support):** OpenCode Go does **not** enforce
per-model monthly buckets. All paid models draw from **one shared normalized allowance**;
each request costs `round(cost × costMultiplier)` against a single per-workspace counter,
where `costMultiplier = planWideLimit ÷ listedLimit_m`. The per-model monthly figures
($160 DS-Flash, $180 GLM-Flash, $60 MiMo-Pro, … on Go Plus) answer only "how much of this
one model alone could you burn with the whole allowance".

Evidence: opencode `packages/console` — `validateBilling` accumulates into one `LiteTable`
row per workspace+user; `getModelQuotaLimit(planWideLimit, multiplier)` derives the displayed
per-model figures. Vendor support, quoted publicly in
`github.com/anomalyco/opencode#54875`: "The 'Monthly limit' for each model is how much of
that model alone you could use with the full allowance. It is not a separate budget for
that model."

**The meter:** plan-wide monthly consumption = `Σ (real$ on model m ÷ listedLimit_m)`,
capped at 1.0 (the plan-wide constant cancels — Go's is $60 normalized; Go Plus's is
unpublished and unneeded). `/zen/go/v1/usage`'s monthly % is this meter server-side.

**Enforcement at the limit:** HTTP 429 hard block until the window resets — no grace margin,
no throttle, no overage billing. Optional console "Use balance" falls back to pay-as-you-go
credits instead of blocking. The 5h window is an **anchored reset** (cleared only when the
last update ages out), not a sliding window.

**What this corrects:**
- 036's "three separate buckets" and any additive headroom arithmetic (including
  2026-10-18's seat-sustainability analysis: per-model capacities do not sum; a seat can be
  simultaneously "under its bucket" and the reason the plan 429s).
- "What happens at bucket exhaustion is unknown" — settled: 429 until reset.

**What survives 004 unchanged:** effective monthly volume (listedLimit ÷ blended $/M) is
exactly "tokens of this model per full allowance" — still the right seat-pick comparison,
and bigger remains better. The correction is only to *aggregation*: compare models with it,
but judge a fleet's sustainability against the shared meter, weighted by `1 ÷ listedLimit`.
Practical consequence: tokens on a $60-listed model weigh 3× a $180-listed model per real
dollar; per raw token the gap widens further with the burn rate (MiMo-Pro ≈ 18× GLM-5.3-Flash
at observed cache-heavy mix).

**Files changed:** this record, `decisions/model-tiers/README.md`, `docs/model-role-scores.md`
(cost-methodology note), `docs/TODO.md` (bucket wording). Measurement tool
(`docs/data/seat_burn.py`, WO-2026-053) reports the meter.

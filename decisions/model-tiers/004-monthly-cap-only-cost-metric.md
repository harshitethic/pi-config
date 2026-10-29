---
title: "Cost evaluation = monthly cap only; request-rate caps carry zero cost weight"
type: decision
status: done
date: 2026-10-18
---

# Monthly-cap-only cost metric (owner ruling)

**Ruling (owner, 2026-10-18):** when evaluating cost for model-seat picks on the
OpenCode Go plans, **the monthly cap is the only dimension that counts**. Do not
weight 5h (or weekly) request caps as a cost factor, and do not convert them into
monthly-equivalents — even though they don't divide neatly into monthly.

**The metric:**
- *Effective monthly volume* = monthly per-model $ bucket ÷ blended burn rate
  (the pipeline's $/M figure, 95/5 I/O at ~98% cache). Bigger = more work per month.
- *Burn rate* ($/M) is the per-unit-work cost; two models doing the same session
  consume allowance in proportion to it.

**What request caps are:** rate limits (speed, not spend). They may still be noted
for operability — a 110 req/5h model throttles heavy parallel days — but with zero
weight in any cost comparison, score, or tiebreaker.

**Why:** rate caps don't aggregate into monthly consumption in any predictable way
(their interaction with workload shape is incidental), so weighting them mixes an
operational concern into a cost judgment and mis-ranks options. The MiMo-V2.6-Pro
vs GLM-5.3 comparison is the worked example: GLM-5.3's nominal $120 bucket looks
2× bigger, but at 4.3× the burn rate its effective monthly volume is ~513M tokens
vs MiMo-Pro's ~1,090M — monthly-cap economics alone picks MiMo-Pro.

**Rejected:** blended scoring that treats 5h/weekly caps as fractional cost (e.g.
"cap × windows/month"); the arithmetic implies a monthly conversion the owner
explicitly does not want made.

**Scope:** cost evaluation for seat picks and scorecharts. Does not change what is
*fetched or displayed* — rate limits stay informational columns in
`docs/model-role-scores.md`. Supersedes any rate-cap cost reasoning in 037's bucket
map and the 2026-10-18 recommendation tables ("request headroom" tiebreakers).

**Files changed:** `docs/model-role-scores.md` (cost-methodology note), decisions
index, this decision. No pipeline change (`role_scores.py` cost axis was already
pure $/M).

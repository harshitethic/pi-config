---
title: "Main session → opencode-go/glm-5.3-flash; multi-session orchestrator split (meter-driven)"
type: decision
status: done
date: 2026-10-18
---

# Main-session seat on the shared allowance (038)

**What (owner ruling, 2026-10-18):** the main session flips back to
`opencode-go/glm-5.3-flash` (fleet-table row updated same day; settings change rode the
settings WIP). This fills 037's "user session + orchestrators → owner's choice" placeholder.

**Driver:** [model-tiers/005](../model-tiers/005-shared-allowance-not-buckets.md) (one shared
weighted allowance, meter = `Σ real$ ÷ listedLimit`) + the first `seat_burn.py` window
(Oct 17–18, WO-2026-053): session+orchestrator traffic was 31.7% of raw tokens but 50.2% of
list-$ and **76% of the plan meter**, because MiMo-V2.6-Pro tokens weigh ~18× GLM-5.3-Flash
per raw token against the meter. The session seat was the dominant meter term, so it moves
to the lightest per-token model on the menu. MiMo-V2.6-Pro stays available as a manual
per-session choice where its capability is worth the weight.

**Orchestrator split across sessions (owner proposal, endorsed):** the main-session default
(`settings.json`) is now GLM-5.3-Flash; a session can override per-session via `/model`.
Topology (owner, 2026-10-18): this pi-config session runs GLM-Flash; the **two TFD main
orchestrator sessions** split one on MiMo-V2.6-Pro, one on GLM-5.3-Flash. Via [031](README.md)
each session's orchestrator inherits its caller's model, so the split falls out for free:

- **GLM-Flash mains** → routine coordination, research dispatch, doc/mechanical
  orchestration, and everything whose subagents do the heavy lifting (implementers and
  reviewers sit in agent frontmatter regardless of caller).
- **MiMo-Pro main** → orchestration where the *orchestrator's own* planning/IF reasoning
  is the bottleneck (hard decomposition, math/algo-adjacent work). The
  `deepseek-v4-pro:max` oracle seat is spawnable from any session.

The allowance is workspace-wide, so all three mains (plus this one) draw the same meter —
`seat_burn.py` reads the shared session store and records the model per message, so the
Oct-21 recheck captures the split's effect automatically.

**Watch:** GLM-5.3-Flash has no measured orchestrator score — 037 picked it for *judging*
review seats; orchestrator duty is planning/IF. If planning quality dips on the GLM session,
the promotion path is `glm-5.3` (full). Its Go Plus listed limit is unrecorded
(`seat_burn.py` price table has no solo-capacity row) — resolve via the OpenCode support
email already queued (Go Plus plan-wide constant, GLM-Flash cache-read price, MiMo-Pro price).

**Measurement:** the TODO recheck now measures the post-flip mix — run
`python3 docs/data/seat_burn.py --since 2026-10-19` (first full days on the new seat) and
compare session meter share against the pre-flip 76%. The 037-era thresholds (session+orch
share >20% of tokens or projected meter >70% → move the seat) are discharged by this flip;
the open question shifts from "is the fleet sustainable" to "does GLM-Flash hold the
planning seat".

**Files changed:** this decision, `decisions/subagents/README.md`, `docs/TODO.md`.

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

> **Clarified (2026-10-22, owner):** "our main session model is just set by me switching
> manually" — the main session is owner-managed, a per-session `/model` choice;
> `settings.json`'s `defaultModel`/`defaultThinkingLevel` are only the initial value. Read
> "main-session default" below as the initial value, not a pinned seat; the split's
> mechanics (031 orchestrator inheritance) are untouched.

**Driver:** [model-tiers/005](../model-tiers/005-shared-allowance-not-buckets.md) (one shared
weighted allowance, meter = `Σ real$ ÷ listedLimit`) + the first `seat_burn.py` window
(Oct 17–18, WO-2026-053): session+orchestrator traffic was 31.7% of raw tokens but 50.2% of
list-$ and **76% of the plan meter**, because MiMo-V2.6-Pro tokens weigh ~18× GLM-5.3-Flash
per raw token against the meter (**magnitude superseded 2026-10-18, later:** the published
Go cache prices collapse this to **1.7×** — GLM-Flash cache-read is $0.03/M, MiMo-Pro's
$0.003625; see [model-tiers/005](../model-tiers/005-shared-allowance-not-buckets.md). The
seat moves stand on direction — GLM-Flash is still the lighter meter weight, and keeping
MiMo concentrated in one seat still right — but they buy 1.7×, not 18×. The session seat
was still the dominant meter term at the old MiMo mix; post-flip the largest consumer is
collective GLM-Flash volume, watched at the recheck.). The session seat was the dominant meter term, so it moves
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
the promotion path is `glm-5.3` (full). Its Go Plus solo limit is **$120**
(qcode.cc, updated 2026-10-15 — third-party single-source). The support email's remaining
open items are now just the Go Plus plan-wide constant and confirmation of the Plus
per-model figures (prices resolved from the console docs table, `model-tiers/005`).

**Measurement:** the TODO recheck now measures the post-flip mix — run
`python3 docs/data/seat_burn.py --since 2026-10-19` (first full days on the new seat) and
compare session meter share against the pre-flip 76%. The 037-era thresholds (session+orch
share >20% of tokens or projected meter >70% → move the seat) are discharged by this flip;
the open question shifts from "is the fleet sustainable" to "does GLM-Flash hold the
planning seat".

**Seat assignment (2026-10-18, delegated by owner — both TFD mains answered a workload
questionnaire):** the **tfd mainline-integrator session switches to GLM-5.3-flash** — ~70%
routing/dispatch/bookkeeping (gate merges, probe verification, peer routing, WO drafting +
queue sequencing), no owned design. The **tfd-d session keeps MiMo-V2.6-Pro** — it owns the
week's decomposition islands (44-site C8/C9 conversion, phase-C checker re-write) and gates
algorithmic compiler diffs (WO-211 switch lowering, 212 tail-graph keys, 214 arena escape,
215 arena-table oracle), where a weak gate silently passes a miscompile; its own conditional
("if the other seat's week is triage churn, give it GLM") matched. Mitigation for the tfd
main's verifier caveat (claim spot-verification before items reach the owner queue):
claim-heavy adjudications route to the MiMo seat or carry scout math-checks. Watch item:
GLM-Flash quality on tfd's ~30% narrow tradeoff calls — escalation path `glm-5.3` full.

**Bug-triage peer (2026-10-18):** stays on `glm-5.3-flash` — highest-volume seat (500–900
msgs/day since Oct 15), Zhipu decorrelation from the DeepSeek implementer it investigates
(037's axis), proven at role. Fallback if bad root causes surface: `deepseek-v4.1-flash:high`
(loses decorrelation, cheapest cache). Measurement note: `agents/bug-triage.md` has no
frontmatter name, so `seat_burn.py` folds triage traffic into the "main-session" bucket —
the session-tier shares include it until the tool grows path-based attribution.

**Files changed:** this decision, `decisions/subagents/README.md`, `docs/TODO.md`.

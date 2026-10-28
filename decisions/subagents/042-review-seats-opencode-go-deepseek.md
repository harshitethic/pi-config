---
title: "Review seats → opencode-go/deepseek-v4.1-flash:high — OpenRouter credits exhausted (temporary, 041 suspended)"
type: decision
status: done
date: 2026-10-28
---

# Review seats → `opencode-go/deepseek-v4.1-flash:high` (042)

**What (owner ruling, 2026-10-28, verbatim):** *"looks like we ran out of openrouter credits, in
the meantime, can we just switch all seats to deepseek-v4.1-flash-1017 via opencode-go in the
meantime (the model this session is currently set to)"* — clarified as
`opencode-go/deepseek-v4.1-flash`.

The three review seats — `review-code`, `review-plan`, `review-tests` — move from
`openrouter/z-ai/glm-5.3-flash:high` to `opencode-go/deepseek-v4.1-flash:high`. Every other seat
already sat on OpenCode Go DeepSeek (036/037): implementer `:high`, scouts `:low`, orchestrator
`:max`, oracle `deepseek-v4-pro:max`. Net effect: the whole fleet is on OpenCode Go again, which
is what 022 originally ruled before 041 moved the reviewers to OpenRouter.

**Why:** OpenRouter credits are exhausted, so the 041 seats cannot run. This is a forcing
constraint, exactly as 022's z.ai case was — not a quality judgment on GLM-5.3-Flash.

**Tradeoffs — accepted, with the decorrelation loss named:**
- **Reviewers now share the implementer's model.** 023's decorrelated-reviewer premise (a
  different lab's reviewer catches what the implementer's own model rationalises past) is
  suspended: implementer and reviewers both run `deepseek-v4.1-flash`. This is the real cost of
  the switch, and the observable is verdict quality on the next gated tasks — the gate must not
  assume an independent second perspective while this stands. Mitigation stays as-is: adversarial
  review briefs, `review-tests`/`review-code` split by concern, and the orchestrator's own diff
  read as the third pass.
- **Effort suffix kept at `:high`** — the same "everyday agentic" band 022's audit derived for
  reviewer seats on this model, so no new effort evidence is needed.

**Rollback (the "in the meantime" clause):** when OpenRouter credits are restored, the intended
seats are 041's `openrouter/z-ai/glm-5.3-flash:high` (decorrelated from the DeepSeek implementer).
Restoring it is a two-line change in the three agent files; no other decision needs revisiting.

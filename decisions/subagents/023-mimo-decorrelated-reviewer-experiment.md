---
title: "Experiment: MiMo V2.6 Flash as the decorrelated reviewer tier"
type: decision
status: experiment
date: 2026-10-01
---

# Experiment: MiMo V2.6 Flash as the decorrelated reviewer tier

**What:** All three review seats — `review-code`, `review-plan`, `review-tests` — run `xiaomi/mimo-v2.6-flash:high`. Implementation, orchestration, and scouts stay on the DeepSeek fleet model (022), so **the entire review tier is now a different lab from the implementer that writes the code**. `models.json` pins MiMo Flash to Xiaomi's first-party endpoint (`only: ["Xiaomi"]`, no fallbacks; fp8, $0.14/$0.28/M, cache $0.0028) so the experiment measures MiMo, not a cheapest-endpoint fp4 rendition. Three model lines moved; rollback is the same three edits.

**The decorrelation axis:** implementer ↔ reviewer (016: same-model review shares the generator's blind spots). With the implementer on DeepSeek, a *DeepSeek* reviewer is the correlated one; a MiMo reviewer is decorrelated regardless of which review job it holds. Reviewer-vs-reviewer lab mixing is explicitly **not** a goal: `review-code` and `review-tests` sharing the Xiaomi lab is fine — the independence that matters is from the DS implementer, and their lenses differ by job (correctness vs coverage vs plan pre-check).

**Why these seats and not a split:** The first two revisions of this experiment got the axis wrong. Revision 1 moved only `review-tests` to MiMo (kept `review-code` on DS "as the correctness half"); revision 2 — after user preference for plan+code — kept `review-tests` on DS "so the parallel gate stays cross-lab". Both optimized reviewer↔reviewer separation while leaving the highest-stakes reviewer same-lab as the implementer. That separation buys nothing on the axis that matters; the revision-2 config is kept in the decision history as the rejected alternative.

**Why Flash and not Pro (explicit):** The user's read is that BenchLM numbers and anecdotal human feedback disagree for this series, so *Pro > Flash* is a hypothesis, not a premise. Flash's BenchLM composite (66.4) is within noise of DeepSeek's (64.6) — it is the cheap near-peer, and if it clears the quality bar it is the win. Pro (75.5 composite, AA 46.3, $0.41–0.44/$0.83–0.87) is the fallback only if Flash fails and its price is separately justified.

## Protocol

Window: the next 2–3 code-changing work orders plus any plan reviews that trigger. The review gate is unchanged, so data arrives automatically; all three seats consume it.

**Instrumentation:** `APPEND_SYSTEM.md` carries a temporary note telling verdict consumers not to rubber-stamp reviewer output and to surface observations for this decision — deleted when the experiment resolves. The note cites this decision by **absolute path** because `APPEND_SYSTEM.md` is appended to sessions in every repo, where a relative `decisions/...` path resolves nowhere.

Signals, judged by the orchestrator (and user where wanted):

1. **Verdict quality** — defects found vs missed, false-positive pushback rate, and fabricated citations. 017's mechanical checks validate `file:line` citations model-independently; verdict *substance* is judged by the orchestrator. There is no cross-lab reviewer left to anchor against — that is the accepted cost of testing the tier, and why the revert path exists.
2. **Cost per round** — sum `usage` from the child session JSONL (`~/.pi/agent/sessions/**/<child-id>.jsonl`) vs the DS reviewer baseline: output $0.28 vs $0.60/M, cache reads ≈ equal (~29% cheaper than DS first-party on the 2026-10-01 measured profile, more at DS peak).
3. **Wall-clock and failures** — round duration; endpoint errors/timeouts (the pin fails loud).

Decision rule: **keep** if verdicts are clean and cost/wall-clock improve; **try one Pro round** if Flash is materially worse but the format is promising (same-lab, stronger — not a decorrelation fix); **revert the tier to DeepSeek** if fabrication, missed defects, or pushback rate regresses — noting that revert returns the config to same-lab review, the status quo 019 accepted for cost and 022 kept.

**2026-10-16:** decision 033 tightened the review gate mid-experiment; verdicts after it are not comparable with the 2026-10-01..16 window. The WO-153/154 control replays use the pre-033 prompts.

## Risks / tradeoffs

- **`review-code` is the highest-stakes seat and MiMo Flash is the series' weakest coding row** (BenchLM coding rank #38, 49.8 index; composite carried by agentic/knowledge rows). Main risk, accepted knowingly; revert on missed defects.
- **BenchLM coverage is thin** (14/495 displayable slots, vendor rows unranked) and the series has a public "benchmaxxed" critique; the experiment is deliberately outcome-measured (verdicts), not benchmark-trusted.
- **If MiMo fails, there is no decorrelated fallback below it**: Pro is the same lab, and reverting to DS is same-lab review. The decorrelation property is only as durable as this experiment.
- **fp8 host**: Xiaomi's first-party serving is fp8; DeepInfra fp8 (99.5% uptime, 944k out) or GMICloud bf16 (unquantized, 86.6% uptime) are the swaps, same price class.
- **Round-to-round noise**: WOs differ in complexity; 2–3 rounds is a smell test, not a clean verdict. Do not generalize to the implementer or oracle seats without a separate test.
- **Thinking is binary-ish on MiMo** (OR exposes `reasoning`/`include_reasoning`, no graded `reasoning_effort`), so `:high` means "thinking on"; there is no effort dial to tune here.

## Rollback

`agents/review-{code,plan,tests}.md` model lines → `deepseek/deepseek-v4.1-flash:high`; drop the `xiaomi/mimo-v2.6-flash` override from `models.json` if no seat uses it. `git revert` of this commit does the model lines plus the docs.

**Files changed:** `agents/review-code.md`, `agents/review-plan.md`, `agents/review-tests.md`, `APPEND_SYSTEM.md` (temporary verdict-checking note), `models.json` (MiMo first-party pin), `docs/model-role-scores.md`, `docs/thinking-levels.md`, `docs/TODO.md`, `README.md`, decisions index, this decision.

**Test coverage:** none — agent frontmatter + routing config. Verified by real dispatch: `review-tests` and `review-code` both smoke-spawned on the pinned MiMo route (meta.json model confirmed, correct tool use, 4 turns each, ~20–27% cheaper than the DS equivalent on the same tiny task); live signal comes from the next real work-order round.

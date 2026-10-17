---
title: "OpenRouter-only fleet on deepseek/deepseek-v4.1-flash — /fleet-model toggle deleted, oracle off 0813"
type: decision
status: done
date: 2026-10-01
---

# OpenRouter-only fleet on `deepseek/deepseek-v4.1-flash`

**What:** The z.ai subscription is gone, so every subagent seat moves to the OpenRouter model pi already runs as its default: `deepseek/deepseek-v4.1-flash`. Implementer, 3 reviewers, 2 scouts, orchestrator, and the oracle all run it; per-seat effort rides the existing `provider/model:level` suffixes (orchestrator/oracle `:max`, implement/reviewers `:high`, scouts and compaction `:low`; see the effort audit below). The `/fleet-model` toggle, its `~/.pi/fleet-model.json` override, `resolveFlashModel`, and the 15-row test matrix are **deleted** — with no second seat there is nothing to flip to. `models.json`'s correctness-guard routing pin transfers from `deepseek/deepseek-v4-pro-0813` to the new model (DeepSeek first-party endpoint only). Supersedes 020's model choice and toggle design; 021's `high`/`max` levels survive for the code and hard-tail seats, while scouts and compaction moved to `low` per the audit below.

**Why:**
1. **No z.ai subscription** — `zai/glm-5.3*` seats cannot run. This is the forcing constraint, not a quality judgment.
2. **The oracle's 0813 guard lapsed: v4.1-flash beats it on the hard tail.** DeepSeek's own instruct-model table (HF card, released 2026-09-10, all rows max effort): Codeforces **3471 vs 3348**, MathArena Apex **65.6 vs 65.3**, DeepSWE v1.1 **74.2 vs 62.7**, Terminal-Bench 2.1 **90.6 vs 87.9**, HLE with tools **63.9 vs 60.0**. List price `$0.0198/$0.396` per M vs `$0.66/$1.98` — ~33× input and ~5× output cheaper. The earlier "oracle stays on 0813 until math data appears" watch item (020) is answered.
3. **First-party is the correctness guard.** 20+ OpenRouter endpoints serve v4.1-flash; the default cheapest is fp4-quantized, which is not the model the card measured. The pin keeps the fleet on unquantized first-party weights. Cost/cache is **not** the reason: a 2026-10-01 probe showed provider-automatic prefix caching works broadly on OpenRouter (DeepSeek default routing on Venice reported ~99.3% cached tokens; MiMo hosts ~99.8%), and first-party's cache-read price ($0.003/M) is within rounding of the cheapest reseller ($0.00285/M). What the pin does give up is first-party's peak-window rates (weekday doubles) — an accepted cost for weight fidelity.

## Alternatives rejected

- **Keep the oracle on 0813 (`deepseek/deepseek-v4-pro-0813`)** — rejected: measured worse than v4.1-flash on the oracle-relevant evals at 33×/5× the price. The one counter-signal is text-only HLE (39.1 vs 42.7); HLE-with-tools flips the other way (63.9 vs 60.0), and the seat's actual work is math/algorithms, where Codeforces/Apex/DeepSWE decide.
- **Keep `/fleet-model` with an OpenRouter-only second seat** — rejected: every candidate is dominated. 0731 (`$0.01/$1.28`) is strictly worse per measured index at 3.2× the output price; 0813-pro is superseded above. An override file with no defined second value is maintenance debt, not an escape hatch.
- **Run the fleet unpinned (cheapest OpenRouter routing)** — rejected: cheapest endpoints are fp4-quantized, so the vendor-card measurements no longer describe what runs. Caching is not the differentiator — provider-automatic prefix caching works across endpoints (probe 2026-10-01); the pin's cost is the first-party rate card, including weekday peak windows. If a first-party outage makes `allow_fallbacks: false` hurt, that's a loud failure to revisit — the intended behavior.
- **Pin only the oracle, leave the fleet unpinned** — impossible: `models.json` overrides are per model slug, not per agent, and all seats now share the slug. Pinning for the oracle pins the fleet.
- **Keep the fleet on the GLM-era effort suffixes without re-verifying** — rejected after the audit below: 021's levels are GLM-derived, and one of them (`:medium` for scouts) does not exist on this model — pi clamps it up to `:high`. The audit re-derived each seat from the vendor's own effort data and pinned the effective level.

## Effort audit (2026-10-01)

Forcing facts:

- **pi catalogue**: v4.1-flash supports `off`/`low`/`high`/`max`; `medium` and `xhigh` are `null`. `clampThinkingLevel` (pi-ai `models.js`) rounds a `null` level **up** first, so `:medium` resolves to `:high` — scouts were silently running at the implementer/reviewer effort.
- **Vendor tech report §5.3.3**: the public API exposes exactly three presets — `low`=50, `high`=75, `max`=100 (no medium). §5.3.2: raising effort 25→100 gains +9.2 pts avg on eight reasoning benchmarks, +8.2 DeepSWE, +8.2 TB2.1, at ~2.5× output tokens; the 60–80 band recovers most of max accuracy at <half its token budget; the final step to 100 lengthens agent trajectories **1.6–1.8× for marginal gains** — "best reserved for the most challenging tasks, while moderate effort levels offer a favorable cost–performance balance for everyday agentic use." The curve is smooth and monotone — no benchmark degrades with effort, so the GLM-style `low` cliff that motivated 021's ban does not exist here.

Per-seat conclusions: implementer/reviewers `:high` = the vendor's everyday-agentic band (unchanged). Oracle `:max` = the definitional hard-tail seat, and its benchmark basis is max-effort (unchanged). Orchestrator `:max` kept — rare (one per roadmap item), high-leverage, and consistent with the user-set `defaultThinkingLevel: max`; `:high` is the defensible cost choice if orchestrator spend ever matters. **Scouts moved `:high`→`:low` (50)** — read-only research takes the real discount tier; 021's ban rested on a GLM `low` cliff that does not exist on this smooth curve, and downstream poisoning is bounded by implementer/reviewer verification of scout findings. **Compaction pinned `:low`** — a pure summarization call; with no explicit level it silently rode the provider default (`high`), so this is a cost cut on a work type that never needed the reasoning tail. Ban scope after this decision: `low` is allowed for read-only/summarization seats (scouts, compaction), still banned for code-writing and hard-tail seats (implement, reviewers, orchestrator, oracle).

**Cheaper-seat alternatives evaluated (MiMo V2.6).** BenchLM composites put MiMo-V2.6-Flash at 66.4/100 (Agentic #36, Coding #38) ≈ this model's 64.6/100 (Agentic #20), and MiMo-V2.6-Pro at 75.5/100 (Coding #9; AA Index 46.3 vs 40) — Flash is a cheaper near-peer, Pro a stronger-but-pricier one. **A caching probe corrected an earlier false read of OpenRouter metadata here:** the per-endpoint `supports_implicit_caching: false` flag does *not* mean MiMo lacks prompt caching. Two identical requests (2026-10-01, pi's request shape) reported ~22,272/22,307 (**99.8%**) cached prompt tokens on MiMo Flash via both DeepInfra and Xiaomi, with cost dropping ~46×; DeepSeek first-party and default routing behaved the same, and pi's catalogue already sets `sendSessionAffinityHeaders: true` for MiMo (sticky routing keeps the same host). On the audit session's measured profile (10.51M cache / 222k fresh / 100k out): DS first-party off-peak ≈ $0.125 vs MiMo Flash ≈ $0.089 (**~29% cheaper** — output at $0.28 vs $0.60/M; cache reads near-identical at $0.0028 vs $0.003/M), and MiMo Pro ≈ $0.220 (pricier than DS off-peak, cheaper than DS peak). **Not adopted in this decision** — the fleet keeps one model, and MiMo Flash's agentic rank (#36 vs #20) is the weak axis for implement/review seats. The candidate experiment when a second seat is justified is **MiMo Flash (cheaper) or Pro (stronger) as a decorrelated reviewer** — Xiaomi lab vs the same-lab DeepSeek fleet — gated on a one-round verdict-quality micro-benchmark, not adopted blind.

## Tradeoffs

- **All seats on one model kills the model-choice complexity dial.** 021's routing principle ("complex work rides the full model, everything else the flash seat") no longer has two models to route between; the remaining dial is the effort suffix. Accepted: the user's directive is explicitly one model, and v4.1-flash matches or beats the old full-tier seat on the measured axes.
- **The oracle runs a "flash"-tier model.** The name understates it — it is a 552B-backbone MoE (8B/16B activated) released after the 0813 checkpoint, and it wins the hard evals. The HLE text-only regression is the honest cost.
- **`:high` quality on v4.1-flash is inferred, not measured.** The card's instruct numbers are all max-effort; the vendor's "60–80 recovers most of max" statement is the basis for running the volume code/review seats at `:high`. If review or implementation quality regresses, the observable is verdicts/coverage, not benchmarks — same watch posture as 020. Scouts and compaction now run the same unmeasured `low` tier; the observable there is scout-finding and summary quality on the next few sessions.
- **The fleet now depends on one endpoint.** `allow_fallbacks: false` means a DeepSeek first-party outage fails loudly instead of silently degrading to a quantized reseller. That is deliberate.
- **Dead z.ai code remains in `footer-session-id.ts`** (quota fetch, peak/off-peak multiplier). It no-ops without a zai key and is out of scope here; delete when the subscription is confirmed permanent.

## Rollback

`git revert` of this commit restores the frontmatter defaults, the toggle/command/test files, and the 0813 `models.json` pin. The old `~/.pi/fleet-model.json` override — if one exists on a machine — has no reader afterward and is inert; delete it manually.

**Files changed:** `agents/{orchestrator,implement,review-code,review-plan,review-tests,scout-code,scout-web,math-algo-oracle}.md` (model lines), `extensions/lib/fleet-model.ts` (reduced to `FLEET_PROVIDER`/`FLEET_MODEL`), `extensions/subagent-async/index.ts` (fallback + comments), `extensions/compaction-model.ts` (constant seat), `extensions/fleet-model.ts` (deleted), `settings.json` (command unregistered; default provider/model already flipped by the user), `models.json` (pin moved), `tests/fleet-model.test.ts` (deleted), `docs/model-role-scores.md`, `docs/thinking-levels.md`, `docs/TODO.md`, `README.md`, decisions index, supersession footnotes on 020/021, this decision.

**Test coverage:** the deleted matrix tested a mechanism that no longer exists; nothing replaces it. The wiring left is a constant passed to existing spawn/compaction call paths (unchanged shapes), covered by the suite's existing subagent/compaction tests. E2E: a live spawn after `/reload` records `deepseek/deepseek-v4.1-flash:*` in its `meta.json`.

---

> **Addendum (2026-10-18, [decision 035](035-flash-1017-refresh.md)):** the fleet model id moved to
> the Oct 17 checkpoint, `deepseek/deepseek-v4.1-flash-1017` — same seat split, same effort levels,
> same routing pin shape; the 0910 id above is the id this decision adopted.

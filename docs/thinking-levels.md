---
title: "Thinking-level sweet spots per fleet model"
type: reference
status: active
date: 2026-07-23
---

# Thinking-level sweet spots per fleet model

Research on reasoning-effort levels for every model in the fleet: which have a
"sweet spot" below max thinking that uses significantly fewer tokens for ~95%+
of the quality. Sources: Artificial Analysis per-effort model variants and
articles, vendor API docs (Z.ai, Moonshot, OpenAI, Xiaomi). Research date:
**2026-07-23**.

## How levels reach the fleet

- Pi thinking levels: `off, minimal, low, medium, high, xhigh, max`
  (`settings.json` → `defaultThinkingLevel: "max"` since decision 021, 2026-08-28; was `"high"`).
- Subagents are spawned with `--model` but **no `--thinking` flag**
  (`extensions/subagent-async/index.ts` → `buildSubagentArgs`), so every
  subagent inherits the session default (`max`) unless the agent frontmatter's
  `model:` uses the `provider/id:<level>` shorthand (e.g.
  `deepseek/deepseek-v4.1-flash-1017:high`). The fleet sets effort per agent this
  way (decision 022, after the 2026-10-01 effort audit: implement/reviewers
  `:high`, scouts `:low`, oracle/orchestrator `:max`, compaction `:low`). The `/fleet-model`
  toggle and its suffix-preserving substitution were deleted 2026-10-01 — one
  model, no substitution (decision 022).
- Provider mappings: **DeepSeek V4.1 Flash via OpenRouter** (pi catalog
  `thinkingLevelMap`, checked in `models-store.json` 2026-10-01): `low`→low
  (real), `medium`→**null** (unsupported), `high`→high, `xhigh`→**null**,
  `max`→max. `clampThinkingLevel` rounds a `null` level **up**, so `:medium`
  resolved to `:high` — which is how the audit found scouts were silently running
  at the top-band effort (decision 022). `low` is the only real discount tier;
  the audit allows it for read-only/summarization seats (scouts, compaction) and
  keeps it banned for code-writing and hard-tail seats. The vendor tech
  report exposes exactly `low`=50 / `high`=75 / `max`=100, recommending the
  60–80 band for everyday agentic use. The zai GLM map (`medium`/`xhigh`→null)
  is history — see the 2026-08-28 addenda below.

## Findings per model

| Model | Fleet roles | Real levels | Sweet spot | Evidence |
|---|---|---|---|---|
| **DeepSeek V4.1 Flash** | **all seats** (decision 022) | low, high, max | ✅ **per seat:** orchestrator/oracle `:max`, implement/reviewers `:high`, scouts/compaction `:low`. `:medium` silently clamps up to high — scouts were mis-set to it, then moved to the real discount tier. Vendor: 60–80 recovers most max accuracy at <half the tokens; final step to 100 costs 1.6–1.8× trajectory for marginal gain; curve is smooth (no GLM-style `low` cliff) | [HF card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), tech report §5.3 |
| **MiMo V2.6 Flash** | `review-code`, `review-plan`, `review-tests` (experiment 023) | on/off (OR exposes `reasoning`, not graded effort) | `:high` = thinking on; no effort dial to tune | OpenRouter endpoints + 2026-10-01 cache probe (~99.8% cached) |
| **DeepSeek V4 Pro** | *(former oracle)* | high, max | ✅ **`high`** — AA Index 43 vs 44 at max (**~98%** of max quality); high variant is also faster | [AA comparison](https://artificialanalysis.ai/models/comparisons/deepseek-v4-pro-high-vs-deepseek-v4-pro) |
| **DeepSeek V4 Flash / 0731** | *(former toggle target)* | high, max | ✅ **`high`** (presumed — same AA variant structure as V4 Pro; exact scores behind JS-rendered pages, single-source) | [AA flash-high](https://artificialanalysis.ai/models/deepseek-v4-flash-high) |
| **GPT-5.6 Luna** | *(not in fleet — orchestrator ceiling)* | low, med, high, xhigh, max | ✅ **`high`** — 90.2% of max quality (46 vs 51 AA Index) at **42% of the tokens** (8k vs 19k/task), $0.09 vs $0.21/task. xhigh: 96.1% at 63%. Graceful degradation, no cliff | [AA GPT-5.6 analysis](https://artificialanalysis.ai/articles/gpt-5-6-has-landed), [dataset gist](https://gist.github.com/IgorWarzocha/60bfd11731f15cf8802f0b6e80d47ac7) |
| **GLM-5.3 / GLM-5.3-flash** | *(out of fleet — decision 022)* | none, high, max | ✅ **effort per seat (decision 021):** orchestrator/main `:max`, implement `:high`, reviewers `:high`, scouts `:medium` (inert on zai → provider-default high), oracle `:max` — set via `provider/model:level`, not the session default | [Z.ai thinking docs](https://docs.z.ai/guides/capabilities/thinking) |
| **Kimi K3** | main session | low, high, max (default max) | ⚠️ **Unknown — data gap.** All benchmarks at max (AA Index 57, ~132M output tokens across the suite); low/high added post-launch with no published comparisons | [Moonshot reasoning-effort guide](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [K3 blog](https://www.kimi.com/blog/kimi-k3), [AA article](https://artificialanalysis.ai/articles/kimi-k3-achieves-3-in-the-artificial-analysis-intelligence-index-comparable-to-opus-4-8-and-gpt-5-5) |
| **MiMo V2.5 Pro** | *(not in fleet)* | — | 🚫 **No effort control** exposed by vendor or OpenRouter; nothing to tune | [product page](https://mimo.xiaomi.com/mimo-v2-5-pro/), [OpenRouter](https://openrouter.ai/xiaomi/mimo-v2.5-pro) |

No model with data shows a cliff between high and max. The only real cliff is
GLM-5.x at `none`/`minimal`, which disables chain-of-thought entirely.

> **2026-08-28 (decision 020):** fleet moved — GLM-5.2 out (replaced by GLM-5.3 /
> GLM-5.3-flash), deep reviewers deleted, and per-agent effort now rides the
> `provider/model:level` shorthand instead of the session default or the
> `thinkingLevelMap` provider clamp (that clamp and the old z-ai models.json entry
> were removed with the prune).

## Addendum — DeepSeek 0813 high-vs-max, and the real zai level map (2026-08-28)

Two research findings that post-date the table above:

**1. Oracle effort `max` is correct — the composite AA delta hides the math
profile.** The earlier "`high` is the V4 Pro sweet spot" guidance rested on the
AA *composite* (44 high vs 45 max on the April preview, index v4.1.1; the
43/44 in our notes was v4.0 drift). The vendor's Table 7 ablation (arxiv
2606.19348, *preview-era*, self-reported) on exactly the oracle seat's evals:
high→max = Apex **+10.9**, Codeforces **+287 rating**, Apex-Shortlist +4.7,
LiveCodeBench +3.7, HMMT +1.2 — and **all 0813-published numbers are
max-effort** (AA 53, HLE 42.7, HMMT 95.2, MathArena AIME 96.67). The param
is honored (official mapping low→low, medium/high/xhigh→high, max→max; the
0813 card introduces 3-level control as new). Caveats: max evals ran 384K ctx
vs 128K for high (part of the delta is context); one −0.6 regression
(MCPAtlas); no 0813-specific high-vs-max dataset exists yet. Cost at oracle
call volume is a non-issue (~$0.004/K thinking tokens; max even decodes
faster, 66 vs 63 t/s). Decisive follow-up if ever needed: 10-problem AIME/HMMT
slice at both efforts through our OpenRouter route, logging reasoning tokens.
(Research: scout-web session subagent-520b5fa4.)

**2. The zai level map is narrower than assumed above.** pi's catalog
(`models-store.json`) maps GLM: `low`→low (real, cheaper), `medium`→**null**,
`xhigh`→**null**, `high`→high, `max`→max — there is no real `medium`; a
`:medium` request falls back to the provider's default. **Post-merge E2E
confirmed it live — twice:** `scout-code` and `scout-web` spawns
(`zai/glm-5.3-flash:medium`) ran on the real endpoint at effective `high`,
including one under `defaultThinkingLevel: max` — the fallback is the
provider default, not the session default. Scouts are therefore pinned to
GLM-high regardless of session-default flips; `:medium` stays in frontmatter
as intent + future-proofing (if z.ai ships a real medium, pi's catalog map
picks it up). `:low` is **banned fleet-wide** (decision 021, 2026-08-28): the user's
benchmark review shows a large low-vs-high quality delta on both GLM variants —
the earlier cost-saving suggestion is rejected, not deferred.

## Addendum — effort rebalance, `low` banned (decision 021, 2026-08-28)

Same-day follow-up to the 020 effort policy, from the user's benchmark review of
GLM per-effort comparisons (see [decision 021](../decisions/subagents/021-effort-rebalance.md)):

- **glm-5.3-flash high vs max:** very small quality delta, very large token delta →
  reviewers drop to `:high` (implement was already `:high`).
- **glm-5.3 high vs max:** token delta notably less stark than flash's → orchestrator
  and main session (`defaultThinkingLevel`) rise to `:max`; less-complex work routes to
  the flash seat at `:high` instead — the complexity dial is model choice, not per-task
  effort.
- **low vs high:** large quality delta on BOTH glm-5.3 and glm-5.3-flash → `low` is
  **banned fleet-wide** (covers DeepSeek V4, whose `low` is real and equally rejected).
  This reverses the "cheaper real option is `:low`" suggestion in the addendum above.
- **Scouts keep `:medium`:** inert on zai (medium→null falls back to provider-default
  `high`, E2E-verified twice), survives the `/fleet-model deepseek` toggle (0731 maps
  medium→high), and future-proofs for a real z.ai medium.

## Addendum — OpenRouter-only, single fleet model (decision 022, 2026-10-01)

- **All seats run `deepseek/deepseek-v4.1-flash-1017`** (orchestrator, implementer, 3
  reviewers, 2 scouts, oracle, compaction). The z.ai subscription is gone; the
  `/fleet-model` toggle and `~/.pi/fleet-model.json` override were deleted.
- **Levels preserved as seat policy, then audited (2026-10-01):** orchestrator/oracle
  `:max`, implement/reviewers `:high`, scouts/compaction `:low`. `medium` does not exist
  on this model — the catalogue maps it to null and pi clamps it up to `high` — so the
  scouts' inherited `:medium` suffix was a silent no-op; the audit moved them to the real
  `low` tier and pinned compaction there too (read-only/summarization seats only;
  `low` remains banned for code/hard-tail seats). Vendor tech report: `low`=50,
  `high`=75, `max`=100; 60–80 is the everyday-agentic band; the final step to 100 costs
  1.6–1.8× trajectory length for marginal gain.
- **MiMo V2.6 evaluated (caching probe corrected).** Flash ≈ this model on BenchLM
  composite (66.4 vs 64.6) and Pro is stronger (75.5, AA 46 vs 40). OpenRouter's
  per-endpoint `supports_implicit_caching: false` flag first suggested no cache
  benefit, but a two-request probe shows **~99.8% cached prompt tokens** on both the
  DeepInfra and Xiaomi hosts (pi's `sendSessionAffinityHeaders` keeps the host sticky),
  making Flash ~29% cheaper than DS first-party on this session's profile (~65% cheaper
  at DS peak). Deferred for now on quality/simplicity grounds — weaker agentic rank —
  with a decorrelated reviewer seat as the candidate experiment.
- **Benchmark basis is max effort.** The 2026-09-10 vendor card reports the instruct
  model at max reasoning only (Codeforces 3471, MathArena Apex 65.6, DeepSWE 74.2);
  the `:high` seats' quality at their level is inferred from the generic high≈max
  pattern below, not measured on this checkpoint. Watch items: reviewer verdict
  quality, implementer invariant coverage.
- **Routing:** `models.json` pins the slug to DeepSeek's first-party endpoint
  (`only: ["deepseek"]`, no fallbacks) — the quantized fp4 resellers are not the
  benchmarked model. Caching is broad on OpenRouter (probe 2026-10-01: ~99% cached
  tokens on DeepSeek and MiMo hosts alike), and first-party's cache-read price
  ($0.003/M) is within rounding of the cheapest reseller's ($0.00285/M).

## What this means for current assignments

1. **All seats — `deepseek/deepseek-v4.1-flash-1017` (decision 022).** Effort per seat
   via the `provider/model:level` shorthand: implement/reviewers `:high`,
   scouts and compaction `:low`, orchestrator/oracle `:max`. Do not raise
   implement/reviewers toward max — the vendor data says the 60–80 band recovers
   most of max at <half the tokens; `low` is scoped to read-only/summarization seats.
2. **Orchestrator — `deepseek/deepseek-v4.1-flash-1017:max`.** 021's max-for-the-hard-tail
   call carries over: the seat owns planning/instructions and the vendor card is
   max-effort. 020's old "complexity is routed by model choice" line is dead —
   there is one model now; the remaining dial is the effort suffix.
3. **Oracle — `deepseek/deepseek-v4.1-flash-1017:max` (decision 022).** The 0813 record
   (020) is superseded: v4.1-flash beats it on Codeforces (3471 vs 3348), MathArena
   Apex (65.6 vs 65.3), DeepSWE (74.2 vs 62.7) and TB2.1 (90.6 vs 87.9), losing only
   text-only HLE (39.1 vs 42.7); HLE-with-tools flips back (63.9 vs 60.0).
4. **MiMo V2.5 Pro — nothing to set** (no effort control).
5. **If GPT-5.6 Luna ever enters the fleet, run it at `high`** — the only
   fully-quantified sweet spot (90% quality / 42% tokens / 43% cost).

## Caveats

- AA's Intelligence Index deltas (43 vs 44) are within-run aggregates, not
  per-task guarantees; treat "~98%" as directional.
- DeepSeek V4 Flash's per-effort scores live behind JS-rendered AA pages; the
  high≈max pattern is inferred from the V4 Pro pair and AA's variant naming.
- Effort levels are per-request; nothing here changes provider pricing, only
  token volume.

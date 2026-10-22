---
title: "Role-fit scores: Orchestrator / Implementer / Oracle / Reviewer"
type: reference
status: active
date: 2026-08-01
---

# Role-fit scores for OpenRouter models

Combined per-role **quality** scores plus a **cost** score for a cost-conscious set of
OpenRouter models, scored against role-specific benchmark priorities for five roles:
**Orchestrator** (session driver / planner), **Implementer** (worker / coder),
**Oracle** (deep math / algorithm reasoner), and **Reviewer** (adversarial review, split
into *review-code* and *review-tests*). Weightings reflect explicit steering
(see [Role definitions](#role-definitions--weights)).

- **Quality score (0–100)** — star-weighted composite of role-relevant benchmarks. A
  *relative* score, not an absolute capability %.
- **Cost score ($/M)** — blended price per million tokens at a **95/5 input/output split
  and 98% cache-hit rate**. (Input-heavy because these roles re-read a large cached
  context each turn; the ratio is a one-line knob in `role_scores.py`.) Lower is better.
- **Confidence** — how much *standalone* benchmark data backs each role score
  (see [Confidence & "unknown"](#confidence--unknown)).

Computed by [`role_scores.py`](data/role_scores.py) from
[`benchlm_snapshot.json`](data/benchlm_snapshot.json) (see
[`fetch_benchlm.py`](data/fetch_benchlm.py)); raw values in
[`role_scores.json`](data/role_scores.json). Data snapshot: **2026-08-01** (BenchLM
per-benchmark pages + OpenRouter `/models` + `/benchmarks`, all fetched 2026-07-31).

> **2026-08-01 refresh — read before comparing to the 2026-07-23 snapshot:**
> 1. **New data source.** BenchLM per-benchmark pages (July 31, 2026) now supply every
>    granular benchmark (SWE-Pro, SWE-Ver, TB2, AA-LCR, IFBench, AIME, Codeforces,
>    GPQA-D, Omniscience) plus the three AA indices. Live OpenRouter `/models` pricing
>    replaces the curated prices (see caveat 8). Only LiveCodeBench and IMO/HMMT remain
>    framia-sourced (BenchLM doesn't track them for DeepSeek). Note: BenchLM's *base*
>    V4 Flash rows are April-24 Preview placeholders, not 0731 measurements (caveat 10);
>    all fleet-relevant flash values use the (High)/(Max) reasoning-variant rows.
> 2. **Thinking-level variants are separate rows.** BenchLM publishes `(High)`/`(Max)`
>    rows for DeepSeek V4 Pro and V4 Flash. The fleet runs DeepSeek at `high`
>    (`defaultThinkingLevel`), so the operative row is the `(High)` variant; `(Max)` is
>    the ceiling. Prior snapshots scored DeepSeek on Max-variant data while the fleet
>    runs High — this snapshot fixes that mismatch.
> 3. **`DeepSeek V4 Flash 0731` added** (2026-07-31 checkpoint; the alias
>    `deepseek/deepseek-v4-flash` still resolves to the old 20260423). Its AA indices
>    are **served-model measurements** (OpenRouter/AA: int 49.9 / cod 69.1 / agt 45.7 —
>    **above V4 Pro on all three**) but its granular benchmarks are **unpublished
>    anywhere** — not by DeepSeek (their 0731 launch published only agentic evals:
>    Terminal-Bench 2.1, DeepSWE, NL2Repo, CyberGym, Toolathlon, ALE, AutomationBench,
>    DSBench) nor any third party (BenchLM's July-31 snapshot holds April-24 **Preview**
>    numbers as historical placeholders; morphllm has no independent re-run). Its
>    composite score is an AA-index-only projection (`proxy 0/4`); treat as directional.
>    Re-check with `python3 docs/data/fetch_benchlm.py --check-0731` in 24-48h.
> 4. **Scores are not cross-comparable with 2026-07-23** — new rows (variants + 0731)
>    stretched min-max bounds. Compare within this snapshot.

> **2026-08-28 fleet move (decision [020](../decisions/subagents/020-fleet-glm-53-flash-single-tier.md)):**
> the flash seat moved to `zai/glm-5.3-flash` (implementer, 3 reviewers, 2 scouts,
> compaction) with a `/fleet-model` toggle back to 0731; the orchestrator moved to
> `zai/glm-5.3:high`; the deep reviewer tier was deleted; per-agent effort levels are
> set via the `provider/model:level` shorthand (implement `:high`, scouts `:medium`,
> reviewers `:max`, oracle `:max`). Same day, [decision 021](../decisions/subagents/021-effort-rebalance.md)
> rebalanced the effort levels (user benchmark review): orchestrator `:max`, reviewers
> `:high`, `low` banned fleet-wide; scouts keep `:medium`. The scores below are the
> 2026-08-01 snapshot and predate the move; the **Current assignments** table is
> authoritative. GLM-5.2 rows in the score tables below are retained as the 2026-08-01
> snapshot data (out of fleet; the next data refresh drops them).
>
> **2026-10-01 fleet move (decision [022](../decisions/subagents/022-openrouter-fleet-v41-flash.md)):**
> z.ai is gone — every seat runs the fleet flash model (orchestrator/oracle
> `:max`, implement/reviewers `:high`, scouts/compaction `:low` after the effort audit), the
> `/fleet-model` toggle +
> `~/.pi/fleet-model.json` override are deleted, and the oracle moved off
> `deepseek/deepseek-v4-pro-0813`. Evidence: the 2026-09-10 vendor card has v4.1-flash
> (all rows max effort) beating 0813-pro on Codeforces **3471 vs 3348**, MathArena Apex
> **65.6 vs 65.3**, DeepSWE **74.2 vs 62.7**, Terminal-Bench 2.1 **90.6 vs 87.9**,
> losing only text-only HLE (39.1 vs 42.7; HLE-with-tools 63.9 vs 60.0). `models.json`
> re-points the correctness pin at v4.1-flash's first-party endpoint. MiMo V2.6
> Flash/Pro were evaluated as cheaper seats: a direct probe shows ~99.8% cached prompt
> tokens on both DeepInfra and Xiaomi hosts (the endpoint `supports_implicit_caching`
> flag understates this), making Flash ~29% cheaper than DS first-party on this
> session's profile. Deferred for the fleet, but the whole review tier
> (`review-code`/`review-plan`/`review-tests`) now runs the MiMo Flash decorrelation
> experiment (decision 023) — Xiaomi reviewers against the DeepSeek implementer. The tables below
> are unchanged 2026-08-01 snapshot data and contain no v4.1 row.
>
> **2026-10-18 checkpoint refresh (decision 035):** the fleet model id moves to
> `deepseek/deepseek-v4.1-flash-1017` (Oct 17 checkpoint; same seat split and effort
> levels). Vendor card: TB4.0 31.2→42.3, DeepSWE 74.2→77.0, Apex 64.6→72.1, shorter outputs.
>
> **2026-10-18 routing move (decision 036):** the DeepSeek fleet seats (implement/oracle/scouts/
> compaction) ride the OpenCode Go plan quota (`opencode-go/deepseek-v4.1-flash`, same levels);
> reviewers stay OpenRouter Xiaomi (023); `-1017` remains manually reachable via OpenRouter.

---

## 2026-10-18 scorechart — OpenCode Go menu (decision model-tiers/003)

Fresh composites after the benchmark-set integrity review: SWE-bench Verified
dropped, SWE-bench Pro discounted, Terminal-Bench 4.0 (2.0 was two majors stale),
DeepSWE added, AIME/Codeforces/GPQA informational-only, AA indices used within one
index version (v4.3.2, sources 2026-10-17). Min-max within the Go subset (22
SKUs with data; LongCat-2.0, Space Bunny, Hy4 preview, MiMo-V2.5, LongCat/Beam
free previews have no BenchLM rows). Halluc% = AA-Omniscience hallucination rate
(informational — closed-book calibration, not an agentic-hallucination proxy).

| SKU | Orch | Impl | R-Code | R-Test | Halluc% | chr-blend ¢/M | solo B tok/mo | Notes |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| Kimi K3 | 84.2 | 99.3 | 89.1 | 86.4 | 53.2 | 35.1 | 0.04 (Go) | ⚠ documented eval cheat (answer-key retrieval via sandbox egress, Frontier Security 2026-08); tiny 5h cap |
| MiMo-V2.6-Pro | 83.1 | -- | 82.2 | 82.4 | 40.6 | 0.88 | 6.8 | Impl granular unpublished; cheapest capable cache ($0.003625) |
| Step 5 Preview | 83.0 | -- | 80.8 | 81.3 | 43.0 | 11.2 | 0.53 | Preview SKU — 4× bucket may expire |
| Gemini 4 Argon | 79.3 | -- | 82.2 | 81.6 | **15.1** | 27.0 | 0.22 | Best factuality row; Google self-report caveat; low 5h cap |
| GLM-5.3 | 78.3 | 97.6 | 73.0 | 68.2 | 29.6 | 27.7 | 0.05 (Go) | Impl solid; expensive cache ($0.26) + 5h cap |
| Qwen3.8 Max | 71.2 | 78.3 | 69.4 | 66.9 | 28.8 | 28.1 | 0.05 (Go) | |
| Claude Haiku 5.5 | 69.5 | -- | 65.0 | 65.2 | 40.4 | 1.20 | 1.26 (Go) | ≤100K pricing tier |
| GLM-5.3-Flash | 69.1 | 80.6 | 65.4 | 62.2 | -- | 3.19 | 5.6 | Reviewer/triage/main-session seat; cache $0.03; halluc unmeasured |
| GPT-5.6 Luna | 68.0 | 74.2 | 85.3 | 86.7 | **92.6** ⚠ | 2.43 | 0.62 (Go) | Top reviewer scores, worst-in-class hallucination — 016/017 objection stands; ≤272K tier |
| Grok 4.7 | 67.8 | 84.5 | 57.7 | 57.3 | 29.3 | 52.3 | 0.03 (Go) | ≤200K tier |
| Qwen3.8 Flash | 67.5 | **88.1** | 66.8 | 63.6 | 45.3 | 1.84 | 1.63 (Go) | Strong implementer value |
| DeepSeek V4.1 Flash 1017 | 65.3 | **-- unmeasured** | 61.6 | 62.1 | **96.5** ⚠ | 0.54 (peak 1.07) | **29.8** off-peak / 14.9 peak | Fleet seat — **throughput king under every cache assumption**; granular rows unpublished — vendor card only (DeepSWE 77.0, TB4.0 42.3) |
| Muse Spark 1.3 | 63.9 | 55.9 | **87.1** | **83.9** | 32.9 | 0.32 | 18.9 (Go) | ⚠ Contributor SKU — trains on prompts/completions (Not ZDR); AA independently benchmarked |
| GLM-5.2 | 51.1 | 58.7 | 50.5 | 47.2 | 26.3 | 27.7 | 0.22 (Go) | |
| GPT-6 Luna | 45.6 | 6.6 | 58.2 | 58.7 | 76.7 | 1.20 | 1.26 (Go) | ≤272K tier |
| MiniMax-M3 | 43.1 | 31.4 | 36.0 | 39.1 | 18.4 | 6.42 | 0.93 (Go) | |
| MiMo-V2.6-Flash | 40.0 | -- | **40.1** | **39.9** | 54.4 | 0.45 | 13.5 (Go) | Former reviewer seat — weakest reviewer row on the menu |
| DeepSeek V4 Pro (High) | 31.3 | 43.6 | 29.1 | 29.6 | 88.7 | 3.10 (peak 6.20) | 1.9 off-peak / 0.97 peak | Oracle-solid but planning-weak (008); low volume fits |
| Qwen3.7 Plus | 28.0 | 30.4 | 32.1 | 32.5 | 27.7 | 4.70 | 1.28 (Go) | ≤256K tier |
| MiMo-V2.5-Pro | 26.7 | 26.6 | 31.8 | 32.3 | 24.7 | 0.88 | 1.70 (Go) | |
| Hy3 | 25.3 | 14.4 | 29.0 | 30.1 | 74.1 | 3.69 | 1.62 (Go) | |
| Kimi K2.7 Code | 24.5 | 10.7 | 33.0 | 33.1 | 82.4 | 20.4 | 0.29 (Go) | |

**Cost columns** (owner assumption 2026-10-18: 99% cache-read uniform, 1% io at 80/20
in/out, off-peak; DS peak ×2 shown): blended $/M and solo monthly tokens
(`listedLimit ÷ blend`; Plus cap where researched, else Go cap marked "(Go)"). Prices and
Go limits from the console table (opencode.ai/v2/docs/console/go/, fetched 2026-10-18).
Caveat: cache ratio is **per-model behavior**, not uniform — OpenCode's own data page puts
glm-5.3-flash at 93% typical (our corpus: 92.8%), DS rows ~98% — and io price differs
17× (GLM-Flash 17¢/M avg io vs MiMo-Pro 54¢). At *observed* mixes the meter weight per
token is DS 5.4e-5 < GLM-Flash 2.2e-4 < MiMo-Pro 3.8e-4 (GLM 1.7× lighter than MiMo); at
the uniform-99% assumption MiMo-Pro (1.5e-4) edges GLM-Flash (1.8e-4) because the
assumption shrinks MiMo's expensive-io share. Seat decisions use observed mixes.

Sub-3-point gaps are noise (harness variance — Anthropic's infrastructure-noise
study moved TB2.0 scores by 6 points on resource config alone). Seat-repick
rulings landed 2026-10-18 ([subagents/037](../decisions/subagents/037-reviewer-oracle-repick.md)):
reviewers → `opencode-go/glm-5.3-flash`, oracle → `opencode-go/deepseek-v4-pro`,
implementer stays on DeepSeek V4.1 Flash. Do not treat the composite as a
decision — the gaps that matter here are >10 points.

**Cost evaluation is monthly-cap-only** (owner ruling, [model-tiers/004](../decisions/model-tiers/004-monthly-cap-only-cost-metric.md)):
compare effective monthly volume (monthly listed $ limit ÷ blended $/M burn rate) and
nothing else. The req/5h column is informational — never a cost input, never
converted into monthly-equivalents. Effective volume = solo capacity, not a private
bucket: Go enforces one shared weighted allowance ([model-tiers/005](../decisions/model-tiers/005-shared-allowance-not-buckets.md)),
so fleet sustainability is judged against `Σ real$ ÷ listedLimit ≤ 1`, and the
solo-throughput columns below are per-model illustrations of that allowance.

---

## TL;DR — value-tier picks (cost-conscious set, flagships excluded)

| Role | Top pick | Best value | Notes |
|---|---|---|---|
| **Orchestrator** | **GPT-5.6 Luna** (93.6, $0.04, 1M) | **DeepSeek V4.1 Flash** (`:max` — decision 022, current fleet) | Luna's live price collapsed ($0.41 → **$0.04**/M blended). The 2026-08-01 snapshot had no v4.1 row; the fleet reverts to DeepSeek after the z.ai plan ended. DeepSeek V4 Flash 0731 projects 85.2 Orch — **proxy, unmeasured** (see refresh note 3). |
| **Implementer** | **Grok 4.5** (98.8, $0.62) | **DeepSeek V4.1 Flash** (`:high` — decision 022, current fleet) · **DeepSeek V4 Flash 0731** (83.7 ⚠, **$0.019**) | All seats share one model since 2026-10-01; 0731 remains the snapshot's cheap coder — AA-index-only. Pro at `high` scores 48.8. |
| **Oracle (math/algo)** | **DeepSeek V4 Pro** (91.9, snapshot) | **DeepSeek V4.1 Flash** (`:max` — decision 022; CF 3471 / Apex 65.6 beats Pro) | LCB/IMO/HMMT unpublished for 0731, so the snapshot held Pro; v4.1-flash's vendor-card Codeforces/Apex/DeepSWE rows supersede it (022). |
| **Reviewer (standard)** | **MiMo V2.5 Pro** (54.9 / 58.2, **$0.055**, 1M) | — | The review tier runs `xiaomi/mimo-v2.6-flash` — Xiaomi-lab, decorrelated from the DeepSeek implementer (experiment 023; supersedes 022's same-lab stopgap, which 017's mechanical checks covered while it lasted). |

**Two value stars, different jobs:**
- **DeepSeek V4.1 Flash** (OpenRouter, 1M ctx, multimodal) — the 2026-09-10 successor that
  absorbed every seat on 2026-10-01 ([022](../decisions/subagents/022-openrouter-fleet-v41-flash.md)):
  it beats `deepseek-v4-pro-0813` on Codeforces (3471 vs 3348), MathArena Apex (65.6 vs
  65.3), DeepSWE (74.2 vs 62.7) and TB2.1 (90.6 vs 87.9) at a fraction of the list price,
  and is pinned to the first-party endpoint for unquantized weights (caching itself
  is broad across OpenRouter hosts — probe 2026-10-01).
- **GLM-5.3 / GLM-5.3-flash** — retained as history: they ran the fleet on the z.ai plan
  until the subscription ended (decision 020; effort split 021).

**Current assignments vs. the data** (see [Role-by-role review](#role-by-role-review-2026-08-01--historical-audit); fleet moved 2026-10-01 per [decision 022](../decisions/subagents/022-openrouter-fleet-v41-flash.md); model id refreshed to the -1017 checkpoint 2026-10-18 per [decision 035](../decisions/subagents/035-flash-1017-refresh.md) — the "moved 2026-10-01" verdicts record when each seat adopted its model/level, not the id suffix):

| Slot | Agent file | Model | Effort | Verdict |
|---|---|---|---|---|
| Main session | `settings.json` | opencode-go/glm-5.3-flash | `defaultThinkingLevel` — `high` | ✓ user-flipped 2026-10-18 (OpenCode Go plan; orchestrators inherit per 031) |
| Orchestrator-subagent | `agents/orchestrator.md` | caller's model + `:max` (031; frontmatter donor `opencode-go/deepseek-v4.1-flash`) | max | ✓ moved 2026-10-01 (decision 022) |
| Implementer | `agents/implement.md` | opencode-go/deepseek-v4.1-flash | high | ✓ moved 2026-10-01 (decision 022) |
| Oracle | `agents/math-algo-oracle.md` | opencode-go/deepseek-v4-pro | max | ✓ 037, 2026-10-18: the only solid math/algo row on the Go menu (LCB 93.5/IMO 89.8); low volume fits its $15 bucket | ✓ moved 2026-10-01 (decision 022; beats 0813 on CF/Apex/DeepSWE/TB2.1) |
| Review standard ×3 | `agents/review-{code,plan,tests}.md` | openrouter/z-ai/glm-5.3-flash | high | ✓ provider moved 2026-10-22 (041) — off OpenCode Go extra-usage billing, same model | ✓ migrated 2026-10-18 (037) — Zhipu lab, decorrelated from the DeepSeek implementer; supersedes 023's Xiaomi tier |
| Scouts ×2 | `agents/scout-{code,web}.md` | opencode-go/deepseek-v4.1-flash | low | ✓ moved 2026-10-01 (decision 022; `:medium` was a silent clamp to high, replaced with the real discount tier for read-only research) |
| Compaction | `extensions/compaction-model.ts` | opencode-go/deepseek-v4.1-flash | low | ✓ moved 2026-10-01 (decision 022; constant target, explicit `:low` — without a level it rode the provider default `high`) |

> History note: the **review deep ×3** rows (`agents/review-*-deep.md`) were
> **deleted 2026-08-28** — the tier fired once ever; quality rationale lapsed; see
> [decision 020](../decisions/subagents/020-fleet-glm-53-flash-single-tier.md).

---

## Primary table — value tier (21 rows)

Sorted by Orchestrator. Orchestrator/Implementer normalized **within this 21-row set**
(100 = best-in-set); Oracle is an absolute math/algo %-composite (see its own table).
Cost at 95/5 I/O, 98% cache, live `/models` pricing. Variant rows shown for DeepSeek
(High = operative fleet level, Max = ceiling).

| Model | Orch | Impl | Oracle | $/M | Ctx | MM | Conf (O / I / Or) |
|---|--:|--:|--:|--:|--:|:--:|---|
| GPT-5.6 Luna | **93.6** | **91.7** | – | **0.041** | 1050K | ✓ | solid / solid / — |
| Grok 4.5 | 85.5 | **98.8** | – | 0.617 | 500K | ✓ | solid / solid / — |
| DeepSeek V4 Flash 0731 | 85.2 ⚠ | 83.7 ⚠ | – | **0.019** | 1048K | – | **proxy** / **proxy** / — |
| GLM-5.2 | 81.2 | 80.7 | 99.2 ⚠ | 0.391 | 1048K | – | solid / solid / aime-only |
| Gemini 3.5 Flash | 64.3 | 59.3 | – | 0.618 | 1048K | ✓ | solid / solid / — |
| MiniMax-M3 | 63.4 | 56.2 | – | 0.122 | 1048K | ✓ | solid / solid / — |
| Qwen3.7 Max | 57.4 | 74.8 | 91.6 | 0.524 | 1000K | – | solid / solid / **solid** |
| MiMo-V2.5-Pro | 55.3 | 46.0 | – | **0.055** | 1048K | – | solid / solid / — |
| Kimi K2.6 | 51.7 | 56.7 | 96.4 ⚠ | 0.228 | 262K | ✓ | solid / solid / aime-only |
| GPT-5.4 mini | 46.4 | 37.8 ⚠ | – | 0.309 | 400K | ✓ | solid / **proxy** / — |
| DeepSeek V4 Pro (Max) | 46.4 | 59.6 | **91.9** | **0.055** | 1048K | – | solid / **solid** / **solid** |
| Kimi K2.7 Code | 39.5 | 49.7 ⚠ | – | 0.329 | 262K | ✓ | solid / **proxy** / — |
| DeepSeek V4 Pro (High) | 37.0 | 48.8 | **91.9** | **0.055** | 1048K | – | solid / **solid** / **solid** |
| GPT-5.4 nano | 33.8 | 38.7 ⚠ | – | 0.085 | 400K | ✓ | solid / **proxy** / — |
| Qwen3.7 Plus | 33.5 | 34.8 ⚠ | – | 0.130 | 1000K | ✓ | solid / **proxy** / — |
| Hy3 | 33.0 | 33.4 | – | 0.060 | 262K | – | partial / **proxy** / — |
| GLM-5.1 | 32.5 | 43.0 | 95.3 ⚠ | 0.337 | 202K | – | solid / partial / aime-only |
| Nex-N2-Pro | 29.6 | 34.8 ⚠ | – | 0.078 | 262K | ✓ | **proxy** / **proxy** / — |
| DeepSeek V4 Flash (Max) | 23.9 | 38.6 | 90.2 | **0.029** | 1048K | – | solid / **solid** / **solid** |
| MiMo-V2.5 | 17.2 | 28.8 ⚠ | – | **0.019** | 1048K | ✓ | solid / **proxy** / — |
| DeepSeek V4 Flash (High) | 17.0 | 31.7 | 90.2 | **0.029** | 1048K | – | solid / **solid** / **solid** |

⚠ = score is an unverified proxy (AA-index-only, AIME-only, or no role data). MM = image input.
`–` in Oracle = **no competition-math/algo eval published** (unknown, not zero).

**Read the 0731 row carefully:** it scores 85.2/83.7 on **AA indices alone** — every
granular benchmark (SWE-Pro, TB2, SWE-Ver, LCB, IMO/HMMT) is unpublished, so the
composite is a projection, not a measurement. Its `proxy (0/4)` confidence flag is the
honest read. Old-flash `(High)` is the currently-measured worker baseline (31.7 IMPL);
0731's real IMPL is wherever its granular benchmarks land — anywhere from "matches old
flash" to "beats Pro" (Pro High: 48.8).

---

## Reviewer table — value tier

Adversarial review splits into two passes (weights in
[Role definitions](#role-definitions--weights)): **review-code** (comprehension-tilt:
find bugs in the implementation) and **review-tests** (reasoning-tilt: find coverage
gaps, weak or tautological tests). "Decorr" flags lab-diversity from the DeepSeek
implementers — a same-lab reviewer is an independence risk regardless of score.

| Model | R-code | R-test | $/M | Ctx | Lab / decorr |
|---|--:|--:|--:|--:|---|
| GPT-5.6 Luna | **91.0** | **91.1** | **0.041** | 1050K | OpenAI ✓ |
| Grok 4.5 | 89.2 | 84.6 | 0.617 | 500K | xAI ✓ |
| DeepSeek V4 Flash 0731 | 80.4 ⚠ | 79.1 ⚠ | 0.019 | 1048K | DeepSeek ✗ same-lab |
| **GLM-5.2** | **79.2** | **79.0** | 0.391 | 1048K | Zhipu ✓ |
| Gemini 3.5 Flash | 68.9 | 69.3 | 0.618 | 1048K | Google ✓ |
| Qwen3.7 Max | 65.7 | 64.1 | 0.524 | 1000K | Alibaba ✓ |
| MiniMax-M3 | 59.4 | 64.1 | 0.122 | 1048K | MiniMax ✓ |
| Kimi K2.6 | 55.5 | 56.3 | 0.228 | 262K | Moonshot ✓ |
| MiMo-V2.5-Pro | 54.9 | 58.2 | **0.055** | 1048K | Xiaomi ✓ |
| DeepSeek V4 Pro (Max) | 43.9 | 45.2 | 0.055 | 1048K | DeepSeek ✗ same-lab |
| Kimi K2.7 Code | 42.7 | 41.3 | 0.329 | 262K | Moonshot ✓ |
| GPT-5.4 mini | 40.0 | 42.3 | 0.309 | 400K | OpenAI ✓ |
| DeepSeek V4 Pro (High) | 37.4 | 38.2 | 0.055 | 1048K | DeepSeek ✗ same-lab |
| Qwen3.7 Plus | 34.1 | 33.4 | 0.130 | 1000K | Alibaba ✓ |
| GPT-5.4 nano | 32.7 | 32.6 | 0.085 | 400K | OpenAI ✓ |
| GLM-5.1 | 32.5 | 30.5 | 0.337 | 202K | Zhipu ✓ |
| Hy3 | 31.4 | 31.0 | 0.060 | 262K | Tencent ✓ |
| Nex-N2-Pro | 29.5 | 27.3 | 0.078 | 262K | NexAGI ✓ |
| DeepSeek V4 Flash (Max) | 27.3 | 27.8 | 0.029 | 1048K | DeepSeek ✗ same-lab |
| DeepSeek V4 Flash (High) | 16.3 | 17.5 | 0.029 | 1048K | DeepSeek ✗ same-lab |
| MiMo-V2.5 | 17.5 | 13.2 | **0.019** | 1048K | Xiaomi ✓ |

The reviewer seat is now **single-tier** — it first ran the fleet flash at `:high` (decision 022; the level survived 021, the GLM basis did not), and since 2026-10-01 the whole tier runs `xiaomi/mimo-v2.6-flash:high` (experiment 023, decorrelated); the two-tier
split (MiMo standard / GLM-5.2 deep) is deleted.
Note **0731's 80.4 R-code is a same-lab AA-index projection** — while the seat was same-lab
(022), it accepted that for cost, with 017's mechanical checks carrying anti-fabrication.

---

## A note on cost & the I/O ratio

Cost uses a **95/5 input/output split at 98% cache hit**. These roles are input-heavy —
the orchestrator re-reads a big cached context (system prompt + session state) every turn
with small outputs — so the **cached-read price**, not nominal prompt price, dominates.

The give-away is the cache discount. Example (raw $/M): MiniMax-M3's prompt is the
*cheapest* of its peers ($0.30) but it only discounts cached tokens by 80% → cached-read
**$0.060/M**, versus MiMo V2.5 Pro / DeepSeek V4 Pro at **$0.0036/M** (99.2% off). On a
cache-heavy workload that ~16.7× gap is the whole bill.

**New for 2026-08-01: DeepSeek V4 Flash 0731's cache-read is 10× cheaper than old
flash** — $0.0028/M vs $0.028/M (99.7% off prompt vs 92.6% for old flash). Same prompt
price ($0.14/M), same 1M ctx, but the new checkpoint discounts cached tokens far more
aggressively. On this cache-heavy workload that's the difference between $0.019/M and
$0.043/M blended — the 0731 upgrade is cheaper per-turn, not just per-token.

| Ratio (of MiMo) | MiniMax-M3 | GLM-5.2 | GPT-5.6 Luna |
|---|--:|--:|--:|
| 90/10 | 1.82× | 4.24× | 7.21× |
| **95/5** | **2.21×** | **5.29×** | **7.48×** |

That's why MiniMax M3 — a fine orchestrator on quality — proved too expensive per-turn
versus MiMo. **Compare models on cached-read price / blended cost, not sticker price.**

---

## Oracle — math/algo detail (value tier)

Only 6 of 21 rows published *any* competition-math/algorithm eval. The composite
is a weighted % of LiveCodeBench (×5) · IMO/HMMT (×4) · AIME (×3). **AIME is saturated**
(most capable models hit 95–100%), so it barely discriminates — the real signal is
LiveCodeBench, Codeforces, and IMO/HMMT. LCB/IMO/HMMT remain framia-sourced (BenchLM
doesn't track them for DeepSeek).

| Model | LiveCodeBench | IMO/HMMT | AIME | Codeforces | Score | Evidence |
|---|--:|--:|--:|--:|--:|---|
| DeepSeek V4 Pro (Max) | **93.5** | 89.8 | – | **3206** | 91.9 | ✅ hard/algo — #1 globally |
| DeepSeek V4 Pro (High) | **93.5** | 89.8 | – | 2919 | 91.9 | ✅ hard/algo — #1 globally |
| Qwen3.7 Max | 91.6 | – | – | – | 91.6 | ✅ algo only |
| DeepSeek V4 Flash (Max) | 91.6 | 88.4 | – | 3052 | 90.2 | ✅ hard/algo · **$0.029/M** |
| DeepSeek V4 Flash (High) | 91.6 | 88.4 | – | 2816 | 90.2 | ✅ hard/algo · **$0.029/M** |
| GLM-5.2 | – | – | 99.2 | – | 99.2 | ⚠ AIME-only (saturated) |
| Kimi K2.6 | – | – | 96.4 | – | 96.4 | ⚠ AIME-only |
| GLM-5.1 | – | – | 95.3 | – | 95.3 | ⚠ AIME-only |

**Unknown** (no math/algo eval): Grok 4.5, GPT-5.6 Luna, Gemini 3.5 Flash, MiniMax-M3,
MiMo-V2.5-Pro, Kimi K2.7 Code, Hy3, Nex-N2-Pro, GPT-5.4 mini, Qwen3.7 Plus, GPT-5.4
nano, MiMo-V2.5, **DeepSeek V4 Flash 0731** (LCB/IMO/HMMT unpublished).

**Read by evidence, not raw score.** GLM-5.2 tops the number (99.2) but on saturated AIME
alone; **DeepSeek V4 Pro is the true math/algo oracle** — #1 on contamination-free
LiveCodeBench (93.5) and Codeforces (3206), plus IMO 89.8 / HMMT 95.2. **DeepSeek V4 Flash
delivers ~98% of that for $0.029/M.** The 0731 checkpoint's math/algo numbers are the
single most valuable missing datum — if its LCB/IMO clear Pro's, the oracle moves to flash
pricing.

> **Resolved 2026-10-01 (decision [022](../decisions/subagents/022-openrouter-fleet-v41-flash.md)):**
> the oracle moved to `deepseek/deepseek-v4.1-flash:max` — the 2026-09-10 successor beats
> 0813-pro on Codeforces (3471 vs 3348), MathArena Apex (65.6 vs 65.3), DeepSWE (74.2 vs
> 62.7) and TB2.1 (90.6 vs 87.9). The table above is the 2026-08-01 snapshot and predates it.

---

## Role-by-role review (2026-08-01) — historical audit

Historical reasoning from the 2026-08-01 snapshot and the 020/021 z.ai move; the current
state is the **Current assignments** table above (2026-10-01, decision 022). GLM references
below are history, not fleet config.

Assignments audited against the refreshed data (the 020/021 move happened 2026-08-28):

1. **Main session — `zai/glm-5.3` (settings.json default).** Fixed 2026-08-28 — the assignment table previously said 0731, but the session has run `zai/glm-5.3` since commit 80e16db. `defaultThinkingLevel` is now **`max`** (raised from `high` 2026-08-28 per decision 021 — a same-day user settings flip, committed by WO-2026-049; the earlier deliberate-`high` note is superseded). Effort suffixes on agent frontmatter are unaffected by the session default.
2. **Orchestrator-subagent — `zai/glm-5.3:max`.** Moved 2026-08-28 (decision 020); effort raised `high`→`max` same day by [decision 021](../decisions/subagents/021-effort-rebalance.md) (user benchmark review — the glm-5.3 high-vs-max token delta is notably less stark than flash's), superseding 020's/016's cap-reasoning-spend note. 0731 projects 85.2 Orch (AA indices only) — but orchestrator duty is planning/IF/agentic, and 0731's granular evidence for that is zero; the GLM-5.2→5.3 move stays in the same family the fleet already trusted.
3. **Implementer — `zai/glm-5.3-flash:high` (flash seat).** Moved 2026-08-28 (decision 020). Flash seat AA indices (57.5/71.5/58.2) dominate the 0731 incumbent (51.8/69.1/48.4) at ⅓ the z.ai plan's points per call; `/fleet-model deepseek` toggles the whole seat back during a credit-low period. Pro's old slot existed for implicit-invariant resilience; the invariant-enumeration step in the agent prompt covers that. See [decision 012](../decisions/subagents/012-implementer-collapse.md) for the pre-history.
4. **Oracle — `deepseek/deepseek-v4-pro-0813:max`.** `:max` added 2026-08-28 (decision 020, user directive). Only verified hard-math/algo leader (LCB 93.5, IMO 89.8, CF 3206); 0731's math/algo numbers are unpublished and GLM-5.x has zero math rows anywhere — oracle stays on 0813 until independent math data appears.
5. **Review standard ×3 — `zai/glm-5.3-flash:high`.** Moved 2026-08-28 (decision 020; single review tier — the deep tier is deleted); effort dropped `max`→`high` same day by decision 021 (flash high-vs-max: negligible quality delta, large token delta). Same-lab with the implementer accepted for cost since 019; 017's mechanical checks carry anti-fabrication.
6. **Review deep ×3 — DELETED 2026-08-28.** The tier fired exactly once in fleet history; its quality rationale (GLM-5.2 > standard) lapsed once the standard tier outscored it; decorrelation value gone after the z.ai flip. See [decision 020](../decisions/subagents/020-fleet-glm-53-flash-single-tier.md).
7. **Scouts ×2 — `zai/glm-5.3-flash:medium`.** Moved 2026-08-28 (decision 020) — read-only research; effort set to `medium` (speed + cost; no code written). Decision 021 keeps `:medium`: inert on zai (falls back to provider-default high) and valid under the deepseek toggle.
8. **Compaction — fleet flash seat (`zai/glm-5.3-flash` default).** Moved 2026-08-28 (decision 020) — compaction rides the seat and the `/fleet-model` toggle flips it too. `models.json` was pruned to a single correctness-guard override (0813-pro first-party routing pin); the `-0731` maxTokens pin and routing order were removed as stale-to-restrictive (catalog 943,718 vs pin 131,072).

---

## Role definitions & weights

Star weights → numeric; normalization noted per benchmark
(`mm` = min-max within set, `raw` = raw %/100 for sparsely-reported benchmarks).

### Orchestrator — *balanced* (planning leads, execution counts)
AA-LCR ×5 `mm` · AA Intelligence Index ×5 `mm` · **IFBench ×4 `raw`** · Terminal-Bench 2.0
×4 `mm` · SWE-bench Pro ×3 `mm` · AA Agentic Index ×3 `mm`.
Context window & MCP are separate columns (soft, not gated). **AA-Omniscience**
(hallucination) is tracked on BenchLM now (Accuracy + Hallucination Rate, both with
DeepSeek variant rows) — carried as informational, not in the composite.

- **GPT-5.6 Luna (93.6, $0.04, 1M)** — strong across long-context, reasoning, IF, and
  agentic tool-use; now *cheap* (live pricing). Best all-round orchestrator in the tier.
- **GLM-5.2 (81.2, $0.39, 1M)** — best open-weights value; measured on all granular axes.
- **Grok 4.5 (85.5)** — high, but **500K context** is marginal for long sessions.
- **DeepSeek V4 Flash 0731 (85.2 ⚠)** — projects high on AA indices alone; **zero
  granular evidence** — do not assign on this.
- **DeepSeek V4 Pro (High 37.0, Max 46.4)** — cheap but planning-weak.

### Implementer — *balanced blend* (repo-SWE ≈ self-contained coding)
SWE-bench Pro ×5 `mm` · **LiveCodeBench ×5 `raw`** · AA Coding Index ×4 `mm` · SWE-bench
Verified ×3 `mm` · Terminal-Bench 2.0 ×3 `mm` · **IFBench ×2 `raw`**.
Cost is the second axis (parallel-worker throughput economics).

- **Grok 4.5 (98.8, $0.62)** — top quality; **GPT-5.6 Luna (91.7, $0.04)** close and cheap.
- **GLM-5.2 (80.7, $0.39)** — the throughput sweet spot.
- **DeepSeek V4 Flash 0731 (83.7 ⚠, $0.019)** — projects above both Pro rows on AA
  indices alone; the two ×5 granular weights (SWE-Pro, LCB) are unpublished. Watch item.
- **DeepSeek V4 Pro (High 48.8 / Max 59.6, $0.055)** — the measured value worker until
  0731 granular confirms.

### Oracle — *math/algo focused*
LiveCodeBench ×5 · IMO/HMMT ×4 · AIME ×3 (raw weighted %). HLE and GPQA-Diamond were
**removed** — they measure science *knowledge*, not math/algorithms. **DeepSeek V4 Pro /
Flash** are the picks; the AIME-only leaders are flagged.

### Reviewer — *adversarial, two passes*
**review-code** = AA-Coding ×5 `mm` · AA-Intelligence ×4 `mm` · IFBench ×4 `raw` ·
AA-LCR ×3 `mm` · SWE-bench Pro ×3 `mm` (comprehension-tilt: find bugs).
**review-tests** = AA-Intelligence ×5 `mm` · IFBench ×4 `raw` · AA-LCR ×4 `mm` ·
AA-Coding ×3 `mm` · SWE-bench Pro ×2 `mm` (reasoning-tilt: find coverage gaps).
Lab decorrelation from the implementer (currently DeepSeek) is a **hard filter applied
at assignment time**, not a score term.

---

## Confidence & "unknown"

Every model has the three AA composite indices (full coverage), which internally embed the
role benchmarks — so no score is *baseless*. The flag measures **standalone corroboration**:

- **solid** — most standalone role benchmarks published; measured.
- **partial** — one standalone benchmark; the rest lean on the AA index.
- **proxy (⚠)** — no standalone role benchmark → AA-index-only estimate = **"unknown."**
- Oracle-specific: **aime-only (⚠)** = only saturated AIME; **`–`** = no math/algo eval.

**Treat as effectively unknown:**

| Model | Unknown for | Why |
|---|---|---|
| **DeepSeek V4 Flash 0731** | all roles | Granular benchmarks **unpublished anywhere** (released 2026-07-31; DeepSeek's launch has only agentic evals, BenchLM holds April-24 Preview placeholders). AA-index-only projection. **Highest-priority datum to fill** — `--check-0731` re-check 24-48h. |
| **MiMo-V2.5, Qwen3.7 Plus, GPT-5.4 nano** | all roles | No standalone role benchmarks. |
| **Kimi K3** | all roles | AA-index only. |
| **Nex-N2-Pro** | all roles | On no granular leaderboard; AA-index only. |
| **12 value rows** | Oracle | No competition-math/algo eval published. |
| **GLM-5.2 / Kimi K2.6 / GLM-5.1** | Oracle rigor | Only saturated AIME — high number, weak evidence. |
| **GPT-5.4 mini / Kimi K2.7 Code** | Implementer | No SWE / LiveCodeBench data. |

Pattern: the newest agentic-tuned models (GPT-5.6 Luna, Grok 4.5, Sonnet 5, Kimi K3)
stopped publishing classic academic benchmarks (GPQA/HLE/AIME/IFBench), reporting only
agentic/coding evals — which is why Oracle and IFBench are the thinnest-covered axes.
The 0731 checkpoint is the reverse: AA indices day-one, granular lagging.

---

## Appendix A — full frontier (all 32 rows, incl. flagships)

Reference "ceiling." Normalized **within all 32**, so **not comparable** to the value-tier
table. Flagships excluded from the primary analysis on cost grounds. Cost at 95/5 I/O.
Sorted by Orchestrator.

| Model | Orch | Impl | Oracle | $/M | Ctx | Conf (O/I/Or) |
|---|--:|--:|--:|--:|--:|---|
| Kimi K3 | **92.9** | **95.5** | – | 1.086 | 1048K | proxy/proxy/— |
| GPT-5.6 Sol | 86.4 | 76.2 | – | 2.061 | 1050K | solid/solid/— |
| Claude Fable 5 | 84.1 | 91.1 | – | 3.621 | 1000K | solid/solid/— |
| GPT-5.6 Terra | 78.0 | 70.9 | – | 0.412 | 1050K | solid/solid/— |
| GPT-5.5 | 73.4 | 60.1 | – | 2.061 | 1050K | solid/solid/— |
| GPT-5.6 Luna | 72.7 | 61.1 | – | 0.041 | 1050K | solid/solid/— |
| Claude Sonnet 5 | 68.4 | 55.8 | – | 0.724 | 1000K | solid/solid/— |
| GPT-5.4 | 67.0 | 49.6 | – | 1.030 | 1050K | solid/partial/— |
| Grok 4.5 | 66.5 | 64.4 | – | 0.617 | 500K | solid/solid/— |
| GLM-5.2 | 66.4 | 56.8 | 99.2 ⚠ | 0.391 | 1048K | solid/solid/aime-only |
| Claude Opus 4.8 | 65.9 | 66.0 | – | 1.810 | 1000K | solid/solid/— |
| DeepSeek V4 Flash 0731 | 64.7 ⚠ | 67.4 ⚠ | – | 0.019 | 1048K | proxy/proxy/— |
| Gemini 3.1 Pro | 57.4 | 69.9 | – | 0.824 | 1048K | solid/proxy/— |
| Gemini 3.5 Flash | 56.2 | 46.8 | – | 0.618 | 1048K | solid/solid/— |
| MiniMax-M3 | 54.2 | 30.5 | – | 0.122 | 1048K | solid/solid/— |
| Qwen3.7 Max | 49.7 | 52.2 | 91.6 | 0.524 | 1000K | solid/solid/solid |
| MiMo-V2.5-Pro | 48.9 | 34.1 | – | 0.055 | 1048K | solid/solid/— |
| GPT-5.4 mini | 47.3 | 35.2 ⚠ | – | 0.309 | 400K | solid/proxy/— |
| Claude Opus 4.7 | 47.2 | 71.3 | – | 1.810 | 1000K | solid/proxy/— |
| Kimi K2.6 | 45.8 | 32.3 | 96.4 ⚠ | 0.228 | 262K | solid/solid/aime-only |
| DeepSeek V4 Pro (Max) | 43.2 | 42.7 | 91.9 | 0.055 | 1048K | solid/solid/solid |
| Kimi K2.7 Code | 41.8 | 44.1 ⚠ | – | 0.329 | 262K | solid/proxy/— |
| GPT-5.4 nano | 38.7 | 36.1 ⚠ | – | 0.085 | 400K | solid/proxy/— |
| DeepSeek V4 Pro (High) | 36.3 | 38.2 | 91.9 | 0.055 | 1048K | solid/solid/solid |
| Hy3 | 35.8 | 26.9 | – | 0.060 | 262K | partial/proxy/— |
| GLM-5.1 | 33.9 | 29.3 | 95.3 ⚠ | 0.337 | 202K | solid/partial/aime-only |
| Qwen3.7 Plus | 33.5 | 25.3 ⚠ | – | 0.130 | 1000K | solid/proxy/— |
| DeepSeek V4 Flash (Max) | 27.6 | 32.4 | 90.2 | 0.029 | 1048K | solid/solid/solid |
| Nex-N2-Pro | 24.8 | 28.1 ⚠ | – | 0.078 | 262K | proxy/proxy/— |
| DeepSeek V4 Flash (High) | 22.5 | 28.2 | 90.2 | 0.029 | 1048K | solid/solid/solid |
| Claude Sonnet 4.6 | 20.3 | 32.1 | – | 1.086 | 1000K | solid/partial/— |
| MiMo-V2.5 | 13.3 | 18.6 ⚠ | – | 0.019 | 1048K | solid/proxy/— |

Flagship ceiling: Kimi K3 leads both axes (AA-index-only — proxy), with Claude Fable 5 /
GPT-5.6 Sol close. **DeepSeek V4 Flash 0731 sits mid-frontier on AA indices alone** —
between Claude Sonnet 5 and Gemini 3.1 Pro on Impl — at $0.019, the cheapest row in the
set. Granular data will decide whether that's real.

---

## Appendix B — raw benchmark data & coverage

Per-benchmark coverage across the 32 rows (blank = no published/tracked score).

| Benchmark | Role use | Norm | Coverage | Source(s) |
|---|---|:--:|--:|---|
| AA Intelligence Index | Orch | mm | 32/32 | BenchLM `/benchmarks/artificialanalysis` |
| AA Coding Index | Impl | mm | 32/32 | BenchLM `/benchmarks/aacodingindex` |
| AA Agentic Index | Orch | mm | 32/32 | BenchLM `/benchmarks/aaagenticindex` |
| AA-LCR (long context) | Orch, Review | mm | 31/32 | BenchLM `/benchmarks/lcr` |
| Terminal-Bench 2.0 | Orch, Impl | mm | 31/32 | BenchLM `/benchmarks/terminal-bench-2` |
| SWE-bench Pro | Orch, Impl, Review | mm | 29/32 | BenchLM `/benchmarks/swe-bench-pro` |
| SWE-bench Verified | Impl | mm | 25/32 | BenchLM `/benchmarks/swe-bench-verified` |
| IFBench | Orch, Impl, Review | raw | 27/32 | BenchLM `/benchmarks/aaifbench` |
| LiveCodeBench | Impl, Oracle | raw | 1/32 | framia (BenchLM tracks only Qwen) |
| IMO-AnswerBench / HMMT | Oracle | raw | 2/32 | framia (DeepSeek) |
| AIME 2025/26 | Oracle | raw | 3/32 | BenchLM `/benchmarks/aime2026` |
| Codeforces (rating) | Oracle (info) | — | 2/32 | BenchLM `/benchmarks/codeforces` |
| AA-Omniscience (Acc / Halluc) | Orch (info) | — | ~24/32 | BenchLM `/benchmarks/omniscienceaccuracy` + `omnisciencehallucinationrate` |
| Pricing (prompt/cache-read/completion) | Cost | — | 32/32 | OpenRouter `/models` |

Coverage jumped sharply vs 2026-07-23: IFBench 4/29 → 27/32, AA-LCR 24/29 → 31/32, SWE-Pro
19/29 → 29/32. The remaining holes: **DeepSeek V4 Flash 0731** (no granular anywhere yet),
**Nex-N2-Pro** (no BenchLM rows at all), and LiveCodeBench/IMO/HMMT (framia-only).

**Excluded from composites** (too sparse to score the set, or off-role):

- **HLE, GPQA-Diamond** — moved *out of Oracle*: science knowledge, not math/algorithms.
- **τ³-Bench, LiveCodeBench Pro (Elo)** — sparse; AA Agentic / LiveCodeBench substitute.
- **Throughput (tokens/sec)** — considered, not added (per steering); cost is the value axis.

### Caveats

1. **Relative, within-set (Orch/Impl/Review).** Min-max makes best-in-set = 100, worst = 0.
   Value-tier and full-frontier tables use different bounds and aren't cross-comparable.
2. **Snapshots aren't comparable either.** The 2026-08-01 refresh added DeepSeek variant
   rows + the 0731 checkpoint, which stretched min-max bounds and moved incumbents' scores
   with zero new capability data. Compare within a snapshot, not across.
3. **Saturation.** GPQA-D, SWE-Verified, AIME are compressed near the top — small real gaps
   get stretched (Orch/Impl) or dominate raw scores (AIME in Oracle). Read leads as ties.
4. **Sparse benchmarks use raw %** (IFBench, LiveCodeBench) to avoid 3–4-point min-max
   artifacts, at a mild scale-mismatch cost with the min-max benchmarks.
5. **Benchmark gaming.** A 2026 Berkeley (RDI) study showed SWE-bench Verified,
   Terminal-Bench, and others can be driven to near-perfect scores without solving tasks —
   don't over-trust any single agentic benchmark.
6. **Source consistency.** Vendor vs. SEAL scaffolds differ 15–30 pts on SWE-bench Pro; HLE
   varies with tools. BenchLM used as the primary consistent source, cross-checked.
7. **Cost basis.** Blended $/M at **95/5 I/O + 98% cache** — input-heavy because these roles
   re-read cached context each turn; cached-read price dominates. It's per-token, not
   per-resolved-task (a cheap model that fails often is expensive per success). The ratio is
   a one-line knob (`IN_RATIO`/`OUT_RATIO`) in `role_scores.py`.
8. **Pricing source.** This snapshot uses live OpenRouter `/models` prices; the
   `models.json` cost overrides were removed 2026-08-01, so pi's footer/cost
   tracking now uses the same numbers via the pi.dev catalog (see
   `decisions/subagents/010-pricing-source-pi-dev-catalog.md`). If you see a
   price here differ from what pi reports, the pi.dev catalog refresh (4h) is
   the lag source.
9. **Variant rows measure the thinking level, not the checkpoint.** DeepSeek `(High)`/
   `(Max)` rows use BenchLM's per-variant granular data but share framia LCB/IMO/HMMT
   (published base-only). The `(High)` row is what the fleet runs.
10. **DeepSeek V4 Flash base rows are April-24 Preview, not 0731.** BenchLM's
    `DeepSeek V4 Flash` (no-variant) rows are sourced from DeepSeek's April-24
    technical report and are retained as historical evidence — the hosted API now
    serves 0731, but BenchLM cannot run fresh evals without weights. All fleet-relevant
    flash granular values here use the `(High)`/`(Max)` reasoning-variant rows, which
    are the old 20260423 checkpoint's numbers. **No non-agentic eval has been
    published for 0731 by any party as of 2026-07-31.**

### Sources

- **BenchLM per-benchmark pages** (fetched 2026-07-31 via `docs/data/fetch_benchlm.py`):
  SWE-bench Pro, SWE-bench Verified, Terminal-Bench 2.0, AA-LCR, AA-IFBench, AA
  Intelligence/Coding/Agentic Index, AIME26, Codeforces, GPQA-D, AA-Omniscience
  Accuracy + Hallucination Rate — [benchlm.ai/benchmarks](https://benchlm.ai/benchmarks)
- [OpenRouter models](https://openrouter.ai/api/v1/models) + [benchmarks](https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis) — live pricing + AA indices
- [Artificial Analysis](https://artificialanalysis.ai/) — [Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) · [AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning) · [IFBench](https://artificialanalysis.ai/evaluations/ifbench) · [AA-Omniscience](https://artificialanalysis.ai/evaluations/omniscience)
- [framia — DeepSeek V4 benchmarks](https://framia.converge.ai/page/en-US/news/deepseek-v4-benchmarks) — LiveCodeBench, IMO/HMMT (BenchLM does not track these for DeepSeek)
- [morphllm — SWE-bench Pro](https://www.morphllm.com/swe-bench-pro) · [LM Council](https://lmcouncil.ai/benchmarks) · [Silicon Report — Fable 5](https://www.siliconreport.com/claude-fable-5-benchmarks-hle-swe-bench-gpqa-5c675c4e)

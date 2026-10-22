# Model seat economics — cache-weighted (2026-10)

Analysis record for the model-seat decisions (reviewer flip landed as decision 041; orchestrator
pick and plan moves pending). Sources: two scout reports (2026-10-22, plan landscape + live
OpenRouter pricing), the owner's pasted opencode console table (current period, began
≈2026-10-17T21:19Z), and `~/.pi/agent/sessions` usage records (38.7k, period-filtered).

## The cache-weighting rule (owner, 2026-10-22)

Long-running sessions trend to **~96% whole-session-sum cache-hit rate** — working number
**96.8%** (owner-confirmed 2026-10-22); price everything at the observed token mix, never at
input/output sticker prices alone. Observed CHR (prompt-sum basis =
cacheRead ÷ (cacheRead + fresh input)):

| seat | in / cache-read (M) | CHR |
|---|---|---|
| review seats (glm-5.3-flash) | 139.3 / 1,692 | 92.4% |
| fleet workhorses (ds-v4.1-flash) | 66.3 / 2,755 | 97.7% |
| main/orchestrator (mimo-v2.6-pro) | 16.1 / 489.2 | 96.9% |

Consequence: **the cache-read rate decides.** At 96% CHR, cache reads are ~82–86% of a GLM seat's
cost on routes without a cache discount, ~55% of Kimi K3's, but only ~14% of MiMo-Pro's and ~28%
of DS's. Any comparison quoted on input/output price alone is misleading.

## Cache rates, cache-weighted monthly cost (workload proxy: 107.9M in / 3,278M cache / 32.8M out)

| model | OR in · cache · out ($/M) | monthly at proxy | cache share of cost | Orch score |
|---|---|---|---|---|
| MiMo-V2.6-Pro | 0.435 · 0.0036 · 0.87 | **$87** | 14% | 83.1 |
| GLM-5.3-Flash (incumbent) | 0.0119 · 0.0119 · 0.1589 | $46 | 86% | 69.1 |
| GLM-5.3 | 0.079 · 0.078 · 1.40 | $310 | 82% | 78.3 |
| DS-V4-Pro-0813 | 0.66 · 0.022 · 1.98 | $208–417 (peak) | 22% | 31.3 |
| Kimi K3 | 3.00 · 0.30 · 15.00 | $1,799 | 55% | 84.2 |
| Qwen3.8-Max | 2.00 · 0.25 · 6.00 | $1,232 | 66% | 71.2 |
| Haiku 5.5 | 0.10 · 0.01 · 0.50 (×5 >100K ctx) | $60–300 | ~54% | 69.5 |

Scoring caveat: Orch composites from `docs/model-role-scores.md` (2026-10-18). `z-ai/glm-5.3`'s
OR price ($0.079 in / $0.078 cache) is 13–18× under z.ai's own API rate — possible promo; if it
reverts, GLM-5.3 on OR goes to ~$1,148/mo. **Re-check in ~2 weeks.**

## Seat deltas at observed traffic (this period, console-billed $125.85)

| seat | billed | Go metered | Zen | OpenRouter | note |
|---|---|---|---|---|---|
| reviewers (GLM-Flash) | $77.11 | 77.06 | 77.06 | **23.51** (fp4) / 77.06 (fp8 pin) | 041 landed; fp8 pin = dollar-neutral + frees quota wall; fp4 = −$53.55 but unmeasured weights |
| fleet (DS-Flash) | $34.70 | 27.15 | 54.30 | 27.15 (`-1017` pin) | Go's +27.8% is peak-hour blend, not overage |
| main (MiMo-Pro) | $13.10 | 13.65 | 13.03 | 13.03 | wash — leave on Go |
| oracle (DS-Pro) | $0.00 | — | — | — | zero this period |
| haiku-5-5 helper | $0.93 | — | — | — | ambient titler signature; immaterial |

The account shares one allowance wall (monthly 69% = $125.85 ÷ $180; weekly cap $90 blown).
GLM was 61% of quota consumption, so the 041 flip un-throttles the whole account independent of
the dollar delta. OpenRouter-side spend (main sessions) is billed separately: $1.75 this period.

## Plan landscape (2026-10-22)

- **Go $10 / Plus $40**: shared weighted allowance (model-tiers/005), 5h 20% / weekly 50% /
  monthly 100% windows, Zen overage (GLM unchanged rates; DS ×2 flat; DS-Pro 2.6–3.6×). Fine
  host for flash-class seats; **cannot host a strong-tier orchestrator** (every strong model
  exceeds its limit 1.45–30× at the proxy).
- **z.ai GLM Coding Plan** Lite $18 / Pro $80 / Max $168: credits (GLM-5.3: 6.9 in / 1.7 cached /
  24 out per 10k tokens), 50% off-peak (all but Mon–Fri 14–18 UTC+8), **hard stop, no overage**.
  At 96% CHR the proxy burns **~710k credits/mo (78% cache-derived)** vs Max's ~602k/mo
  equivalent: **118% at full rate, ~59% off-peak** — the earlier "~63% of weekly credits" reading
  holds only with off-peak discipline. TOS question: licensed for "supported coding tools",
  explicitly not a general API key.
- **Others**: MiniMax M (M3.1-Flash only, opaque quotas — no place in the fleet); Copilot
  (credits, no OpenAI-compatible key — SDK only); DevPass (one 2× shared allowance incl.
  frontier, open-model rates unpublished); Qwen Token Plan (real overage at 88%, single-seat
  candidate); Kimi (opaque credits); Claude subs (no third-party tools).

## Orchestrator pick (pending owner)

Per 031 the orchestrator inherits the caller's model, so this is a main-session choice unless
031's mechanics change. Both shapes are on the table.

1. **MiMo-V2.6-Pro** — $67–87/mo, highest measured Orch score on the menu (83.1), seat-proven
   (038's hard-decomposition window: 930 turns, sound), Xiaomi lab = decorrelated from both
   DeepSeek implementer and Zhipu reviewers. Breaks: heaviest Go meter weight (1.7×), granular
   benchmarks unpublished, observed endpoint instability (clustered 500s, ~2× slower turns).
2. **GLM-5.3 full on z.ai Max $168 flat** — measured granular rows behind its score, hard monthly
   ceiling, off-peak-friendly. Breaks: hard-stop throttling risk (118% at full rate), TOS
   question, Zhipu concentration (coordination + review in one lab).
3. Not recommended: GLM-5.3 on OR ($310 on a maybe-promo rate), DS-Pro (Orch 31.3), Kimi/Qwen
   (20–30× the headroom for +1–5 Orch points).

Open owner questions: 031 change vs main-session change; Zhipu two-seat concentration; z.ai TOS;
MiMo data-retention terms (never pinned like DS's ZDR, valid through 2026-10-31); GLM-5.3 OR
promo sanity; whether the Go plan stays post-overage.

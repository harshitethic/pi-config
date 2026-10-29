---
title: "OpenCode Go is a coupon, not a meter — fill it (~100%) with DeepSeek fleet traffic only"
type: decision
status: done
date: 2026-10-22
---

# OpenCode Go is a coupon, not a meter — fill it with DeepSeek fleet traffic only (042)

**What (owner ruling, 2026-10-22, verbatim):** *"seems like it would be better to keep only
deepseek on go and try to get 100% utilization (and not much more) of the sub plans token
allotment"*.

Earlier the same day the owner settled the other half of the split: the main-session model is
owner-managed — *"just set by me switching manually"* — which is why the main seat's provider
lives in `models.json` (a routing preference pin) and not in any fleet constant. The main session
runs `openrouter/xiaomi/mimo-v2.6-pro`; the owner switches to it with `/model` when he wants it.

**What changes:** the OpenCode Go plan is treated as a **prepaid coupon to be filled** — target
~100% of the monthly allotment and not much more — and only DeepSeek fleet traffic fills it:
implementer, scouts, compaction, and the orchestrator when it inherits a DeepSeek caller (031).
Everything flexible lives off the meter:

- reviewers → `openrouter/z-ai/glm-5.3-flash:high` (041, already landed);
- main session → `openrouter/xiaomi/mimo-v2.6-pro` (owner's manual `/model`);
- this record adds the one piece 041 left: a `xiaomi/mimo-v2.6-pro` routing **preference** in
  `models.json` — `order: ["xiaomi"]`, `allow_fallbacks: true`.

**Endpoint evidence** (`GET https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-pro/endpoints`
and `/api/v1/providers`, 2026-10-22). Five endpoints: DeepInfra `deepinfra/fp8` ($0.387 /
$0.783 / $0.00324 per M prompt / completion / cache-read, 10% discount), Novita `novita/fp8`
($0.435 / $0.87 / $0.0036), **Xiaomi `xiaomi/fp8` — the pinned one** ($0.435 / $0.87 / $0.0036,
1,048,576 ctx, `max_completion_tokens` 131,072, `supports_implicit_caching: true`, `tools` and
`reasoning` in `supported_parameters`, 100% uptime last 30 m / 99.2% last 1 d, HQ CN, datacenters
SG + NL), GMICloud `gmicloud/bf16` ($0.435 / $0.87 / $0.004), StreamLake `streamlake` quant
**unknown** ($0.522 / $1.044 / $0.00432). **No fp4 endpoint exists on this slug**, so no fallback
can land on the fp4 renditions 022 exists to avoid. The provider slug for routing is `xiaomi`
(lowercase; confirmed against `/api/v1/providers`, which is the list `order`/`only` are matched
against — pi's `compat.openRouterRouting.order` is sent as OpenRouter's `provider` request field).

**Why — the coupon-displacement accounting.** The Go plan is a prepaid bundle (~$180/mo of
metered value included on the plan), not a pass-through meter, so a metered non-DeepSeek token on
Go does not cost its metered value in isolation: it consumes coupon that DeepSeek traffic would
otherwise have consumed, and the displaced DeepSeek traffic falls out of the coupon into Zen
overage, where DeepSeek bills **2×** ($0.30 / $1.20 flat, no off-peak) against OpenRouter's pinned
first-party `-1017` route at **1×** ($0.15 / $0.60 / $0.003). "MiMo on Go is a wash" (the
2026-10-22 seat-delta table) is true only in isolation — at the margin its rate is Zen's 2×.

And the fleet alone now fills the coupon: at this period's pace DeepSeek traffic extrapolates to
roughly the coupon size — **~$230/mo metered against ~$180/mo included** (console table,
2026-10-22; fleet row $27.15 Go metered ~4.4 days into the period that began 2026-10-17T21:19Z;
workings in `docs/investigations/model-seat-economics-2026-10.md`). So the overflow question is
live rather than hypothetical, and it has an answer already paid for: DeepSeek overflow past the
coupon routes to `openrouter/deepseek/deepseek-v4.1-flash-1017` (035's pin, 1×), **never** to Zen
overage at 2×. All figures are 2026-10-22 snapshots.

## Alternatives rejected

- **Keep MiMo on Go** — the seat-delta table calls it a wash ($13.65 Go vs $13.03 OpenRouter) and
  that reading is correct in isolation. Rejected: coupon displacement makes the marginal rate
  Zen's 2×, and it spends coupon the DeepSeek fleet needs.
- **Turn extra-usage billing off instead of moving traffic** — rejected (owner): the plan's
  5 h / weekly / monthly windows would then hard-throttle *the owner's own session mid-work*,
  which is the failure mode 036/038 were shaped around. Filling the coupon while keeping
  extra-usage as the pressure valve is the gentler shape.
- **Automate the provider flip at the coupon boundary** (meter at x% → switch flexible seats back
  onto Go) — rejected for now: nothing in this config meters spawns against a plan balance, and
  building that is a new mechanism for a boundary that the coupon-fill target makes rare. See
  watch item (a) for the manual read that replaces it.
- **Fill the coupon with GLM traffic instead** (reviewers back onto Go) — rejected in 041: the GLM
  review volume is what blew the account's shared allowance wall (61% of quota consumption), and
  the same-model OpenRouter route is dollar-neutral with the Go metered rate while un-throttling
  the account. Weight-fidelity is preserved by 041's `z-ai` pin.
- **Full-fidelity pin on MiMo (`only: ["xiaomi"]`, `allow_fallbacks: false`)** — rejected: the
  owner's own seat favours resilience over byte-fidelity, and all five endpoints are fp8/bf16 (no
  fp4), so a fallback costs a re-quantization nobody has measured a difference on, while a
  no-fallback pin turns one bad 30 minutes at Xiaomi into the owner's unavailable seat.

## Tradeoffs

- **Two billing surfaces to watch** instead of one: the Go coupon (cadence-checked) and the
  OpenRouter balance (fails loudly at spawn when it runs dry).
- **The coupon fill is checked by cadence, not enforced.** No code caps Go spend at the allotment;
  "~100%, not much more" is a target read off a tracker, and overshoot lands in Zen at 2× until the
  next read catches it.
- **The MiMo pin is a preference, not a lock.** `order: ["xiaomi"]` puts the first-party endpoint
  first and lets OpenRouter fall back when it is unavailable or filtered out; fallbacks are
  same-quantization or better (fp8 ×3, bf16 ×1) except StreamLake, whose quantization is
  unlabelled (and whose $0.522/$1.044 price and 56.6% 1 d uptime make it an unlikely pick).

## Watch items

- **(a) Coupon fill against a target band.** Read `docs/data/seat_burn.py` (WO-2026-053's tracker)
  periodically and compare the monthly Go consumption to a documented band around the allotment.
  **Cadence TBD; no automation landed** — until it is written down, this is a human-in-the-loop
  check.
- **(b) Frequent DeepSeek overflow to the `-1017` pin** is the signal that the fleet no longer fits
  the coupon. If it becomes routine, revisit whether the fleet constant (`FLEET_PROVIDER`) should
  flip at the margin — fill the coupon, then spill — or whether the plan tier changes.
- **(c) `z-ai/glm-5.3`'s OpenRouter promo price** (~$0.079 in / $0.078 cache-read, 13–18× under
  z.ai's own API rate) gets its ~2-week re-check, already noted in the economics investigation. A
  revert would not touch this record's seats — `glm-5.3-flash` is the reviewer slug — but it is the
  same balance.

## Rollback

Two independent moves, either order:

- Reviewers: `agents/review-{code,plan,tests}.md` back to `opencode-go/glm-5.3-flash:high` (041's
  rollback), restoring the pre-041 coupon burn.
- Main seat: `git revert` this commit drops the `xiaomi/mimo-v2.6-pro` override from
  `models.json`; the owner's `/model` choice is his own and is unaffected by the revert.

**Files changed:** `models.json` (the `xiaomi/mimo-v2.6-pro` routing preference), this decision.

**Verification:** `python3 -m json.tool models.json` parses; `env -u PI_SUBAGENT_ALLOWLIST -u
PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` — 823 pass / 0 fail across 43 files, zero delta from
the `28f10c2` baseline (no test reads the repo's `models.json`; the two files that name it point
`ModelRuntime` at `~/.pi/agent/models.json`). Route-level behaviour is observable only on a live
main-session turn, which the owner drives.

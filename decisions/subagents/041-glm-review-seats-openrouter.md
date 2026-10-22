---
title: "Review seats → openrouter/z-ai/glm-5.3-flash:high — off OpenCode Go extra-usage billing, same model"
type: decision
status: done
date: 2026-10-22
---

# Review seats → `openrouter/z-ai/glm-5.3-flash:high` (041)

**What (owner ruling, 2026-10-22, verbatim):** *"we've hit usage limits on opencode go so I've
switched over to extra usage billing. thinking we should switch all the seats that are currently
using GLM-5.3-Flash over to the same model, just via openrouter instead?"*

The three review seats — `review-code`, `review-plan`, `review-tests` — move from
`opencode-go/glm-5.3-flash:high` to `openrouter/z-ai/glm-5.3-flash:high`. Model and effort
suffix unchanged; only the provider prefix moves. No other seat changes: implementer, oracle,
scouts and orchestrator stay on the OpenCode Go DeepSeek seats (036/037), and the main-session
seat is untouched (038).

**Premise verified (2026-10-22):** live `GET https://openrouter.ai/api/v1/models` lists
`z-ai/glm-5.3-flash` (canonical slug `z-ai/glm-5.3-flash-20260826`, 1,048,576 ctx,
`supported_efforts: max / high / low`) — the seat's `:high` suffix is a real level on this
endpoint, not a clamp.

**Why:**
1. **The Go plan no longer bounds this seat's cost.** Usage limits were hit and the account now
   bills extra usage on OpenCode Go (owner ruling). The seat's cost driver stops being a plan
   quota and becomes a metered overage whose rate we do not control from here — against a known
   OpenRouter list price for the identical model.
2. **Same model, so nothing about the seat's quality basis changes.** 037's review-seat pick
   (65.4/62.2, ~25-pt over the 023 MiMo seat) was a model choice, not a provider choice; it
   carries over intact.
3. **Decorrelation is preserved.** Zhipu-lab reviewers against the DeepSeek implementer is the
   property 037 bought, and a provider change does not touch the lab (unlike 036, which moved
   the DeepSeek seats to a gateway that hides upstream weights).

**Pricing, dated — not current:** the last measured figures live in 020's recon (2026-08-28):
glm-5.3-flash at **$0.075 / $0.25 / $0.015 per M** prompt / completion / cached. Those numbers
are four weeks old at this ruling and are quoted only as the price band that made the seat cheap
in the first place; they are not a commitment and were not re-measured for this decision. For the
record, today's live listing (2026-10-22) shows `$0.0132 / $0.1589 / $0.0132` for the same slug —
also volatile, also not load-bearing. **The decision rests on list-price-instead-of-opaque-overage,
not on either figure.**

## Alternatives rejected

- **Keep the three seats on OpenCode Go extra-usage billing** — rejected (owner): an opaque
  metered overage on a gateway, versus a published list price for the same model from a provider
  we already hold credits with. Same model, one fewer unknown.
- **Move the whole fleet to OpenRouter** — rejected (owner scoped it): the directive is "all the
  seats that are currently using GLM-5.3-Flash". The DeepSeek seats ride the Go plan's most
  usage-generous bucket (036/037) and are not implicated by the GLM seat hitting limits.
- **Pin an OpenRouter provider endpoint for this slug** (`models.json` route guard, 022's
  shape) — rejected: 020 ran glm-5.3-flash on OpenRouter unpinned and that acceptance stands.
  There is no first-party-weight-fidelity argument here as there was for the DeepSeek `-1017`
  pin (022), and `allow_fallbacks: false` would make a single upstream hiccup a loud fleet-wide
  reviewer outage.
- **Return to a z.ai subscription** — impossible: none exists (022).
- **Swap the model while we are here** (a cheaper or stronger reviewer) — out of scope: the
  owner ruled on a provider move for the same model, and reviewer quality is a separate
  measurement (023/037).

## Tradeoffs

- **The reviewer tier now bills per token, not against a quota.** Reviewer runs are a recurring,
  substantial share of fleet traffic, so that spend now shows on the OpenRouter balance instead of
  being absorbed by the plan — the same balance that funds the manual `-1017` escape hatch
  (022/035).
- **Prompt caching is upstream-chosen.** The slug is served by multiple endpoints; 022's
  2026-10-01 probe found provider-automatic prefix caching works broadly across OpenRouter
  endpoints, but the cache-read share of a reviewer bill is not ours to set without a pin, which
  this decision declines to add.
- **Two providers in one review round.** Reviewers on OpenRouter and implementers on Go means a
  provider-wide outage breaks only half the round, but a review with two independent gates is
  also exposed to two independent failure modes. No mitigation beyond the loud-failure stance.

## Watch items

- **OpenRouter balance.** If credit runs down, reviewers fail loudly at spawn. The fallback is
  topping up, or flipping these three lines back to `opencode-go/glm-5.3-flash:high` — the model is
  still listed on the Go menu (037).
- **Verdict quality is unchanged in expectation, not in observation.** The model is the same, so
  037's hallucination-rate watch item (unmeasured, mitigated by the prove-each-finding and
  citation-validation rules in the reviewer prompts) carries over untouched; the observable stays
  verdict quality on the next gated tasks, now recording `openrouter/z-ai/glm-5.3-flash:*` spawns.
- **Pricing drift.** Both price figures quoted above are dated snapshots (2026-08-28 recon,
  2026-10-22 listing) and they disagree; neither is a commitment. Re-read the live listing before
  any cost argument that depends on this seat.

## Rollback

One commit, three frontmatter lines: `opencode-go/glm-5.3-flash:high` restores the previous
provider. No state file, no toggle, no `models.json` change.

**Files changed:** `agents/review-{code,plan,tests}.md` (model lines), `README.md` (agent
roster), `docs/model-role-scores.md` (assignment-table row), `decisions/subagents/README.md`
(index), supersession addenda on 022 and 037, this decision.

**Verification:** `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` —
823 pass / 0 fail across 43 files at this landing (214 s). No test pins a reviewer model string, so
the suite is a regression check on the config, not an E2E of the new route; the first gated task
records `openrouter/z-ai/glm-5.3-flash:*` spawns in its reviewers' `meta.json`.

**Numbering note:** the dispatch cited this record as `038`, which is landed history
(`038-main-session-glm-flash-split.md`). Per `rules/work-order-numbering.md` clause 3 a landed
number keeps its id, so the losing claim renumbers to the next free id — 041.

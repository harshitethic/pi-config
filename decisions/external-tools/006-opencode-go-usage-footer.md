---
title: "OpenCode Go usage in the footer — the /zen/go/v1/usage aggregate endpoint"
type: decision
status: done
date: 2026-10-18
---

# OpenCode Go plan usage in the footer (external-tools/006)

**What:** the footer's provider-quota slot (already serving z.ai and MiniMax in
`extensions/footer-session-id.ts`) now renders OpenCode Go plan usage when the
model provider is `opencode-go`, per the owner's display spec:

- rolling: percent + time left (`5h:1% 4.6h`)
- weekly: percent + %-through-week + days till reset (`7d:17% thru86% 1.0d`)
- monthly: percent + %-through-month + days till reset (`mo:8% thru6% 29.3d`)

**API surface:** `GET https://opencode.ai/zen/go/v1/usage`, `Authorization:
Bearer <oc_sk_ key>` (the same key as inference). It is the only usage GET the
public proxy maps (opencode issues #31084, #43983): three plan-wide windows with
integer `percent` + `resetsAt`, no per-model breakdown, no dollars, no tokens,
no plan name. `?group=model` is ignored. Per-model usage rows exist server-side
(`billing.sql.ts`: model, tokens, cost, keyID, sessionID) but are console-only.
Third-party dashboards all scan local client stores for that reason.

**Window-start estimate:** the payload has `resetsAt` but no window start.
Weekly = `resetsAt − 7d` (exact); monthly = `resetsAt` minus one calendar month
(the billing anniversary keeps a stable wall-clock anchor, e.g. 21:19:11).
Through-percent is clamped to 0..100; pure helpers are unit-tested against the
live account's window shape.

**Why a branch in `footer-session-id.ts` and not a new extension:** that file is
the footer owner (`ctx.ui.setFooter` — one footer per pi instance, second
install would clobber the first), and the fetch/poll/key-resolution/width-ladder
machinery is there. Extending it is the shared path; a standalone extension
would parallel the quota mechanism. The z.ai/MiniMax percent-color thresholds
were duplicated twice inline and are now one helper (`colorUsedPct`) used by all
three providers.

**Cost context (model-tiers/004):** monthly-cap-only cost evaluation needs
per-model burn; this endpoint cannot provide it. The footer shows account-level
pace (the honest cross-check); the per-model projection tool (pi session logs ×
models-store prices) remains a separate, unbuilt follow-up and is what the role-
variant trigger ("DS bucket >50% mid-month") should be measured with.

**Files changed:** `extensions/footer-session-id.ts` (Go section + refresh
branch + `colorUsedPct` extraction), `tests/footer-opencode-usage.test.ts` (24
tests), `README.md`, `docs/investigations/structure-trend.md`, decisions index,
this decision. Live probe of the endpoint on the owner's account recorded in the
session (2026-10-18: rolling 1%, weekly 17%, monthly 8%, resets Nov 16).

**Rollback:** `git revert`; the Go section is self-contained and provider-gated.

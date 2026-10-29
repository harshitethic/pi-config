---
title: "Reviewer approval bar and structural checks — mitigation defined, parallel mechanisms, decision placement"
type: decision
status: active
date: 2026-10-16
---

# Reviewer approval bar and structural checks

**Ruling (owner, 2026-10-16).** `review-code` and `review-tests` carry an *Approval bar*:
APPROVED_WITH_NOTES only when every note is LOW or MEDIUM with a named mitigation, where
mitigation is an artifact in the tree (test, pinned `| nyi` row, guard) or an acceptance quoted
from the work order or an owner ruling. An unauthorized deviation from the work order is at
least MEDIUM; a finding needing a ruling is REJECT_AND_REWORK; an unverifiable load-bearing
claim blocks approval; re-baselining a test to accept a known regression is HIGH.
`review-code` gains Pass 3 items 8 (**parallel mechanisms** — grep for the existing
implementation; MEDIUM, HIGH when the copies diverge) and 9 (**decision placement** — a later
stage re-deriving an earlier stage's decision, per the project's docs; MEDIUM), and structural
findings follow the same bar. `review-tests` flags **duplicate coverage** (LOW unless the new
test pins a distinct regression).

**Why.** The severity table already said "MEDIUM with no mitigation → REJECT", but never defined
mitigation, and reviewers approved through that gap. Evidence from the 2026-10-08 retrospective
audit (`tfd/docs/investigations/retrospective-audit-2026-10-08.md`) and the review sessions:

- WO-2026-154: review-tests rated the unauthorized acyclic-merge deviation "MEDIUM (escalation,
  not a test defect)" and approved; review-code took a regression re-verification "as reported"
  because it could not check it (the old rule: "Unverifiable → flag as risk"). The work order
  allowed one residual gate and five remained; an 8→9 allocation re-baseline recorded a known
  regression as intended output.
- WO-2026-143: both seats approved a bare "no sibling defect" negative claim with no enumeration.
- Audit C1–C6: six parallel copies of existing mechanisms (three traversals of one position
  set, codegen re-deriving an annotator merge, a layout predicate re-inlined at four sites)
  passed review. The old behaviour rule "flag hand-rolled reimplementations" had no severity
  and no search step; it is replaced by item 8 rather than kept alongside it.

**Rejected:** a model-only fix (swap the reviewer and keep the prompts). The WO-154 miss was the
reviewer *flagging* the deviation and approving anyway — a gate-calibration failure that any
model can reproduce under the old wording. The model question stays with decision 023.

**Generic wording.** Agent prompts are shared across repos, so decision placement points at "the
project's docs" rather than naming TFD's shift-left rule.

**Time-box.** The 25-tool-call time-box stays, but converging now means reporting unchecked
claims as blocking, not dropping them — otherwise the time-box re-opens the verification gap.

**Pruned in the same pass:** the duplicated re-review guidance in each output template (it
points at the *Re-review decision* section), the "Citation rot" failure mode in `review-code`
(behaviour rules 3–4 cover it), and `review-tests`' duplicate rule number 7.

**Not changed:** `review-plan` (its failure modes differ; no evidence in this window).

**Interaction with 023.** Verdicts after this change are not comparable with the 2026-10-01..16
MiMo window. The 023 control run (WO-153/154 replays) used a pre-033 snapshot of the prompts.

**Files changed:** `agents/review-code.md`, `agents/review-tests.md`, decisions index, this
decision, 023 (interaction note).

**Test coverage:** none — agent prompt text. `discover-agents-cache`, `rules-frontmatter` and
`subagent-review-status` suites pass (no test pins the edited text).

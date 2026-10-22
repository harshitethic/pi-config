---
title: "Refactor first: every work order makes the change easy before making it"
type: decision
status: done
date: 2026-10-21
---

# Refactor first (040)

**What (owner ruling, 2026-10-21):** "make the change easy, then make the easy change" is the
development plan for every work order, and work lands right the first time:

1. **Every work order has a Preparatory refactor section.** It is either a behaviour-preserving
   refactor behind characterization tests that lets the area take the change without a second
   path, or `none` with a one-line reason. One implementer does both and asks for one standard
   review (no separate review pass for the refactor), preferably as two commits: the refactor,
   with existing tests unchanged, then the change.
2. **No landing adds a parallel path.** That rules out a second implementation of an existing
   mechanism, a copied block, and one more branch on a structure already known to be
   duplicated. Debt recorded for a later order is not mitigation unless that order lands first.
3. **Any role may refuse, and must, with `REFACTOR FIRST`** when the work would build on an area
   that strongly needs a refactor. The refusal gives the evidence (sites and sizes) and a
   proposed preparatory refactor, and it counts as a successful outcome.
   - Orchestrators and implementers refuse to *start*.
   - Reviewers still review in full but refuse to *accept*: the finding is HIGH, so the verdict
     is `REJECT_AND_REWORK`.
4. **Reviewer severity.** A new parallel mechanism, or growth in an area on the register, is
   HIGH.
5. **Refactor-needed register, two strikes.** Each repo keeps a register in its
   structure-trend doc. An area flagged by two landings, or named in one `REFACTOR FIRST`
   refusal, is **closed** to feature work until its refactor lands.

**Override:** owner only. No orchestrator, reviewer or dispatcher can accept work past a
`REFACTOR FIRST` or into a closed area.

**Scope:** all repos. The changes are in APPEND_SYSTEM.md (Landing work), the `orchestrator`,
`implement`, `review-code` and `review-plan` agents, and the `work-order-template` skill.

**Queue (tfd):** WOs 281–293 get preparatory-refactor sections. A match/union refactor chunk
lands before WO-284 and WO-293, and before any new match/union work.

**Why:** in tfd's post-sweep audit (2026-10-21), every landing reviewed added to the duplication
the sweep was opened to remove:

- WO-211 kept three annotator arm loops and re-derived the match kind in codegen.
- WO-227 copied `wrap_retag_arm` as `lower_union_inject`.
- WO-222 added name-keyed predicate lookups.
- WO-274 added 1,682 lines of test-only probe.

Each report and review *acknowledged* the debt, and the work landed anyway. The guidance made
that the expected outcome:

- review-code item 5 flagged a refactor only when it would shrink the diff about 2×.
- Item 7 made growth LOW and the refactor suggestion optional.
- Item 8 made a parallel mechanism MEDIUM, which the orchestrator could accept.
- implement and orchestrator said "do not refactor outside scope; flag it".
- The chunk-boundary audit folded candidates into "the next chunk", and nothing enforced it.

**Alternatives considered:**

- *Keep warn-and-proceed with stronger wording.* Rejected: the warnings were already being
  written, and the work still landed.
- *A size threshold that closes a file.* Rejected: tfd's large files are already over any
  threshold, and growth stays delta-based. An area closes on evidence (strikes), not size.
  **Amended 2026-10-23 (owner, tfd `docs/reviews/refactor-priority-2026-10.md#RP9`):**
  growth below a repo's small-file floor does not count (tfd: lines up to 1,000). This adds an
  exemption floor; no size closes a file, so the rejection stands.
- *Orchestrator or reviewer override.* Rejected: an override is how acknowledged debt landed.

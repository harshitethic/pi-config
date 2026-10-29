---
title: "Structural growth checks — reviewers report, chunk boundaries audit"
type: decision
status: done
date: 2026-10-05
---

# Structural growth checks

**What:** Two additions that together give codebase growth an owner:

1. **Always-on, in the review seats.** `review-code` Pass 3 gains item 7 *Growth*: if the
   diff materially grows an already-large file (repo top decile) or adds a branch/flag/
   parameter to a long function (>~300 lines), the reviewer **reports** it — file or
   function, current size, delta — regardless of whether a refactor would clearly shrink
   the change. `review-plan` gains the matching pre-implementation bullet, including
   whether the addition can route somewhere better. Both carry a `Growth:` line in their
   report output so the observation is visible rather than optional.
2. **Occasional, at chunk boundaries.** Each chunk landing runs a `scout-code` structural
   audit over the delta since the last one, appended to the repo's
   `docs/investigations/structure-trend.md`: top files and longest functions with their
   deltas, duplication and dead code inside the delta, and candidate extraction work items
   ranked by lines-removed × risk. The orchestrator folds the top candidates into the next
   chunk's sequence **before feature work**, so cleanup competes with features for slots.
   Convention recorded in `AGENTS.md` (tfd).

**Why.** Every existing structural check was diff-local and gated on "would this refactor
clearly shrink *this change*" (2× fewer lines / removes duplicated special cases), while
`implement.md` and `orchestrator.md` both forbid refactoring outside the item's scope. The
two rules are individually right, but together they leave accumulation unowned: a series
of locally-reasonable work orders grows the fat files with no diff tripping a check. The
trigger was a phase-A landing (+1,325/−518 across 25 files, ~700 lines into two top-6
files) in a codebase already at 116,891 lines with 43 functions over 300 lines and a
4,910-line worst function. A threshold-gated refactor suggestion can never fire there;
a mandatory *observation* can, and the audit turns observations into scheduled work.

**Alternatives rejected.**
- *Absolute thresholds* ("files must be under N lines"): meaningless in a codebase this
  size — it would fire on everything and be ignored. Growth must be delta-based.
- *A permanent `review-arch` seat*: every WO paying an architecture review to catch an
  occasional problem. `scout-code` at chunk boundaries is the right cadence and needs no
  new tier.
- *Letting reviewers demand refactors*: recreates the scope violation the implementer
  rules forbid. The reviewer observes; the orchestrator schedules.

**Reopening triggers.** Growth observations become noise (most diffs flag) → raise the
size/decile bars. Audits get skipped for feature pressure → make the boundary check part
of the plan's sequence template. A file's growth attributable to one WO with no
observation in its review → the review-seat bullet is not being applied; fix the prompt
before adding more machinery.

> **Relocated (2026-10-06):** the chunk-boundary audit convention moved from tfd's
> `AGENTS.md` to the global `APPEND_SYSTEM.md` — *Structural audits at chunk
> boundaries*. It is repo-independent process, so it belongs in the shared prompt;
> `docs/investigations/structure-trend.md` stays the per-repo artifact.

> **Superseded in part (2026-10-21):** growth is no longer an optional observation, and the
> chunk-boundary audit no longer just folds candidates into the next chunk. Growth and parallel
> mechanisms are strikes on a refactor-needed register, two strikes close an area, and
> `REFACTOR FIRST` refusals apply. The snapshot convention stands. See
> [040-refactor-first](040-refactor-first.md).

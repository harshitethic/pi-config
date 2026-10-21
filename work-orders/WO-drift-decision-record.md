# WO-drift-decision-record — drift decision record for `9925257` + doc-drift cleanup

**Status: DRAFT — DISPATCH-BLOCKED on the owner's restore-vs-record ruling (sanity-check §7 Q4) for the disposition column only. The record and the doc-drift cleanup are ruling-independent and land either way.**

### Metadata

- **work_order_id**: assigned at dispatch (slug: drift-decision-record; `rules/work-order-numbering.md` — drafts are slug-only)
- **parent_plan_id**: checkpoint sanity-check (`docs/investigations/checkpoint-sanity-check-2026-10.md` §6 item 3)
- **sequence_position**: 2 of 3 remaining (§6 items 2, 3, 5)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: trivial
- **review_policy**: skip — documentation-only (decision record + README/agent-doc drift); no code changes

### Task Summary

**One-sentence description**: Record the stash-recovery commit `9925257`'s feature removals as a decision record with per-item dispositions, and fix the doc drift that describes behavior which does not exist.

**Goal**: `decisions/checkpoint/` gains the record; README and agent docs stop describing removed/non-existent APIs; each removed feature is marked `[RECORDED INTENTIONAL]` or `[RESTORE PENDING → follow-up WO]` per the ruling.

### Premise

`9925257` (2026-07-10, stash recovery) removed `doCheckpoint`, `checkpoint-continue`/`-stop`, `isAbnormalStop`, and the context strip that existed in `4611f42`, with no decision record (sanity-check §5.8). Probe: `git show 4611f42` exhibits them and `git show 9925257` removes them. If either fails, stop — report `PREMISE FALSIFIED`.

### Preparatory refactor

**none** — documentation-only order.

### Ruling input (fill at dispatch)

Per-item disposition table from §7 Q4: for each of `doCheckpoint`, `checkpoint-continue`/`-stop`, `isAbnormalStop`, context strip — `[RECORDED INTENTIONAL]` or `[RESTORE PENDING]`. If any is RESTORE, allocate its follow-up order at dispatch (restoring is real code work and is **not** part of this docs order).

### Scope

**Invariants**: no code or test changes; every record claim cites evidence (commits/docs); the record must not claim any restore happened; a superseded claim keeps its original text with a dated note, not a rewrite.

**Files expected to change**:
- `decisions/checkpoint/NNN-*.md` (next number in that dir; follow its existing format) — the drift record: what `9925257` was, what it removed (before-evidence from `4611f42`), the drift path (no record at the time; surfaced 2026-10-21 by sanity-check §5.8), the disposition table (ruling), and forward links to any restore orders.
- `README.md` — §5.8 drift: the documented `checkpoint(summary, nextSteps?, continue?, newCwd?)` signature and the "fork entry recorded on the old session" claim don't exist (there are two tools; `/go` stages a fork and appends nothing to the old session). Fix to describe what exists.
- `agents/orchestrator.md`, `agents/implement.md` — stale `checkpoint_search` references (tool removed in `dd89c68`).

**Files NOT to modify**: all code and tests; `settings.json` and `decisions/settings/**` (another session's uncommitted WIP); `work-orders/WO-2026-031.md` (frozen history — its stale reference stays).

**Out of scope**: restoring any removed feature (follow-up orders per the ruling); removing the dead `StrippedAssistant` type (`extensions/checkpoint.ts` — code; park it as a named follow-up inside the record).

### Implementation Specification

1. Write the record per `decisions/checkpoint/`'s existing format. Every claim carries its evidence (`git show`-able IDs, doc section cites). The disposition table is exactly the ruling's; undecided items are marked `[RESTORE PENDING]` with the follow-up WO id, never silently dropped.
2. Fix `README.md` to describe the current tool surface (two tools, no `nextSteps?`/`continue?`/`newCwd?` signature, `/go` behavior as it is).
3. Drop `checkpoint_search` mentions from `agents/orchestrator.md` and `agents/implement.md`.

**Required test boundary**: none (docs). Verification: the cited commits resolve, and `rg 'checkpoint_search|nextSteps' README.md agents/` returns nothing. If any *test* pins the drift (asserts the non-existent API or the README text), flag it in the report — do not change tests in this order.

### Invariants

**Cross-file conventions**: decision-record format per `decisions/checkpoint/` (read the dir first). Dates on every disposition.

### Verification Criteria

**Tests that must pass**: full suite green unchanged (`env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test`) — docs-only, so the suite must be byte-identical in outcome to the base.

**Build requirements**: none (no build step exists).

### Structural Risks

- [ ] **No unrequested changes**: only the three doc surfaces above.
- [ ] **Build config untouched**.
- [ ] **No unsolicited features**: no code, including "trivial" dead-type removal.
- [ ] **No parallel path**: n/a (docs).

### Context

**Prior work orders completed in this plan**: WO-2026-055/056/057 (checkpoint hardening), WO-2026-058/059 (test infra).

**Upcoming work orders**: WO-summary-ownership-dispatch (summary ownership — same window, independent files), WO-pi-upgrade-1.3.0 (pi upgrade; after the ownership order).

**Relevant decisions from the planning doc**: sanity-check §5.8 (the drift inventory this record memorializes); the repo rule that a decision file is historical record and supersessions are noted in place.

### Completion Report Format

Standard schema; `review_policy: skip` so no adversarial review rounds are expected — include `deviations_from_spec` and `notes_for_orchestrator` regardless.

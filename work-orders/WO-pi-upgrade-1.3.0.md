# WO-pi-upgrade-1.3.0 — pi upgrade 0.83.0 → 1.3.0 + `compaction-model.ts` 1.3.0 fixes

**Status: DRAFT — DISPATCH-BLOCKED on (a) the owner's upgrade-timing ruling (sanity-check §7 Q2: GO-now vs batch-later) and (b) WO-summary-ownership-dispatch having LANDED. The sequencing is the trap: upgrading arms the dormant fleet-summary override before the ownership rule arbitrates it (pi-upgrade §7).**

### Metadata

- **work_order_id**: assigned at dispatch (slug: pi-upgrade-1.3.0; `rules/work-order-numbering.md` — drafts are slug-only)
- **parent_plan_id**: checkpoint sanity-check §6 item 5 (evaluation: `docs/investigations/pi-upgrade-2026-10.md`)
- **sequence_position**: 3 of 3 remaining (§6 items 2, 3, 5)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Upgrade pi to 1.3.0 and fix the one extension the upgrade breaks (`compaction-model.ts`'s header/routing surface), then execute the smoke matrix in order.

**Goal**: pi 1.3.0 running with all extensions loading clean; `compaction-model.ts` type-correct against 1.3.0 and passing an explicit session id to `compact()`; the smoke matrix run and reported row by row; WO-summary-ownership-dispatch's ownership rows still green.

### Premise

At dispatch, npm `dist-tags.latest` for `@earendil-works/pi-coding-agent` is still 1.3.0 (recheck; if it moved, stop and report — the evaluation targets 1.3.0 specifically), and the 1.3.0 type surface for the in-scope files is as recorded in pi-upgrade §4: `compaction-model.ts` is the only breakage (`headers` is now `ProviderHeaders` `string | null`; `baseUrl`/`env` dropped from the auth object). Probe: fetch the 1.3.0 `model-registry.d.ts`/`types.d.ts` (pi-upgrade Sources) and confirm both claims before editing. If the impact assessment is wrong (more files break), report — do not patch the extra breakage silently.

### Preparatory refactor

**none** — one file's type surface, nothing duplicated to fold (WO-summary-ownership-dispatch already separated ownership from routing; this order only touches routing/types).

### Rejected alternatives

(to be filled at dispatch: upgrading before WO-summary-ownership-dispatch — rejected by the sequencing ruling, pi-upgrade §7, cite §7 Q2's date)

### Scope

**Invariants** (the blast radius):
- **No session migration.** Rollback = reinstall 0.83.0 (pi-upgrade §6.6). If anything needs a migration step, stop and report.
- **Only `extensions/compaction-model.ts` changes in extension code**: the evaluation found one type mismatch and one routing fix. Any other breakage = report, not a silent patch (it falsifies §4's impact assessment).
- **The summary-ownership order's behavior is preserved** (`WO-summary-ownership-dispatch`): its dispatch rows must still pass after the upgrade. Fleet may now *succeed* (the `MissingSessionID` gap closes upstream in 0.86.0) — both outcomes must remain loud per that order's R4/R5.
- Compaction boundary semantics (`firstKeptEntryId`/`tokensBefore`) unchanged.

**Files expected to change**:
- `extensions/compaction-model.ts` — filter `null` headers (or reuse pi's `withoutDeletedHeaders` semantics), forward `auth.env`, and pass `ctx.sessionManager.getSessionId()` as `compact(..., sessionId)` so fleet compaction routing is explicit rather than accidental.

**Files to read (reference only, do not modify)**:
- `docs/investigations/pi-upgrade-2026-10.md` — §4 (impact), §6 (sequence + smoke matrix), Sources (1.3.0 `.d.ts` URLs).
- `extensions/checkpoint.ts` — the invariants this upgrade must not disturb.

**Files NOT to modify**: `settings.json`, `extensions/auto-checkpoint.ts`, `tests/auto-checkpoint.test.ts`, `decisions/settings/**` (another session's uncommitted WIP); `extensions/checkpoint.ts` (evaluated unbroken); build config (none exists — extensions are jiti-stripped; `tsc --noEmit` is NOT available, which is why the type fix is a review obligation checked against the installed 1.3.0 `.d.ts` by inspection).

**Out of scope**: ownership behavior changes (the ownership order landed them — preserve); the `MissingSessionID` root cause in pi's own `model-registry` (upstream, fixed 0.86.0+); any migration tooling.

### Implementation Specification

1. Install pi 1.3.0 (`npm i -g @earendil-works/pi-coding-agent@1.3.0` or the managed installer). Machine-level action, permitted under the ruling's GO; state the install target in the report. If the environment forbids global installs, stop and report.
2. Apply the three `compaction-model.ts` fixes (header filtering, `auth.env` forwarding, explicit `sessionId`).
3. Smoke matrix, **in this order** (pi-upgrade §6.5), reported row by row:
   1. start a session, `/reload` — all extensions load without errors;
   2. one `read`, then a `checkpoint` tool call — injection present + token delta in the notify (`estimatedTokensAfter` non-null);
   3. `/checkpoints`;
   4. `/compact` — verbatim summary survives per the ownership order's ruling; fleet path exercised or refused loudly;
   5. let a session cross the threshold — auto-compaction archives, does not touch the summary (per the ownership order's column);
   6. `/go` fork;
   7. one subagent spawn + one peer-link message.
   Steps requiring the live TUI may be delegated back to the orchestrator/owner — list what you could not run and why.
4. Re-run WO-summary-ownership-dispatch's ownership rows and the full suite.

**Required test boundary**: full suite green post-upgrade (`env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` — the tests spawn pi children against the installed pi), plus the smoke matrix as documented evidence.

### Invariants

**Error handling conventions**: fleet failures still surface loudly (the ownership order's R4/R5) — the routing fix may change *whether* fleet fails, never *whether* a failure is visible.

**Ordering assumptions**: this order runs after WO-summary-ownership-dispatch is merged to `main` (premise-checked at dispatch; if 060 is absent, stop — `PREMISE FALSIFIED` by sequencing).

### Verification Criteria

**Entry points that must work**: all extensions load post-upgrade; `checkpoint` tool call produces the notify token delta; `/compact` behavior per the ownership order's matrix.

**Tests that must pass**: WO-summary-ownership-dispatch's rows unchanged and green; full suite green.

**Test surface requirements**: smoke-matrix evidence is a row-by-row report (command, observed, pass/fail) — not prose.

**Build requirements**: no build config is touched (none exists).

### Structural Risks

- [ ] **Route/path correctness**: session id comes from `ctx.sessionManager.getSessionId()`, not a re-derived id.
- [ ] **Input validation scope**: `null` headers filtered before use (or `withoutDeletedHeaders` semantics).
- [ ] **Test surface**: the ownership order's rows rerun; smoke matrix documented row by row.
- [ ] **Recovery logic**: n/a.
- [ ] **No unrequested changes**: only `extensions/compaction-model.ts`.
- [ ] **Build config untouched**.
- [ ] **No unsolicited features**: no new routing behavior beyond explicit `sessionId`.
- [ ] **No parallel path**: extend the existing fleet call; do not add a second request builder.

### Context

**Prior work orders completed in this plan**: WO-2026-055/056/057 (checkpoint hardening), WO-2026-058/059 (test infra), WO-summary-ownership-dispatch (summary ownership — prerequisite).

**Upcoming work orders**: none in this plan. Register's remaining item (fold `auto-checkpoint.ts` onto `read-tracking.ts`) is blocked on the owner's §7 Q3 ruling.

**Relevant decisions from the planning doc**: pi-upgrade §7 GO verdict with its sequencing reason (upgrading first arms the fleet override); sanity-check §6.2 update (the fleet path's dormant failure is not an ownership rule).

### Completion Report Format

Standard schema (all `review_policy: required` extras), with the smoke matrix as a table in `tests` or `notes_for_orchestrator`.

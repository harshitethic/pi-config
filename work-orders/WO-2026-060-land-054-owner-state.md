# WO-2026-060 — Land WO-2026-054 (owner-state + checkpoint recoverability) onto current main

### Metadata

- **work_order_id**: WO-2026-060
- **parent_plan_id**: process-controls R3/R4/R6 (tfd rulings 2026-10-19; mechanism record = this landing's decision file)
- **sequence_position**: 1 of 1 (integration pass; R8 is queued behind this landing)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Merge the completed-but-never-merged WO-2026-054 implementation (commit `f8bbbe6`, branch `pi-subagent-8e559b224caa`) into current main, resolving the named conflicts and one review fix, with all suites green.

**Goal**: main carries the five R3/R4/R6 mechanisms with main's newer mechanisms intact, the decision record renumbered to `043`, and the review's one MEDIUM finding fixed.

### Premise

The review of 2026-10-22 (review-code session `subagent-18cd30e5…`, verdict LAND) verified on a scratch merge that (a) all five mechanisms exist in `f8bbbe6` and (b) main has **not** independently implemented any of them — main's `subagent-async/index.ts` and `tests/subagent-async-kill.test.ts` merely *anticipate* the `owner_asks` gate in comments. Probe before starting: `rg -n 'validateOwnerAsks|readSubagentState|validateNextStepsOwnerState|reapFinishedWorktrees' extensions/ tests/` on the merge base — expect only the branch's own files to provide them. If the mechanisms already exist on main in another form, or the branch is gone: stop, report `PREMISE FALSIFIED` with evidence; nothing lands.

### Preparatory refactor

`none` — this task is the landing of an already-reviewed implementation whose extraction (`extensions/lib/subagent-state.ts`, `extensions/lib/owner-row.ts`) it already contains; the review confirmed `subagent-async/index.ts` shrank relative to its additions.

### Rejected alternatives

Abandon the branch — rejected: the mechanisms are the owner's tfd R3/R4/R6 rulings (2026-10-19) and the 2026-10-22 review verdict is LAND (nothing redundant; R8 is specified to build on this branch's validator).

### Scope

**Invariants:**
- The five mechanisms behave exactly as reviewed: R3-1 in-flight registry section (checkpoint + checkpoint_fork, one source three consumers), R3-2 worktree lock/unlock lifecycle (the `fs.rmSync` fallback stays **deleted**; failure paths re-lock), R3-2 orphan reap on resume (two adoption gates; dirty trees kept + `worktreeKept`), R3-3 four-state vocabulary (`running/complete/orphaned/dead` evidence naming), R4 `owner_asks` delivery-funnel gate (refused reports never delivered, gate before `stdin.end()`), R6 `nextSteps` owner-state bar (same-paragraph rule, registry existence).
- Main's newer mechanisms survive unchanged: `FLEET_MODEL_SPEC` fallback arms (`extensions/lib/fleet-model.ts` consumers, decision 022/041/042 lane), WO-2026-057's `renderSummary`/`SummaryFields` + `extensions/lib/checkpoint-meta.ts`/`read-tracking.ts` extractions, `killedVia: "turn-limit"` union, the `tests/peer-link-external.test.ts` 120s ceilings (landed `c86fd15`).
- Existing test **assertions** pass unchanged everywhere except `tests/checkpoint-recoverability.test.ts`'s fixture (see steps). A mirror `.cjs` edit is allowed only as a KEEP-IN-SYNC follow of the real suite; real suites are authoritative. Any assertion whose *intent* must change = behavior change → stop and flag.
- `validateOwnerAsks`'s exported surface stays stable — R8 (queued) builds on it (row-id form + registry existence).

**Files expected to change** (guidance):
- `extensions/checkpoint.ts` — two `composeSummary` call sites re-pointed onto `renderSummary(fields, next)` output
- `extensions/subagent-async/index.ts` — conflict resolution only: keep **both** import sets (main's `FLEET_MODEL_SPEC`, branch's new libs)
- `decisions/subagents/039-owner-state-*.md` → `043-owner-state-*.md` — renumber + internal self-references; `decisions/subagents/README.md` row in order
- `extensions/lib/owner-row.ts` — finding-1 fix (loud degradation, below)
- `tests/checkpoint-recoverability.test.ts` — fixture rewrite only
- plus the branch's own files as merged (`extensions/lib/subagent-state.ts`, `tests/subagent-*.test.ts`, `extensions/subagent-async/test-*.cjs`)

**Files to read (reference only):** `docs/TODO.md` (the 054 row states the branch/decision-number history — do not edit), `decisions/subagents/040-refactor-first.md`, the commit `f4f7d50` decision text (fail-hard: a correct-output default on a can't-happen state is a banned fallback).

**Files NOT to modify:** `docs/TODO.md` and `docs/investigations/*` (orchestrator reconciles after landing); `work-orders/WO-2026-054-*.md` (frozen record); `settings.json`, `extensions/auto-checkpoint.ts`, `tests/auto-checkpoint.test.ts`, `decisions/settings/*` (another session's WIP); `extensions/lib/fleet-model.ts`; `tests/peer-link-external.test.ts`.

**Out of scope:** R8's registry-tool gate; any change to `extensions/owner-asks/*`; performance follow-ups (the peer-link spawn fixture note).

### Implementation Specification

**Steps:**
1. Merge `pi-subagent-8e559b224caa` (contains `f8bbbe6`) into your branch base (current main). Conflicts expected in exactly: `extensions/checkpoint.ts` (2 blocks), `extensions/subagent-async/index.ts` (1 import block), `decisions/subagents/README.md` + the branch's decision record (numbering). The review's scratch merge (`/tmp/wo054-merge`, may not exist) resolved these in ~10 lines of checkpoint.ts.
2. `extensions/checkpoint.ts`: re-point `composeSummary(renderSummary(summaryFields, next), section)` at both tool bodies; keep main's extracted-lib structure — do not re-inline `checkpoint-meta.ts`/`read-tracking.ts`.
3. `extensions/subagent-async/index.ts`: keep both import sets; the branch must not resurrect the bare `FLEET_MODEL` fallback.
4. Renumber the branch's `decisions/subagents/039-owner-state-*.md` → `043-owner-state-*.md` (039 was consumed by `039-gate-suite-single-run`, 2026-10-20; landed history keeps its ids). Update its frontmatter/heading/internal references and add its README row after 042. Add one line to the record noting the renumbering and why.
5. Finding-1 fix (review MEDIUM; f4f7d50): in `extensions/lib/owner-row.ts`'s `validateNextStepsOwnerState` registry-existence check, the case "registry script exists but exits non-zero or times out" must **degrade loudly** — a named warning visible in the tool result (and debugLog) stating the script and its failure — instead of silently `return { ok: true }`. Keep the outcome non-blocking (the state is legitimate; decision 043 discloses it). Update the record's enumeration text to match. The "script absent" fallback stays as the branch had it.
6. Rewrite `tests/checkpoint-recoverability.test.ts`'s fixture to main's contract: fake ctx gains `getContextUsage()`, `summary:` literals become `SummaryFields` objects as `renderSummary` consumes them. The 12 failing rows fail for fixture shape only — assertion intent unchanged.
7. Preferred commit shape: (1) merge/integration resolution, (2) the finding-1 loud fix + record text. Report the suite numbers at each.

**Required test boundary:** the real tool handlers (`checkpoint`, `checkpoint_fork`, `subagent`, `subagent_status`) — the branch's four bun suites already drive them (real git, real temp repos, real lock lifecycle including "git refuses force-remove of a locked tree"). Acceptance evidence = those suites green on the merged tree **plus** main's suites unchanged.

**Behavior and failure matrix:**
- R3-1: 0/1/3-children registry rows; empty registry → section omitted; fork row; round-trip.
- R3-2: spawn→lock→force-remove-refused→complete→unlock→remove; unlock-fails → re-lock (never `rmSync`); reap: clean → remove, dirty → kept + `worktreeKept` + resume offer; live-foreign-owner / legacy-meta / still-tracked rows.
- R3-3: each state names its evidence; unknown-session description leads with classification + resume call.
- R4: missing / empty / `none`+ids mixed / free-text refused, each naming the rule; refused report never delivered; recovered-session path per decision 043's enumeration.
- R6: cross-paragraph refusal; backtick/emphasis wrapping; malformed-id naming; existence rows; **new row**: registry script present but non-zero exit → loud warning + ok; script timeout → loud warning + ok; script absent → branch's documented fallback.
- Merge-integrity rows: `renderSummary` output shape reaches `composeSummary` in both tools; `FLEET_MODEL_SPEC` arms still emit `opencode-go/deepseek-v4.1-flash` (see `tests/subagent-model-inheritance.test.ts` pins).

**Integration contract:** `subagent-async/index.ts` calls `validateOwnerAsks` (msg_end gate) and `validateNextStepsOwnerState` (both tools, before archiving); `checkpoint.ts` composes summaries from `renderSummary` output; `lib/subagent-state.ts` is the only state reader (`readSubagentState`).

**Reference patterns:** the branch's own `tests/subagent-worktree-lock.test.ts:157-200` (real-code lock lifecycle) is the model for boundary tests; mirror-sync style in `extensions/subagent-async/test-*.cjs` (KEEP-IN-SYNC comment convention).

### Invariants

**Cross-file conventions:** mirrors (`test-*.cjs`) follow their real suites on any change; the decision index `decisions/subagents/README.md` is updated with the record; `worktreeKept: {reason, at}` shape stays as written (read by `describeUnknownSession`).

**Default values to preserve:** `carryUncommitted` default true; worktree lock is best-effort at creation but loud in debugLog; "registry script absent" fallback in R6 is form-only checking (as documented).

**Ordering assumptions:** the owner-asks gate runs before `stdin.end()`/`isDone`; `validateNextStepsOwnerState` runs before archiving; reap runs in `session_start` after the 027 adoption scan.

**Error handling conventions:** fail-hard per `f4f7d50` — no correct-output default on a can't-happen state; the one sanctioned degradation (R6 script error, a can-happen state) must be loud; all failure paths in the lock lifecycle re-lock.

**Worktree environment:** the worktree ships no `node_modules` (gitignored) — symlink the parent checkout's `node_modules` (and `extensions/node_modules` if present) before running suites; do not commit them.

### Verification Criteria

**Entry points that must work:** `checkpoint`, `checkpoint_fork`, `subagent`, `subagent_status` tool handlers end to end; worktree create/lock/unlock/remove lifecycle on real git.

**Tests that must pass:** `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` → all green (baseline at `c86fd15`: **823 pass / 0 fail / 43 files**, measured 2026-10-22; expect +the branch's four suites ≈ 61 rows). All `extensions/subagent-async/test-*.cjs` green with unchanged counts except synced mirrors; `worktree-guard.test.mjs` unchanged. The 12 previously-failing `tests/checkpoint-recoverability.test.ts` rows pass on fixture shape alone — if any needs an assertion-intent change, stop and flag.

**Build requirements:** no tsconfig/package changes; `git status` clean apart from intended files.

### Structural Risks

- [x] **Route/path correctness** — row: renumbered record lives at `decisions/subagents/043-*.md`; no orphan `039-owner-state`.
- [x] **Input validation scope** — row: `validateOwnerAsks` accepts every documented report shape (its four refusal rows unchanged).
- [x] **Test surface** — row: the four suites drive real tool handlers (not internal fns); lock lifecycle row pins git's own refusal.
- [x] **Recovery logic** — row: unlock-fails → re-lock; reap failure paths re-lock; refused reports not delivered.
- [x] **No unrequested changes** — row: `git show --stat` per commit matches the expected set; WIP files untouched.
- [x] **Build config untouched** — nothing to change.
- [x] **No parallel path** — row: `readSubagentState` remains the only state reader; no re-inlined checkpoint helpers.
- [x] **Fail-hard** — row: the new R6 warning row set (loud, named) + `fs.rmSync` fallback still absent (`rg 'rmSync' extensions/subagent-async/index.ts` → 0).

### Context

**Prior work:** WO-2026-054 (this branch's spec; its `work-orders/` file is frozen), WO-2026-057 (`renderSummary`/`SummaryFields` + checkpoint lib extraction — the fixture contract this merge re-bases on), today's seat-config batch (041/042 — `FLEET_MODEL_SPEC`, unrelated files).

**Upcoming:** R8 (registry-tool gate) builds on `validateOwnerAsks` — keep its export shape; the orchestrator reconciles `docs/TODO.md` + `docs/investigations/structure-trend.md` after landing (not this order).

**Relevant decisions:** `f4f7d50` (fail hard; no safe defaults), `039-gate-suite-single-run` (consumed the 039 number), `040-refactor-first`, decision `043` = this landing's mechanism record (renumbered from the branch's draft).

### Completion Report Format

Standard report; `review_policy: required` so include `assumptions_made`, `unexpected_changes`, `issues_encountered`, `test_coverage`, `adversarial_reviews`, `review_cap_reached`. Report suite counts at each of the two commits.
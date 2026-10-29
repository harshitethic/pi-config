# Work Order: Extract checkpoint git/token observability helpers to `extensions/lib/`

### Metadata

- **work_order_id**: WO-2026-057
- **parent_plan_id**: register refactor — `docs/investigations/structure-trend.md` "extensions/checkpoint.ts growth" row (the candidate named there and in WO-2026-056's review-code MEDIUM)
- **sequence_position**: runs before the blocked orders 2/3/5 (checkpoint-sanity-check-2026-10 §6), so order 2 lands on a smaller `checkpoint.ts`
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Move the checkpoint extension's git-binding and token-accounting helpers out of `extensions/checkpoint.ts` into one shared module under `extensions/lib/`, with zero behavior change.

**Goal**: `extensions/checkpoint.ts` no longer contains the git/token helper block; the helpers live in one importable lib module following the `read-tracking.ts` convention; every existing test row passes unchanged.

### Premise

The extracted helpers have no hidden coupling to `checkpoint.ts` module state. Probe: `rg -n 'runGit|captureGitBinding|tokensBefore|renderTokenDelta|recordTokensAfter|metaPathFor|GitBinding|CheckpointTokens' extensions/` — every hit is a definition, a call from `checkpoint.ts`'s handlers/notify, or a type annotation; all functions already take `cwd`/`ctx`/`archivePath` parameters. If any helper reaches module state (the pending-checkpoint map, tool registration), pass it as a parameter. If parameterization would change behavior, stop and report `PREMISE FALSIFIED`; nothing lands.

### Preparatory refactor

This order **is** the register's named refactor (decision subagents/040). Characterization coverage is already landed: WO-2026-056's rows S6a/S6b/S6c (token accounting), S7 (goal + git hash in `/checkpoints`), S8 (git captured before the archive write), S9 (non-git → `git: null`) exercise exactly the moving code through the real tool surface. Expected new rows: none. If a gap surfaces while moving, add the characterization row **before** the move.

### Rejected alternatives

None on record (no owner ruling about module layout).

### Scope

**Invariants** (the blast radius):
- Behavior byte-identical: notify token-delta wording, meta shape (`summaryFields`/`tokens`/`git`, explicit `null`s), capture-before-write ordering (git snapshot before the archive file is written — S8), the `recordTokensAfter` read-modify-write patch invoked at `ctx.compact().onComplete` (WO-2026-056 landing stamp: do **not** move this into `execute` — the timing is pi's API shape), `runGit`'s 2 s timeout and null-on-failure, `recordTokensAfter` swallowing patch failures after the notify.
- Zero test edits. Any row that must change means behavior changed — stop and report instead of editing.
- No new public surface: no tool, no config key, no README change — internal move only.
- One-way dependency: the new lib module never imports from `extensions/*.ts`.

**Files expected to change** (guidance, not a limit):
- `extensions/checkpoint.ts` — delete the extracted block, import from the new module
- `extensions/lib/checkpoint-meta.ts` (new; one module — the register names the functions, not the filename; keep this name or pick better, one module either way) — `runGit`, `captureGitBinding`, `tokensBefore`, `renderTokenDelta`, `recordTokensAfter`, `metaPathFor`, `GitBinding`, `CheckpointTokens`

**Files to read (reference only, do not modify)**:
- `extensions/lib/read-tracking.ts` — module convention from WO-2026-055 (named exports, header comment, no default export)
- `work-orders/WO-2026-056-checkpoint-schema-observability.md` — the landing stamp on `tokens.after` timing; the moved comments are load-bearing

**Files NOT to modify** (explicit guardrails):
- `extensions/auto-checkpoint.ts`, `extensions/compaction-model.ts`, `extensions/lib/read-tracking.ts`, `settings.json`, `decisions/settings/**` — other register rows / another session's uncommitted WIP / order 2's territory
- `tests/**` — this is a pure refactor; the suite passes as-is
- `README.md` — nothing user-visible moves

**Out of scope**: `renderSummary` and the summary schema (stays in `checkpoint.ts`), the meta builder's composition (stays at its one site; it may import `metaPathFor`), the `auto-checkpoint.ts` migration, extracting anything else.

### Implementation Specification

1. Run the premise census (`rg` above) and record the hit list in the report.
2. Create `extensions/lib/checkpoint-meta.ts` with the moved functions **verbatim** — comments travel with their functions (the `estimatedTokensAfter` timing note and the capture-before-write note are load-bearing).
3. Rewire `extensions/checkpoint.ts`: import the helpers, delete the originals. Export only what `checkpoint.ts` consumes; keep the rest module-private.
4. One commit (this order is the refactor; there is no follow-up change).

**Required test boundary**: the existing rows of `tests/e2e-checkpoint.test.ts` through the real tool `execute` — the boundary's existing rows are the acceptance evidence.

**Behavior and failure matrix** (refactor order — each case must already be pinned by the named row):

| case | pinned by |
|---|---|
| git binding captured before the archive is written | S8 |
| non-git cwd → `git: null`, archive written, checkpoint proceeds | S9 |
| tokens.before from context usage, after patched at `onComplete` (result takes precedence) | S6a |
| no post count → `after: null`, notify shows before only | S6b |
| nothing estimable → no token text in notify, both counts null | S6c |
| `/checkpoints` renders goal headline + git hash from meta | S7 |
| git failure/hang → null within the 2 s timeout | same catch as S9 (not separately rowed — WO-2026-056 accepted note) |
| token-delta notify wording unchanged | S6a/S6b/S6c assertions |

**Integration contract**: `checkpoint.ts`'s handlers call the module; the module takes `cwd`/`ctx`/`archivePath`/values as parameters and imports nothing from `extensions/*.ts`; no registration side effects at import.

**Reference patterns**: `extensions/lib/read-tracking.ts` (export shape, header comment style).

### Invariants

**Cross-file conventions**:
- Lib modules follow `read-tracking.ts`: named exports, header comment naming the seam, no default export, no side effects at import.
- One-way imports: `extensions/lib/*` never imports from `extensions/*.ts`.
- `null` (not `undefined`, not absent) for missing `git`/token fields — S6b/S6c/S9 pin explicit nulls.

**Ordering assumptions**:
- Git snapshot is taken before the archive write (S8); the move must not reorder these calls.
- `recordTokensAfter` runs from `ctx.compact().onComplete`, after the notify (WO-2026-056 landing stamp).
- Meta construction stays at its one site in `checkpoint.ts` (the token patch is the only second writer).

**Error handling conventions**:
- `runGit` keeps its 2 s timeout and catch → `null`; `captureGitBinding` keeps partial-null behavior; `recordTokensAfter` keeps swallowing patch failures after the notify. No new error paths, no new throws.

### Verification Criteria

**Entry points that must work**: `checkpoint`, `checkpoint_fork`, and `/checkpoints` exactly as before — exercised via the existing rows.

**Input shapes that must be accepted**: unchanged — the schemas are untouched.

**Tests that must pass**: the entire `tests/e2e-checkpoint.test.ts` **unchanged** (zero diff under `tests/`), and the full suite green. Env note: when the test runner is itself a subagent, run `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` — those inherited vars otherwise fail 11 subagent-boundary rows (known environmental artifact, not this change's).

**Test surface requirements**: no new tests expected; the existing rows through real tool `execute` are the acceptance evidence.

**Build requirements**: no package/config changes; `git diff --stat` shows exactly two paths (`extensions/checkpoint.ts`, the new lib file) unless a premise-driven parameter forced a listed-adjacent edit — then it goes under `unexpected_changes` with why.

### Structural Risks

- [x] **Route/path correctness**: helpers reachable at the new module path with unchanged export names
- [ ] **Input validation scope**: not applicable (no validation added or changed)
- [x] **Test surface**: existing rows through real `execute`, not helper-level tests
- [x] **Recovery logic**: the catch/timeout/swallow semantics listed under Error handling survive the move unchanged
- [x] **No unrequested changes**: exactly the two expected paths
- [x] **Build config untouched**
- [x] **No unsolicited features**: no new exports beyond what `checkpoint.ts` consumes
- [x] **No parallel path**: the block is **deleted** from `checkpoint.ts`, not copied — `rg` must show zero remaining definitions there

### Context

**Prior work orders in this plan**:
1. WO-2026-055 — shared `read-tracking.ts`; the module convention this order follows.
2. WO-2026-056 — created the block being moved; its rows are the characterization suite.

**Upcoming work orders** (don't break them):
1. Order 2 (summary-ownership dispatch, blocked on owner ruling) — will touch `checkpoint.ts`'s handlers and `compaction-model.ts`; do not reshape handler structure beyond the move.
2. Order 3 (drift decision record), order 5 (pi upgrade evaluation) — unaffected.

**Relevant decisions**: WO-2026-056's landing stamp (token timing is pi's API shape — the patch stays where it is invoked); decision subagents/040 (this order is the "make the change easy" step for order 2).

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator, plus (review_policy: required) assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews / review_cap_reached / accepted_notes.

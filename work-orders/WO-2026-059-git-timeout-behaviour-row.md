# WO-2026-059 — git-hang timeout behavioural row for checkpoint-meta

### Metadata

- **work_order_id**: WO-2026-059
- **parent_plan_id**: standalone — structure-trend parked follow-up (git-hang behavioural row)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Pin the hang protection in `runGit` (the `execFile` timeout in `extensions/lib/checkpoint-meta.ts`) with a behavioural row that provably goes red when that timeout is removed.

**Goal**: `tests/checkpoint-meta.test.ts` gains a row exercising `captureGitBinding` against a hung `git`, asserting it resolves `null` within a bounded time; a mutation check (dropping the `timeout` option from `runGit`'s `execFile` call) reds the row — proving the row, not just the constant, carries the protection.

### Premise

`runGit`'s only hang protection is `timeout: GIT_TIMEOUT_MS` (2000) in its `execFile` options, and the module's contract ("any failure — not a repo, no git binary, timeout — yields null") has no row on the timeout path: dropping the option passes the whole suite (register note in `docs/investigations/structure-trend.md`). Probe (a control that discriminates): implement the row, then temporarily delete the `timeout` option from the `execFile` call — the row must go red (the hung git never calls back, so `captureGitBinding` never resolves and the row's bounded witness fires). Report both sides (red-without-timeout / green-with). If the row passes both ways, it is a no-op control: report `PREMISE FALSIFIED` and land nothing.

### Preparatory refactor

**`none`** — the change adds one test row at one site and touches no production code; the area has no existing mechanism to extend (census: `tests/` currently has zero references to `checkpoint-meta`/`captureGitBinding`).

### Rejected alternatives

None on record.

### Scope

**Invariants** (blast radius):
- Production code is untouched: `extensions/lib/checkpoint-meta.ts` (and every other `extensions/` file) stays byte-identical. If you believe a testability seam in production code is required, stop and report instead of changing it.
- The row exercises the exported entry `captureGitBinding`, not the private `runGit` — and exercises it against a genuinely hung `git` (a shim that sleeps), not a fast-failing one; a shim that exits early no-ops the timeout and the row proves nothing.
- Env hygiene: any `process.env` mutation (e.g. `PATH` for the shim) is save/set/restore in the row or beforeAll/afterAll per the `tests/owner-asks.test.ts` sibling pattern — including the recorded Bun quirk that children get the **startup** env snapshot, so in-process mutations may not reach `execFile` children (verify with a probe before building on it; if they don't, run the scenario in a child process with explicit `env`, the way `tests/subagent-boundary-hermeticity.test.ts`'s harness does).
- Load independence (pi-config#3 is open on exactly this): the row sets its own explicit test timeout and a bounded witness strictly below it, so a hang fails with the witness's message, not with an implicit 5000ms budget kill.

**Files expected to change** (guidance, not a limit):
- `tests/checkpoint-meta.test.ts` (new — mirrors the per-lib convention of `tests/read-tracking.test.ts`).

**Files to read (reference only, do not modify)**:
- `extensions/lib/checkpoint-meta.ts` — `runGit`/`captureGitBinding` contract (timeout yields `null`).
- `tests/owner-asks.test.ts` — env save/set/restore pattern + the startup-snapshot note at its `spawnSync` rows.
- `tests/read-tracking.test.ts` — per-lib test file convention.
- `docs/investigations/structure-trend.md` (the parked-follow-up row this fulfils).

**Files NOT to modify** (explicit guardrails): everything under `extensions/`; `tests/subagent-boundary-hermeticity.test.ts` and the three boundary test files (WO-2026-058 is in flight on them); `bunfig.toml`/build config.

**Out of scope**: the other `captureGitBinding` failure paths (not-a-repo, missing git binary) — the comment's contract, but not what this order pins; e2e checkpoint-flow rows; parameterizing `GIT_TIMEOUT_MS`; pi-config#3/#4.

### Implementation Specification

**Detailed requirements**:
1. Census: confirm there is no existing direct coverage of `checkpoint-meta` and pick the row's home (`tests/checkpoint-meta.test.ts` unless the census shows a better-fitting existing file).
2. Build the hang fixture: a `git` shim that sleeps (e.g. a temp dir with a `git` script that `sleep`s, found first on `PATH`), with the env mechanism verified against the startup-snapshot quirk (see Invariants).
3. Row: `captureGitBinding(cwd)` against the hung git resolves `null` within a bounded time (witness race with a clear failure message). Include a fast control case alongside (real git in a temp repo → non-null binding) so the row proves it is exercising `captureGitBinding`'s real path, not a stub.
4. Mutation check (the acceptance proof): delete the `timeout` option from `runGit`'s `execFile` call, confirm the row reds via its witness, restore it, confirm green. Report both observations in the completion report.
5. Full-suite regression run at the end (see Verification).

**Required test boundary**: the exported `captureGitBinding(cwd)` — cheapest stable external entry; both the hang case and the real-git control run through it.

**Behavior and failure matrix**:

| case | expected |
|---|---|
| real `git`, real repo | `captureGitBinding` resolves a non-null binding (control: the row drives the real path) |
| hung `git` (sleeping shim) | resolves `null` within `GIT_TIMEOUT_MS` + slack; bounded witness below the row's own test timeout; hang fails with the witness's message |
| mutation: `timeout` option dropped | the hang row goes red (reported both ways — this is the acceptance proof) |
| env teardown | `process.env` restored after the row even on failure; subsequent rows unaffected (no order dependence) |

**Integration contract**: `captureGitBinding` is consumed by the checkpoint flow (git-ref binding in archive meta, WO-2026-056); its "git never blocks the checkpoint" contract is what the row protects. No production code changes.

**Reference patterns**: `tests/read-tracking.test.ts` (per-lib row style); `tests/owner-asks.test.ts` (env hygiene).

### Invariants

**Cross-file conventions**:
- Per-lib test file naming (`tests/<lib>.test.ts`) matching `extensions/lib/<lib>.ts`.
- Env mutation follows the save/set/restore sibling pattern with restore-on-failure.

**Default values to preserve**: `GIT_TIMEOUT_MS` stays 2000; the row may bound its witness around it but must not change it.

**Ordering assumptions**: the mutation check runs against the final tree (timeout present → green; dropped → red).

**Error handling conventions**: a shim/setup failure fails the row loudly with captured output — no try/catch converting a crash to a pass.

**Unspecified invariants**: none — `invariant_exhaustiveness: explicit`.

### Verification Criteria

**Entry points that must work**: `captureGitBinding` against both fixture shapes (matrix rows 1–2).

**Tests that must pass**: `bun test tests/checkpoint-meta.test.ts`, then the full suite with zero failures (measure at your creation commit; do not quote counts from this order).

**Test surface requirements**: rows go through `captureGitBinding`; direct `runGit`-only tests would be INADEQUATE (it is module-private and the contract is on the export).

**Build requirements**: no dependency or build-config changes.

**Operational note (you run as a subagent)**: the harness injects `PI_SUBAGENT_*` into your process; while WO-2026-058 is unfixed you may see 11 phantom failures in the three subagent-boundary files on bare `bun test` runs — they are not yours. Use `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` for suite runs and say so in the report if you saw them.

### Structural Risks

- [ ] **Route/path correctness**: matrix names `captureGitBinding` explicitly; the row's home is named.
- [ ] **Input validation scope**: n/a; fixture shapes are the matrix rows.
- [ ] **Test surface**: the exported-entry requirement above.
- [ ] **Recovery logic**: env restore-on-failure invariant + the teardown row.
- [ ] **No unrequested changes**: production untouched (hard invariant above).
- [ ] **Build config untouched**: named guardrail.
- [ ] **No unsolicited features**: out-of-scope list is explicit (do not add rows for the other failure paths).
- [ ] **No parallel path**: one fixture (the shim), one row file; no second harness.

### Context

**Prior work orders completed in this plan**: WO-2026-057 extracted `extensions/lib/checkpoint-meta.ts`; this row is the follow-up the register parked for it. WO-2026-055/056 are checkpoint-area context only.

**Upcoming work orders** (do not break them): WO-2026-058 (subagent-boundary hermeticity) is in flight on other test files — leave its files alone. Checkpoint summary-ownership and pi-upgrade orders follow; none depend on this row.

**Relevant decisions**: `decisions/subagents/040-refactor-first.md` (prep-refactor section above: `none` with census reason); the startup-snapshot quirk is recorded at pi-config#7's fix (`afe16c9`).

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator. Also: assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews (both verdicts, session IDs, rounds, remaining findings), review_cap_reached, accepted_notes. The mutation-check observations (red-without-timeout / green-with) are required content in `tests`.

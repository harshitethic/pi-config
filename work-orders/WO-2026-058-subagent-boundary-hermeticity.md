# WO-2026-058 — subagent-boundary suite hermeticity (pi-config#9)

### Metadata

- **work_order_id**: WO-2026-058
- **parent_plan_id**: standalone — pi-config#9 (test-suite verdict must not depend on invocation context)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Make the subagent-boundary test rows insensitive to the ambient `PI_SUBAGENT_*` environment so `bun test` reports the same verdict whether the test runner itself runs inside a subagent or not, and flip the pin row that records the bug.

**Goal**: `bun test` reports 0 fail for the three boundary files — and for the whole suite — both with and without the harness-injected `PI_SUBAGENT_ALLOWLIST`/`PI_SUBAGENT_DEPTH`/`PI_IS_SUBAGENT`; `tests/subagent-boundary-hermeticity.test.ts`'s KNOWN-BUG row is flipped to its positive form via its own documented procedure.

### Premise

The failing rows in `tests/subagent-model-inheritance.test.ts`, `tests/work-order-policy-wiring.test.ts`, `tests/work-record-capture.test.ts` (11 rows at the pin's commit) fail under injection because those rows spawn through the tool gate — `extensions/subagent-async/index.ts` reads `process.env.PI_SUBAGENT_ALLOWLIST` for its allowlist check and `subagentDepth()` for the nesting cap — so an inherited allowlist refuses the `implement`/`orchestrator` spawns the rows are about. Probe: `env PI_SUBAGENT_ALLOWLIST=review-code,review-tests PI_SUBAGENT_DEPTH=1 PI_IS_SUBAGENT=1 bun test <the three files>` fails while the same run without those vars is green (the pin's KNOWN-BUG row asserts exactly this split and is green at the creation commit). If the two runs already agree, report `PREMISE FALSIFIED` and land nothing.

Also load-bearing (recorded at pi-config#7's fix, commit `afe16c9` on `origin/bug-triage/owner-asks-subagent-env-pin`): Bun children get the **startup** env snapshot — in-process `delete process.env.X` never reaches a `spawnSync` child; spawns must pass an explicit `env`. A scrub that only mutates `process.env` silently no-ops for child spawns. Verify, don't assume (a passing-vs-failing pair or the spawn's captured env).

### Preparatory refactor

**Refactor commit** (behind the three files' existing rows, which are the characterization tests and must pass unchanged at this commit): extract the shared env-control helper the three files adopt — snapshot/delete/restore scrub (with restore in `afterAll` even on failure) plus an explicit-env spawn wrapper covering the startup-snapshot quirk. Follow the sibling pattern already in `tests/owner-asks.test.ts` (its `savedSubagentDepth` beforeAll/afterAll scrub and its per-row `saved`/restore block around the env-sensitive case). Step 0 is a census of the three files' spawn setups (`rg -n "PI_SUBAGENT|spawn|spawnSync|Bun\.spawn" tests/subagent-model-inheritance.test.ts tests/work-order-policy-wiring.test.ts tests/work-record-capture.test.ts`); a negative result (nothing shareable beyond the env control) is valid — the env-control helper is shared regardless. One helper, adopted by all three; no third copy of scrub logic.

### Rejected alternatives

None on record.

### Scope

**Invariants** (blast radius):
- The spawn gate's env sensitivity is the *feature under test*: `extensions/subagent-async/index.ts`'s reads of `PI_SUBAGENT_ALLOWLIST`/`PI_SUBAGENT_DEPTH` must not change. No file under `extensions/` changes at all.
- Rows that exercise allowlist/nesting behavior must keep exercising it after the fix — they control the env they exercise (explicit per-row env) and still assert the env-driven outcome. A fix that goes green by not spawning, by weakening assertions, or by teaching the gate to ignore the env is a fail, not a fix.
- Verdict invariance is the invariant: the suite's verdict must be identical under injected and bare env. The runner's own subagent-ness may not be observable in results.
- The pin file keeps its harness shape (child `bun test` of the three boundary files with `INJECTED`); only its KNOWN-BUG row is flipped/renamed per the procedure documented in the file's own comment (assertion becomes `expect(out).toContain("0 fail")`, name becomes the positive one), and its "gh #19" citation is corrected to pi-config#9.
- No other test file changes except adopting the new shared helper.

**Files expected to change** (guidance, not a limit):
- `tests/subagent-model-inheritance.test.ts`, `tests/work-order-policy-wiring.test.ts`, `tests/work-record-capture.test.ts` — adopt the helper; rows keep their assertions while controlling env explicitly.
- `tests/subagent-boundary-hermeticity.test.ts` — flip the pin row + fix the issue citation.
- `tests/helpers/` (new shared helper; name is the implementer's choice).

**Files to read (reference only, do not modify)**:
- `extensions/subagent-async/index.ts` — the gate's env reads (`PI_SUBAGENT_ALLOWLIST` allowlist check, `subagentDepth()` nesting cap); what the rows exercise.
- `tests/owner-asks.test.ts` — the sibling scrub pattern and the startup-snapshot note at its `spawnSync` rows.
- `tests/subagent-boundary-hermeticity.test.ts` — its comment documents the intended end state and the row-flip procedure.

**Files NOT to modify** (explicit guardrails):
- Anything under `extensions/` — the gate's behavior is the subject, not the lever.
- `bunfig.toml` — permitted only if you choose the preload mechanism: one test-only preload entry, nothing else. A global scrub that hides env sensitivity from rows which must *exercise* it is wrong regardless of mechanism.
- Build/dependency config (`package.json` etc.).

**Out of scope**: other open test-infra bugs (pi-config#4 spawn-log leak, pi-config#3 load-dependent timeouts, pi-config#1 stage-2 kill); the checkpoint work orders (WO-2026-055..057 area); making any extension "test-aware".

### Implementation Specification

**Detailed requirements**:
1. Step 0 census (see Preparatory refactor). Identify the failing rows and how each builds its child env today. Measure and report the current fail counts (bare vs `INJECTED`) — measure fresh at your creation commit; the pin comment's "11 rows" is historical, do not quote it as yours.
2. Refactor commit: extract + adopt the shared helper; rows unchanged; suite green bare.
3. Change commit: the rows control their env (beforeAll/afterAll scrub via the helper and/or explicit env per spawn row), and the injected run goes green.
4. Pin flip in the same commit as the green injected run (never leave a commit red): positive assertion + rename per the pin's procedure; fix the "gh #19" citation to pi-config#9.
5. Verify verdict invariance end to end (matrix below) and attach measured numbers for each row.

**Required test boundary**: two external observables, both required:
- `bun test tests/subagent-boundary-hermeticity.test.ts` — its row runs a child `bun test` of the three files under `INJECTED` and must report the positive outcome.
- `env PI_SUBAGENT_ALLOWLIST=review-code,review-tests PI_SUBAGENT_DEPTH=1 PI_IS_SUBAGENT=1 bun test` (whole suite) — the original failure mode; must report 0 fail.

**Behavior and failure matrix** (non-overlapping; the test reviewer audits row by row):

| case | expected after the fix | today |
|---|---|---|
| three boundary files, bare env | 0 fail | 0 fail (keep) |
| three boundary files, `INJECTED` env | 0 fail | 11 fail (the fix's observable) |
| whole suite, bare env | 0 fail | 0 fail (keep) |
| whole suite, `INJECTED` env | 0 fail | ≥11 fail (original symptom, pi-config#9) |
| gate-sensitivity rows (allowlist refusal, nesting cap) | pass **and** still assert env-driven behavior — each sets the env it exercises explicitly | pass bare, fail injected |
| pin row after flip | positive assertion green, renamed; suite green at the same commit | KNOWN-BUG row green (asserts the bug) |
| runner genuinely inside a subagent (real harness injection) | identical verdict to bare | 11 phantom failures |

**Integration contract**: the rows spawn real subagents through the tool gate; the fix lives entirely on the test side. No production code is involved.

**Reference patterns**: `tests/owner-asks.test.ts` (scrub pattern + explicit spawn env); `tests/subagent-boundary-hermeticity.test.ts` comment (flip procedure).

### Invariants

**Cross-file conventions**:
- One shared env-control helper; no per-file copies of the scrub logic. Restore runs in `afterAll` (or equivalent teardown) even when a row fails.
- Spawns pass explicit `env` (startup-snapshot quirk, Premise) — never rely on in-process `process.env` mutation reaching a child.

**Default values to preserve**:
- `INJECTED` keeps the harness's shapes: `PI_SUBAGENT_ALLOWLIST="review-code,review-tests"`, `PI_SUBAGENT_DEPTH="1"`, `PI_IS_SUBAGENT="1"`. Don't "fix" the pin by changing the injected values.

**Ordering assumptions**:
- Helper adoption (refactor commit) lands before the behavior change; the pin flip lands in the same commit as the green injected run.

**Error handling conventions**:
- A spawn that dies fails its row with the captured output — no swallowed failures, no try/catch that converts a crash to a pass.

**Unspecified invariants**: none — `invariant_exhaustiveness: explicit`.

### Verification Criteria

**Entry points that must work**: the two Required-test-boundary commands, both reporting 0 fail.

**Input shapes that must be accepted**: n/a (test-side only); the rows must behave identically with the vars absent, injected by the harness, and set per-row.

**Tests that must pass**: the full matrix above; `bun test` bare and injected with identical verdicts.

**Test surface requirements**: rows must exercise real spawns through the tool gate — that is what they are for. Internal-helper-only coverage is INADEQUATE here.

**Build requirements**: no dependency or build-config changes beyond the optional `bunfig.toml` preload entry; `bun test` remains the only runner.

**Operational note (you run as a subagent)**: the harness injects `PI_SUBAGENT_*` into *your* process, so a bare `bun test` from your shell shows the phantom failures until your fix lands. For pre/post comparisons use `env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test` as the baseline; after the fix, the suite must be green **without** that workaround as well.

### Structural Risks

- [ ] **Route/path correctness**: exercised by matrix rows naming the three boundary files and the pin flip.
- [ ] **Input validation scope**: n/a — but the vars-absent / injected / per-row shapes are the matrix's env rows.
- [ ] **Test surface**: the "gate-sensitivity rows still assert env-driven behavior" row is the guard; a no-spawn or weakened-assertion fix fails it.
- [ ] **Recovery logic**: teardown restores env even on failure — covered by the helper invariant; the matrix's bare-vs-injected rows detect leakage between rows.
- [ ] **No unrequested changes**: scope invariants + Files NOT to modify; anything else goes under `unexpected_changes` with justification.
- [ ] **Build config untouched**: `bunfig.toml` exception is named and bounded above.
- [ ] **No unsolicited features**: out-of-scope list is explicit.
- [ ] **No parallel path**: the shared-helper rule in the preparatory refactor; one scrub mechanism, not three.

### Context

**Prior work orders completed in this plan**: none (standalone fix). Neighbouring landings for trajectory only: WO-2026-055/056/057 (checkpoint area) — untouched here.

**Upcoming work orders** (do not break them): checkpoint summary-ownership fix, drift decision record, pi 0.83.0→1.3.0 upgrade — none depend on test-side env handling, and none may be affected by your changes.

**Relevant decisions**: `decisions/subagents/040-refactor-first.md` (the preparatory refactor above honours it); pi-config#7's fix (`afe16c9`) is the precedent for the scrub pattern and the startup-snapshot quirk.

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator. For this code change also: assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews (both reviewer verdicts, session IDs, rounds used, remaining findings), review_cap_reached, accepted_notes. Attach the measured matrix numbers at your creation commit.

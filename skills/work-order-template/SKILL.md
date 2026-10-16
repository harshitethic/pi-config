---
name: work-order-template
description: Work order schema for delegating implementation tasks to subagents (implement). Load this skill when generating, reviewing, or filling out a work order — defines the required sections the orchestrator must populate and the fields the implementer reads.
---

# Work Order Template

## Instructions for the Orchestrator

You are generating a work order to dispatch to an implementation agent. Fill in every section that applies; omit the rest.

Your work order quality directly determines whether the implementer succeeds on the first pass. If you cannot fully specify all invariants, set `invariant_exhaustiveness: implicit` so the implementer knows to enumerate them.

---

## Work Order

### Metadata

- **work_order_id**: <unique identifier, e.g., WO-2026-007>
- **parent_plan_id**: <ID of the planning session this work order belongs to>
- **sequence_position**: <N of M work orders in the current plan>
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit | implicit
- **priority**: critical | normal | low
- **estimated_complexity**: trivial | moderate | complex
- **review_policy**: required | skip — default `required`. Set `skip` only for documentation-only changes or explicit justified exceptions (state the reason). The bullet is the prescribed form; a bare bold line (no dash) and the YAML `review_policy:` form are also accepted — see [Encoding](#encoding--use-the-bolded--metadata-block).

### Task Summary

**One-sentence description**: <what this work order accomplishes, in plain language>

**Goal**: <the specific outcome the implementer must produce — not the "how," the "what">

### Premise

<The one fact the specified mechanism depends on, and the probe that would falsify it.> If falsified:
stop, report `PREMISE FALSIFIED` with the evidence; nothing lands.

### Rejected alternatives

Only alternatives the owner rejected, each citing its ruling (decision, registry row or brief with
date). Never filled from the order author's own reasoning; omit the section when there are none.
Landing a listed alternative is not this work order.

### Scope

**Invariants** (the blast radius — what must not change): <behaviour, layouts, passes or files that
must stay untouched, and why>. Scope is these invariants, not a file list: an implementer may edit a
file not named below when the invariants hold, and lists it under `unexpected_changes` with why.

**Files expected to change** (guidance, not a limit):
- `path/to/file.rs` — <what changes in this file>

**Files to read (reference only, do not modify)**:
- `path/to/reference.rs` — <why the implementer needs to read this>
- `path/to/pattern.rs` — <existing code that demonstrates the convention to follow>

**Files NOT to modify** (explicit guardrails):
- `path/to/do_not_touch.rs` — <reason: e.g., "downstream pass depends on current IR shape">

**Out of scope**: <anything adjacent that might tempt the implementer but is not part of this work order>

### Implementation Specification

**Detailed requirements**: <step-by-step description of what to implement. Be specific about behavior, not just structure.>

**Required test boundary**: <the cheapest stable externally observable
entry point through which tests must exercise the behavior — public
API, CLI command, compiler driver, HTTP endpoint. For pure,
deterministic, inexpensive input/output transformers, end-to-end /
oracle / golden tests through this boundary are the primary
correctness evidence. Unit tests may supplement but do not replace
them. State the boundary explicitly; do not let the implementer
guess.>

For a refactor (extract, merge, move), the boundary's **existing** rows
are the acceptance evidence: name them, and make characterization rows
step 0 where the touched behaviour is not pinned. An existing row that
must change means behaviour changed.

**Behavior and failure matrix**: <the cases the implementation must
satisfy, organized as a non-overlapping matrix that the test reviewer
can audit row by row. Cover at minimum:

- For behavior-split surfaces (eager/lazy, two spellings, two registration
  shapes), name which case is the NOVEL exposure — "pre-change this was
  trivially right; now it isn't" — and pin BOTH shapes. Testing only the
  historically-fragile half pins the half that didn't change. (Origin:
  tfd-b WO-078 F2 — eager impls were the novel exposure under lazification
  precisely because eager registration had made them trivially right.)

- Success paths the work order requests
- Validation, malformed, empty, boundary, and failure paths
- Retry, timeout, recovery, and partial-failure behavior (when relevant)
- Regressions for every issue fixed or discovered during implementation

Each row should name the case precisely. The implementer's tests and
the test reviewer's coverage matrix both target these rows.>

**Representation-level checks**: <only when applicable — IR shape,
generated code, optimization invariants, internal data-structure
checks. These supplement behavioral tests but do not replace them.
Specify which representations must hold and how the implementer
should assert them. Omit this subsection if the work order has no
representation-level concerns.>

**Integration contract**: <how this code connects to the rest of the
system — what calls it, what it calls, what interfaces it must
implement, what types it must produce/consume>

**Reference patterns**: <point to existing code in the repo that demonstrates the style/convention to follow. E.g., "follow the pattern in `passes/constant_folding.rs` for pass registration and visitor implementation">

### Invariants

List every invariant the implementer must preserve. This is the most critical section — invariants left unstated become silent bugs.

**Cross-file conventions**:
- <e.g., "All IR nodes must implement the `Visitable` trait">
- <e.g., "All passes return `Result<Module, CompileError>`">
- <e.g., "The pass registry must be updated when a new pass is added">

**Default values to preserve**:
- <e.g., "The default optimization level is O2, not O0">
- <e.g., "If no target triple is specified, default to x86_64-unknown-linux-gnu">

**Ordering assumptions**:
- <e.g., "Constant folding runs before dead code elimination">
- <e.g., "SSA construction must complete before any optimization pass runs">

**Error handling conventions**:
- <e.g., "Errors propagate via `?` operator, never panic in pass implementations">
- <e.g., "All user-facing errors must be wrapped in CompileError with source location">

**Unspecified invariants** (only if `invariant_exhaustiveness: implicit`):
- <e.g., "The work order references 'standard pass conventions' but does not enumerate them — the implementer must check `passes/mod.rs` for the full convention list">
- <e.g., "Error recovery behavior for malformed IR is not specified — follow the pattern in the existing passes">

> If you cannot enumerate all invariants, you MUST set `invariant_exhaustiveness: implicit` above. Do not mark `explicit` unless you are confident every invariant is stated.

### Verification Criteria

The implementer must verify all of the following before reporting completion.

**Entry points that must work**:
- <e.g., "The HTTP endpoint at `/workflows/:key/runs` must return 200 for valid inputs">
- <e.g., "The CLI command `compiler --pass=constant-folding input.ll` must produce valid output">

**Input shapes that must be accepted**:
- <e.g., "The parser must accept both objects and arrays at the top level">
- <e.g., "The pass must handle modules with zero functions without crashing">

**Tests that must pass**:
- <e.g., "`cargo test passes::constant_folding` — all tests pass">
- <e.g., "Integration tests in `tests/end_to_end.rs` that exercise the new pass must pass">

**Test surface requirements**:
- <e.g., "Integration tests must call the actual `compile()` entry point, not internal pass functions directly">
- <e.g., "Tests must exercise the error path, not just the happy path">
- Tests must hit the **Required test boundary** declared above. If the
  implementer only writes internal-helper tests for a public-API
  change, the test reviewer will mark that INADEQUATE.
- For pure deterministic transformers with a cheap stable public
  boundary, end-to-end / oracle / golden tests are primary;
  unit tests are supplemental. State this explicitly when it
  applies.

**Build requirements**:
- <e.g., "`cargo build` succeeds with no warnings related to this change">
- <e.g., "Do not modify Cargo.toml unless adding a dependency that is explicitly required">

### Structural Risks

Known risk patterns for this task type. The implementer must explicitly check for these.

- [ ] **Route/path correctness**: Every endpoint, public function, or CLI command is at the path specified in the work order (not a variant or prefix of it)
- [ ] **Input validation scope**: Validation accepts every input shape the spec allows — no over-constraining types or rejecting valid inputs
- [ ] **Test surface**: Tests exercise the actual entry points (HTTP endpoints, public APIs, CLI commands), not internal functions called directly
- [ ] **Recovery logic**: If error handling or retry logic is involved, recovery paths do not execute work after a parent failure has occurred
- [ ] **No unrequested changes**: No files, routes, or structures modified beyond what the work order specifies
- [ ] **Build config untouched**: Build configuration (tsconfig, Cargo.toml, CMakeLists) not modified unless explicitly requested
- [ ] **No unsolicited features**: No features, refactors, or "improvements" added that were not requested in the work order

> The implementer must check every box above. If any check fails, the implementer must fix the issue before reporting completion or flag it in the completion report.

> Every risk that applies must be **exercised by a named row**, or the report must
> say why it cannot be. A risk list with no row behind it is a review round waiting
> to happen. (Origin: tfd WO-2026-143 — two separate reviewer findings hit the same
> pattern: the order's claimed guards did not actually cover the changed path until
> rows were written for them.)

### Context

**Prior work orders completed in this plan** (to maintain trajectory coherence):
1. <WO-2026-005: Added IR node definitions> — <key state change: IR nodes now support `Visitable`>
2. <WO-2026-006: Updated pass registry> — <key state change: registry accepts new pass registrations>

**Upcoming work orders** (so the implementer doesn't break future work):
1. <WO-2026-008: Will add dead code elimination pass> — <implementer must not change the pass registration interface>

**Relevant decisions from planning session**:
- <e.g., "Decided to use visitor pattern rather than match-based traversal for all new passes">
- <e.g., "Decided to defer SSA validation to a separate pass, not inline it here">

### Completion Report Format

The implementer must produce a completion report in their final assistant message. All implementers use: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator.

For code-changing work (`review_policy: required`), also include:
- **assumptions_made** — invariants assumed, not explicit in work order
- **unexpected_changes** — files touched outside scope, with justification
- **issues_encountered** — bugs found, workarounds applied
- **test_coverage** — one-line summary (per-case matrix is `review-tests`'s job)
- **adversarial_reviews** — both reviewer verdicts, session IDs, rounds used, remaining findings
- **review_cap_reached** — `true` if 3-round cap hit
- **accepted_notes** (optional) — low-severity notes intentionally not fixed, with rationale

See the agent's system prompt for exact schema. A `complete` status requires both reviewers APPROVED (or APPROVED_WITH_NOTES with notes resolved/accepted).

---

## Persistence and lifecycle

The template above defines a work order's *content*. This section defines where it
lives and what happens to it afterwards.

### Where it goes

Write the work order to **`work-orders/` at the target repo's root**, as
`work-orders/<work_order_id>-<short-slug>.md`. Pass that repo-relative path as
`workOrderPath` on the `subagent` call.

Do **not** put work orders under `docs/`. They are dispatch artifacts, not
documentation: they are unindexed, they are never updated after landing, and in
bulk they drown the curated doc set — 173 accumulated work orders were 46% of
one repo's `docs/` by volume before they were relocated.

`work_order_id` is unique **per repo**, not globally. `WO-2026-013` names
different work in `tfd` and in `pi-config`. Never assume an ID identifies a work
order without knowing which repo it belongs to.

### Encoding — use the bolded `### Metadata` block

Write metadata as the bolded bullet list shown in the template above; that is
the canonical form the parser prefers. This is a **code contract, not a style
preference**: the gate parses `review_policy` with two regexes —

```
/^\s*(?:-\s*)?\*\*review_policy\*\*:\s*(\S+)/m   ??   /^review_policy:\s*(\S+)/m
```

— the bold line first (the leading dash is optional, so a bare
`**review_policy**: skip` metadata line is accepted; before the 2026-10-07
ruling it matched nothing and silently read as `required`), YAML frontmatter as
fallback. When both are present the bold line wins. Anything else — `required`,
the template literal `required | skip`, or no declaration at all — reads as
`required`. The task-text declaration a WO-less dispatch can carry is the bold
line only; a YAML line in a task string is not read.

### Persistence — commit it, then freeze it

Commit the work order. It is the written record of what was asked for and why, at
the moment of dispatch, and is frequently the only trace of a decision's context.
Reserve the id by pushing before dispatch; a non-fast-forward rejection is a
collision alarm — see `rules/work-order-numbering.md`.

A work order quoting suite counts (baseline, expected anchors) must attach fresh
`--list` numbers measured at the creation commit — stale anchors cost diagnosis
cycles downstream (WO-2026-089: dispatched against a count three rows behind
its own base).

**Do not edit a work order after its work has landed.** A landed WO is a snapshot
of intent; its stale line numbers and paths are accurate history, not rot. Append
a landing stamp if you must, but do not rewrite the spec to match what was
actually built — that destroys the record of the gap between the two, which is
exactly what a reviewer needs.

### Graduation — durable knowledge moves out

A work order is not a home for knowledge that outlives it. When the work produces
something durable, put it where it will be maintained and leave the WO frozen with
a forward link:

| What came out of the work | Where it goes |
|---|---|
| A ruling, its alternatives, its tradeoffs | `decisions/<area>/NNN-*.md` |
| How the system now works, and why | `docs/design/` |
| What is in flight or next | `docs/current-plan.md` |
| A new term used across docs | `docs/glossary.md` |

**Watch for a work order that keeps growing.** If a WO accretes progress banners,
phase ledgers and review rounds, that is the signal it has outgrown its genre and
should have graduated into a design plan. A 650-line work order is a failure of
this rule, not a thorough one.

---

## Notes for the Orchestrator

- **Always set `invariant_exhaustiveness`**. Default to `implicit` if uncertain. When you set `implicit`, state what the enumeration must list — the list is the deliverable, and a *negative* result (no further sites) is a valid one. Do not write it up in a way that implies a find is expected.
- **Cite constructs, not line numbers.** A number measured while writing the order is stale by dispatch — four landings moved one file by 21 lines inside a day — and a *wrong* number is worse than none: it sends the implementer into unrelated code (tfd WO-2026-143 cited a binding constructor at the line of a type-unification helper). Name the function and the enclosing construct, and add a grep anchor when the name alone is ambiguous.
- **A control that silently no-ops is not a control.** Before a probe's result is written into an order, confirm the probe changed the measured outcome. A "forced" reference is only a force while its binding is non-inlinable — otherwise it is constant-substituted away and the test proves nothing (tfd item 19: `s.q.n + (d.n - d.n)` no-opped without the reshadow, and "still fails under forced capture" was an artifact of measuring nothing). Discriminate with a dump/IR or a passing-vs-failing pair.
- **Always list files NOT to modify** when adjacent files could plausibly be touched — strongest signal against scope creep.
- **Use repo-relative paths everywhere.** Subagents run in isolated worktrees; absolute parent-repo paths bypass isolation.
- **Cross-reference AGENTS.md** for project-specific conventions.
- **Consider pre-dispatch simplification.** If the change looks larger than the goal warrants, route through `review-plan` first.
## Review routing criterion

`review_policy: skip` is for changes where **no invariant can fail** — not changes where
the invariant is cheap. Size is not the criterion. Calibration case: a "trivial" directory
sweep (WO-2026-067) shipped a fail-open liveness gate that a 4-round review cycle caught;
the skip call was wrong despite the change being genuinely small. When an invariant is live
(liveness, completeness, ordering, security), route review — the cycle is cheaper than the
production failure it prevents.

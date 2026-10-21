# WO-summary-ownership-dispatch — summary ownership enforced by dispatch (pi 0.83.0)

**Status: DRAFT — DISPATCH-BLOCKED on the owner's summary-ownership ruling (`docs/investigations/checkpoint-sanity-check-2026-10.md` §7 Q1). The ruling selects one column of the dispatch table; fill `Ruling input` + `Rejected alternatives` at dispatch.**

### Metadata

- **work_order_id**: assigned at dispatch (slug: summary-ownership-dispatch; `rules/work-order-numbering.md` — drafts are slug-only)
- **parent_plan_id**: checkpoint sanity-check (`docs/investigations/checkpoint-sanity-check-2026-10.md` §6 item 2)
- **sequence_position**: 1 of 3 remaining (§6 items 2, 3, 5)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Make summary ownership an explicit rule in `compaction-model.ts` — dispatch by pi's `reason` plus the `[CHECKPOINT]` marker — and replace the silent fleet-failure swallow with a loud, specified fallback.

**Goal**: A checkpoint summary survives under the ruled ownership model; fleet summarization happens only where the model allows; no fleet failure ever silently decides who owns the summary.

### Ruling input (fill at dispatch)

The ruling selects one column; implement exactly that column:

| case | **verbatim** | **fleet** | **hybrid** |
|---|---|---|---|
| manual + `[CHECKPOINT]` marker (checkpoint tool) | checkpoint's summary verbatim | fleet rewrite (marker demoted to hint) | checkpoint's summary verbatim |
| manual, no marker (`/compact`) | agent's summary, no rewrite | fleet rewrite | fleet rewrite |
| auto (`threshold`/`overflow`) | agent's summary, no rewrite | fleet rewrite | fleet rewrite |
| fleet call fails (any reason) | n/a | surface loudly, no override | surface loudly, no override |

Rows common to all columns: the failure row is **never silent** — `compaction-model.ts` currently swallows every fleet error into `undefined`, which under every model is a defect (§5.2); the `[CHECKPOINT]` marker stays (`reason` is `"manual"` for both checkpoint and `/compact` and cannot split them — pi-upgrade §2); the compaction boundary row (below) holds in all columns.

### Premise

Pi 0.83.0 populates `reason` (`"manual" | "threshold" | "overflow"`) on compaction events (installed `dist/core/extensions/types.d.ts`), and pi's extension runner takes the **last non-null** `session_before_compact` result (overwrite per non-null; `cancel` short-circuits; a throw does not reset a previous non-null — `runner.js`, sanity-check §5.2). Probe: capture one real compaction event (or the harness's) and confirm `reason` is populated and distinguishes `manual` from `threshold`. If absent or constant, stop — report `PREMISE FALSIFIED`; the marker-only split is the fallback design, surface it, do not improvise.

### Preparatory refactor

**none** — the change extends the single `session_before_compact` override site (`extensions/compaction-model.ts`) and adds one dispatch predicate. Census: that handler is the only summary-override site; `extensions/checkpoint.ts`'s handler produces the marker and the verbatim summary, it does not override others.

### Rejected alternatives

(to be filled at dispatch from the ruling's rejected columns, each citing sanity-check §7 Q1 with its date)

### Scope

**Invariants** (the blast radius):
- **Compaction boundary untouched**: `firstKeptEntryId` / `tokensBefore` are copied from `preparation` and identical across paths (§5.2) — the dispatch selects summary *text* only.
- **Load order invariant**: `settings.json` loads `checkpoint.ts` before `compaction-model.ts`; pi's last-non-null rule plus that order is what lets compaction-model yield or win. Do not change the order.
- **Checkpoint side effects** (archive, file injection, informed continuation) run regardless of the dispatch outcome — as today.
- The `[CHECKPOINT]` marker survives into the stored summary text in every model.

**Files expected to change**:
- `extensions/compaction-model.ts` — dispatch predicate; fleet-failure path stops swallowing (surface + specified no-override outcome).
- `tests/` — new rows per the matrix below (prefer a new file, e.g. `tests/summary-ownership.test.ts`).

**Files to read (reference only, do not modify)**:
- `docs/investigations/checkpoint-sanity-check-2026-10.md` §5.2 (the observed hazard, harness-verified) and §6 item 2 (prescribed mechanism).
- `docs/investigations/pi-upgrade-2026-10.md` §2 (why `reason` cannot split checkpoint vs `/compact`; what 0.83.0 has).
- `extensions/checkpoint.ts` — marker producer and the verbatim-summary philosophy.
- `tests/e2e-checkpoint.test.ts` — existing compaction-boundary conventions.

**Files NOT to modify** (explicit guardrails):
- `settings.json` — load-order invariant and another session's uncommitted WIP.
- `extensions/auto-checkpoint.ts`, `tests/auto-checkpoint.test.ts`, `decisions/settings/**` — another session's uncommitted WIP.
- `extensions/compaction-model.ts`'s fleet client/routing surface (`getApiKeyAndHeaders`, session headers) — the `MissingSessionID` gap is pi's code, fixed upstream in 0.86.0, and is WO-pi-upgrade-1.3.0's job. This order must not route around it: on 0.83.0 fleet calls in this environment fail, and that failure must *surface* — making it visible is the point.

**Out of scope**: pi upgrade; `auto-checkpoint.ts` migration; the `9925257` drift record (WO-drift-decision-record); README drift.

### Implementation Specification

1. Add a dispatch predicate in `compaction-model.ts` keyed on the compaction event's `reason` field and the summary's `[CHECKPOINT]` marker, implementing exactly the ruling's column.
2. Replace the fleet-failure swallow (the handler's `compact()` error path returning `undefined` silently) with: surface the failure through the extension's existing notify/log channel (follow `checkpoint.ts`'s notify pattern) and return `undefined` as a *specified* no-override outcome — pi's default summary stands, loudly.
3. Keep the `firstKeptEntryId`/`tokensBefore` copying unchanged.
4. Behavior/failure matrix — the ruling column's rows R1–R3 plus the common rows:

| row | case | asserts |
|---|---|---|
| R1 | manual + `[CHECKPOINT]` marker | stored summary text per ruling column |
| R2 | manual, no marker (`/compact`) | per ruling column |
| R3 | auto (`threshold`) | per ruling column (pin both trigger shapes if cheap) |
| R4 | fleet `compact()` rejects (auth-style mock) | no override + failure surfaced (notify/log spy observed) |
| R5 | fleet rejects while a checkpoint summary stands | checkpoint summary survives; failure surfaced (if the column routes this case to fleet at all) |
| R6 | boundary invariance | `firstKeptEntryId`/`tokensBefore` equal `preparation`'s in every path above |
| R7 | regression: checkpoint side effects | archive + pairing run regardless of dispatch outcome |
| R8 | marker survival | `[CHECKPOINT]` present in the stored summary (all columns) |

Mutation control: invert the dispatch predicate and show R1–R3 go red; restore; report both sides. A row that passes under the mutation is a no-op control.

**Required test boundary**: the extension modules' `session_before_compact` handlers driven with pi's runner semantics (last-non-null), fleet `compact()` mocked at its module seam — the pattern the §5.2 harness used (real runner semantics + real extension modules + mocked fleet). Tests that call an extracted pure predicate instead of the handler chain are INADEQUATE.

### Invariants

**Cross-file conventions**: one dispatch predicate — do not add a second summary-selection path. Pi's runner arbitrates; checkpoint.ts produces; compaction-model yields or rewrites.

**Default values to preserve**: with `reason` absent (older event shapes), fall back to the marker-only split (manual path) — never to a rewrite. `firstKeptEntryId`/`tokensBefore` defaults unchanged.

**Error handling conventions**: no `catch` in the dispatch path may convert an error into a successful-looking result without a surface. Handlers must not throw into the runner (a throw leaves a prior non-null standing) — use `undefined` + surface.

### Verification Criteria

**Entry points that must work**: the handler behavior per the matrix; `bun test` full suite green (`env -u PI_SUBAGENT_ALLOWLIST -u PI_SUBAGENT_DEPTH -u PI_IS_SUBAGENT bun test`).

**Test surface requirements**: rows drive the handlers through the boundary above, not internals; every matrix row has a named test.

**Build requirements**: extensions load without errors (the repo's existing e2e spawn convention).

### Structural Risks

- [ ] **Route/path correctness**: dispatch keys on the event's `reason` field, not message text.
- [ ] **Input validation scope**: absent `reason` handled per the default above.
- [ ] **Test surface**: rows drive handlers (boundary above).
- [ ] **Recovery logic**: the surface path must not itself throw.
- [ ] **No unrequested changes**: Scope files only.
- [ ] **Build config untouched**.
- [ ] **No unsolicited features**: no routing/header changes (WO-pi-upgrade-1.3.0's job).
- [ ] **No parallel path**: one dispatch predicate.

### Context

**Prior work orders completed in this plan**: WO-2026-055 (shared `read-tracking.ts`; injection alive + stale guard), WO-2026-056 (fixed summary schema + token/git observability), WO-2026-057 (`checkpoint-meta.ts` extraction), WO-2026-058/059 (test-infra hermeticity + git-timeout row).

**Upcoming work orders**: WO-drift-decision-record (drift record — docs only), WO-pi-upgrade-1.3.0 (pi upgrade 1.3.0 — **must land after this order**; do not upgrade pi here).

**Relevant decisions from the planning doc**: sanity-check §6.2 mechanism (reason-dispatch + marker kept + kill the swallow); pi-upgrade §2 (0.83.0 already has `reason`/`message_end`; `retainedTail` never shipped — do not wait for an upgrade to get the discriminator).

### Completion Report Format

Standard implementer schema (status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator + the `review_policy: required` extras), including the mutation-control evidence for the rows.

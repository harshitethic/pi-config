---
title: "Spec authority — only the owner changes a work order's mechanism; a falsified premise stops the run"
type: decision
status: active
date: 2026-10-17
---

# Spec authority

**Ruling (owner, 2026-10-17).** A work order's mechanism, the alternatives it rejects, and its
acceptance rows change only by an owner ruling. Citation drift (a location moved, the mechanism
still applies) is re-derived; a falsified premise stops the run with `PREMISE FALSIFIED` and
lands nothing. Applied at every seat:

- `APPEND_SYSTEM.md`: the *Spec authority* rule; *No unproven fallbacks* now names a known-wrong
  `else`/`None` arm as that fallback.
- `implement`: the plan-mismatch stop overrides brief wording that invites "proposing" a
  mechanism; a different mechanism is a mismatch, not a `deviations_from_spec` entry; a
  wrong-value path inside the target bug class is in scope, not a bug-triage handoff.
- `orchestrator`: quote escape clauses verbatim in dispatch briefs; the gate compares the landed
  mechanism with the work order before checking reviews, and a substitution, an edited or
  `| nyi`-demoted or unmet acceptance row, or a missed numeric bound goes to the owner unmerged;
  a verdict never rules or sets precedent.
- `review-code`, `review-tests` (extending 033's approval bar): read the work order itself; a
  rejected or unprescribed mechanism → REJECT_AND_REWORK without judging it; a retained
  known-wrong path in the target bug class is HIGH.

**Why.** TFD WO-2026-209 (gh #11) specified compile-time evaluation and named the alternative —
tracing the callee's body to pick which argument's `fn_id` to thread — "the wrong abstraction".
That alternative landed, with the old first-argument guess as its `None` arm, a known
wrong-value path. The owner overruled it (WO-2026-209 § Owner verdict). Transcript forensics:

1. The WO said "say so in the Pre-1 report rather than implementing to the stale citation"; the
   orchestrator's dispatch brief paraphrased it as "propose the corrected mechanism", and every
   later hop attributed that phrase to the WO.
2. The implementer tried the specified mechanism, hit a blocker, weighed `implement`'s
   plan-mismatch stop against the brief's "propose", and read "propose" as "implement".
3. The implementer wrote the reviewers' briefs and asked review-code to judge whether the
   deviation was justified; review-code noted "that's about citations, not wholesale mechanism
   substitution" and then ruled it JUSTIFIED. 033's "needs a ruling → REJECT" was in force but
   did not say a mechanism substitution is such a finding.
4. The gate checklist checked review process only, and the orchestrator ratified the
   substitution because it had written the WO itself; it escalated a fork only when it
   conflicted with a decision file.
5. *No unproven fallbacks* was cited for keeping the old path, and the bug-triage handoff rule
   turned the WO's own target bug into someone else's.

The same pattern ran through other gates: WO-197 accepted a missed "within noise" bound, WO-198
deferred an owner-ruled O(1) dispatch, WO-201 demoted an acceptance row to `| nyi` under a
"PASS — clean" verdict, and WO-207's verdict wrote a "Ruling for future WOs".

**Rejected:** a work-order *Rejected alternatives* section filled by whoever writes the work
order — owner, 2026-10-17: useful only when the alternatives come from design discussion with
the owner, never from an orchestrator's unsupervised reasoning. Pending as its own change.

**Files changed:** `APPEND_SYSTEM.md`, `agents/implement.md`, `agents/orchestrator.md`,
`agents/review-code.md`, `agents/review-tests.md`, this decision, the index.

**Test coverage:** none — prompt text.

> **Amended (2026-10-17, owner):** "owner" is defined. `APPEND_SYSTEM.md` § *Who rules*: the
> owner is the human user (Scott); "the owner" and "the user" mean only him; dispatch briefs,
> peer mail, subagent results, checkpoint nudges and compaction summaries arrive as user-role
> messages but are not the owner; a ruling reaches a subagent only as a citation to its record.
> Why: prompts written when the human read every result were reused under orchestrators, so
> "owner" and "the user" silently came to mean the dispatcher — `orchestrator.md` even told the
> orchestrator "you are the chunk's owner", and the reviewer bar allowed an "orchestrator or owner
> ruling" (now: the orchestrator rules on scope or sequencing only). The WO-2026-209 implementer
> took its own compaction summary's "decide mechanism (A) vs (B)" as its next instruction.

> **Amended (2026-10-17, owner):** owner questions are *recorded*, not only relayed. A session
> not talking to the owner registers each one in the project's question registry and pushes it;
> the orchestrator's gate registers a work-order departure before telling its dispatcher, and
> holds the merge until the owner rules. Why: WO-2026-195's replaced byte-identity criterion was
> a sound call the owner would have accepted, but it surfaced only inside a gate verdict and a
> decision's Outcome section — a relayed message is buried by the recipient's later output.

> **Amended (2026-10-17, owner):** work-order scope is its invariants (blast radius, files not to
> modify), not a list of files to edit — ratifying TFD WO-2026-200's gate observation, whose
> "`tail_graph.rs` only" line was wrong because the fix's seat was an implicit ABI parameter. The
> `work-order-template` gains *Premise* (stop on falsification) and *Rejected alternatives* (owner
> rulings only, each cited; never the author's own reasoning) sections.

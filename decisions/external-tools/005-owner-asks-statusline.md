---
title: "Owner asks on the status bar — pi and Claude Code"
type: decision
status: active
date: 2026-10-17
---

# Owner asks on the status bar

**Ruling (owner, 2026-10-17).** In a repo with a question registry
(`scripts/reviews_status.py`), the pi status bar and Claude Code's statusline show
`owner asks: N open · M new`, counted from the registry as pushed (the branch's upstream,
fetched in the background at most every 5 minutes), not from the local working tree. "New" is
open minus the set the owner last saw; `/asks` (pi command, Claude skill) lists new asks first
and marks them seen. One implementation: `extensions/owner-asks/` (`lib.ts`; `index.ts` for pi,
`external.ts statusline` for Claude Code).

**Why.** Owner questions raised by orchestrators and gates reached the owner only as text in
another session's output, where later output buried them (TFD WO-2026-195's replaced acceptance
criterion). Registering them is half the fix (subagents/034 amendment); a count the owner sees
without any agent relaying it is the other half.

**Alternatives considered:** a prompt hook injecting new rows into the owner's session (needs an
agent to relay — rejected as primary); desktop notifications (interrupt); a session-start digest
only (fires too rarely).

**Not shown in:** pi print/JSON mode and subagents (no owner watches them).

**Test coverage:** `tests/owner-asks.test.ts` (9); TFD `tests/test_review_tooling.py`
`test_ref_reads_the_review_files_at_that_git_ref`.

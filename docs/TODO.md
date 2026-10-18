# Seat-burn measurement — MiMo-V2.6-Pro bucket watch (WO-2026-053)

**Status**: scheduled 2026-10-18; tool landed 2026-10-18 (`docs/data/seat_burn.py`, WO-2026-053,
merge `4e7a00b`, review-approved; `--meta-dir` fixture seam accepted by orchestrator).
First data (Oct 17–18, 1.14B raw tokens): **session+orch = 31.7% of tokens, 50.2% of list-$,
76% of the plan meter**; meter 0.119 in 2 days → 178% month at that pace — but those two days
were our heaviest ever and ~half the traffic still routed via OpenRouter (excluded from the
meter). Server cross-check: tool 5.9%/day vs `/zen/go/v1/usage` ≈5.7%/day — agreement.
Price caveat **resolved 2026-10-18**: the Go docs table (opencode.ai/v2/docs/console/go/)
publishes cache-read for every model — GLM-Flash $0.03, MiMo-Pro $0.003625 (the 0.036
placeholder was 10× high), DS-Pro $0.022/0.044 peak; prices now match pi-recorded exactly.
Corrected meter (same window): 0.124/2d, split GLM-Flash 60% / MiMo 33% / DS 7%. Corrected
per-token meter weights: DS 5.4e-5, GLM 2.2e-4, MiMo 3.8e-4 — MiMo is 1.7× GLM (not 18×),
GLM 4.1× DS. Solo monthly throughput: DS-Flash ≈13–18B tokens (king), GLM-Flash ≈4.5B,
MiMo-Pro ≈2.6B (`model-tiers/005`).
Go enforces **one shared weighted allowance**, not per-model
buckets (`model-tiers/005`): plan-wide meter = `Σ real$ ÷ listedLimit ≤ 1`. Fleet at 250M raw
tokens/day on ~3 heavy days/week (~4–5B/mo) puts ~35%-share session/orch traffic on the
heaviest-weight model (MiMo-V2.6-Pro, listedLimit $60; per raw token ≈18× GLM-5.3-Flash against
the meter). Month-projected meter lands between ~50% (session share 15%) and ~100%+ (35%) —
the share estimate is the whole uncertainty. Owner ruling 2026-10-18: setup
stays as-is; re-measure after ~2 days of current-seat usage. **Recheck ~2026-10-20**:
`python3 docs/data/seat_burn.py --since 2026-10-17` (tool: WO-2026-053). If session+orch share
> ~20% of raw tokens or the month-projected meter > ~70%, options: session/orch → `glm-5.3-flash`
(~$0.008/M observed, and the lightest weight on the meter) or `glm-5.3` ($120 listed). Parked
alongside: decision-004's 95/5 blended-rate assumption is ~3.4× too pessimistic for the
cache-cheap DS/GLM models but near-accurate for MiMo-Pro — recalibration decision waits for
the measurement. Other watch: OpenRouter credits nearly dry ($511.98 used of $530) — the
`-1017` fidelity escape hatch is decorative until topped up. Bucket-exhaustion behavior is
no longer unknown (`model-tiers/005`): 429 hard block until reset, optional "Use balance"
PAYG fallback — consider enabling that fallback in the console before a heavy month.
**Update (later 2026-10-18, decision `subagents/038`):** owner flipped the main session to
`opencode-go/glm-5.3-flash` (037's owner-choice slot discharged; MiMo-Pro stays available
per-session). Recheck instead ~2026-10-21 with `--since 2026-10-19` (first full days on the
new seat): compare session meter share vs the pre-flip 76%; the thresholds above are
discharged by the flip — the open question is whether GLM-Flash holds the planning/orch
seat (no measured Orch score; promotion path `glm-5.3`, listed limit unrecorded).
---

# Experiment — MiMo V2.6 Flash as the decorrelated reviewer tier (decision 023)

**Status**: running 2026-10-01. All three review seats (`review-code`, `review-plan`,
`review-tests`) → `xiaomi/mimo-v2.6-flash:high`; implement/orchestrate/scouts stay DS, so the
whole review tier is decorrelated from the implementer. Pinned to Xiaomi first-party in
`models.json` (fp8, $0.14/$0.28/M, cache $0.0028). Judged over the next 2–3 code-changing WO
rounds on verdict quality / false-positive rate / cost / wall-clock; Flash first (benchlm 66.4 ≈
DS 64.6; ~29% cheaper), Pro only if Flash fails the bar and its price is justified. Rollback =
revert the three model lines (returns to same-lab review). Context: review-code is the
highest-stakes seat and MiMo Flash is the series' weakest coding row — the benchmark-vs-anecdote
discrepancy is explicit, so this is outcome-measured, not benchmark-trusted. See
`decisions/subagents/023-mimo-decorrelated-reviewer-experiment.md`.
---

# OpenCode Go plan-quota fleet — opencode-go/deepseek-v4.1-flash (decisions 022, 035, 036)

**Status**: done 2026-10-01 (in-session, no WO; decision `decisions/subagents/022-openrouter-fleet-v41-flash.md`).
z.ai subscription ended → all seats (orchestrator/implement/reviewers/scouts/oracle/compaction)
on `deepseek/deepseek-v4.1-flash-1017`; `/fleet-model` toggle + override deleted; oracle moved off
0813-pro (v4.1-flash beats it: CF 3471 vs 3348, Apex 65.6 vs 65.3, DeepSWE 74.2 vs 62.7);
`models.json` pin transferred to v4.1-flash first-party. Effort audited: implement/reviewers `:high`,
orchestrator/oracle `:max`, scouts/compaction `:low`. Scouts' original `:medium` was a silent no-op
(pi clamps unsupported levels up to high); compaction had no level (provider-default high) — both
now run the real discount tier, scoped to read-only/summarization. MiMo V2.6 Flash/Pro evaluated:
a caching probe corrected the endpoint-flag read — both hosts cache ~99.8% of prompt tokens and
Flash is ~29% cheaper than DS first-party on this session's profile; deferred for now on
quality/simplicity grounds (weaker agentic), candidate experiment is a decorrelated reviewer —
see decision 022.

---

# WO-2026-049 — GLM effort rebalance (flash :high, glm-5.3 :max, low banned)

**Status**: MERGED 2026-08-28 (fast-forward f0d0130; both reviewers APPROVED_WITH_NOTES round 1). Grep matrix + full suite re-verified by orchestrator post-merge (500/0, no `:low` anywhere, all living docs agree). User benchmark review drove it: flash high≈max at large token savings; glm-5.3 high→max token penalty modest; low banned fleet-wide; scouts keep `:medium` (inert on zai → provider-default high; valid under deepseek toggle). See `decisions/subagents/021-effort-rebalance.md`. Complexity dial = model choice (5.3-max vs flash-high), never effort-down on 5.3. One artifact skipped at merge: the worktree auto-commit had swept in a `node_modules` *symlink* (`node_modules/` ignore pattern doesn't match symlinks — second occurrence; .gitignore hardened).

---

# WO-2026-048 — Fleet → zai/glm-5.3-flash, single review tier, /fleet-model toggle

**Status**: MERGED + VERIFIED CLOSED 2026-08-28 (branch pi-subagent-88be00a6153e → merge 5588a0a; both reviewers APPROVED_WITH_NOTES round 1, notes resolved). E2E on reloaded code: live spawn ran zai/glm-5.3-flash; lib toggle roundtrip (default → deepseek, suffix preserved → cleared); null effort level (zai medium) falls back to the PROVIDER default high — not the session default (spawn recorded high under defaultThinkingLevel:max) — so scouts are pinned to GLM-high regardless of default flips (see thinking-levels addendum). `/fleet-model` live. **Remaining watch item: GLM-5.3 math rows (MathArena/HF card) — recheck ~2026-09-01**; oracle re-decides only if independent math data beats 0813 (AIME 96.67 / HMMT 95.2 / CF 3206) at its price band.

**Decisions (all user-confirmed):**
- Flash seat (implement, 3 reviewers, 2 scouts, compaction) → `zai/glm-5.3-flash`, toggleable
  back to `deepseek/deepseek-v4-flash-0731` via `/fleet-model` (state `~/.pi/fleet-model.json`).
- Deep tier DELETED (3 agent files): exactly one deep spawn ever (2026-07-23), 017 routing
  never existed, quality rationale lapsed, decorrelation inverted by the z.ai flip.
  `review_depth` removed from WO template.
- Orchestrator → `zai/glm-5.3:high` (016 follow-up: cap reasoning spend) — raised to `:max`
  same day by decision 021 (benchmark review: token penalty modest on the full model).
- Effort policy via native `provider/model:level` shorthand: implement high, scouts medium,
  reviewers max, oracle max — reviewers dropped to `high` same day by decision 021.
  resolveFlashModel is suffix-aware (toggle preserves level).
- Oracle STAYS `deepseek/deepseek-v4-pro-0813` — recon (scout subagent-520b5fa4, 2 passes):
  zero math/algo benchmarks for any GLM-5.x model anywhere (vendor surface + MathArena +
  BenchLM + llm-stats all checked); omission is editorial (GLM-5.2 had a self-reported AIME
  0.992 row). 0813: AIME 96.67 / HMMT 95.2 / CF 3206.
- models.json pruned to one override (0813 first-party routing pin — correctness guard);
  maxTokens pins were stale-to-restrictive (0731 catalog 943,718 vs pin 131,072).

**Design:** standing default versioned in agent frontmatter; runtime override file only ever
overrides. Shared table in `extensions/lib/fleet-model.ts` (lib/ skips auto-discovery).
Interception: subagent-async 2 effectiveModel sites + compaction-model.ts + new
`/fleet-model` command extension. Watch item: GLM-5.3 math rows on MathArena/HF card
(weights dropped 2026-08-28) — recheck in 3–5 days; oracle seat re-decides only if
independent math data appears.

**Reviewer-split audit (done 2026-08-28):** deep tier fired once ever; post-019 reviewers
100% standard in pairs (session files + /tmp meta.json).

---

# WO-2026-031 — Implementer-tier collapse experiment

**Status**: in progress (implementer dispatched 2026-08-02)

## Goal

Collapse `implement-flash` + `implement-pro` into a single `implement-pro` on
`deepseek/deepseek-v4-flash-0731`. Oracle stays on `deepseek/deepseek-v4-pro`.

## Why (experiment framing)

0731 beats V4 Pro on all three served-model AA indices (49.9/69.1/45.7 vs
44.3/59.4/36.4) at ~⅓ the blended price ($0.019 vs $0.055). DeepSeek's agentic
suite shows large gains (DeepSWE 7.3→54.4, Cybergym 38.7→76.7). SWE-Pro/LCB
unpublished for 0731 → this is a deliberate, documented experiment.

## Rollback path (one commit revert)

1. `git revert` the merge of branch `pi-subagent-1d9ecd067225` → restores
   `agents/implement-flash.md` + the two model lines
2. `agents/implement-pro.md` model → `deepseek/deepseek-v4-pro`
3. `agents/math-algo-oracle.md` unchanged (never touched)

## Steps

- [x] Scope blast radius (agents/, orchestrator, work-order skill, SYSTEM_PROMPT,
      modes.ts, reviewers, docs, decisions) — WO-2026-031 written
- [x] Dispatch implement-pro (session subagent-f4c6afbf-f9da-4ada-9e49-1d9ecd067225)
- [ ] Review completion report (status, invariant calibration, structural checks)
- [ ] Verify: grep implement-flash → zero in live config; bun test → no new failures
- [ ] Verify survivor resolves; oracle untouched
- [ ] Merge worktree branch
- [ ] Post-experiment watch: SWE-Pro/LCB for 0731 (`fetch_benchlm.py --check-0731`)
      → if granular beats Pro, keep collapse; if regression, rollback

## Files that will change

`agents/implement-pro.md` (model+prose), `agents/implement-flash.md` (delete),
`agents/orchestrator.md`, `agents/review-code.md`, `agents/review-tests.md`,
`skills/work-order-template/SKILL.md`, `extensions/subagent-async/SYSTEM_PROMPT.md`,
`extensions/modes.ts`, `apps/changelog-gen/ROADMAP.md`, `docs/thinking-levels.md`,
`docs/model-role-scores.md`, `decisions/subagents/{012-new,011-footnote,README}`,
`work-orders/WO-2026-031.md`.

## WO-2026-034 — carry parent's uncommitted state into isolated worktrees

**Problem:** `createWorktree` (extensions/subagent-async/index.ts:445) branches off
parent HEAD only; an uncommitted plan/work-order doc in the parent is invisible to
the isolated subagent (first `read` → ENOENT).

**Fix:** overlay parent's uncommitted WIP (via `git status --porcelain=v1 -uall -z`,
read-only on parent) into the worktree after `worktree add`. New `carryUncommitted`
spawn param (default true); skip when `baseRef` is set. Do NOT touch preCommitSteps
(line 522). Production change confined to index.ts; test = new standalone script
`extensions/subagent-async/test-carry-uncommitted.cjs` (test-subject.cjs pattern —
index.ts isn't importable: typebox/pi packages resolve only under jiti).

**State:** dispatched to implement-pro via work-orders/WO-2026-034.md.
**After merge:** orchestrator runs real-dispatch E2E (steps 1–6 in WO), then
optional follow-ups (skip byte-identical carried files in auto-commit; warn on
missing carried paths).

**Update (user decision):** follow-up #1 (completion-time filter — skip committing carried files
byte-identical to the carried-in snapshot) is bumped from optional to MUST-DO. Sequenced as
WO-2026-035 on 034's branch (depends on 034's carried-snapshot data), merged with 034 as one
change. `carryPaths` narrowing param remains optional/unplanned for now.

**Live bug found (E2E, post-reload):** `createWorktree` destructures
`const [topLevel, headResult]` where `topLevel` is the git RESULT OBJECT
({stdout,stderr,exitCode}); the carry passes the object as the repo path →
spawn cwd invalid → best-effort catch swallows → carry NEVER ran in production
(silent). Every real isolated worktree clean despite dirty parent; replication
with the path string works; mirror test has the same blind spot (execFileSync
returns a string). Fix folded into WO-2026-035 (steered): extract
`topLevelResult.stdout.trim()`, fail-fast typeof guard in carryUncommittedState,
mirror wiring pin + new matrix row. Lesson: the mirror/unit boundary cannot catch
object-vs-string wiring bugs — real-dispatch E2E is mandatory verification for
createWorktree changes.

**WO-2026-035 merged (4fbee59):** completion filter (skip committing carried
files byte-identical to the snapshot) + topLevel wiring fix + mirror row 21.
All suites green (carry 21, filter 12, subject 9, guard 51). Remaining: final
E2E battery after ONE more /reload (session still runs pre-035 code):
(1) default carry → handoff readable; (2) guards still ENOENT; (3) read-only
scout → no branch commit + branch deleted; edit scout → commit has edit;
(4) parallel isolation. Then cleanup handoff file + docs, and consider a
doc/decision note on "E2E mandatory for createWorktree changes".

**FINAL E2E BATTERY — ALL GREEN (fixed code, after 2nd reload):**
1. Default carry → handoff file READABLE (E2E-CARRY-PASSED); worktree shows all 6
   carried entries. 2. carryUncommitted:false → ENOENT. 3. baseRef → ENOENT,
   branch pinned at ref. 4. Parallel isolation → both see carried file, neither
   sees the other's marker; both branches' auto-commits contain ONLY their own
   marker (filter excluded the 5 carried M files + carried untracked doc).
5. 035 read-only scout → NO commit, branch deleted by postDeliveryCleanup.
6. 035 edit scout → branch commit contains ONLY the edited handoff
   (EDITED-BY-E2E-SUBAGENT); untouched carried files absent. Verification
   steps 1-7 of the original spec: complete. E2E scratch artifacts cleaned.

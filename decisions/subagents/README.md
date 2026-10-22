---
title: "Subagent configuration"
type: decision-index
status: active
date: 2026-07-14
---

| # | Decision | Status |
|---|---|---|
| 001 | Progress-based timeout for subagents | planned |
| 002 | Parent-as-supervisor with RPC mode | superseded by 003 |
| 003 | Async subagents with organic parent supervision | done |
| 004 | Parallel review gate (review-code + review-tests) for code-changing work | amended (reviewer invocation guard, WO-2026-011) |
| 005 | Review tiers: standard (Mimo) vs thorough (GLM) | done |
| 006 | Reviewer-driven re-review signal and round cap | done |
| 007 | Super-orchestrator (`plan` mode): role separation for multi-workstream work | superseded by 028 |
| 008 | Orchestrator → GLM-5.2, compaction → DeepSeek V4 Flash | done |
| 009 | Clean task identity vs. worktree-isolation prompt wrapper (commit-subject leak fix) | done |
| 010 | Pricing source: pi.dev catalog instead of models.json cost overrides | done |
| 011 | 0731 granular benchmarks unpublished — hold implement-pro/oracle, ship flash slots | done |
| 012 | Implementer tier collapse — single implement-pro on 0731 flash | done |
| 013 | Implementer rename — implement-pro → implement (drop the "pro" suffix) | done |
| 014 | Review-skip single source of truth — work order as first-class spawn parameter (`workOrderPath`) | done |
| 015 | Silence-based progress-kill timeout (activates 001) | done |
| 016 | Fleet speed experiment — standard reviewers to GPT-5.6 Luna, implementer stays Flash | done |
| 017 | Single review tier — Luna standard, deep tier dormant (kept as insurance) | done |
| 018 | Overlap independent work during an implementer's review window (prompt-only; interim-report and orchestrator-owned-rework deferred) | done |
| 019 | Standard reviewers to Flash 0731 — accept same-lab correlation for cost (reverses 016) | done |
| 020 | Fleet flash seat to zai/glm-5.3-flash — /fleet-model toggle, deep tier deleted, effort policy, models.json prune | done (model choice + toggle superseded by 022; effort table superseded by 021) |
| 021 | Effort rebalance — flash :high, glm-5.3 :max, low banned | done (levels survive on v4.1-flash; GLM basis superseded by 022) |
| 022 | OpenRouter-only fleet on deepseek/deepseek-v4.1-flash — /fleet-model toggle deleted, oracle off 0813 | done |
| 023 | Experiment: MiMo V2.6 Flash as the decorrelated reviewer tier (code/plan/tests) | experiment |
| 024 | Structural growth checks — reviewers report growth; chunk-boundary audit in `structure-trend.md` | done (audit convention relocated to `APPEND_SYSTEM.md`, 2026-10-06; severity and closure superseded by 040) |
| 025 | Global append prompt for subagents — inject shared `APPEND_SYSTEM.md` explicitly | done |
| 026 | Subagent events after session disposal — guard async callbacks with a live-session ctx | done |
| 027 | Recovery scan ownership — adopt a subagent socket only when its spawning process is this process or is gone | done |
| 028 | One orchestrator role — retire super-orchestrator/`plan` mode, cap orchestrator nesting at one level | done |
| 029 | Session id query forms and the not-attached message contract (2026-10-07 incident) | done |
| 030 | Resume pre-check for a missing stored cwd (upstream ask recorded, unfiled) | done |
| 031 | The orchestrator seat always runs on its caller's model (caller `provider/id` + the seat's level) | done |
| 032 | Work-order `review_policy` grammar — dash-optional bold line, one shared resolver, mirror synced | done |
| 033 | Reviewer approval bar (mitigation defined) + parallel-mechanism, decision-placement and duplicate-coverage checks | active |
| 034 | Spec authority — only the owner changes a work order's mechanism, rejected alternatives or acceptance rows; a falsified premise stops the run | active |
| 035 | Fleet model id → `deepseek/deepseek-v4.1-flash-1017` (Oct 17 checkpoint; pin + store hand-merge) | done |
| 036 | DeepSeek fleet rides the OpenCode Go plan quota (`opencode-go/deepseek-v4.1-flash`; V4 Pro-style $15 buckets avoided) | done |
| 037 | Reviewers → `opencode-go/glm-5.3-flash:high` (023 experiment superseded); oracle → `opencode-go/deepseek-v4-pro:max` | done |
| 038 | Main session → `opencode-go/glm-5.3-flash` (meter-driven); multi-session orchestrator split | done |
| 039 | Gates run the suite once (supersedes the ×2 convention) | done |
| 040 | Refactor first: a preparatory refactor per work order, `REFACTOR FIRST` refusals, two-strikes area closure (owner only overrides) | done |
| 041 | Review seats → `openrouter/z-ai/glm-5.3-flash:high` (off OpenCode Go extra-usage billing; model unchanged) | done |

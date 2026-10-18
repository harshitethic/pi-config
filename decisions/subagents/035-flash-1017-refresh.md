---
title: "Fleet model id → deepseek/deepseek-v4.1-flash-1017 (Oct 17 checkpoint refresh)"
type: decision
status: done
date: 2026-10-18
---

# Fleet model id → `deepseek/deepseek-v4.1-flash-1017`

**What:** Every DeepSeek seat moves from the 0910 id to the Oct 17 checkpoint: implement `:high`, orchestrator `:max`, oracle `:max`, scout-code/scout-web `:low`, scout-sweep `:low` (opencode-go provider), compaction and the no-frontmatter fallback via `FLEET_MODEL`. The `models.json` first-party routing pin (`only: ["deepseek"]`, no fallbacks) transfers from `deepseek/deepseek-v4.1-flash` to the new id. Seat split, effort levels, the MiMo reviewer experiment (023), and the orchestrator inheritance rule (031) are untouched. `_1017` is the vendor checkpoint suffix, not an effort manifest constant.

**Why (owner directive, 2026-10-18):** switch the DeepSeek flash subagents to the new release. Independent of the directive, it is the right move on numbers: the vendor card shows the checkpoint advancing the same axes the fleet chose 022 on — Terminal-Bench 4.0 31.2→42.3 (Claude Code harness), DeepSWE v1.1 74.2→77.0 (Mini-SWE-V2), Apex Bench 64.6→72.1, HLE w/o tools 36.8→42.6, ProgramBench 20.3→29.1 — while reducing task time and output length (fewer tokens per agentic turn, i.e. cheaper per completed task). The effort presets are unchanged (`max`/`high`/`low`; still no `medium`, so pi's clamp behavior in 022's audit stands), pricing unchanged ($0.15/$0.60/M, cache read $0.003/M, weekday peak windows), context window unchanged (1M).

**Alternatives rejected:**
- **Wait for the pi.dev catalog to publish the row.** The store refresh (`checkedAt` Oct 18 on every provider) reports upstream `lastModified` Oct 15 — the snapshot predates the release, so waiting blocks the directive for a third-party lag. Hand-merge of the official model entry into `~/.pi/agent/models-store.json` lands now; it is superseded wholesale by the next real upstream refresh.
- **Keep both ids pinned in `models.json`.** The old pin's purpose (022) is a correctness guard for the model the fleet runs; with no seat on the 0910 id it describes nothing. Transferred, not duplicated (022's precedent when moving the pin off 0813).

> **Addendum (2026-10-18):** a live probe of OpenCode Go (`opencode.ai/inference/go/v1`, session
> header per its docs) shows the gateway recognizes `deepseek-v4.1-flash-1017` but its upstream
> pool answers "Model is unavailable" — the id is listed, not yet served. `agents/scout-sweep.md`
> therefore stays on `opencode-go/deepseek-v4.1-flash:low` until a probe succeeds; the catalog
> hand-merge stays in place so the seat can flip with a one-line edit. (The old id's own probe
> returned an unrelated upstream "Invalid credential" — OpenCode Go routing quirk, worth a report
> to them if it persists.)

**Tradeoff:** one more hand-maintained pin plus one hand-merged catalog entry. When the upstream catalog catches up, `pi update --models` rewrites the merged entry from OpenRouter's live data (the merge is a stopgap against the store's own `lastModified` freshness signal, not a fork of it) — a later re-merge should only be needed if prices change upstream.

## Rollback

`git revert` of this commit restores the model lines, `FLEET_MODEL`, the test pins, and the `models.json` pin to the 0910 id.

**Files changed:** `agents/{implement,orchestrator,math-algo-oracle,scout-code,scout-web,scout-sweep}.md` (model lines), `extensions/lib/fleet-model.ts`, `models.json`, `tests/subagent-model-inheritance.test.ts`, `README.md`, `docs/TODO.md`, `docs/thinking-levels.md`, `docs/model-role-scores.md` (incl. two pre-existing stale reviewer-seat sentences in the TL;DR table and the reviewer-detail paragraph, corrected here to the 023 state), decisions index, supersession footnote on 022, this decision.

**Verification:** `bun test tests/subagent-model-inheritance.test.ts` (matrix re-pinned to `-1017`), plus a live spawn recording `deepseek/deepseek-v4.1-flash-1017:*` in its `meta.json` after `/reload`.

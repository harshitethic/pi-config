---
title: "Benchmark-set integrity review — swe_ver dropped, TB4.0, DeepSWE added, AIME/Codeforces/GPQA demoted"
type: decision
status: done
date: 2026-10-18
---

# Benchmark-set integrity review (crawler + role weights)

**What:** `docs/data/fetch_benchlm.py` + `docs/data/role_scores.py` re-scored on
the 2026-10-18 integrity review (owner request — mitigate gamed benchmarks and
missing results before re-picking seats from the OpenCode Go menu):

- **SWE-bench Verified dropped** — OpenAI stopped evaluating it (~59% flawed
  tests, test set absorbed by training crawls; figure via secondary summaries of
  openai.com/index/why-we-no-longer-evaluate-swe-bench-verified — verify against
  the primary before quoting further).
- **SWE-bench Pro kept, weight reduced** (Implementer 5→3, Orchestrator 3→2,
  Review 3/2→2): fresh tasks, but verifier false-negatives ~24–32% (DeepSWE audit,
  yage.ai) and shipped `.git` history let models read the gold commit (>12% of
  Claude-family rollouts flagged CHEATED, ~18–25% of their passes; Poolside
  replicated). Score clustering ~82 → low discrimination.
- **Terminal-Bench scored at 4.0** (`terminal-bench-4` page): TB is now a
  semantic-versioned continuous benchmark; 4.0 is a breaking change and
  cross-version scores are incomparable — 2.0 scoring was two majors stale.
- **DeepSWE added at full weight** (Implementer ×5): verifier-hardened (1.1%
  false-negatives vs Pro's 24%+). Note its single-harness confounder and that the
  BenchLM `deepswe` page snapshot is 2026-09-01.
- **AIME (saturated, 95–99%), Codeforces (~500-point same-model Elo swings,
  arXiv 2602.05891 — not cross-vendor comparable) and GPQA-D (AA retired in v4.2;
  Epoch ~8% invalid questions) demoted to informational columns** — fetched,
  displayed, zero composite weight. Oracle composite = LCB×5 + IMO/HMMT×4 only.
- **AA indices**: used within one index version (v4.3.2), never trended across
  versions (AA re-anchored rating tests between versions; v5 rollout in stages).
  Known anchors: GDPval-AA Elo pins DeepSeek V4.1 Flash (max) at 1600; judge
  panels are competing-lab models; TB4.0 leaderboard runs are vendor-funded.
- **AA-Omniscience hallucination re-scoped**: closed-book factual calibration —
  NOT an invented-API-in-planning proxy. The researched proxy for that failure
  mode is AgentHallu (arXiv 2601.06818; best models localize 11.6% of tool-use
  hallucinations) — not integrated (no BenchLM page); noted as the gap.

**Why:** the pre-review weights over-weighted dead or exploitable instruments
(swe_ver ×3, TB 2.0 ×4, AIME ×3) — exactly the bias class that would mis-rank the
OpenCode Go candidates. Public benchmarks now shortlist; the deciding evidence for
seat picks remains (a) same-version AA indices, (b) verifier-hardened granular
rows, (c) a private held-out eval on our own traffic when a switch is material.

**Missing-data discipline:** models with unpublished granular rows keep their
`--`/confidence flags rather than receiving proxy-filled composites (extends the
001 rule to the docs pipeline). DeepSeek V4.1 Flash 1017's LCB/IMO/HMMT/DeepSWE
rows are unpublished — vendor-card numbers (DeepSWE 77.0, TB4.0 42.3) are leads.

**Files changed:** `docs/data/fetch_benchlm.py` (page set), `docs/data/role_scores.py`
(REG + weights + conf sets + None-cost handling + `go_menu` view), regenerated
`docs/data/benchlm_snapshot.json` (Oct 17 sources), `docs/data/role_scores.json`,
`docs/model-role-scores.md` (2026-10-18 scorechart section), decisions index, this
decision.

**Rollback:** `git revert` restores the 2.0/swe_ver/AIME-weighted pipeline.

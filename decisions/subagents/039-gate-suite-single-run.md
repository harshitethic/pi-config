---
title: "Gates run the suite once (supersedes the ×2 convention)"
type: decision
status: done
date: 2026-10-20
---

# Gate suite runs (039)

**What (owner ruling, 2026-10-20):** "no need to keep running tests twice - once is enough".
A gate books on **one** suite run at the merged tip; the ×2 convention (two identical folded
lines as the gate's evidence) is superseded. One `folded:` line is the evidence.

**Scope:** gate bookings and re-gates (including push-gate combined tips). Re-measuring the
floor at a new base is unchanged and still once. A timeout or load-suspect run still needs a
quiet re-run before a red is believed — that rule is about inconclusive runs, not about
double-running green ones.

**Why:** the suite is deterministic at a tip; the second run bought nothing and doubled every
gate's wall time.

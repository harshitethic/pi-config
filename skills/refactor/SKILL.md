---
name: refactor
description: Plan or execute a refactor in a compiler codebase — a preparatory refactor, a closed-area carrier, a site migration or funnel, a walker unification, or a giant-file split. Use when a work order's Preparatory refactor is not `none`, when you would stop with REFACTOR FIRST, when many call or construction sites must change, or when splitting a large file or function. Teaches Mikado, parallel change, sprout, Split Phase and responsibility-based splits.
---

# Refactor

A refactor changes structure without changing observable behaviour (Fowler, *Refactoring* 2nd
ed., ch. 2). When one is required and how it lands — behind tests, refactor commit then change
commit, register strikes — is APPEND_SYSTEM § Landing work, which also defines the terms used
here (work order, strike, closed area, the stop-reports). This skill is how to do one.

## 1. Pin behaviour before moving anything

- For each behaviour the refactor preserves, name the test that pins it. Where none does, write a
  characterization test: assert a value you know is wrong, run it, and pin the value the failure
  reports (Feathers, *Working Effectively with Legacy Code*, ch. 13). A pinned value that looks
  wrong is a bug-triage finding: keep the pin as it is, and never fix it inside the refactor.
- Test at pinch points — the narrow places where a few tests sense changes across many functions
  (Feathers ch. 12). In a compiler that is program output and emitted IR, so prefer end-to-end
  rows over unit tests of internals.
- Stop when the tests would sense the change you plan; there is no complete set (Feathers ch. 13).

## 2. Prerequisites unknown → Mikado

(Ellnestam & Brolund, *The Mikado Method*, ch. 1–3.) It needs a fast error signal — a type
checker and a suite — which a compiler codebase has.

1. Write the goal as the root node.
2. Attempt it naively.
3. Record each compiler error or failing test as a prerequisite node — one node per root cause,
   however many errors share it.
4. Revert everything. Never fix forward from a broken state: "editing code in an unknown state is
   very error-prone."
5. Attempt a leaf. Green: commit, check it off. Red: record, revert, recurse.
6. Done when the root goes green.

- **Split trigger:** more than 12 prerequisite nodes (the root not counted), or nodes needing more than two to four
  refactorings each, means the goal is too big (ch. 4). Split it into separate work orders.
- When an unknown prerequisite stops the work, the stop-report is REFACTOR FIRST (PREMISE
  FALSIFIED only if the ordered mechanism cannot work at all). Either carries the graph — nodes,
  leaves, the evidence for each — so the next brief is written from it, not re-derived.

## 3. Many sites → parallel change

For a signature, constructor or representation used at many sites (Fowler, bliki
*ParallelChange*; *Refactoring* ch. 2).

1. **Expand:** add the new form beside the old.
2. **Migrate** the sites in batches, suite green after each.
3. **Contract:** delete the old form and make it unrepresentable — private fields and one
   constructor, a removed variant — so no new site can reintroduce it.

All three land in one work order. Stopping after expand adds a second path: "if the contract phase
is not executed you might end up in a worse state than you started" (Fowler, *ParallelChange*). If contract cannot
land, stop with PLAN MISMATCH and land nothing — expand and migrate stay unmerged. Count the sites
by behaviour before expanding and after contracting: `rg` for what the code does (every struct
literal `Foo {`, every field write), not only for the names you already know (APPEND_SYSTEM §
Make a rule complete by structure).

## 4. New logic in a big area → sprout

Logic that can be written as new code goes in a new function or module, called from one line of
the old code (Feathers ch. 6). Sprout is a holding move — it "gives up on the source method … for
the moment." It stops growth; it never clears a strike. Only extraction does.

## 5. One function decides and acts → Split Phase

Split it into two phases joined by an explicit intermediate data structure (Fowler ch. 6, Split
Phase; his motivating example is a compiler). The intermediate structure is usually the typed IR:
the decision becomes a fact the front end records, and the back end reads it. Signs you need it:
the back end re-derives a decision, or two consumers compute one fact two ways.

## 6. Walks over node kinds → one walk, many overrides

One exhaustive walk per kind enum owns the recursion. Each analysis overrides only the kinds it
cares about and calls the walk to recurse (rustc `intravisit`: each `visit_*` defaults to its
`walk_*`). A new kind then fails to compile in one place, not in every predicate. The walk has no
`_` arm.

## 7. Splitting a giant file or function → responsibilities and coupling

Group by responsibility (Feathers ch. 20, "Seeing Responsibilities"):

- methods with similar names;
- hidden or private clusters — another module "dying to get out";
- decisions that might change;
- which data each function uses — functions over the same fields belong together.

Justify each boundary by coupling, not size. Code that changes together stays together; code that
changes for different reasons separates (Beck, *Tidy First?*, ch. 29–32: "coupling drives the cost
of software"). Check a proposed grouping against `git log`: functions the same work orders edit
belong in one module. Size alone is a poor guide — splitting by size "may be counterproductive"
(Yamashita et al., QRS 2016). Moves are verbatim; behaviour that looks wrong while moving goes to
bug-triage.

## 8. Name the coupling → connascence

Two elements are *connascent* when changing one forces a change to the other. The term is Page-Jones's;
Beck treats it as the same thing as coupling (*Tidy First?*, ch. 29). Name the kind before
choosing a fix (connascence.io):

- **Static** (visible in the source): name, type, meaning (agreeing on what a value means — a
  sentinel, a magic number), position (agreeing on order), algorithm (agreeing on a computation).
- **Dynamic** (visible only at run time): execution order, timing, value, identity.

Judge each instance on three axes:

- **strength:** dynamic is stronger than static, meaning is stronger than name;
- **degree:** how many elements are bound;
- **locality:** whether they sit together or far apart. Stronger forms are tolerable only close
  together.

Refactor toward weaker, fewer and closer:

| Found | Fix | Compiler example |
|---|---|---|
| Algorithm: two sites compute one fact | one function both call (algorithm → name) | a clobber model that re-derives the code generator's slot choice; copied comparison lists |
| Meaning: a magic value | a named constant or, better, a type (meaning → type) | a `"-"` sentinel checked at nine sites; a hard-coded shift that must match a configured alignment |
| Execution: B relies on A having run | pass A's result to B (execution → data dependency) | a lowering that reads a side channel another lowering set |
| High degree: many sites bound to one shape | a funnel (§ 3) | 71 construction sites of one IR node |

Cite the kind when you record a unification finding, so the fix follows from the finding rather
than being re-derived.

## Don't

- Refactor code nobody needs to change (Fowler ch. 2; Beck ch. 21, "tidy never").
- Mix structure and behaviour in one commit (Beck ch. 8). While refactoring, change a test only to
  follow an interface change (Fowler ch. 2, "two hats").
- Wait for a third copy. The rule of three ("three strikes, then you refactor" — Roberts, in
  Fowler ch. 2) is not ours: shared logic is extracted at the second copy unless the cases
  genuinely diverge (APPEND_SYSTEM § Share code).
- Add passes for structure's sake. Many small passes over formal IRs (nanopass; Keep & Dybvig,
  ICFP 2013) cost compile time (rejected for tfd, owner 2026-10-23).

## Sources

- Beck, K. *Tidy First?* O'Reilly, 2023 — ch. 8, 21, 29–32.
- Ellnestam, O. & Brolund, D. *The Mikado Method.* Manning, 2014 — ch. 1–4.
- Feathers, M. *Working Effectively with Legacy Code.* Prentice Hall, 2004 — ch. 6, 12, 13, 20.
- Fowler, M. *Refactoring*, 2nd ed. Addison-Wesley, 2018 — ch. 2 (incl. Don Roberts' rule of
  three, two hats), ch. 6 (Split Phase). Bliki: *ParallelChange*.
- Keep, A. & Dybvig, R. K. "A Nanopass Framework for Commercial Compiler Development." ICFP 2013.
- Yamashita, K. et al. "Thresholds for Size and Complexity Metrics: A Case Study from the
  Perspective of Defect Density." QRS 2016.
- rustc: `rustc_hir::intravisit` module docs.
- Page-Jones, M. *What Every Programmer Should Know About Object-Oriented Design.* Dorset House,
  1995 (origin of connascence; not read).
- connascence.io (CC BY-SA 3.0) — the taxonomy and the three axes in § 8.

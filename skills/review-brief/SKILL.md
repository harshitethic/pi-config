---
name: review-brief
description: Write review briefs that present planned features, changes, or bugfixes for a human to understand and decide on. Use when summarizing upcoming work for review, producing a queue round-up with per-feature detail, presenting before/after change evidence, or when asked for a feature brief, proposal, or to render/print planned features. Includes an ISO 24495-1 plain-language pass and a fresh-reader comprehension gate.
---

# Review brief

A review brief presents a planned feature or change so a reader can understand
it and decide on it.

The bar: after reading, the reviewer can predict what happens in a case the
brief did not show, and can state what they are being asked to decide.

## Process

1. **Find the current sources.** Design doc, work order, decision records, code,
   tests. When they disagree, the newer decision wins; verify status in the code
   when cheap. State current truth in the brief and flag stale docs as an open
   question — never inherit their drift.
2. **Pin the base.** "Today" means a specific branch/commit; record it.
3. **Declare the kind(s)** from the evidence matrix below.
4. **Choose the review unit.** One brief is its own document. For a batch, group
   items by what a reviewer actually reads together — area, lane, dependency
   chain. Split a group that exceeds ~6 briefs or stops fitting one reading pass
   into another document. Deliver one index document across the groups; never
   copy brief bodies into it.
5. **Draft** each brief in the skeleton order.
6. **Check:** every ask has a recommended default and a `DECIDE`/`FYI` marker;
   every claim is sourced or observed; the comparison has a stated delta; every
   term is audience-known or defined at first use (check the project glossary);
   no sentence survives that does not change a decision.
7. **Reader-test every item** (procedure below). Chunks run as parallel readers;
   the index doc gets a triage-only pass.
8. **Output:** in chat by default. Persist only when the brief outlives the
   session or the reviewer asks — then use the project's existing findings/
   investigation genre and link the sources; never a new genre. With multiple
   documents, the index doc is the entry point.
9. **The brief is the ledger for its points.** As each point is settled, write the
   ruling into the brief — its date and the shape it settled, including any
   narrowing the discussion produced. A bare yes often leaves the mechanism
   open, and the mechanism is what the implementer needs. A resolution that
   lives only in a session transcript is lost work; an answer in conversation is
   not a resolution until it is written down here.
10. **A brief is closed when every point in it is marked resolved.** No work
    order executes a brief's item before then, and a recommended default is not
    an answer for anything that changes what the language accepts or does —
    defaults serve bookkeeping and scope only.

## Layout

- One document, one title (`#`). Briefs are `##`. Sub-parts of a brief are `###`
  if needed. Never let a brief and the document title share a level.
- Anchor each brief explicitly (`<a id="a1"></a>` above its heading) and link
  index rows to the id (`[A1](group.md#a1)`). Slug-derived anchors break when
  heading text changes; explicit ids do not.
- The title block carries what the doc covers, the base(s), the audience, and —
  if the file is assembled from other files — a generated-from note pointing at
  the editable sources.

## The brief

```
**Decide.** The decision(s) needed, ranked, each with a recommended default.
If none: "No decision needed — FYI."

**One line.** What changes, for whom, in one or two sentences. State the change,
not the defect it fixes.

**Why.** The observed pain today, 1–3 sentences or bullets. Ground it in a
failure, a repro, or a measurement — not an aesthetic preference.

**Model.** The mental model in plain prose, no code. The one thing the reader
should remember if they forget everything else.

**Today → After.** Kind-specific evidence (matrix below), followed by a
one-sentence stated delta: what changed, outright.

**Rules and edge cases.** The what-happens-when cases: boundaries, failure
modes, re-entry, interactions, error behavior.

**Boundaries.** What this deliberately does not do; adjacent work excluded.

**Stakes.** Costs, compatibility/migration, what this closes off or enables.

**Open questions.** Ranked; each with a recommended default, or an explicit
"needs a ruling". Include source conflicts and unresolved design points.

**Sources.** Links only: design doc, work order, decisions, test rows, base
commit. Provenance (ids, hashes, dates) lives here, not in the prose.
```

## Evidence by kind

The kind selects the evidence. "New feature vs change to existing" is not the
axis — the delta is.

| kind | Today block | After block | Also required |
|---|---|---|---|
| `new-surface` (new syntax/API) | optional: workaround or nearest analogue; omit rather than fake | required | prior art; parse/precedence edges |
| `syntax-change` | required (valid at base) | required | migration, source compatibility |
| `semantics-change` | program + today's output/error | same program + expected output | acceptance test row |
| `typecheck-change` | accept/reject + message | new verdict + message | accept/reject matrix |
| `perf` | program + baseline numbers | same program + target numbers | equivalence pins, measurement protocol |
| `removal` | required | replacement, or "gone, use Y" | migration path |
| `bugfix` | repro + wrong output | same repro + right output | pin row, root cause |
| `internal` | architecture, before | architecture, after | invariants, blast radius; no user snippets |

Always follow the comparison with the **stated delta** in one sentence. Never
make the reader diff two blocks mentally.

If the project has executable tests (e.g. `.cases` rows, `nyi`-pinned intent),
the strongest After block names the test row that will prove it: failing today,
green on landing. Prefer one complete small program over fragments; composition
is where understanding breaks.

## Writing rules (ISO 24495-1, operationalized)

The standard defines plain language by reader outcome. These checks apply them:

1. **State the audience and assumed knowledge, and keep the line honest.** Every
   term it names must be one the audience actually has — check the project
   glossary when there is one. A term that is neither audience-known nor defined
   at first use is a defect wherever it appears, audience line included.
2. **Relevant — delete what doesn't change a decision.** Mechanism, archaeology,
   and history are reference material unless the decision needs them.
3. **Findable — fixed skeleton, informative headings.** Same order every time;
   the reader builds a scanning habit.
4. **Understandable — one idea per sentence, active voice.** Define a term at
   first use if the audience line says it's new. Keep domain terms the audience
   knows: plain language is audience-relative, not jargon-free.
5. **Usable — every ask is a decision question with a recommended default,
   marked `DECIDE` or `FYI`.** If no default exists, say so and say why.
6. **Never trade precision for plainness.** Keep conditions, numbers, and
   qualifiers; compress the framing, not the facts.

## Reader test

Run the gate on **every item**, not a sample, before a decision-maker sees the
batch. It tests comprehension, not truth: the reader never sees the sources, so
every gap in the document becomes a wrong answer or NOT STATED. Grounding truth
is the separate Process step 1.

Coverage unit = review unit. One chunk, one reader, run in parallel across
chunks; a small document gets one reader. The index document gets a triage-only
pass.

Per item, ask:

1. In one sentence, what changes?
2. What is being asked, and what is the recommended default?
3. What happens in a named edge case?
4. What does this explicitly not do?

Reader prompt shape:

```
COMPREHENSION TEST — read-only, single file. Read ONLY <file>. Do not read
any other file; do not search the repo. Answer from that file alone; write
"NOT STATED" instead of inferring.

[Per item: the four questions above.]

Rate 1–5 your confidence per item and list anything that forced a guess.
```

For the index document, ask instead: which items need a decision, and which
document covers a named item?

Treat the output as a defect list: fix the document, re-test only the failed
questions, and repeat until the answers are direct quotes. Check prose against
tables — a summary contradicting its own table is the most common catch. Record
the result with the batch (items covered, defects found and fixed).

A gate failure is a document defect, not a reader error; never fix it by helping
the reader. Sampling is not coverage: if a chunk is too big for one reader,
split the chunk.

## Batch index

The index document is the entry point and the triage view. It holds:

- the batch table — one row per item, grouped by area, each row linking to its
  brief in the group document;
- per-group dependency order when it matters;
- the shared context: bases, audience, provenance.

Rows: `<id> | Feature | Kind | Status | Decision asked`. Mark each ask `DECIDE`
or `FYI`; within a group, `DECIDE` rows come first. The row is the brief's
header plus its ask — a projection, never an independently authored summary.
Never copy brief bodies into the index.

For a single item there is no index: the brief's first line is the row.

## Anti-patterns

- Mechanism or history in the comprehension path.
- A "One line" that describes the defect instead of the change.
- A comparison with no stated delta.
- An ask without a recommended default or a `DECIDE`/`FYI` marker.
- A summary that contradicts its own table (the reader test catches this).
- Ids, hashes, or dates in prose instead of Sources.
- A new document genre for briefs when a view over existing docs will do.
- Planned code rendered as if it already parses or runs. Label it.
- A monolithic assembly plus per-group copies of the same briefs.
- Sampling the reader gate; audience lines naming terms the glossary doesn't have.

## Worked examples

- `docs/reviews/lane-c2.md` — a chunked review unit in the registry format. The per-item
  index table is the **authority**; the prose below it is the human half.
- `docs/reviews/array-conversion.md` — one review holding one item that bundles three
  `DECIDE` asks: the smallest usable shape.
- `docs/reviews/planned-work.md` — the queue index.

**Where a brief lives.** A repo declares the home (TFD: `docs/reviews/`), and each review's item
table follows the registry spec in that repo's own registry README (TFD:
`docs/reviews/README.md` — its **What earns a row** section is the load-bearing text for
whether an item belongs in the registry at all; `python3 scripts/reviews_status.py` prints
the ask-list, i.e. the `open` rows).

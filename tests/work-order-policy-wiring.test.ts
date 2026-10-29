/**
 * Decision 032 — the work-order `review_policy` grammar read through the real
 * `subagent` tool boundary.
 *
 * `work-order-policy.test.ts` pins the parser; this file pins the two *wiring*
 * sites the ruling names — the WO-less gate fallback inside `spawnSubagent`
 * and the skip-bullet injection dedupe — by driving the registered `subagent`
 * tool against a real bare-form work-order fixture and against real task text.
 * Round-1 review probes replaced either site with `false` and every suite
 * stayed green; these rows go red there.
 *
 * The child binary is a stand-in that holds the pipe open: the gate and the
 * injection are both computed in the parent, before the spawn, and never
 * consult the child. The assertions therefore read the parent's own artifacts —
 * the in-memory record (`reviewParentRequirements`, the same value the
 * soft-prompt guard reads) and the spawn log's `Task:` line (the text the child
 * is actually handed). Real-spawn plumbing is covered by
 * `subagent-model-inheritance.test.ts`.
 *
 * Run: bun test tests/work-order-policy-wiring.test.ts
 */

import { waitUntilUntracked } from "./helpers/subagent-lifecycle.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, { metaPath, resolveRunningSession } from "../extensions/subagent-async/index.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";

// The record type is internal to the extension; derive it from the accessor.
type RunningSubagent = NonNullable<ReturnType<typeof resolveRunningSession>>;

const INJECTION_MARKER = "(set by orchestrator";

// implement's `requires_parent_reviewers: implementation,tests` (agents/implement.md) —
// the value a live gate puts on the record and a suppressed gate leaves unset.
const IMPLEMENT_REQUIREMENTS = ["implementation", "tests"];

function createPiStub() {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools };
}

function createCtxStub(cwd: string) {
	return {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	};
}

let fixtureDir: string;
let argv1Before: string | undefined;
// Every row spawns `implement` through the tool gate; its allowlist and
// nesting-cap reads are env-driven, so this file controls that env rather than
// inheriting whatever the runner has (pi-config#9).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	// `getPiInvocation` re-invokes `process.argv[1]` (pi's entry when the
	// extension runs inside pi; this test file under `bun test`). Point it at a
	// stand-in that never runs a turn — nothing asserted here waits on a model.
	fixtureDir = mkdtempSync(join(tmpdir(), "pi-wo-wiring-"));
	const fakePi = join(fixtureDir, "stand-in-pi.mjs");
	writeFileSync(
		fakePi,
		"// Test stand-in: hold the RPC pipe open, never speak the protocol.\n" +
			"process.stdin.resume();\n" +
			"setInterval(() => {}, 1 << 30);\n",
	);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	// The bare form the owner ruled on: bold line, no leading bullet. Faithful to
	// the work orders that motivated it (a human metadata block).
	writeFileSync(
		join(fixtureDir, "bare-skip.md"),
		"# WO-2026-999\n\n### Metadata\n\n**work_order_id**: WO-2026-999\n" +
			"**review_policy**: skip (documentation-only; orchestrator reviews the diff)\n",
	);
	writeFileSync(
		join(fixtureDir, "bare-required.md"),
		"# WO-2026-999\n\n### Metadata\n\n**work_order_id**: WO-2026-999\n**review_policy**: required\n",
	);
	// Both encodings in one file, disagreeing: the bold line is the one the WO
	// template prescribes and wins (decision 032).
	writeFileSync(
		join(fixtureDir, "both-bold-skip.md"),
		"---\nwork_order_id: WO-2026-999\nreview_policy: required\n---\n\n# WO-2026-999\n\n**review_policy**: skip\n",
	);
});

afterAll(() => {
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	restoreSubagentEnv();
	rmSync(fixtureDir, { recursive: true, force: true });
});

type Spawned = { sid: string; rs: RunningSubagent; log: string; tools: Map<string, any>; ctx: any };

async function spawn(task: string, extra: Record<string, unknown> = {}): Promise<Spawned> {
	const { pi, tools } = createPiStub();
	subagentFactory(pi);
	const ctx = createCtxStub(fixtureDir);
	const res = await tools
		.get("subagent")
		.execute("tc", { agent: "implement", task, cwd: fixtureDir, isolate: false, ...extra }, undefined, undefined, ctx);
	const text = res.content[0].text as string;
	const match = /session: (subagent-[0-9a-f-]+)/.exec(text);
	if (!match) throw new Error(`spawn did not return a session id:\n${text}`);
	const sid = match[1];
	children.push({ sid, tools, ctx });
	const rs = resolveRunningSession(sid);
	if (!rs) throw new Error(`no in-memory record for ${sid} immediately after the spawn returned`);
	// Written synchronously inside spawnSubagent, before any child traffic.
	const log = readFileSync(`/tmp/pi-subagent-${sid}.log`, "utf8");
	return { sid, rs, log, tools, ctx };
}

const children: Array<{ sid: string; tools: Map<string, any>; ctx: any }> = [];

/** Wait until the harness no longer tracks the child; true when it settled.
 *  The close handler writes its completion footer to the spawn log and only
 *  then removes the record from the running map (index.ts: footer `logEntry` →
 *  `running.delete`, both before the first `await`), so a settled record is the
 *  deterministic signal that the log is final. Unlinking straight after
 *  `subagent_kill` races that handler and the footer recreates the file
 *  (round-3 review: 7 leaked logs per run). */


afterEach(async () => {
	for (const child of children.splice(0)) {
		const rs = resolveRunningSession(child.sid);
		try {
			await child.tools
				.get("subagent_kill")
				.execute("tk", { session_id: child.sid }, undefined, undefined, child.ctx);
		} catch {
			// best-effort: fall through to the direct kill below
		}
		if (rs) {
			// The kill path clears both timers; clear again in case it raced the
			// close handler so no 30-minute timer outlives the test process.
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
		}
		const settled = await waitUntilUntracked(child.sid);
		const artifacts = [metaPath(child.sid), `/tmp/pi-subagent-${child.sid}.log`, `/tmp/pi-subagent-${child.sid}.sock`];
		const remove = () => {
			for (const f of artifacts) {
				try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
			}
		};
		remove();
		if (!settled) {
			// The close handler had not finished when the budget expired. Its
			// footer write is the one thing that can recreate an artifact, so give
			// it a bounded grace pass before the final unlink — and say so loudly
			// if even that does not stick (a leak must not be silent).
			await new Promise((r) => setTimeout(r, 250));
			remove();
			if (existsSync(artifacts[1])) {
				console.warn(`[work-order-policy-wiring] cleanup did not settle for ${child.sid}; ${artifacts[1]} was re-created`);
			}
		}
	}
});

describe("work-order skip flows through the real subagent boundary", () => {
	it(
		"a bare-form work order suppresses the gate and annotates the task",
		async () => {
			const { rs, log } = await spawn("Reply with: ok", { workOrderPath: "bare-skip.md" });

			// The WO's `skip` (bare bold line) reaches the gate…
			expect(rs.reviewParentRequirements).toBeUndefined();
			// …and the child is told, even though the task itself never declares it.
			expect(log).toContain(INJECTION_MARKER);
		},
		15_000,
	);

	it(
		"without a work order, a bare bold declaration in the task suppresses the gate",
		async () => {
			const { rs } = await spawn("Reply with: ok\n\n**review_policy**: skip");

			// Round-1 mutation `(workOrderPolicy === undefined && false)` went red here.
			expect(rs.reviewParentRequirements).toBeUndefined();
		},
		15_000,
	);

	it(
		"without any declaration the gate stays live (the suppression above is real)",
		async () => {
			const { rs } = await spawn("Reply with: ok");

			expect(rs.reviewParentRequirements).toEqual(IMPLEMENT_REQUIREMENTS);
		},
		15_000,
	);

	it(
		"a task that already declares skip is not annotated twice",
		async () => {
			const { log } = await spawn("**review_policy**: skip (mine)\nDo the thing", {
				review_policy: "skip",
			});

			// Round-1 mutation `if (false) return task` in the dedupe went red here.
			expect(log).not.toContain(INJECTION_MARKER);
		},
		15_000,
	);

	it(
		"a task without the declaration still gets the annotation (that assertion has teeth)",
		async () => {
			const { log } = await spawn("Do the thing", { review_policy: "skip" });

			expect(log).toContain(INJECTION_MARKER);
		},
		15_000,
	);

	it(
		"the work order's parsed policy wins over a disagreeing tool param (both directions)",
		async () => {
			// WO `required` beats param `skip`: gate live, nothing annotated. This is
			// the `workOrderPolicy ?? reviewPolicy` threading at execute — an inversion
			// (`params.review_policy ?? workOrderPolicy`) passes every other row.
			const required = await spawn("Do the thing", { workOrderPath: "bare-required.md", review_policy: "skip" });
			expect(required.rs.reviewParentRequirements).toEqual(IMPLEMENT_REQUIREMENTS);
			expect(required.log).not.toContain(INJECTION_MARKER);

			// WO `skip` beats param `required`: gate suppressed, child told.
			const skipped = await spawn("Do the thing", { workOrderPath: "bare-skip.md", review_policy: "required" });
			expect(skipped.rs.reviewParentRequirements).toBeUndefined();
			expect(skipped.log).toContain(INJECTION_MARKER);
		},
		15_000,
	);

	it(
		"a work order carrying both encodings takes the bold line",
		async () => {
			const { rs, log } = await spawn("Do the thing", { workOrderPath: "both-bold-skip.md" });

			// YAML says required, the bold line says skip — through the real execute,
			// end to end. (The mirror pins this too, in its manual lane.)
			expect(rs.reviewParentRequirements).toBeUndefined();
			expect(log).toContain(INJECTION_MARKER);
		},
		15_000,
	);
});

/**
 * tfd process-controls R3-1 and R6 (owner, 2026-10-19) through the real
 * `checkpoint` / `checkpoint_fork` tool handlers.
 *
 * R3-1: the archived summary carries a machine-built "In-flight subagents"
 * section sourced from the subagent meta registry — 0 live children → omitted,
 * N → each with id + branch + state; the restore path (`customInstructions` +
 * MARKER) still round-trips.
 * R6: `nextSteps` states owner state only by registry row id — no claim passes
 * free, a claim with a same-paragraph row id passes, a claim without fails the
 * tool call, a malformed id fails it, and a repo with `scripts/reviews_status.py`
 * names a row it does not have.
 *
 * Run: bun test tests/checkpoint-recoverability.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import checkpointFactory, { _testSetInflightScanDir } from "../extensions/checkpoint.ts";
import { childEnv } from "./helpers/subagent-env.ts";

// ── Stubs ──────────────────────────────────────────────────────────────────

function createPiStub() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: (name: string, fn: any) => handlers.set(name, fn),
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
	};
	return { pi, tools, handlers };
}

function createCtxStub(cwd: string) {
	const compactions: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		compactions,
		notifications,
		ctx: {
			cwd,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setStatus: () => {},
				setWidget: () => {},
				clearStatus: () => {},
			},
			model: { contextWindow: 200_000 },
			getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: null }),
			getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
			sessionManager: {
				getEntries: () => [],
				getSessionId: () => "sess-test",
				getCwd: () => cwd,
			},
			compact: (opts: any) => compactions.push(opts),
		},
	};
}

/** The `summary` schema's fields — the shape both tool parameters require. */
interface SummaryFields {
	goal: string;
	filesTouched: string[];
	decisions: string[];
	triedAndFailed: string[];
	constraints: string;
}

const SUMMARY: SummaryFields = {
	goal: "recoverability fixture",
	filesTouched: [],
	decisions: ["none"],
	triedAndFailed: ["none"],
	constraints: "none",
};

/** `renderSummary(SUMMARY, "Continue work")` — the summary text with no machine section. */
const SUMMARY_TEXT = [
	"Goal: recoverability fixture",
	"Files touched: none",
	"Decisions: none",
	"Tried and failed (and why): none",
	"Constraints: none",
	"Next: Continue work",
].join("\n");

let dir: string;
let registryDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-recover-"));
	registryDir = mkdtempSync(join(tmpdir(), "pi-checkpoint-registry-"));
	_testSetInflightScanDir(registryDir);
});

afterEach(() => {
	_testSetInflightScanDir(undefined);
	rmSync(dir, { recursive: true, force: true });
	rmSync(registryDir, { recursive: true, force: true });
});

/** A meta the in-flight scan will adopt (same-process owner). */
function writeMeta(sid: string, extra: Record<string, unknown> = {}) {
	writeFileSync(
		join(registryDir, `pi-subagent-${sid}.meta.json`),
		JSON.stringify({ ownerPid: process.pid, agentName: "implement", task: "do the thing", ...extra }),
	);
}

/** An orphaned child: no completion footer, a session file on disk. */
function writeOrphaned(sid: string, branch = `pi-subagent-${sid.slice(-12)}`) {
	const sessionFile = join(dir, `${sid}.session.jsonl`);
	writeFileSync(sessionFile, "{}\n");
	writeMeta(sid, { isolationBranch: branch, sessionFile, worktreePath: `/tmp/pi-subagent-wt-${sid.slice(-12)}` });
}

/** A running child: log written now is the liveness evidence. */
function writeRunning(sid: string, branch = `pi-subagent-${sid.slice(-12)}`) {
	writeMeta(sid, { isolationBranch: branch });
	writeFileSync(join(registryDir, `pi-subagent-${sid}.log`), "── Turn 1 ──\nworking…\n");
}

async function runCheckpoint(
	params: Record<string, unknown>,
	cwd = dir,
): Promise<{
	text: string;
	isError?: boolean;
	instructions: string;
	archiveSummary: string | null;
	notifications: Array<{ message: string; level: string }>;
}> {
	const { pi, tools, handlers } = createPiStub();
	checkpointFactory(pi);
	const { ctx, compactions, notifications } = createCtxStub(cwd);
	const res = await tools
		.get("checkpoint")
		.execute("tc", { summary: SUMMARY, ...params }, undefined, undefined, ctx);

	// The compaction itself is triggered by the turn_end handler (the tool only
	// stashes the request), so fire it before reading the instructions.
	await handlers.get("turn_end")({}, ctx);

	// The archive meta is the other copy the tool stores.
	const archiveDir = join(cwd, ".pi/checkpoints");
	let archiveSummary: string | null = null;
	if (existsSync(archiveDir)) {
		const metas = readdirSync(archiveDir).filter((f) => f.endsWith(".meta.json"));
		if (metas.length > 0) {
			archiveSummary = JSON.parse(readFileSync(join(archiveDir, metas[0]), "utf-8")).summary;
		}
	}

	return {
		text: res.content[0].text as string,
		isError: res.isError,
		instructions: compactions[0]?.customInstructions ?? "",
		archiveSummary,
		notifications,
	};
}

// ── R3-1 ───────────────────────────────────────────────────────────────────

describe("checkpoint summary records in-flight subagents (R3-1)", () => {
	it("omits the section when no live subagents are in the registry", async () => {
		const out = await runCheckpoint({ nextSteps: "Continue work" });

		expect(out.isError).toBeFalsy();
		expect(out.instructions).not.toContain("In-flight subagents");
		expect(out.archiveSummary).toBe(SUMMARY_TEXT);
	});

	it("lists one live subagent with id, branch and state", async () => {
		writeOrphaned("subagent-aaaaaaaa-1111-4111-8111-111111111111");

		const out = await runCheckpoint({ nextSteps: "Continue work" });

		expect(out.instructions).toContain("In-flight subagents");
		expect(out.instructions).toContain("subagent-aaaaaaaa-1111-4111-8111-111111111111");
		expect(out.instructions).toContain("pi-subagent-111111111111");
		expect(out.instructions).toContain("state: orphaned");
		// The recoverable one carries the call that resumes it (R3-3 vocabulary).
		expect(out.instructions).toContain("subagent_resume({ session_id:");
		expect(out.text).toContain("In-flight subagents recorded in the summary: 1");
	});

	it("lists three live subagents — running and orphaned — from the registry, not the model's prose", async () => {
		writeOrphaned("subagent-bbbbbbbb-1111-4111-8111-111111111111");
		writeOrphaned("subagent-cccccccc-1111-4111-8111-111111111111");
		writeRunning("subagent-dddddddd-1111-4111-8111-111111111111");

		const out = await runCheckpoint({ nextSteps: "Continue work" });

		for (const sid of [
			"subagent-bbbbbbbb-1111-4111-8111-111111111111",
			"subagent-cccccccc-1111-4111-8111-111111111111",
			"subagent-dddddddd-1111-4111-8111-111111111111",
		]) {
			expect(out.instructions).toContain(sid);
		}
		expect(out.instructions).toContain("state: running");
		expect(out.instructions.match(/state: orphaned/g)?.length).toBe(2);
		expect(out.archiveSummary).toContain("In-flight subagents");
	});

	it("round-trips: the restore instructions still parse back via the MARKER", async () => {
		writeOrphaned("subagent-eeeeeeee-1111-4111-8111-111111111111");

		const out = await runCheckpoint({ nextSteps: "Continue work" });

		expect(out.instructions.startsWith("[CHECKPOINT]\n")).toBe(true);
		const restored = out.instructions.replace("[CHECKPOINT]", "").trim();
		expect(restored.startsWith(SUMMARY_TEXT)).toBe(true);
		expect(restored).toContain("In-flight subagents");
	});

	it("checkpoint_fork carries the section into the new session's summary", async () => {
		writeOrphaned("subagent-ffffffff-1111-4111-8111-111111111111");
		const target = join(dir, "target");
		mkdirSync(target);
		const { pi, tools } = createPiStub();
		checkpointFactory(pi);
		const { ctx } = createCtxStub(dir);

		const res = await tools
			.get("checkpoint_fork")
			.execute("tc", { newCwd: target, summary: SUMMARY, nextSteps: "Continue work" }, undefined, undefined, ctx);

		expect(res.isError).toBeFalsy();
		expect(res.content[0].text as string).toContain("In-flight subagents recorded in the summary: 1");
	});
});

// ── R6 ─────────────────────────────────────────────────────────────────────

describe("checkpoint nextSteps owner-state bar (R6)", () => {
	it("accepts nextSteps with no owner-state claim", async () => {
		const out = await runCheckpoint({ nextSteps: "Continue work" });
		expect(out.isError).toBeFalsy();
	});

	it("accepts an owner-state claim whose paragraph carries a row id", async () => {
		const out = await runCheckpoint({
			nextSteps: "Take the owner's answers on the three rulings (docs/reviews/process-controls.md#R3).",
		});
		expect(out.isError).toBeFalsy();
	});

	it("accepts a row id on a continuation line of the same paragraph", async () => {
		const out = await runCheckpoint({
			nextSteps: "The owner ruled on the transport merge\n(see emitir-transport.md#E2) — proceed.",
		});
		expect(out.isError).toBeFalsy();
	});

	it("accepts a row id wrapped in backticks or emphasis", async () => {
		for (const nextSteps of [
			"The owner ruled on the transport merge (`emitir-transport.md#E2`) — proceed.",
			"The owner ruled on the transport merge (**emitir-transport.md#E2**) — proceed.",
		]) {
			const out = await runCheckpoint({ nextSteps });
			expect(out.isError).toBeFalsy();
		}
	});

	it("fails the tool call when the claim has no row id, naming the rule", async () => {
		const out = await runCheckpoint({ nextSteps: "Take the owner's answers on WO-153's three open rulings." });

		expect(out.isError).toBe(true);
		expect(out.text).toContain("R6");
		expect(out.text).toMatch(/row id/);
		expect(out.text).toContain("Take the owner's answers");
		// nothing was archived
		expect(existsSync(join(dir, ".pi/checkpoints"))).toBe(false);
	});

	it("fails a claim whose id-shaped token has no '#'", async () => {
		const out = await runCheckpoint({ nextSteps: "The owner confirmed the plan (see R3 for the ruling)." });

		expect(out.isError).toBe(true);
		expect(out.text).toMatch(/without the `#`|without the #/);
		expect(out.text).toContain("R3");
	});

	it("does not require a row id for a paragraph that only asks the owner", async () => {
		const out = await runCheckpoint({
			nextSteps: "Ask the owner whether the transport merge should proceed; the owner owns this question.",
		});
		expect(out.isError).toBeFalsy();
	});

	it("a claim's row id in a *different* paragraph does not license it", async () => {
		const out = await runCheckpoint({
			nextSteps: "Take the owner's answers on the three rulings.\n\nRows: docs/reviews/process-controls.md#R3",
		});
		expect(out.isError).toBe(true);
		expect(out.text).toContain("Take the owner's answers");
	});

	it("fails checkpoint_fork's nextSteps on the same bar", async () => {
		const target = join(dir, "target");
		mkdirSync(target);
		const { pi, tools } = createPiStub();
		checkpointFactory(pi);
		const { ctx } = createCtxStub(dir);

		const res = await tools
			.get("checkpoint_fork")
			.execute("tc", { newCwd: target, summary: SUMMARY, nextSteps: "The owner decided to merge." }, undefined, undefined, ctx);

		expect(res.isError).toBe(true);
		expect(res.content[0].text as string).toMatch(/row id/);
	});
});

describe("R6 registry existence (repo with scripts/reviews_status.py)", () => {
	/** A temp git repo carrying `scripts/reviews_status.py`. Default registry: one row, docs/reviews/known.md#K1. */
	function makeRegistryRepo(script?: string): string {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(
			join(repo, "scripts/reviews_status.py"),
			script ??
				'import sys\nprint("docs/reviews/known.md")\nprint("  K1  -  answered  not-started  ruled: 2026-01-01  revisit: -  - item")\n',
		);
		const git = Bun.spawnSync(["git", "init", "-q", repo], { env: childEnv() });
		if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
		return repo;
	}

	it("names a cited row the registry does not have", async () => {
		const repo = makeRegistryRepo();
		const out = await runCheckpoint(
			{ nextSteps: "The owner ruled on the schema (docs/reviews/missing.md#X9)." },
			repo,
		);

		expect(out.isError).toBe(true);
		expect(out.text).toContain("docs/reviews/missing.md#X9");
		expect(out.text).toContain("does not exist");
	});

	it("accepts a cited row the registry has (basename and full path forms)", async () => {
		const repo = makeRegistryRepo();
		for (const rowId of ["docs/reviews/known.md#K1", "known.md#K1"]) {
			const out = await runCheckpoint({ nextSteps: `The owner approved the row (${rowId}).` }, repo);
			expect(out.isError).toBeFalsy();
		}
	});

	it("falls back to form-only when the repo has no registry script", async () => {
		const bare = join(dir, "bare");
		mkdirSync(bare, { recursive: true });
		Bun.spawnSync(["git", "init", "-q", bare], { env: childEnv() });

		const out = await runCheckpoint({ nextSteps: "The owner approved the row (anything.md#Z1)." }, bare);
		expect(out.isError).toBeFalsy();
	});
});

/**
 * tfd process-controls R4 (owner, 2026-10-19) through the real `subagent`
 * boundary: a completion report from an agent whose report schema declares
 * `owner_asks` is refused unless the field is present and holds `none` or
 * registry row ids — and the refusal reaches the live reporter as a steer, so
 * the report is never delivered.
 *
 * The child binary is a stand-in that emits one text-only assistant
 * `message_end` (the report) and echoes everything it receives on stdin to
 * `<cwd>/stdin-echo.txt`, so both halves of the ruling are observable: the
 * parent's decision (delivered vs not) and the rejection text the reporter got.
 *
 * Run: bun test tests/subagent-owner-asks-gate.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	_testRunning,
	_testSetLiveSessionCtx,
	metaPath,
	reportDeclaresOwnerAsks,
	resolveRunningSession,
} from "../extensions/subagent-async/index.ts";

type RunningSubagent = NonNullable<ReturnType<typeof resolveRunningSession>>;

/** The stand-in child: emit `standin-report.txt` as one assistant message_end,
 *  and re-emit whenever the file changes (the reissue path). It also answers the
 *  harness's `get_state` request, so tests can exercise the reviewer gate (which
 *  needs the child's pi session id to find its reviewer-spawn tracker). */
const STANDIN_SOURCE = `
import { appendFileSync, readFileSync } from "node:fs";

/** The key the harness will look its reviewer tracker up by. */
const PI_SESSION_ID = "standin-owner-asks";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	try { appendFileSync("stdin-echo.txt", d); } catch { /* */ }
	for (const line of String(d).split("\\n")) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg && msg.type === "get_state") {
			process.stdout.write(JSON.stringify({
				type: "response", id: msg.id, success: true,
				data: { sessionId: PI_SESSION_ID, sessionFile: "/tmp/" + PI_SESSION_ID + ".jsonl" },
			}) + "\\n");
		}
	}
});
process.stdin.on("end", () => process.exit(0));
const emit = (text) => {
	const event = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	};
	process.stdout.write(JSON.stringify(event) + "\\n");
};
let last = null;
setInterval(() => {
	let report = "";
	try { report = readFileSync("standin-report.txt", "utf8"); } catch { /* no report */ }
	if (report.length > 0 && report !== last) { last = report; emit(report); }
}, 200);
setInterval(() => {}, 1 << 30);
`;

let fixtureRoot: string;
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;

/** A minimal agent whose report schema declares `owner_asks` (the R4 gate's
 *  trigger is the prompt, so the fixture must carry the field). */
function agentFile(name: string, body: string): string {
	return `---\nname: ${name}\ndescription: test fixture\n---\n\n${body}\n`;
}

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-owner-asks-"));
	const fakePi = join(fixtureRoot, "stand-in-pi.mjs");
	writeFileSync(fakePi, STANDIN_SOURCE);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	// The gate keys on the agent's own prompt, so the fixture agent dir (not the
	// user's) decides whether it is live. `getAgentDir` reads the env each call.
	const agentsDir = join(fixtureRoot, "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "implement.md"),
		agentFile(
			"implement",
			"## Completion report\n\n**status:** complete | blocked | partial\n\n**owner_asks:** none, or `<file>#<id>` row ids\n",
		),
	);
	writeFileSync(join(agentsDir, "scout-code.md"), agentFile("scout-code", "Report findings. No completion schema."));
	// Same report schema, plus the reviewer requirement: exercises the ordering
	// between the reviewer soft-prompt gate and the R4 gate.
	writeFileSync(
		join(agentsDir, "gated-implement.md"),
		`---\nname: gated-implement\ndescription: test fixture\nrequires_parent_reviewers: implementation,tests\n---\n\n` +
			"## Completion report\n\n**status:** complete | blocked | partial\n\n**owner_asks:** none, or `<file>#<id>` row ids\n",
	);
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
});

afterAll(() => {
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function createPiStub() {
	const tools = new Map<string, any>();
	const delivered: string[] = [];
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => delivered.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools, delivered };
}

interface Child {
	sid: string;
	cwd: string;
	rs: RunningSubagent;
	tools: Map<string, any>;
	ctx: any;
	delivered: string[];
}

const children: Child[] = [];

async function spawnWithReport(report: string, extra: Record<string, unknown> = {}): Promise<Child> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-owner-asks-case-"));
	writeFileSync(join(cwd, "standin-report.txt"), report);

	const { pi, tools, delivered } = createPiStub();
	subagentFactory(pi);
	const ctx: any = {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "sess-owner-asks" },
	};
	_testSetLiveSessionCtx(ctx);

	const res = await tools
		.get("subagent")
		.execute(
			"tc",
			{ agent: "implement", task: "Reply with: ok", cwd, isolate: false, review_policy: "skip", ...extra },
			undefined,
			undefined,
			ctx,
		);
	const text = res.content[0].text as string;
	const match = /session: (subagent-[0-9a-f-]+)/.exec(text);
	if (!match) throw new Error(`spawn did not return a session id:\n${text}`);
	const sid = match[1];
	const rs = resolveRunningSession(sid);
	if (!rs) throw new Error(`no in-memory record for ${sid}`);
	const child: Child = { sid, cwd, rs, tools, ctx, delivered };
	children.push(child);
	return child;
}

/** Wait until `check` is truthy; returns whether it became so. */
async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return check();
}

function stdinEcho(child: Child): string {
	try {
		return readFileSync(join(child.cwd, "stdin-echo.txt"), "utf8");
	} catch {
		return "";
	}
}

async function waitUntilUntracked(sid: string, ms = 10_000): Promise<boolean> {
	return waitFor(() => !resolveRunningSession(sid), ms);
}

afterEach(async () => {
	_testSetLiveSessionCtx(undefined);
	for (const child of children.splice(0)) {
		const rs = resolveRunningSession(child.sid);
		try {
			await child.tools
				.get("subagent_kill")
				.execute("tk", { session_id: child.sid }, undefined, undefined, child.ctx);
		} catch { /* best-effort */ }
		if (rs) {
			if (rs.staleTimer) clearTimeout(rs.staleTimer);
			if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
			try { rs.proc?.kill("SIGKILL"); } catch { /* already gone */ }
		}
		await waitUntilUntracked(child.sid, 5_000);
		for (const f of [
			metaPath(child.sid),
			`/tmp/pi-subagent-${child.sid}.log`,
			`/tmp/pi-subagent-${child.sid}.sock`,
			"/tmp/pi-subagent-standin-owner-asks.reviewers.json",
		]) {
			try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
		}
		rmSync(child.cwd, { recursive: true, force: true });
	}
	_testRunning.clear();
});

const CONFORMING_TAIL = "\n\n**files_modified:** none\n\n**tests:** none\n";

describe("owner_asks is accepted when well-formed", () => {
	it("accepts `none` and delivers the report", async () => {
		const child = await spawnWithReport(`**status:** complete\n\n**owner_asks:** none\n${CONFORMING_TAIL}`);

		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
		expect(child.delivered.join("\n")).toContain("**status:** complete");
		expect(child.delivered.join("\n")).not.toContain("owner-asks");
	}, 20_000);

	it("accepts a single well-formed row id (the owner-asks key shape)", async () => {
		const child = await spawnWithReport(
			`**status:** complete\n\n**owner_asks:** emitir-transport.md#E2\n${CONFORMING_TAIL}`,
		);

		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
	});

	it("accepts a multi-ask report (comma-separated and space-separated ids)", async () => {
		for (const value of [
			"docs/reviews/process-controls.md#R3, emitir-transport.md#E2",
			"emitir-transport.md#E2 array-conversion.md#A1a",
		]) {
			const child = await spawnWithReport(`**status:** complete\n\n**owner_asks:** ${value}\n${CONFORMING_TAIL}`);
			expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
		}
	}, 30_000);

	it("accepts ids wrapped in markdown emphasis (the schema's own bold spelling)", async () => {
		const child = await spawnWithReport(
			`**status:** complete\n\n**owner_asks:** **emitir-transport.md#E2** \`array-conversion.md#A1a\`.\n${CONFORMING_TAIL}`,
		);

		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
		expect(child.delivered.join("\n")).not.toContain("owner-asks");
	}, 20_000);

	it("leaves agents whose schema does not declare owner_asks ungated", async () => {
		const child = await spawnWithReport("Findings: nothing to report.", { agent: "scout-code" });

		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
		expect(child.delivered.join("\n")).not.toContain("[owner-asks]");
	}, 20_000);
});

describe("a non-conforming report is refused and never delivered", () => {
	it("refuses free text in the ask and steers the reporter to reissue", async () => {
		const child = await spawnWithReport(
			`**status:** blocked\n\n**owner_asks:** should we merge the transport branch?\n${CONFORMING_TAIL}`,
		);

		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks]"))).toBe(true);
		const echo = stdinEcho(child);
		expect(echo).toContain("Report refused");
		expect(echo).toContain("owner_asks");
		expect(echo).toContain("free text");
		expect(echo).toContain("should we merge the transport branch?");

		// Not delivered: the child is still tracked, not done.
		expect(child.delivered).toEqual([]);
		expect(child.rs.isDone).toBe(false);
		expect(resolveRunningSession(child.sid)).toBeDefined();
	}, 20_000);

	it("refuses a report with no owner_asks line at all", async () => {
		const child = await spawnWithReport(`**status:** complete\n\n**files_modified:** none\n`);

		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks]"))).toBe(true);
		expect(stdinEcho(child)).toContain("line missing");
		expect(child.delivered).toEqual([]);
	}, 20_000);

	it("refuses an empty owner_asks value", async () => {
		const child = await spawnWithReport(`**status:** complete\n\n**owner_asks:**\n${CONFORMING_TAIL}`);

		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks]"))).toBe(true);
		expect(stdinEcho(child)).toContain("empty");
		expect(child.delivered).toEqual([]);
	}, 20_000);

	it("refuses `none` mixed with row ids", async () => {
		const child = await spawnWithReport(
			`**status:** complete\n\n**owner_asks:** none, emitir-transport.md#E2\n${CONFORMING_TAIL}`,
		);

		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks]"))).toBe(true);
		expect(stdinEcho(child)).toContain("mixes");
		expect(child.delivered).toEqual([]);
	}, 20_000);

	it("a conforming reissue after a refusal is delivered", async () => {
		const child = await spawnWithReport(`**status:** complete\n\n**owner_asks:** tell the owner\n${CONFORMING_TAIL}`);
		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks]"))).toBe(true);
		expect(child.delivered).toEqual([]);

		// The reporter reissues with the ask registered as a row.
		writeFileSync(
			join(child.cwd, "standin-report.txt"),
			`**status:** complete\n\n**owner_asks:** emitir-transport.md#E2\n${CONFORMING_TAIL}`,
		);

		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
	}, 25_000);
});

describe("under the reviewer flow (requires_parent_reviewers)", () => {
	// The tracker the child's own harness writes per spawned reviewer; the
	// review gate reads it by the child's pi session id (the stand-in's).
	const TRACKER = "/tmp/pi-subagent-standin-owner-asks.reviewers.json";

	function reviewerTracker(kinds: string[]): string {
		return JSON.stringify({
			parentSessionId: "standin-owner-asks",
			updatedAt: Date.now(),
			spawns: kinds.map((reviewerKind, i) => ({
				reviewerKind,
				childSessionId: `reviewer-${i}`,
				childAgentName: reviewerKind,
				spawnedAt: Date.now(),
			})),
			reviewRounds: 1,
			reviewCapReached: false,
		});
	}

	it("a refused report is neither delivered nor counted, and a conforming reissue is", async () => {
		try { unlinkSync(TRACKER); } catch { /* none from an earlier run */ }

		const freeText = `**status:** complete\n\n**owner_asks:** should we merge the transport branch?\n${CONFORMING_TAIL}`;
		const child = await spawnWithReport(freeText, { agent: "gated-implement", review_policy: "required" });

		// 1. The reviewer gate is live (the child answered get_state, so the
		//    harness can read its tracker) and fires first: still no delivery.
		expect(await waitFor(() => stdinEcho(child).includes("[review-gate]"))).toBe(true);
		expect(child.delivered).toEqual([]);
		expect(child.rs.isDone).toBe(false);

		// The child runs both reviewers (the tracker is what the gate reads).
		writeFileSync(TRACKER, reviewerTracker(["implementation", "tests"]));

		// 2. Reviewers satisfied → the R4 gate reaches the same report and
		//    refuses it. Refused is not delivered, and not countable as such.
		writeFileSync(join(child.cwd, "standin-report.txt"), `${freeText}\n`);
		expect(await waitFor(() => stdinEcho(child).includes("[owner-asks] Report refused"))).toBe(true);
		expect(child.delivered).toEqual([]);
		expect(child.rs.isDone).toBe(false);

		// 3. The conforming reissue passes both gates and is delivered.
		writeFileSync(
			join(child.cwd, "standin-report.txt"),
			`**status:** complete\n\n**owner_asks:** emitir-transport.md#E2\n${CONFORMING_TAIL}\n`,
		);
		expect(await waitFor(() => child.delivered.length > 0)).toBe(true);
		expect(child.delivered.join("\n")).toContain("emitir-transport.md#E2");
	}, 40_000);
});

// ── Gate scope ─────────────────────────────────────────────────────────────

describe("reportDeclaresOwnerAsks — which prompts declare the field", () => {
	const agentBody = (file: string) => readFileSync(join(import.meta.dir, "..", "agents", file), "utf8");

	it("is exactly the two report schemas, read from the real agent files", () => {
		const declared = ["bug-triage.md", "implement.md", "math-algo-oracle.md", "orchestrator.md",
			"review-code.md", "review-plan.md", "review-tests.md", "scout-code.md", "scout-web.md"]
			.filter((f) => reportDeclaresOwnerAsks(agentBody(f)));
		expect(declared).toEqual(["implement.md", "orchestrator.md"]);
	});

	it("accepts the schema spellings and rejects prose and absent prompts", () => {
		expect(reportDeclaresOwnerAsks("**owner_asks:** none")).toBe(true);
		expect(reportDeclaresOwnerAsks("- **owner_asks:** `<file>#<id>`")).toBe(true);
		expect(reportDeclaresOwnerAsks("**OWNER_ASKS:** none")).toBe(true);
		expect(reportDeclaresOwnerAsks("- **owner_asks** — the asks this report raises")).toBe(false);
		expect(reportDeclaresOwnerAsks("Report findings. No completion schema.")).toBe(false);
		expect(reportDeclaresOwnerAsks(undefined)).toBe(false);
		expect(reportDeclaresOwnerAsks(null)).toBe(false);
	});
});

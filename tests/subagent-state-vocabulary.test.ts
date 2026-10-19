/**
 * tfd process-controls R3-3 (owner, 2026-10-19): the four-state status
 * vocabulary, driven through the real `subagent_status` tool and the shared
 * classifier that also feeds checkpoint's in-flight section.
 *
 * Each row produces its state from evidence on disk and asserts the evidence is
 * named in the answer: running (attached / socket+live owner / fresh log),
 * complete (the `── Completed …` footer), orphaned (no completion line, session
 * file exists → the `subagent_resume` call), dead/unmatched (no meta; owner
 * gone with no session file). The old "may have already finished or been
 * stopped" merge must not appear for any distinguishable case.
 *
 * Run: bun test tests/subagent-state-vocabulary.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_testRunning,
	describeUnknownSession,
	metaPath,
	readMetaJson,
	resolveRunningSession,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";
import {
	listInFlightSubagents,
	readSubagentState,
	resumeCallFor,
	type SubagentDiskFacts,
} from "../extensions/lib/subagent-state.ts";
import subagentFactory from "../extensions/subagent-async/index.ts";

const created: string[] = [];
const dirs: string[] = [];

afterEach(() => {
	_testRunning.clear();
	for (const f of created.splice(0)) {
		try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Backdate a log so its mtime is not liveness evidence. */
function ageLog(path: string, secondsAgo = 3600) {
	const t = (Date.now() - secondsAgo * 1000) / 1000;
	utimesSync(path, t, t);
}

function track(sid: string) {
	created.push(metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`);
}

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-state-vocab-"));
	dirs.push(d);
	return d;
}

/** A dead pid, for the owner-gone rows. */
async function deadPid(): Promise<number> {
	const p = Bun.spawn(["true"]);
	const pid = p.pid;
	await p.exited;
	return pid;
}

// ── Pure classifier ────────────────────────────────────────────────────────

describe("readSubagentState — evidence → state", () => {
	const base: SubagentDiskFacts = {
		meta: { ownerPid: process.pid, ownerStartToken: null },
		attached: false,
		sockExists: false,
		logLastLine: null,
		logMtimeMs: null,
		sessionFileExists: false,
		hasRecordedOwner: true,
		ownerAlive: true,
		now: 1_000_000,
	};

	it("attached → running", () => {
		expect(readSubagentState({ ...base, attached: true }).state).toBe("running");
	});

	it("no meta → unmatched", () => {
		const r = readSubagentState({ ...base, meta: null });
		expect(r.state).toBe("unmatched");
		expect(r.evidence).toContain("no registry entry");
	});

	it("`── Completed (…)` footer → complete", () => {
		const r = readSubagentState({ ...base, logLastLine: "── Completed (7 turns, exit 0) ──" });
		expect(r.state).toBe("complete");
		expect(r.evidence).toContain("Completed");
	});

	it("`── Killed (…)` footer with a session file → orphaned (resumable)", () => {
		const r = readSubagentState({
			...base,
			logLastLine: "── Killed (7 turns, exit 0) ──",
			sessionFileExists: true,
		});
		expect(r.state).toBe("orphaned");
		expect(r.evidence).toContain("Killed");
	});

	it("`── Stopped (…)` footer with no session file → dead, cause named", () => {
		const r = readSubagentState({ ...base, logLastLine: "── Stopped (1 turns, exit 1) ──" });
		expect(r.state).toBe("dead");
		expect(r.evidence).toContain("no session file");
	});

	it("socket + live owner → running", () => {
		const r = readSubagentState({ ...base, sockExists: true, ownerAlive: true });
		expect(r.state).toBe("running");
		expect(r.evidence).toContain("owner");
	});

	it("a log written seconds ago → running (fresh mtime)", () => {
		const r = readSubagentState({ ...base, logMtimeMs: base.now - 5_000, logLastLine: "working…" });
		expect(r.state).toBe("running");
		expect(r.evidence).toContain("ago");
	});

	it("a stale log + a session file, no completion line → orphaned", () => {
		const r = readSubagentState({
			...base,
			logMtimeMs: base.now - 60 * 60 * 1000,
			logLastLine: "working…",
			sessionFileExists: true,
		});
		expect(r.state).toBe("orphaned");
	});

	it("a stale log, no session file, owner gone → dead naming the owner", () => {
		const r = readSubagentState({
			...base,
			ownerAlive: false,
			logMtimeMs: base.now - 60 * 60 * 1000,
			logLastLine: "working…",
		});
		expect(r.state).toBe("dead");
		expect(r.evidence).toContain("gone");
	});

	it("a legacy meta (no owner) with nothing on disk → unmatched, no liveness claim", () => {
		const r = readSubagentState({
			...base,
			meta: {},
			hasRecordedOwner: false,
			ownerAlive: undefined,
			logMtimeMs: base.now - 60 * 60 * 1000,
			logLastLine: "working…",
		});
		expect(r.state).toBe("unmatched");
		expect(r.evidence).toContain("no owner process was recorded");
	});
});

// ── subagent_status (the tool) ─────────────────────────────────────────────

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

async function statusText(sessionId: string): Promise<string> {
	const { pi, tools } = createPiStub();
	subagentFactory(pi);
	const res = await tools.get("subagent_status").execute("tc", { session_id: sessionId }, undefined, undefined, undefined);
	return res.content[0].text as string;
}

describe("subagent_status names the state and its evidence", () => {
	it("an attached child reports State: running", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		_testRunning.set(sid, {
			sessionId: sid,
			agentName: "implement",
			isDone: false,
			startedAt: Date.now(),
			progress: { turns: 0, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "testing" },
		} as any);

		const text = await statusText(sid);
		expect(text).toContain("State: running — attached to this session's tracker.");
	});

	it("a completed child reports State: complete", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		writeMetaJson(sid, { ownerPid: process.pid, ownerStartToken: null });
		writeFileSync(`/tmp/pi-subagent-${sid}.log`, "── Turn 1 ──\nwork\n── Completed (1 turns, exit 0) ──\n");

		const text = await statusText(sid.slice(-12));
		expect(text).toContain("State: complete");
		expect(text).toContain("Completed");
		expect(text).not.toMatch(/may have already finished or been stopped/);
	});

	it("an orphaned child reports State: orphaned and prints the resume call", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		const sessionFile = join(tempDir(), "s.jsonl");
		writeFileSync(sessionFile, "{}\n");
		writeMetaJson(sid, { ownerPid: process.pid, ownerStartToken: null, sessionFile, task: "finish the transport merge" });

		const text = await statusText(sid.slice(-12));
		expect(text).toContain("State: orphaned");
		expect(text).toContain("Resume with: subagent_resume({ session_id: \"" + sid + "\"");
		expect(text).toContain("finish the transport merge");
	});

	it("an id matching nothing reports unmatched, not 'finished or stopped'", async () => {
		const text = await statusText(`subagent-${randomUUID()}`);
		expect(text).toMatch(/No session matches/);
		expect(text).not.toMatch(/may have already finished or been stopped/);
	});

	it("a dead owner with no session file reports State: dead naming the owner", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		const pid = await deadPid();
		writeMetaJson(sid, { ownerPid: pid, ownerStartToken: null });
		writeFileSync(`/tmp/pi-subagent-${sid}.log`, "── Turn 1 ──\nwork\n");
		ageLog(`/tmp/pi-subagent-${sid}.log`);

		const text = await statusText(sid.slice(-12));
		expect(text).toContain("State: dead");
		expect(text).toMatch(new RegExp(`pid ${pid}\\) is gone`));
	}, 30_000);

	it("a legacy meta with no owner reports unmatched and never invents liveness", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		writeMetaJson(sid, {});
		writeFileSync(`/tmp/pi-subagent-${sid}.log`, "── Turn 1 ──\nwork\n");
		ageLog(`/tmp/pi-subagent-${sid}.log`);

		const text = await statusText(sid.slice(-12));
		expect(text).toContain("State: unmatched");
		expect(text).not.toMatch(/pid undefined/);
	});
});

// ── In-flight listing (R3-1's source) ──────────────────────────────────────

describe("listInFlightSubagents — adoption gate + state", () => {
	it("lists running and orphaned children, skips complete and dead ones", () => {
		const dir = tempDir();
		const sessionFile = join(dir, "s.jsonl");
		writeFileSync(sessionFile, "{}\n");

		const write = (sid: string, meta: Record<string, unknown>) =>
			writeFileSync(join(dir, `pi-subagent-${sid}.meta.json`), JSON.stringify(meta));

		write("running-1", { ownerPid: process.pid, agentName: "implement", isolationBranch: "b-running" });
		writeFileSync(join(dir, "pi-subagent-running-1.log"), "working\n");

		write("orphaned-1", { ownerPid: process.pid, agentName: "implement", isolationBranch: "b-orphaned", sessionFile });
		writeFileSync(join(dir, "pi-subagent-orphaned-1.log"), "── Turn 1 ──\n");
		ageLog(join(dir, "pi-subagent-orphaned-1.log"));

		write("complete-1", { ownerPid: process.pid, isolationBranch: "b-complete" });
		writeFileSync(join(dir, "pi-subagent-complete-1.log"), "── Completed (2 turns, exit 0) ──\n");

		write("foreign-1", { ownerPid: process.ppid === process.pid ? 1 : process.ppid, ownerStartToken: "other" });
		write("legacy-1", {});

		const entries = listInFlightSubagents({ dir });
		const ids = entries.map((e) => e.sid).sort();
		expect(ids).toEqual(["orphaned-1", "running-1"]);
		expect(entries.find((e) => e.sid === "orphaned-1")?.resumeCall).toContain("subagent_resume(");
		expect(entries.find((e) => e.sid === "running-1")?.resumeCall).toBeNull();
		expect(entries.find((e) => e.sid === "running-1")?.branch).toBe("b-running");
	});
});

describe("resumeCallFor", () => {
	it("quotes a task safely and clips it", () => {
		const call = resumeCallFor("subagent-x", { task: 'say "hi"\n' + "x".repeat(200) });
		expect(call).toContain('\\"hi\\"');
		expect(call).toContain("…");
		expect(call.length).toBeLessThan(220);
	});

	it("falls back to a generic instruction when the meta has no task", () => {
		expect(resumeCallFor("subagent-x", null)).toContain("continue the work");
	});
});

// ── The reap keeps the registry honest ─────────────────────────────────────

describe("reap marking is visible to the status answer", () => {
	it("a kept worktree (worktreeKept) is reported as resumable", async () => {
		const sid = `subagent-${randomUUID()}`;
		track(sid);
		writeMetaJson(sid, {
			ownerPid: process.pid,
			ownerStartToken: null,
			worktreePath: "/tmp/pi-subagent-wt-kept",
			worktreeKept: { reason: "uncommitted work" },
		});
		writeFileSync(`/tmp/pi-subagent-${sid}.log`, "── Completed (1 turns, exit 0) ──\n");

		const text = await statusText(sid.slice(-12));
		expect(text).toContain("Uncommitted work kept");
		expect(text).toContain("orphaned-resumable");
		expect(text).toContain("subagent_resume(");
		expect(readMetaJson(sid)?.worktreeKept).toBeDefined();
	});
});

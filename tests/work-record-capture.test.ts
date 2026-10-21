/**
 * Harness capture of work-order records (decisions/work-order-records/001).
 *
 * The spawner writes the dispatch at spawn, and the reviewer rounds and completion at the
 * implementer's close. These tests drive the exported helpers against a temp repo holding a
 * stub `scripts/wo_record.py` that logs each call, so they pin the harness's side of the
 * contract: argv, stdin, order, and what a failed write does. The real tool's behaviour is
 * pinned in tfd (tests/test_wo_record.py).
 *
 * Run: bun test tests/work-record-capture.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentFactory, {
	completeWorkRecord,
	metaPath,
	openWorkRecord,
	readSessionExchange,
	recoverOrphanedSubagents,
	resolveRunningSession,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";
import { scrubSubagentEnv } from "./helpers/subagent-env.ts";

// Logs each append to calls.jsonl (ok: false when fail-on names its kind, argv[3]). `summary --json`
// answers from the accepted reviews logged so far, as the real tool does, and is not logged itself.
const STUB = `#!/usr/bin/env python3
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
log = os.path.join(root, "calls.jsonl")
if sys.argv[1] == "summary":
    entries = []
    if os.path.exists(log):
        for line in open(log):
            c = json.loads(line)
            if c["ok"] and c["argv"][2] == "review":
                entries.append({"kind": "review", "keys": {"session": c["argv"][c["argv"].index("--session") + 1]}})
    print(json.dumps({"status": "open", "entries": entries}))
    sys.exit(0)
fail = os.path.join(root, "fail-on")
refused = os.path.exists(fail) and open(fail).read().strip() == sys.argv[3]
with open(log, "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "body": sys.stdin.read(), "ok": not refused}) + "\\n")
if refused:
    print("stub refused " + sys.argv[3], file=sys.stderr)
    sys.exit(1)
`;

const WO_FILE = "work-orders/WO-2026-001-demo.md";
const WO_ID = "WO-2026-001";
const tmpDirs: string[] = [];
const tmpFiles: string[] = [];

// The spawn rows run `implement` through the tool gate, whose allowlist and
// nesting-cap reads are env-driven — so this file controls that env instead of
// inheriting whatever its runner has (pi-config#9).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function makeRepo({ script = true } = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wo-record-capture-"));
	tmpDirs.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	fs.mkdirSync(path.join(root, "work-orders"));
	fs.writeFileSync(path.join(root, WO_FILE), "# WO-2026-001 — demo\n\nbody\n");
	if (script) {
		fs.mkdirSync(path.join(root, "scripts"));
		fs.writeFileSync(path.join(root, "scripts/wo_record.py"), STUB);
	}
	return root;
}

function calls(root: string): { argv: string[]; body: string }[] {
	const file = path.join(root, "calls.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => {
		const { argv, body } = JSON.parse(l);
		return { argv, body };
	});
}

function blobOf(root: string, rel: string): string {
	return execFileSync("git", ["hash-object", "--", rel], { cwd: root, encoding: "utf-8" }).trim();
}

const ISO = "2026-10-17T10:00:00.000Z";

function sessionFile(root: string, lines: object[]): string {
	const file = path.join(root, "session.jsonl");
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

function message(id: string, message: object) {
	return { type: "message", id, parentId: null, timestamp: ISO, message };
}

/** Register a reviewer under `implementerKey`, as the reviewers registry and meta files do. */
function registerReviewer(implementerKey: string, childId: string, agent: string, sessionFileName?: string) {
	const regFile = `/tmp/pi-subagent-${implementerKey}.reviewers.json`;
	const prior = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, "utf-8")).spawns : [];
	const spawns = [...prior, { reviewerKind: "implementation", childSessionId: childId, childAgentName: agent, spawnedAt: 1 }];
	fs.writeFileSync(regFile, JSON.stringify({ spawns, reviewRounds: spawns.length, reviewCapReached: false }));
	tmpFiles.push(regFile);
	const metaFile = `/tmp/pi-subagent-${childId}.meta.json`;
	fs.writeFileSync(metaFile, JSON.stringify(sessionFileName ? { sessionFile: sessionFileName } : {}));
	tmpFiles.push(metaFile);
}

function uniqueKey(tag: string): string {
	return `subagent-${tag}-${Math.random().toString(16).slice(2, 10)}`;
}

describe("openWorkRecord — dispatch at spawn", () => {
	it("writes the dispatch with the WO file's blob sha and the task on stdin", () => {
		const root = makeRepo();
		const task = "Implement the thing.\n```\nfenced\n```";
		const { record, notes } = openWorkRecord(root, WO_FILE, "subagent-impl-1", task);
		expect(notes).toEqual([]);
		expect(record).toEqual({ cwd: root, woId: "WO-2026-001" });
		expect(calls(root)).toEqual([{
			argv: ["append", "WO-2026-001", "dispatch", "--wo_blob", blobOf(root, WO_FILE),
				"--implementer", "subagent-impl-1", "--work_order", WO_FILE],
			body: task,
		}]);
	}, 30_000);

	it("writes nothing and says nothing in a repo without wo_record.py", () => {
		const root = makeRepo({ script: false });
		expect(openWorkRecord(root, WO_FILE, "subagent-impl-1", "task")).toEqual({ notes: [] });
		expect(fs.existsSync(path.join(root, "calls.jsonl"))).toBe(false);
	}, 30_000);

	it("reports a refused write and returns no record to complete", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "fail-on"), "dispatch");
		const out = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.notes).toEqual(["work-order record not written: stub refused dispatch"]);
	}, 30_000);

	it("reports a file name with no WO-YYYY-NNN prefix without calling the tool", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "work-orders/demo.md"), "x");
		const out = openWorkRecord(root, "work-orders/demo.md", "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.notes[0]).toContain("has no WO-YYYY-NNN prefix");
		expect(calls(root)).toEqual([]);
	}, 30_000);
});

describe("completeWorkRecord — reviewer rounds, then completion", () => {
	it("writes each reviewer round in spawn order, then the completion", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		const code = sessionFile(root, [
			message("u1", { role: "user", content: "Review the code." }),
			message("a1", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] }),
			message("a2", { role: "assistant", content: [{ type: "text", text: "APPROVED" }] }),
		]);
		const tests = path.join(root, "tests-session.jsonl");
		fs.writeFileSync(tests, JSON.stringify(message("u2", { role: "user", content: [{ type: "text", text: "Review tests." }] })) + "\n"
			+ JSON.stringify(message("a3", { role: "assistant", content: [{ type: "text", text: "REJECT" }] })) + "\n");
		registerReviewer(key, "subagent-code-1", "review-code", code);
		registerReviewer(key, "subagent-tests-1", "review-tests", tests);

		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, () => "Done.\n**deviations_from_spec:** none");
		expect(notes).toEqual([]);
		const [r1, r2, done] = calls(root);
		expect(r1.argv).toEqual(["append", "WO-2026-001", "review", "--seat", "review-code", "--round", "1",
			"--session", "subagent-code-1"]);
		expect(JSON.parse(r1.body)).toEqual({ brief: "Review the code.", output: "APPROVED" });
		expect(r2.argv.slice(2, 8)).toEqual(["review", "--seat", "review-tests", "--round", "2", "--session"]);
		expect(JSON.parse(r2.body)).toEqual({ brief: "Review tests.", output: "REJECT" });
		expect(done).toEqual({ argv: ["append", "WO-2026-001", "completion", "--implementer", key],
			body: "Done.\n**deviations_from_spec:** none" });
	}, 30_000);

	it("keeps writing after a refused review and reports it", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		fs.writeFileSync(path.join(root, "fail-on"), "review");
		const code = sessionFile(root, [message("u1", { role: "user", content: "Review." }),
			message("a1", { role: "assistant", content: [{ type: "text", text: "OK" }] })]);
		registerReviewer(key, "subagent-code-2", "review-code", code);
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, () => "Done.");
		expect(notes).toEqual(["work-order record: review subagent-code-2 not written: stub refused review"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["review", "completion"]);
	}, 30_000);

	it("reports a reviewer with no session file and still writes the rest", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		registerReviewer(key, "subagent-code-3", "review-code");
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, () => "Done.");
		expect(notes).toEqual(["work-order record: review subagent-code-3 not written: no session file with a task"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["completion"]);
	}, 30_000);

	it("reports a missing final report and writes no completion", () => {
		const root = makeRepo();
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, uniqueKey("impl"), () => "  \n");
		expect(notes).toEqual(["work-order record: completion not written: implementer has no final report"]);
		expect(calls(root)).toEqual([]);
	}, 30_000);
});

describe("readSessionExchange", () => {
	it("takes the first user task and the last assistant text, skipping tool calls", () => {
		const root = makeRepo();
		const file = sessionFile(root, [
			{ type: "session", version: 3, id: "s", timestamp: ISO, cwd: root },
			message("u", { role: "user", content: [{ type: "text", text: "Brief." }, { type: "text", text: "More." }] }),
			message("a", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] }),
			message("b", { role: "assistant", content: [{ type: "text", text: "Final." }] }),
		]);
		expect(readSessionExchange(file)).toEqual({ task: "Brief.\nMore.", output: "Final." });
	}, 30_000);

	it("returns null without a user message", () => {
		const root = makeRepo();
		expect(readSessionExchange(sessionFile(root, [message("a", { role: "assistant", content: [] })]))).toBeNull();
	}, 30_000);

	it("throws on a malformed line rather than dropping part of the session", () => {
		const root = makeRepo();
		const file = path.join(root, "bad.jsonl");
		fs.writeFileSync(file, JSON.stringify(message("u", { role: "user", content: "x" })) + "\n{\"type\":");
		expect(() => readSessionExchange(file)).toThrow();
	}, 30_000);
});

// ── Resume, recovery and the execute branch ─────────────────────────────────

function stubPi() {
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

const stubCtx = (cwd: string) => ({
	cwd,
	ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
	getModel: () => undefined,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
});

/** A reviewer session file (JSONL) with one task and one final text. */
function reviewSession(file: string, task: string, output: string): string {
	fs.writeFileSync(file, [
		JSON.stringify(message("u", { role: "user", content: task })),
		JSON.stringify(message("a", { role: "assistant", content: [{ type: "text", text: output }] })),
	].join("\n") + "\n");
	return file;
}

describe("a second completion appends only the reviews the record does not hold", () => {
	it("writes the new reviewer with the next round, then the completion", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		const record = { cwd: root, woId: WO_ID };
		registerReviewer(key, "subagent-rev-a", "review-code", reviewSession(path.join(root, "a.jsonl"), "Review A.", "APPROVED"));
		expect(completeWorkRecord(record, key, () => "First report.")).toEqual([]);
		const before = calls(root).length;

		registerReviewer(key, "subagent-rev-b", "review-tests", reviewSession(path.join(root, "b.jsonl"), "Review B.", "REJECT"));
		expect(completeWorkRecord(record, key, () => "Second report.")).toEqual([]);

		const later = calls(root).slice(before);
		expect(later.map((c) => c.argv[2])).toEqual(["review", "completion"]);
		expect(later[0].argv).toEqual(["append", WO_ID, "review", "--seat", "review-tests", "--round", "2",
			"--session", "subagent-rev-b"]);
		expect(later[1].body).toBe("Second report.");
	}, 30_000);
});

class FakeSock extends EventEmitter {
	unref(): void {}
}

describe("recovery completes the record from the recovered session file", () => {
	it("appends the reviews not yet recorded, then the completion", () => {
		const root = makeRepo();
		const piId = uniqueKey("impl");
		const record = { cwd: root, woId: WO_ID };
		// Run 1 completed before the reload.
		registerReviewer(piId, "subagent-rec-a", "review-code", reviewSession(path.join(root, "a.jsonl"), "Review A.", "APPROVED"));
		completeWorkRecord(record, piId, () => "First report.");
		const before = calls(root).length;

		// Run 2: its reviewer ran before the reload, then the child finished under a recovered handle.
		registerReviewer(piId, "subagent-rec-b", "review-tests", reviewSession(path.join(root, "b.jsonl"), "Review B.", "REJECT"));
		const sid = `subagent-${randomUUID()}`;
		const runFile = reviewSession(path.join(root, "run2.jsonl"), "Rework.", "Reworked.\n\n**deviations_from_spec:**\n- Changed the approach.");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-recover-"));
		tmpDirs.push(dir);
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.sock`), "");
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.log`), "");
		fs.writeFileSync(path.join(dir, `pi-subagent-${sid}.meta.json`), JSON.stringify({
			agentName: "implement", task: "Rework.", cwd: root, startedAt: Date.now(), piSessionId: piId,
			sessionFile: runFile, ownerPid: process.pid, workRecord: record,
		}));

		const { pi } = stubPi();
		const sock = new FakeSock();
		recoverOrphanedSubagents(pi, { cwd: root }, { dir, connect: () => sock as any, selfPid: process.pid });
		sock.emit("connect");
		sock.emit("close");

		const after = calls(root).slice(before);
		expect(after.map((c) => c.argv[2])).toEqual(["review", "completion"]);
		expect(after[0].argv.slice(3, 9)).toEqual(["--seat", "review-tests", "--round", "2", "--session", "subagent-rec-b"]);
		expect(after[1].body).toBe("Reworked.\n\n**deviations_from_spec:**\n- Changed the approach.");
		expect(resolveRunningSession(sid)).toBeNull();
	}, 30_000);
});

describe("resume carries the record context from the meta", () => {
	it("sets the resumed run's record from the meta written at its original spawn", async () => {
		const root = makeRepo();
		const sid = `subagent-${randomUUID()}`;
		const sessionFile = path.join(root, "resume.jsonl");
		fs.writeFileSync(sessionFile, `{"type":"session","version":3,"id":"abc","cwd":${JSON.stringify(root)}}\n{"type":"model_change"}\n`);
		writeMetaJson(sid, { sessionFile, agentName: "implement", workRecord: { cwd: root, woId: WO_ID } });
		const { pi, tools } = stubPi();
		subagentFactory(pi);
		try {
			const res = await tools.get("subagent_resume").execute("tc", { session_id: sid, task: "continue" },
				undefined, undefined, stubCtx(root));
			expect(res.isError).toBeFalsy();
			expect(resolveRunningSession(sid)?.workRecord).toEqual({ cwd: root, woId: WO_ID });
		} finally {
			await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, stubCtx(root));
			removeArtifacts(sid);
		}
	}, 30_000);
});

/** Remove what a real spawn leaves for a handle: meta, log, socket, and its pi transcript. */
function removeArtifacts(sid: string): void {
	const files = [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`];
	const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
	try {
		for (const dir of fs.readdirSync(sessionsRoot)) {
			for (const entry of fs.readdirSync(path.join(sessionsRoot, dir))) {
				if (entry.endsWith(`_${sid}.jsonl`)) files.push(path.join(sessionsRoot, dir, entry));
			}
		}
	} catch {
		// no transcripts directory
	}
	for (const f of files) fs.rmSync(f, { force: true });
}

describe("subagent execute opens the record only for a workOrderPath spawn", () => {
	it("writes the dispatch and persists the record context; a plain spawn writes nothing", async () => {
		const root = makeRepo();
		const { pi, tools } = stubPi();
		subagentFactory(pi);
		const ctx = stubCtx(root);
		const task = "Reply with the single word: ok";
		const sids: string[] = [];
		try {
			const withOrder = await tools.get("subagent").execute("tc", {
				agent: "implement", task, cwd: root, isolate: false, review_policy: "skip", workOrderPath: WO_FILE,
			}, undefined, undefined, ctx);
			const sid = /session: (subagent-[0-9a-f-]+)/.exec(withOrder.content[0].text)![1];
			sids.push(sid);
			expect(calls(root)).toEqual([{
				argv: ["append", WO_ID, "dispatch", "--wo_blob", blobOf(root, WO_FILE), "--implementer", sid,
					"--work_order", WO_FILE],
				body: task,
			}]);
			expect(JSON.parse(fs.readFileSync(metaPath(sid), "utf-8")).workRecord).toEqual({ cwd: root, woId: WO_ID });

			const plain = await tools.get("subagent").execute("tc", {
				agent: "implement", task, cwd: root, isolate: false, review_policy: "skip",
			}, undefined, undefined, ctx);
			const plainSid = /session: (subagent-[0-9a-f-]+)/.exec(plain.content[0].text)![1];
			sids.push(plainSid);
			expect(calls(root)).toHaveLength(1);
			expect(JSON.parse(fs.readFileSync(metaPath(plainSid), "utf-8")).workRecord).toBeUndefined();
		} finally {
			for (const sid of sids) {
				await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, ctx);
				removeArtifacts(sid);
			}
		}
	}, 30_000);
});

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

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	completeWorkRecord,
	openWorkRecord,
	readSessionExchange,
} from "../extensions/subagent-async/index.ts";

// Logs each call to calls.jsonl; exits 1 when fail-on names the call's kind (argv[3]).
const STUB = `#!/usr/bin/env python3
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(root, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "body": sys.stdin.read()}) + "\\n")
fail = os.path.join(root, "fail-on")
if os.path.exists(fail) and open(fail).read().strip() == sys.argv[3]:
    print("stub refused " + sys.argv[3], file=sys.stderr)
    sys.exit(1)
`;

const WO_FILE = "work-orders/WO-2026-001-demo.md";
const tmpDirs: string[] = [];
const tmpFiles: string[] = [];

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
	return fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
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
	});

	it("writes nothing and says nothing in a repo without wo_record.py", () => {
		const root = makeRepo({ script: false });
		expect(openWorkRecord(root, WO_FILE, "subagent-impl-1", "task")).toEqual({ notes: [] });
		expect(fs.existsSync(path.join(root, "calls.jsonl"))).toBe(false);
	});

	it("reports a refused write and returns no record to complete", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "fail-on"), "dispatch");
		const out = openWorkRecord(root, WO_FILE, "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.notes).toEqual(["work-order record not written: stub refused dispatch"]);
	});

	it("reports a file name with no WO-YYYY-NNN prefix without calling the tool", () => {
		const root = makeRepo();
		fs.writeFileSync(path.join(root, "work-orders/demo.md"), "x");
		const out = openWorkRecord(root, "work-orders/demo.md", "subagent-impl-1", "task");
		expect(out.record).toBeUndefined();
		expect(out.notes[0]).toContain("has no WO-YYYY-NNN prefix");
		expect(calls(root)).toEqual([]);
	});
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

		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, "Done.\n**deviations_from_spec:** none");
		expect(notes).toEqual([]);
		const [r1, r2, done] = calls(root);
		expect(r1.argv).toEqual(["append", "WO-2026-001", "review", "--seat", "review-code", "--round", "1",
			"--session", "subagent-code-1"]);
		expect(JSON.parse(r1.body)).toEqual({ brief: "Review the code.", output: "APPROVED" });
		expect(r2.argv.slice(2, 8)).toEqual(["review", "--seat", "review-tests", "--round", "2", "--session"]);
		expect(JSON.parse(r2.body)).toEqual({ brief: "Review tests.", output: "REJECT" });
		expect(done).toEqual({ argv: ["append", "WO-2026-001", "completion", "--implementer", key],
			body: "Done.\n**deviations_from_spec:** none" });
	});

	it("keeps writing after a refused review and reports it", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		fs.writeFileSync(path.join(root, "fail-on"), "review");
		const code = sessionFile(root, [message("u1", { role: "user", content: "Review." }),
			message("a1", { role: "assistant", content: [{ type: "text", text: "OK" }] })]);
		registerReviewer(key, "subagent-code-2", "review-code", code);
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, "Done.");
		expect(notes).toEqual(["work-order record: review round 1 (subagent-code-2) not written: stub refused review"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["review", "completion"]);
	});

	it("reports a reviewer with no session file and still writes the rest", () => {
		const root = makeRepo();
		const key = uniqueKey("impl");
		registerReviewer(key, "subagent-code-3", "review-code");
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, key, "Done.");
		expect(notes).toEqual(["work-order record: review round 1 (subagent-code-3) not written: no session file with a task"]);
		expect(calls(root).map((c) => c.argv[2])).toEqual(["completion"]);
	});

	it("reports a missing final report and writes no completion", () => {
		const root = makeRepo();
		const notes = completeWorkRecord({ cwd: root, woId: "WO-2026-001" }, uniqueKey("impl"), "  \n");
		expect(notes).toEqual(["work-order record: completion not written: implementer has no final report"]);
		expect(calls(root)).toEqual([]);
	});
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
	});

	it("returns null without a user message", () => {
		const root = makeRepo();
		expect(readSessionExchange(sessionFile(root, [message("a", { role: "assistant", content: [] })]))).toBeNull();
	});

	it("throws on a malformed line rather than dropping part of the session", () => {
		const root = makeRepo();
		const file = path.join(root, "bad.jsonl");
		fs.writeFileSync(file, JSON.stringify(message("u", { role: "user", content: "x" })) + "\n{\"type\":");
		expect(() => readSessionExchange(file)).toThrow();
	});
});

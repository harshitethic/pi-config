/**
 * Unit tests for the shared read-tracking helper.
 *
 * The first describes pin behavior the checkpoint extension already had before
 * the helper existed (region merging, path normalization, preservation-boundary
 * scanning); they are the characterization rows its extraction had to preserve.
 */
import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ReadTracker,
	collectPreservedReadPaths,
	coversWholeFile,
	formatRanges,
	mergeRegions,
	normalizePath,
} from "../extensions/lib/read-tracking";

const END = Number.MAX_SAFE_INTEGER;

describe("normalizePath", () => {
	const cwd = "/repo";

	it("keeps relative paths relative to cwd", () => {
		expect(normalizePath("a.ts", cwd)).toBe("a.ts");
		expect(normalizePath("./a.ts", cwd)).toBe("a.ts");
		expect(normalizePath("sub/b.ts", cwd)).toBe("sub/b.ts");
	});

	it("collapses absolute paths inside cwd to the same key", () => {
		expect(normalizePath("/repo/a.ts", cwd)).toBe("a.ts");
		expect(normalizePath("/repo/sub/../a.ts", cwd)).toBe("a.ts");
		expect(normalizePath("sub/../a.ts", cwd)).toBe("a.ts");
	});

	it("keeps paths outside cwd absolute", () => {
		expect(normalizePath("/other/b.ts", cwd)).toBe("/other/b.ts");
		expect(normalizePath("../b.ts", cwd)).toBe("/b.ts");
	});

	it("normalizes cwd itself to '.'", () => {
		expect(normalizePath(".", cwd)).toBe(".");
	});

	it("is idempotent", () => {
		expect(normalizePath(normalizePath("sub/../a.ts", cwd), cwd)).toBe("a.ts");
	});
});

describe("mergeRegions", () => {
	it("keeps disjoint windows separate", () => {
		expect(mergeRegions([{ offset: 1, limit: 5 }, { offset: 10, limit: 3 }])).toEqual([
			{ offset: 1, endLine: 5 },
			{ offset: 10, endLine: 12 },
		]);
	});

	it("merges touching windows (no duplicated content)", () => {
		expect(mergeRegions([{ offset: 1, limit: 10 }, { offset: 11, limit: 5 }])).toEqual([
			{ offset: 1, endLine: 15 },
		]);
	});

	it("merges overlapping windows and sorts unordered input", () => {
		expect(mergeRegions([{ offset: 20, limit: 5 }, { offset: 5, limit: 10 }, { offset: 1, limit: 7 }])).toEqual([
			{ offset: 1, endLine: 14 },
			{ offset: 20, endLine: 24 },
		]);
	});

	it("absorbs a window nested inside another", () => {
		expect(mergeRegions([{ offset: 1, limit: 20 }, { offset: 5, limit: 3 }])).toEqual([
			{ offset: 1, endLine: 20 },
		]);
	});

	it("carries an unlimited read ('to end') past any file end", () => {
		const merged = mergeRegions([{ offset: 30, limit: END }, { offset: 1, limit: 10 }]);
		expect(merged).toHaveLength(2);
		expect(merged[1].offset).toBe(30);
		expect(merged[1].endLine).toBeGreaterThanOrEqual(END - 1);
	});

	it("returns no windows for no reads", () => {
		expect(mergeRegions([])).toEqual([]);
	});
});

describe("coversWholeFile / formatRanges", () => {
	it("treats only an unlimited read from line 1 as the whole file", () => {
		expect(coversWholeFile(mergeRegions([{ offset: 1, limit: END }]))).toBe(true);
		expect(coversWholeFile(mergeRegions([{ offset: 2, limit: END }]))).toBe(false);
		expect(coversWholeFile(mergeRegions([{ offset: 1, limit: 40 }]))).toBe(false);
		expect(coversWholeFile(mergeRegions([{ offset: 1, limit: 5 }, { offset: 10, limit: END }]))).toBe(false);
	});

	it("renders ranges, with an unlimited window as 'end'", () => {
		expect(formatRanges([{ offset: 1, endLine: 40 }, { offset: 50, endLine: END }])).toBe("L1-40, L50-end");
		expect(formatRanges([{ offset: 3, endLine: 7 }])).toBe("L3-7");
	});
});

describe("ReadTracker", () => {
	it("keys relative and absolute spellings of one file to one entry", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "read-tracking-"));
		try {
			await writeFile(join(cwd, "a.ts"), "line1\nline2\nline3\n");
			const reads = new ReadTracker();
			await reads.recordRead("a.ts", cwd, { offset: 1, limit: 2 });
			await reads.recordRead(join(cwd, "a.ts"), cwd, { offset: 3, limit: 1 });

			expect(reads.size).toBe(1);
			expect(reads.regionsFor("a.ts", cwd)).toHaveLength(2);
			expect(reads.fileSummaries()).toEqual([
				{ path: "a.ts", merged: [{ offset: 1, endLine: 3 }], wholeFile: false },
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("records the file's size and mtime at read time", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "read-tracking-"));
		try {
			const content = "alpha\nbeta\n";
			await writeFile(join(cwd, "a.ts"), content);
			const s = await stat(join(cwd, "a.ts"));

			const reads = new ReadTracker();
			await reads.recordRead("a.ts", cwd, { offset: 1, limit: END });

			const region = reads.regionsFor("a.ts", cwd)?.[0];
			expect(region?.size).toBe(content.length);
			expect(region?.mtimeMs).toBe(s.mtimeMs);
			expect(reads.fileSummaries()[0].wholeFile).toBe(true);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("records a read of a vanished file without a stat identity", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "read-tracking-"));
		try {
			const reads = new ReadTracker();
			await reads.recordRead("gone.ts", cwd, { offset: 1, limit: 5 });
			expect(reads.regionsFor("gone.ts", cwd)).toEqual([
				{ offset: 1, limit: 5, size: undefined, mtimeMs: undefined },
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keys are cwd-relative, so a cwd switch needs an explicit clear", async () => {
		// Same relative path under two cwds collides to one key: nothing in the
		// key distinguishes the sessions, which is why the extension clears the
		// tracker on session_start (a fork switches cwd mid-process).
		const reads = new ReadTracker();
		await reads.recordRead("a.ts", "/one", { offset: 1, limit: 1 });
		await reads.recordRead("a.ts", "/two", { offset: 2, limit: 1 });
		expect(reads.size).toBe(1);
		expect(reads.regionsFor("a.ts", "/two")).toHaveLength(2);

		reads.clear();
		expect(reads.size).toBe(0);
		expect(reads.regionsFor("a.ts", "/one")).toBeUndefined();
	});
});

describe("collectPreservedReadPaths", () => {
	const readCall = (path: string) => ({
		id: "",
		type: "message",
		message: { role: "assistant", content: [{ type: "tool_use", name: "read", input: { path } }] },
	});
	const entry = (id: string, path: string) => ({ ...readCall(path), id });

	it("collects only reads at or after the preservation boundary", () => {
		const entries = [
			entry("e1", "before.ts"),
			entry("e2", "kept.ts"),
			{ id: "e3", type: "message", message: { role: "toolResult", toolCallId: "t1" } },
			entry("e4", "later.ts"),
		];
		const paths = collectPreservedReadPaths(entries, "e2", "/repo");
		expect([...paths].sort()).toEqual(["kept.ts", "later.ts"]);
	});

	it("normalizes the collected paths against cwd", () => {
		const paths = collectPreservedReadPaths([entry("e1", "/repo/sub/../a.ts")], "e1", "/repo");
		expect([...paths]).toEqual(["a.ts"]);
	});

	it("collects nothing when the boundary is absent", () => {
		expect(collectPreservedReadPaths([entry("e1", "a.ts")], "missing", "/repo").size).toBe(0);
	});

	it("ignores non-read tool calls and non-assistant entries", () => {
		const entries = [
			{ id: "e1", type: "message", message: { role: "user", content: [{ type: "tool_use", name: "read", input: { path: "u.ts" } }] } },
			{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { path: "b.ts" } }] } },
		];
		expect(collectPreservedReadPaths(entries, "e1", "/repo").size).toBe(0);
	});
});

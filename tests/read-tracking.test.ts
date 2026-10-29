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
	selectFreshRegions,
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
	// pi's session-entry shape: assistant tool calls are `toolCall`/`arguments`.
	const readCall = (path: string) => ({
		id: "",
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }],
		},
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
			{ id: "e1", type: "message", message: { role: "user", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "u.ts" } }] } },
			{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { path: "b.ts" } }] } },
		];
		expect(collectPreservedReadPaths(entries, "e1", "/repo").size).toBe(0);
	});

	it("matches nothing for the wire-adapter block shape (tool_use/input)", () => {
		const entries = [
			{ id: "e1", type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "read", input: { path: "a.ts" } }] } },
		];
		expect(collectPreservedReadPaths(entries, "e1", "/repo").size).toBe(0);
	});
});

describe("ReadTracker.recordToolResult", () => {
	const result = (over: Record<string, unknown> = {}) => ({
		toolName: "read",
		isError: false,
		input: { path: "a.ts", offset: 3, limit: 7 },
		...over,
	});

	it("takes path/offset/limit from the finalized input, with the file's stat", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "read-tracking-"));
		try {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\nfour\nfive\n");
			const reads = new ReadTracker();
			await reads.recordToolResult(result(), cwd);

			const regions = reads.regionsFor("a.ts", cwd);
			expect(regions).toHaveLength(1);
			expect(regions?.[0].offset).toBe(3);
			expect(regions?.[0].limit).toBe(7);
			expect(regions?.[0].size).toBe(24);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("defaults an unqualified read to line 1 to end", async () => {
		const reads = new ReadTracker();
		await reads.recordToolResult(result({ input: { path: "a.ts" } }), "/repo");
		expect(reads.regionsFor("a.ts", "/repo")).toEqual([
			{ offset: 1, limit: END, size: undefined, mtimeMs: undefined },
		]);
	});

	it("coerces an unusable offset to line 1 (the read tool validates it upstream)", async () => {
		const reads = new ReadTracker();
		for (const offset of [0, -3, Number.NaN, "7"]) {
			await reads.recordToolResult(result({ input: { path: "a.ts", offset, limit: 5 } }), "/repo");
		}
		expect(reads.regionsFor("a.ts", "/repo")?.map((r) => r.offset)).toEqual([1, 1, 1, 1]);
	});

	it("keeps a zero limit as an empty window and defaults a nonsensical one to 'to end'", async () => {
		const reads = new ReadTracker();
		await reads.recordToolResult(result({ input: { path: "a.ts", limit: 0 } }), "/repo");
		await reads.recordToolResult(result({ input: { path: "a.ts", limit: Number.POSITIVE_INFINITY } }), "/repo");
		expect(reads.regionsFor("a.ts", "/repo")).toEqual([
			{ offset: 1, limit: 0, size: undefined, mtimeMs: undefined },
			{ offset: 1, limit: END, size: undefined, mtimeMs: undefined },
		]);
	});

	it("ignores error results, other tools, and pathless inputs", async () => {
		const reads = new ReadTracker();
		await reads.recordToolResult(result({ isError: true }), "/repo");
		await reads.recordToolResult(result({ toolName: "bash" }), "/repo");
		await reads.recordToolResult(result({ input: {} }), "/repo");
		await reads.recordToolResult(result({ input: { path: 42 } }), "/repo");
		expect(reads.size).toBe(0);
	});
});

describe("selectFreshRegions", () => {
	const region = (size: number, mtimeMs: number) => ({ offset: 1, limit: 5, size, mtimeMs });

	it("keeps windows whose file identity matches the current snapshot", () => {
		const fresh = region(10, 1000);
		expect(selectFreshRegions([fresh], { size: 10, mtimeMs: 1000 })).toEqual([fresh]);
	});

	it("drops a window when the file grew, shrank, or was rewritten", () => {
		const before = region(10, 1000);
		expect(selectFreshRegions([before], { size: 12, mtimeMs: 2000 })).toEqual([]);
		expect(selectFreshRegions([before], { size: 10, mtimeMs: 2000 })).toEqual([]);
	});

	it("drops a window recorded without a stat: it can never be proven fresh", () => {
		expect(selectFreshRegions([{ offset: 1, limit: 5 }], { size: 10, mtimeMs: 1000 })).toEqual([]);
	});
});

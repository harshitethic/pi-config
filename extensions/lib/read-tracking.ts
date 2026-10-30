/**
 * Read-window tracking shared by the checkpoint extensions.
 *
 * Records which line windows of which files the model read this session, keyed
 * by path normalized relative to a cwd. `checkpoint.ts` uses the windows to
 * decide what file content to re-inject after compaction; `auto-checkpoint.ts`
 * uses them for its nudge's file hints.
 *
 * This is the one module that maps pi's shapes to read windows. Finalized read
 * args arrive on `tool_result.input` (`tool_execution_end` carries no args at
 * all), and session entries hold assistant tool calls as
 * `{type:"toolCall", name, arguments}` — `tool_use`/`input` exists only in pi's
 * Anthropic wire adapter, never in a session entry.
 *
 * No pi runtime imports — this module must stay unit-testable.
 */
import { stat } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";

/** One read window, 1-based inclusive start line plus the line count requested. */
export interface ReadRegion {
	offset: number;
	/** Number of lines requested; Number.MAX_SAFE_INTEGER means "read to end". */
	limit: number;
	/** File size in bytes at read time (undefined when the stat failed). */
	size?: number;
	/** File mtime in ms since epoch at read time (undefined when the stat failed). */
	mtimeMs?: number;
}

/** A read window after merging, with an inclusive end line. */
export interface MergedRegion {
	offset: number;
	endLine: number;
}

/** A file's merged read windows, as consumed by hint/injection formatting. */
export interface FileReadSummary {
	path: string;
	merged: MergedRegion[];
	/** True when one window runs from line 1 to the end of the file. */
	wholeFile: boolean;
}

/**
 * Normalize a path relative to `cwd` so absolute and relative spellings of the
 * same file share one key. Paths outside `cwd` stay absolute.
 */
export function normalizePath(filePath: string, cwd: string): string {
	const absolute = resolvePath(cwd, filePath);
	const rel = relative(cwd, absolute);
	return rel.startsWith("..") ? absolute : rel || ".";
}

/**
 * Merge overlapping/adjacent windows to minimise duplicated content.
 * Adjacent (touching) windows merge, so a run of single-line reads is one block.
 */
export function mergeRegions(regions: readonly ReadRegion[]): MergedRegion[] {
	const sorted = regions
		.map((r) => ({ offset: r.offset, endLine: r.offset + r.limit - 1 }))
		.sort((a, b) => a.offset - b.offset);

	const merged: MergedRegion[] = [];
	for (const r of sorted) {
		const prev = merged[merged.length - 1];
		if (prev && r.offset <= prev.endLine + 1) {
			prev.endLine = Math.max(prev.endLine, r.endLine);
		} else {
			merged.push({ ...r });
		}
	}
	return merged;
}

/** True when the windows run from line 1 past any plausible file end (an unlimited read). */
export function coversWholeFile(merged: readonly MergedRegion[]): boolean {
	return (
		merged.length === 1 &&
		merged[0].offset === 1 &&
		merged[0].endLine >= Number.MAX_SAFE_INTEGER - 1
	);
}

/** Render merged windows as `L1-40, L50-end`. */
export function formatRanges(merged: readonly MergedRegion[]): string {
	return merged
		.map((r) => (r.endLine >= Number.MAX_SAFE_INTEGER - 1 ? `L${r.offset}-end` : `L${r.offset}-${r.endLine}`))
		.join(", ");
}

/** File identity captured when a read was tracked. */
export interface FileSnapshot {
	mtimeMs: number;
	size: number;
}

/** A finalized tool result, as pi delivers it on the `tool_result` event. */
export interface ToolResultLike {
	toolName: string;
	isError: boolean;
	input: Record<string, unknown>;
}

/** 1-based start line, matching the read tool: absent or < 1 means line 1. */
function startLine(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** Requested line count, matching the read tool: absent means "to end of file". */
function lineCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.floor(value)
		: Number.MAX_SAFE_INTEGER;
}

/**
 * Windows whose read-time identity still matches `snapshot` (size and mtime).
 * A window recorded without a stat can never be proven fresh, so it is dropped:
 * naming the file for a re-read beats serving a stale line range.
 */
export function selectFreshRegions(
	regions: readonly ReadRegion[],
	snapshot: FileSnapshot,
): ReadRegion[] {
	return regions.filter((r) => r.size === snapshot.size && r.mtimeMs === snapshot.mtimeMs);
}

/** Per-file read windows, keyed by {@link normalizePath}. */
export class ReadTracker {
	private readonly files = new Map<string, ReadRegion[]>();

	/** Number of distinct files with at least one tracked read. */
	get size(): number {
		return this.files.size;
	}

	clear(): void {
		this.files.clear();
	}

	/** Track that `filePath` was read from `cwd`, capturing the file's stat for staleness checks. */
	async recordRead(
		filePath: string,
		cwd: string,
		region: { offset: number; limit: number },
	): Promise<void> {
		const key = normalizePath(filePath, cwd);
		let size: number | undefined;
		let mtimeMs: number | undefined;
		try {
			const s = await stat(resolvePath(cwd, filePath));
			size = s.size;
			mtimeMs = s.mtimeMs;
		} catch {
			// Record without a stat identity: the window can never be proven fresh.
		}
		const regions = this.files.get(key) ?? [];
		regions.push({ offset: region.offset, limit: region.limit, size, mtimeMs });
		this.files.set(key, regions);
	}

	/** Track a read from a finalized `tool_result` event. */
	async recordToolResult(event: ToolResultLike, cwd: string): Promise<void> {
		if (event.toolName !== "read" || event.isError) return;
		const filePath = event.input?.path;
		if (typeof filePath !== "string" || filePath.length === 0) return;
		await this.recordRead(filePath, cwd, {
			offset: startLine(event.input.offset),
			limit: lineCount(event.input.limit),
		});
	}

	/** Windows tracked for `filePath`, or undefined when it was never read. */
	regionsFor(filePath: string, cwd: string): ReadRegion[] | undefined {
		return this.files.get(normalizePath(filePath, cwd));
	}

	/** Every tracked file with its merged windows, in first-read order. */
	fileSummaries(): FileReadSummary[] {
		const out: FileReadSummary[] = [];
		for (const [path, regions] of this.files) {
			const merged = mergeRegions(regions);
			out.push({ path, merged, wholeFile: coversWholeFile(merged) });
		}
		return out;
	}
}

/**
 * Collect the paths of files whose `read` tool calls survive the compaction
 * boundary (`firstKeptEntryId` and later) — those files are still in the
 * model's context, so re-injecting them would duplicate content.
 *
 * Pass the compacting branch's entries: off-branch reads are not in context, so
 * counting them would skip a file the model can no longer see.
 */
export function collectPreservedReadPaths(
	entries: ReadonlyArray<{ id: string; type: string; message?: any }>,
	firstKeptEntryId: string,
	cwd: string,
): Set<string> {
	const paths = new Set<string>();
	let found = false;
	for (const entry of entries) {
		if (entry.id === firstKeptEntryId) found = true;
		if (!found) continue;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const block of entry.message.content ?? []) {
			if (block?.type !== "toolCall" || block.name !== "read") continue;
			const rawPath = block.arguments?.path;
			if (typeof rawPath !== "string") continue;
			paths.add(normalizePath(rawPath, cwd));
		}
	}
	return paths;
}

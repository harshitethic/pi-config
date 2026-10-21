/**
 * Read-window tracking shared by the checkpoint extensions.
 *
 * Records which line windows of which files the model read this session, keyed
 * by path normalized relative to a cwd. `checkpoint.ts` uses the windows to
 * decide what file content to re-inject after compaction; `auto-checkpoint.ts`
 * uses them for its nudge's file hints.
 *
 * No pi runtime imports (types only) — this module must stay unit-testable.
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
			if (block?.type !== "tool_use" || block.name !== "read") continue;
			const rawPath = block.input?.path;
			if (typeof rawPath !== "string") continue;
			paths.add(normalizePath(rawPath, cwd));
		}
	}
	return paths;
}

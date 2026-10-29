/**
 * Checkpoint git binding and token accounting, shared by the checkpoint flows.
 *
 * `checkpoint.ts` writes a JSONL archive plus one meta record beside it. This
 * module supplies what that meta records about the world the checkpoint was
 * taken in: the git binding of the working tree, the token counts around the
 * compaction, the meta path derivation, and the post-compaction patch that
 * merges `tokens.after` into the already-written meta. The meta object itself
 * is still composed at its one site in `checkpoint.ts` — this is not a second
 * meta builder.
 *
 * Two orderings are load-bearing. Git is captured *before* the archive write,
 * or the archive's own untracked files read as `dirty` (WO-2026-056 row S8).
 * `tokens.after` is patched from `ctx.compact(...).onComplete`, because pi
 * exposes `estimatedTokensAfter` only there — the timing is pi's API shape, not
 * a defect to be hoisted back into `execute` (WO-2026-056 landing stamp).
 *
 * Type-only pi import — this module must stay unit-testable.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The working tree a checkpoint was taken from (dual-state alignment, sanity-check §3 row 4). */
export interface GitBinding {
	head: string;
	branch: string;
	dirty: boolean;
}

/**
 * Token counts around the compaction: pi's context estimate before it, its
 * post-compaction estimate after. Either can be null — pi returns null when it
 * cannot estimate (documented: right after a compaction, before the next LLM
 * response), and the post count only exists once compaction completes.
 */
export interface CheckpointTokens {
	before: number | null;
	after: number | null;
}

/** A hung git must never hold a checkpoint: every call is bounded. */
const GIT_TIMEOUT_MS = 2000;

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolveGit, rejectGit) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			if (err) rejectGit(err);
			else resolveGit(stdout.trim());
		});
	});
}

/**
 * Bind the archive to the working tree it was taken from. Capture this *before*
 * writing the archive, or the archive's own untracked files read as `dirty`.
 * Any failure — not a repo, no git binary, timeout — yields null: git never
 * fails or delays a checkpoint (same tolerance as the archive-failure path).
 */
export async function captureGitBinding(cwd: string): Promise<GitBinding | null> {
	try {
		const [head, branch, status] = await Promise.all([
			runGit(cwd, ["rev-parse", "HEAD"]),
			runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
			runGit(cwd, ["status", "--porcelain"]),
		]);
		return { head, branch, dirty: status.length > 0 };
	} catch {
		return null;
	}
}

/** pi's own estimate of the live context, or null when it has none. */
export function tokensBefore(ctx: ExtensionContext): number | null {
	return ctx.getContextUsage()?.tokens ?? null;
}

/** ` Tokens: 120,000 → 3,400 (-116,600)`, or before/after alone when one is all pi has. */
export function renderTokenDelta(tokens: CheckpointTokens): string {
	const { before, after } = tokens;
	if (before === null && after === null) return "";
	if (before === null) return ` Tokens: ${after!.toLocaleString()}`;
	if (after === null) return ` Tokens: ${before.toLocaleString()}`;
	const delta = after - before;
	return (
		` Tokens: ${before.toLocaleString()} → ${after.toLocaleString()} ` +
		`(${delta > 0 ? "+" : ""}${delta.toLocaleString()})`
	);
}

/** An archive's meta record sits beside it, same basename. */
export function metaPathFor(archivePath: string): string {
	return archivePath.replace(/\.jsonl$/, ".meta.json");
}

/**
 * Merge pi's post-compaction token estimate into an already-written meta. The
 * archive and its meta are written before `ctx.compact()` — they have to
 * survive a failed compaction — and `estimatedTokensAfter` only exists once
 * compaction completes, so the two numbers land in the one meta object in two
 * steps. Observability only: a failure here never fails a completed checkpoint.
 */
export async function recordTokensAfter(archivePath: string | undefined, tokens: CheckpointTokens): Promise<void> {
	if (!archivePath) return;
	const metaPath = metaPathFor(archivePath);
	const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
	await writeFile(metaPath, JSON.stringify({ ...meta, tokens }, null, 2), "utf8");
}

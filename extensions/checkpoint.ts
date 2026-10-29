import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { AgentMessage, AssistantMessage } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	type CompactionResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setPendingGo } from "./go.ts";
import {
	captureGitBinding,
	metaPathFor,
	recordTokensAfter,
	renderTokenDelta,
	tokensBefore,
	type CheckpointTokens,
	type GitBinding,
} from "./lib/checkpoint-meta.ts";
import { validateNextStepsOwnerState } from "./lib/owner-row.ts";
import {
	ReadTracker,
	collectPreservedReadPaths,
	formatRanges,
	mergeRegions,
	normalizePath,
	selectFreshRegions,
} from "./lib/read-tracking.ts";
import { listInFlightSubagents, type InFlightSubagent } from "./lib/subagent-state.ts";

const CHECKPOINT_DIR = ".pi/checkpoints";
const MARKER = "[CHECKPOINT]";

// Fraction of context window to use for file injection (15%).
const INJECTION_BUDGET_FRACTION = 0.15;

// ---------------------------------------------------------------------------
// Summary schema + rendering
// ---------------------------------------------------------------------------

/**
 * The fixed summary schema both checkpoint tools accept (sanity-check §3 row 5,
 * §6 item 4). Kept verbatim in the archive meta as `summaryFields`.
 */
interface SummaryFields {
	goal: string;
	filesTouched: string[];
	decisions: string[];
	triedAndFailed: string[];
	constraints: string;
}

const SUMMARY_FORMAT_HINT =
	"`summary` is an object and every field is required: " +
	"`goal` (one paragraph: what this checkpoint is accomplishing), " +
	"`filesTouched` (repo-relative paths), " +
	"`decisions` (choices made, with why), " +
	"`triedAndFailed` (each entry names an approach tried, what happened, and why it failed — " +
	"the fresh window retries what it is not told about), " +
	"`constraints` (limits the next window must respect). " +
	'Empty means the literal "none"/["none"], never an omitted field.';

/** Every field required: presence is the point, so the typebox schema enforces it. */
const SUMMARY_SCHEMA = Type.Object(
	{
		goal: Type.String({
			description: "One paragraph: what this checkpoint is accomplishing.",
		}),
		filesTouched: Type.Array(Type.String(), {
			description: "Repo-relative paths touched.",
		}),
		decisions: Type.Array(Type.String(), {
			description: 'Choices made and why. ["none"] when none.',
		}),
		triedAndFailed: Type.Array(Type.String(), {
			description:
				"Each entry: an approach tried, what happened, and why it failed. " +
				'The next window retries what it is not told about. ["none"] when none.',
		}),
		constraints: Type.String({
			description: 'Limits the next window must respect. "none" when none.',
		}),
	},
	{ description: SUMMARY_FORMAT_HINT },
);

const NONE = "none";

/** `"none"`/`["none"]`/`[]` all mean "nothing to report". */
function isNone(items: string[]): boolean {
	return items.length === 0 || (items.length === 1 && items[0].trim().toLowerCase() === NONE);
}

/** `label: none`, or the label followed by one bullet per entry. */
function bulletSection(label: string, items: string[]): string {
	if (isNone(items)) return `${label}: ${NONE}`;
	return `${label}:\n${items.map((item) => `  - ${item}`).join("\n")}`;
}

/**
 * The canonical summary text. Its three consumers — the compaction
 * `customInstructions`, `meta.summary`, and `checkpoint_fork`'s seeded message —
 * all call this; none formats its own copy.
 */
function renderSummary(fields: SummaryFields, nextSteps: string): string {
	return [
		`Goal: ${fields.goal}`,
		`Files touched: ${isNone(fields.filesTouched) ? NONE : fields.filesTouched.join(", ")}`,
		bulletSection("Decisions", fields.decisions),
		bulletSection("Tried and failed (and why)", fields.triedAndFailed),
		`Constraints: ${fields.constraints || NONE}`,
		`Next: ${nextSteps}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelevantPathEntry {
	path: string;
}

/** Everything an archive records besides the transcript itself. */
interface ArchiveMetaExtras {
	summaryFields: SummaryFields | null;
	tokens: CheckpointTokens;
	git: GitBinding | null;
	/** Set by `checkpoint_fork`: the cwd the new session lands in. */
	newCwd?: string;
}

/** State passed from checkpoint tool → compaction hook → onComplete callback. */
interface PendingCheckpoint {
	/** `composeSummary` output — the text the fresh window receives verbatim. */
	summary: string;
	next: string;
	doContinue: boolean;
	tokens: CheckpointTokens;
	archivePath?: string;
	relevantPaths: RelevantPathEntry[];
	cwd: string;
	contextWindow: number;
	injection?: { text: string; omitted: string[]; skippedPreserved: string[] };
}

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

/** Files read this session, keyed by normalized relative-to-cwd path. */
const reads = new ReadTracker();

/** Pending checkpoint data that bridges execute() → session_before_compact → onComplete. */
let pendingCheckpoint: PendingCheckpoint | null = null;

/**
 * True once the checkpoint tool has stashed a request and the turn's tool
 * results have not yet settled. `turn_end` consumes it: a later checkpoint
 * call in the same turn replaces the data but only one compaction fires.
 */
let compactRequested = false;

// ---------------------------------------------------------------------------
// In-flight subagent record (R3-1)
// ---------------------------------------------------------------------------

/**
 * The machine-built "In-flight subagents" section appended to every archived
 * summary. Sourced read-only from the subagent meta registry (tfd
 * process-controls R3, owner 2026-10-19) — never from the model's summary, so
 * work in flight cannot be lost by an omission in the prose. Empty registry
 * (or no running/orphaned child) means no section.
 */
export function formatInFlightSection(entries: InFlightSubagent[]): string {
	if (entries.length === 0) return "";
	const lines = ["### In-flight subagents", "_Recorded by the checkpoint tool from the subagent meta registry._"];
	for (const e of entries) {
		const agent = e.agentName ? ` (${e.agentName})` : "";
		const branch = e.branch ? `branch \`${e.branch}\`` : "no worktree branch";
		lines.push(`- \`${e.sid}\`${agent} — ${branch} — state: ${e.state} (${e.evidence})`);
		if (e.resumeCall) lines.push(`  - resumable: \`${e.resumeCall}\``);
	}
	return lines.join("\n");
}

/** The stored summary: the model's three-part summary plus the machine section. */
function composeSummary(summary: string, section: string): string {
	return section ? `${summary}\n\n${section}` : summary;
}

/**
 * R6 (tfd process-controls, owner 2026-10-19): `nextSteps` states owner state
 * only by registry row id. `error` is the tool-error result for a violating
 * claim (the tool call lands nothing); `warning` is the existence lookup's
 * degradation when the repo's registry script cannot run — non-blocking, but
 * carried onto the tool result and a `ui.notify` warning so it is never silent.
 */
function checkOwnerState(
	nextSteps: string,
	cwd: string,
): { error?: { content: Array<{ type: "text"; text: string }>; isError: true }; warning?: string } {
	const verdict = validateNextStepsOwnerState(nextSteps, cwd);
	if (verdict.ok) return { warning: verdict.warning };
	return {
		error: {
			content: [{ type: "text" as const, text: `Error: ${verdict.error}` }],
			isError: true,
		},
	};
}

/** Test hook: scan this directory for the meta registry instead of /tmp. */
let inflightScanDirOverride: string | undefined;
export function _testSetInflightScanDir(dir: string | undefined): void {
	inflightScanDirOverride = dir;
}

// ---------------------------------------------------------------------------
// File injection
// ---------------------------------------------------------------------------

function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * One line saying what the injected block is: content re-read from disk at
 * checkpoint time, line ranges picked from an earlier read.
 */
const SNAPSHOT_LABEL =
	"[Disk snapshot taken at checkpoint time — line ranges were selected from an earlier read, so line numbers may have shifted.]";

/**
 * Read file contents for each entry in `relevantPaths`, skipping files that
 * are already preserved in the compacted context.
 *
 * Only the lines actually read this session are injected — if the whole file
 * was read the whole file goes through.  Files with no tracked read regions
 * are skipped entirely.  Windows whose file changed since the read are never
 * served: their line numbers described an older version, so the file is named
 * for a re-read instead.
 */
async function buildFileInjection(
	relevantPaths: RelevantPathEntry[],
	cwd: string,
	contextWindow: number,
	preserved: Set<string>,
): Promise<{ text: string; omitted: string[]; skippedPreserved: string[] }> {
	if (relevantPaths.length === 0) return { text: "", omitted: [], skippedPreserved: [] };

	const budget = Math.round(contextWindow * INJECTION_BUDGET_FRACTION);
	const parts: string[] = [];
	const omitted: string[] = [];
	const skippedPreserved: string[] = [];
	const changed: string[] = [];
	let used = 0;

	for (const entry of relevantPaths) {
		const key = normalizePath(entry.path, cwd);

		// Skip files already in the preserved context tail — the model
		// already has whatever lines it read during the preserved turns.
		if (preserved.has(key)) {
			skippedPreserved.push(entry.path);
			continue;
		}

		// No read regions tracked → nothing to inject, skip entirely.
		const regions = reads.regionsFor(entry.path, cwd);
		if (!regions || regions.length === 0) continue;

		// -- Read and format file content (matching read-tool output format) -
		const absolutePath = resolvePath(cwd, entry.path);
		let content: string;

		try {
			const [raw, snapshot] = await Promise.all([
				readFile(absolutePath, "utf-8"),
				stat(absolutePath),
			]);

			// A window read from another version of the file describes line
			// numbers that no longer hold, so it is dropped rather than served.
			const fresh = selectFreshRegions(regions, snapshot);
			if (fresh.length === 0) {
				changed.push(entry.path);
				continue;
			}
			if (fresh.length < regions.length) changed.push(entry.path);

			const merged = mergeRegions(fresh);
			const rawLines = raw.split("\n");
			const totalLines = rawLines.length;
			// Single region covering the whole file → no continuation hints.
			const isFullFile = merged.length === 1 && merged[0].offset === 1 && merged[0].endLine >= totalLines;
			const chunks: string[] = [];
			for (const r of merged) {
				const start = Math.max(0, r.offset - 1);
				const end = Math.min(rawLines.length, r.endLine);
				if (start >= end) continue;
				chunks.push(rawLines.slice(start, end).join("\n"));
				if (!isFullFile && end < totalLines) {
					chunks.push(`[L${r.offset}-${end} of ${totalLines} lines. offset=${end + 1} for more.]`);
				}
			}
			content = chunks.join("\n\n");
		} catch {
			continue;
		}

		const tokens = estimateTokens(content);
		const block = `[${entry.path}]\n${content}`;
		const blockTokens = estimateTokens(block);

		if (used + blockTokens > budget) {
			omitted.push(entry.path);
			continue;
		}

		parts.push(block);
		used += blockTokens;
	}

	let text = parts.length > 0 ? `${SNAPSHOT_LABEL}\n${parts.join("\n\n")}` : "";

	const notes: string[] = [];
	if (skippedPreserved.length > 0) {
		notes.push(
			`${skippedPreserved.length} file(s) already in preserved context — skipped: ${skippedPreserved.join(", ")}. `,
		);
	}
	if (omitted.length > 0) {
		notes.push(
			`${parts.length} of ${relevantPaths.length} files included ` +
			`(budget: ${budget.toLocaleString()} tokens, ~${Math.round(INJECTION_BUDGET_FRACTION * 100)}% of context window). ` +
			`Omitted: ${omitted.join(", ")}. Use read tool if needed.`,
		);
	}
	if (changed.length > 0) {
		notes.push(
			`${changed.length} file(s) changed since read — re-read if needed: ${changed.join(", ")}. `,
		);
	}
	if (notes.length > 0) {
		text = text ? `${text}\n\n[${notes.join(" ")}]` : `[${notes.join(" ")}]`;
	}

	return { text, omitted, skippedPreserved };
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

/** Drop thinking blocks from assistant messages. Archives are for reference, not API replay. */
function stripThinking(msg: AssistantMessage): AssistantMessage {
	const filtered = msg.content.filter((b) => b.type !== "thinking");
	return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Write session entries to a JSONL archive, plus the single meta record beside it. */
async function archiveSession(
	cwd: string,
	entries: unknown[],
	summary: string,
	sessionId: string | undefined,
	extras: ArchiveMetaExtras,
): Promise<string> {
	const archiveDir = join(cwd, CHECKPOINT_DIR);
	await mkdir(archiveDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const sid = sessionId ? `${sessionId}-` : "";
	const archivePath = join(archiveDir, `session-${sid}${ts}.jsonl`);

	const lines: string[] = [];
	for (const entry of entries as Array<{ type: string; message?: AgentMessage }>) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			lines.push(JSON.stringify({ ...entry, message: stripThinking(entry.message) }));
		} else {
			lines.push(JSON.stringify(entry));
		}
	}
	await writeFile(archivePath, lines.join("\n") + "\n", "utf8");

	const metaPath = metaPathFor(archivePath);
	await writeFile(
		metaPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				sessionId,
				archivePath,
				summary,
				entryCount: entries.length,
				summaryFields: extras.summaryFields,
				tokens: extras.tokens,
				git: extras.git,
				...(extras.newCwd ? { newCwd: extras.newCwd } : {}),
			},
			null,
			2,
		),
		"utf8",
	);
	return archivePath;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -- Read tracking ---------------------------------------------------
	pi.on("session_start", () => {
		reads.clear();
		pendingCheckpoint = null;
		compactRequested = false;
	});

	// Finalized read args arrive here, on `input`. `tool_execution_end` carries
	// no args at all, so tracking from it recorded nothing (WO-2026-055).
	pi.on("tool_result", async (event, ctx) => {
		await reads.recordToolResult(event, ctx.cwd);
	});

	// -- Compaction trigger ----------------------------------------------
	// The checkpoint tool only stashes its request in execute(); compaction is
	// triggered here, at the turn-end boundary. The SDK emits `turn_end` from
	// agent-loop's runLoop *after* every tool result message has been emitted
	// (message_end → SessionManager.appendMessage) and pushed into context, so
	// the checkpoint call's own result is already persisted and no sibling tool
	// execution is still in flight. Compacting from inside execute() instead
	// disconnected the agent mid-batch, so the checkpoint result was never
	// persisted and a late tool result attached to the compaction entry — the
	// orphan-toolResult defect this guards against.
	pi.on("turn_end", (_event, ctx) => {
		if (!compactRequested) return;
		compactRequested = false;
		// Snapshot: onComplete/onError own clearing the pending data. A later
		// checkpoint call replaces it before this fires (last request wins).
		const pending = pendingCheckpoint;
		ctx.compact({
			customInstructions: `${MARKER}\n${pending?.summary ?? ""}`,
			onComplete: async (result: CompactionResult) => {
				const inj = pending?.injection;
				const tokens: CheckpointTokens = {
					before: result?.tokensBefore ?? pending?.tokens.before ?? null,
					after: result?.estimatedTokensAfter ?? null,
				};
				pendingCheckpoint = null;

				// Notify and continuation run before the meta patch below: pi does
				// not await this callback, and a checkpoint's user-visible outcome
				// must not wait on an archive write. The outer catch keeps a throw
				// visible as "Checkpoint failed" — pi's compaction wrapper only sees
				// synchronous throws from this callback.
				try {
					try {
						const archiveLine = pending?.archivePath ? `\nArchive: ${pending.archivePath}` : "";
						ctx.ui.notify(
							`Checkpoint complete — context cleared.${renderTokenDelta(tokens)}${archiveLine}`,
							"info",
						);
					} catch { /* ctx stale after reload */ }
					if (pending?.doContinue) {
						const parts = [pending.next];
						if (inj?.text) parts.unshift(inj.text);
						if (pending.archivePath) parts.push(`Archive: ${pending.archivePath}`);
						const followUp = parts.join("\n\n");
						pi.sendUserMessage(followUp, { deliverAs: "followUp" });
					}
				} catch (err) {
					try {
						ctx.ui.notify(
							`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					} catch { /* ctx stale after reload */ }
				}

				try {
					await recordTokensAfter(pending?.archivePath, tokens);
				} catch { /* meta gone — the notify already carries the delta */ }
			},
			onError: (err) => {
				pendingCheckpoint = null;
				try {
					ctx.ui.notify(`Checkpoint failed: ${err.message}`, "error");
				} catch { /* ctx stale after reload */ }
			},
		});
	});

	// -- Compaction hook -------------------------------------------------
	pi.on("session_before_compact", async (event, ctx) => {
		const { customInstructions, preparation } = event;

		if (customInstructions?.includes(MARKER)) {
			const summary = customInstructions.replace(MARKER, "").trim();

			// Read and inject files now that we know the preservation boundary.
			if (pendingCheckpoint) {
				// Scope the scan to the entries being compacted: `getEntries()` also
				// holds off-branch reads, which are not in the model's context and
				// would wrongly suppress injection.
				const entries = event.branchEntries ?? ctx.sessionManager.getEntries();
				const preserved = collectPreservedReadPaths(
					entries,
					preparation.firstKeptEntryId,
					ctx.cwd,
				);
				pendingCheckpoint.injection = await buildFileInjection(
					pendingCheckpoint.relevantPaths,
					pendingCheckpoint.cwd,
					pendingCheckpoint.contextWindow,
					preserved,
				);
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		}

		// Auto-compaction (not from checkpoint tool): archive independently.
		const autoSummary = `Auto-archived before compaction (${preparation.tokensBefore.toLocaleString()} tokens)`;
		try {
			const archivePath = await archiveSession(
				ctx.cwd,
				ctx.sessionManager.getEntries(),
				autoSummary,
				ctx.sessionManager.getSessionId(),
				{
					// No authored summary here — the auto path has no schema fields.
					summaryFields: null,
					tokens: { before: preparation.tokensBefore, after: null },
					git: await captureGitBinding(ctx.cwd),
				},
			);
			ctx.ui.notify(`📦 Archived session for grepping: ${archivePath}`, "info");
		} catch (err) {
			ctx.ui.notify(
				`Archive failed (compaction continues): ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	// -- checkpoint tool -------------------------------------------------
	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Archive the current session, clear context, and continue. " +
			"Use at logical task boundaries when work for this turn is done but more remains. " +
			"Preserved reads are skipped automatically — only files the model hasn't seen in the preserved tail are injected.",
		parameters: Type.Object({
			summary: SUMMARY_SCHEMA,
			nextSteps: Type.Optional(
				Type.String({
					description:
						"What comes next. Used as the kickoff prompt if continue is true. Defaults to 'Continue work'.",
				}),
			),
			continue: Type.Optional(
				Type.Boolean({
					description: "If true (default), follow up with a fresh prompt so work continues. Set false to stop.",
				}),
			),
			relevantPaths: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({
							description:
								"File path relative to cwd (same convention as read/write tools).",
						}),
					}),
					{
						description:
							"Files to carry forward after compaction. Be conservative — only include files you are **certain** you'll need in the very next turn. " +
							"When in doubt, omit it: you can always read it again after the checkpoint. " +
							"Only the lines actually read are injected; files already in the preserved tail are skipped automatically.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ownerState = checkOwnerState(params.nextSteps ?? "", ctx.cwd);
			if (ownerState.error) return ownerState.error;
			if (ownerState.warning) ctx.ui.notify(ownerState.warning, "warning");

			const next = params.nextSteps ?? "Continue work";
			const doContinue = params.continue !== false;
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const contextWindow = ctx.model?.contextWindow ?? 200_000;
			const summaryFields: SummaryFields = params.summary;

			// Captured before anything is written, so the archive's own untracked
			// files cannot show up in `git.dirty`.
			const git = await captureGitBinding(ctx.cwd);
			const tokens: CheckpointTokens = { before: tokensBefore(ctx), after: null };

			// R3-1: one composed summary serves both the archive and the restore
			// path, so the in-flight record is in the context after compaction.
			const inFlight = listInFlightSubagents({ dir: inflightScanDirOverride });
			const section = formatInFlightSection(inFlight);
			const summary = composeSummary(renderSummary(summaryFields, next), section);

			// Archive *before* compaction so all entries are captured in full.
			let archivePath: string | undefined;
			try {
				archivePath = await archiveSession(
					ctx.cwd,
					ctx.sessionManager.getEntries(),
					summary,
					ctx.sessionManager.getSessionId(),
					{ summaryFields, tokens, git },
				);
			} catch (err) {
				ctx.ui.notify(
					`Archive failed (compaction continues): ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}

			// Stash params for session_before_compact to pick up (it has access
			// to firstKeptEntryId, which lets us skip preserved files) and mark
			// the request for the turn_end trigger. Do NOT compact here: the
			// tool result has not been persisted yet.
			pendingCheckpoint = {
				summary,
				next,
				doContinue,
				tokens,
				archivePath,
				relevantPaths,
				cwd: ctx.cwd,
				contextWindow,
			};
			compactRequested = true;

			const responseLines = [`Checkpoint queued.`];
			if (ownerState.warning) responseLines.push(ownerState.warning);
			if (inFlight.length > 0) {
				responseLines.push(
					`In-flight subagents recorded in the summary: ${inFlight.length} ` +
						`(${inFlight.map((e) => `${e.sid.slice(-8)} ${e.state}`).join(", ")}).`,
				);
			}
			if (archivePath) {
				responseLines.push(`Full session archived to:\n\`${archivePath}\``);
				responseLines.push(`Grep there with: \`rg PATTERN ${archivePath}\``);
			} else {
				responseLines.push(`Archive failed — session data is preserved in the session file.`);
			}
			responseLines.push(`Next: ${next}${doContinue ? "" : " (no auto-continue)"}`);

			return {
				content: [{ type: "text", text: responseLines.join("\n\n") }],
			};
		},
	});

	// -- checkpoint_fork tool --------------------------------------------
	pi.registerTool({
		name: "checkpoint_fork",
		label: "Checkpoint Fork",
		description:
			"Archive the current session and stage a fork into a new working directory. " +
			"Run /go to commit the switch (session switching requires a user-initiated command). " +
			"You (the model) choose the target directory, author the summary from current context, " +
			"and pick nextSteps/continue — just like checkpoint. " +
			"The target dir must already exist.",
		parameters: Type.Object({
			newCwd: Type.String({
				description: "Target working directory for the forked session. Must already exist.",
			}),
			summary: SUMMARY_SCHEMA,
			nextSteps: Type.Optional(
				Type.String({
					description:
						"What comes next. Used as the kickoff prompt if continue is true. Default: 'Continue work'.",
				}),
			),
			continue: Type.Optional(
				Type.Boolean({
					description: "If true (default), follow up with a fresh prompt so work continues after the switch.",
				}),
			),
			relevantPaths: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({
							description:
								"File path relative to the *source* cwd (same convention as read/write tools). " +
								"Files are read from the source directory and injected into the new session.",
						}),
					}),
					{
						description:
							"Files from the source cwd to inject into the new session context. " +
							"Only the lines actually read are injected — if whole file, whole file goes through. " +
							"Forks start fresh — no preservation dedup applies.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let targetStat;
			try {
				targetStat = await stat(params.newCwd);
			} catch {
				return {
					content: [{ type: "text", text: `Error: target directory does not exist: ${params.newCwd}` }],
					isError: true,
				};
			}
			if (!targetStat.isDirectory()) {
				return {
					content: [{ type: "text", text: `Error: not a directory: ${params.newCwd}` }],
					isError: true,
				};
			}

			// Argument shape first: the R6 verdict (refusal or warning) goes on the
			// tool result, so it must not sit behind an early `return`.
			const ownerState = checkOwnerState(params.nextSteps ?? "", ctx.cwd);
			if (ownerState.error) return ownerState.error;
			if (ownerState.warning) ctx.ui.notify(ownerState.warning, "warning");

			const next = params.nextSteps ?? "Continue work";
			const doContinue = params.continue !== false;
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const oldSessionId = ctx.sessionManager.getSessionId();
			const oldCwd = ctx.sessionManager.getCwd();
			const contextWindow = ctx.model?.contextWindow ?? 200_000;
			const summaryFields: SummaryFields = params.summary;

			// The source tree's ref, captured when the fork is authored (the archive
			// itself is written at /go, after this): the summary describes this state.
			const git = await captureGitBinding(oldCwd);
			const tokens: CheckpointTokens = { before: tokensBefore(ctx), after: null };

			// R3-1: both the fork-source archive and the new session's summary
			// carry the in-flight record.
			const inFlight = listInFlightSubagents({ dir: inflightScanDirOverride });
			const section = formatInFlightSection(inFlight);
			const summary = composeSummary(renderSummary(summaryFields, next), section);

			// Fork creates a new session — no preservation to dedup against.
			const injection = await buildFileInjection(
				relevantPaths,
				oldCwd,
				contextWindow,
				new Set(), // empty — nothing preserved
			);

			const included = relevantPaths.length - injection.omitted.length - injection.skippedPreserved.length;

			setPendingGo({
				label: `fork → ${params.newCwd}`,
				run: async (cmdCtx) => {
					try {
						const forkArchivePath = await archiveSession(
							cmdCtx.cwd,
							cmdCtx.sessionManager.getEntries(),
							summary,
							cmdCtx.sessionManager.getSessionId(),
							{ summaryFields, tokens, git, newCwd: params.newCwd },
						);
						cmdCtx.ui.notify(`📦 Fork source archived: ${forkArchivePath}`, "info");
					} catch (err) {
						cmdCtx.ui.notify(
							`Fork archive failed (switch continues): ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
					}
					const newSession = SessionManager.create(params.newCwd);
					newSession.appendMessage({
						role: "user",
						content: [
							{ type: "text", text: `This session was created from a checkpoint of session ${oldSessionId} (${oldCwd}).` },
						],
						timestamp: Date.now(),
					});
					newSession.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: summary }],
						api: "anthropic",
						provider: "anthropic",
						model: "unknown",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						stopReason: "end",
						timestamp: Date.now(),
					});
					await cmdCtx.switchSession(newSession.getSessionFile()!, {
						withSession: async (n) => {
							if (doContinue) {
								const parts = [next];
								if (injection.text) parts.unshift(injection.text);
								await n.sendUserMessage(parts.join("\n\n"));
							}
						},
					});
				},
			});

			ctx.ui.notify(`Fork prepared → ${params.newCwd}. Run /go to switch.`, "info");

			const responseLines = [`Fork prepared → ${params.newCwd}. Run /go to switch.`];
			if (ownerState.warning) responseLines.push(ownerState.warning);
			if (inFlight.length > 0) {
				responseLines.push(`In-flight subagents recorded in the summary: ${inFlight.length}.`);
			}
			if (relevantPaths.length > 0) {
				const notes: string[] = [];
				notes.push(
					`${included} of ${relevantPaths.length} files ` +
					`(~${Math.round(INJECTION_BUDGET_FRACTION * 100)}% context budget)`,
				);
				if (injection.omitted.length > 0) notes.push(`Omitted (budget): ${injection.omitted.join(", ")}`);
				if (injection.skippedPreserved.length > 0) notes.push(`Skipped (preserved): ${injection.skippedPreserved.join(", ")}`);
				responseLines.push(`File injection: ${notes.join(". ")}`);
			}

			return {
				content: [{ type: "text", text: responseLines.join("\n\n") }],
			};
		},
	});

	// -- /checkpoints command --------------------------------------------
	pi.registerCommand("checkpoints", {
		description: "List archived session checkpoints.",
		async handler(_args, ctx) {
			const archiveDir = join(ctx.cwd, CHECKPOINT_DIR);
			try {
				const files = (await readdir(archiveDir)).filter((f) => f.endsWith(".meta.json"));
				if (files.length === 0) {
					ctx.ui.notify("No checkpoints yet.", "info");
					return;
				}
				const lines: string[] = [`Checkpoints in ${archiveDir}:`];
				for (const f of files.sort().reverse()) {
					const meta = JSON.parse(await readFile(join(archiveDir, f), "utf8"));
					const shortPath = meta.archivePath ? meta.archivePath.replace(archiveDir, "") : f.replace(/\.meta\.json$/, ".jsonl");
					// First line of the rendered summary is its `Goal:` line.
					const headline = String(meta.summary ?? "(no summary)").split("\n")[0];
					const git = meta.git
						? ` [${meta.git.branch}@${String(meta.git.head).slice(0, 7)}${meta.git.dirty ? "+" : ""}]`
						: "";
					lines.push(`  ${meta.timestamp} — ${headline}${git}`);
					lines.push(`        archive: …${shortPath}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch {
				ctx.ui.notify("No checkpoints yet.", "info");
			}
		},
	});

	// -- /checkpoint command ---------------------------------------------
	pi.registerCommand("checkpoint", {
		description:
			"Archive session and compact context. Sends a follow-up prompting the model to summarize and continue. Optional: /checkpoint <focus hint>",
		handler: async (args, ctx) => {
			const focus = args.trim();

			let fileHint = "";
			if (reads.size > 0) {
				const lines: string[] = [];
				for (const { path, merged, wholeFile } of reads.fileSummaries()) {
					lines.push(`- ${path}${wholeFile ? " (entire file)" : ` → ${formatRanges(merged)}`}`);
				}
				fileHint =
					`\n\nFiles read this session (be conservative with relevantPaths — only include files you're certain you'll need; ` +
					`when in doubt just re-read after checkpoint):\n${lines.join("\n")}`;
			}

			const basePrompt =
				"Run the checkpoint tool now. " + SUMMARY_FORMAT_HINT + " " +
				"Let `continue` default to true so work continues automatically after compaction. " +
				"If you need file context carried forward, include a `relevantPaths` list — only list files " +
				"you will actually need after the checkpoint. " +
				"Be conservative: include only files you're 100% certain you'll need in the next turn. " +
				"When in doubt, omit it — you can always read it again.";

			const prompt = focus
				? `${basePrompt}\n\nFocus the summary on: ${focus}${fileHint}`
				: `${basePrompt}${fileHint}`;

			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Checkpoint queued — will run after current work.", "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


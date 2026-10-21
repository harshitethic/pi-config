import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { AgentMessage, AssistantMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setPendingGo } from "./go.ts";
import {
	ReadTracker,
	collectPreservedReadPaths,
	formatRanges,
	mergeRegions,
	normalizePath,
} from "./lib/read-tracking.ts";

const CHECKPOINT_DIR = ".pi/checkpoints";
const MARKER = "[CHECKPOINT]";
const SUMMARY_FORMAT_HINT =
	"Structure the summary with three parts: " +
	"(1) brief bullet list of what was done/accomplished so far, " +
	"(2) an in-depth explanation of what's being worked on right now and why, " +
	"(3) medium-length overview of the overall plan (what comes after this).";

// Fraction of context window to use for file injection (15%).
const INJECTION_BUDGET_FRACTION = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelevantPathEntry {
	path: string;
}

/** State passed from checkpoint tool → compaction hook → onComplete callback. */
interface PendingCheckpoint {
	summary: string;
	next: string;
	doContinue: boolean;
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
// File injection
// ---------------------------------------------------------------------------

function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Read file contents for each entry in `relevantPaths`, skipping files that
 * are already preserved in the compacted context.
 *
 * Only the lines actually read this session are injected — if the whole file
 * was read the whole file goes through.  Files with no tracked read regions
 * are skipped entirely.
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
	let used = 0;

	for (const entry of relevantPaths) {
		const key = normalizePath(entry.path, cwd);

		// Skip files already in the preserved context tail — the model
		// already has whatever lines it read during the preserved turns.
		if (preserved.has(key)) {
			skippedPreserved.push(entry.path);
			continue;
		}

		// -- Read and format file content (matching read-tool output format) -
		const absolutePath = resolvePath(cwd, entry.path);
		let content: string;

		try {
			const raw = await readFile(absolutePath, "utf-8");
			const regions = reads.regionsFor(key, cwd);

			// No read regions tracked → nothing to inject, skip entirely.
			if (!regions || regions.length === 0) continue;

			const merged = mergeRegions(regions);
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

	let text = parts.join("\n\n");

	const notes: string[] = [];
	if (skippedPreserved.length > 0) {
		notes.push(
			`${skippedPreserved.length} file(s) already in preserved context — skipped: ${skippedPreserved.join(", ")}. ` +
			``,
		);
	}
	if (omitted.length > 0) {
		notes.push(
			`${parts.length} of ${relevantPaths.length} files included ` +
			`(budget: ${budget.toLocaleString()} tokens, ~${Math.round(INJECTION_BUDGET_FRACTION * 100)}% of context window). ` +
			`Omitted: ${omitted.join(", ")}. Use read tool if needed.`,
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

/** Write session entries to a JSONL archive. */
async function archiveSession(
	cwd: string,
	entries: unknown[],
	summary: string,
	sessionId?: string,
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

	const metaPath = archivePath.replace(/\.jsonl$/, ".meta.json");
	await writeFile(
		metaPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				sessionId,
				archivePath,
				summary,
				entryCount: entries.length,
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

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const path: string | undefined = event.args?.path;
		if (!path) return;
		const offset: number = event.args?.offset ?? 1;
		const limit: number = event.args?.limit ?? Number.MAX_SAFE_INTEGER;
		await reads.recordRead(path, ctx.cwd, { offset, limit });
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
			onComplete: () => {
				const inj = pending?.injection;
				pendingCheckpoint = null;

				try {
					const archiveLine = pending?.archivePath ? `\nArchive: ${pending.archivePath}` : "";
					ctx.ui.notify(`Checkpoint complete — context cleared.${archiveLine}`, "info");
				} catch { /* ctx stale after reload */ }
				if (pending?.doContinue) {
					const parts = [pending.next];
					if (inj?.text) parts.unshift(inj.text);
					if (pending.archivePath) parts.push(`Archive: ${pending.archivePath}`);
					const followUp = parts.join("\n\n");
					pi.sendUserMessage(followUp, { deliverAs: "followUp" });
				}
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
				const preserved = collectPreservedReadPaths(
					ctx.sessionManager.getEntries(),
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
			summary: Type.String({ description: SUMMARY_FORMAT_HINT }),
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
			const next = params.nextSteps ?? "Continue work";
			const doContinue = params.continue !== false;
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const contextWindow = ctx.model?.contextWindow ?? 200_000;

			// Archive *before* compaction so all entries are captured in full.
			let archivePath: string | undefined;
			try {
				archivePath = await archiveSession(
					ctx.cwd,
					ctx.sessionManager.getEntries(),
					params.summary,
					ctx.sessionManager.getSessionId(),
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
				summary: params.summary,
				next,
				doContinue,
				archivePath,
				relevantPaths,
				cwd: ctx.cwd,
				contextWindow,
			};
			compactRequested = true;

			const responseLines = [`Checkpoint queued.`];
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
			summary: Type.String({
				description: `${SUMMARY_FORMAT_HINT} Authored inline from current context.`,
			}),
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

			const next = params.nextSteps ?? "Continue work";
			const doContinue = params.continue !== false;
			const relevantPaths: RelevantPathEntry[] = params.relevantPaths ?? [];
			const oldSessionId = ctx.sessionManager.getSessionId();
			const oldCwd = ctx.sessionManager.getCwd();
			const contextWindow = ctx.model?.contextWindow ?? 200_000;

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
							params.summary,
							cmdCtx.sessionManager.getSessionId(),
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
						content: [{ type: "text", text: params.summary }],
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
					lines.push(`  ${meta.timestamp} — ${meta.summary.split("\n")[0]}`);
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


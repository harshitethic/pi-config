/**
 * Auto-Checkpoint Extension
 *
 * Monitors context usage per turn and nudges the model (via a context message)
 * to suggest checkpointing when configured thresholds are crossed.
 *
 * When a turn crosses the threshold and BOTH the turn-count and timer cooldowns
 * have elapsed, the nudge is delivered as a steer message if the run is still
 * going (so long autonomous runs get it mid-task), or armed for the start of
 * the next agent run (before_agent_start) if the run is ending.
 *
 * Idle compaction: a settled session above the threshold with no activity for
 * `IDLE_FRACTION × cacheTtlMs` compacts itself (`ctx.compact()`), so the next
 * prompt starts from a summary instead of re-reading the whole context cold.
 * The timer fires *before* the provider's cache expires on purpose: the
 * summarization call is the one request that must read the entire context, and
 * before expiry it reads it at cache-read price. After expiry that same read is
 * billed at the full input price, which is the cost this feature exists to
 * avoid. Claude Code uses the same shape (54 min of a 1 h cache, ≥200k tokens).
 *
 * Config:
 *   ~/.pi/agent/auto-checkpoint.json  (global)
 *   .pi/auto-checkpoint.json          (project-local, merged over global)
 *
 * Schema:
 *   {
 *     "defaultThreshold": 256000,        // fraction (<1) of contextWindow, or absolute tokens (>=1)
 *     "smallWindowFraction": 0.8,        // absolute thresholds cap at this fraction of the window
 *     "cooldownTurns": 3,                // min turns between nudges
 *     "cooldownMs": 30000,               // min ms between nudges
 *     "idleCompaction": true,            // compact a settled session after idle
 *     "cacheTtlMs": 300000,              // provider prompt-cache lifetime (Anthropic default 5 min)
 *     "prompt": "**Context note:** ...",  // optional, overrides degradation auto-pick
 *     "defaultContextDegradation": true,  // default for models without explicit setting
 *     "models": {
 *       "deepseek/*": { "threshold": 0.8, "cooldownTurns": 5, "cacheTtlMs": 21600000 },
 *       "openai/*":    { "threshold": 0.7 },
 *       "z.ai/glm-5.2": {
 *         "threshold": 0.85,
 *         "contextDegradation": false   // relaxed prompt, no urgency
 *       }
 *     }
 *   }
 *
 * Thresholds (default and per-model): < 1 is a fraction of contextWindow,
 * >= 1 is an absolute token count. An absolute threshold that would exceed
 * smallWindowFraction × contextWindow (default 0.8) is capped to that value, so
 * small-window models still get nudged rather than never firing. Fractional
 * thresholds are uncapped. Model patterns support * and ? wildcards; first
 * match wins.
 *
 * When contextDegradation is false, the nudge prompt is relaxed — suggesting
 * the model wait for a logical completion point rather than urging a quick
 * checkpoint. When a custom prompt is set explicitly at the model or top level,
 * the degradation flag is ignored.
 *
 * cacheTtlMs is the provider's prompt-cache lifetime, not a pi setting: the
 * documented values differ by an order of magnitude (Anthropic 5 min, with a
 * 1 h option; DeepSeek disk cache "a few hours to a few days"; z.ai and MiMo
 * publish no TTL). `idleCompaction: false` or `cacheTtlMs: 0` turns the timer
 * off for a model whose cache outlives the session's usefulness.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelThresholdConfig {
	/** < 1 → fraction of contextWindow, >= 1 → absolute token count. */
	threshold: number;
	cooldownTurns?: number;
	cooldownMs?: number;
	/** Compact this model's session after idle; defaults to the top-level setting. */
	idleCompaction?: boolean;
	/** Provider prompt-cache lifetime in ms; defaults to the top-level setting. */
	cacheTtlMs?: number;
	prompt?: string;
	/**
	 * Whether this model's quality degrades at higher context lengths.
	 * - true (default) → prompt with some urgency: "Quality degrades…"
	 * - false → relaxed prompt: "Handles longer contexts well… no rush"
	 *
	 * Ignored when a custom prompt is set explicitly.
	 */
	contextDegradation?: boolean;
}

interface RawAutoCheckpointConfig {
	defaultThreshold?: number;
	/** Absolute thresholds cap at this fraction of the window (default 0.8). */
	smallWindowFraction?: number;
	cooldownTurns?: number;
	cooldownMs?: number;
	idleCompaction?: boolean;
	cacheTtlMs?: number;
	models?: Record<string, ModelThresholdConfig>;
	prompt?: string;
	defaultContextDegradation?: boolean;
}

export interface AutoCheckpointConfig {
	defaultThreshold: number;
	smallWindowFraction: number;
	cooldownTurns: number;
	cooldownMs: number;
	idleCompaction: boolean;
	cacheTtlMs: number;
	models: Record<string, ModelThresholdConfig>;
	prompt: string;
	defaultContextDegradation: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt variants
// ---------------------------------------------------------------------------

/** Used when the model degrades at high context (contextDegradation: true). */
const DEGRADATION_PROMPT =
	"**Context note:** The conversation has reached **{{tokens}}** tokens " +
	"({{percent}}% of {{contextWindow}}). Quality tends to degrade at higher " +
	"context lengths. Finish the current subtask first, then run the **checkpoint** " +
	"tool at that stopping point to archive progress and continue with fresh context.";

/** Used when the model handles long context well (contextDegradation: false). */
const NO_DEGRADATION_PROMPT =
	"**Context note:** The conversation has reached **{{tokens}}** tokens " +
	"({{percent}}% of {{contextWindow}}). This model handles longer contexts " +
	"well, but keeping context smaller reduces costs. Whenever you reach a " +
	"clean break — finishing the current subtask or answering the current " +
	"question — you can run the **checkpoint** tool to archive progress and " +
	"continue with fresh context. There's no rush.";

const DEFAULT_CONFIG: AutoCheckpointConfig = {
	defaultThreshold: 0.75,
	smallWindowFraction: 0.8,
	cooldownTurns: 3,
	cooldownMs: 30_000,
	idleCompaction: true,
	// Anthropic's default prompt-cache TTL. Other providers publish nothing
	// (or, for DeepSeek, hours-to-days), so raise it per model where known.
	cacheTtlMs: 5 * 60_000,
	models: {},
	prompt: DEGRADATION_PROMPT,
	defaultContextDegradation: true,
};

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-checkpoint.json");

// ---------------------------------------------------------------------------
// Glob matching (only * and ?)
// ---------------------------------------------------------------------------

export function matchPattern(pattern: string, s: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp("^" + escaped + "$", "i").test(s);
}

// ---------------------------------------------------------------------------
// Config loading & merging
// ---------------------------------------------------------------------------

function mergeConfig(base: AutoCheckpointConfig, raw: RawAutoCheckpointConfig): AutoCheckpointConfig {
	return {
		...base,
		...raw,
		models: { ...base.models, ...raw.models },
		prompt: raw.prompt ?? base.prompt,
		defaultContextDegradation: raw.defaultContextDegradation ?? base.defaultContextDegradation,
	};
}

async function loadConfig(cwd: string): Promise<AutoCheckpointConfig> {
	let config = { ...DEFAULT_CONFIG };

	try {
		const raw = JSON.parse(await readFile(GLOBAL_CONFIG_PATH, "utf8")) as RawAutoCheckpointConfig;
		config = mergeConfig(config, raw);
	} catch {
		// missing or invalid global config → use defaults
	}

	const projectPath = join(cwd, ".pi", "auto-checkpoint.json");
	try {
		const raw = JSON.parse(await readFile(projectPath, "utf8")) as RawAutoCheckpointConfig;
		config = mergeConfig(config, raw);
	} catch {
		// missing or invalid project config → keep current
	}

	return config;
}

/** Resolve threshold to an absolute token count for the given model.
 *
 *  < 1 → fraction of contextWindow. >= 1 → absolute, capped at
 *  smallWindowFraction × contextWindow so small-window models still nudge. */
export function resolveThreshold(modelId: string, contextWindow: number, config: AutoCheckpointConfig): number {
	const cap = Math.round(config.smallWindowFraction * contextWindow);
	const resolve = (threshold: number): number =>
		threshold < 1 ? Math.round(threshold * contextWindow) : Math.min(threshold, cap);
	for (const [pattern, mcfg] of Object.entries(config.models)) {
		if (matchPattern(pattern, modelId)) return resolve(mcfg.threshold);
	}
	return resolve(config.defaultThreshold);
}

/** Get resolved model-level config for cooldown/prompt/idle overrides. */
function resolveModelConfig(
	modelId: string,
	config: AutoCheckpointConfig,
): {
	cooldownTurns: number;
	cooldownMs: number;
	explicitPrompt: string | null;
	contextDegradation: boolean;
	idleCompaction: boolean;
	cacheTtlMs: number;
} {
	for (const [pattern, mcfg] of Object.entries(config.models)) {
		if (matchPattern(pattern, modelId)) {
			return {
				cooldownTurns: mcfg.cooldownTurns ?? config.cooldownTurns,
				cooldownMs: mcfg.cooldownMs ?? config.cooldownMs,
				explicitPrompt: mcfg.prompt ?? null,
				contextDegradation: mcfg.contextDegradation ?? config.defaultContextDegradation,
				idleCompaction: mcfg.idleCompaction ?? config.idleCompaction,
				cacheTtlMs: mcfg.cacheTtlMs ?? config.cacheTtlMs,
			};
		}
	}
	return {
		cooldownTurns: config.cooldownTurns,
		cooldownMs: config.cooldownMs,
		explicitPrompt: null,
		contextDegradation: config.defaultContextDegradation,
		idleCompaction: config.idleCompaction,
		cacheTtlMs: config.cacheTtlMs,
	};
}

// ---------------------------------------------------------------------------
// Nudge state
// ---------------------------------------------------------------------------

interface PendingNudge {
	tokens: number;
	contextWindow: number;
	percent: number;
}

// ---------------------------------------------------------------------------
// Read-region tracking (shared format with checkpoint.ts)
// ---------------------------------------------------------------------------

interface ReadRegion {
	offset: number;
	limit: number; // Number.MAX_SAFE_INTEGER means "read to end"
}

/** Files read this session, keyed by normalized relative-to-cwd path. */
const readRegions = new Map<string, ReadRegion[]>();

function normalizePath(filePath: string, cwd: string): string {
	const absolute = resolvePath(cwd, filePath);
	const rel = relative(cwd, absolute);
	return rel.startsWith("..") ? absolute : rel || ".";
}

function mergeRegions(regions: ReadRegion[]): Array<{ offset: number; endLine: number }> {
	const sorted = regions
		.map((r) => ({ offset: r.offset, endLine: r.offset + r.limit - 1 }))
		.sort((a, b) => a.offset - b.offset);
	const merged: Array<{ offset: number; endLine: number }> = [];
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

function formatReadRegions(readRegions: Map<string, ReadRegion[]>): string {
	if (readRegions.size === 0) return "";
	const entries: string[] = [];
	for (const [path, regions] of readRegions) {
		const merged = mergeRegions(regions);
		const ranges = merged
			.map((r) => (r.endLine >= Number.MAX_SAFE_INTEGER - 1 ? `L${r.offset}-end` : `L${r.offset}-${r.endLine}`))
			.join(", ");
		const fullFile = merged.length === 1 && merged[0].offset === 1 && merged[0].endLine >= Number.MAX_SAFE_INTEGER - 1;
		entries.push(`- ${path}${fullFile ? " (entire file)" : ` → ${ranges}`}`);
	}
	return (
		`\n\nFiles read this session:\n${entries.join("\n")}` +
		`\n\nWhen checkpointing, include only files you're certain you'll need immediately in relevantPaths — ` +
		`be conservative, you can re-read anything after the checkpoint.`
	);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: {
	config: AutoCheckpointConfig | null;
	modelId: string | null;
	threshold: number;
	turnCounter: number;
	lastNudgedTurn: number;
	lastNudgedMs: number;
	pending: PendingNudge | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
} = {
	config: null,
	modelId: null,
	threshold: 0,
	turnCounter: 0,
	lastNudgedTurn: -1,
	lastNudgedMs: -1,
	pending: null,
	idleTimer: null,
};

/** Cancel a pending idle-compaction timer. */
function clearIdleTimer(): void {
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = null;
}

function resetState(): void {
	clearIdleTimer();
	state.modelId = null;
	state.threshold = 0;
	state.turnCounter = 0;
	state.lastNudgedTurn = -1;
	state.lastNudgedMs = -1;
	state.pending = null;
	readRegions.clear();
}

/** Render the nudge text for a crossover, including tracked read regions. */
function buildNudgeContent(tokens: number, contextWindow: number, percent: number, modelId: string): string {
	const mcfg = resolveModelConfig(modelId, state.config!);
	// Pick the right built-in prompt based on degradation flag, unless an
	// explicit prompt was configured (takes precedence).
	const promptTemplate = mcfg.explicitPrompt
		?? (mcfg.contextDegradation ? DEGRADATION_PROMPT : NO_DEGRADATION_PROMPT);

	let content = promptTemplate
		.replace(/\{\{tokens\}\}/g, tokens.toLocaleString())
		.replace(/\{\{percent\}\}/g, percent.toFixed(1))
		.replace(/\{\{contextWindow\}\}/g, contextWindow.toLocaleString());

	// Append tracked read regions so the model can make informed
	// relevantPaths decisions when calling the checkpoint tool.
	content += formatReadRegions(readRegions);
	return content;
}

// ---------------------------------------------------------------------------
// Idle compaction
// ---------------------------------------------------------------------------

/**
 * Fraction of the cache TTL after which an idle session compacts, mirroring
 * Claude Code's 54-of-60 minutes. Firing earlier costs the same (the summary
 * read is cached either way) but compacts sessions the user was about to
 * resume; later risks the cache expiring first.
 */
const IDLE_FRACTION = 0.9;

/** Idle delay before compaction for a provider cache TTL of `ttlMs`. */
export function idleCompactDelayMs(ttlMs: number): number {
	return ttlMs > 0 ? Math.round(ttlMs * IDLE_FRACTION) : 0;
}

/**
 * Re-derive model + threshold from ctx when the arming events missed them.
 * session_start sees no model on resume, model_select never fires for a
 * resumed session's model, and session_compact resets state — ctx.model is
 * reliably current, so every handler that needs the threshold self-heals here.
 * Returns the model id to use, or null while no threshold is known.
 */
function ensureModel(ctx: ExtensionContext, config: AutoCheckpointConfig): string | null {
	const currentModel = ctx.model;
	if (currentModel?.id && (state.modelId !== currentModel.id || state.threshold <= 0)) {
		state.modelId = currentModel.id;
		state.threshold = resolveThreshold(currentModel.id, currentModel.contextWindow ?? 200_000, config);
	}
	return state.modelId !== null && state.threshold > 0 ? state.modelId : null;
}

/** Run the idle check and compact when everything still holds at fire time. */
function fireIdleCompaction(ctx: ExtensionContext): void {
	if (!state.config || !state.modelId) return;

	// Re-check at fire time: the timer is armed when a run settles, and one
	// request may have happened since (steer, follow-up, retry).
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	if (usage.tokens < state.threshold) return;

	// The summarization read is the only request that must see the whole
	// context; compacting before the cache expires keeps it at cache-read price.
	ctx.compact({
		onComplete: () => {
			if (ctx.hasUI) ctx.ui.notify("Compacted while idle — next prompt starts from the summary.", "info");
		},
		onError: (error: Error) => {
			if (ctx.hasUI) ctx.ui.notify(`Idle compaction failed: ${error.message}`, "error");
		},
	});
}

/** Arm the idle-compaction timer for a settled session. */
function armIdleCompaction(ctx: ExtensionContext): void {
	clearIdleTimer();
	if (!state.config || !state.modelId) return;

	// Interactive sessions only. A subagent or RPC session is settled between
	// commands its driver may issue at any moment; compacting under it would
	// summarise context the driver is still using (Claude Code requires an
	// interactive terminal session for the same reason).
	if (ctx.mode !== "tui") return;

	const mcfg = resolveModelConfig(state.modelId, state.config);
	if (!mcfg.idleCompaction) return;

	const delay = idleCompactDelayMs(mcfg.cacheTtlMs);
	if (delay <= 0) return;

	const timer = setTimeout(() => {
		state.idleTimer = null;
		fireIdleCompaction(ctx);
	}, delay);
	// Don't hold the process open (print/RPC modes must still exit).
	(timer as { unref?: () => void }).unref?.();
	state.idleTimer = timer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: load config, reset state for fresh session ---
	pi.on("session_start", async (_event, ctx) => {
		state.config = await loadConfig(ctx.cwd);
		resetState();

		const model = ctx.model;
		if (model && model.id) {
			state.modelId = model.id;
			state.threshold = resolveThreshold(model.id, model.contextWindow ?? 200_000, state.config);
		}
	});

	// --- model_select: recompute threshold, clear nudge state ---
	pi.on("model_select", async (event, _ctx) => {
		if (!state.config) return;

		resetState();
		state.modelId = event.model.id;
		state.threshold = resolveThreshold(event.model.id, event.model.contextWindow ?? 200_000, state.config);
	});

	// --- session_compact: context just got freed → clear nudge state & read tracking ---
	pi.on("session_compact", async () => {
		resetState();
	});

	// --- turn_start / before_agent_start: activity cancels the idle timer ---
	pi.on("turn_start", async () => {
		clearIdleTimer();
	});

	// --- turn_end: check context usage against threshold ---
	pi.on("turn_end", async (event, ctx) => {
		if (!state.config) return;

		const modelId = ensureModel(ctx, state.config);
		if (!modelId) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		// Count turns monotonically across the whole session. `event.turnIndex`
		// resets to 0 at the start of every agent run (every user prompt), so
		// comparing it against a previous run's index made the turn cooldown
		// suppress nudges indefinitely once a long run had raised the watermark.
		state.turnCounter += 1;

		const tokens = usage.tokens;
		const contextWindow = usage.contextWindow;
		const percent = usage.percent ?? Math.round((tokens / contextWindow) * 100);

		// Below threshold → no nudge pending, but don't clear history (threshold
		// zone exit is handled by compaction/model-change/session-start events).
		if (tokens < state.threshold) return;

		// Cooldown: both turn count AND timer must have elapsed.
		const mcfg = resolveModelConfig(modelId, state.config);
		const turnsSinceLast = state.turnCounter - state.lastNudgedTurn;
		const msSinceLast = state.lastNudgedMs < 0 ? Number.POSITIVE_INFINITY : Date.now() - state.lastNudgedMs;

		if (turnsSinceLast < mcfg.cooldownTurns || msSinceLast < mcfg.cooldownMs) return;

		// The run is still going (the model asked to use tools) → steer the nudge
		// in now, so long autonomous runs and steered subagents get it before the
		// context outgrows the window. If the run is ending, arm it for delivery
		// at the next before_agent_start.
		if (event.message.role === "assistant" && event.message.stopReason === "toolUse") {
			pi.sendMessage(
				{
					customType: "auto-checkpoint",
					content: buildNudgeContent(tokens, contextWindow, percent, modelId),
					display: false,
				},
				{ deliverAs: "steer" },
			);
			state.lastNudgedTurn = state.turnCounter;
			state.lastNudgedMs = Date.now();
		} else {
			state.pending = { tokens, contextWindow, percent };
		}
	});

	// --- tool_result: track read regions for nudge file hints ---
	// `tool_execution_end` dropped its `args` field in current pi; the finalized
	// tool arguments live on `tool_result.input`.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const input = event.input as { path?: string; offset?: number; limit?: number };
		const path = input.path;
		if (!path) return;
		const offset: number = input.offset ?? 1;
		const limit: number = input.limit ?? Number.MAX_SAFE_INTEGER;

		const key = normalizePath(path, ctx.cwd);
		const regions = readRegions.get(key) ?? [];
		regions.push({ offset, limit });
		readRegions.set(key, regions);
	});

	// --- before_agent_start: inject a nudge armed by the previous run's end ---
	pi.on("before_agent_start", async (_event, ctx) => {
		// A run is starting: the session is no longer idle.
		clearIdleTimer();
		if (!state.pending) return;
		if (!state.config) return;

		const { tokens, contextWindow, percent } = state.pending;
		const content = buildNudgeContent(tokens, contextWindow, percent, state.modelId ?? ctx.model?.id ?? "");

		state.lastNudgedTurn = state.turnCounter;
		state.lastNudgedMs = Date.now();
		state.pending = null;

		return {
			message: {
				customType: "auto-checkpoint",
				content,
				display: false,
			},
		};
	});

	// --- agent_settled: the run is fully over → arm idle compaction ---
	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.config) return;
		if (!ensureModel(ctx, state.config)) return;
		armIdleCompaction(ctx);
	});

	// --- /checkpoint-status command: show current config & context ---
	pi.registerCommand("checkpoint-status", {
		description: "Show auto-checkpoint configuration and current context usage.",
		async handler(_args, ctx) {
			const model = ctx.model;
			const modelId = model?.id ?? "no-model";

			const lines: string[] = [
				"─── Auto-Checkpoint ───",
				`model: ${modelId}`,
			];

			if (state.config) {
				// Calculate effective threshold
				const effectiveThreshold =
					state.threshold > 0
						? state.threshold
						: resolveThreshold(modelId, model?.contextWindow ?? 200_000, state.config);

				const mcfg = resolveModelConfig(modelId, state.config);
				lines.push(`threshold: ${effectiveThreshold.toLocaleString()} tokens`);
				lines.push(`cooldown: ${mcfg.cooldownTurns} turns / ${(mcfg.cooldownMs / 1000).toFixed(0)}s`);
				lines.push(`context degradation: ${mcfg.contextDegradation}`);
				lines.push(
					mcfg.idleCompaction && idleCompactDelayMs(mcfg.cacheTtlMs) > 0
						? `idle compaction: ${(idleCompactDelayMs(mcfg.cacheTtlMs) / 60_000).toFixed(1)} min after settle (cache TTL ${(mcfg.cacheTtlMs / 60_000).toFixed(0)} min)`
						: "idle compaction: off",
				);

				const usage = ctx.getContextUsage();
				if (usage && usage.tokens !== null) {
					const pct = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);
					lines.push(`context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${pct}%)`);
					if (usage.tokens >= effectiveThreshold) {
						lines.push(`status: ${state.pending ? "nudge pending" : "above threshold (cooldown)"}`);
					} else {
						lines.push("status: below threshold");
					}
				} else {
					lines.push("context: unknown");
				}
			} else {
				lines.push("config: not loaded");
			}

			lines.push(`last nudge: turn ${state.lastNudgedTurn} at ${state.lastNudgedMs > 0 ? new Date(state.lastNudgedMs).toLocaleTimeString() : "never"}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

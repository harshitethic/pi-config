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
 *     "cacheTtlMs": 3600000,             // assumed cache lifetime for an unknown family (1 h)
 *     "prompt": "**Context note:** ...",  // optional, overrides degradation auto-pick
 *     "defaultContextDegradation": true,  // default for models without explicit setting
 *     "models": {
 *       "deepseek*":   { "threshold": 0.8, "cooldownTurns": 5 },   // any route, any version
 *       "openrouter/openai/*": { "threshold": 0.7 },
 *       "z.ai/*":      { "cacheTtlMs": 10800000 },
 *       "glm-5.2": {
 *         "threshold": 0.85,
 *         "contextDegradation": false   // relaxed prompt, no urgency
 *       }
 *     }
 *   }
 *
 * Patterns match `model.id` and `provider/model.id` (`*`, `?` wildcards,
 * case-insensitive, first match wins), so `deepseek*` covers
 * `deepseek-v4.1-flash` through opencode-go and `deepseek/deepseek-v4-pro`
 * through openrouter, and `opencode-go/*` or `z.ai/*` scope a whole route.
 *
 * Thresholds (default and per-model): < 1 is a fraction of contextWindow,
 * >= 1 is an absolute token count. An absolute threshold that would exceed
 * smallWindowFraction × contextWindow (default 0.8) is capped to that value, so
 * small-window models still get nudged rather than never firing. Fractional
 * thresholds are uncapped.
 *
 * When contextDegradation is false, the nudge prompt is relaxed — suggesting
 * the model wait for a logical completion point rather than urging a quick
 * checkpoint. When a custom prompt is set explicitly at the model or top level,
 * the degradation flag is ignored.
 *
 * cacheTtlMs is the provider's prompt-cache lifetime, not a pi setting. Only
 * lifetimes that are documented as facts get a sentence below; everything else
 * gets `cacheTtlMs` (1 h). Anthropic documents 5 min (1 h on request). DeepSeek
 * documents only a typical range ("usually within a few hours to a few days")
 * and OpenCode Go a route over it with no TTL of its own, so DeepSeek runs on
 * the 1 h default too: "usually hours" is not "always more than an hour".
 * z.ai and MiMo publish no TTL. `idleCompaction: false` or `cacheTtlMs: 0`
 * turns the timer off for a model whose cache outlives the session's usefulness.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ReadTracker, formatRanges } from "./lib/read-tracking.ts";

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
	// Cache lifetime assumed for a family with no documented TTL. One hour sits
	// between the documented extremes (Anthropic 5 min, DeepSeek hours-to-days)
	// and is short enough that a normally-used session still compacts while its
	// cache is warm. Documented families override this (FAMILY_CACHE_TTL_MS).
	cacheTtlMs: 60 * 60_000,
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

/**
 * A model as pi identifies it: `id` is the provider's own name for it
 * (`deepseek-v4.1-flash` through opencode-go, `deepseek/deepseek-v4.1-flash`
 * through openrouter), `provider` is the route (`opencode-go`, `openrouter`,
 * `z.ai`). Patterns are globs over either `id` or `provider/id`, so one entry
 * covers every route for a model and every version of a family.
 */
export interface ModelIdentity {
	id: string;
	provider?: string;
}

function identityStrings(model: ModelIdentity | string): string[] {
	if (typeof model === "string") return [model];
	return model.provider ? [model.id, `${model.provider}/${model.id}`] : [model.id];
}

/** Glob match against the model id or its `provider/id` form. */
export function matchModel(pattern: string, model: ModelIdentity | string): boolean {
	return identityStrings(model).some((identity) => matchPattern(pattern, identity));
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
export function resolveThreshold(
	model: ModelIdentity | string,
	contextWindow: number,
	config: AutoCheckpointConfig,
): number {
	const cap = Math.round(config.smallWindowFraction * contextWindow);
	const resolve = (threshold: number): number =>
		threshold < 1 ? Math.round(threshold * contextWindow) : Math.min(threshold, cap);
	for (const [pattern, mcfg] of Object.entries(config.models)) {
		if (matchModel(pattern, model)) return resolve(mcfg.threshold);
	}
	return resolve(config.defaultThreshold);
}

/**
 * Documented prompt-cache lifetimes, keyed by family token so any version
 * inherits its family's value with no config entry: `deepseek-v4.1-flash`,
 * `deepseek/deepseek-v4-pro`, `z-ai/deepseek-v5` all match.
 *
 * Only documented values belong here. A wrong guess is worse than the 1 h
 * default: assuming short compacts sessions whose cache was still warm, while
 * assuming long can pay the full input price for the summary read.
 */
const FAMILY_CACHE_TTL_MS: ReadonlyArray<readonly [pattern: string, ttlMs: number]> = [
	// Anthropic documents the lifetime: 5 min, 1 h when the request asks for
	// `ttl: "1h"`.
	["*claude*", 5 * 60_000],
	["*anthropic*", 5 * 60_000],
	// DeepSeek is deliberately absent. Its cache "works on a best-effort basis"
	// and is cleared "usually within a few hours to a few days"
	// (api-docs.deepseek.com/guides/kv_cache) — a typical range, not a floor, and
	// OpenCode Go's DeepSeek route publishes no lifetime of its own. "Usually
	// hours" is not "always more than an hour", so it takes the 1 h default.
];

/**
 * Resolved per-model config. Precedence for each field: an explicit `models`
 * entry, then a documented family TTL, then the top-level setting.
 */
export function resolveModelConfig(
	model: ModelIdentity | string,
	config: AutoCheckpointConfig,
): {
	cooldownTurns: number;
	cooldownMs: number;
	explicitPrompt: string | null;
	contextDegradation: boolean;
	idleCompaction: boolean;
	cacheTtlMs: number;
} {
	const entry = Object.entries(config.models).find(([pattern]) => matchModel(pattern, model))?.[1];
	const familyTtl = FAMILY_CACHE_TTL_MS.find(([pattern]) => matchModel(pattern, model))?.[1];
	return {
		cooldownTurns: entry?.cooldownTurns ?? config.cooldownTurns,
		cooldownMs: entry?.cooldownMs ?? config.cooldownMs,
		explicitPrompt: entry?.prompt ?? null,
		contextDegradation: entry?.contextDegradation ?? config.defaultContextDegradation,
		idleCompaction: entry?.idleCompaction ?? config.idleCompaction,
		cacheTtlMs: entry?.cacheTtlMs ?? familyTtl ?? config.cacheTtlMs,
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
// Read-region tracking (shared with checkpoint.ts)
// ---------------------------------------------------------------------------

/** Files the model read this session, for the nudge's re-read hints. */
const reads = new ReadTracker();

function formatReadRegions(tracker: ReadTracker): string {
	if (tracker.size === 0) return "";
	const entries = tracker
		.fileSummaries()
		.map(({ path, merged, wholeFile }) => `- ${path}${wholeFile ? " (entire file)" : ` → ${formatRanges(merged)}`}`);
	return (
		`\n\nFiles read this session:\n${entries.join("\n")}` +
		`\n\nWhen checkpointing, include only files you're certain you'll need immediately in relevantPaths — ` +
		`be conservative, you can re-read anything after the checkpoint.`
	);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: {
	config: AutoCheckpointConfig | null;
	model: ModelIdentity | null;
	threshold: number;
	turnCounter: number;
	lastNudgedTurn: number;
	lastNudgedMs: number;
	pending: PendingNudge | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
} = {
	config: null,
	model: null,
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
	state.model = null;
	state.threshold = 0;
	state.turnCounter = 0;
	state.lastNudgedTurn = -1;
	state.lastNudgedMs = -1;
	state.pending = null;
	reads.clear();
}

/** Render the nudge text for a crossover, including tracked read regions. */
function buildNudgeContent(
	tokens: number,
	contextWindow: number,
	percent: number,
	model: ModelIdentity,
): string {
	const mcfg = resolveModelConfig(model, state.config!);
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
	content += formatReadRegions(reads);
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
function ensureModel(ctx: ExtensionContext, config: AutoCheckpointConfig): ModelIdentity | null {
	const currentModel = ctx.model;
	if (currentModel?.id && (state.model?.id !== currentModel.id || state.threshold <= 0)) {
		state.model = { id: currentModel.id, provider: currentModel.provider };
		state.threshold = resolveThreshold(state.model, currentModel.contextWindow ?? 200_000, config);
	}
	return state.model !== null && state.threshold > 0 ? state.model : null;
}

/** Run the idle check and compact when everything still holds at fire time. */
function fireIdleCompaction(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!state.config || !state.model) return;

	// Re-check at fire time: the timer can land in the same instant as a new
	// prompt or a queued follow-up. Never compact under a live run.
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	if (usage.tokens < state.threshold) return;

	const mcfg = resolveModelConfig(state.model, state.config);

	const tokens = usage.tokens;
	const idleMinutes = Math.round(idleCompactDelayMs(mcfg.cacheTtlMs) / 60_000);
	const percent = usage.percent ?? Math.round((tokens / usage.contextWindow) * 100);

	// The summarization read is the only request that must see the whole
	// context; compacting before the cache expires keeps it at cache-read price.
	ctx.compact({
		onComplete: () => {
			// Durable, TUI-only (pi.appendEntry never enters LLM context): a
			// toast is useless here because the user is by definition away.
			pi.appendEntry("auto-checkpoint", { tokens, percent, idleMinutes });
		},
		onError: (error: Error) => {
			if (ctx.hasUI) ctx.ui.notify(`Idle compaction failed: ${error.message}`, "error");
		},
	});
}

/** Arm the idle-compaction timer for a settled session. */
function armIdleCompaction(pi: ExtensionAPI, ctx: ExtensionContext): void {
	clearIdleTimer();
	if (!state.config || !state.model) return;

	// Interactive sessions only. A subagent or RPC session is settled between
	// commands its driver may issue at any moment; compacting under it would
	// summarise context the driver is still using (Claude Code requires an
	// interactive terminal session for the same reason).
	if (ctx.mode !== "tui") return;

	const mcfg = resolveModelConfig(state.model, state.config);
	if (!mcfg.idleCompaction) return;

	const delay = idleCompactDelayMs(mcfg.cacheTtlMs);
	if (delay <= 0) return;

	const timer = setTimeout(() => {
		state.idleTimer = null;
		fireIdleCompaction(pi, ctx);
	}, delay);
	// Don't hold the process open (print/RPC modes must still exit).
	(timer as { unref?: () => void }).unref?.();
	state.idleTimer = timer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- transcript marker for an idle compaction (never enters LLM context) ---
	pi.registerEntryRenderer<{ tokens: number; percent: number; idleMinutes: number }>(
		"auto-checkpoint",
		(entry, _options, theme) => {
			const { tokens, percent, idleMinutes } = entry.data ?? { tokens: 0, percent: 0, idleMinutes: 0 };
			return new Text(
				`compacted while idle — ${tokens.toLocaleString()} tokens (${percent}%) after ${idleMinutes} min idle`,
				1,
				1,
				(text) => theme.fg("muted", text),
			);
		},
	);

	// --- session_start: load config, reset state for fresh session ---
	pi.on("session_start", async (_event, ctx) => {
		state.config = await loadConfig(ctx.cwd);
		resetState();

		const model = ctx.model;
		if (model && model.id) {
			state.model = { id: model.id, provider: model.provider };
			state.threshold = resolveThreshold(state.model, model.contextWindow ?? 200_000, state.config);
		}
	});

	// --- model_select: recompute threshold, clear nudge state ---
	pi.on("model_select", async (event, _ctx) => {
		if (!state.config) return;

		resetState();
		state.model = { id: event.model.id, provider: event.model.provider };
		state.threshold = resolveThreshold(state.model, event.model.contextWindow ?? 200_000, state.config);
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

		const model = ensureModel(ctx, state.config);
		if (!model) return;

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
		const mcfg = resolveModelConfig(model, state.config);
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
					content: buildNudgeContent(tokens, contextWindow, percent, model),
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
	// tool arguments arrive on `tool_result.input`.
	pi.on("tool_result", async (event, ctx) => {
		await reads.recordToolResult(event, ctx.cwd);
	});

	// --- before_agent_start: inject a nudge armed by the previous run's end ---
	pi.on("before_agent_start", async (_event, ctx) => {
		// A run is starting: the session is no longer idle.
		clearIdleTimer();
		if (!state.pending) return;
		if (!state.config) return;

		const { tokens, contextWindow, percent } = state.pending;
		const content = buildNudgeContent(tokens, contextWindow, percent, state.model ?? ctx.model ?? { id: "" });

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
		armIdleCompaction(pi, ctx);
	});

	// --- /checkpoint-status command: show current config & context ---
	pi.registerCommand("checkpoint-status", {
		description: "Show auto-checkpoint configuration and current context usage.",
		async handler(_args, ctx) {
			const model = ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : { id: "no-model" };

			const lines: string[] = [
				"─── Auto-Checkpoint ───",
				`model: ${model.provider ? `${model.provider}/${model.id}` : model.id}`,
			];

			if (state.config) {
				// Calculate effective threshold
				const effectiveThreshold =
					state.threshold > 0
						? state.threshold
						: resolveThreshold(model, ctx.model?.contextWindow ?? 200_000, state.config);

				const mcfg = resolveModelConfig(model, state.config);
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

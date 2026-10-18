/**
 * Session ID Footer
 *
 * Replaces the default footer with one that preserves pi's existing layout
 * (cwd top-left, tokens bottom-left, model bottom-right) and adds a
 * right-aligned session identifier on the right side of the stats line.
 *
 * Encoding: 18 contiguous bits drawn from the random region of the UUID
 * map bijectively to three themed words via three 64-entry lists —
 * adjective, fantasy creature, and class/job, with sci-fi scattered
 * through.
 *
 * Source bits (UUIDv7 layout):
 *   bit 48-51  = version nibble (always 7), skipped
 *   bit 52-55  = hex 13 (random_a byte 0)       ┐
 *   bit 56-59  = hex 14 (random_a byte 1)       ├─ all of random_a (12 bits)
 *   bit 60-63  = hex 15 (random_a byte 2)       ┘
 *   bit 64-65  = variant (always 10), included    \u2190 redundant 2 bits
 *   bit 66-69  = hex 17 (random_b byte 0)       ┐
 *   bit 70-75  = hex 18 top 6 bits (random_b)    ┴\u2014 first 10 bits of random_b
 *
 * Encoded bits: 52-69 of the UUID (18 contiguous bits). Sourcing every
 * encoded bit from the random region guarantees that two sessions in the
 * same millisecond still produce distinct phrases, because random_a and
 * random_b are randomized per UUID by design.
 *
 * Reversibility: looking up each word's index recovers hex chars 13, 14,
 * 15, and 17 of the UUID (4 full hex chars of the random region) plus
 * the top 6 bits of hex 18. Hex 16 (variant, always 8 or 9 for v7) sits
 * between hex 15 and hex 17 and is implicit. Use `decodeSessionFingerprint`
 * for a single grep-friendly string.
 *
 * Format: `adjective-creature-class` (e.g. `arcane-phoenix-archmage`).
 *
 * 64³ = 262,144 distinct phrases. Collision probability between any two
 * random sessions is ~1 in 262k, effectively zero for any real workflow.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Word lists — 64 entries each. Fantasy and sci-fi mixed throughout.
//
// Constraints enforced at module load:
//   - exactly 64 entries per list
//   - all entries unique within each list
//   - no entry appears in more than one list (decode would be ambiguous)
// ---------------------------------------------------------------------------

// Fantasy/sci-fi descriptors: colors, elements, materials, qualities, time.
const ADJECTIVES = [
	"amber", "ancient", "arcane", "ashen", "astral", "atomic", "auroral", "azure",
	"barren", "blazing", "bold", "brazen", "bronze", "burning", "celestial", "cinder",
	"cobalt", "copper", "cosmic", "crimson", "crystal", "cursed", "cyber", "dark",
	"dawn", "deathless", "dire", "distant", "divine", "ebony", "elder", "ember",
	"emerald", "eternal", "ethereal", "frozen", "galactic", "gilded", "glacial", "golden",
	"hallowed", "hidden", "hoary", "icy", "infernal", "jade", "lightning", "lunar",
	"midnight", "molten", "mystic", "nebula", "noble", "obsidian", "phantom", "plasma",
	"primal", "quantum", "radiant", "rippling", "sacred", "shadow", "silver", "stormy",
];

// Fantasy creatures (mythological beasts, races) + sci-fi (androids, synths).
const CREATURES = [
	"angel", "android", "apparition", "archon", "banshee", "basilisk", "behemoth", "chimera",
	"chimaera", "couatl", "demon", "djinn", "drake", "dryad", "efreet", "elemental",
	"elf", "fae", "fiend", "firebird", "genie", "ghost", "giant", "gnome",
	"goblin", "golem", "gorgon", "griffin", "harpy", "hydra", "ifrit", "imp",
	"incubus", "jackal", "kraken", "lich", "manticore", "medusa", "mephit", "mimic",
	"minotaur", "mummy", "naga", "nymph", "ogre", "oni", "oracle", "pegasus",
	"phoenix", "pixie", "revenant", "roc", "salamander", "seraph", "shade", "siren",
	"sphinx", "sprite", "succubus", "synth", "titan", "treant", "unicorn", "wraith",
];

// Fantasy classes (mage, cleric…) + occupations + sci-fi roles.
const CLASSES = [
	"alchemist", "arbalist", "arcanist", "archer", "archmage", "artificer", "assassin", "astromancer",
	"augur", "barbarian", "bard", "binder", "cleric", "conjurer", "crusader", "cultist",
	"diplomat", "diviner", "druid", "duelist", "enchanter", "executioner", "explorer", "gladiator",
	"gunslinger", "hacker", "harbinger", "healer", "hexer", "hunter", "illusionist", "inquisitor",
	"invoker", "knight", "monk", "navigator", "necromancer", "occultist", "paladin", "pathfinder",
	"pilgrim", "pilot", "priest", "psion", "ranger", "reaver", "rogue", "sage",
	"scout", "shaman", "smith", "sorcerer", "summoner", "swashbuckler", "templar", "thief",
	"vanguard", "warden", "warmage", "warrior", "wizard", "wonderer", "zealot", "zephyrus",
];

// Build a quick lookup from word → index for the decoder.
const ADJ_INDEX = new Map(ADJECTIVES.map((w, i) => [w, i]));
const CRE_INDEX = new Map(CREATURES.map((w, i) => [w, i]));
const CLS_INDEX = new Map(CLASSES.map((w, i) => [w, i]));

// Compile-time invariant checks. A typo'd entry or cross-list collision
// would corrupt the encoding, so fail loudly rather than silently producing
// ambiguous output.
function assertValid(name: string, list: string[], index: Map<string, number>) {
	if (list.length !== 64) throw new Error(`${name}: need 64 entries, got ${list.length}`);
	if (index.size !== 64) throw new Error(`${name}: ${64 - index.size} duplicate entries`);
}
assertValid("ADJECTIVES", ADJECTIVES, ADJ_INDEX);
assertValid("CREATURES", CREATURES, CRE_INDEX);
assertValid("CLASSES", CLASSES, CLS_INDEX);
for (const w of ADJECTIVES) {
	if (CRE_INDEX.has(w) || CLS_INDEX.has(w)) {
		throw new Error(`ADJECTIVES: '${w}' collides with another list`);
	}
}
for (const w of CREATURES) {
	if (CLS_INDEX.has(w)) {
		throw new Error(`CREATURES: '${w}' collides with CLASSES`);
	}
}

// ---------------------------------------------------------------------------
// Encoding — bijective mapping from first 18 bits of UUID → 3 themed words.
// ---------------------------------------------------------------------------

/**
 * Extract the 18-bit value used to index all three words. Same value drives
 * both the phrase and the per-session color, so adding color costs no
 * extra entropy. Returns null if the UUID is too short to read.
 */
export function sessionBits(uuid: string): number | null {
	const hex = uuid.replace(/-/g, "").slice(0, 20);
	if (hex.length < 20) return null;
	const ra = parseInt(hex.slice(13, 16), 16);
	const rbTop = (parseInt(hex.slice(17, 19), 16) >>> 2) & 0x3f;
	return (ra << 6) | rbTop;
}

/** Encode a UUID session ID as `adjective-creature-class`. */
export function encodeSessionId(uuid: string): string {
	const v = sessionBits(uuid);
	if (v === null) return "wandering-???-seeker";
	const a = (v >> 12) & 0x3f;
	const c = (v >> 6) & 0x3f;
	const k = v & 0x3f;
	return `${ADJECTIVES[a]}-${CREATURES[c]}-${CLASSES[k]}`;
}

/**
 * Map HSL to an ANSI truecolor fg escape code. h ∈ [0, 360), s and l are
 * percentages. Used to give each session a distinct, deterministic color.
 */
function hslToAnsiFg(h: number, s: number, l: number): string {
	const sn = s / 100;
	const ln = l / 100;
	const c = (1 - Math.abs(2 * ln - 1)) * sn;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = ln - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	r = Math.round((r + m) * 255);
	g = Math.round((g + m) * 255);
	b = Math.round((b + m) * 255);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Per-session color derived from the same 18-bit value as the phrase.
 * Sweeps the full hue range (linear: v / 2^18 * 360); saturation is held
 * constant so the only varying dimension is hue. Lightness is configurable
 * so the staleness indicator can fade the words while keeping the hue.
 * Defaults to 58 — slightly desaturated (60%) and middling lightness,
 * legible against both light and dark backgrounds.
 */
export function sessionColor(uuid: string, lightness: number = 58): string {
	const v = sessionBits(uuid);
	if (v === null) return "";
	const hue = (v / 262144) * 360;
	return hslToAnsiFg(hue, 60, lightness);
}

/** Staleness table: time since last activity mapped to a glyph + lightness.
 *  Hand-tuned 6 buckets with thresholds at 30s, 5m, 30m, 2h, 8h. Bucket
 *  widths grow roughly 10× each step (log-ish), giving more resolution
 *  where short-lived sessions need to be distinguishable (minutes) and
 *  fewer buckets across the long tail (hours). Glyph fill drops ~25% per
 *  step so adjacent states are visually distinct even when the lightness
 *  delta is small; lightness itself ramps 60 → 38 across the full range.
 *  Sessions idle for 8h or more land in the final bucket (max stale). */
type Staleness = { glyph: string; lightness: number };

const STALENESS_BUCKETS: ReadonlyArray<{ maxAgeMs: number; staleness: Staleness }> = [
	{ maxAgeMs: 30_000, staleness: { glyph: "\u25cf", lightness: 60 } }, //   < 30s: just finished
	{ maxAgeMs: 5 * 60_000, staleness: { glyph: "\u25d5", lightness: 56 } }, //   < 5m: brief pause
	{ maxAgeMs: 30 * 60_000, staleness: { glyph: "\u25d0", lightness: 52 } }, //   < 30m: short break
	{ maxAgeMs: 2 * 60 * 60_000, staleness: { glyph: "\u25d4", lightness: 47 } }, //   < 2h: pause
	{ maxAgeMs: 8 * 60 * 60_000, staleness: { glyph: "\u25cc", lightness: 43 } }, //   < 8h: long break
	{ maxAgeMs: Number.POSITIVE_INFINITY, staleness: { glyph: "\u25cb", lightness: 38 } }, //   >= 8h: stale
];

function stalenessFor(ageMs: number): Staleness {
	const hit = STALENESS_BUCKETS.find((b) => ageMs < b.maxAgeMs);
	return (hit ?? STALENESS_BUCKETS[STALENESS_BUCKETS.length - 1]!).staleness;
}

/** Time elapsed since the most recent entry on the current branch, in ms.
 *  Returns 0 for sessions with no entries yet (treated as fresh). */
function lastActivityMs(entries: ReadonlyArray<unknown>): number {
	let latest = 0;
	for (const entry of entries) {
		const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		if (Number.isFinite(ts) && ts > latest) latest = ts;
	}
	return latest;
}

/** Current thinking level from the most recent `thinking_level_change`
 *  entry on the current branch. `getBranch()` returns leaf-to-root, so the
 *  first match is the active one. Returns undefined if no such entry
 *  exists yet (treat as "off"). */
function currentThinkingLevel(branch: ReadonlyArray<unknown>): string | undefined {
	// getBranch() returns root-to-leaf (chronological), so iterate in reverse to
	// find the most recent thinking_level_change entry.
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: string; thinkingLevel?: string };
		if (e.type === "thinking_level_change") return e.thinkingLevel;
	}
	return undefined;
}

/** Internal: reverse `encodeSessionId` to its raw 18-bit value. */
function decodeToValue(words: string): number | null {
	const parts = words.toLowerCase().split("-");
	if (parts.length !== 3) return null;
	const a = ADJ_INDEX.get(parts[0]);
	const c = CRE_INDEX.get(parts[1]);
	const k = CLS_INDEX.get(parts[2]);
	if (a === undefined || c === undefined || k === undefined) return null;
	return (a << 12) | (c << 6) | k;
}

/**
 * Reverse the encoding. Returns the recovered random-region bits:
 * hex chars 13, 14, 15 (full random_a nibbles) and hex 17 plus the top 2
 * bits of hex 18 (top of random_b).
 */
export function decodeSessionWords(words: string): {
	hex13: string;
	hex14: string;
	hex15: string;
	hex17: string;
	hex18Top2: number;
} | null {
	const v = decodeToValue(words);
	if (v === null) return null;
	const ra = (v >> 6) & 0xfff; // top 12 = random_a
	const rbTop = v & 0x3f; // bottom 6 = top of random_b
	return {
		hex13: (ra >> 8).toString(16),
		hex14: ((ra >> 4) & 0xf).toString(16),
		hex15: (ra & 0xf).toString(16),
		hex17: (rbTop >> 2).toString(16),
		hex18Top2: rbTop & 0x3, // 0..3 = top 2 bits of hex 18
	};
}

/**
 * Convenience: returns a grep-friendly fingerprint string. Format is
 * `XYZW:N` where X,Y,Z,W are full hex chars (hex 13, 14, 15, 17) of the
 * random region and N is the top 2 bits of hex 18 (a digit 0-3). UUIDv7's
 * variant nibble (hex 16, always 8 or 9) sits between Z and W and is implicit.
 *
 * Example: a UUID with random region `7abcdef0` produces fingerprint `7ab:e`.
 */
export function decodeSessionFingerprint(words: string): string | null {
	const d = decodeSessionWords(words);
	if (!d) return null;
	return `${d.hex13}${d.hex14}${d.hex15}${d.hex17}:${d.hex18Top2}`;
}

// ---------------------------------------------------------------------------
// Footer rendering — port of pi's FooterComponent with session-words added.
// We can't extend the built-in footer, only replace it, so the existing
// layout (pwd / stats+model / extension-statuses) is reimplemented here.
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

type Theme = {
	fg: (color: string, text: string) => string;
	bold: (s: string) => string;
	// Optional — absent on stubs/older theme objects. darkenAccentFg degrades
	// to the dim token when either member is missing.
	getFgAnsi?: (color: string) => string;
	getColorMode?: () => "truecolor" | "256color";
};
type FooterData = {
	getGitBranch: () => string | null;
	getExtensionStatuses: () => ReadonlyMap<string, string>;
	getAvailableProviderCount: () => number;
	onBranchChange: (cb: () => void) => () => void;
};
type FooterFactoryCtx = {
	sessionManager: {
		getEntries(): unknown[];
		getBranch(): unknown[];
		getCwd(): string;
		getSessionName(): string | undefined;
		getSessionId(): string;
		getHeader(): { timestamp?: string } | null;
	};
	model: { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
	modelRegistry?: {
		isUsingOAuth?: (model: unknown) => boolean;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};
	getContextUsage?: () => {
		contextWindow?: number;
		percent?: number | null;
	} | undefined;
};

// ---------------------------------------------------------------------------
// Z.ai coding-plan quota — undocumented endpoint consumed by community tools.
// https://api.z.ai/api/monitor/usage/quota/limit
// ---------------------------------------------------------------------------

/** Cached quota data, written by the poll interval and read by render(). */
let cachedQuota: QuotaData | undefined;

/** Set to true after the first fetch failure to suppress repeated console.warn. */
let quotaWarnedOnce = false;

/** Resolved z.ai API key (cached after first resolution), or undefined if unavailable. */
let resolvedZaiKey: string | undefined;

/** True once the API key has been resolved (even if null — prevents re-resolution). */
let zaiKeyResolved = false;

/** Set to true after the first MiniMax fetch failure to suppress repeated console.warn. */
let minimaxWarnedOnce = false;

/** Resolved MiniMax API key (cached per-provider after first resolution). */
let cachedMinimaxKey: { provider: string; key: string } | undefined;

/** Per-provider quota endpoint. Documented in platform.minimax.io Token Plan FAQ. */
const MINIMAX_ENDPOINTS: Record<string, string> = {
	"minimax":    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
	"minimax-cn": "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
};

interface QuotaLimitItem {
	type: string;
	unit: number;
	percentage: number;
	usage: number;
	currentValue: number;
	nextResetTime?: number;
}

interface QuotaData {
	level: string;
	limits: QuotaLimitItem[];
}

/**
 * Fetch z.ai coding-plan quota from the undocumented endpoint.
 * No Authorization header prefix — bare key.
 */
async function fetchQuota(apiKey: string): Promise<QuotaData | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(
			"https://api.z.ai/api/monitor/usage/quota/limit",
			{
				headers: { Authorization: apiKey },
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			if (!quotaWarnedOnce) {
				console.warn(`[footer-session-id] quota fetch failed: HTTP ${res.status}`);
				quotaWarnedOnce = true;
			}
			return undefined;
		}
		const json = await res.json() as {
			code?: number;
			data?: { level?: string; limits?: QuotaLimitItem[] };
			success?: boolean;
		};
		if (!json.data?.limits || json.success === false) {
			if (!quotaWarnedOnce) {
				console.warn("[footer-session-id] quota response missing limits field");
				quotaWarnedOnce = true;
			}
			return undefined;
		}
		return {
			level: json.data.level ?? "unknown",
			limits: json.data.limits,
		};
	} catch (err: unknown) {
		if (!quotaWarnedOnce) {
			console.warn(
				"[footer-session-id] quota fetch error:",
				err instanceof Error ? err.message : String(err),
			);
			quotaWarnedOnce = true;
		}
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Resolve and cache the z.ai API key. Returns true if any key is configured.
 *
 * Do NOT gate on a key-prefix heuristic: the endpoint response is the authority
 * on whether this is a coding-plan key. Real coding-plan keys do not
 * consistently start with `sk-sp-` (verified against a live Pro subscription
 * whose key had a hex prefix). A standard pay-as-you-go key simply returns no
 * `data.limits`, which renderQuotaSegment already treats as "render nothing".
 */
async function ensureZaiKey(ctx: FooterFactoryCtx): Promise<boolean> {
	if (zaiKeyResolved) return !!resolvedZaiKey;
	zaiKeyResolved = true;
	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider?.("zai");
		if (key) {
			resolvedZaiKey = key;
			return true;
		}
		resolvedZaiKey = undefined;
		return false;
	} catch {
		resolvedZaiKey = undefined;
		return false;
	}
}

/**
 * Fetch MiniMax (minimaxi.com / minimax.io) Token Plan quota. Documented in
 * platform.minimax.io/docs/token-plan/faq ("Method 2: Use the API Endpoint").
 *
 * Returns the same QuotaData shape as fetchQuota, normalized so that
 * renderQuotaSegment can consume it without knowing the provider. Selects
 * the "general" bucket (text-model quota); falls back to the first bucket.
 *
 * No key-prefix check — endpoint response is the authority (same rationale
 * as ensureZaiKey: a pay-as-you-go key returns base_resp.status_code != 0
 * and renderQuotaSegment naturally treats that as "render nothing").
 */
async function fetchMinimaxQuota(apiKey: string, provider: string): Promise<QuotaData | undefined> {
	const url = MINIMAX_ENDPOINTS[provider];
	if (!url) return undefined;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			if (!minimaxWarnedOnce) {
				console.warn(`[footer-session-id] MiniMax quota fetch failed: HTTP ${res.status}`);
				minimaxWarnedOnce = true;
			}
			return undefined;
		}
		const json = await res.json() as {
			model_remains?: Array<{
				model_name?: string;
				current_interval_remaining_percent?: number;
				current_weekly_remaining_percent?: number;
				remains_time?: number;
				weekly_remains_time?: number;
				current_interval_status?: number;
			}>;
			base_resp?: { status_code?: number; status_msg?: string };
		};

		if (json.base_resp?.status_code !== 0) {
			if (!minimaxWarnedOnce) {
				console.warn(
					`[footer-session-id] MiniMax quota API error: ${json.base_resp?.status_code} ${json.base_resp?.status_msg ?? ""}`,
				);
				minimaxWarnedOnce = true;
			}
			return undefined;
		}

		const buckets = json.model_remains;
		if (!buckets || buckets.length === 0) {
			if (!minimaxWarnedOnce) {
				console.warn("[footer-session-id] MiniMax quota response has no model_remains");
				minimaxWarnedOnce = true;
			}
			return undefined;
		}

		// Prefer "general" (text-model quota); fall back to the first bucket.
		const bucket = buckets.find((b) => b.model_name === "general") ?? buckets[0];
		if (!bucket) return undefined;

		const fivePct = bucket.current_interval_remaining_percent;
		const weeklyPct = bucket.current_weekly_remaining_percent;
		if (typeof fivePct !== "number" || typeof weeklyPct !== "number") {
			if (!minimaxWarnedOnce) {
				console.warn("[footer-session-id] MiniMax quota response missing percentage fields");
				minimaxWarnedOnce = true;
			}
			return undefined;
		}

		const now = Date.now();
		const status = bucket.current_interval_status;

		// Status: 1 = normal (limited), 2 = exhausted, 3 = unlimited.
		// Use `level` to surface notable states only; normal status leaves it
		// blank so the healthy display stays clean (no `· ok` clutter).
		let level = "";
		if (status === 2) level = "exhausted";
		else if (status === 3) level = "unlimited";

		return {
			level,
			limits: [
				{
					type: "TOKENS_LIMIT",
					unit: 3,
					percentage: Math.max(0, Math.min(100, 100 - fivePct)),  // used %
					nextResetTime:
						typeof bucket.remains_time === "number" ? now + bucket.remains_time : undefined,
				},
				{
					type: "TOKENS_LIMIT",
					unit: 6,
					percentage: Math.max(0, Math.min(100, 100 - weeklyPct)),
					nextResetTime:
						typeof bucket.weekly_remains_time === "number"
							? now + bucket.weekly_remains_time
							: undefined,
				},
			],
		};
	} catch (err: unknown) {
		if (!minimaxWarnedOnce) {
			console.warn(
				"[footer-session-id] MiniMax quota fetch error:",
				err instanceof Error ? err.message : String(err),
			);
			minimaxWarnedOnce = true;
		}
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Resolve and cache the MiniMax API key. Cached per-provider so a session
 * that switches between minimax and minimax-cn re-resolves on the second
 * provider. No key-prefix check, same rationale as ensureZaiKey.
 */
async function ensureMinimaxKey(
	ctx: FooterFactoryCtx,
	provider: string,
): Promise<string | undefined> {
	if (cachedMinimaxKey && cachedMinimaxKey.provider === provider) {
		return cachedMinimaxKey.key;
	}
	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider?.(provider);
		if (key) {
			cachedMinimaxKey = { provider, key };
			return key;
		}
		cachedMinimaxKey = undefined;
		return undefined;
	} catch {
		cachedMinimaxKey = undefined;
		return undefined;
	}
}

/**
 * Run one quota cycle: clear stale data on switch-away from zai, fetch on
 * switch-to-zai. Triggers a render whenever cachedQuota is mutated, so the
 * footer reflects the new state without waiting for the 60s polling tick.
 *
 * Fire-and-forget at call sites — render() reads cachedQuota at draw time,
 * so the awaiter doesn't need to block on the network round-trip.
 */
async function refreshQuotaNow(
	fc: FooterFactoryCtx,
	requestRender: (() => void) | null | undefined,
): Promise<void> {
	const provider = fc.model?.provider;

	if (provider === "zai") {
		const hasKey = await ensureZaiKey(fc);
		if (!hasKey || !resolvedZaiKey) {
			cachedQuota = undefined;
			return;
		}
		const quota = await fetchQuota(resolvedZaiKey);
		if (quota) {
			cachedQuota = quota;
			requestRender?.();
		}
		return;
	}

	if (provider === "minimax" || provider === "minimax-cn") {
		const key = await ensureMinimaxKey(fc, provider);
		if (!key) {
			cachedQuota = undefined;
			return;
		}
		const quota = await fetchMinimaxQuota(key, provider);
		if (quota) {
			cachedQuota = quota;
			requestRender?.();
		}
		return;
	}

	if (provider === "opencode-go") {
		const hasKey = await ensureGoKey(fc);
		if (!hasKey || !resolvedGoKey) {
			cachedGoUsage = undefined;
			return;
		}
		const usage = await fetchOpenCodeUsage(resolvedGoKey);
		if (usage) {
			cachedGoUsage = usage;
			requestRender?.();
		}
		return;
	}

	// Switch-away (or never-supported): drop any stale quota so it can't
	// show up under a model that doesn't have a quota fetcher.
	cachedQuota = undefined;
	cachedGoUsage = undefined;
	requestRender?.();
}

/** Unit → display label mapping for quota windows. */
const QUOTA_LABELS: Record<number, string> = {
	3: "5h",   // TOKENS_LIMIT, 5-hour rolling window
	6: "7d",   // TOKENS_LIMIT, weekly
	5: "MCP",  // TIME_LIMIT, monthly MCP cap (web search / reader / Zread)
};

/**
 * Format a compact duration-until-reset from a Unix-ms timestamp.
 * Returns "" when the timestamp is missing or already in the past (the next
 * poll tick refreshes with a fresh reset time — never render a stale/reset one).
 *   <1h → "47m",   <1d → "4.9h",   ≥1d → "6.5d"
 */
function formatResetDuration(nextResetTime: number | undefined, now: number): string {
	if (!nextResetTime) return "";
	const deltaMs = nextResetTime - now;
	if (deltaMs <= 0) return "";
	const mins = deltaMs / 60000;
	if (mins < 60) return `${Math.round(mins)}m`;
	const hrs = mins / 60;
	if (hrs < 24) return `${hrs.toFixed(1)}h`;
	return `${(hrs / 24).toFixed(1)}d`;
}

/**
 * Determine the z.ai peak/off-peak quota multiplier for the given model.
 * Returns undefined when the model is not subject to peak pricing.
 * Peak hours: 14:00–18:00 Beijing time (Asia/Shanghai, UTC+8).
 * Off-peak: 2× (1× promo through 2026-09-30; hard-code 2× until then).
 */
function getZaiMultiplier(
	modelId: string | undefined,
	now?: Date,
): 3 | 2 | undefined {
	if (!modelId) return undefined;
	const lower = modelId.toLowerCase();
	if (!lower.includes("glm-5.2") && !lower.includes("glm-5-turbo")) return undefined;

	const beijing = new Date(
		(now ?? new Date()).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }),
	);
	const hour = beijing.getHours();

	if (hour >= 14 && hour < 18) return 3;
	return 2;
}

/** Quota percentage with the shared pressure-color thresholds (≥85 error,
 * ≥60 warning, else success). */
function colorUsedPct(
	theme: { fg: (color: string, text: string) => string },
	usedPct: number,
): string {
	const pct = `${usedPct}%`;
	if (usedPct >= 85) return theme.fg("error", pct);
	if (usedPct >= 60) return theme.fg("warning", pct);
	return theme.fg("success", pct);
}

/**
 * Build the quota segment string for the footer top line.
 * Returns empty string when no quota data is available or model is not zai.
 */
function renderQuotaSegment(
	quota: QuotaData | undefined,
	modelProvider: string | undefined,
	modelId: string | undefined,
	width: number,
	theme: { fg: (color: string, text: string) => string },
	now?: Date,
): string {
	if (
		modelProvider !== "zai" &&
		modelProvider !== "minimax" &&
		modelProvider !== "minimax-cn"
	) return "";
	if (!quota || !quota.limits.length) return "";

	const parts: string[] = [];

	// Unit 3 = 5h window, unit 6 = 7d window (always show when available)
	for (const u of [3, 6] as const) {
		const entry = quota.limits.find((l) => l.unit === u);
		if (!entry) continue;
		const usedPct = entry.percentage;
		const label = QUOTA_LABELS[u] ?? `u${u}`;
		const coloredPct = colorUsedPct(theme, usedPct);
		let part = `${label}:${coloredPct}`;
		// Append compact duration until reset (always shown) for both token
		// windows — the "when do I get capacity back" signal. Monthly MCP
		// (unit 5) reset stays off; it's too far out and MCP only renders
		// when in use anyway.
		if (u === 3 || u === 6) {
			const reset = formatResetDuration(entry.nextResetTime, Date.now());
			if (reset) part += ` ${theme.fg("dim", reset)}`;
		}
		parts.push(part);
	}

	// MCP (unit 5) — only if non-zero usage
	const mcpEntry = quota.limits.find((l) => l.unit === 5);
	if (mcpEntry && mcpEntry.currentValue > 0) {
		const usedPct = mcpEntry.percentage;
		const coloredPct = colorUsedPct(theme, usedPct);
		parts.push(`MCP:${coloredPct}`);
	}

	// Z.ai peak/off-peak multiplier prefix — prepended when a subject model
	// (GLM-5.2 or GLM-5-Turbo) is active. The 1× off-peak promo runs through
	// 2026-09-30; hard-code 2× until then.
	if (modelProvider === "zai") {
		const mult = getZaiMultiplier(modelId, now);
		if (mult === 3) parts.unshift(theme.fg("warning", "3\u00d7"));
		else if (mult === 2) parts.unshift(theme.fg("dim", "2\u00d7"));
	}

	if (parts.length === 0) return "";

	// Plan tier at the end, dimmed (omitted when empty — MiniMax normal
	// status leaves `level` blank to keep the healthy display clean).
	const tier = quota.level.toLowerCase();
	if (tier) parts.push(`${theme.fg("dim", `· ${tier}`)}`);

	const segment = parts.join(" ");

	// Width-budget check: drop MCP first, then tier, if too wide
	const segWidth = visibleWidth(segment);
	if (segWidth <= width) return segment;

	// Try dropping MCP
	const noMcpParts = parts.filter((elem) => !elem.startsWith("MCP:"));
	if (noMcpParts.length >= 2) {
		const noMcp = noMcpParts.join(" ");
		if (visibleWidth(noMcp) <= width) return noMcp;
		// Drop tier too
		const noTierParts = noMcpParts.filter((_, i) => {
			// tier is the last entry (starts with dim "· ")
			return i < noMcpParts.length - 1;
		});
		if (noTierParts.length >= 1) {
			const noTier = noTierParts.join(" ");
			if (visibleWidth(noTier) <= width) return noTier;
			// Drastic: just show the first entry
			return parts[0]!;
		}
	}
	// Fallback: just return the first entry
	return parts[0]!;
}

// ---------------------------------------------------------------------------
// OpenCode Go plan usage — GET /zen/go/v1/usage (the only usage endpoint the
// public proxy exposes; per-model detail is server-side only — see
// opencode issues #31084/#43983).
//
// Display (owner spec, model-tiers/004 monthly-cap-only cost metric):
//   rolling: percent + time left              `5h:1% 4.6h`
//   weekly:  percent + %-through + days left  `7d:17% thru86% 1.0d`
//   monthly: percent + %-through + days left  `mo:8% thru6% 29.3d`
// The window start is not in the payload: weekly = resetsAt − 7d (exact),
// monthly = resetsAt − 1 calendar month (billing anniversary — resetsAt keeps
// the wall-clock time of day, e.g. 21:19:11, so the anchor is stable).
// ---------------------------------------------------------------------------

export type GoUsageWindow = { percent: number; resetsAtMs: number };
export type GoUsage = {
	rolling?: GoUsageWindow;
	weekly?: GoUsageWindow;
	monthly?: GoUsageWindow;
};

/** Cached Go usage, written by the poll cycle and read by render(). */
let cachedGoUsage: GoUsage | undefined;

/** Suppress repeated console.warn after the first Go fetch failure. */
let goWarnedOnce = false;

/** Resolved OpenCode Go API key (cached), undefined when unavailable. */
let resolvedGoKey: string | undefined;

/** True once the Go key has been resolved (even if null). */
let goKeyResolved = false;

/** Normalize the /zen/go/v1/usage payload. Windows missing percent or a
 * parseable resetsAt are skipped; nothing usable → undefined. */
export function normalizeGoUsage(json: unknown): GoUsage | undefined {
	const root = (json as { usage?: Record<string, unknown> })?.usage;
	if (!root || typeof root !== "object") return undefined;
	const out: GoUsage = {};
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const w = root[key] as { percent?: unknown; resetsAt?: unknown } | undefined;
		if (!w || typeof w.percent !== "number" || typeof w.resetsAt !== "string") continue;
		const ms = Date.parse(w.resetsAt);
		if (!Number.isFinite(ms)) continue;
		out[key] = { percent: Math.round(w.percent), resetsAtMs: ms };
	}
	return out.rolling || out.weekly || out.monthly ? out : undefined;
}

async function fetchOpenCodeUsage(apiKey: string): Promise<GoUsage | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			if (!goWarnedOnce) {
				console.warn(`[footer-session-id] opencode-go usage fetch failed: HTTP ${res.status}`);
				goWarnedOnce = true;
			}
			return undefined;
		}
		const usage = normalizeGoUsage(await res.json());
		if (!usage && !goWarnedOnce) {
			console.warn("[footer-session-id] opencode-go usage response missing windows");
			goWarnedOnce = true;
		}
		return usage;
	} catch (err: unknown) {
		if (!goWarnedOnce) {
			console.warn(
				"[footer-session-id] opencode-go usage fetch error:",
				err instanceof Error ? err.message : String(err),
			);
			goWarnedOnce = true;
		}
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Resolve and cache the OpenCode Go API key (`oc_sk_…` in auth.json under
 * the `opencode-go` provider). */
async function ensureGoKey(ctx: FooterFactoryCtx): Promise<boolean> {
	if (goKeyResolved) return !!resolvedGoKey;
	goKeyResolved = true;
	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider?.("opencode-go");
		resolvedGoKey = key || undefined;
		return !!resolvedGoKey;
	} catch {
		resolvedGoKey = undefined;
		return false;
	}
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** %-through the current 7d window (start = resetsAt − 7d). Clamped to 0..100. */
export function weeklyThroughPercent(now: number, resetsAtMs: number): number {
	const start = resetsAtMs - WEEK_MS;
	return Math.max(0, Math.min(100, ((now - start) / WEEK_MS) * 100));
}

/** %-through the current billing-month window (start = resetsAt minus one
 * calendar month). Clamped to 0..100. */
export function monthlyThroughPercent(now: number, resetsAtMs: number): number {
	const start = new Date(resetsAtMs);
	start.setMonth(start.getMonth() - 1);
	const startMs = start.getTime();
	const len = resetsAtMs - startMs;
	if (!(len > 0)) return 0;
	return Math.max(0, Math.min(100, ((now - startMs) / len) * 100));
}

/** Go usage segment for the footer's quota slot. Empty string when the
 * provider is not opencode-go or no usage is cached. */
export function renderGoUsageSegment(
	usage: GoUsage | undefined,
	modelProvider: string | undefined,
	width: number,
	theme: { fg: (color: string, text: string) => string },
	now?: number,
): string {
	if (modelProvider !== "opencode-go" || !usage) return "";
	const t = now ?? Date.now();

	const part = (label: string, w: GoUsageWindow, withThrough: boolean, throughOf: (n: number, r: number) => number): string => {
		const bits = [`${label}:${colorUsedPct(theme, w.percent)}`];
		if (withThrough) bits.push(theme.fg("dim", `thru${Math.round(throughOf(t, w.resetsAtMs))}%`));
		const reset = formatResetDuration(w.resetsAtMs, t);
		if (reset) bits.push(theme.fg("dim", reset));
		return bits.join(" ");
	};

	const parts: string[] = [];
	if (usage.rolling) parts.push(part("5h", usage.rolling, false, weeklyThroughPercent));
	if (usage.weekly) parts.push(part("7d", usage.weekly, true, weeklyThroughPercent));
	if (usage.monthly) parts.push(part("mo", usage.monthly, true, monthlyThroughPercent));
	if (parts.length === 0) return "";

	// Width ladder: all windows → drop monthly (furthest out) → rolling only.
	for (let keep = parts.length; keep >= 1; keep--) {
		const candidate = parts.slice(0, keep).join(" ");
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth(parts[0]!, width, theme.fg("dim", "..."));
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_DIR_NAME = ".pi";

function readAutoCompactEnabled(): boolean {
	try {
		const envDir = process.env[ENV_AGENT_DIR];
		const agentDir = envDir || path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
		const settingsPath = path.join(agentDir, "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { compaction?: { enabled?: boolean } };
		return parsed.compaction?.enabled ?? true;
	} catch {
		return true;
	}
}

// Initial value at module load. Updated by the render interval in the footer
// factory below; also re-read on every branch change via requestRender.
let cachedAutoCompactEnabled = readAutoCompactEnabled();

// Holds the active footer's requestRender so thinking_level_select can
// trigger a redraw without waiting for the 30s interval or a branch change.
let requestRenderRef: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Activity timeline — 7-day logarithmic timeline row (half-cell resolution)
// ---------------------------------------------------------------------------

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 604 800 000
const MIN_AGE_MS = 60 * 1000; // 60 000 (log floor)
const R_LOG = Math.log(WINDOW_MS / MIN_AGE_MS); // ln(10080) ≈ 9.22

/** How translucent the llm-only (dark) state reads, as alpha over the background. */
const DARK_ALPHA = 0.5;

/** Terminal background RGB (OSC 11 query result), used to composite the dark state. */
type RgbColor = { r: number; g: number; b: number };

/** Cached terminal background; undefined until the OSC 11 query resolves. */
let cachedBgRgb: RgbColor | undefined;
let bgQueryStarted = false;

/**
 * Map an age (ms) to a virtual half-column index (v2 scale: 2× width).
 * Left = 7 days ago, right = now. Ages < MIN_AGE_MS map to the rightmost
 * half-column; ages ≥ WINDOW_MS clamp to 0 (leftmost). width < 1 → 0.
 */
export function timelineColumn(ageMs: number, width: number): number {
	if (width < 1) return 0;
	if (!Number.isFinite(ageMs)) return 0;
	const age = Math.max(ageMs, MIN_AGE_MS);
	const f = Math.log(age / MIN_AGE_MS) / R_LOG;
	const col = width - 1 - Math.floor(f * width);
	return Math.max(0, Math.min(width - 1, col));
}

/**
 * One physical column = two half-cells. `left` covers the earlier sub-slot,
 * `right` the later one. State per half: user activity is `bright`, llm-only
 * activity is `dark`, nothing is `none`.
 */
export type TimelineCell = {
	left: "bright" | "dark" | "none"; // earlier sub-slot
	right: "bright" | "dark" | "none"; // later sub-slot
	isSessionStart: boolean;
};

const HALF_ROLES = new Set(["assistant", "toolResult", "bashExecution"]);

/**
 * Compute one TimelineCell per column (exactly `width` cells) from session
 * entries. Each in-range message maps to a half-cell via the virtual 2×width
 * scale: v = timelineColumn(ageMs, 2*width) → column floor(v/2), half v%2
 * (0 = left/earlier, 1 = right/later).
 */
export function computeTimelineCells(
	entries: unknown[],
	nowMs: number,
	width: number,
	sessionStartMs: number | undefined,
): TimelineCell[] {
	if (width < 1) return [];

	const cells: TimelineCell[] = Array.from({ length: width }, () => ({
		left: "none",
		right: "none",
		isSessionStart: false,
	}));

	for (const entry of entries) {
		const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		if (!Number.isFinite(ts)) continue;

		const ageMs = nowMs - ts;
		if (ageMs >= WINDOW_MS) continue; // outside window

		const v = timelineColumn(ageMs, 2 * width);
		const k = Math.floor(v / 2); // physical column
		const h = v % 2; // 0 = left half (earlier), 1 = right half (later)
		const current = cells[k]!;

		const e = entry as { type?: string; message?: { role?: string } };
		if (e.type !== "message" || !e.message?.role) continue;

		// Per-half precedence: bright (user) > dark (llm) > none.
		if (e.message.role === "user") {
			if (h === 0) current.left = "bright";
			else current.right = "bright";
		} else if (HALF_ROLES.has(e.message.role)) {
			if (h === 0) {
				if (current.left === "none") current.left = "dark";
			} else if (current.right === "none") {
				current.right = "dark";
			}
		}
		// Non-message entries and unrecognised roles are ignored
	}

	// Session-start marker: computed once, applied last (overrides).
	// Column-level — which half the start age lands in doesn't matter.
	if (sessionStartMs !== undefined) {
		const startAge = nowMs - sessionStartMs;
		if (startAge < WINDOW_MS) {
			const markerV = timelineColumn(startAge, 2 * width);
			cells[Math.floor(markerV / 2)]!.isSessionStart = true;
		}
	}

	return cells;
}

/**
 * Resolve the session start timestamp from the header, falling back to
 * the first entry's timestamp, or returning undefined.
 */
export function resolveSessionStartMs(
	headerTimestamp: string | undefined,
	entries: unknown[],
): number | undefined {
	if (headerTimestamp !== undefined) {
		const ts = Date.parse(headerTimestamp);
		if (Number.isFinite(ts)) return ts;
	}
	// Fallback: first entry's parseable timestamp
	for (const entry of entries) {
		const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		if (Number.isFinite(ts)) return ts;
	}
	return undefined;
}

/**
 * Convert an RGB color to HSL. h ∈ [0, 360), s/l as percentages (0–100) —
 * the same parameter convention hslToAnsiFg expects.
 */
export function rgbToHsl(
	r: number,
	g: number,
	b: number,
): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
		else if (max === gn) h = ((bn - rn) / d + 2) * 60;
		else h = ((rn - gn) / d + 4) * 60;
	}
	return { h, s: s * 100, l: l * 100 };
}

/**
 * Darkened accent foreground for the llm-only state.
 *
 * With the terminal background known (OSC 11), the accent is alpha-composited
 * over it — visually the same translucency as v1's 50% dither, as an opaque
 * color. Without it, falls back to halving saturation and lightness (same hue,
 * "veiled" rather than jewel-toned). Returns null when the accent isn't an RGB
 * truecolor ANSI code (default `\x1b[39m`, 256-color `38;5`, or a theme stub
 * without getFgAnsi) — the caller then falls back to the `dim` token.
 */
export function darkenAccentFg(theme: Theme, bgRgb?: RgbColor): string | null {
	const ansi = theme.getFgAnsi?.("accent");
	if (ansi === undefined) return null;
	const m = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
	if (!m) return null;
	const fg: RgbColor = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };

	if (bgRgb) {
		// Alpha composite in sRGB: result = bg·(1−α) + accent·α.
		const mix = (f: number, b: number) => Math.round(b * (1 - DARK_ALPHA) + f * DARK_ALPHA);
		return `\x1b[38;2;${mix(fg.r, bgRgb.r)};${mix(fg.g, bgRgb.g)};${mix(fg.b, bgRgb.b)}m`;
	}

	// Background unknown (query unanswered): same hue, halved saturation and
	// lightness — darkening at full saturation reads *more* saturated.
	const { h, s, l } = rgbToHsl(fg.r, fg.g, fg.b);
	return hslToAnsiFg(h, s * 0.5, Math.max(15, l * 0.5));
}

/**
 * Render a timeline row. Exactly `width` visible columns.
 * `darkFg` is the darkened-accent ANSI code (computed once by the caller);
 * when undefined it is computed internally, falling back to the dim token.
 */
export function renderTimelineRow(
	cells: TimelineCell[],
	theme: Theme,
	width: number,
	darkFg?: string,
): string {
	if (width < 1) return "";
	const dark = darkFg ?? darkenAccentFg(theme);
	const n = Math.min(cells.length, width);
	let out = "";
	for (let i = 0; i < n; i++) {
		const cell = cells[i]!;
		if (cell.isSessionStart) {
			out += theme.fg("warning", "\u2588");
		} else if (cell.left === "none" && cell.right === "none") {
			out += " ";
		} else if (cell.left === "none" || cell.right === "none") {
			// Exactly one half active: ▌ (left/earlier) or ▐ (right/later).
			const isLeft = cell.left !== "none";
			const state = isLeft ? cell.left : cell.right;
			const char = isLeft ? "\u258c" : "\u2590";
			if (state === "bright") {
				out += theme.fg("accent", char);
			} else {
				out += dark ? `${dark}${char}\x1b[39m` : theme.fg("dim", char);
			}
		} else {
			// Both halves active: █ in the winning state (bright wins).
			const state =
				cell.left === "bright" || cell.right === "bright" ? "bright" : "dark";
			if (state === "bright") {
				out += theme.fg("accent", "\u2588");
			} else {
				out += dark ? `${dark}\u2588\x1b[39m` : theme.fg("dim", "\u2588");
			}
		}
	}
	// Pad to width with spaces (defensive; cells.length should equal width).
	out += " ".repeat(width - n);
	return out;
}

/** Export for testing — pure function mapping quota data to footer segment string. */
export {
	getZaiMultiplier,
	renderQuotaSegment,
};

// ---------------------------------------------------------------------------
// Session block — greyed-out full UUID + staleness glyph + three-word name.
// Exported as pure helpers so the layout (full → words-only → truncated pwd)
// is unit-testable without a TUI.
// ---------------------------------------------------------------------------

export type SessionBlock = {
	/** Greyed-out full session id + glyph + words (the usual right-aligned block). */
	text: string;
	/** Visible width of `text`. */
	width: number;
	/** Glyph + words without the id — used when the width is too tight for it. */
	wordsText: string;
	/** Visible width of `wordsText`. */
	wordsWidth: number;
};

/**
 * Build the right-aligned session identifier: the raw session UUID greyed
 * out, then the staleness glyph, then the three-word friendly name. The words
 * only encode an 18-bit fingerprint of the UUID, so showing the raw id too is
 * the point — it's the only place in the footer it appears.
 */
export function buildSessionBlock(
	sessionId: string,
	staleness: Staleness,
	theme: Theme,
): SessionBlock {
	const words = encodeSessionId(sessionId);
	const colorStart = sessionColor(sessionId, staleness.lightness);
	const wordsText = colorStart
		? `${theme.fg("dim", staleness.glyph)} ${colorStart}${words}\x1b[39m`
		: `${theme.fg("dim", staleness.glyph)} ${words}`;
	const text = `${theme.fg("dim", sessionId)} ${wordsText}`;
	return {
		text,
		width: visibleWidth(text),
		wordsText,
		wordsWidth: visibleWidth(wordsText),
	};
}

/**
 * Lay out the footer's top line: pwd left-aligned, session block right-aligned
 * with a minimum 2-space gap. When the full block doesn't fit, drop the greyed
 * out id and keep the words; only if even that fails, truncate pwd with “…”.
 */
export function layoutPwdLine(
	pwd: string,
	block: SessionBlock,
	width: number,
	theme: Theme,
): string {
	const pwdDim = theme.fg("dim", pwd);
	const pwdVisible = visibleWidth(pwdDim);
	const minGap = 2;
	if (pwdVisible + minGap + block.width <= width) {
		return pwdDim + " ".repeat(width - pwdVisible - block.width) + block.text;
	}
	if (pwdVisible + minGap + block.wordsWidth <= width) {
		return pwdDim + " ".repeat(width - pwdVisible - block.wordsWidth) + block.wordsText;
	}
	return truncateToWidth(pwdDim, width, theme.fg("dim", "..."));
}

export default function (pi: ExtensionAPI) {
	// Re-render the footer whenever the thinking level changes. The footer
	// factory reads the level from session entries in render(), so it just
	// needs to be called again.
	pi.on("thinking_level_select", async () => {
		requestRenderRef?.();
	});

	// Re-render when the model changes AND reconcile quota state.
	// model name, provider, context window are read from ctx.model in
	// render(). The quota block needs special handling: on switch-AWAY
	// from zai we must clear stale data immediately (not wait for the
	// 60s tick), and on switch-TO zai we must fetch immediately (not
	// wait up to 60s for the next interval tick — that was the bug).
	pi.on("model_select", async (_event, ctx) => {
		requestRenderRef?.();
		const fc = ctx as FooterFactoryCtx;
		void refreshQuotaNow(fc, requestRenderRef);
	});

	function installFooter(ctx: unknown): void {
		const c = ctx as { ui: { setFooter: (factory: FooterFactory) => void } };
		c.ui.setFooter((tui, theme, footerData) => {
			requestRenderRef = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// Periodic refresh so the staleness indicator updates while the
			// session is idle (no user input or session events would otherwise
			// trigger a render). Re-reads autoCompact from settings.json each
			// tick too — toggles in `/settings` show up within 30s. pi's
			// requestRender throttles internally via renderTimer /
			// MIN_RENDER_INTERVAL_MS, so 30s is cheap.
			const refreshInterval = setInterval(() => {
				cachedAutoCompactEnabled = readAutoCompactEnabled();
				tui.requestRender();
			}, 30_000);

			// Terminal background for the darkened accent: one OSC 11 query per
			// install (the TUI resolves it from the terminal's reply). Until it
			// lands, darkenAccentFg uses its desaturation fallback; the re-render
			// below swaps in the composited color. Unknown bg → fallback stays.
			if (!bgQueryStarted) {
				bgQueryStarted = true;
				const bgQuery = tui.queryTerminalBackgroundColor?.({ timeoutMs: 2000 });
				if (bgQuery) {
					void bgQuery.then((bg) => {
						cachedBgRgb = bg;
						requestRenderRef?.();
					});
				}
			}

			// Quota polling: every 60s, run a quota cycle (refreshQuotaNow).
			// The helper itself decides whether to fetch or clear based on
			// the current provider, so this stays a one-liner.
			// Skip entirely in subagent sessions — they never see the footer
			// usefully, and the HTTP fetch adds latency to spawn.
			const fc = ctx as FooterFactoryCtx;
			let quotaInterval: ReturnType<typeof setInterval> | undefined;
			if (process.env.PI_IS_SUBAGENT !== "1") {
				quotaInterval = setInterval(() => {
					void refreshQuotaNow(fc, requestRenderRef);
				}, 60_000);

				// Kick off the first quota fetch immediately (don't wait 60s).
				// Fire-and-forget; cachedQuota stays undefined until it resolves,
				// at which point refreshQuotaNow requests a render.
				void refreshQuotaNow(fc, requestRenderRef);
			}

			return {
				dispose() {
					requestRenderRef = null;
					unsub();
					clearInterval(refreshInterval);
					if (quotaInterval) clearInterval(quotaInterval);
					// Reset module-level state so a future re-install starts fresh.
					cachedQuota = undefined;
					quotaWarnedOnce = false;
					zaiKeyResolved = false;
					resolvedZaiKey = undefined;
					minimaxWarnedOnce = false;
					cachedMinimaxKey = undefined;
					cachedGoUsage = undefined;
					goWarnedOnce = false;
					goKeyResolved = false;
					resolvedGoKey = undefined;
					cachedBgRgb = undefined;
					bgQueryStarted = false;
				},
				invalidate() {},
				render(width: number): string[] {
					const fc = ctx as FooterFactoryCtx;
					const sm = fc.sessionManager;

					// --- Token / cost aggregates from session entries. ---
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;
					const allEntries = sm.getEntries();
					for (const entry of allEntries) {
						const e = entry as { type: string; message?: { role: string } & AssistantMessage };
						if (e.type === "message" && e.message?.role === "assistant") {
							const m = e.message;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
							const promptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (m.usage.cacheRead / promptTokens) * 100 : undefined;
						}
					}

					// --- Context usage. ---
					const ctxUsage = fc.getContextUsage?.();
					const model = fc.model;
					const contextWindow = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = ctxUsage?.percent ?? 0;
					const contextPercent =
						ctxUsage?.percent !== null && ctxUsage?.percent !== undefined
							? contextPercentValue.toFixed(1)
							: "?";

					// --- pwd line. ---
					let pwd = formatCwdForFooter(sm.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = sm.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- stats parts. ---
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					const usingSubscription = model && fc.modelRegistry?.isUsingOAuth?.(model);
					if (totalCost || usingSubscription) {
						const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
						statsParts.push(costStr);
					}

					let contextPercentStr: string;
					const autoIndicator = cachedAutoCompactEnabled ? " (auto)" : "";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
					else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
					else contextPercentStr = contextPercentDisplay;
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// --- model name with optional provider + thinking level. ---
					// Reading thinkingLevel off the extension context always returns
					// undefined (the ExtensionContext type doesn't expose it), so we
					// walk the current branch and pick the most recent
					// thinking_level_change entry. Branch-only — entries on sibling
					// branches shouldn't influence the displayed state.
					const sessionBranch = sm.getBranch();
					const modelName = model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (model?.reasoning) {
						const tl = currentThinkingLevel(sessionBranch) || "off";
						rightSideWithoutProvider =
							tl === "off"
								? `${modelName} • thinking off`
								: `${modelName} • thinking ${tl}`;
					}
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					// --- session identifier with staleness indicator. ---
					// Greyed-out full session id + words, right-aligned on the pwd
					// line. The words encode only an 18-bit fingerprint of the UUID,
					// so the raw id is otherwise unrecoverable from the footer. The
					// glyph between them tracks time since the most recent entry on
					// the current branch (filled → 3/4 → half → 1/4 → dotted → empty
					// across 6 buckets), and the words fade along the same axis so
					// the signal is reinforced two ways.
					const sessionId = sm.getSessionId();
					const lastMs = lastActivityMs(sessionBranch);
					const staleness = stalenessFor(lastMs === 0 ? 0 : Date.now() - lastMs);
					const sessionSide = buildSessionBlock(sessionId, staleness, theme);

					// Layout: stats [...padding] model, right-aligned (unchanged).
					const minPadding = 2;
					const statsLine = (() => {
						const totalNeeded = statsLeftWidth + minPadding + visibleWidth(rightSide);
						if (totalNeeded <= width) {
							const padding = " ".repeat(width - statsLeftWidth - visibleWidth(rightSide));
							return statsLeft + padding + rightSide;
						}
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							return statsLeft + padding + truncatedRight;
						}
						return statsLeft;
					})();

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					// --- Top line: pwd (left) + session id/words (right). ---
					// Tight-width degradation: drop the greyed-out UUID before the
					// words — the id is secondary and recoverable from the words.
					const pwdLine = layoutPwdLine(pwd, sessionSide, width, theme);

					const lines: string[] = [pwdLine, dimStatsLeft + dimRemainder];

					// Row 3: statuses on the left, quota on the right (when both
					// exist). Keeps LHS and RHS items paired row-by-row:
					//   row 1: pwd                                    session-id
					//   row 2: stats                                  model
					//   row 3: [orchestrate] subagents: ...           5h:9% 1.3h ...
					// When only one exists, it uses the appropriate alignment alone.
					const quotaStr = renderQuotaSegment(
						cachedQuota,
						model?.provider,
						model?.id,
						Math.max(30, width),
						theme,
					) || renderGoUsageSegment(
						cachedGoUsage,
						model?.provider,
						Math.max(30, width),
						theme,
					);

					let statusesStr = "";
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						statusesStr = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
					}

					if (statusesStr && quotaStr) {
						const sWidth = visibleWidth(statusesStr);
						const qWidth = visibleWidth(quotaStr);
						const minGap = 2;
						if (sWidth + minGap + qWidth <= width) {
							const fill = " ".repeat(width - sWidth - qWidth);
							lines.push(statusesStr + fill + quotaStr);
						} else {
							// Width-tight: keep quota (primary), drop statuses if
							// there's not even room for a short fragment + ellipsis.
							const availForStatus = Math.max(0, width - qWidth - minGap);
							const truncatedStatus = availForStatus > 6
								? truncateToWidth(statusesStr, availForStatus, theme.fg("dim", "..."))
								: "";
							const tWidth = visibleWidth(truncatedStatus);
							const fill = " ".repeat(Math.max(0, width - tWidth - qWidth));
							lines.push(truncatedStatus + fill + quotaStr);
						}
					} else if (quotaStr) {
						const qWidth = visibleWidth(quotaStr);
						lines.push(
							qWidth <= width
								? " ".repeat(width - qWidth) + quotaStr
								: truncateToWidth(quotaStr, width, theme.fg("dim", "...")),
						);
					} else if (statusesStr) {
						lines.push(truncateToWidth(statusesStr, width, theme.fg("dim", "...")));
					}

					// Row 4: activity timeline (7-day logarithmic window).
					const startMs = resolveSessionStartMs(
						sm.getHeader()?.timestamp,
						allEntries,
					);
					const cells = computeTimelineCells(
						allEntries,
						Date.now(),
						width,
						startMs,
					);
					const darkFg = darkenAccentFg(theme, cachedBgRgb);
					lines.push(renderTimelineRow(cells, theme, width, darkFg));

					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		installFooter(ctx);
	});
}

type FooterFactory = (
	tui: {
		requestRender: () => void;
		queryTerminalBackgroundColor?: (opts: {
			timeoutMs: number;
		}) => Promise<RgbColor | undefined>;
	},
	theme: Theme,
	footerData: FooterData,
) => { render: (width: number) => string[]; invalidate: () => void; dispose?: () => void };
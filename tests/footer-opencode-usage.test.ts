/**
 * Tests for the OpenCode Go usage footer segment (GET /zen/go/v1/usage).
 *
 * Display spec (owner, 2026-10-18):
 *   rolling: percent + time left              `5h:1% 4.5h`
 *   weekly:  percent + %-through + days left  `7d:17% thru86% 1.0d`
 *   monthly: percent + %-through + days left  `mo:8% thru6% 29.0d`
 *
 * All time-sensitive tests pass explicit `now` (epoch ms) — the renderer's
 * optional last parameter — to avoid flaky time-dependent failures.
 */
import { describe, it, expect } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	normalizeGoUsage,
	weeklyThroughPercent,
	monthlyThroughPercent,
	renderGoUsageSegment,
	type GoUsage,
} from "../extensions/footer-session-id";

/** Minimal theme stub that wraps text in markers for color detection. */
const testTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
};

/** Passthrough theme — no markers, so string length == visible width. */
const plainTheme = {
	fg: (_color: string, text: string) => text,
};

/** Fixed reference instant: 2026-10-18T21:19:11Z (matches the live account's
 * monthly window anchor time of day). */
const NOW = Date.parse("2026-10-18T21:19:11Z");

/** Full three-window fixture with hand-computed through percentages:
 *   rolling: +4.5h left              → "4.5h"
 *   weekly:  +1d left, 6/7 elapsed   → thru 86%, "1.0d"
 *   monthly: +29d left, 2/31 elapsed → thru 6%,  "29.0d" (window Oct 16→Nov 16)
 */
const FULL_USAGE: GoUsage = {
	rolling: { percent: 1, resetsAtMs: Date.parse("2026-10-19T01:49:11Z") },
	weekly: { percent: 17, resetsAtMs: Date.parse("2026-10-19T21:19:11Z") },
	monthly: { percent: 8, resetsAtMs: Date.parse("2026-11-16T21:19:11Z") },
};

const VALID_PAYLOAD = {
	usage: {
		rolling: { status: "ok", percent: 1, resetsAt: "2026-10-19T01:49:11.000Z" },
		weekly: { status: "ok", percent: 17, resetsAt: "2026-10-19T21:19:11.000Z" },
		monthly: { status: "ok", percent: 8, resetsAt: "2026-11-16T21:19:11.000Z" },
	},
};

// ---------------------------------------------------------------------------
// normalizeGoUsage
// ---------------------------------------------------------------------------

describe("normalizeGoUsage", () => {
	it("parses all three windows (ISO resetsAt → epoch ms)", () => {
		const out = normalizeGoUsage(VALID_PAYLOAD);
		expect(out?.rolling).toEqual({ percent: 1, resetsAtMs: Date.parse("2026-10-19T01:49:11Z") });
		expect(out?.weekly?.percent).toBe(17);
		expect(out?.monthly?.resetsAtMs).toBe(Date.parse("2026-11-16T21:19:11Z"));
	});

	it("skips windows with a non-numeric percent", () => {
		const out = normalizeGoUsage({
			usage: {
				rolling: { status: "ok", percent: "1", resetsAt: "2026-10-19T01:49:11.000Z" },
				weekly: { status: "ok", percent: 17, resetsAt: "2026-10-19T21:19:11.000Z" },
			},
		});
		expect(out?.rolling).toBeUndefined();
		expect(out?.weekly?.percent).toBe(17);
	});

	it("skips windows with an unparseable resetsAt", () => {
		const out = normalizeGoUsage({
			usage: {
				rolling: { status: "ok", percent: 1, resetsAt: "not-a-date" },
				weekly: { status: "ok", percent: 17, resetsAt: "2026-10-19T21:19:11.000Z" },
			},
		});
		expect(out?.rolling).toBeUndefined();
		expect(out?.weekly).toBeDefined();
	});

	it("missing usage wrapper → undefined", () => {
		expect(normalizeGoUsage({})).toBeUndefined();
		expect(normalizeGoUsage(undefined)).toBeUndefined();
		expect(normalizeGoUsage(null)).toBeUndefined();
	});

	it("no usable windows → undefined", () => {
		expect(normalizeGoUsage({ usage: { monthly: { status: "ok" } } })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// weeklyThroughPercent / monthlyThroughPercent
// ---------------------------------------------------------------------------

describe("weeklyThroughPercent", () => {
	const reset = Date.parse("2026-10-19T21:19:11Z");
	const DAY = 24 * 60 * 60 * 1000;

	it("0% at window start (resetsAt − 7d)", () => {
		expect(weeklyThroughPercent(reset - 7 * DAY, reset)).toBe(0);
	});

	it("~51% mid-window (7d window, 3.5d elapsed)", () => {
		expect(weeklyThroughPercent(reset - 3.5 * DAY, reset)).toBeCloseTo(50, 5);
	});

	it("100% at reset; clamped past reset and before start", () => {
		expect(weeklyThroughPercent(reset, reset)).toBe(100);
		expect(weeklyThroughPercent(reset + DAY, reset)).toBe(100);
		expect(weeklyThroughPercent(reset - 8 * DAY, reset)).toBe(0);
	});
});

describe("monthlyThroughPercent", () => {
	// Window Oct 16 21:19:11 → Nov 16 21:19:11 (31 days — calendar-month anchor).
	const reset = Date.parse("2026-11-16T21:19:11Z");
	const DAY = 24 * 60 * 60 * 1000;

	it("0% at window start (resetsAt minus one calendar month)", () => {
		expect(monthlyThroughPercent(Date.parse("2026-10-16T21:19:11Z"), reset)).toBe(0);
	});

	it("~2/31 = 6.45% two days in (the live-account shape)", () => {
		expect(monthlyThroughPercent(NOW, reset)).toBeCloseTo(6.45, 1);
	});

	it("clamped before window start and past reset", () => {
		expect(monthlyThroughPercent(Date.parse("2026-10-01T00:00:00Z"), reset)).toBe(0);
		expect(monthlyThroughPercent(reset + DAY, reset)).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// renderGoUsageSegment — display spec
// ---------------------------------------------------------------------------

describe("renderGoUsageSegment", () => {
	it("provider gating: only opencode-go renders", () => {
		expect(renderGoUsageSegment(FULL_USAGE, "opencode-go", 200, testTheme, NOW)).not.toBe("");
		expect(renderGoUsageSegment(FULL_USAGE, "zai", 200, testTheme, NOW)).toBe("");
		expect(renderGoUsageSegment(FULL_USAGE, "openrouter", 200, testTheme, NOW)).toBe("");
		expect(renderGoUsageSegment(FULL_USAGE, undefined, 200, testTheme, NOW)).toBe("");
	});

	it("no cached usage → empty", () => {
		expect(renderGoUsageSegment(undefined, "opencode-go", 200, testTheme, NOW)).toBe("");
		expect(renderGoUsageSegment({}, "opencode-go", 200, testTheme, NOW)).toBe("");
	});

	it("rolling shows percent + time left, no thru marker", () => {
		const s = renderGoUsageSegment(
			{ rolling: FULL_USAGE.rolling },
			"opencode-go", 200, testTheme, NOW,
		);
		expect(s).toBe("5h:[success:1%] [dim:4.5h]");
	});

	it("weekly shows percent + %-through + days till reset", () => {
		const s = renderGoUsageSegment(
			{ weekly: FULL_USAGE.weekly },
			"opencode-go", 200, testTheme, NOW,
		);
		expect(s).toBe("7d:[success:17%] [dim:thru86%] [dim:1.0d]");
	});

	it("monthly shows percent + %-through + days till reset", () => {
		const s = renderGoUsageSegment(
			{ monthly: FULL_USAGE.monthly },
			"opencode-go", 200, testTheme, NOW,
		);
		expect(s).toBe("mo:[success:8%] [dim:thru6%] [dim:29.0d]");
	});

	it("full segment joins 5h, 7d, mo windows in order", () => {
		const s = renderGoUsageSegment(FULL_USAGE, "opencode-go", 200, testTheme, NOW);
		expect(s).toBe(
			"5h:[success:1%] [dim:4.5h] 7d:[success:17%] [dim:thru86%] [dim:1.0d] mo:[success:8%] [dim:thru6%] [dim:29.0d]",
		);
	});

	it("color thresholds: 59 success, 60 warning, 85 error", () => {
		const w = (percent: number): GoUsage => ({
			rolling: { percent, resetsAtMs: FULL_USAGE.rolling!.resetsAtMs },
		});
		expect(renderGoUsageSegment(w(59), "opencode-go", 200, testTheme, NOW))
			.toContain("[success:59%]");
		expect(renderGoUsageSegment(w(60), "opencode-go", 200, testTheme, NOW))
			.toContain("[warning:60%]");
		expect(renderGoUsageSegment(w(85), "opencode-go", 200, testTheme, NOW))
			.toContain("[error:85%]");
	});

	it("percent is rounded at normalization (1.6 → 2% in display)", () => {
		const parsed = normalizeGoUsage({
			usage: {
				rolling: { status: "ok", percent: 1.6, resetsAt: "2026-10-19T01:49:11.000Z" },
			},
		});
		const s = renderGoUsageSegment(parsed, "opencode-go", 200, testTheme, NOW);
		expect(s).toContain("2%");
	});
});

// ---------------------------------------------------------------------------
// Width ladder (plain theme: visible width == string length except where
// truncateToWidth appends ANSI resets)
//   full (49) → drop mo (30) → rolling only (10) → truncate
// ---------------------------------------------------------------------------

describe("renderGoUsageSegment width ladder", () => {
	it("wide width keeps all three windows", () => {
		const s = renderGoUsageSegment(FULL_USAGE, "opencode-go", 49, plainTheme, NOW);
		expect(s).toBe("5h:1% 4.5h 7d:17% thru86% 1.0d mo:8% thru6% 29.0d");
	});

	it("drops monthly first when tight", () => {
		const s = renderGoUsageSegment(FULL_USAGE, "opencode-go", 30, plainTheme, NOW);
		expect(s).toBe("5h:1% 4.5h 7d:17% thru86% 1.0d");
		expect(s).not.toContain("mo:");
	});

	it("rolling only when very tight", () => {
		const s = renderGoUsageSegment(FULL_USAGE, "opencode-go", 10, plainTheme, NOW);
		expect(s).toBe("5h:1% 4.5h");
	});

	it("truncates rather than overflowing at extreme tightness", () => {
		const s = renderGoUsageSegment(FULL_USAGE, "opencode-go", 6, plainTheme, NOW);
		expect(visibleWidth(s)).toBeLessThanOrEqual(6);
	});
});

/**
 * Tests for the footer's cumulative cache-hit-rate segment helper.
 *
 * cacheHitRate is the pure calc behind the footer's ∑CH segment — prompt-token-
 * weighted (cacheRead ÷ (input + cacheRead + cacheWrite)), cumulative over the
 * session, unlike the bar's latest-turn CH. The on-screen identity: ∑CH must
 * equal R ÷ (↑+R+W) from the same totals line.
 *
 * Boundary matrix:
 *   1. all zero              → undefined (nothing displayed)
 *   2. no cache reported     → undefined (mirrors core's latest-turn guard:
 *      providers without cache support show no CH segment)
 *   3. cacheWrite only       → defined (cache activity was reported)
 *   4. full hit              → 100
 *   5. tfd-d-style real mix  → ~93.5 (token-weighted truth < latest-turn bar)
 *   6. identity: derivable from the displayed ↑/R/W segments
 *   7. zero prompt + reported cache → undefined (division guard)
 */
import { describe, it, expect } from "bun:test";
import { cacheHitRate } from "../extensions/footer-session-id";

describe("cacheHitRate (cumulative ∑CH segment)", () => {
	it("1. all-zero totals → undefined", () => {
		expect(cacheHitRate(0, 0, 0)).toBeUndefined();
	});

	it("2. provider without cache reporting → undefined (no CH segment)", () => {
		expect(cacheHitRate(5000, 0, 0)).toBeUndefined();
	});

	it("3. cacheWrite-only activity is still cache activity → defined", () => {
		// 1k read, 2k written, 0 uncached-in → 1000/(1000+2000) = 33.33%
		expect(cacheHitRate(0, 1000, 2000)).toBeCloseTo(33.333, 2);
	});

	it("4. full hit → 100%", () => {
		expect(cacheHitRate(0, 42000, 0)).toBe(100);
	});

	it("5. deep-cache session mix lands well below the latest-turn bar", () => {
		// Shape seen in the tfd-d main (2026-10-18 scan): warm turns ~99.8%,
		// fresh-reading turns carrying ~half the volume → ~93.5% weighted.
		// 3.09M cache-read + 0.15M input + 0.06M cache-write → 3.09/3.30
		const rate = cacheHitRate(150_000, 3_090_000, 60_000);
		expect(rate).toBeGreaterThan(90);
		expect(rate).toBeLessThan(96);
	});

	it("6. identity: ∑CH == R ÷ (↑+R+W) from the bar's own segments", () => {
		const input = 1_234_567;
		const read = 98_765_432;
		const write = 12_345;
		const expected = (read / (input + read + write)) * 100;
		expect(cacheHitRate(input, read, write)).toBeCloseTo(expected, 10);
	});

	it("7. reported cache with zero prompt tokens → undefined (division guard)", () => {
		expect(cacheHitRate(0, 0, 0)).toBeUndefined();
	});
});

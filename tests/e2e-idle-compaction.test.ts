// LIVE-NETWORK: this file makes real billed LLM calls on every full `bun test` run.
// Provider/model: opencode-go/deepseek-v4.1-flash, authorized from the live
// ~/.pi/agent/auth.json. Two prompts plus one compaction summary (~50k prompt
// tokens); sessions run via `SessionManager.inMemory`, so no transcript is
// persisted. See docs/investigations/or-workspace-attribution-2026-10.md.

/**
 * End-to-end idle compaction: a real pi session, the real extension, a real
 * provider, and a cache TTL short enough to fire inside the test.
 *
 * The unit tests drive the handlers with a fake ctx and a `compact` spy, so
 * they cannot catch the failures this file exists for — a `ctx.compact()` that
 * pi refuses, an extension not bound to the TUI, an `agent_settled` that never
 * arrives. Two pi behaviours discovered here and worth keeping in mind:
 *
 *   - `ctx.compact()` works from a timer (no event handler required).
 *   - pi refuses to compact a small session: "Nothing to compact (session too
 *     small)" — `keepRecentTokens` is 20k, so the fixture must exceed it or the
 *     run proves nothing. An idle-compacting session is above 256k by
 *     definition, so this only constrains the fixture.
 *
 * Run: bun test tests/e2e-idle-compaction.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

const EXTENSION = join(import.meta.dir, "..", "extensions", "auto-checkpoint.ts");
const PROVIDER = "opencode-go";
const MODEL = "deepseek-v4.1-flash";

/** Any missing UI method is a no-op; the extension only needs `notify`. */
function stubUI(): any {
	return new Proxy({}, { get: () => () => undefined });
}

async function settle(session: AgentSession): Promise<void> {
	while (session.isStreaming) await new Promise((r) => setTimeout(r, 100));
}

describe("idle compaction (live session)", () => {
	let cwd: string;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-idle-e2e-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		// Fire 1.8 s after settle; any real context clears the threshold.
		await writeFile(
			join(cwd, ".pi", "auto-checkpoint.json"),
			JSON.stringify({ defaultThreshold: 1000, cacheTtlMs: 2000, cooldownMs: 0 }),
		);
		// pi keeps 20k recent tokens, so a smaller session has no cut point.
		const filler = Array.from(
			{ length: 2500 },
			(_, i) => `export const line_${i} = "filler payload ${i} abcdefghij";`,
		).join("\n");
		await writeFile(join(cwd, "big.ts"), filler + "\n");

		const settingsManager = SettingsManager.inMemory({});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(getAgentDir(), "auth.json"),
			modelsPath: join(getAgentDir(), "models.json"),
		});
		const model = modelRuntime.getModel(PROVIDER, MODEL);
		if (!model) throw new Error(`Model ${PROVIDER}/${MODEL} not found`);

		// A throwaway agent dir: no global extensions or settings leak in.
		const agentDir = await mkdtemp(join(tmpdir(), "pi-idle-e2e-agent-"));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [EXTENSION],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			settingsManager,
		});
		await loader.reload();

		sessionManager = SessionManager.inMemory(cwd);
		const created = await createAgentSession({
			cwd,
			model,
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader: loader,
			tools: ["read"],
			sessionManager,
			settingsManager,
		});
		session = created.session;
		// The extension compacts interactive sessions only; bind it as one.
		await session.bindExtensions({ uiContext: stubUI(), mode: "tui" });
	}, 120_000);

	afterAll(async () => {
		try { session?.dispose(); } catch {}
		try { await rm(cwd, { recursive: true, force: true }); } catch {}
	});

	it("compacts itself after the idle delay and leaves a marker", async () => {
		await session.prompt("Read big.ts in full (one read call, all lines). Reply with just OK.");
		await settle(session);
		await session.prompt("Reply with just the number of lines you read.");
		await settle(session);
		await session.prompt("Thanks — reply with the single word DONE.");
		await settle(session);

		let marker: any;
		let compaction: any;
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			const entries = sessionManager.getEntries() as any[];
			marker = entries.find((e) => e.type === "custom" && e.customType === "auto-checkpoint");
			compaction = entries.find((e) => e.type === "compaction");
			if (marker && compaction && !session.isCompacting) break;
			await new Promise((r) => setTimeout(r, 250));
		}

		expect(compaction).toBeTruthy();
		expect(marker).toBeTruthy();
		expect(marker.data.tokens).toBeGreaterThan(1000);
		expect(marker.data.percent).toBeGreaterThan(0);
		expect(typeof marker.data.idleMinutes).toBe("number");
	}, 240_000);
});

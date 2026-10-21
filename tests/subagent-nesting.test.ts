/**
 * Decision 028: orchestrator nesting is capped at one level.
 *
 * - `subagentDepth` / `nextSubagentDepth` own the depth arithmetic.
 * - `buildSubagentEnv` / `buildSubagentProcessEnv` stamp the child's depth
 *   and prove the stamp overrides an inherited parent value.
 * - `subagentNestingBlock` implements the cap, and the `subagent` tool
 *   boundary is exercised to prove the wiring refuses the spawn at
 *   depth >= 2. The boundary tests abort at the missing-`workOrderPath`
 *   gate, which runs after the nesting gate and before any spawn — so a
 *   mutation that deletes the nesting wiring fails the test instead of
 *   launching a real subagent.
 *
 * Run: bun test tests/subagent-nesting.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	MAX_ORCHESTRATOR_NESTING_DEPTH,
	buildSubagentEnv,
	buildSubagentProcessEnv,
	nextSubagentDepth,
	subagentDepth,
	subagentNestingBlock,
} from "../extensions/subagent-async/index.ts";
import { scrubSubagentEnv, unsetSubagentEnv } from "./helpers/subagent-env.ts";

const baseConfig = {
	sessionId: "subagent-x",
	allowlist: ["orchestrator", "implement"],
	worktreePath: null,
	parentCwdForCleanup: "",
};

describe("subagentDepth", () => {
	it("treats an unset depth as the root session (0)", () => {
		expect(subagentDepth({})).toBe(0);
	});

	it("parses the stamped depth", () => {
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "1" })).toBe(1);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "2" })).toBe(2);
	});

	it("treats unset, empty, and zero depth as the root session (0)", () => {
		expect(subagentDepth({})).toBe(0);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "" })).toBe(0);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "0" })).toBe(0);
	});

	it("fails closed on malformed or negative stamps (deny, never grant)", () => {
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "nope" })).toBe(MAX_ORCHESTRATOR_NESTING_DEPTH);
		expect(subagentDepth({ PI_SUBAGENT_DEPTH: "-3" })).toBe(MAX_ORCHESTRATOR_NESTING_DEPTH);
	});
});

describe("nextSubagentDepth (spawn-site arithmetic)", () => {
	it("adds one to the parent's depth", () => {
		expect(nextSubagentDepth({})).toBe(1);
		expect(nextSubagentDepth({ PI_SUBAGENT_DEPTH: "1" })).toBe(2);
		expect(nextSubagentDepth({ PI_SUBAGENT_DEPTH: "2" })).toBe(3);
	});
});

describe("buildSubagentEnv depth stamping", () => {
	it("stamps the child's depth", () => {
		expect(buildSubagentEnv({ ...baseConfig, depth: 1 }).PI_SUBAGENT_DEPTH).toBe("1");
		expect(buildSubagentEnv({ ...baseConfig, depth: 2 }).PI_SUBAGENT_DEPTH).toBe("2");
	});
});

describe("buildSubagentProcessEnv (the spawn site's env builder)", () => {
	it("computes the child depth from the parent env", () => {
		expect(buildSubagentProcessEnv(baseConfig, {}).PI_SUBAGENT_DEPTH).toBe("1");
		expect(buildSubagentProcessEnv(baseConfig, { PI_SUBAGENT_DEPTH: "1" }).PI_SUBAGENT_DEPTH).toBe("2");
	});

	it("overrides an inherited parent stamp and preserves the rest of the env", () => {
		const env = buildSubagentProcessEnv(baseConfig, { PI_SUBAGENT_DEPTH: "9", PATH: "/usr/bin" });
		expect(env.PI_SUBAGENT_DEPTH).toBe("10");
		expect(env.PATH).toBe("/usr/bin");
	});
});

describe("subagentNestingBlock (decision 028 cap)", () => {
	it("allows a root session to dispatch an orchestrator", () => {
		expect(subagentNestingBlock("orchestrator", 0)).toBeNull();
	});

	it("allows a depth-1 orchestrator to nest once", () => {
		expect(subagentNestingBlock("orchestrator", 1)).toBeNull();
	});

	it("refuses an orchestrator spawn at the cap", () => {
		for (const depth of [MAX_ORCHESTRATOR_NESTING_DEPTH, 3, 7]) {
			const msg = subagentNestingBlock("orchestrator", depth);
			expect(msg).toContain("capped at one level");
			expect(msg).toContain(`PI_SUBAGENT_DEPTH=${depth}`);
		}
	});

	it("does not cap non-orchestrator agents", () => {
		expect(subagentNestingBlock("implement", 5)).toBeNull();
		expect(subagentNestingBlock("review-code", 2)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tool boundary: the `subagent` tool itself must refuse the spawn.
//
// A penetration past the nesting gate lands on the missing-workOrderPath
// error (which runs after the nesting gate and before any spawn), so these
// tests fail cleanly on a deleted/rewired cap instead of launching a child.
// ---------------------------------------------------------------------------

describe("subagent tool boundary (nesting cap wiring)", () => {
	const tools: Record<string, any> = {};
	const pi = {
		on: () => {},
		registerTool: (t: any) => { tools[t.name] = t; },
		registerCommand: () => {},
	} as any;
	subagentFactory(pi);

	let fixtureRoot = "";
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	let restoreSubagentEnv: () => void = () => {};

	beforeAll(() => {
		// This block drives the tool with ambient env: a subagent session inherits
		// PI_SUBAGENT_ALLOWLIST/PI_SUBAGENT_DEPTH, and the allowlist gate fires
		// before the nesting gate, so an inherited allowlist would refuse the spawn
		// for the wrong reason (and make the suite red from inside a subagent).
		// Each row then declares the env it exercises; afterEach returns to this
		// scrubbed baseline, and afterAll restores the harness's own values.
		restoreSubagentEnv = scrubSubagentEnv();
		fixtureRoot = mkdtempSync(join(tmpdir(), "pi-nesting-fixture-"));
		mkdirSync(join(fixtureRoot, "agents"), { recursive: true });
		for (const name of ["orchestrator", "implement"]) {
			writeFileSync(
				join(fixtureRoot, "agents", `${name}.md`),
				`---\nname: ${name}\ndescription: test\n---\n\nTest prompt.\n`,
			);
		}
		process.env.PI_CODING_AGENT_DIR = fixtureRoot;
	});

	afterEach(() => {
		unsetSubagentEnv();
	});

	afterAll(() => {
		restoreSubagentEnv();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(fixtureRoot, { recursive: true, force: true });
	});

	const run = (agent: string) =>
		tools.subagent.execute(
			"call-1",
			{ agent, task: "noop", cwd: fixtureRoot, workOrderPath: "missing.md" },
			undefined,
			undefined,
			{} as any,
		);

	const textOf = async (agent: string) => (await run(agent)).content[0].text as string;

	it("refuses an orchestrator spawn at depth 2 (the cap is wired, not just theorized)", async () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		const text = await textOf("orchestrator");
		expect(text).toContain("capped at one level");
		expect(text).toContain("PI_SUBAGENT_DEPTH=2");
	});

	it("fails closed at the tool when the depth stamp is malformed", async () => {
		process.env.PI_SUBAGENT_DEPTH = "junk";
		const text = await textOf("orchestrator");
		expect(text).toContain("capped at one level");
		expect(text).toContain("PI_SUBAGENT_DEPTH=2");
	});

	it("fails closed at the tool on a negative stamp", async () => {
		process.env.PI_SUBAGENT_DEPTH = "-3";
		const text = await textOf("orchestrator");
		expect(text).toContain("capped at one level");
	});

	it("lets a depth-1 orchestrator past the cap gate", async () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		const text = await textOf("orchestrator");
		expect(text).not.toContain("capped at one level");
		expect(text).toContain("workOrderPath file not found"); // the post-cap gate
	});

	it("does not depth-cap a non-orchestrator agent", async () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		const text = await textOf("implement");
		expect(text).not.toContain("capped at one level");
		expect(text).toContain("workOrderPath file not found");
	});

	it("pins gate ordering: the allowlist refusal wins over the depth refusal", async () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		process.env.PI_SUBAGENT_ALLOWLIST = "implement";
		const text = await textOf("orchestrator");
		expect(text).toContain("not in this subagent's allowlist");
		expect(text).not.toContain("capped at one level");
	});
});

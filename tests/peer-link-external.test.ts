/**
 * External peers (peer-link/external.ts): registration semantics in the
 * mailbox layer, plus the CLI driven as Claude Code hooks would drive it
 * (real subprocesses against a temp $PI_PEER_MAILBOX).
 *
 * Run: bun test tests/peer-link-external.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTERNAL_TTL_MS,
	deliveryDecision,
	listPeers,
	newEnvelope,
	readIncoming,
	sendEnvelope,
	sweepStalePeers,
	writeHeartbeat,
} from "../extensions/peer-link/mailbox";
import { renderMail } from "../extensions/peer-link/external";

const CLI = join(import.meta.dir, "..", "extensions", "peer-link", "external.ts");
const SID = "0b1c2d3e-aaaa-bbbb-cccc-111122223333";
const SELF = `claude-${SID}`;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "peer-external-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function run(args: string[], stdin = ""): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		stdin: new TextEncoder().encode(stdin),
		env: { ...process.env, PI_PEER_MAILBOX: dir },
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const hookJson = (event: string) => JSON.stringify({ session_id: SID, cwd: "/w", hook_event_name: event });

describe("external peers in the mailbox layer", () => {
	it("are listed but never online, and outlive the pi sweep window", () => {
		const now = Date.now();
		writeHeartbeat(dir, { name: "ext", ts: now - 10 * 60_000, external: true });
		writeHeartbeat(dir, { name: "pi-old", ts: now - 10 * 60_000 });
		sweepStalePeers(dir, now);
		const peers = listPeers(dir, now);
		expect(peers.map((p) => p.name)).toEqual(["ext"]);
		expect(peers[0].online).toBe(false);
		sweepStalePeers(dir, now + EXTERNAL_TTL_MS);
		expect(listPeers(dir)).toEqual([]);
	});

	it("accept queued delivery, but fail requireOnline", () => {
		const listed = [{ name: "ext", online: false, external: true }];
		expect(deliveryDecision("ext", listed, false)).toEqual({ ok: true, online: false, external: true });
		const r = deliveryDecision("ext", listed, true);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("external");
	});

	it("renders mail oldest first, with a reply prompt when asked", () => {
		const a = { ...newEnvelope("bob", SELF, "second", true), sentAt: 2 };
		const b = { ...newEnvelope("bob", SELF, "first"), sentAt: 1 };
		const text = renderMail(SELF, [a, b]);
		expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
		expect(text).toContain(`send --from ${SELF} bob`);
	});
});

describe("external.ts CLI (as Claude Code hooks run it)", () => {
	it("registers, receives a pi send, delivers on prompt, acks at Stop, and unregisters", () => {
		const start = run(["hook", "session-start"], hookJson("SessionStart"));
		expect(start.code).toBe(0);
		expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain(SELF);
		const me = listPeers(dir).find((p) => p.name === SELF);
		expect(me?.external).toBe(true);

		// A pi peer's send passes the delivery gate because the external is listed.
		const d = deliveryDecision(SELF, listPeers(dir), false);
		expect(d.ok).toBe(true);
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "issue #42 filed"));

		const prompt = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(prompt.code).toBe(0);
		const ctx = JSON.parse(prompt.out).hookSpecificOutput;
		expect(ctx.hookEventName).toBe("UserPromptSubmit");
		expect(ctx.additionalContext).toContain("[peer:bug-triage] issue #42 filed");
		expect(readIncoming(dir, SELF)).toHaveLength(1); // inflight, NOT acked yet

		expect(run(["hook", "stop"], hookJson("Stop")).code).toBe(0);
		expect(readIncoming(dir, SELF)).toEqual([]); // turn completed → acked

		const again = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(again.code).toBe(0);
		expect(again.out).toBe(""); // nothing pending → no context

		expect(run(["hook", "session-end"], hookJson("SessionEnd")).code).toBe(0);
		expect(listPeers(dir).some((p) => p.name === SELF)).toBe(false);
	}, 20_000);

	it("an aborted prompt loses nothing: un-acked mail is re-emitted on the next prompt", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "mail that must survive Escape"));

		const first = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(first.out).toContain("mail that must survive Escape");
		// Escape: the turn is aborted, no Stop hook fires.
		const second = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(second.out).toContain("mail that must survive Escape"); // re-emitted
		expect(readIncoming(dir, SELF)).toHaveLength(1); // still exactly one envelope (dedup)

		run(["hook", "stop"], hookJson("Stop"));
		expect(readIncoming(dir, SELF)).toEqual([]);
		expect(run(["hook", "prompt"], hookJson("UserPromptSubmit")).out).toBe("");
	}, 20_000);

	it("Stop acks only what the completed turn carried; mid-turn arrivals wait", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "seen by the turn"));
		const prompt = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(prompt.out).toContain("seen by the turn");
		sendEnvelope(dir, newEnvelope("bug-triage", SELF, "arrived mid-turn"));

		run(["hook", "stop"], hookJson("Stop"));
		const left = readIncoming(dir, SELF);
		expect(left).toHaveLength(1);
		expect(left[0].text).toBe("arrived mid-turn");

		const next = run(["hook", "prompt"], hookJson("UserPromptSubmit"));
		expect(next.out).toContain("arrived mid-turn");
		expect(next.out).not.toContain("seen by the turn");
	}, 20_000);

	it("Stop with nothing inflight is a clean no-op", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		const r = run(["hook", "stop"], hookJson("Stop"));
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
		expect(readIncoming(dir, SELF)).toEqual([]);
	}, 20_000);

	it("sends to a listed pi peer, from stdin, with --reply", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() });
		const r = run(["send", "--from", SELF, "--reply", "bug-triage", "-"], "repro: x\nwhere: y\n");
		expect(r.code).toBe(0);
		expect(r.out).toContain("online");
		const [env] = readIncoming(dir, "bug-triage");
		expect(env).toMatchObject({ from: SELF, to: "bug-triage", text: "repro: x\nwhere: y", expectReply: true });
		expect(typeof env.sentAt).toBe("number");
	}, 20_000);

	it("fails loud: unlisted target, unregistered sender, requireOnline to an offline peer", () => {
		run(["hook", "session-start"], hookJson("SessionStart"));
		const unlisted = run(["send", "--from", SELF, "nobody", "hi"]);
		expect(unlisted.code).toBe(1);
		expect(unlisted.err).toContain("not listed");
		expect(existsSync(join(dir, "nobody"))).toBe(false);

		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() });
		expect(run(["send", "--from", "claude-forged", "bug-triage", "hi"]).err).toContain(
			"not a registered external peer",
		);

		writeHeartbeat(dir, { name: "bug-triage", ts: Date.now() - 5 * 60_000 });
		const offline = run(["send", "--from", SELF, "--require-online", "bug-triage", "hi"]);
		expect(offline.code).toBe(1);
		expect(readIncoming(dir, "bug-triage")).toEqual([]);
	}, 20_000);
});

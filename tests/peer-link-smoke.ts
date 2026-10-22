// Two-process smoke test: alice and bob as independent pi RPC processes
// exchange a message end-to-end (peer_send tool -> mailbox -> injection ->
// agent reply -> auto-reply back). Mirrors two user-launched TUI sessions.
//
// Manual validation script — not part of the bun test suite (spawns real pi
// processes and makes live LLM calls).
//
// Run: bun run tests/peer-link-smoke.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";
import { FLEET_MODEL, FLEET_PROVIDER } from "../extensions/lib/fleet-model.ts";

// The two peers stand in for user-launched TUI sessions, which never carry the
// harness's PI_SUBAGENT_* — drop them here and hand the live env to each spawn
// (tests/helpers/subagent-env.ts) so the script behaves the same from any shell.
scrubSubagentEnv();

const MAILBOX = await mkdtemp(join(tmpdir(), "peer-smoke-mail-"));
const WORKDIR = await mkdtemp(join(tmpdir(), "peer-smoke-work-"));
const MODEL = process.env.PI_SMOKE_MODEL ?? `${FLEET_PROVIDER}/${FLEET_MODEL}`;

interface Child {
	proc: ReturnType<typeof spawn>;
	lines: string[];
	onEvent: (e: Record<string, any>) => void;
}

function spawnPeer(name: string): Child {
	const proc = spawn("pi", ["--mode", "rpc", "--model", MODEL], {
		cwd: WORKDIR,
		env: childEnv({ PI_PEER_NAME: name, PI_PEER_MAILBOX: MAILBOX }),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const child: Child = { proc, lines: [], onEvent: () => {} };
	const rl = createInterface({ input: proc.stdout });
	rl.on("line", (line) => {
		child.lines.push(line);
		try {
			child.onEvent(JSON.parse(line));
		} catch {}
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[${name}:err] ${d}`));
	return child;
}

function send(child: Child, message: string) {
	child.proc.stdin.write(JSON.stringify({ id: "req-1", type: "prompt", message }) + "\n");
}

function getState(child: Child) {
	child.proc.stdin.write(JSON.stringify({ id: "get-state-1", type: "get_state" }) + "\n");
}

function waitFor(child: Child, pred: (e: Record<string, any>) => boolean, what: string, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			for (const line of child.lines) {
				try {
					const e = JSON.parse(line);
					if (pred(e)) return resolve();
				} catch {}
			}
			if (Date.now() > deadline) {
				reject(new Error(`[${what}] timed out after ${timeoutMs}ms\nlast lines:\n${child.lines.slice(-15).join("\n")}`));
			} else {
				setTimeout(check, 250);
			}
		};
		check();
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("spawning alice and bob (", MODEL, ")...");
const alice = spawnPeer("alice");
const bob = spawnPeer("bob");
// session_start is not streamed in RPC mode; get_state response is the readiness signal.
getState(alice);
getState(bob);
await Promise.all([
	waitFor(alice, (e) => e.type === "response" && e.command === "get_state" && e.success, "alice ready", 90_000),
	waitFor(bob, (e) => e.type === "response" && e.command === "get_state" && e.success, "bob ready", 90_000),
]);
console.log("both sessions started.");

send(
	alice,
	"Use the peer_send tool to send the message 'hello from alice' to the peer named 'bob' with expectReply true. " +
		"Then report what bob replies. Do not use any tools other than peer_list and peer_send.",
);

// bob should receive the message as an injected user message
await waitFor(
	bob,
	(e) => e.type === "message_start" && e.message?.role === "user" && String(e.message?.content?.[0]?.text ?? "").includes("[peer:alice]"),
	"bob received injected message",
	120_000,
);
console.log("bob received: [peer:alice] hello from alice");

// alice should receive bob's auto-reply as an injected user message
await waitFor(
	alice,
	(e) => e.type === "message_start" && e.message?.role === "user" && String(e.message?.content?.[0]?.text ?? "").includes("[peer:bob]"),
	"alice received auto-reply from bob",
	180_000,
);
console.log("alice received: [peer:bob] ...");

// give alice a moment to finish processing, then collect her final assistant text
const aliceUserTexts = alice.lines
	.map((l) => { try { return JSON.parse(l); } catch { return null; } })
	.filter((e) => e && e.type === "message_end" && e.message?.role === "assistant")
	.map((e) => JSON.stringify(e.message?.content ?? "").slice(0, 200));
console.log("alice assistant messages:", aliceUserTexts.length);

alice.proc.kill("SIGTERM");
bob.proc.kill("SIGTERM");
await sleep(1500);
await rm(MAILBOX, { recursive: true, force: true });
await rm(WORKDIR, { recursive: true, force: true });
console.log("smoke test done ✓");
process.exit(0);

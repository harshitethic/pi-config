#!/usr/bin/env bun
/**
 * Owner-asks for Claude Code (not a pi extension — pi loads only owner-asks/index.ts).
 *
 *   external.ts statusline           Claude Code statusline: its JSON on stdin, one line out
 *   external.ts list [--cwd DIR]     open asks, new first
 *   external.ts ack [--cwd DIR]      mark the open asks seen
 *
 * DIR defaults to the process cwd. Non-registry repos print no asks in the statusline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ack, countText, gitOut, list, ownerAsks } from "./lib.ts";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface StatuslineInput {
	workspace?: { current_dir?: string };
	cwd?: string;
}

function readStdin(): StatuslineInput {
	try {
		return JSON.parse(fs.readFileSync(0, "utf8")) as StatuslineInput;
	} catch {
		return {};
	}
}

async function statusline(): Promise<void> {
	const input = readStdin();
	const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
	const [branch, asks] = await Promise.all([
		gitOut(cwd, ["branch", "--show-current"]),
		ownerAsks(cwd).catch(() => "error" as const),
	]);
	const parts = [path.basename(cwd)];
	if (branch) parts.push(branch);
	if (asks === "error") parts.push("owner asks: error");
	else if (asks) {
		const text = countText(asks.asks);
		parts.push(asks.asks.some((a) => a.isNew) ? `${YELLOW}${text}${RESET}` : text);
	}
	process.stdout.write(`${parts.join(" · ")}\n`);
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "statusline") return statusline();
	if (cmd !== "list" && cmd !== "ack") {
		throw new Error("usage: external.ts <statusline | list [--cwd DIR] | ack [--cwd DIR]>");
	}
	const cwd = flag(args, "--cwd") ?? process.cwd();
	if (cmd === "list") {
		const lines = await list(cwd);
		if (!lines) throw new Error(`not a registry repo: ${cwd}`);
		console.log(lines.length ? lines.join("\n") : "no open asks");
		return;
	}
	const state = await ack(cwd);
	if (!state) throw new Error(`not a registry repo: ${cwd}`);
	console.log(`acked ${state.asks.length} open asks`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`owner-asks: ${(err as Error).message}`);
		process.exit(1);
	});
}

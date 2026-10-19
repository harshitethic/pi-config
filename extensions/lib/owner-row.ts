/**
 * The registry row-id shape every owner-state check shares.
 *
 * tfd process-controls R4/R6 (owner, 2026-10-19) ruled that owner state travels
 * only as a registry row id, in the one form `extensions/owner-asks/lib.ts`
 * already keys on: `<file>#<id>` (e.g. `emitir-transport.md#E2`). One shape,
 * one validator — the completion-report `owner_asks` gate (R4, subagent-async)
 * and the `checkpoint` `nextSteps` bar (R6) both call in here.
 *
 * The R6 half also reads the repo registry read-only to check a cited row
 * exists; a repo without `scripts/reviews_status.py` falls back to form-only
 * validation (decisions/subagents/039).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FILE_PART = String.raw`[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+`;
const ID_PART = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?`;

/** `<file>#<id>` — a registry file path, `#`, a row id. */
export const ROW_ID_RE = new RegExp(`^${FILE_PART}#${ID_PART}$`);

/** The canonical spelling examples use in errors. */
export const ROW_ID_EXAMPLE = "emitir-transport.md#E2";

/** True when `value` is exactly one registry row id. */
export function isRowId(value: string): boolean {
	return ROW_ID_RE.test(value);
}

/** The `owner_asks` field of a completion report, as declared. Accepts the
 *  bold spellings both report schemas use (`**owner_asks:** …`, and the closing
 *  `**` on the value side). */
const OWNER_ASKS_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\*{0,2}owner_asks\*{0,2}[ \t]*:\**[ \t]*(.*)$/gim;

/**
 * Validate the `owner_asks` field of a completion report (R4).
 *
 * The field is mandatory wherever an ask is born: `none`, or one or more
 * registry row ids. Missing, empty, `none` mixed with ids, or any free-text
 * token is a refusal — the caller steers the reporter to reissue the report
 * with the ask registered as a row first. Form-only: existence is R6's half
 * (a report may be written before the registry is reachable).
 */
export function validateOwnerAsks(text: string): { ok: true } | { ok: false; error: string } {
	const values: string[] = [];
	for (const m of text.matchAll(OWNER_ASKS_LINE_RE)) values.push(m[1]);
	if (values.length === 0) {
		return {
			ok: false,
			error:
				`\`owner_asks\` line missing. Completion reports must carry \`owner_asks:\` — ` +
				`\`none\` when the report raises no owner ask, or the registry row ids it does raise ` +
				`(\`<file>#<id>\`, e.g. \`${ROW_ID_EXAMPLE}\`). Add the line and reissue the report.`,
		};
	}

	const tokens = values
		.flatMap((v) => v.replace(/[`"]/g, " ").split(/[,\s]+/))
		.map(stripDecoration)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return {
			ok: false,
			error:
				`\`owner_asks\` is empty. Use \`none\` when the report raises no owner ask, ` +
				`or the registry row ids (\`<file>#<id>\`, e.g. \`${ROW_ID_EXAMPLE}\`) of the asks it raises.`,
		};
	}

	const noneTokens = tokens.filter((t) => t.toLowerCase() === "none");
	const idTokens = tokens.filter((t) => t.toLowerCase() !== "none");

	if (noneTokens.length > 0 && idTokens.length > 0) {
		return {
			ok: false,
			error:
				`\`owner_asks\` mixes \`none\` with row ids (${idTokens.join(", ")}). ` +
				`Use \`none\` alone, or the row ids alone.`,
		};
	}
	if (noneTokens.length > 0) return { ok: true };

	const bad = idTokens.find((t) => !isRowId(t));
	if (bad !== undefined) {
		const raw = values.map((v) => v.trim()).filter((v) => v.length > 0).join(" | ");
		return {
			ok: false,
			error:
				`\`owner_asks\` holds free text (\`${raw}\`). Owner asks travel as registry row ids ` +
				`(\`<file>#<id>\`, e.g. \`${ROW_ID_EXAMPLE}\`): register the ask as a row first, then ` +
				`reissue the report with its id — or \`none\`.`,
		};
	}
	return { ok: true };
}

// ── R6: owner-state prose in checkpoint nextSteps ──────────────────────────

/**
 * Phrases that assert owner state — a ruling, answer, decision or approval
 * attributed to the owner. Mirrors tfd process-controls R5's widened phrase
 * list (the same vocabulary the live asks use) plus the phrasing the R6
 * incident produced. Asking is not asserting: "ask the owner", "the owner owns
 * this question" and "report as an owner question" do not match.
 */
const OWNER_STATE_RE = new RegExp(
	[
		// Possessive state: "the owner's answers/ruling/decision/call…"
		String.raw`owner['’]s?\s+(?:answer|answers|ruling|rulings|decision|decisions|call|verdict|veto|approval|approvals|confirmation|sign-?off|go-?ahead|blessing|direction|instruction|instructions|guidance|word|position|state)\b`,
		// Verb attribution: "the owner ruled / answered / decided / approved…"
		String.raw`owner\s+(?:has\s+|had\s+|already\s+|then\s+)?(?:ruled|answered|decided|approved|approved of|confirmed|vetoed|said|says|chose|chooses|instructed|directed|signed off|weighed in|gave the go-?ahead|gave the green light)\b`,
		// Hyphenated/agentive forms: "owner-ruled", "owner-approved"
		String.raw`owner-(?:ruled|approved|confirmed|decided|directed)\b`,
		// Owed-state shapes: "needs a ruling", "awaiting ruling", "pending owner", "flag for veto"
		String.raw`needs?\s+(?:an?\s+)?owner\s+(?:ruling|decision|answer|call|sign-?off)`,
		String.raw`awaiting\s+(?:the\s+)?(?:owner['’]s?\s+)?(?:ruling|decision|answer|call)`,
		String.raw`pending\s+(?:the\s+)?owner['’]s?\b`,
		String.raw`flagged\s+for\s+(?:a\s+)?(?:veto|owner\s+decision)`,
		String.raw`\[decide\]`,
	].join("|"),
	"i",
);

/**
 * Split `nextSteps` into paragraph units. Blank lines separate paragraphs; a
 * markdown list item or heading starts a new one, so a row id in the next
 * bullet does not license a claim in this one (R6 requires the row id in the
 * *same* paragraph).
 */
export function ownerStateParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.flatMap((block) => block.split(/\n(?=\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s))/))
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

/** Strip the markdown/sentence decoration a caller may wrap around a token:
 *  emphasis and backticks, quotes, brackets, trailing punctuation. Applied
 *  before the form check, never in place of it — no legitimate row id starts or
 *  ends with any of these, so this only prevents a refusal of a correctly
 *  written id. */
function stripDecoration(token: string): string {
	return token.replace(/^[`*_"'(\[\]]+/, "").replace(/[`*_"'()\[\].,;:]+$/, "");
}

/** A row id must be at least one whole whitespace-delimited token. */
function rowIdsIn(paragraph: string): string[] {
	return paragraph
		.split(/\s+/)
		.map(stripDecoration)
		.filter(isRowId);
}

/** Tokens in the paragraph that look like a row id but lack the `#`. */
function malformedRowIdTokens(paragraph: string): string[] {
	const tokens = paragraph.split(/[\s,;()]+/).map(stripDecoration);
	return tokens.filter((t) => {
		if (t.includes("#") || t.length === 0) return false;
		if (/^WO-\d/i.test(t)) return false; // a work-order id is not a row id
		return /^[A-Z]\d{1,3}[a-z]?$/.test(t) || (/\.[A-Za-z0-9]+$/.test(t) && /^[\w./-]+$/.test(t));
	});
}

/**
 * R6, form half: every paragraph that asserts owner state must carry a
 * registry row id in that same paragraph. Returns the first offending
 * paragraph as an error; `rowIds` is the union of ids found (for the caller's
 * existence check).
 */
export function validateOwnerStateProse(
	text: string,
): { ok: true; rowIds: string[] } | { ok: false; error: string } {
	const claims = ownerStateParagraphs(text).filter((p) => OWNER_STATE_RE.test(p));
	if (claims.length === 0) return { ok: true, rowIds: [] };

	const rowIds: string[] = [];
	for (const p of claims) {
		const ids = rowIdsIn(p);
		if (ids.length === 0) {
			const malformed = malformedRowIdTokens(p);
			const quoted = `"${p.length > 300 ? `${p.slice(0, 300)}…` : p}"`;
			if (malformed.length > 0) {
				return {
					ok: false,
					error:
						`\`nextSteps\` asserts owner state and names what looks like a row id — ` +
						`\`${malformed.join("`, `")}\` — without the \`#\`. Row ids are ` +
						`\`<file>#<id>\` (e.g. \`${ROW_ID_EXAMPLE}\`). Fix the id or drop the claim. ` +
						`Offending paragraph: ${quoted}`,
				};
			}
			return {
				ok: false,
				error:
					`\`nextSteps\` asserts owner state (a ruling, answer, decision or approval ` +
					`attributed to the owner). Per tfd process-controls R6 (owner, 2026-10-19), ` +
					`owner state is stated only by registry row id: add the row id in \`<file>#<id>\` ` +
					`form (e.g. \`${ROW_ID_EXAMPLE}\`) to the same paragraph, or remove the claim. ` +
					`Offending paragraph: ${quoted}`,
			};
		}
		rowIds.push(...ids);
	}
	return { ok: true, rowIds };
}

// ── Registry existence (read-only) ─────────────────────────────────────────

export interface RegistryRow {
	file: string;
	id: string;
}

/**
 * Parse `scripts/reviews_status.py --all --plain`: a file path on its own line,
 * then one indented record per row whose first token is the row id.
 * @for-testing-only — pure
 */
export function parseRegistryRows(output: string): RegistryRow[] {
	const rows: RegistryRow[] = [];
	let file: string | null = null;
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		if (!/^\s/.test(line)) {
			file = line.trim();
			continue;
		}
		if (!file) continue;
		const m = /^\s+(\S+)\b/.exec(line);
		if (!m || m[1] === "(no") continue;
		rows.push({ file, id: m[1] });
	}
	return rows;
}

/** True when `(file, id)` names a row: exact path, basename, or path suffix. */
export function registryRowMatches(rows: RegistryRow[], rowId: string): boolean {
	const hash = rowId.lastIndexOf("#");
	if (hash < 0) return false;
	const file = rowId.slice(0, hash);
	const id = rowId.slice(hash + 1);
	const base = file.split("/").pop() ?? file;
	return rows.some(
		(r) =>
			r.id === id && (r.file === file || r.file.endsWith(`/${file}`) || (r.file.split("/").pop() ?? r.file) === base),
	);
}

const REGISTRY_SCRIPT = "scripts/reviews_status.py";

/** The git toplevel for `cwd`, or null when `cwd` is not in a repo. */
function repoRoot(cwd: string): string | null {
	try {
		const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 });
		if (out.status !== 0 || typeof out.stdout !== "string") return null;
		const root = out.stdout.trim();
		return root.length > 0 ? root : null;
	} catch {
		return null;
	}
}

/**
 * R6, existence half: `nextSteps` owner-state paragraphs must cite a row the
 * repo's registry actually carries. Degrades to form-only when `cwd` has no
 * `scripts/reviews_status.py` (a repo outside the registry convention) or the
 * script fails to run — the bar's shape still holds, only the lookup is lost.
 * @for-testing-only — pure over an injected script path when `opts.root` is set
 */
export function validateNextStepsOwnerState(
	nextSteps: string,
	cwd: string,
): { ok: true } | { ok: false; error: string } {
	const form = validateOwnerStateProse(nextSteps);
	if (!form.ok) return form;
	if (form.rowIds.length === 0) return { ok: true };

	const root = repoRoot(cwd);
	if (!root) return { ok: true };
	const script = join(root, REGISTRY_SCRIPT);
	if (!existsSync(script)) return { ok: true };

	let rows: RegistryRow[];
	try {
		const out = spawnSync("python3", [script, "--all", "--plain"], {
			cwd: root,
			encoding: "utf8",
			timeout: 20_000,
		});
		if (out.status !== 0 || typeof out.stdout !== "string") return { ok: true };
		rows = parseRegistryRows(out.stdout);
	} catch {
		return { ok: true };
	}

	const missing = form.rowIds.filter((id) => !registryRowMatches(rows, id));
	if (missing.length > 0) {
		return {
			ok: false,
			error:
				`\`nextSteps\` cites a registry row that does not exist in ${REGISTRY_SCRIPT}: ` +
				`${missing.map((m) => `\`${m}\``).join(", ")}. Check the file/id spelling, register the ` +
				`ask as a row first, or remove the owner-state claim from \`nextSteps\`.`,
		};
	}
	return { ok: true };
}

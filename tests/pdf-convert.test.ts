/**
 * Tests for PDF detection, conversion engine fallback, and response builders.
 *
 * Covers:
 *   1. isPdfContentType — case-insensitive, false negatives
 *   2. isPdfBody — prefix sniff (handles the text/html+PDF-body incident case)
 *   3. isPdfBytes — latin1 sniff
 *   4. Converter engine selection with stub ExecFn (pymupdf4llm → pdftotext →
 *      error; empty-output → "no extractable text")
 *   5. Real end-to-end conversion on the fixture PDF (guarded by availability)
 *   6. buildFetchPdfResponse — inline/save/error branches
 *   7. buildReadPdfResponse — inline/save/error branches
 *   8. Never-binary invariant — no response text contains %PDF or U+FFFD
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
	isPdfContentType,
	isPdfBody,
	isPdfBytes,
	createPdfConverter,
	buildFetchPdfResponse,
	buildReadPdfResponse,
	PDF_INLINE_MAX_CHARS,
	type ExecFn,
	type PdfConversion,
} from "../extensions/lib/pdf-convert"
import { writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a stub ExecFn that returns pre-scripted responses for given commands. */
function stubExec(
	responses: Record<
		string,
		{ stdout?: string; stderr?: string; code?: number }
	>,
): ExecFn {
	return async (cmd: string, args: string[]) => {
		const key = `${cmd} ${args.join(" ")}`
		// Try exact match first, then prefix match
		for (const [pattern, resp] of Object.entries(responses)) {
			if (key === pattern || key.startsWith(pattern)) {
				return {
					stdout: resp.stdout ?? "",
					stderr: resp.stderr ?? "",
					code: resp.code ?? 0,
				}
			}
		}
		return { stdout: "", stderr: `stub: no response for "${key}"`, code: 1 }
	}
}

// ── Fixture PDF ──────────────────────────────────────────────────────────

/**
 * Minimal one-page PDF ("Hello PDF World"), 590 bytes base64.
 * Generated with a simple PDF structure: one page, Helvetica, "Hello PDF World".
 */
const FIXTURE_PDF_BASE64 =
	"JVBERi0xLjQKMSAwIG9iaiA8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4gZW5kb2JqCjIgMCBvYmogPDwg" +
	"L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4gZW5kb2JqCjMgMCBvYmogPDwgL1R5cGUgL1Bh" +
	"Z2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNl" +
	"cyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4gZW5kb2JqCjQgMCBvYmogPDwgL0xlbmd0aCA0NCA+PiBz" +
	"dHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoSGVsbG8gUERGIFdvcmxkKSBUaiBFVAplbmRzdHJlYW0gZW5k" +
	"b2JqCjUgMCBvYmogPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+" +
	"IGVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1" +
	"OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyODkgMDAwMDAgbiAKMDAwMDAwMDQwMiAwMDAw" +
	"MCBuIAp0cmFpbGVyIDw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQ4MAolJUVPRgo="

let fixtureDir = ""

beforeAll(async () => {
	fixtureDir = join(tmpdir(), "pi-pdf-test-" + Date.now())
	await mkdir(fixtureDir, { recursive: true })
	await writeFile(
		join(fixtureDir, "hello.pdf"),
		Buffer.from(FIXTURE_PDF_BASE64, "base64"),
	)
})

afterAll(async () => {
	if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

// ── 1. isPdfContentType ──────────────────────────────────────────────────

describe("isPdfContentType", () => {
	it('"application/pdf" → true', () => {
		expect(isPdfContentType("application/pdf")).toBe(true)
	})

	it('"application/PDF" → true (case-insensitive)', () => {
		expect(isPdfContentType("application/PDF")).toBe(true)
	})

	it('"text/html" → false', () => {
		expect(isPdfContentType("text/html")).toBe(false)
	})

	it('"application/json" → false', () => {
		expect(isPdfContentType("application/json")).toBe(false)
	})

	it('"" → false', () => {
		expect(isPdfContentType("")).toBe(false)
	})
})

// ── 2. isPdfBody ─────────────────────────────────────────────────────────

describe("isPdfBody", () => {
	it('"%PDF-1.7\\n..." → true', () => {
		expect(isPdfBody("%PDF-1.7\n%some junk\nmore")).toBe(true)
	})

	it('"  %PDF-" → true (leading whitespace)', () => {
		expect(isPdfBody("  %PDF-")).toBe(true)
	})

	it('"<html>%PDF-..." → false (no leading, html prefix)', () => {
		expect(isPdfBody("<html>%PDF-1.4...")).toBe(false)
	})

	it('"" → false', () => {
		expect(isPdfBody("")).toBe(false)
	})

	it('"not a pdf" → false', () => {
		expect(isPdfBody("not a pdf")).toBe(false)
	})
})

// ── 3. isPdfBytes ────────────────────────────────────────────────────────

describe("isPdfBytes", () => {
	it("%PDF-1.4 bytes with high-bit (latin1) → true", () => {
		// High-bit bytes (0xC0, 0x80) test the latin1 decoding path —
		// UTF-8 would replacement-character or error on these.
		const bytes = [0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0xC0, 0x80]
		const buf = new Uint8Array(bytes)
		expect(isPdfBytes(buf)).toBe(true)
	})

	it("UTF-8 text bytes → false", () => {
		const buf = new TextEncoder().encode("<html><body>hello</body></html>")
		expect(isPdfBytes(buf)).toBe(false)
	})

	it("empty buffer → false", () => {
		expect(isPdfBytes(new Uint8Array(0))).toBe(false)
	})

	it("binary non-PDF (PNG header) → false", () => {
		const buf = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		expect(isPdfBytes(buf)).toBe(false)
	})
})

// ── 4. Converter engine selection with stub ExecFn ───────────────────────

describe("createPdfConverter (stub ExecFn)", () => {
	it("pymupdf4llm probe succeeds → engine pymupdf4llm, markdown passed through", async () => {
		const markdown = "# Hello PDF World\n\nThis is converted content."
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 0 },
			"python3 -c import sys, io, pymupdf, pymupdf4llm;":
				{ stdout: markdown, code: 0 },
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/path.pdf")
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.engine).toBe("pymupdf4llm")
			expect(result.markdown).toBe(markdown)
		}
	})

	it("pymupdf4llm probe fails, pdftotext succeeds → engine pdftotext", async () => {
		const markdown = "plain text from pdftotext"
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 1 },
			"sh -c command -v pdftotext": { stdout: "/opt/homebrew/bin/pdftotext", code: 0 },
			"pdftotext -layout /fake/path.pdf -": {
				stdout: markdown,
				code: 0,
			},
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/path.pdf")
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.engine).toBe("pdftotext")
			expect(result.markdown).toBe(markdown)
		}
	})

	it("both engines unavailable → { ok: false } with install instructions", async () => {
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 1 },
			"sh -c command -v pdftotext": { stdout: "", code: 1 },
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/path.pdf")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toMatch(/pip install pymupdf4llm/)
			expect(result.error).toMatch(/brew install poppler/)
		}
	})

	it("pymupdf4llm exits non-zero with a multiline traceback → error is the last line only", async () => {
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 0 },
			"python3 -c import sys, io, pymupdf, pymupdf4llm;": {
				stdout: "",
				code: 1,
				stderr:
					"Traceback (most recent call last):\n" +
					'  File "<string>", line 1, in <module>\n' +
					"RuntimeError: code=7: Invalid number of pages",
			},
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/corrupt.pdf")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toBe(
				"pymupdf4llm: RuntimeError: code=7: Invalid number of pages",
			)
			expect(result.error).not.toContain("Traceback")
		}
	})

	it("password-protected PDF → clear error, no traceback", async () => {
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 0 },
			"python3 -c import sys, io, pymupdf, pymupdf4llm;": {
				stdout: "",
				code: 1,
				stderr: "PDF is password-protected — no text extraction without the password",
			},
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/password.pdf")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toContain("password-protected")
			expect(result.error).not.toContain("Traceback")
		}
	})

	it("pymupdf4llm returns only whitespace → { ok: false } 'no extractable text'", async () => {
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 0 },
			"python3 -c import sys, io, pymupdf, pymupdf4llm;": {
				stdout: "   \n\t\n  ",
				code: 0,
			},
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/path.pdf")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toMatch(/no extractable text/i)
		}
	})

	it("pdftotext returns only whitespace → { ok: false } 'no extractable text'", async () => {
		const exec = stubExec({
			"python3 -c import pymupdf4llm": { stdout: "", code: 1 },
			"sh -c command -v pdftotext": { stdout: "/opt/homebrew/bin/pdftotext", code: 0 },
			"pdftotext -layout /fake/path.pdf -": {
				stdout: "  \n\t\n ",
				code: 0,
			},
		})
		const { convert } = createPdfConverter(exec)
		const result = await convert("/fake/path.pdf")
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toMatch(/no extractable text/i)
		}
	})
})

// ── 5. Real end-to-end conversion (guarded) ──────────────────────────────

describe("real PDF conversion (end-to-end)", () => {
	async function probeEngine(): Promise<"pymupdf4llm" | "pdftotext" | null> {
		// Try pymupdf4llm
		try {
			const r = await execFileP("python3", ["-c", "import pymupdf4llm"], {
				timeout: 15_000,
			})
			if ((r as any).exitCode === undefined) return "pymupdf4llm" // execFile doesn't fail on non-zero
		} catch {
			// not available
		}
		// Try pdftotext
		try {
			await execFileP("pdftotext", ["-v"], { timeout: 5_000 })
			return "pdftotext"
		} catch {
			// not available
		}
		return null
	}

	// The engine probe is an environment prerequisite, not the behavior under test.
	let engine: Awaited<ReturnType<typeof probeEngine>> = null
	beforeAll(async () => {
		engine = await probeEngine()
	}, 30_000)

	it("converts fixture PDF to markdown containing 'Hello PDF World'", async () => {
		if (!engine) {
			console.log("Skipping real conversion test: no engine available")
			return
		}

		const realExec: ExecFn = async (cmd, args, opts) => {
			try {
				const { stdout, stderr } = await execFileP(cmd, args, {
					timeout: opts?.timeout ?? 30_000,
					maxBuffer: 10 * 1024 * 1024,
				})
				return { stdout, stderr, code: 0 }
			} catch (e: any) {
				return {
					stdout: e.stdout ?? "",
					stderr: e.stderr ?? "",
					code: e.code ?? 1,
				}
			}
		}

		const { convert } = createPdfConverter(realExec)
		const pdfPath = join(fixtureDir, "hello.pdf")
		const result = await convert(pdfPath)

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.markdown).toMatch(/Hello PDF World/i)
			console.log(`Real conversion: engine=${result.engine}, output=${result.markdown.slice(0, 80)}...`)
		}
	}, 60_000)
})

// ── 6. buildFetchPdfResponse ─────────────────────────────────────────────

describe("buildFetchPdfResponse", () => {
	it("small markdown (≤12K) → inline with pdf: engine marker", async () => {
		const conv: PdfConversion = {
			ok: true,
			markdown: "# Hello\n\nConverted content.",
			engine: "pymupdf4llm",
		}
		const r = await buildFetchPdfResponse("curl exit: 0", conv, "https://example.com/doc.pdf")
		expect(r.content[0].text).toContain("pdf: pymupdf4llm -> markdown")
		expect(r.content[0].text).toContain("Converted content")
		expect(r.savedPath).toBeUndefined()
	})

	it("large markdown (>12K) → saved to disk with grep hint", async () => {
		const large = "# Large doc\n\n" + "A".repeat(PDF_INLINE_MAX_CHARS + 100)
		const conv: PdfConversion = {
			ok: true,
			markdown: large,
			engine: "pdftotext",
		}
		const r = await buildFetchPdfResponse("curl exit: 0", conv, "https://example.com/big.pdf")
		expect(r.savedPath).toBeDefined()
		expect(r.content[0].text).toContain("saved to disk")
		expect(r.content[0].text).toContain("grep -n -A5")
		expect(r.content[0].text).toContain("pdftotext -> markdown")
	})

	it("conversion failed → error with pdf skill pointer", async () => {
		const conv: PdfConversion = {
			ok: false,
			error: "No PDF conversion engine available. Install one:\n  pip install pymupdf4llm\n  brew install poppler",
		}
		const r = await buildFetchPdfResponse("curl exit: 0", conv, "https://example.com/doc.pdf")
		expect(r.content[0].text).toContain("pdf conversion failed")
		expect(r.content[0].text).toContain("pdf")
		expect(r.content[0].text).toContain("skill")
	})
})

// ── 7. buildReadPdfResponse ──────────────────────────────────────────────

describe("buildReadPdfResponse", () => {
	it("small → starts with 'Read PDF file' and contains converted text", async () => {
		const conv: PdfConversion = {
			ok: true,
			markdown: "# Chapter 1\n\nContent here.",
			engine: "pymupdf4llm",
		}
		const r = await buildReadPdfResponse(conv, "/some/path.pdf")
		expect(r.content[0].text).toMatch(/^Read PDF file \[pymupdf4llm\]/)
		expect(r.content[0].text).toContain("Content here")
		expect(r.savedPath).toBeUndefined()
	})

	it("large → savedPath + note about binary", async () => {
		const large = "# Big doc\n" + "B".repeat(PDF_INLINE_MAX_CHARS + 50)
		const conv: PdfConversion = {
			ok: true,
			markdown: large,
			engine: "pdftotext",
		}
		const r = await buildReadPdfResponse(conv, "/large.pdf")
		expect(r.savedPath).toBeDefined()
		expect(r.content[0].text).toContain("PDF files are binary")
		expect(r.content[0].text).toContain("grep -n -A5")
	})

	it("error → mentions skill, no binary", async () => {
		const conv: PdfConversion = {
			ok: false,
			error: "pdftotext: something went wrong",
		}
		const r = await buildReadPdfResponse(conv, "/bad.pdf")
		expect(r.content[0].text).toContain("conversion failed")
		expect(r.content[0].text).toContain("pdf")
		expect(r.content[0].text).toContain("skill")
	})
})

// ── 8. Never-binary invariant ────────────────────────────────────────────

describe("never-binary invariant", () => {
	it("no response text contains %PDF or U+FFFD replacement chars", async () => {
		const cases: Array<{
			name: string
			fn: () => Promise<{ content: { type: "text"; text: string }[] }>
		}> = [
			{
				name: "fetch small ok",
				fn: () =>
					buildFetchPdfResponse("prefix", {
						ok: true,
						markdown: "# Test",
						engine: "pymupdf4llm",
					}, "https://example.com/test.pdf"),
			},
			{
				name: "fetch large ok",
				fn: () =>
					buildFetchPdfResponse("prefix", {
						ok: true,
						markdown: "A".repeat(PDF_INLINE_MAX_CHARS + 1),
						engine: "pdftotext",
					}, "https://example.com/test.pdf"),
			},
			{
				name: "fetch error",
				fn: () =>
					buildFetchPdfResponse("prefix", {
						ok: false,
						error: "engine not found",
					}, "https://example.com/test.pdf"),
			},
			{
				name: "read small ok",
				fn: () =>
					buildReadPdfResponse({
						ok: true,
						markdown: "# Test",
						engine: "pymupdf4llm",
					}, "/test.pdf"),
			},
			{
				name: "read large ok",
				fn: () =>
					buildReadPdfResponse({
						ok: true,
						markdown: "B".repeat(PDF_INLINE_MAX_CHARS + 1),
						engine: "pdftotext",
					}, "/test.pdf"),
			},
			{
				name: "read error",
				fn: () =>
					buildReadPdfResponse({
						ok: false,
						error: "engine not found",
					}, "/test.pdf"),
			},
		]

		for (const c of cases) {
			const r = await c.fn()
			const text = r.content.map((c) => c.text).join("\n")
			expect(text).not.toMatch(/%PDF/)
			expect(text).not.toMatch(/\uFFFD/)
		}
	})
})

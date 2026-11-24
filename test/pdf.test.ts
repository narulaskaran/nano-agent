import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ResizedImage } from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig } from "../src/config.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import {
	DEFAULT_PDF_DPI,
	DEFAULT_PDF_PAGES,
	formatPages,
	MAX_PDF_DPI,
	MAX_PDF_PAGES,
	MIN_PDF_DPI,
	parsePageSelection,
	PDF_TEXT_CHAR_CAP,
	type PdfRunner,
	resolveDpi,
	toContiguousRanges,
	viewPdf,
} from "../src/pdf.ts";
import { nanoTools } from "../src/tools.ts";

// Minimal 1x1 PNG bytes for resizer / fallback checks.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function fakeModel(input: Model<Api>["input"]): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://127.0.0.1",
		input,
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4096,
	};
}

/** Build a valid N-page PDF with page labels and a drawn diagonal stroke on page 1. */
function makeMinimalPdf(pageCount = 1): Buffer {
	const fontObjId = 3 + pageCount * 2;
	const pageRefs = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		`2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pageCount} >>\nendobj\n`,
	];
	for (let i = 0; i < pageCount; i++) {
		const pageId = 3 + i * 2;
		const contentId = pageId + 1;
		const stroke = i === 0 ? "2 w 72 640 m 220 670 l S\n" : "";
		const stream = `BT /F1 18 Tf 72 700 Td (Signed Form Page ${i + 1}) Tj ET\n${stroke}`;
		objects.push(
			`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
			`${contentId} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
		);
	}
	objects.push(`${fontObjId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [0];
	for (const obj of objects) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += obj;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i < offsets.length; i++) {
		pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "ascii");
}

function hasPoppler(): boolean {
	try {
		execFileSync("pdfinfo", ["-v"], { stdio: "ignore" });
		execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("parsePageSelection handles defaults, ranges, clamping, and invalid input", () => {
	assert.deepEqual(parsePageSelection(undefined, 10), [1, 2, 3]);
	assert.deepEqual(parsePageSelection("  ", 2), [1, 2]);
	assert.deepEqual(parsePageSelection("1", 1), [1]);
	assert.deepEqual(parsePageSelection("2-4", 10), [2, 3, 4]);
	assert.deepEqual(parsePageSelection("5, 1-2, 2", 10), [1, 2, 5]);
	assert.deepEqual(parsePageSelection("2-9", 3), [2, 3]);

	assert.throws(() => parsePageSelection("abc", 5), /Invalid pages/);
	assert.throws(() => parsePageSelection("1,,2", 5), /Invalid pages/);
	assert.throws(() => parsePageSelection("0", 5), /Invalid page range/);
	assert.throws(() => parsePageSelection("4-2", 5), /Invalid page range/);
	assert.throws(() => parsePageSelection("6", 5), /out of range/);
	assert.throws(() => parsePageSelection(`1-${MAX_PDF_PAGES + 1}`, 10), /Too many pages/);
});

test("toContiguousRanges and formatPages collapse adjacent pages", () => {
	assert.deepEqual(toContiguousRanges([1, 2, 3]), [[1, 3]]);
	assert.deepEqual(toContiguousRanges([1, 3, 4, 7]), [
		[1, 1],
		[3, 4],
		[7, 7],
	]);
	assert.equal(formatPages([1]), "1");
	assert.equal(formatPages([1, 2, 4]), "1-2, 4");
});

test("resolveDpi uses default, clamps to bounds, and rejects invalid values", () => {
	assert.equal(resolveDpi(undefined), DEFAULT_PDF_DPI);
	assert.equal(resolveDpi(50), MIN_PDF_DPI);
	assert.equal(resolveDpi(600), MAX_PDF_DPI);
	assert.equal(resolveDpi(199.6), 200);
	assert.throws(() => resolveDpi(0), /Invalid dpi/);
	assert.throws(() => resolveDpi(-100), /Invalid dpi/);
	assert.throws(() => resolveDpi(Number.NaN), /Invalid dpi/);
});

test("viewPdf renders pages into image blocks, cleans up temp dir, and hints remaining pages", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "nano-pdf-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pdfPath = join(dir, "signed.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");

	let capturedOutDir = "";
	let capturedRanges: readonly [number, number][] = [];
	let capturedDpi = 0;

	const runner: PdfRunner = {
		async pageCount() {
			return 6;
		},
		async renderPages(_path, ranges, dpi, outDir) {
			capturedRanges = ranges;
			capturedDpi = dpi;
			capturedOutDir = outDir;
			assert.equal(existsSync(outDir), true);
			return [
				{ page: 1, bytes: TINY_PNG },
				{ page: 2, bytes: TINY_PNG },
				{ page: 3, bytes: TINY_PNG },
			];
		},
		async extractText() {
			throw new Error("extractText should not run on vision models");
		},
	};

	let resizeCalls = 0;
	const resizer = async (): Promise<ResizedImage> => {
		resizeCalls++;
		return {
			data: TINY_PNG.toString("base64"),
			mimeType: "image/png",
			originalWidth: 2550,
			originalHeight: 3300,
			width: 1545,
			height: 2000,
			wasResized: resizeCalls === 2,
		};
	};

	const result = await viewPdf(pdfPath, { dpi: 200 }, { model: fakeModel(["text", "image"]), runner, resizer });
	assert.equal(existsSync(capturedOutDir), false, "temporary render directory is removed");
	assert.deepEqual(capturedRanges, [[1, DEFAULT_PDF_PAGES]]);
	assert.equal(capturedDpi, 200);
	assert.equal(result.details.mode, "images");
	assert.deepEqual(result.details.pages, [1, 2, 3]);
	assert.equal(result.content.length, 4);
	assert.equal(result.content[0]?.type, "text");
	const summary = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(summary, /PDF: signed\.pdf \(6 pages\)\. Attached page images in order: 1-3 of 6 \(200 DPI\)\./);
	assert.match(summary, /Pass pages="4-6" to inspect more\./);
	assert.match(summary, /Page 2: \[Image: original 2550x3300, displayed at 1545x2000\./);
	for (let i = 1; i <= 3; i++) {
		assert.equal(result.content[i]?.type, "image");
	}
});

test("viewPdf cleans up temp dir on render failure and validates paths", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "nano-pdf-err-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pdfPath = join(dir, "broken.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");

	await assert.rejects(() => viewPdf(join(dir, "missing.pdf")), /No such file/);
	await assert.rejects(() => viewPdf(dir), /Not a file/);

	let seenOutDir = "";
	const failingRunner: PdfRunner = {
		async pageCount() {
			return 1;
		},
		async renderPages(_path, _ranges, _dpi, outDir) {
			seenOutDir = outDir;
			throw new Error("render boom");
		},
		async extractText() {
			return "";
		},
	};
	await assert.rejects(() => viewPdf(pdfPath, {}, { runner: failingRunner }), /render boom/);
	assert.equal(existsSync(seenOutDir), false, "temp dir is cleaned up on error");
});

test("viewPdf falls back to extracted text on non-vision models and caps long text", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "nano-pdf-text-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pdfPath = join(dir, "notice.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");

	const bigText = "x".repeat(PDF_TEXT_CHAR_CAP + 50);
	const runner: PdfRunner = {
		async pageCount() {
			return 2;
		},
		async renderPages() {
			throw new Error("renderPages should not run on text-only models");
		},
		async extractText() {
			return bigText;
		},
	};

	const result = await viewPdf(pdfPath, { pages: "1-2" }, { model: fakeModel(["text"]), runner });
	assert.equal(result.details.mode, "text");
	assert.equal(result.content.length, 1);
	const body = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(body, /Current model does not support images; returning extracted text only/);
	assert.match(body, new RegExp(`\\[cut at ${PDF_TEXT_CHAR_CAP} of ${bigText.length} chars\\]`));
});

test("viewPdf handles resizer returning null for small and oversized PNGs", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "nano-pdf-null-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pdfPath = join(dir, "two.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");

	const runner: PdfRunner = {
		async pageCount() {
			return 2;
		},
		async renderPages() {
			return [
				{ page: 1, bytes: TINY_PNG },
				{ page: 2, bytes: Buffer.alloc(3 * 1024 * 1024 + 1) },
			];
		},
		async extractText() {
			return "";
		},
	};

	const result = await viewPdf(pdfPath, { pages: "1-2" }, { runner, resizer: async () => null });
	assert.equal(result.content.length, 2, "small page falls back to raw PNG, oversized page is omitted");
	const summary = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(summary, /Attached page image in order: 1 of 2/);
	assert.match(summary, /Page 2: \[Image omitted/);
	assert.equal(result.content[1]?.type, "image");
});

test("nanoTools registers view_pdf, resolves workspace paths, and prompt advertises it", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-pdf-tool-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config: Config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "core" });
	mkdirSync(join(dataDir, "workspace"), { recursive: true });
	assert.match(buildSystemPrompt(config), /view_pdf/);

	type ViewPdfExec = (id: string, params: { path: string; pages?: string; dpi?: number }) => Promise<unknown>;
	let execute: ViewPdfExec | undefined;
	const register = nanoTools(config, {} as never, {} as never, "space", { modelRuntime: {} as never });
	void register({
		registerTool(tool: { name: string; execute: ViewPdfExec }) {
			if (tool.name === "view_pdf") execute = tool.execute;
		},
	} as unknown as ExtensionAPI);
	assert.ok(execute, "view_pdf is registered");
	await assert.rejects(
		() => execute!("1", { path: "attachments/missing.pdf" }),
		new RegExp(`No such file: ${join(dataDir, "workspace", "attachments", "missing.pdf").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
	);
});

test("viewPdf works end-to-end with poppler-utils when installed", async (t) => {
	if (!hasPoppler()) return t.skip("poppler-utils not installed on host");
	const dir = mkdtempSync(join(tmpdir(), "nano-pdf-e2e-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pdfPath = join(dir, "signed-form.pdf");
	writeFileSync(pdfPath, makeMinimalPdf(10));

	const visual = await viewPdf(pdfPath, { pages: "1, 10" }, { model: fakeModel(["text", "image"]) });
	assert.equal(visual.details.totalPages, 10);
	assert.equal(visual.details.mode, "images");
	assert.deepEqual(visual.details.pages, [1, 10]);
	assert.equal(visual.content.length, 3);
	assert.equal(visual.content[1]?.type, "image");
	assert.equal(visual.content[1]?.mimeType, "image/png");
	assert.equal(visual.content[2]?.type, "image");

	const textOnly = await viewPdf(pdfPath, { pages: "1, 10" }, { model: fakeModel(["text"]) });
	assert.equal(textOnly.details.mode, "text");
	const text = textOnly.content[0]?.type === "text" ? textOnly.content[0].text : "";
	assert.match(text, /Signed Form Page 1/);
	assert.match(text, /Signed Form Page 10/);
});

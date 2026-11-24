import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, type ResizedImage, resizeImage } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export const DEFAULT_PDF_PAGES = 3;
export const MAX_PDF_PAGES = 5;
export const DEFAULT_PDF_DPI = 150;
export const MIN_PDF_DPI = 72;
export const MAX_PDF_DPI = 300;
export const PDF_TEXT_CHAR_CAP = 20_000;
const PDF_EXEC_TIMEOUT_MS = 30_000;
const RAW_FALLBACK_MAX_BYTES = 3 * 1024 * 1024;

export interface RenderedPdfPage {
	page: number;
	bytes: Buffer;
}

export interface PdfRunner {
	pageCount(path: string, signal?: AbortSignal): Promise<number>;
	renderPages(path: string, ranges: readonly [number, number][], dpi: number, outDir: string, signal?: AbortSignal): Promise<RenderedPdfPage[]>;
	extractText(path: string, ranges: readonly [number, number][], signal?: AbortSignal): Promise<string>;
}

export type PdfImageResizer = (bytes: Uint8Array, mimeType: string, options?: Parameters<typeof resizeImage>[2]) => Promise<ResizedImage | null>;

export interface ViewPdfParams {
	pages?: string;
	dpi?: number;
}

export interface ViewPdfOptions {
	signal?: AbortSignal;
	model?: Model<Api>;
	runner?: PdfRunner;
	resizer?: PdfImageResizer;
}

export interface ViewPdfDetails {
	path: string;
	totalPages: number;
	pages: number[];
	dpi: number;
	mode: "images" | "text";
}

export interface ViewPdfResult {
	content: (TextContent | ImageContent)[];
	details: ViewPdfDetails;
}

async function execPoppler(cmd: "pdfinfo" | "pdftoppm" | "pdftotext", args: string[], signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("Operation aborted");
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			encoding: "utf8",
			timeout: PDF_EXEC_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
			signal,
		});
		return stdout;
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
		if (err.code === "ENOENT") throw new Error(`PDF inspection requires poppler-utils (${cmd}), which is not installed.`);
		if (signal?.aborted || err.name === "AbortError") throw new Error("Operation aborted");
		const detail = err.stderr?.trim() || err.message || String(error);
		throw new Error(`Could not inspect PDF (${cmd}): ${detail}`);
	}
}

/** Default runner backed by poppler-utils (pdfinfo, pdftoppm, pdftotext). */
export const popplerRunner: PdfRunner = {
	async pageCount(path, signal) {
		const stdout = await execPoppler("pdfinfo", [path], signal);
		const match = /^Pages:\s*(\d+)/m.exec(stdout);
		const count = match ? Number(match[1]) : NaN;
		if (!Number.isInteger(count) || count < 1) throw new Error(`Could not determine page count for ${basename(path)}.`);
		return count;
	},

	async renderPages(path, ranges, dpi, outDir, signal) {
		const prefix = join(outDir, "page");
		for (const [first, last] of ranges) {
			await execPoppler("pdftoppm", ["-png", "-r", String(dpi), "-f", String(first), "-l", String(last), path, prefix], signal);
		}
		const rendered: RenderedPdfPage[] = [];
		for (const entry of readdirSync(outDir)) {
			const match = /^page-(\d+)\.png$/.exec(entry);
			if (!match) continue;
			rendered.push({ page: Number(match[1]), bytes: readFileSync(join(outDir, entry)) });
		}
		rendered.sort((a, b) => a.page - b.page);
		return rendered;
	},

	async extractText(path, ranges, signal) {
		const chunks: string[] = [];
		for (const [first, last] of ranges) {
			chunks.push(await execPoppler("pdftotext", ["-f", String(first), "-l", String(last), path, "-"], signal));
		}
		return chunks.join("\n\n");
	},
};

/** Parse a 1-indexed page selection like "1", "1-3", "2,4-5" against `totalPages`. */
export function parsePageSelection(spec: string | undefined, totalPages: number, maxPages = MAX_PDF_PAGES): number[] {
	if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error(`Invalid PDF page count: ${totalPages}.`);
	const trimmed = spec?.trim();
	if (!trimmed) {
		const count = Math.min(totalPages, DEFAULT_PDF_PAGES);
		return Array.from({ length: count }, (_, i) => i + 1);
	}
	const chosen = new Set<number>();
	for (const raw of trimmed.split(",")) {
		const token = raw.trim();
		const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
		if (!match) throw new Error(`Invalid pages "${spec}". Use 1-indexed page numbers or ranges like "1", "1-3", or "2,4".`);
		const start = Number(match[1]);
		const end = match[2] !== undefined ? Number(match[2]) : start;
		if (start < 1 || end < 1 || start > end) {
			throw new Error(`Invalid page range "${token}". Pages are 1-indexed and start must not exceed end.`);
		}
		if (start > totalPages) {
			throw new Error(`Page ${start} is out of range (PDF has ${totalPages} ${totalPages === 1 ? "page" : "pages"}).`);
		}
		const clampedEnd = Math.min(end, totalPages);
		for (let p = start; p <= clampedEnd; p++) chosen.add(p);
	}
	const selected = [...chosen].sort((a, b) => a - b);
	if (selected.length > maxPages) {
		throw new Error(
			`Too many pages requested (${selected.length}; max ${maxPages} per call). This PDF has ${totalPages} pages — request smaller ranges like "1-${maxPages}".`,
		);
	}
	return selected;
}

/** Collapse sorted 1-indexed page numbers into contiguous [first, last] runs. */
export function toContiguousRanges(pages: readonly number[]): [number, number][] {
	const ranges: [number, number][] = [];
	for (const page of pages) {
		const prev = ranges[ranges.length - 1];
		if (prev && page === prev[1] + 1) prev[1] = page;
		else ranges.push([page, page]);
	}
	return ranges;
}

/** Format sorted page numbers concisely, e.g. [1, 2, 4] -> "1-2, 4". */
export function formatPages(pages: readonly number[]): string {
	return toContiguousRanges(pages)
		.map(([first, last]) => (first === last ? String(first) : `${first}-${last}`))
		.join(", ");
}

export function resolveDpi(dpi: number | undefined): number {
	if (dpi === undefined) return DEFAULT_PDF_DPI;
	if (!Number.isFinite(dpi) || dpi <= 0) throw new Error(`Invalid dpi: ${dpi}. Use a number between ${MIN_PDF_DPI} and ${MAX_PDF_DPI}.`);
	return Math.round(Math.min(MAX_PDF_DPI, Math.max(MIN_PDF_DPI, dpi)));
}

/** Render PDF pages as images for vision inspection, falling back to extracted text for non-vision models. */
export async function viewPdf(path: string, params: ViewPdfParams = {}, options: ViewPdfOptions = {}): Promise<ViewPdfResult> {
	const absPath = resolve(path);
	if (!existsSync(absPath)) throw new Error(`No such file: ${absPath}`);
	if (!statSync(absPath).isFile()) throw new Error(`Not a file: ${absPath}`);

	const dpi = resolveDpi(params.dpi);
	const runner = options.runner ?? popplerRunner;
	const resizer = options.resizer ?? resizeImage;
	const totalPages = await runner.pageCount(absPath, options.signal);
	const selected = parsePageSelection(params.pages, totalPages);
	const ranges = toContiguousRanges(selected);
	const name = basename(absPath);
	const highest = selected[selected.length - 1]!;
	const nextHint =
		totalPages > highest
			? ` Pass pages="${highest + 1}${totalPages > highest + 1 ? `-${Math.min(totalPages, highest + DEFAULT_PDF_PAGES)}` : ""}" to inspect more.`
			: "";

	const supportsVision = !options.model || options.model.input.includes("image");
	if (!supportsVision) {
		const raw = (await runner.extractText(absPath, ranges, options.signal)).trim();
		const body =
			raw.length === 0
				? "(no extractable text on these pages)"
				: raw.length > PDF_TEXT_CHAR_CAP
					? `${raw.slice(0, PDF_TEXT_CHAR_CAP)}\n[cut at ${PDF_TEXT_CHAR_CAP} of ${raw.length} chars]`
					: raw;
		const header = [
			`PDF: ${name} (${totalPages} ${totalPages === 1 ? "page" : "pages"}). Pages ${formatPages(selected)} of ${totalPages}.${nextHint}`,
			"[Current model does not support images; returning extracted text only — signatures, handwriting, checkboxes and scans are not visible.]",
		].join("\n");
		return {
			content: [{ type: "text", text: `${header}\n\n${body}` }],
			details: { path: absPath, totalPages, pages: selected, dpi, mode: "text" },
		};
	}

	const outDir = mkdtempSync(join(tmpdir(), "nano-pdf-"));
	let rendered: RenderedPdfPage[];
	try {
		rendered = await runner.renderPages(absPath, ranges, dpi, outDir, options.signal);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
	if (rendered.length === 0) throw new Error(`Could not render any pages from ${name}.`);

	const notes: string[] = [];
	const images: ImageContent[] = [];
	const attachedPages: number[] = [];
	const resizeOptions = options.model?.inputLimits?.images?.resize;
	for (const page of rendered) {
		const resized = await resizer(page.bytes, "image/png", resizeOptions);
		if (resized) {
			const dimNote = formatDimensionNote(resized);
			if (dimNote) notes.push(`Page ${page.page}: ${dimNote}`);
			attachedPages.push(page.page);
			images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		} else if (page.bytes.byteLength <= RAW_FALLBACK_MAX_BYTES) {
			attachedPages.push(page.page);
			images.push({ type: "image", data: page.bytes.toString("base64"), mimeType: "image/png" });
		} else {
			notes.push(`Page ${page.page}: [Image omitted: could not be resized below the inline image size limit.]`);
		}
	}

	const attached =
		attachedPages.length > 0
			? `Attached page ${attachedPages.length === 1 ? "image" : "images"} in order: ${formatPages(attachedPages)} of ${totalPages} (${dpi} DPI).`
			: `No page images could be attached for pages ${formatPages(selected)} of ${totalPages}.`;
	const header = `PDF: ${name} (${totalPages} ${totalPages === 1 ? "page" : "pages"}). ${attached}${nextHint}`;
	const summary = [header, ...notes].join("\n");
	return {
		content: [{ type: "text", text: summary }, ...images],
		details: { path: absPath, totalPages, pages: selected, dpi, mode: "images" },
	};
}

import * as fs from "fs-extra"
import { bench, describe } from 'vitest'
import { encodePng } from "image-js"
import { toImage } from "../src/conversion"
import { createPdfContext, addPdfPage } from "../src/pdf"
import { SupernoteX } from "../src/parsing"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// Profiling spike for plans/rtr-searchable-pdf-workers.md step 1: measures
// how much of toPdf()'s total time is spent in the CPU-heavy, worker-safe
// render step (toImage + encodePng — both are what a Worker would run, per
// the README's documented pattern) vs. the main-thread-only assembly step
// (createPdfContext + addPdfPage given already-encoded PNG bytes), to decide
// whether parallelizing render alone (Option A) captures most of the win.
const file = "demo-a5x-20230015-1to10.note";
const buf = readFileToUint8Array(file);
const sn = new SupernoteX(buf);
const images = await toImage(sn);
const pngBytes = images.map((image) => encodePng(image));

describe(`toPdf phases (${file}, ${sn.pages.length} pages)`, () => {
	bench("render (toImage + encodePng, all pages — worker-eligible)", async () => {
		const rendered = await toImage(sn);
		for (const image of rendered) encodePng(image);
	});

	bench("assemble (createPdfContext + addPdfPage loop, pre-encoded PNG bytes — main-thread-only)", async () => {
		const ctx = await createPdfContext();
		for (let i = 0; i < sn.pages.length; i++) {
			await addPdfPage(ctx, sn.pages[i], pngBytes[i]);
		}
		await ctx.pdfDoc.save();
	});
});

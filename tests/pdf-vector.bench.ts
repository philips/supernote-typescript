import * as fs from "fs-extra"
import { bench, describe } from 'vitest'
import { toPdf } from "../src/pdf"
import { prepareVectorInkPages, buildVectorInkPrimitives } from "../src/vector-ink"
import { SupernoteX } from "../src/parsing"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// Profiling spike for plans/profile-vector-pdf.md step 1: measures
// toPdf({ vectorInk: true }) against toPdf() (raster) on the densest fixtures
// named in https://github.com/philips/supernote-typescript/issues/101, plus a
// sparse control, to decide whether the vector-ink PDF path needs
// optimization for v0.6.0. The "build-only" bench isolates the pure,
// worker-safe primitive-build step (prepareVectorInkPages +
// buildVectorInkPrimitives) from pdf-lib's content-stream serialization, so
// step 2 of the plan has the cost-center breakdown already in hand.
//
// vitest bench's warmup average is noisy for a one-shot decision; the actual
// numbers used in the plan's profile table come from a one-shot harness, not
// from these -- these benches are here for regression tracking.

const files = [
	"sticker-n5-20260016-plugin-artwork.note",
	"caligraphy-n5-20260016-widths-erase.note",
	"turkish-a6x-20230015-handwriting-erase.note",
	// sparse control: a dense-only regression should show up as this staying flat
	"demo-a5x-20230015-1to10.note",
];

for (const file of files) {
	const buf = readFileToUint8Array(file);
	const sn = new SupernoteX(buf);

	describe(`vector vs. raster PDF (${file}, ${sn.pages.length} page(s))`, () => {
		bench("toPdf() — raster (baseline)", async () => {
			await toPdf(sn);
		});

		bench("toPdf({ vectorInk: true })", async () => {
			await toPdf(sn, { vectorInk: true });
		});

		bench("vector-ink build only (prepareVectorInkPages + buildVectorInkPrimitives, no pdf-lib)", async () => {
			const pages = prepareVectorInkPages(sn, undefined, 1);
			for (const vip of pages) {
				if (vip.useVectorInk) buildVectorInkPrimitives(vip.strokes, vip.styles);
			}
		});
	});
}

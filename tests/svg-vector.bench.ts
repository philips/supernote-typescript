import * as fs from "fs-extra"
import { bench, describe } from 'vitest'
import { toImage } from "../src/conversion"
import { toPdf } from "../src/pdf"
import { toSvg } from "../src/svg"
import { SupernoteX } from "../src/parsing"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// Fixtures whose pages actually cross MIN_INK_COVERAGE_TO_REPLACE_RASTER
// (see issue #56) -- i.e. where vectorInk actually replaces the rasterized
// ink rather than silently falling back to it, so these numbers reflect the
// real cost of the vector path, not a no-op.
const files = ["a5x-2.14.28.note", "horizontal_1270.note", "test.note"];

// Compares the existing raster-only export paths (toImage for PNG, toPdf)
// against toSvg's vectorInk option, to quantify what switching a page's ink
// from rasterized to <path> vectors costs (or saves) relative to generating
// the same page the old way.
for (const file of files) {
	const buf = readFileToUint8Array(file);
	const sn = new SupernoteX(buf);

	describe(`export cost, raster vs. vector (${file}, ${sn.pages.length} page(s))`, () => {
		bench("toImage (PNG raster, all pages)", async () => {
			await toImage(sn);
		});

		bench("toPdf (raster image embedded per page)", async () => {
			await toPdf(sn);
		});

		bench("toSvg (raster ink, embedded PNG only)", async () => {
			await toSvg(sn);
		});

		bench("toSvg({ vectorInk: true }) (decoded pen strokes as <path>)", async () => {
			await toSvg(sn, { vectorInk: true });
		});
	});
}

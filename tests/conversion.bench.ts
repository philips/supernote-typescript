import * as fs from "fs-extra"
import { bench, describe } from 'vitest'
import { toImage, RattaRLEDecoder } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import { ILayer } from "../src/format"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// Representative fixtures: a small simple note and a couple of larger,
// multi-page / multi-layer notes to reflect real-world usage.
const files = [
	"test-a5x-20220011-old-pen-ids.note",
	"blank-n5-20230015-manta.note",
	"blank-a6x-3.15.27-shapes-rtr.note",
	"ink-a5x-2.14.28-old-pen-width.note",
];

describe("toImage end-to-end", () => {
	for (const file of files) {
		const buf = readFileToUint8Array(file);
		const sn = new SupernoteX(buf);
		bench(file, async () => {
			await toImage(sn);
		});
	}
});

describe("RattaRLEDecoder.decode", () => {
	for (const file of files) {
		const buf = readFileToUint8Array(file);
		const sn = new SupernoteX(buf);
		const page = sn.pages[0];
		const layerName = page.LAYERSEQ.find((name) => {
			const layer = page[name] as ILayer;
			return layer && layer.bitmapBuffer !== null && layer.bitmapBuffer.length;
		});
		if (!layerName) continue;
		const layer = page[layerName] as ILayer;
		const layerBuffer = layer.bitmapBuffer as Uint8Array;

		bench(`${file} (${layerName}, ${layerBuffer.length} bytes)`, () => {
			const decoder = new RattaRLEDecoder();
			decoder.decode(layerBuffer, sn.pageWidth, sn.pageHeight);
		});
	}
});

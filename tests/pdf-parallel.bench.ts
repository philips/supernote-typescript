import * as fs from "fs-extra"
import os from "node:os"
import { Worker } from "node:worker_threads"
import { bench, describe, afterAll } from 'vitest'
import { encodePng } from "image-js"
import { toImage, extractPageRenderData } from "../src/conversion"
import { createPdfContext, addPdfPage } from "../src/pdf"
import { SupernoteX } from "../src/parsing"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** A minimal persistent worker pool, built only for this benchmark — per
 * plans/rtr-searchable-pdf-workers.md, orchestration is application-specific
 * and out of this library's scope (see the README's own example). Workers
 * stay alive across requests (render-worker-pool.mjs), so pool/Worker
 * startup cost is paid once, not per page, matching how a long-lived app
 * would use this. */
function createPool(size: number) {
	const workers = Array.from(
		{ length: size },
		() => new Worker(new URL("./fixtures/render-worker-pool.mjs", import.meta.url)),
	);
	let next = 0;

	function render(pageRenderData: unknown): Promise<Uint8Array> {
		const worker = workers[next];
		next = (next + 1) % workers.length;
		return new Promise((resolve, reject) => {
			const onMessage = (pngBytes: Uint8Array) => {
				worker.off("error", onError);
				resolve(pngBytes);
			};
			const onError = (err: unknown) => {
				worker.off("message", onMessage);
				reject(err);
			};
			worker.once("message", onMessage);
			worker.once("error", onError);
			worker.postMessage(pageRenderData);
		});
	}

	function terminate() {
		return Promise.all(workers.map((worker) => worker.terminate()));
	}

	return { render, terminate };
}

const file = "demo-a5x-20230015-1to10.note";
const sn = new SupernoteX(readFileToUint8Array(file));
const poolSize = Math.max(2, Math.min(4, os.cpus().length));
const pool = createPool(poolSize);

afterAll(() => pool.terminate());

// Confirms plans/rtr-searchable-pdf-workers.md's premise end-to-end: that
// parallelizing render (toImage + encodePng) across Workers, then
// assembling on the main thread via createPdfContext/addPdfPage, is
// actually faster wall-clock than doing everything on one thread — not
// just that the render portion is theoretically parallelizable.
describe(`toPdf serial vs. worker-parallel (${file}, ${sn.pages.length} pages, pool=${poolSize})`, () => {
	bench("serial: single-thread toImage + encodePng + assemble", async () => {
		const images = await toImage(sn);
		const pngBytes = images.map((image) => encodePng(image));

		const ctx = await createPdfContext();
		for (let i = 0; i < sn.pages.length; i++) {
			await addPdfPage(ctx, sn.pages[i], pngBytes[i]);
		}
		await ctx.pdfDoc.save();
	});

	bench(`parallel: ${poolSize}-worker render pool + main-thread assemble`, async () => {
		const pngBytes = await Promise.all(
			sn.pages.map((_, i) => pool.render(extractPageRenderData(sn, i + 1))),
		);

		const ctx = await createPdfContext();
		for (let i = 0; i < sn.pages.length; i++) {
			await addPdfPage(ctx, sn.pages[i], pngBytes[i]);
		}
		await ctx.pdfDoc.save();
	});
});

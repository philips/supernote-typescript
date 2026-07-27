import * as fs from "fs-extra"
import { existsSync } from "fs"
import { Worker } from "node:worker_threads"
import { decodePng } from "image-js"
import { describe, test, expect, beforeAll } from 'vitest'
import { extractPageRenderData, toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"

function readFileToUint8Array(filePath: string): Uint8Array {
	const data = fs.readFileSync(`tests/input/${filePath}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function runRenderWorker(pageRenderData: unknown): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./fixtures/render-worker.mjs", import.meta.url), {
			workerData: { pageRenderData },
		});
		worker.once("message", (pngBytes: Uint8Array) => {
			worker.terminate();
			resolve(pngBytes);
		});
		worker.once("error", reject);
	});
}

describe("worker-parallel page rendering", () => {
	beforeAll(() => {
		if (!existsSync("lib/conversion.js")) {
			throw new Error(
				"lib/conversion.js not found — this test exercises the worker_threads " +
				"round trip against the built package (worker_threads can't load .ts " +
				"directly). Run `npm run build` first (the `pretest` script does this " +
				"automatically for `npm test`).",
			);
		}
	});

	test("extractPageRenderData survives structured clone and round-trips through a worker", { timeout: 30000 }, async () => {
		const sn = new SupernoteX(readFileToUint8Array("1to10.note"));
		const renderData = extractPageRenderData(sn, 1);

		// structuredClone is what postMessage uses internally; assert it
		// doesn't throw as a direct sanity check on clone-safety, independent
		// of whether the worker itself is wired up correctly.
		expect(() => structuredClone(renderData)).not.toThrow();

		const pngBytes = await runRenderWorker(renderData);
		const workerImage = decodePng(pngBytes);

		const [mainThreadImage] = await toImage(sn, [1]);

		expect(workerImage.width).toBe(mainThreadImage.width);
		expect(workerImage.height).toBe(mainThreadImage.height);

		// Not `.toEqual()`: on a multi-megabyte mismatch, vitest's failure-diff
		// machinery walks/prints the arrays element-by-element and can exhaust
		// the heap. A manual byte compare gives the same guarantee cheaply.
		const workerData = workerImage.getRawImage().data;
		const mainThreadData = mainThreadImage.getRawImage().data;
		const workerBytes = Buffer.from(workerData.buffer, workerData.byteOffset, workerData.byteLength);
		const mainThreadBytes = Buffer.from(mainThreadData.buffer, mainThreadData.byteOffset, mainThreadData.byteLength);
		expect(Buffer.compare(workerBytes, mainThreadBytes)).toBe(0);
	});
});

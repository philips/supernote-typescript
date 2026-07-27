// Persistent worker_threads entry point for tests/pdf-parallel.bench.ts.
// Unlike render-worker.mjs (one task per Worker instantiation, used by the
// worker_threads round-trip test), this stays alive and answers repeated
// render requests over postMessage, so a benchmark can amortize Worker
// startup across many pages instead of paying it per page.
import { parentPort } from 'node:worker_threads';
import { encodePng } from 'image-js';
import { toImage } from '../../lib/conversion.js';

parentPort.on('message', async (pageRenderData) => {
	const [image] = await toImage(pageRenderData, [1]);
	const pngBytes = encodePng(image);
	parentPort.postMessage(pngBytes, [pngBytes.buffer]);
});

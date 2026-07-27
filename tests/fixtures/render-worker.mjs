// Plain-JS worker_threads entry point for tests/pdf-worker-roundtrip.test.ts.
// worker_threads can't load .ts directly, so this imports the built output
// (lib/, produced by `npm run build`, which the `pretest` script guarantees
// exists) rather than src/ — exercising exactly what an application's own
// Worker would do with this library's published package.
import { parentPort, workerData } from 'node:worker_threads';
import { encodePng } from 'image-js';
import { toImage } from '../../lib/conversion.js';

const [image] = await toImage(workerData.pageRenderData, [1]);
const pngBytes = encodePng(image);
parentPort.postMessage(pngBytes, [pngBytes.buffer]);

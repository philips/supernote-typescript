/**
 * Regenerates `tests/visual-diff-baselines.json` from the current render.
 *
 * Run after an *intentional* rendering change; the resulting diff in the
 * baseline file is the review artifact for that change, the way `--update`
 * snapshots are.
 *
 *   npm run visual-diff:baseline
 */

import * as fs from 'node:fs';
import { listFixturesWithDevicePdf, computeMetrics, type VisualDiffMetrics } from './visual-diff.js';

const OUT_FILE = 'tests/visual-diff-baselines.json';

async function main() {
	const fixtures = await listFixturesWithDevicePdf();
	const baselines: Record<string, Record<string, VisualDiffMetrics>> = {};
	let totalPages = 0;
	for (const { name, pages } of fixtures) {
		const pageMap: Record<string, VisualDiffMetrics> = {};
		for (let p = 1; p <= pages; p++) {
			const m = await computeMetrics(`${name}.note`, p);
			pageMap[String(p)] = m;
			totalPages++;
			console.log(`${name} p${p}: ink=${m.ourInkPixels}/${m.deviceInkPixels} iou=${m.iouSvgVsDevice.toFixed(3)} pdfDiff=${m.pdfDiffFrac.toFixed(4)}`);
		}
		baselines[name] = pageMap;
	}
	// Pure JSON (no comment header -- JSON does not allow comments). The
	// regenerate command and the drift-not-targets intent are documented in
	// tests/pdf-visual-diff.test.ts and AGENTS.md.
	fs.writeFileSync(OUT_FILE, JSON.stringify(baselines, null, 2) + '\n');
	console.log(`wrote ${OUT_FILE}: ${fixtures.length} fixtures, ${totalPages} pages`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

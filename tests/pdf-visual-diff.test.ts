/**
 * Visual-diff regression test for `toPdf({ vectorInk: true })`.
 *
 * For every fixture that ships a device `.pdf` export, each page is rendered
 * three ways and measured against Supernote's own vector PDF export (ground
 * truth); the metrics are checked against committed baselines in
 * `tests/visual-diff-baselines.json`. CI fails on *drift* beyond tolerance,
 * not on absolute correctness — the values are measurements of the known-good
 * render, the way `--update` snapshots are.
 *
 * Three metrics (see `scripts/visual-diff.ts` for the full rationale):
 *   - `inkAreaRatio`   dark-ink pixel count of our SVG over the device's.
 *   - `iouSvgVsDevice` intersection-over-union of the two ink masks (spatial).
 *   - `pdfDiffFrac`    full-page pixel disagreement between our vectorInk PDF
 *                     and the device PDF (the one metric that rasterises the
 *                     actual library PDF and sees colour, incl. white ink).
 *
 * Requires `pdftoppm` (poppler-utils) on PATH. The CI workflow installs it;
 * locally run `apt-get install poppler-utils` (or your platform's equivalent).
 *
 * After an intentional rendering change, regenerate the baselines and commit
 * the diff:
 *
 *   npm run visual-diff:baseline
 */

import * as fs from 'fs-extra';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { listFixturesWithDevicePdf, computeMetrics, checkAgainstBaseline, type VisualDiffMetrics } from '../scripts/visual-diff';

const BASELINES = JSON.parse(fs.readFileSync('tests/visual-diff-baselines.json', 'utf8')) as Record<string, Record<string, VisualDiffMetrics>>;

// Top-level await: the describe blocks below need the fixture list, and
// vitest supports top-level await in test modules. This runs once at load.
const FIXTURES = await listFixturesWithDevicePdf();

describe('vectorInk PDF visual diff', () => {
	test('pdftoppm (poppler-utils) is installed', () => {
		// Fail loudly and early with a named package rather than an opaque
		// ENOENT deep inside rasterizePdf, so a missing CI dep is obvious.
		const r = spawnSync('pdftoppm', ['-v'], { stdio: 'pipe' });
		expect(r.error, 'pdftoppm not found — install poppler-utils').toBeUndefined();
	});

	test('baseline set covers every fixture page with a device export', () => {
		// Catches a fixture being added with a device PDF but no baseline being
		// regenerated — the new pages would silently be un-tested — and a
		// baseline lingering after its fixture was removed.
		for (const { name, pages } of FIXTURES) {
			const base = BASELINES[name];
			expect(base, `${name}: no baseline entry (run: npm run visual-diff:baseline)`).toBeDefined();
			for (let p = 1; p <= pages; p++) {
				expect(base[String(p)], `${name} page ${p}: no baseline`).toBeDefined();
			}
		}
		for (const fixture of Object.keys(BASELINES)) {
			expect(FIXTURES.some((f) => f.name === fixture), `${fixture}.pdf has a baseline but no fixture/device PDF`).toBe(true);
		}
	});

	for (const { name, pages } of FIXTURES) {
		describe(name, () => {
			for (let p = 1; p <= pages; p++) {
				// Concurrent so the per-page rendering (the suite's cost: each page
				// runs toPdf/toSvg, which each call toImage) overlaps across pages
				// instead of running strictly serially. `concurrent: true` keeps
				// each page's failure message isolated to that page.
				test.concurrent(`page ${p} matches baseline`, { timeout: 60000 }, async () => {
					const baseline = BASELINES[name]?.[String(p)];
					expect(baseline, `${name} page ${p}: missing baseline`).toBeDefined();
					const actual = await computeMetrics(`${name}.note`, p);
					const failures = checkAgainstBaseline(actual, baseline).filter((c) => !c.pass);
					if (failures.length > 0) {
						// One assertion listing every metric that drifted, so the
						// failure points at the regression, not just one metric.
						expect.fail(
							`${name} page ${p} regressed:\n` +
								failures.map((c) => `  - ${c.message}`).join('\n') +
								'\nIf this is an intentional rendering change, regenerate: `npm run visual-diff:baseline`',
						);
					}
				});
			}
		});
	}
});

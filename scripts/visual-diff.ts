/**
 * Visual-diff metrics for `toPdf({ vectorInk: true })`, used by
 * `tests/pdf-visual-diff.test.ts` to catch rendering regressions the
 * operator-level PDF tests cannot.
 *
 * For every fixture that ships a device `.pdf` export, each page is measured
 * three ways against ground truth (Supernote's own vector PDF export):
 *
 * 1. `inkAreaRatio` — dark-ink pixel count of the library's vector-ink SVG
 *    over the device's, both rasterised ink-only. Deterministic and
 *    renderer-independent in shape; catches a whole stroke going missing or
 *    a width doubling. (Pure-white eraser overlays are excluded by the
 *    dark-ink threshold, the same convention `build-fixture-site.ts`'s
 *    `svgInkArea` uses.)
 * 2. `iouSvgVsDevice` — intersection-over-union of the two ink masks. A
 *    spatial metric, sensitive to *where* the ink lands: a hatched fill
 *    drawn over nearby ink, an extra contour on a partial erase, or a stroke
 *    shifted all drop IoU even when total area barely moves.
 * 3. `pdfDiffFrac` / `pdfMae` — rasterise the library's `toPdf({vectorInk:
 *    true})` page and the device PDF page to PNGs (via `pdftoppm`) and
 *    compare full pages. Both share the same page template as their
 *    background, so the template cancels at the >40-grey-level band the diff
 *    counts; what is left is ink the two sides disagree on. This is the one
 *    metric that rasterises the actual library PDF (so it sees pdf-lib's
 *    filled-contour / stroked-centreline / hatched-rect drawing, not just the
 *    shared `vector-ink.ts` pipeline) and the only one that sees *colour*,
 *    which is what catches a white-ink cover-up the dark-ink masks above are
 *    blind to.
 *
 * Metric values are not targets — they are measurements of the known-good
 * render, recorded in `tests/visual-diff-baselines.json` so CI fails on
 * *drift*, not on absolute correctness. This is the same posture
 * `build-fixture-site.ts`'s ink-area ratio takes (reported, not asserted),
 * except here a regression fails CI.
 *
 * Build tooling, not shipped: lives under `scripts/` and is compiled by
 * `tsconfig.scripts.json`. Needs `pdftoppm` (poppler-utils) on PATH and
 * `@resvg/resvg-js` (devDependency) for SVG rasterisation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { decode } from 'image-js';
import { Resvg } from '@resvg/resvg-js';
import { SupernoteX } from '../src/parsing.js';
import { toSvg } from '../src/svg.js';
import { toPdf } from '../src/pdf.js';
import { extractPageForms, pdfPageToSvg, devicePageToSvgDocument } from './pdf-vector.js';

const INPUT_DIR = 'tests/input';

/** A pixel value below this is "ink" (dark) on the ink-only rasters. Pure
 * white (254, the white-pen cover-up colour) is deliberately above it, so
 * white cover-ups are not counted as ink — matching `build-fixture-site.ts`'s
 * `svgInkArea`, which skips `rgb(255,255,255)` for the same reason. */
const INK_GREY_THRESHOLD = 200;
/** Two full-page pixels this many grey levels apart count as a disagreement.
 * Chosen (measured on the fixtures) to sit above the template-background
 * compression noise between our decode and the device's embedded image, so
 * the template cancels, and below real ink-edge differences, so ink the two
 * sides disagree on registers. */
const PAGE_DIFF_THRESHOLD = 40;

export interface VisualDiffMetrics {
	/** Library SVG dark-ink pixel count divided by the device's. `null` when
	 * the device draws no ink on the page — then `ourInkPixels`/`deviceInkPixels`
	 * are what the test checks, not the ratio. */
	inkAreaRatio: number | null;
	/** IoU of the library-SVG ink mask and the device ink mask, in [0,1].
	 * Returns 1 when both masks are empty (both sides agree the page is
	 * blank). */
	iouSvgVsDevice: number;
	/** Fraction of full-page pixels where the library PDF and device PDF
	 * differ by more than `PAGE_DIFF_THRESHOLD` grey levels. */
	pdfDiffFrac: number;
	/** Mean absolute grey-level difference over the full page. Recorded as
	 * a sanity number; the test asserts `pdfDiffFrac`, not this. */
	pdfMae: number;
	/** Dark-ink pixel count the library SVG laid down. */
	ourInkPixels: number;
	/** Dark-ink pixel count the device PDF laid down. */
	deviceInkPixels: number;
}

export interface FixturePageKey {
	/** Fixture name without extension, e.g. `ink-a5x-2.14.28-old-pen-width`. */
	fixture: string;
	pageNumber: number;
}

/** Every fixture in `tests/input` that ships a same-stem `.pdf` device export,
 * with its page count. Derived the same way `build-fixture-site.ts:buildFixture`
 * derives its set, so adding a fixture with a device export adds a visual-diff
 * case automatically. */
export async function listFixturesWithDevicePdf(inputDir: string = INPUT_DIR): Promise<{ name: string; pages: number }[]> {
	const files = (await fs.promises.readdir(inputDir)).filter((f) => f.endsWith('.note')).sort();
	const out: { name: string; pages: number }[] = [];
	for (const file of files) {
		const name = file.replace(/\.note$/, '');
		try {
			await fs.promises.access(path.join(inputDir, `${name}.pdf`));
		} catch {
			continue;
		}
		const note = new SupernoteX(new Uint8Array(await fs.promises.readFile(path.join(inputDir, file))));
		out.push({ name, pages: note.pages.length });
	}
	return out;
}

/** The red channel as a `Float32Array` of length `width*height`. Using a single
 * channel (rather than `image.grey()`) keeps the library-PDF render (RGB) and
 * the resvg/`toImage` renders (RGBA) comparable — `grey()` weights channels
 * differently for 3- vs 4-channel images, which would make two renders of the
 * same page read as different everywhere. Red is fine: ink is dark in every
 * channel and the page template is near-white. */
type DecodedImage = { width: number; height: number; channels: number; data: Uint8Array | Uint8ClampedArray; resize: (opts: { width: number; height: number }) => DecodedImage };

function redPlane(img: DecodedImage): Float32Array {
	const n = img.width * img.height;
	const out = new Float32Array(n);
	const ch = img.channels;
	for (let i = 0; i < n; i++) out[i] = img.data[i * ch];
	return out;
}

function rasterizePdf(pdfPath: string, dpi: number, outPrefix: string): DecodedImage {
	const res = spawnSync('pdftoppm', ['-png', '-r', String(dpi), '-f', '1', '-l', '1', pdfPath, outPrefix], { stdio: 'pipe' });
	if (res.status !== 0) {
		const hint = res.error?.message?.includes('ENOENT') ? ' (is poppler-utils / pdftoppm installed?)' : '';
		throw new Error(`pdftoppm failed for ${path.basename(pdfPath)}: ${(res.stderr ?? '').toString().trim()}${hint}`);
	}
	return decode(fs.readFileSync(`${outPrefix}-1.png`)) as unknown as DecodedImage;
}

function rasterizeSvgInkOnly(svg: string, width: number): DecodedImage {
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white' }).render().asPng();
	return decode(Buffer.from(png)) as unknown as DecodedImage;
}

/** Downsample to a canonical width, preserving aspect ratio. All four
 * rasters share the page's aspect ratio, so they all land on the same
 * `targetWidth x targetHeight` grid without any per-source resampling arg. */
function resizeToWidth(img: DecodedImage, targetWidth: number | undefined): DecodedImage {
	if (targetWidth === undefined || img.width === targetWidth) return img;
	const targetHeight = Math.round((targetWidth * img.height) / img.width);
	return img.resize({ width: targetWidth, height: targetHeight });
}

function inkMask(plane: Float32Array, threshold = INK_GREY_THRESHOLD): Uint8Array {
	const mask = new Uint8Array(plane.length);
	for (let i = 0; i < plane.length; i++) if (plane[i] < threshold) mask[i] = 1;
	return mask;
}

function maskArea(mask: Uint8Array): number {
	let c = 0;
	for (const v of mask) c += v;
	return c;
}

function iou(a: Uint8Array, b: Uint8Array): number {
	let inter = 0;
	let uni = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x || y) {
			uni++;
			if (x && y) inter++;
		}
	}
	return uni ? inter / uni : 1; // both empty => both agree the page is blank
}

function pageDiffStats(a: Float32Array, b: Float32Array, threshold = PAGE_DIFF_THRESHOLD): { diffFrac: number; mae: number } {
	const n = a.length;
	let over = 0;
	let mae = 0;
	for (let i = 0; i < n; i++) {
		const d = Math.abs(a[i] - b[i]);
		if (d > threshold) over++;
		mae += d;
	}
	return { diffFrac: over / n, mae: mae / n };
}

/** Strip the rasterized page background from a vectorInk SVG so only ink is
 * left — the same `inkOnly()` transform `build-fixture-site.ts` uses, so the
 * ink-only rasters here compare like-for-like with that site. */
function inkOnlySvg(svg: string): string {
	return svg.replace(/<image\b[^>]*\/>/g, '');
}

export interface ComputeMetricsOptions {
	/** DPI passed to `toPdf`; the library PDF is rasterised at this DPI so its
	 * pixels come out at `pageWidth x pageHeight`. Defaults to 300 (`toPdf`'s
	 * own default). */
	dpi?: number;
	/** Directory for intermediate PNG/PDF files. Defaults to a fresh temp
	 * dir created and removed per call. */
	workDir?: string;
	/** Canonical width all four rasters are downsampled to before the masks
	 * and diffs are computed. Omit (or pass `undefined`) to keep each raster at
	 * its native `pageWidth x pageHeight` -- the default, since the suite's
	 * cost is in rendering (`toPdf`/`toSvg` each call `toImage`), not in the
	 * pixel math, so downsampling did not pay off. Pass a smaller width only
	 * to trade a little metric sharpness for cheaper local iteration. */
	targetWidth?: number;
}

/**
 * Compute the visual-diff metrics for one fixture page.
 *
 * Rasterises four things: the library `toPdf({vectorInk:true})` page, the
 * device PDF page (both via `pdftoppm`), the device's vector ink (via
 * `pdf-vector.ts` -> resvg), and the library's vector-ink SVG ink-only (via
 * resvg). All four land on the `pageWidth x pageHeight` pixel grid, so the
 * masks and diffs are aligned without any resampling.
 */
export async function computeMetrics(noteFile: string, pageNumber: number, options: ComputeMetricsOptions = {}): Promise<VisualDiffMetrics> {
	const dpi = options.dpi ?? 300;
	const targetWidth = options.targetWidth; // undefined => native, no resize
	const notePath = path.isAbsolute(noteFile) ? noteFile : path.join(INPUT_DIR, noteFile);
	const noteName = path.basename(notePath, '.note');
	const devicePdfPath = path.join(path.dirname(notePath), `${noteName}.pdf`);

	const sn = new SupernoteX(new Uint8Array(fs.readFileSync(notePath)));
	const W = sn.pageWidth;
	const H = sn.pageHeight;

	const ownsWorkDir = !options.workDir;
	const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'supernote-visualdiff-'));
	try {
		// 1. Library vector-ink PDF, rasterised.
		const ourPdfBytes = await toPdf(sn, { vectorInk: true, pageNumbers: [pageNumber], dpi });
		const ourPdfPath = path.join(workDir, 'our.pdf');
		fs.writeFileSync(ourPdfPath, ourPdfBytes);
		const libPdfPlane = redPlane(resizeToWidth(rasterizePdf(ourPdfPath, dpi, path.join(workDir, 'our')), targetWidth));

		// 2. Device PDF, rasterised at 72 DPI (its MediaBox is in page pixels, so
		//    72 DPI yields exactly pageWidth x pageHeight), then downsampled to
		//    the same canonical width as the others.
		const devPlane = redPlane(resizeToWidth(rasterizePdf(devicePdfPath, 72, path.join(workDir, 'dev')), targetWidth));

		// 3. Device vector ink only: extract the Form-XObject ink the device's
		//    PDF carries and rasterise it over white. Rasterise at the full page
		//    width then downsample so the ink edges anti-alias the same way the
		//    full-page rasters do.
		const forms = extractPageForms(fs.readFileSync(devicePdfPath));
		const devInkSvg = devicePageToSvgDocument(pdfPageToSvg(forms[pageNumber - 1] ?? [], H), W, H);
		const devInkPlane = redPlane(resizeToWidth(rasterizeSvgInkOnly(devInkSvg, W), targetWidth));

		// 4. Library vector-ink SVG, ink only, rasterised over white.
		const [ourSvgFull] = await toSvg(sn, { vectorInk: true, includeText: false, pageNumbers: [pageNumber] });
		const ourInkPlane = redPlane(resizeToWidth(rasterizeSvgInkOnly(inkOnlySvg(ourSvgFull), W), targetWidth));

		const devInkMask = inkMask(devInkPlane);
		const ourInkMask = inkMask(ourInkPlane);
		const deviceInkPixels = maskArea(devInkMask);
		const ourInkPixels = maskArea(ourInkMask);

		const pd = pageDiffStats(libPdfPlane, devPlane);
		return {
			inkAreaRatio: deviceInkPixels > 0 ? ourInkPixels / deviceInkPixels : null,
			iouSvgVsDevice: iou(ourInkMask, devInkMask),
			pdfDiffFrac: pd.diffFrac,
			pdfMae: pd.mae,
			ourInkPixels,
			deviceInkPixels,
		};
	} finally {
		if (ownsWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
	}
}

/** Tolerance applied to each metric by the test. Wide enough to absorb
 * poppler/resvg point-release anti-aliasing drift, tight enough that a single
 * whole stroke going missing, a width doubling, or a hatched fill landing on
 * ink trips it. Tuned from the measured per-fixture baselines. */
export interface VisualDiffTolerance {
	inkAreaRatio: number; // absolute band, applied only when device has ink
	iouSvgVsDevice: number; // absolute band
	pdfDiffFracRelative: number; // e.g. 0.15 => +/-15% of baseline
	pdfDiffFracAbsolute: number; // floor added to the relative band for tiny baselines
	blankInkPixelFloor: number; // a "blank" device page must keep our ink below this
}

export const DEFAULT_TOLERANCE: VisualDiffTolerance = {
	inkAreaRatio: 0.08,
	iouSvgVsDevice: 0.03,
	pdfDiffFracRelative: 0.15,
	pdfDiffFracAbsolute: 0.003,
	blankInkPixelFloor: 500,
};

/** One baseline's pass/fail verdict, with the value that crossed for the
 * failure message. */
export interface MetricCheck {
	metric: string;
	baseline: number | null;
	actual: number | null;
	pass: boolean;
	message: string;
}

/** Compare a measured page against its recorded baseline. Pure (no I/O) so
 * the test can call it directly. */
export function checkAgainstBaseline(actual: VisualDiffMetrics, baseline: VisualDiffMetrics, tol: VisualDiffTolerance = DEFAULT_TOLERANCE): MetricCheck[] {
	const checks: MetricCheck[] = [];
	const add = (metric: string, pass: boolean, message: string) => checks.push({ metric, baseline: null, actual: null, pass, message });

	if (baseline.deviceInkPixels < tol.blankInkPixelFloor) {
		// The device draws ~nothing on this page. The right assertion is that
		// we also draw ~nothing (no phantom ink), not an area ratio.
		const pass = actual.ourInkPixels < tol.blankInkPixelFloor;
		checks.push({
			metric: 'ourInkPixels',
			baseline: baseline.ourInkPixels,
			actual: actual.ourInkPixels,
			pass,
			message: `device draws no ink; expected ourInkPixels < ${tol.blankInkPixelFloor}, got ${actual.ourInkPixels}`,
		});
	} else {
		const ar = actual.inkAreaRatio;
		const bar = baseline.inkAreaRatio;
		if (ar === null) {
			add('inkAreaRatio', false, `device has ink but our inkAreaRatio is null`);
		} else if (bar === null) {
			add('inkAreaRatio', false, `baseline inkAreaRatio is null but device now has ${baseline.deviceInkPixels} ink px`);
		} else {
			const pass = Math.abs(ar - bar) <= tol.inkAreaRatio;
			checks.push({
				metric: 'inkAreaRatio',
				baseline: bar,
				actual: ar,
				pass,
				message: `inkAreaRatio ${ar.toFixed(3)} vs baseline ${bar.toFixed(3)} (±${tol.inkAreaRatio})`,
			});
		}
	}

	const iouPass = Math.abs(actual.iouSvgVsDevice - baseline.iouSvgVsDevice) <= tol.iouSvgVsDevice;
	checks.push({
		metric: 'iouSvgVsDevice',
		baseline: baseline.iouSvgVsDevice,
		actual: actual.iouSvgVsDevice,
		pass: iouPass,
		message: `iouSvgVsDevice ${actual.iouSvgVsDevice.toFixed(3)} vs baseline ${baseline.iouSvgVsDevice.toFixed(3)} (±${tol.iouSvgVsDevice})`,
	});

	const band = Math.max(baseline.pdfDiffFrac * tol.pdfDiffFracRelative, tol.pdfDiffFracAbsolute);
	const pdfPass = Math.abs(actual.pdfDiffFrac - baseline.pdfDiffFrac) <= band;
	checks.push({
		metric: 'pdfDiffFrac',
		baseline: baseline.pdfDiffFrac,
		actual: actual.pdfDiffFrac,
		pass: pdfPass,
		message: `pdfDiffFrac ${actual.pdfDiffFrac.toFixed(4)} vs baseline ${baseline.pdfDiffFrac.toFixed(4)} (±${band.toFixed(4)})`,
	});

	return checks;
}

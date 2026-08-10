import { Image, encodePng } from 'image-js';
import { toImage, RattaRLEDecoder, IPdfPage } from './conversion.js';
import { recognitionCoordinateScale } from './pdf.js';
import { ISupernote, IPage, ILayerNames } from './format.js';
import { parseStrokes, IStroke } from './strokes.js';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encodes `bytes` without `Buffer` (Node-only) or `btoa`
 * (call-stack-limited on large inputs), so it works the same in Node and
 * the browser at the size of a full-page PNG. */
function encodeBase64(bytes: Uint8Array): string {
	const chars: string[] = [];
	const len = bytes.length;
	for (let i = 0; i < len; i += 3) {
		const b0 = bytes[i];
		const hasB1 = i + 1 < len;
		const hasB2 = i + 2 < len;
		const b1 = hasB1 ? bytes[i + 1] : 0;
		const b2 = hasB2 ? bytes[i + 2] : 0;

		chars.push(BASE64_CHARS[b0 >> 2]);
		chars.push(BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]);
		chars.push(hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=');
		chars.push(hasB2 ? BASE64_CHARS[b2 & 0x3f] : '=');
	}
	return chars.join('');
}

const XML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;',
};

function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

/** Builds one invisible, positioned `<text>` element per recognized word, so
 * the word can be found/selected/copied in an SVG viewer despite the ink
 * itself being part of the rasterized `<image>` beneath it. Mirrors
 * `drawRecognitionText` in pdf.ts, adapted to SVG: SVG's y-axis already runs
 * top-down like the recognition boxes (no PDF-style flip needed), and SVG's
 * own `textLength`/`lengthAdjust` attributes do the stretch-to-fit-the-box
 * scaling natively instead of needing a manually computed horizontal-scale
 * percentage. */
function buildRecognitionTextElements(page: IPdfPage, pageWidth: number): string {
	const scale = recognitionCoordinateScale(pageWidth);
	const elements: string[] = [];
	for (const element of page.recognitionElements) {
		if (element.type !== 'Text') continue;

		for (const word of element.words) {
			const box = word['bounding-box'];
			if (!box) continue;

			const label = decodeURIComponent(escape(word.label));
			if (!label) continue;

			const x = box.x * scale;
			const y = box.y * scale;
			const width = box.width * scale;
			const height = box.height * scale;
			// SVG positions text by its baseline, not a bounding-box corner;
			// anchoring at the box's bottom edge approximates the baseline
			// closely enough for search/selection (exact glyph metrics aren't
			// available, and this isn't rendered visibly anyway).
			const baselineY = y + height;

			elements.push(
				`<text x="${x}" y="${baselineY}" font-size="${height}" textLength="${width}" ` +
					`lengthAdjust="spacingAndGlyphs" fill="transparent">${escapeXml(label)}</text>`,
			);
		}
	}
	return elements.join('');
}

/** Default width, in the same pixel units as the SVG's `viewBox`, for
 * `<path>` elements built from `AddSvgPageOptions.strokes`. Pen pressure/
 * width isn't decoded yet (see `parseStrokes`), so every stroke currently
 * renders at this one fixed width regardless of how it was actually drawn. */
const DEFAULT_STROKE_WIDTH = 3;

function buildStrokePathElements(strokes: IStroke[], strokeWidth: number): string {
	return strokes
		.filter((stroke) => stroke.points.length > 0)
		.map((stroke) => {
			const d = stroke.points
				.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
				.join(' ');
			return `<path d="${d}" fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
		})
		.join('');
}

export interface AddSvgPageOptions {
	/** Assumed pixel density of the source page raster, used to size the SVG
	 * in physical units (inches) via its `width`/`height` attributes; the
	 * `viewBox` (and so the coordinate space `image`/text sit in) always
	 * stays in raw pixels regardless. Omit to size the SVG in pixels too. */
	dpi?: number;
	/** Whether to overlay the recognized handwriting (RTR) text invisibly, as
	 * `addPdfPage` does for PDF output. Default true. */
	includeText?: boolean;
	/** Pen strokes to draw as real vector `<path>` elements on top of
	 * `image`, instead of relying on `image` for ink -- see
	 * `ToSvgOptions.vectorInk`. Coordinates must already be in the same
	 * pixel space as `pageWidth`/`pageHeight` (`parseStrokes`'s output is).
	 * Omit (or pass `[]`) to render `image` as the only source of ink. */
	strokes?: IStroke[];
	/** Width of each `<path>` built from `strokes`, in `viewBox` pixels.
	 * Default `DEFAULT_STROKE_WIDTH`; scale it along with `upscale` if
	 * rendering strokes onto an upscaled raster. */
	strokeWidth?: number;
}

/**
 * Builds one standalone SVG document for a page: the rasterized image
 * embedded as a base64 data URI, with the recognized handwriting (RTR) text
 * drawn invisibly on top at the position it was written, so the word can be
 * found/selected/copied in an SVG viewer that supports text search (e.g. a
 * browser).
 *
 * `image` may be an `image-js` `Image` (e.g. straight from `toImage`) or
 * already-PNG-encoded bytes (e.g. from a Worker that already called
 * `toImage` + `encodePng` off-main-thread). Unlike `addPdfPage`, this
 * doesn't touch any non-structured-clone-safe objects, so — one more
 * difference from the PDF path — it can run inside a Worker too, not just on
 * the main thread.
 */
export function addSvgPage(
	page: IPdfPage,
	image: Image | Uint8Array,
	pageWidth: number,
	pageHeight: number,
	options: AddSvgPageOptions = {},
): string {
	const { dpi, includeText = true, strokes, strokeWidth = DEFAULT_STROKE_WIDTH } = options;

	const pngBytes = image instanceof Uint8Array ? image : encodePng(image);
	const base64 = encodeBase64(pngBytes);

	const widthAttr = dpi ? `${pageWidth / dpi}in` : `${pageWidth}`;
	const heightAttr = dpi ? `${pageHeight / dpi}in` : `${pageHeight}`;

	const textElements = includeText ? buildRecognitionTextElements(page, pageWidth) : '';
	const strokeElements = strokes && strokes.length ? buildStrokePathElements(strokes, strokeWidth) : '';

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
		`width="${widthAttr}" height="${heightAttr}" viewBox="0 0 ${pageWidth} ${pageHeight}">` +
		`<image x="0" y="0" width="${pageWidth}" height="${pageHeight}" xlink:href="data:image/png;base64,${base64}"/>` +
		strokeElements +
		textElements +
		`</svg>`
	);
}

export interface ToSvgOptions {
	/** Page numbers to export (1-indexed). Defaults to all pages. */
	pageNumbers?: number[];
	/** See `AddSvgPageOptions.dpi`. */
	dpi?: number;
	/** See `AddSvgPageOptions.includeText`. */
	includeText?: boolean;
	/** See `ToImageOptions.upscale`. The resulting SVG's pixel `viewBox` (and
	 * so the recognized-text overlay's coordinate space, via
	 * `recognitionCoordinateScale`) scales up right along with the embedded
	 * raster - both are sized off the actual produced image, not off
	 * `note.pageWidth`/`pageHeight`, so text stays aligned to the ink at any
	 * upscale factor. When `dpi` is also set, it's scaled by the same factor
	 * so the physical `width`/`height` (inches) stay put - `upscale` raises
	 * pixel density for a sharper render at the same physical size (like a
	 * "retina" image), it doesn't enlarge the page. */
	upscale?: number;
	/** Render each page's pen strokes as real vector `<path>` elements
	 * decoded from its `TOTALPATH` data, instead of leaving ink to the
	 * rasterized image -- crisp at any zoom, instead of the fixed-resolution
	 * bitmap `toSvg` otherwise embeds. See `parseStrokes` for what this can
	 * and can't decode yet (pressure/width isn't decoded, so every stroke
	 * currently renders at one fixed width).
	 *
	 * Applied per page, not globally: a page whose strokes decode
	 * successfully gets its bitmap ink layers (MAINLAYER/LAYER1-3) left out
	 * of the raster and replaced with vector paths; a page that doesn't
	 * decode (e.g. genuinely blank, or a stroke encoding this decoder
	 * doesn't recognize) keeps its normal rasterized ink instead, rather
	 * than silently rendering blank. Background layers (templates, PDF
	 * style) are always rasterized either way, since they aren't stored as
	 * vector data. Default false. */
	vectorInk?: boolean;
}

/** Returns `page` with its ink layers (MAINLAYER, LAYER1-3) cleared so
 * `toImage` rasterizes only the background layer (BGLAYER: template lines,
 * PDF style, etc.) -- used by `toSvg`'s `vectorInk` option to avoid drawing
 * ink twice once it's been decoded as vector paths instead. */
function withoutInkLayers(page: IPage): IPage {
	return {
		...page,
		MAINLAYER: { ...page.MAINLAYER, bitmapBuffer: null },
		LAYER1: { ...page.LAYER1, bitmapBuffer: null },
		LAYER2: { ...page.LAYER2, bitmapBuffer: null },
		LAYER3: { ...page.LAYER3, bitmapBuffer: null },
	};
}

const INK_LAYER_NAMES: ILayerNames[] = ['MAINLAYER', 'LAYER1', 'LAYER2', 'LAYER3'];
/** Below this fraction of a page's actual rendered ink pixels landing near a
 * decoded stroke point, `toSvg`'s `vectorInk` option keeps that page's
 * rasterized ink rather than replacing it -- see `estimateInkCoverage`. */
const MIN_INK_COVERAGE_TO_REPLACE_RASTER = 0.85;
/** Starting point (and floor) for `estimateInkCoverage`'s per-point coverage
 * radius search: never check a band narrower than this even on a page whose
 * ink turns out to need no growing at all, since a too-tight radius
 * false-flags even a perfect decode as low-coverage over ordinary
 * rendering/rounding noise. */
const MIN_INK_COVERAGE_RADIUS = 3;
/** Upper bound on how far `estimateInkCoverage`'s radius search grows --
 * about 3% of a typical page's shorter dimension, comfortably bigger than
 * any real pen width observed so far but nowhere near big enough for a
 * *genuinely* incomplete decode (ink with no nearby stroke at all, however
 * far the search grows) to be mistaken for a complete one. */
const MAX_INK_COVERAGE_RADIUS = 40;
/** Step size, in pixels, `estimateInkCoverage`'s radius search grows by. */
const INK_COVERAGE_RADIUS_STEP = 2;
/** `estimateInkCoverage`'s radius search stops growing once a step gains
 * less than this much additional coverage, on the theory that once growth
 * stops paying off it's re-covering the same already-explained ink rather
 * than finding new real ink near a stroke that was just being measured too
 * tightly. */
const MIN_INK_COVERAGE_GAIN_PER_STEP = 0.01;

/** Marks every pixel within `radius` of each of `strokes`' decoded points
 * (and along the line between consecutive points, so fast pen movement
 * that samples sparsely doesn't leave gaps) as "explained", then returns
 * what fraction of `isInk`'s `inkPixelCount` pixels that covers. */
function coverageAtRadius(
	strokes: IStroke[],
	pageWidth: number,
	pageHeight: number,
	radius: number,
	isInk: Uint8Array,
	inkPixelCount: number,
): number {
	const explained = new Uint8Array(pageWidth * pageHeight);
	const markDisk = (cx: number, cy: number) => {
		for (let y = Math.max(0, cy - radius); y <= Math.min(pageHeight - 1, cy + radius); y++) {
			const rowStart = y * pageWidth;
			const xStart = Math.max(0, cx - radius);
			const xEnd = Math.min(pageWidth - 1, cx + radius);
			explained.fill(1, rowStart + xStart, rowStart + xEnd + 1);
		}
	};
	for (const stroke of strokes) {
		for (let i = 0; i < stroke.points.length; i++) {
			const point = stroke.points[i];
			markDisk(Math.round(point.x), Math.round(point.y));
			if (i === 0) continue;
			const prev = stroke.points[i - 1];
			const dx = point.x - prev.x;
			const dy = point.y - prev.y;
			const steps = Math.ceil(Math.hypot(dx, dy) / radius);
			for (let s = 1; s < steps; s++) {
				const t = s / steps;
				markDisk(Math.round(prev.x + dx * t), Math.round(prev.y + dy * t));
			}
		}
	}

	let explainedInkPixelCount = 0;
	for (let p = 0; p < isInk.length; p++) {
		if (isInk[p] && explained[p]) explainedInkPixelCount++;
	}
	return explainedInkPixelCount / inkPixelCount;
}

/**
 * Estimates what fraction of `page`'s actually-rendered ink (from its RLE
 * bitmap layers) sits near one of `strokes`' decoded points, as a proxy for
 * "how much of this page's real handwriting would go missing if its
 * rasterized ink were discarded in favor of `strokes`". `parseStrokes` only
 * decodes a subset of the coordinate encodings real strokes can use (see
 * its doc comment), so a page can have some strokes decode correctly while
 * others silently don't -- comparing against the page's own rendered ink,
 * rather than trusting `strokes` to be complete just because it's
 * non-empty, is what catches that case.
 *
 * The per-point coverage radius is found by growing it from
 * `MIN_INK_COVERAGE_RADIUS` while doing so keeps meaningfully increasing
 * coverage, rather than estimating it once from the page's overall ink
 * density (total ink area / total decoded path length ~ average stroke
 * width). That density estimate reads low on pages with a lot of
 * self-overlapping ink -- dense cursive, retraced letters -- because
 * overlapping ink doesn't add new pixels to the area term, so the same
 * total path length appears to explain more area than any single pass of
 * the pen actually covers, even though the true per-point radius needed is
 * no different than a sparser page's (confirmed across multiple real
 * fixtures: growing the radius recovers the "missing" coverage almost
 * entirely). Searching directly against the actual rendered ink instead
 * sidesteps that bias, and can't produce a false sense of completeness: it
 * only ever recovers ink that's genuinely near a correctly-placed stroke,
 * never ink that has no nearby stroke at all, so a genuinely incomplete
 * decode still reads as incomplete regardless of how far the radius grows
 * (verified by re-running this search with half a known-complete page's
 * strokes withheld). See
 * https://github.com/philips/supernote-typescript/issues/56.
 *
 * Returns a number in `[0, 1]`; `1` both when coverage is perfect and when
 * the page has no rendered ink at all (nothing to lose either way).
 */
function estimateInkCoverage(page: IPage, strokes: IStroke[], pageWidth: number, pageHeight: number): number {
	if (strokes.length === 0) return 0;

	const inkLayers = INK_LAYER_NAMES.map((name) => page[name]).filter(
		(layer) => layer.bitmapBuffer && layer.bitmapBuffer.length,
	);
	if (inkLayers.length === 0) return 1;

	const decoder = new RattaRLEDecoder();
	const isInk = new Uint8Array(pageWidth * pageHeight);
	let inkPixelCount = 0;
	for (const layer of inkLayers) {
		const pixels = decoder.decode(layer.bitmapBuffer as Uint8Array, pageWidth, pageHeight);
		for (let i = 0, p = 0; p < isInk.length; i += 4, p++) {
			if (isInk[p]) continue;
			if (pixels[i + 3] > 0 && pixels[i] < 250) {
				isInk[p] = 1;
				inkPixelCount++;
			}
		}
	}
	if (inkPixelCount === 0) return 1;

	let radius = MIN_INK_COVERAGE_RADIUS;
	let coverage = coverageAtRadius(strokes, pageWidth, pageHeight, radius, isInk, inkPixelCount);
	while (radius < MAX_INK_COVERAGE_RADIUS && coverage < 1) {
		const nextRadius = radius + INK_COVERAGE_RADIUS_STEP;
		const nextCoverage = coverageAtRadius(strokes, pageWidth, pageHeight, nextRadius, isInk, inkPixelCount);
		if (nextCoverage - coverage < MIN_INK_COVERAGE_GAIN_PER_STEP) break;
		radius = nextRadius;
		coverage = nextCoverage;
	}
	return coverage;
}

/**
 * Render a Supernote note to one SVG document per page, each showing the
 * rasterized page image with the recognized handwriting (RTR) text drawn
 * invisibly on top of it, at the position it was written, so the text can be
 * found/selected/copied in an SVG viewer.
 *
 * SVG has no native multi-page container, so this returns one SVG string per
 * page rather than a single document — pair each with its page number for
 * filenames, e.g. `notebook-page-1.svg`.
 *
 * Convenience wrapper around `toImage` + `addSvgPage`, all run on the
 * current thread. To render pages in parallel across Workers, call
 * `extractPdfPageData` + `toImage` + `encodePng` + `addSvgPage` in each
 * Worker instead — see the README's PDF section for the equivalent
 * `extractPdfPageData` pattern (SVG's own `addSvgPage` step can join the
 * others inside the Worker, since none of it needs the main thread).
 */
export async function toSvg(note: ISupernote, options: ToSvgOptions = {}): Promise<string[]> {
	const { pageNumbers, dpi, includeText, upscale = 1, vectorInk = false } = options;
	const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;

	// parseStrokes' transform is linear in pageWidth/pageHeight, so decoding
	// directly against the upscaled dimensions lands points in the same
	// coordinate space toImage's upscaled raster (and so images[i].width/
	// height below) uses, without a separate scaling pass.
	const strokesPerPage = vectorInk
		? pages.map((page) => parseStrokes(page.totalPathBuffer, note.pageWidth * upscale, note.pageHeight * upscale))
		: pages.map((): IStroke[] => []);

	// A page decoding *some* strokes doesn't mean it decoded all of them
	// (see parseStrokes' doc comment on the coordinate encodings it can't
	// read yet) -- estimateInkCoverage compares against this page's own
	// rendered ink (at native resolution; coverage is scale-independent) to
	// tell "fully decoded, safe to replace the raster" apart from
	// "partially decoded, replacing the raster would drop real ink".
	const decodedPageNumbers = vectorInk
		? new Set(
				pages
					.map((page, i) => {
						const nativeStrokes = parseStrokes(page.totalPathBuffer, note.pageWidth, note.pageHeight);
						const coverage = estimateInkCoverage(page, nativeStrokes, note.pageWidth, note.pageHeight);
						const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
						return coverage >= MIN_INK_COVERAGE_TO_REPLACE_RASTER ? pageNumber : -1;
					})
					.filter((pageNumber) => pageNumber !== -1),
			)
		: new Set<number>();
	const renderNote: ISupernote = vectorInk
		? {
				...note,
				pages: note.pages.map((page, i) => (decodedPageNumbers.has(i + 1) ? withoutInkLayers(page) : page)),
			}
		: note;
	const images = await toImage(renderNote, pageNumbers, { upscale });

	// Scale dpi along with the raster so widthAttr/heightAttr (pageWidth /
	// dpi) come out the same physical size regardless of upscale - see
	// ToSvgOptions.upscale's doc comment.
	const effectiveDpi = dpi ? dpi * upscale : dpi;

	return pages.map((page, i) => {
		const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
		// Only pages whose raster ink was actually replaced (decodedPageNumbers)
		// need the vector paths drawn -- for any other page, the kept raster
		// already carries its ink, and adding (partial, by definition here)
		// paths on top would just bloat the SVG for no visible difference.
		const strokes = decodedPageNumbers.has(pageNumber) ? strokesPerPage[i] : undefined;
		return addSvgPage(page, images[i], images[i].width, images[i].height, {
			dpi: effectiveDpi,
			includeText,
			strokes,
			strokeWidth: DEFAULT_STROKE_WIDTH * upscale,
		});
	});
}

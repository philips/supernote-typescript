import { Image, encodePng } from 'image-js';
import { toImage, RattaRLEDecoder, IPdfPage } from './conversion.js';
import { recognitionCoordinateScale } from './pdf.js';
import { ISupernote, IPage, ILayerNames } from './format.js';
import { parseStrokes, IStroke, IStrokePoint } from './strokes.js';

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

/** How to render one decoded stroke -- see `deriveStrokeStyle`. For a
 * `'path'`, `color`/`width`/`tier` come directly from the stroke's own real
 * `TOTALPATH` metadata (`IStroke.color`/`thickness`/`pen`), not sampled from
 * a raster -- see https://github.com/philips/supernote-typescript/issues/56
 * and https://github.com/Walnut356/snlib for how that metadata was found.
 *
 * `'rect'` is a distinct record shape TOTALPATH itself encodes, not a style
 * choice: a stroke decoded down to exactly two points is a filled
 * rectangle's opposite corners. Unlike `'path'`, a rect's own `color`/`pen`
 * fields are *not* meaningful (confirmed against a real fixture with four
 * differently-colored heading backgrounds on one page: every one of their
 * 2-point records reads the same, uninformative `color` regardless of the
 * background's real, visibly different color). For a Heading's rect (the
 * common case), the real color lives losslessly in the `.note` footer's own
 * `TITLE_*` metadata instead -- see `findMatchingTitleStyle` -- so
 * `deriveStrokeStyle` looks that up first. Only a 2-point rect with no
 * matching `TITLE_*` entry (badges/highlight boxes, which aren't Headings)
 * falls back to sampling the page's own rendered ink for color/fill, the way
 * every stroke's style used to be sampled before real per-stroke metadata
 * was found: checking what fraction of the rectangle's own bounding box is
 * already real ink separates a genuine rect (a solid background measures
 * ~97-99% filled, a diagonal cross-hatch background ~25% -- both confirmed
 * against Supernote's own "Heading" feature, see
 * https://support.supernote.com/1759244-using-titles-keywords-and-stars)
 * from a real but unrelated short 2-point ink stroke (measures ~0%, `'skip'`
 * so as to not draw a phantom diagonal line for it). `fill` records solid
 * vs. hatch so `buildRectElement` can draw the latter as an actual hatch
 * pattern instead of collapsing it to a solid block that would hide
 * anything drawn on top (confirmed on a real fixture: a hatched heading's
 * own black label text is the same color as the hatch, so a solid fill
 * hides it entirely).
 *
 * `'path'`'s `tier` is `'marker'` exactly when the stroke's own real `pen`
 * field says `'marker'` -- see `buildStrokePathElements` for what `tier`
 * actually changes. */
export type StrokeStyle =
	| { shape: 'path'; color: string; width: number; tier: 'marker' | 'pen' }
	| { shape: 'rect'; color: string; fill: 'solid' | 'hatch' }
	| { shape: 'skip' };

/** Deterministic, XML-id-safe name for the hatch `<pattern>` used by a given
 * color, e.g. `rgb(0,0,0)` -> `hatch-rgb-0-0-0-` -- shared by every hatched
 * rect of that color on the page, so only one `<pattern>` def is needed per
 * color rather than one per rect. */
function hatchPatternId(color: string): string {
	return `hatch-${color.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

/** A `<pattern>` def drawing diagonal stripes in `color` over a white
 * background, standing in for `StrokeStyle`'s `'hatch'` rect fill -- not a
 * pixel-accurate reproduction of Supernote's own cross-hatch (its exact
 * line spacing/angle isn't recoverable from the raster the way color is),
 * just something visibly non-solid that still reads as "hatched" and, unlike
 * a solid fill, leaves most of its area open for content drawn on top to
 * stay visible. */
function buildHatchPatternDef(color: string): string {
	const id = hatchPatternId(color);
	return (
		`<pattern id="${id}" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">` +
		`<rect width="10" height="10" fill="white"/>` +
		`<line x1="0" y1="0" x2="0" y2="10" stroke="${color}" stroke-width="5"/>` +
		`</pattern>`
	);
}

/** Builds a `<rect>` for a 'rect'-shaped stroke (see `StrokeStyle`'s doc
 * comment). */
function buildRectElement(stroke: IStroke, style: { color: string; fill: 'solid' | 'hatch' }): string {
	const [p0, p1] = stroke.points;
	const x = Math.min(p0.x, p1.x);
	const y = Math.min(p0.y, p1.y);
	const width = Math.abs(p1.x - p0.x);
	const height = Math.abs(p1.y - p0.y);
	const fill = style.fill === 'hatch' ? `url(#${hatchPatternId(style.color)})` : style.color;
	return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${fill}"/>`;
}

function buildPathElement(stroke: IStroke, style: { color: string; width: number }): string {
	const d = stroke.points
		.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
		.join(' ');
	return `<path d="${d}" fill="none" stroke="${style.color}" stroke-width="${style.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Builds every stroke's SVG element in three fixed tiers -- `'rect'`s,
 * then wide ("marker") `'path'`s, then narrow ("pen") `'path'`s -- instead
 * of strictly in `strokes`' order (i.e. TOTALPATH buffer order, which
 * doesn't reliably match how layered content was actually drawn). Confirmed
 * on real fixtures both ways: a badge's `'rect'` background record sits
 * *after* the digit stroke it's meant to sit behind, and a highlighter
 * pass's record can sit after the pen ink drawn over it too -- either way,
 * drawing in plain buffer order (SVG paints later elements on top) paints
 * the background/highlight over the ink and hides it. Sorting into these
 * tiers sidesteps needing to know the real chronological order at all: a
 * background fill or a wide highlighter mark is safe to draw before
 * narrower ink regardless of when it was actually drawn, since nothing
 * legitimately needs a highlighter mark drawn *over* the pen ink it's
 * highlighting. Relative order *within* each tier still follows
 * `strokes`. A stroke with no entry in `styles` (out-of-range index) is
 * skipped entirely, rather than falling back to a guessed color/width --
 * every stroke `parseStrokes` returns carries its own real style, so a
 * missing entry only happens from a caller-side index mismatch, not
 * anything `deriveStrokeStyle` itself produces. */
function buildStrokePathElements(strokes: IStroke[], styles: StrokeStyle[] | undefined): { defs: string; elements: string } {
	const rectElements: string[] = [];
	const markerElements: string[] = [];
	const penElements: string[] = [];
	const hatchColors = new Set<string>();

	strokes.forEach((stroke, i) => {
		if (stroke.points.length === 0) return;
		const style = styles?.[i];
		if (!style || style.shape === 'skip') return;
		if (style.shape === 'rect') {
			rectElements.push(buildRectElement(stroke, style));
			if (style.fill === 'hatch') hatchColors.add(style.color);
			return;
		}
		const bucket = style.tier === 'marker' ? markerElements : penElements;
		bucket.push(buildPathElement(stroke, style));
	});

	const defs = [...hatchColors].map(buildHatchPatternDef).join('');
	return { defs, elements: rectElements.join('') + markerElements.join('') + penElements.join('') };
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
	/** How to render each of `strokes`, aligned by index -- see `StrokeStyle`.
	 * A stroke with no entry (or an out-of-range index) is skipped entirely;
	 * scale a `'path'` entry's width along with `upscale` if rendering
	 * strokes onto an upscaled raster (a `'rect'` entry's size instead comes
	 * straight from its stroke's own already-upscaled points, so it needs no
	 * separate scaling). */
	strokeStyles?: StrokeStyle[];
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
	const { dpi, includeText = true, strokes, strokeStyles } = options;

	const pngBytes = image instanceof Uint8Array ? image : encodePng(image);
	const base64 = encodeBase64(pngBytes);

	const widthAttr = dpi ? `${pageWidth / dpi}in` : `${pageWidth}`;
	const heightAttr = dpi ? `${pageHeight / dpi}in` : `${pageHeight}`;

	const textElements = includeText ? buildRecognitionTextElements(page, pageWidth) : '';
	const { defs, elements: strokeElements } =
		strokes && strokes.length ? buildStrokePathElements(strokes, strokeStyles) : { defs: '', elements: '' };

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
		`width="${widthAttr}" height="${heightAttr}" viewBox="0 0 ${pageWidth} ${pageHeight}">` +
		(defs ? `<defs>${defs}</defs>` : '') +
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
	 * decoded from its `TOTALPATH` data (including each stroke's real color,
	 * tool, and thickness -- see `parseStrokes`), instead of leaving ink to
	 * the rasterized image -- crisp at any zoom, instead of the
	 * fixed-resolution bitmap `toSvg` otherwise embeds.
	 *
	 * Applied per page, not globally: a page whose strokes decode
	 * successfully gets its bitmap ink layers (MAINLAYER/LAYER1-3) left out
	 * of the raster and replaced with vector paths; a page with no decodable
	 * strokes at all (e.g. genuinely blank, or a `TOTALPATH` structure this
	 * hasn't been validated against) keeps its normal rasterized ink instead,
	 * rather than silently rendering blank. Background layers (templates, PDF
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

/** A page's rendered ink, decoded once per page -- the fallback source for a
 * `'rect'` stroke's color/fill (see `deriveStrokeStyle`) when it has no
 * matching `TITLE_*` footer entry (a rect's own `TOTALPATH` metadata isn't
 * meaningful the way a `'path'` stroke's is, and only Headings carry
 * `TITLE_*` metadata -- badges/highlight boxes still need this). */
interface InkMask {
	/** 1 where that pixel (row-major, `y * pageWidth + x`) is real rendered
	 * ink, 0 otherwise. */
	isInk: Uint8Array;
	inkPixelCount: number;
	/** RGB of each `isInk` pixel, 3 bytes per pixel at the same index * 3;
	 * meaningless where `isInk` is 0. */
	colors: Uint8Array;
}

/** Decodes `page`'s ink layers (MAINLAYER/LAYER1-3) into one composited
 * `InkMask`, or `null` if the page has no ink layer data at all. An earlier
 * version of this filtered out ink pixels whose red channel read >= 250, to
 * exclude near-white anti-aliasing bleeding into the background -- but
 * RATTA_RLE's colors are flat (no anti-aliasing) and background/unwritten
 * pixels decode to alpha 0 regardless of color (see RattaRLEDecoder's own
 * doc comment), so alpha alone already distinguishes real ink from
 * background. The brightness check just silently excluded genuine *white*
 * ink as if it were background instead -- confirmed against a real white-pen
 * stroke (see stroke-isolation.note, issue #56's follow-up investigation),
 * which undercounted coverage and made color sampling unable to ever detect
 * a white pen. */
function buildInkMask(page: IPage, pageWidth: number, pageHeight: number): InkMask | null {
	const inkLayers = INK_LAYER_NAMES.map((name) => page[name]).filter(
		(layer) => layer.bitmapBuffer && layer.bitmapBuffer.length,
	);
	if (inkLayers.length === 0) return null;

	const decoder = new RattaRLEDecoder();
	const isInk = new Uint8Array(pageWidth * pageHeight);
	const colors = new Uint8Array(pageWidth * pageHeight * 3);
	let inkPixelCount = 0;
	for (const layer of inkLayers) {
		const pixels = decoder.decode(layer.bitmapBuffer as Uint8Array, pageWidth, pageHeight);
		for (let i = 0, p = 0; p < isInk.length; i += 4, p++) {
			if (isInk[p]) continue;
			if (pixels[i + 3] > 0) {
				isInk[p] = 1;
				colors[p * 3] = pixels[i];
				colors[p * 3 + 1] = pixels[i + 1];
				colors[p * 3 + 2] = pixels[i + 2];
				inkPixelCount++;
			}
		}
	}
	return inkPixelCount > 0 ? { isInk, inkPixelCount, colors } : null;
}

/** Below this fraction of a page's actual rendered ink pixels sitting in a
 * connected-ink blob that some decoded stroke actually passes through,
 * `toSvg`'s `vectorInk` option keeps that page's rasterized ink rather than
 * replacing it -- see `estimateInkCoverage`. */
/** Below this fraction of a 2-point stroke's own bounding rectangle already
 * being real ink, `deriveStrokeStyle` treats it as `'skip'` rather than
 * `'rect'` -- see `StrokeStyle`'s doc comment. Comfortably below every
 * genuine rectangle measured so far (~97% for a solid fill, ~25% for a
 * deliberately patterned one like a cross-hatch) and comfortably above the
 * 0% measured for the handful of unrelated short 2-point ink strokes found
 * across other fixtures, so this only needs to separate those two clusters,
 * not pinpoint an exact threshold. */
const MIN_RECT_FILL_FRACTION = 0.15;
/** At or above this fill fraction, a 'rect' is treated as a `'solid'` fill;
 * below it (but still >= `MIN_RECT_FILL_FRACTION`), a `'hatch'` fill -- see
 * `StrokeStyle`'s doc comment. Sits comfortably between the two clusters
 * measured on a real fixture (~97-99% solid, ~25% cross-hatch). */
const SOLID_RECT_MIN_FILL_FRACTION = 0.5;

function modeColor(colorCounts: Map<string, number>): string | undefined {
	let bestKey: string | undefined;
	let bestCount = 0;
	for (const [key, count] of colorCounts) {
		if (count > bestCount) {
			bestCount = count;
			bestKey = key;
		}
	}
	return bestKey;
}

function rectBounds(p0: IStrokePoint, p1: IStrokePoint, pageWidth: number, pageHeight: number) {
	return {
		minX: Math.max(0, Math.floor(Math.min(p0.x, p1.x))),
		maxX: Math.min(pageWidth - 1, Math.ceil(Math.max(p0.x, p1.x))),
		minY: Math.max(0, Math.floor(Math.min(p0.y, p1.y))),
		maxY: Math.min(pageHeight - 1, Math.ceil(Math.max(p0.y, p1.y))),
	};
}

/** A Heading rect's real fill/text color, decoded from its `TITLE_*` footer
 * metadata (see `buildTitleIndex`) instead of sampled from the raster. */
interface TitleStyle {
	fill: 'solid' | 'hatch';
	/** The rect's own background color, e.g. `rgb(157,157,157)`. */
	backgroundColor: string;
	/** The Heading's label text color, auto-recolored for contrast against
	 * `backgroundColor` -- see `applyHeadingContrastOverrides`. */
	textColor: string;
}

/** Decodes an `ITitle.TITLESTYLE` value (7 decimal digits, `1BBBFFF`) into a
 * `TitleStyle` -- `BBB` is the background's grey level, `FFF` the displayed
 * label text's grey level, confirmed against real fixtures on two devices
 * (see plans/vector-format-spec.md, "TITLE_ / KEYWORD_ footer metadata").
 * The cross-hatch pattern is the one variant whose background and text
 * digits are both `000`: a solid-black heading always carries white text, so
 * `1000000` can't mean "solid black" -- it's the hatch case instead, whose
 * pattern color is black. */
function parseTitleStyle(titleStyle: string): TitleStyle {
	const backgroundDigits = titleStyle.slice(1, 4);
	const textDigits = titleStyle.slice(4, 7);
	const isHatch = backgroundDigits === '000' && textDigits === '000';
	const backgroundGrey = Number(backgroundDigits);
	const textGrey = Number(textDigits);
	return {
		fill: isHatch ? 'hatch' : 'solid',
		backgroundColor: `rgb(${backgroundGrey},${backgroundGrey},${backgroundGrey})`,
		textColor: `rgb(${textGrey},${textGrey},${textGrey})`,
	};
}

/** One page's `TITLE_*` footer entries (Headings), reduced to their page-pixel
 * rect and decoded `TitleStyle` -- built once per page and matched against
 * each 2-point rect stroke by position (see `findMatchingTitleStyle`), since
 * `ITitle` itself carries no stroke-record link, only its own independently
 * recorded `TITLERECT`. */
interface TitleRectEntry {
	x: number;
	y: number;
	width: number;
	height: number;
	style: TitleStyle;
}

/** `note.titles` is keyed by the footer's `TITLE_PPPPYYYYXXXX` suffix --
 * 4-digit page number, then the title's own `y`/`x` -- across the whole
 * note, not scoped per page, so filtering by the page-number prefix is how
 * one page's own Headings are found. */
function buildTitleIndex(note: ISupernote, pageNumber: number): TitleRectEntry[] {
	const pagePrefix = String(pageNumber).padStart(4, '0');
	const entries: TitleRectEntry[] = [];
	for (const [key, titles] of Object.entries(note.titles)) {
		if (!key.startsWith(pagePrefix)) continue;
		for (const title of titles) {
			// ITitle.TITLERECT is typed as a 4-tuple (IRectangle), but
			// _parseTitle's actual value is the raw, still-comma-joined
			// "x,y,w,h" string (parseKeyValue never splits it) -- normalize
			// either shape rather than trusting the declared type.
			const rectParts = Array.isArray(title.TITLERECT) ? title.TITLERECT : String(title.TITLERECT).split(',');
			const [x, y, width, height] = rectParts.map(Number);
			entries.push({ x, y, width, height, style: parseTitleStyle(title.TITLESTYLE) });
		}
	}
	return entries;
}

/** A rect stroke's transformed corners land within ~1px of its `TITLERECT`
 * counterpart (confirmed pixel-exact against a real fixture -- see
 * plans/vector-format-spec.md), so a small tolerance absorbs float rounding
 * from the coordinate transform without risking a false match between two
 * distinct, unrelated rects on the same page. */
const TITLE_RECT_MATCH_TOLERANCE_PX = 2;

/** Finds the `TitleStyle` for a 2-point rect stroke's corners `p0`/`p1`, by
 * position against `titleIndex` -- or `undefined` if this rect isn't a
 * Heading (no matching `TITLE_*` entry), e.g. a badge or highlight box. */
function findMatchingTitleStyle(titleIndex: TitleRectEntry[], p0: IStrokePoint, p1: IStrokePoint): TitleStyle | undefined {
	const x = Math.min(p0.x, p1.x);
	const y = Math.min(p0.y, p1.y);
	const width = Math.abs(p1.x - p0.x);
	const height = Math.abs(p1.y - p0.y);
	const entry = titleIndex.find(
		(candidate) =>
			Math.abs(candidate.x - x) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.y - y) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.width - width) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.height - height) <= TITLE_RECT_MATCH_TOLERANCE_PX,
	);
	return entry?.style;
}

/** What fraction of the rectangle spanned by `p0`/`p1` (a 2-point stroke's
 * decoded points, i.e. its opposite corners) is already real ink in `mask`,
 * and that ink's most common color within the rectangle (`undefined` if
 * none). */
function sampleRect(
	mask: InkMask,
	pageWidth: number,
	pageHeight: number,
	p0: IStrokePoint,
	p1: IStrokePoint,
): { fillFraction: number; color: string | undefined } {
	const { minX, maxX, minY, maxY } = rectBounds(p0, p1, pageWidth, pageHeight);
	const colorCounts = new Map<string, number>();
	let total = 0;
	let filled = 0;
	for (let y = minY; y <= maxY; y++) {
		const rowStart = y * pageWidth;
		for (let x = minX; x <= maxX; x++) {
			total++;
			const p = rowStart + x;
			if (!mask.isInk[p]) continue;
			filled++;
			const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
			colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
		}
	}
	return { fillFraction: total > 0 ? filled / total : 0, color: modeColor(colorCounts) };
}

/** Converts `IStroke.thickness` (an opaque on-device unit -- see its own doc
 * comment) to an SVG stroke-width in page pixels. Calibrated empirically
 * against `stroke-isolation.note`'s tool-isolated fixture: dividing by 150
 * lands ordinary pen tools (needle/ink/calligraphy: raw 400-900) at 3-6px
 * and a marker (raw 3800) at ~25px, matching this codebase's own prior
 * raster-measured widths for the same strokes (needle/ink/calligraphy
 * consistently well under a marker's, which measured close to the old
 * raster-search's own 12px-half-width cap) -- not derived from a documented
 * physical unit, since `thickness` isn't confirmed to share the coordinate
 * fields' "10 micrometers per unit" scale (dividing by the same per-page
 * coordinate `scale` `parseStrokes` uses produces implausibly wide lines,
 * confirmed against this same fixture). */
const THICKNESS_TO_PIXEL_SCALE = 150;

/**
 * Derives a `StrokeStyle` for one decoded stroke. For a `'path'`, this is a
 * pure, direct read of the stroke's own real `TOTALPATH` metadata -- no
 * raster involved at all (see `StrokeStyle`'s doc comment for why that
 * metadata, not raster sampling, is now the source of truth). A 2-point
 * `'rect'` is the one exception: its own `color` field isn't meaningful (see
 * `StrokeStyle`), so its color/fill instead comes from `titleIndex` (a
 * Heading's real `TITLE_*` footer metadata -- see `findMatchingTitleStyle`)
 * when it matches; only a rect with no `TITLE_*` match (a badge/highlight
 * box, not a Heading) falls back to `mask`, the page's own rendered ink.
 */
function deriveStrokeStyle(
	stroke: IStroke,
	mask: InkMask | null,
	titleIndex: TitleRectEntry[],
	pageWidth: number,
	pageHeight: number,
): StrokeStyle {
	if (stroke.points.length === 2) {
		const [p0, p1] = stroke.points;
		const titleStyle = findMatchingTitleStyle(titleIndex, p0, p1);
		if (titleStyle) return { shape: 'rect', color: titleStyle.backgroundColor, fill: titleStyle.fill };

		if (!mask) return { shape: 'skip' };
		const { fillFraction, color } = sampleRect(mask, pageWidth, pageHeight, p0, p1);
		if (fillFraction < MIN_RECT_FILL_FRACTION) return { shape: 'skip' };
		return {
			shape: 'rect',
			color: color ? `rgb(${color})` : 'black',
			fill: fillFraction >= SOLID_RECT_MIN_FILL_FRACTION ? 'solid' : 'hatch',
		};
	}

	return {
		shape: 'path',
		color: stroke.color,
		width: stroke.thickness / THICKNESS_TO_PIXEL_SCALE,
		tier: stroke.pen === 'marker' ? 'marker' : 'pen',
	};
}

/** At or above this fraction of a `'path'` stroke's own points landing
 * inside a single `'rect'` stroke's bounding box, `applyHeadingContrastOverrides`
 * treats it as label text belonging to that rect rather than unrelated ink
 * that merely passes nearby. */
const MIN_INSIDE_RECT_FRACTION = 0.8;

function isInsideRectBounds(point: IStrokePoint, bounds: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
	return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

/**
 * Supernote's Heading feature auto-recolors its label text for contrast
 * against the heading's own background -- confirmed against a real
 * fixture: black-pen text drawn over a black or dark-grey heading
 * background renders as white in the raster, not black. That's a
 * display-time effect, not something recorded per-stroke: `IStroke.color`
 * always reflects the actual pen color the text was physically written in
 * (black, here), which is exactly right for `deriveStrokeStyle`'s normal,
 * raster-free `'path'` color -- just not for this one feature's on-screen
 * result.
 *
 * Handled here as a narrow, targeted exception rather than by discarding
 * real per-stroke color generally: a `'path'` whose own points mostly land
 * inside a `'rect'`'s bounds (a heading background, or any other 2-point
 * rect -- see `StrokeStyle`) gets its *displayed* color overridden. When
 * that rect is a real Heading (a `TITLE_*` match), the override is an exact
 * read of `TITLESTYLE`'s own text-color digits (see `TitleStyle`) -- no
 * raster involved. Only a rect with no `TITLE_*` match falls back to
 * resampling `mask`, the page's own rendered ink, the way this used to work
 * for every rect. Every other stroke keeps its real, raster-free color
 * untouched.
 */
function applyHeadingContrastOverrides(
	strokes: IStroke[],
	styles: StrokeStyle[],
	titleIndex: TitleRectEntry[],
	mask: InkMask | null,
	pageWidth: number,
	pageHeight: number,
): StrokeStyle[] {
	const rectInfoList = strokes
		.map((stroke, i) => {
			if (styles[i].shape !== 'rect') return null;
			const [p0, p1] = stroke.points;
			return {
				bounds: rectBounds(p0, p1, pageWidth, pageHeight),
				textColor: findMatchingTitleStyle(titleIndex, p0, p1)?.textColor,
			};
		})
		.filter((info) => info !== null);
	if (rectInfoList.length === 0) return styles;

	return styles.map((style, i) => {
		if (style.shape !== 'path') return style;
		const stroke = strokes[i];
		const matchedRect = rectInfoList.find((info) => {
			const insideCount = stroke.points.filter((point) => isInsideRectBounds(point, info.bounds)).length;
			return insideCount / stroke.points.length >= MIN_INSIDE_RECT_FRACTION;
		});
		if (!matchedRect) return style;
		if (matchedRect.textColor) return { ...style, color: matchedRect.textColor };

		if (!mask) return style;
		const colorCounts = new Map<string, number>();
		for (const point of stroke.points) {
			const xi = Math.round(point.x);
			const yi = Math.round(point.y);
			if (xi < 0 || xi >= pageWidth || yi < 0 || yi >= pageHeight) continue;
			const p = yi * pageWidth + xi;
			if (!mask.isInk[p]) continue;
			const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
			colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
		}
		const sampled = modeColor(colorCounts);
		return sampled ? { ...style, color: `rgb(${sampled})` } : style;
	});
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

	// Each real IStroke already carries its own real color/tool/thickness
	// (see parseStrokes), so "did this page decode at all" is now a simple,
	// exact question -- no coverage estimate needed. A page whose strokes
	// don't decode (no TOTALPATH data, or a structure this hasn't been
	// validated against) keeps its raster ink instead of replacing it with
	// nothing. A 'rect' stroke is the one case that still needs a lookup
	// beyond its own TOTALPATH record (see deriveStrokeStyle): titleIndex
	// (that page's Heading metadata, from the note's own footer -- built
	// once per decoded page since it's a plain-value lookup, no decoding
	// needed) covers Headings exactly; mask (the page's own rendered ink,
	// decoded once per page at native resolution) is only the fallback for a
	// 2-point rect with no titleIndex match (badges/highlight boxes). Rect
	// styles don't need to be recomputed per upscale factor, only their
	// already-upscaled points do.
	const strokeStylesPerPage: StrokeStyle[][] = pages.map(() => []);
	const decodedPageNumbers = vectorInk
		? new Set(
				pages
					.map((page, i) => {
						const nativeStrokes = parseStrokes(page.totalPathBuffer, note.pageWidth, note.pageHeight);
						const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
						if (nativeStrokes.length === 0) return -1;
						const mask = buildInkMask(page, note.pageWidth, note.pageHeight);
						const titleIndex = buildTitleIndex(note, pageNumber);
						const styles = nativeStrokes.map((stroke) =>
							deriveStrokeStyle(stroke, mask, titleIndex, note.pageWidth, note.pageHeight),
						);
						strokeStylesPerPage[i] = applyHeadingContrastOverrides(
							nativeStrokes,
							styles,
							titleIndex,
							mask,
							note.pageWidth,
							note.pageHeight,
						);
						return pageNumber;
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
		// Styles were derived at native resolution (alongside the decode
		// check above); a 'path' style's width needs to scale up alongside
		// strokesPerPage's own upscaled coordinates so the rendered line
		// matches the stroke's real thickness at any upscale factor -- a
		// 'rect' style's size instead comes straight from its stroke's own
		// (already-upscaled) points, and 'skip' has no size at all, so
		// neither needs adjusting here. Color doesn't need scaling either.
		const strokeStyles = strokes
			? strokeStylesPerPage[i].map((style): StrokeStyle => (style.shape === 'path' ? { ...style, width: style.width * upscale } : style))
			: undefined;
		return addSvgPage(page, images[i], images[i].width, images[i].height, {
			dpi: effectiveDpi,
			includeText,
			strokes,
			strokeStyles,
		});
	});
}

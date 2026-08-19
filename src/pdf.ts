import {
	PDFDocument,
	PDFFont,
	PDFName,
	PDFPage,
	StandardFonts,
	TextRenderingMode,
	beginText,
	endText,
	moveText,
	setCharacterSqueeze,
	setFontAndSize,
	setTextRenderingMode,
	showText,
	rgb,
	LineCapStyle,
	Color,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Image, encodePng } from 'image-js';
import { toImage, IPdfPage } from './conversion.js';
import { ISupernote } from './format.js';
import { IStroke } from './strokes.js';
import {
	StrokeStyle,
	VectorInkPrimitive,
	buildVectorInkPrimitives,
	prepareVectorInkPages,
	buildRenderNoteForVectorInk,
} from './vector-ink.js';

// Recognized word bounding boxes are stored in raster-pixel units divided by
// a scale factor that is *not* a universal constant - it depends on which
// device family produced the note.
//
// The recognition engine renders each page to a fixed-width "reference
// canvas" before recognizing, and stores bounding boxes in that canvas's
// pixel space divided by 11.9 (confirmed per plans/rtr-searchable-pdf.md).
// So the universal part is: canvas_pixel = recognition_unit * 11.9. What is
// *not* universal is the reference canvas width, which is a FIXED
// per-device constant (it does NOT scale with an upscaled render):
//
//   - Manta (N5, pageWidth 1920): canvas 1920  → scale = render * 11.9 / 1920
//   - A5X       (pageWidth 1404): canvas 1920  → scale = render * 11.9 / 1920
//     (A5X is the only known device whose recognition canvas, 1920,
//      differs from its own pageWidth, 1404 - it upsamples recognition to
//      the same 1920 canvas Manta uses. philips/supernote-obsidian-plugin#204:
//      a fixed 11.9 landed A5X highlights a full page-height below the ink.)
//   - Nomad (N6, pageWidth 1404): canvas 1404  → scale = render * 11.9 / 1404
//   - A6X   (pageWidth 1404):      canvas 1404  → scale = render * 11.9 / 1404
//     (N6/A6X render recognition natively at their own pageWidth, so the
//      correct scale at native resolution is the raw 11.9, NOT shrunk by
//      1404/1920. philips/supernote-obsidian-plugin#219: the old code applied
//      that 1920-reference shrink to every non-Manta family, which is right
//      for A5X but wrong for N6/A6X - it pulled their boxes to ~8.70 when they
//      line up at the raw 11.9.)
//
// I.e. #204's "recognition coordinates are defined against a fixed 1920-unit
// canvas" model was over-generalized from a single A5X fixture: 1920 is the
// canvas for Manta AND A5X, but N6/A6X use their own pageWidth (1404) as the
// canvas. (A pre-X A5, if one exists, may also upsample to 1920 the way A5X
// does - we have no fixture to confirm; only A5X is special-cased here,
// deliberately, because it's the only one the data covers.)
//
// `renderWidth` is the width of the raster being rendered into (the image's
// pixel width - `upscale` grows it beyond `note.pageWidth`). `equipment` is
// `header.APPLY_EQUIPMENT` (e.g. 'A5X', 'N5', 'N6', 'A6X'). `nativePageWidth`
// is the note's own `pageWidth` (the device's native, pre-upscale page width) -
// needed to pick the canvas for non-A5X devices, since `renderWidth` alone
// can't recover it when `upscale > 1`.
//
// When `equipment` is omitted (undefined), the legacy 1920-reference-canvas
// behavior is preserved so existing direct callers of addPdfPage()/addSvgPage()
// that don't pass it keep their pre-#219 output unchanged; the high-level
// toPdf()/toSvg() always pass the note's real equipment and nativePageWidth.
const RECOGNITION_REFERENCE_PAGE_WIDTH = 1920;
const RECOGNITION_REFERENCE_SCALE = 11.9;

/** Scale factor to convert a recognized word's native bounding-box units into
 * raster-pixel units at the given `renderWidth`, for a note produced by
 * `equipment` (`header.APPLY_EQUIPMENT`, e.g. 'A5X', 'N5', 'N6', 'A6X') whose
 * native page width is `nativePageWidth` (the note's `pageWidth`, NOT the
 * possibly-upscaled render width). Pass the real equipment + nativePageWidth
 * for correct results on every device family and at every upscale factor;
 * omitting both keeps the legacy 1920-reference-canvas behavior (correct only
 * for A5X and Manta, wrong for N6/A6X - see the comment above).
 *
 * Exported so other exporters positioning an invisible text overlay over
 * the same recognition data (e.g. svg.ts, and the obsidian plugin's own
 * wordOverlay.ts) share this instead of re-deriving it. */
export function recognitionCoordinateScale(
	renderWidth: number,
	equipment?: string,
	nativePageWidth?: number,
): number {
	// A5X is the only known device whose recognition canvas (1920) differs
	// from its own pageWidth. For every other device the canvas equals its
	// native pageWidth. Omitting equipment keeps the legacy 1920 canvas so
	// direct callers that don't pass it get unchanged pre-#219 output.
	const canvasWidth = equipment === undefined || equipment === 'A5X'
		? RECOGNITION_REFERENCE_PAGE_WIDTH
		: (nativePageWidth ?? renderWidth);
	return (renderWidth * RECOGNITION_REFERENCE_SCALE) / canvasWidth;
}

export interface ToPdfOptions {
	/** Page numbers to export (1-indexed). Defaults to all pages. */
	pageNumbers?: number[];
	/** Bytes of a Unicode-capable TTF/OTF font to embed for the invisible text
	 * layer. Defaults to the standard Helvetica font, which only supports
	 * Latin (WinAnsi) text and will throw for other scripts. */
	fontBytes?: Uint8Array;
	/** Assumed pixel density of the source page raster, used to size PDF
	 * pages in points. Supernote doesn't record this in the file; 300 matches
	 * known device screen densities. Only affects the physical/print page
	 * size, not searchability. */
	dpi?: number;
	/** Render each page's pen strokes as real vector paths instead of
	 * rasterizing the ink layers -- crisp at any zoom. When enabled, the
	 * bitmap ink layers (MAINLAYER/LAYER1-3) are stripped from the page image
	 * and replaced with vector primitives derived from `TOTALPATH`. Default
	 * false. */
	vectorInk?: boolean;
	/** Smooth upscale factor applied to the rasterized background before
	 * vector ink is drawn on top. Must be >= 1. Coordinates are upscaled
	 * along with the background so the vector ink stays aligned. */
	upscale?: number;
}

export interface PdfContext {
	pdfDoc: PDFDocument;
	font: PDFFont;
}

/**
 * Creates the PDF document and embeds the invisible-text-layer font.
 * Main-thread only: the returned `pdf-lib` objects aren't structured-clone-safe
 * and so can't be created in or handed to a Worker.
 */
export async function createPdfContext(
	options: Pick<ToPdfOptions, 'fontBytes'> = {},
): Promise<PdfContext> {
	const { fontBytes } = options;
	const pdfDoc = await PDFDocument.create();

	let font: PDFFont;
	if (fontBytes) {
		pdfDoc.registerFontkit(fontkit);
		font = await pdfDoc.embedFont(fontBytes, { subset: true });
	} else {
		font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	}

	return { pdfDoc, font };
}

export interface AddPdfPageOptions {
	/** Assumed pixel density of the source page raster; see `ToPdfOptions.dpi`. */
	dpi?: number;
	/** Pen strokes to draw as vector paths on top of `image`, instead of
	 * leaving ink to the raster. Coordinates must be in the same pixel space
	 * as the supplied `image`. Omit (or pass `[]`) to render only `image`. */
	strokes?: IStroke[];
	/** How to render each of `strokes`, aligned by index -- see `StrokeStyle`. */
	strokeStyles?: StrokeStyle[];
	/** Device family this page's note was produced by
	 * (`header.APPLY_EQUIPMENT`, e.g. 'A5X', 'N5', 'N6', 'A6X'), used to pick
	 * the correct recognition-coordinate scale - see
	 * `recognitionCoordinateScale`. Omitting it (with `nativePageWidth`)
	 * keeps the legacy 1920-reference-canvas behavior (correct only for A5X
	 * and Manta, wrong for N6/A6X); `toPdf()` always passes the note's real
	 * equipment. */
	equipment?: string;
	/** The note's own `pageWidth` (the device's native, pre-upscale page
	 * width) - needed to pick the recognition canvas for non-A5X devices
	 * when `image` is upscaled beyond it. Defaults to `image`'s width (i.e.
	 * no upscale), which is correct for non-upscaled renders.
	 * `toPdf()` always passes `note.pageWidth`. */
	nativePageWidth?: number;
}

// Draws the recognized handwriting (RTR) text invisibly onto `pdfPage` at
// the position it was written, so PDF viewers (or pdf.js's getTextContent())
// can find/select/extract the handwritten words. Shared by addPdfPage() (page
// also gets the rendered image drawn beneath this) and addTextOnlyPdfPage()
// (no image at all — see its doc comment for when that's the right choice).
function drawRecognitionText(
	pdfPage: PDFPage,
	fontKey: PDFName,
	font: PDFFont,
	page: IPdfPage,
	renderWidth: number,
	pointsPerPixel: number,
	heightPts: number,
	equipment?: string,
	nativePageWidth?: number,
): void {
	const scale = recognitionCoordinateScale(renderWidth, equipment, nativePageWidth);
	for (const element of page.recognitionElements) {
		if (element.type !== 'Text') continue;

		for (const word of element.words) {
			const box = word['bounding-box'];
			if (!box) continue;

			const label = decodeURIComponent(escape(word.label));
			if (!label) continue;

			const xPx = box.x * scale;
			const yPx = box.y * scale;
			const widthPx = box.width * scale;
			const heightPx = box.height * scale;

			const boxWidthPts = widthPx * pointsPerPixel;
			const boxHeightPts = heightPx * pointsPerPixel;
			const x = xPx * pointsPerPixel;
			// PDF's y-axis runs bottom-up; recognition boxes are top-down.
			const y = heightPts - (yPx * pointsPerPixel + boxHeightPts);

			// Size the font to the box height, then use horizontal scaling
			// (the PDF `Tz` operator) to stretch or squeeze the text to
			// exactly match the box width in both directions — handwriting
			// is rarely the same width as print at a given height (cursive
			// runs narrower, print can run wider) — so that PDF viewers'
			// search-hit highlight rectangle lines up with the ink instead
			// of just not overflowing it.
			try {
				const fontSize = boxHeightPts;
				const naturalWidth = font.widthOfTextAtSize(label, fontSize);
				const horizontalScale = naturalWidth > 0 ? (boxWidthPts / naturalWidth) * 100 : 100;

				pdfPage.pushOperators(
					beginText(),
					setTextRenderingMode(TextRenderingMode.Invisible),
					setFontAndSize(fontKey, fontSize),
					setCharacterSqueeze(horizontalScale),
					moveText(x, y),
					showText(font.encodeText(label)),
					endText(),
				);
			} catch {
				// The active font (Helvetica by default) can't encode every
				// character recognition may produce (e.g. superscripts, smart
				// punctuation). Skip this word rather than losing the whole
				// PDF over one unsearchable word; pass a Unicode `fontBytes`
				// font via ToPdfOptions to cover more characters.
				continue;
			}
		}
	}
}

/** Converts a CSS `rgb(g,g,g)` color string to a pdf-lib `Color`. */
function pdfColor(css: string): Color {
	const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css);
	if (!m) return rgb(0, 0, 0);
	return rgb(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
}

/** Draws a hatched rectangle as a white background with diagonal colored
 * stripes -- the PDF equivalent of the SVG hatch pattern used for Heading
 * backgrounds. */
function drawHatchedRect(
	pdfPage: PDFPage,
	x: number,
	y: number,
	width: number,
	height: number,
	color: Color,
	heightPts: number,
	pointsPerPixel: number,
): void {
	const px = x * pointsPerPixel;
	const py = heightPts - (y + height) * pointsPerPixel;
	const pw = width * pointsPerPixel;
	const ph = height * pointsPerPixel;

	pdfPage.drawRectangle({
		x: px,
		y: py,
		width: pw,
		height: ph,
		color: rgb(1, 1, 1),
	});

	// Diagonal stripes at 45° (direction (1, 1) in top-down coordinates),
	// spaced like the SVG pattern cell diagonal (10 * sqrt(2)) with a 5px
	// perpendicular stroke width.
	const spacing = 10 * Math.sqrt(2);
	const thickness = 5 * pointsPerPixel;
	const minC = x - (y + height);
	const maxC = x + width - y;
	for (let c = minC; c <= maxC; c += spacing) {
		const yMin = Math.max(y, x - c);
		const yMax = Math.min(y + height, x + width - c);
		if (yMin >= yMax) continue;
		const startX = c + yMin;
		const startY = yMin;
		const endX = c + yMax;
		const endY = yMax;
		pdfPage.drawLine({
			start: { x: startX * pointsPerPixel, y: heightPts - startY * pointsPerPixel },
			end: { x: endX * pointsPerPixel, y: heightPts - endY * pointsPerPixel },
			thickness,
			color,
			lineCap: LineCapStyle.Butt,
		});
	}
}

/** Renders a list of vector-ink primitives onto a PDF page. Coordinates are
 * in image pixels (top-down) and are converted to points using
 * `pointsPerPixel`; `heightPts` is used to flip the y-axis into PDF's
 * bottom-up coordinate system. */
function drawVectorInkPrimitives(
	pdfPage: PDFPage,
	primitives: VectorInkPrimitive[],
	heightPts: number,
	pointsPerPixel: number,
): void {
	for (const primitive of primitives) {
		if (primitive.kind === 'rect') {
			const color = pdfColor(primitive.color);
			if (primitive.fill === 'hatch') {
				drawHatchedRect(
					pdfPage,
					primitive.x,
					primitive.y,
					primitive.width,
					primitive.height,
					color,
					heightPts,
					pointsPerPixel,
				);
			} else {
				pdfPage.drawRectangle({
					x: primitive.x * pointsPerPixel,
					y: heightPts - (primitive.y + primitive.height) * pointsPerPixel,
					width: primitive.width * pointsPerPixel,
					height: primitive.height * pointsPerPixel,
					color,
				});
			}
			continue;
		}

		const d =
			primitive.kind === 'filledPath'
				? primitive.rings
						.map((ring) =>
							ring.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ') + ' Z',
						)
						.join(' ')
				: primitive.points
						.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
						.join(' ');

		if (primitive.kind === 'filledPath') {
			pdfPage.drawSvgPath(d, {
				x: 0,
				y: heightPts,
				scale: pointsPerPixel,
				color: pdfColor(primitive.color),
			});
		} else {
			pdfPage.drawSvgPath(d, {
				x: 0,
				y: heightPts,
				scale: pointsPerPixel,
				borderColor: pdfColor(primitive.color),
				borderWidth: primitive.width,
				borderLineCap: LineCapStyle.Round,
			});
		}
	}
}

/**
 * Adds one rendered page to `ctx`: the page image, plus the recognized
 * handwriting (RTR) text drawn invisibly on top of it at the position it was
 * written, so PDF viewers can search for and select the handwritten words.
 *
 * `image` may be an `image-js` `Image` (e.g. straight from `toImage`) or
 * already-PNG-encoded bytes (e.g. from a Worker that already called
 * `toImage` + `encodePng` off-main-thread) — accepting bytes avoids the main
 * thread needing to reconstruct an `Image` just to re-encode it.
 *
 * When `options.strokes`/`options.strokeStyles` are supplied, the ink layers
 * in `image` are expected to have been omitted and the strokes are drawn as
 * vector paths on top of the background before the text layer is added.
 *
 * Main-thread only: `ctx` holds `pdf-lib` objects.
 */
export async function addPdfPage(
	ctx: PdfContext,
	page: IPdfPage,
	image: Image | Uint8Array,
	options: AddPdfPageOptions = {},
): Promise<void> {
	const { dpi = 300, strokes, strokeStyles, equipment, nativePageWidth } = options;
	const { pdfDoc, font } = ctx;
	const pointsPerPixel = 72 / dpi;

	const pngBytes = image instanceof Uint8Array ? image : encodePng(image);
	const pngImage = await pdfDoc.embedPng(pngBytes);

	const widthPts = pngImage.width * pointsPerPixel;
	const heightPts = pngImage.height * pointsPerPixel;

	const pdfPage = pdfDoc.addPage([widthPts, heightPts]);
	const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);

	pdfPage.drawImage(pngImage, { x: 0, y: 0, width: widthPts, height: heightPts });

	if (strokes && strokes.length) {
		drawVectorInkPrimitives(pdfPage, buildVectorInkPrimitives(strokes, strokeStyles), heightPts, pointsPerPixel);
	}

	drawRecognitionText(pdfPage, fontKey, font, page, pngImage.width, pointsPerPixel, heightPts, equipment, nativePageWidth);
}

/**
 * Adds one page to `ctx` with the recognized text drawn invisibly, same as
 * addPdfPage(), but with no image at all — for a PDF whose only purpose is
 * to be handed to pdf.js so its getTextContent()/getViewport() can be used
 * (e.g. to build a searchable/selectable text layer over a page that's
 * actually displayed some other way, such as a directly-rendered canvas).
 * `pdfPage.render()` is never called against such a PDF, so the image would
 * be pure dead weight: embedding a full-resolution PNG only for pdf-lib to
 * decode, recompress, and serialize it is real, size-proportional work
 * (seconds for a many-page/high-resolution note) for bytes nothing ever
 * looks at. `pageWidth`/`pageHeight` (pixels) size the PDF page the same way
 * the image's own dimensions would via addPdfPage().
 */
export async function addTextOnlyPdfPage(
	ctx: PdfContext,
	page: IPdfPage,
	pageWidth: number,
	pageHeight: number,
	options: AddPdfPageOptions = {},
): Promise<void> {
	const { dpi = 300, equipment, nativePageWidth } = options;
	const { pdfDoc, font } = ctx;
	const pointsPerPixel = 72 / dpi;

	const widthPts = pageWidth * pointsPerPixel;
	const heightPts = pageHeight * pointsPerPixel;

	const pdfPage = pdfDoc.addPage([widthPts, heightPts]);
	const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);

	drawRecognitionText(pdfPage, fontKey, font, page, pageWidth, pointsPerPixel, heightPts, equipment, nativePageWidth ?? pageWidth);
}

/**
 * Render a Supernote note to a PDF where each page shows the rasterized
 * page image with the recognized handwriting (RTR) text drawn invisibly on
 * top of it, at the position it was written, so PDF viewers can search for
 * and select the handwritten words.
 *
 * With `vectorInk: true`, each page's ink is drawn as vector paths instead
 * of rasterized pixels, giving a crisp result at any zoom. The bitmap ink
 * layers are left out of the page image and replaced by primitives decoded
 * from `TOTALPATH`.
 *
 * Convenience wrapper around `createPdfContext` + `addPdfPage`, all run on
 * the current thread. To render pages in parallel across Workers, call
 * `extractPageRenderData` + `toImage` + `encodePng` in each Worker and
 * `createPdfContext` + `addPdfPage` on the main thread instead — see the
 * README.
 */
export async function toPdf(note: ISupernote, options: ToPdfOptions = {}): Promise<Uint8Array> {
	const { pageNumbers, fontBytes, dpi, vectorInk = false, upscale = 1 } = options;
	if (!Number.isFinite(upscale) || upscale < 1) {
		throw new RangeError(`upscale must be a number >= 1, received ${upscale}`);
	}
	const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;
	const vectorInkPages = vectorInk ? prepareVectorInkPages(note, pageNumbers, upscale) : [];
	const renderNote = vectorInk ? buildRenderNoteForVectorInk(note, vectorInkPages) : note;
	const images = await toImage(renderNote, pageNumbers, { upscale });

	const ctx = await createPdfContext({ fontBytes });
	for (let i = 0; i < pages.length; i++) {
		const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
		const vip = vectorInkPages.find((p) => p.pageNumber === pageNumber);
		await addPdfPage(ctx, pages[i], images[i], {
			dpi,
			strokes: vip?.useVectorInk ? vip.strokes : undefined,
			strokeStyles: vip?.useVectorInk ? vip.styles : undefined,
			equipment: note.header.APPLY_EQUIPMENT,
			nativePageWidth: note.pageWidth,
		});
	}

	return ctx.pdfDoc.save();
}

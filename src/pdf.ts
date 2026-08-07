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
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Image, encodePng } from 'image-js';
import { toImage, IPdfPage } from './conversion.js';
import { ISupernote } from './format.js';

// Recognized word bounding boxes are stored in raster-pixel units divided by
// a scale factor that is *not* a universal constant: 11.9 (confirmed per
// plans/rtr-searchable-pdf.md) only holds at the 1920px-wide reference page
// Manta-family devices (SupernoteX's `header.APPLY_EQUIPMENT === 'N5'`
// check) render at. Every other device family - including the far more
// common A5X, whose default pageWidth is 1404 - needs that reference scale
// shrunk proportionally to its own actual page width, or recognized-word
// positions drift further from the real ink the further down the page a
// word sits (the error is multiplicative, so it's barely visible on the
// first line and lands on blank paper several lines down). Confirmed
// against a real A5X note fixture in
// https://github.com/philips/supernote-obsidian-plugin/pull/206.
const RECOGNITION_REFERENCE_PAGE_WIDTH = 1920;
const RECOGNITION_REFERENCE_SCALE = 11.9;

/** Scale factor to convert a recognized word's native bounding-box units
 * into raster-pixel units, for a page whose actual pixel width is
 * `pageWidth`. Exported so other exporters positioning an invisible text
 * overlay over the same recognition data (e.g. svg.ts) share this instead
 * of re-deriving it. */
export function recognitionCoordinateScale(pageWidth: number): number {
	return (pageWidth * RECOGNITION_REFERENCE_SCALE) / RECOGNITION_REFERENCE_PAGE_WIDTH;
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
	pageWidth: number,
	pointsPerPixel: number,
	heightPts: number,
): void {
	const scale = recognitionCoordinateScale(pageWidth);
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
 * Main-thread only: `ctx` holds `pdf-lib` objects.
 */
export async function addPdfPage(
	ctx: PdfContext,
	page: IPdfPage,
	image: Image | Uint8Array,
	options: AddPdfPageOptions = {},
): Promise<void> {
	const { dpi = 300 } = options;
	const { pdfDoc, font } = ctx;
	const pointsPerPixel = 72 / dpi;

	const pngBytes = image instanceof Uint8Array ? image : encodePng(image);
	const pngImage = await pdfDoc.embedPng(pngBytes);

	const widthPts = pngImage.width * pointsPerPixel;
	const heightPts = pngImage.height * pointsPerPixel;

	const pdfPage = pdfDoc.addPage([widthPts, heightPts]);
	const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);

	pdfPage.drawImage(pngImage, { x: 0, y: 0, width: widthPts, height: heightPts });

	drawRecognitionText(pdfPage, fontKey, font, page, pngImage.width, pointsPerPixel, heightPts);
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
	const { dpi = 300 } = options;
	const { pdfDoc, font } = ctx;
	const pointsPerPixel = 72 / dpi;

	const widthPts = pageWidth * pointsPerPixel;
	const heightPts = pageHeight * pointsPerPixel;

	const pdfPage = pdfDoc.addPage([widthPts, heightPts]);
	const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);

	drawRecognitionText(pdfPage, fontKey, font, page, pageWidth, pointsPerPixel, heightPts);
}

/**
 * Render a Supernote note to a PDF where each page shows the rasterized
 * page image with the recognized handwriting (RTR) text drawn invisibly on
 * top of it, at the position it was written, so PDF viewers can search for
 * and select the handwritten words.
 *
 * Convenience wrapper around `createPdfContext` + `addPdfPage`, all run on
 * the current thread. To render pages in parallel across Workers, call
 * `extractPageRenderData` + `toImage` + `encodePng` in each Worker and
 * `createPdfContext` + `addPdfPage` on the main thread instead — see the
 * README.
 */
export async function toPdf(note: ISupernote, options: ToPdfOptions = {}): Promise<Uint8Array> {
	const { pageNumbers, fontBytes, dpi } = options;
	const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;
	const images = await toImage(note, pageNumbers);

	const ctx = await createPdfContext({ fontBytes });
	for (let i = 0; i < pages.length; i++) {
		await addPdfPage(ctx, pages[i], images[i], { dpi });
	}

	return ctx.pdfDoc.save();
}

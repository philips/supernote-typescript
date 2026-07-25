import {
	PDFDocument,
	PDFFont,
	StandardFonts,
	TextRenderingMode,
	beginText,
	endText,
	moveText,
	setFontAndSize,
	setTextRenderingMode,
	showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { encodePng } from 'image-js';
import { toImage } from './conversion';
import { ISupernote } from './format';

// Empirically-verified constant used by Supernote's own recognition format:
// recognized word bounding boxes are stored in raster-pixel units divided by
// this factor. See plans/rtr-searchable-pdf.md for how this was confirmed.
const RECOGNITION_COORDINATE_SCALE = 11.9;

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

/**
 * Render a Supernote note to a PDF where each page shows the rasterized
 * page image with the recognized handwriting (RTR) text drawn invisibly on
 * top of it, at the position it was written, so PDF viewers can search for
 * and select the handwritten words.
 */
export async function toPdf(note: ISupernote, options: ToPdfOptions = {}): Promise<Uint8Array> {
	const { pageNumbers, fontBytes, dpi = 300 } = options;
	const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;
	const images = await toImage(note, pageNumbers);
	const pointsPerPixel = 72 / dpi;

	const pdfDoc = await PDFDocument.create();

	let font: PDFFont;
	if (fontBytes) {
		pdfDoc.registerFontkit(fontkit);
		font = await pdfDoc.embedFont(fontBytes, { subset: true });
	} else {
		font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	}

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		const image = images[i];

		const widthPts = image.width * pointsPerPixel;
		const heightPts = image.height * pointsPerPixel;

		const pdfPage = pdfDoc.addPage([widthPts, heightPts]);
		const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);

		const pngImage = await pdfDoc.embedPng(encodePng(image));
		pdfPage.drawImage(pngImage, { x: 0, y: 0, width: widthPts, height: heightPts });

		for (const element of page.recognitionElements) {
			if (element.type !== 'Text') continue;

			for (const word of element.words) {
				const box = word['bounding-box'];
				if (!box) continue;

				const label = decodeURIComponent(escape(word.label));
				if (!label) continue;

				const xPx = box.x * RECOGNITION_COORDINATE_SCALE;
				const yPx = box.y * RECOGNITION_COORDINATE_SCALE;
				const widthPx = box.width * RECOGNITION_COORDINATE_SCALE;
				const heightPx = box.height * RECOGNITION_COORDINATE_SCALE;

				const boxWidthPts = widthPx * pointsPerPixel;
				const boxHeightPts = heightPx * pointsPerPixel;
				const x = xPx * pointsPerPixel;
				// PDF's y-axis runs bottom-up; recognition boxes are top-down.
				const y = heightPts - (yPx * pointsPerPixel + boxHeightPts);

				// Shrink the font to fit the recognized word's box width, since
				// cursive handwriting compresses to a narrower printed word.
				try {
					const naturalWidth = font.widthOfTextAtSize(label, boxHeightPts);
					const fontSize = naturalWidth > boxWidthPts && naturalWidth > 0
						? boxHeightPts * (boxWidthPts / naturalWidth)
						: boxHeightPts;

					pdfPage.pushOperators(
						beginText(),
						setTextRenderingMode(TextRenderingMode.Invisible),
						setFontAndSize(fontKey, fontSize),
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

	return pdfDoc.save();
}

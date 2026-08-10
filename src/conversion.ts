import { ILayerNames, ISupernote, IRecognitionElement } from './format.js';
import { Image, ImageColorModel, decodePng } from "image-js";
import Color, { ColorInstance } from 'color';

/** The minimal layer shape `toImage` needs to rasterize a page: enough to
 * decode/composite, without the address/protocol metadata `ILayer` carries. */
export interface IRenderableLayer {
	LAYERNAME: ILayerNames;
	bitmapBuffer: Uint8Array | null;
}

/** The minimal page shape `toImage` needs to rasterize a page. Only layers
 * named in `LAYERSEQ` need to be present. */
export interface IRenderablePage extends Partial<Record<ILayerNames, IRenderableLayer>> {
	PAGESTYLE: string;
	LAYERSEQ: ILayerNames[];
}

/** The minimal note shape `toImage` needs: page pixel dimensions plus the
 * per-page layer data, without the class instance or unrelated pages/fields.
 * `ISupernote` (and its full `IPage`/`ILayer` types) satisfy this structurally,
 * so `toImage` continues to accept `ISupernote` unchanged; this narrower type
 * additionally lets a single-page slice (see `extractPageRenderData`) be
 * passed to `toImage` after being sent through a Worker's structured clone,
 * without reconstructing a fake `ISupernote`. */
export interface IRenderableNote {
	pageWidth: number;
	pageHeight: number;
	pages: IRenderablePage[];
}

/** The minimal page shape `addPdfPage`/`addTextOnlyPdfPage` need: everything
 * `IRenderablePage` carries for rasterization, plus the already-parsed
 * recognition data for the invisible searchable-text layer, without `IPage`'s
 * various protocol/address/raw-file metadata fields neither function reads.
 * `IPage` continues to satisfy this structurally, so existing callers
 * passing a full parsed `IPage` are unaffected; this only additionally lets
 * a minimal, Worker-clonable slice (see `extractPdfPageData`) be passed
 * directly, e.g. to build a whole PDF inside a Worker without reconstructing
 * a fake `IPage` there. */
export interface IPdfPage extends IRenderablePage {
	recognitionElements: IRecognitionElement[];
}

// True when the platform stores the least-significant byte of a multi-byte
// value first in memory (true for every runtime this library targets, i.e.
// x86/x64/ARM Node.js and browsers).
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Pack RGBA byte values into a single uint32 matching the platform's native
 * byte order, so writing it through a Uint32Array view produces the same
 * byte sequence [r, g, b, a] as writing the bytes individually. */
function packRGBA(r: number, g: number, b: number, a: number): number {
	return LITTLE_ENDIAN
		? (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
		: (a | (b << 8) | (g << 16) | (r << 24)) >>> 0;
}

/** Overlays `sourceImage` onto `destinationImage` in place. Both must be
 * 8-bit RGBA images of matching dimensions.
 *
 * Operates on the raw pixel buffers as packed uint32s instead of going
 * through `Image.getPixel`/`setPixel`, which allocate a fresh JS array per
 * pixel touched (two per pixel, for both reads and the write). For a
 * megapixel-scale page composited across several overlay layers, that adds
 * up to millions of short-lived array allocations; this does none. */
export function compositeImages(sourceImage: Image, destinationImage: Image) {
	if (
		sourceImage.width !== destinationImage.width ||
		sourceImage.height !== destinationImage.height
	) {
		throw new Error('Images must have the same dimensions for compositing.');
	}

	const source = sourceImage.getRawImage();
	const destination = destinationImage.getRawImage();

	if (
		source.bitDepth !== 8 ||
		destination.bitDepth !== 8 ||
		source.channels !== 4 ||
		destination.channels !== 4
	) {
		throw new Error('Compositing only supports 8-bit RGBA images.');
	}

	const sourcePixels = new Uint32Array(
		source.data.buffer,
		source.data.byteOffset,
		source.data.length / 4,
	);
	const destinationPixels = new Uint32Array(
		destination.data.buffer,
		destination.data.byteOffset,
		destination.data.length / 4,
	);

	// A fully-transparent RGBA pixel is 0 regardless of platform byte order,
	// so "is this pixel fully transparent" is just a zero check on the
	// packed value; anything non-zero overwrites the destination.
	for (let i = 0; i < sourcePixels.length; i++) {
		const sourcePixel = sourcePixels[i];
		if (sourcePixel !== 0) {
			destinationPixels[i] = sourcePixel;
		}
	}
}

/** Bicubic-resizes an 8-bit RGBA image up by `factor`, without the color
 * fringing a naive resize would produce at ink/transparent edges:
 * flattenToWhite()'s own comment below notes background pixels are packed
 * as black at alpha 0, since nothing normally looks at their color. A plain
 * resize interpolates color and alpha channels independently, so it *would*
 * look at that stored black and blend it into partially-transparent edge
 * pixels - darkening non-black ink (white highlighter, gray marker) right
 * where anti-aliasing should be smoothing it, not tinting it. Premultiplying
 * by alpha before the resize and dividing it back out after (standard
 * "premultiplied alpha" compositing) keeps interpolated color anchored to
 * the actual ink color instead of the meaningless color underneath it. */
export function upscaleImage(image: Image, factor: number): Image {
	const { width, height, data, channels, bitDepth } = image.getRawImage();
	if (bitDepth !== 8 || channels !== 4) {
		throw new Error('upscale only supports 8-bit RGBA images.');
	}

	const premultiplied = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3];
		premultiplied[i] = Math.round((data[i] * alpha) / 255);
		premultiplied[i + 1] = Math.round((data[i + 1] * alpha) / 255);
		premultiplied[i + 2] = Math.round((data[i + 2] * alpha) / 255);
		premultiplied[i + 3] = alpha;
	}

	const resized = new Image(width, height, { colorModel: ImageColorModel.RGBA, data: premultiplied }).resize({
		xFactor: factor,
		yFactor: factor,
		preserveAspectRatio: false,
		interpolationType: 'bicubic',
	});

	const raw = resized.getRawImage();
	const out = new Uint8Array(raw.data.length);
	for (let i = 0; i < raw.data.length; i += 4) {
		const alpha = raw.data[i + 3];
		if (alpha === 0) {
			out[i] = out[i + 1] = out[i + 2] = 0;
		} else {
			out[i] = Math.min(255, Math.round((raw.data[i] * 255) / alpha));
			out[i + 1] = Math.min(255, Math.round((raw.data[i + 1] * 255) / alpha));
			out[i + 2] = Math.min(255, Math.round((raw.data[i + 2] * 255) / alpha));
		}
		out[i + 3] = alpha;
	}

	return new Image(raw.width, raw.height, { colorModel: ImageColorModel.RGBA, data: out });
}

/** Flattens an image with an alpha channel onto an opaque white background,
 * producing a plain image (RGB, or GREY for a GREYA source) with no alpha
 * channel at all - for a destination (e.g. a PDF page, see
 * addPdfPage()/toPdf()) that has no "behind" for a transparent pixel to
 * show, unlike an on-screen `<img>` sitting over a page background.
 *
 * This is *not* the same as just discarding the alpha channel
 * (`convertColor()` to a non-alpha model, which keeps each pixel's existing
 * color channels untouched and only drops alpha): background/unwritten
 * pixels here are packed with their color channels at 0 - i.e. black - and
 * alpha at 0 (see RattaRLEDecoder.buildPackedTranslation()), specifically
 * *because* nothing ever looks at their color when alpha is respected. Only
 * actually blending each pixel toward white by its own alpha (standard
 * "flatten onto a background color" alpha compositing) gives the right
 * result for both fully-transparent (-> white) and fully-opaque (-> its own
 * color, unchanged) pixels, and everything anti-aliased in between; simply
 * dropping alpha would instead reveal every background pixel's *actual*
 * stored color - black - as if it had been solid ink all along. */
export function flattenToWhite(image: Image): Image {
	if (!image.alpha) return image;

	const { width, height, data, channels } = image.getRawImage();
	const colorChannels = channels - 1;
	const out = new Uint8Array(width * height * colorChannels);

	for (let i = 0, o = 0; i < data.length; i += channels, o += colorChannels) {
		const alpha = data[i + colorChannels] / 255;
		for (let c = 0; c < colorChannels; c++) {
			out[o + c] = Math.round(data[i + c] * alpha + 255 * (1 - alpha));
		}
	}

	const colorModel = image.colorModel === 'RGBA' ? ImageColorModel.RGB : ImageColorModel.GREY;
	return new Image(width, height, { colorModel, data: out });
}

export interface ToImageOptions {
	/** Downsample factor (positive integer, default 1 = full resolution).
	 * Output pages are `ceil(pageWidth / scale)` x `ceil(pageHeight / scale)`.
	 * At `scale > 1`, each layer is decoded directly at the reduced
	 * resolution via `RattaRLEDecoder.decodeAtScale` rather than decoded at
	 * full resolution and downscaled afterward, so a full `pageWidth` x
	 * `pageHeight` buffer is never allocated -- meant for cheap thumbnails
	 * on memory-constrained devices, see
	 * https://github.com/philips/supernote-typescript/issues/40. */
	scale?: number;
	/** Smooth upscale factor (finite number >= 1, default 1 = no upscaling).
	 * Applied via upscaleImage() as a bicubic resize *after* decoding/
	 * compositing, not by decoding at a higher resolution - Supernote's
	 * layers are fixed-resolution rasters (decodeAtScale samples them, it
	 * doesn't invent detail), so there's nothing extra to recover, only
	 * visible stair-stepping on stroke edges to soften. Mirrors Ratta's own
	 * "200%" export option; combines with `scale` (applied on top of
	 * whatever resolution `scale` decoded at), see
	 * https://github.com/philips/supernote-obsidian-plugin/issues/212.
	 * The bicubic resize is real per-pixel CPU work (~10s for a single
	 * full-resolution Manta page at `upscale: 1.5` on a dev laptop) -- fine
	 * for an on-demand export, not something to run on every page of a
	 * scrolling viewer. */
	upscale?: number;
}

/**
 * Convert a Supernote file to one or more image-js image objects.
 * @param note Parsed Supernote, or the minimal `IRenderableNote` slice
 * produced by `extractPageRenderData` (e.g. when rendering off-main-thread).
 * @param pageNumbers Optional page numbers to export (defaults to all). Indexing starts at 1.
 * @param options See `ToImageOptions`.
 */
export function toImage(note: IRenderableNote, pageNumbers?: number[], options?: ToImageOptions) {
	const scale = options?.scale ?? 1;
	if (!Number.isInteger(scale) || scale < 1) {
		throw new RangeError(`scale must be a positive integer, received ${scale}`);
	}
	const upscale = options?.upscale ?? 1;
	if (!Number.isFinite(upscale) || upscale < 1) {
		throw new RangeError(`upscale must be a number >= 1, received ${upscale}`);
	}
	const outWidth = Math.ceil(note.pageWidth / scale);
	const outHeight = Math.ceil(note.pageHeight / scale);

	const pages = pageNumbers
		? pageNumbers.map((n) => note.pages[n - 1])
		: note.pages;
	const decoder = new RattaRLEDecoder();
	return Promise.all(
		pages.map(async (page) => {
			const overlays = page.LAYERSEQ.map((name) => page[name] as IRenderableLayer).filter(
				(layer) => layer.bitmapBuffer !== null && layer.bitmapBuffer.length,
			);

			const promises = overlays.map(async (layer): Promise<Image> => {
				if (
					layer.LAYERNAME == 'BGLAYER' &&
					page.PAGESTYLE.startsWith('user_')
				) {
					// User-uploaded background templates are arbitrary PNGs and may
					// decode to any bit depth/color model (e.g. 8-bit RGB with no
					// alpha channel). compositeImages() requires 8-bit RGBA on both
					// sides, so normalize regardless of the source PNG's format.
					let image = decodePng(layer.bitmapBuffer as Uint8Array)
						.convertBitDepth(8)
						.convertColor(ImageColorModel.RGBA);
					if (scale > 1) {
						// Matches the RLE layers' output size exactly (see below) so
						// compositeImages()' equal-dimensions requirement still holds.
						image = image.resize({ width: outWidth, height: outHeight, preserveAspectRatio: false });
					}
					return image;
				}
				if (scale === 1) {
					const buffer = decoder.decode(
						layer.bitmapBuffer as Uint8Array,
						note.pageWidth,
						note.pageHeight,
					);
					return new Image(note.pageWidth, note.pageHeight, { colorModel: ImageColorModel.RGBA, data: buffer });
				}
				const decoded = decoder.decodeAtScale(
					layer.bitmapBuffer as Uint8Array,
					note.pageWidth,
					note.pageHeight,
					scale,
				);
				return new Image(decoded.width, decoded.height, { colorModel: ImageColorModel.RGBA, data: decoded.data });
			});

			let images = await Promise.all(promises);
			images = images.reverse();
			const output = images[0].clone();
			for (let i = 1; i < overlays.length; i++) {
				compositeImages(images[i], output);
			}

			return upscale === 1 ? output : upscaleImage(output, upscale);
		}),
	);
}

/**
 * Extracts the minimal, structured-clone-safe slice of `note` needed to
 * render page `pageNumber` off-main-thread (e.g. posted to a Web Worker or
 * `worker_threads` worker), without cloning the whole note (every other
 * page's buffers, or the `SupernoteX` instance and its methods, which don't
 * survive structured clone). Feed the result straight back into `toImage`:
 * `toImage(extractPageRenderData(note, n), [1])`.
 * @param note Parsed Supernote.
 * @param pageNumber Page number to extract (1-indexed).
 */
export function extractPageRenderData(note: ISupernote, pageNumber: number): IRenderableNote {
	const page = note.pages[pageNumber - 1];
	const renderablePage: IRenderablePage = {
		PAGESTYLE: page.PAGESTYLE,
		LAYERSEQ: page.LAYERSEQ,
	};
	for (const name of page.LAYERSEQ) {
		const layer = page[name];
		renderablePage[name] = { LAYERNAME: layer.LAYERNAME, bitmapBuffer: layer.bitmapBuffer };
	}
	return {
		pageWidth: note.pageWidth,
		pageHeight: note.pageHeight,
		pages: [renderablePage],
	};
}

/**
 * Same as `extractPageRenderData`, but for building a PDF page (see
 * `IPdfPage`) rather than just rasterizing one: additionally carries the
 * recognized-text data `addPdfPage`/`addTextOnlyPdfPage` need for the
 * invisible searchable-text layer. Lets a whole PDF be assembled
 * off-main-thread (e.g. inside a Worker, alongside `createPdfContext` +
 * `addPdfPage` there too - `pdf-lib` itself has no DOM dependency and runs
 * fine in a Worker; only its *objects* aren't structured-clone-safe, so the
 * whole `createPdfContext`-through-`save()` sequence has to happen in one
 * place; see the Worker's own comment for why that matters for keeping a
 * host UI responsive during a large export).
 * @param note Parsed Supernote.
 * @param pageNumber Page number to extract (1-indexed).
 */
export function extractPdfPageData(note: ISupernote, pageNumber: number): { pageWidth: number; pageHeight: number; pages: IPdfPage[] } {
	const page = note.pages[pageNumber - 1];
	const pdfPage: IPdfPage = {
		PAGESTYLE: page.PAGESTYLE,
		LAYERSEQ: page.LAYERSEQ,
		recognitionElements: page.recognitionElements,
	};
	for (const name of page.LAYERSEQ) {
		const layer = page[name];
		pdfPage[name] = { LAYERNAME: layer.LAYERNAME, bitmapBuffer: layer.bitmapBuffer };
	}
	return {
		pageWidth: note.pageWidth,
		pageHeight: note.pageHeight,
		pages: [pdfPage],
	};
}

/** Color palette to use as substitutes for the Supernote's colors. */
export interface IColorPalette extends Record<string, ColorInstance> {
	background: ColorInstance;
	black: ColorInstance;
	darkGray: ColorInstance;
	gray: ColorInstance;
	white: ColorInstance;
	markerBlack: ColorInstance;
	markerDarkGray: ColorInstance;
	markerGray: ColorInstance;

	darkGrayX2: ColorInstance;
	grayX2: ColorInstance;
	markerDarkGrayX2: ColorInstance;
	markerGrayX2: ColorInstance;
}

/** Default color palette to use based on named colors in the color library. */
const defaultPalette: IColorPalette = {
	background: Color('transparent'),
	black: Color('black'),
	// NOTE: CSS 'gray' (128,128,128) is darker than CSS 'darkgray' (169,169,169),
	// so the named colors are swapped here to match darkGray < gray in lightness.
	darkGray: Color('gray'),
	gray: Color('darkgray'),
	white: Color('white'),
	markerBlack: Color('black'),
	markerDarkGray: Color('gray'),
	markerGray: Color('darkgray'),

	darkGrayX2: Color('gray'),
	grayX2: Color('darkgray'),
	markerDarkGrayX2: Color('gray'),
	markerGrayX2: Color('darkgray'),
};

/** An encoded color palette as found in the Supernote's file buffer. */
export interface IEncodedPalette extends Record<string, number> {
	black: number;
	background: number;
	darkGray: number;
	gray: number;
	white: number;
	markerBlack: number;
	markerDarkGray: number;
	markerGray: number;

	darkGrayX2: number;
	grayX2: number;
	markerDarkGrayX2: number;
	markerGrayX2: number;
}

/** Decoder for the Ratta RLE protocol. */
export class RattaRLEDecoder {
	encodedPalette: IEncodedPalette = {
		black: 0x61,
		background: 0x62,
		darkGray: 0x63,
		gray: 0x64,
		white: 0x65,
		markerBlack: 0x66,
		markerDarkGray: 0x67,
		markerGray: 0x68,

		darkGrayX2: 0x9d,
		grayX2: 0xc9,
		markerDarkGrayX2: 0x9e,
		markerGrayX2: 0xca,
	};
	specialLengthMarker = 0xff;
	specialLength = 0x4000;
	specialLengthForBlank = 0x400;

	/**
	 * @param buffer Input buffer following Ratta RLE protocol.
	 * @param width Page width.
	 * @param height Page height.
	 * @param palette Optionally custom palette.
	 * @param allBlank Blank toggle.
	 * @returns Decoded buffer.
	 * Adopted from https://github.com/jya-dev/supernote-tool.
	 */
	decode(
		buffer: Uint8Array,
		width: number,
		height: number,
		palette?: IColorPalette,
		allBlank = false,
	) {
		const pal = palette ?? defaultPalette;
		const translation = this.buildPackedTranslation(pal);

		const totalPixels = width * height;
		const expectedLength = totalPixels * 4;
		const result = new Uint8Array(expectedLength);
		const pixels = new Uint32Array(result.buffer);

		const cursor = this._walkRuns(buffer, totalPixels, allBlank, (cursor, color, length) =>
			this.fillRun(pixels, cursor, color, length, translation),
		);

		if (cursor !== totalPixels)
			throw new Error(
				`Uint8Array length ${cursor * 4} doesn't match expected length ${expectedLength}.`,
			);
		return result;
	}

	/**
	 * Like `decode`, but samples directly at a reduced resolution instead of
	 * decoding a full `width` x `height` buffer and downscaling afterward, so
	 * the full-resolution buffer is never allocated -- for cheap thumbnails
	 * on memory-constrained devices, see
	 * https://github.com/philips/supernote-typescript/issues/40. Uses
	 * nearest-neighbor sampling: output pixel `(x, y)` takes the color of
	 * full-resolution pixel `(x * factor, y * factor)`.
	 * @param buffer Input buffer following Ratta RLE protocol.
	 * @param width Full-resolution page width.
	 * @param height Full-resolution page height.
	 * @param factor Downsample factor (positive integer). `1` samples every
	 * pixel -- equivalent to, but slower than, `decode` itself, so prefer
	 * `decode` directly at factor `1`.
	 * @param palette Optionally custom palette.
	 * @param allBlank Blank toggle.
	 * @returns Decoded buffer sized `ceil(width / factor)` x
	 * `ceil(height / factor)` (not necessarily an exact divisor of the input
	 * dimensions), plus those output dimensions.
	 */
	decodeAtScale(
		buffer: Uint8Array,
		width: number,
		height: number,
		factor: number,
		palette?: IColorPalette,
		allBlank = false,
	): { data: Uint8Array; width: number; height: number } {
		if (!Number.isInteger(factor) || factor < 1) {
			throw new RangeError(`factor must be a positive integer, received ${factor}`);
		}
		const outWidth = Math.ceil(width / factor);
		const outHeight = Math.ceil(height / factor);

		const pal = palette ?? defaultPalette;
		const translation = this.buildPackedTranslation(pal);

		const totalPixels = width * height;
		const outResult = new Uint8Array(outWidth * outHeight * 4);
		const outPixels = new Uint32Array(outResult.buffer);

		const cursor = this._walkRuns(buffer, totalPixels, allBlank, (cursor, color, length) =>
			this.fillRunAtScale(outPixels, outWidth, width, totalPixels, factor, cursor, length, color, translation),
		);

		if (cursor !== totalPixels)
			throw new Error(
				`Uint8Array length ${cursor * 4} doesn't match expected length ${totalPixels * 4}.`,
			);
		return { data: outResult, width: outWidth, height: outHeight };
	}

	/** Walks `buffer`'s encoded (color, length) runs following Ratta RLE's
	 * two-byte length-extension scheme, invoking `fill(cursor, color,
	 * length)` for each run in turn and threading its return value through
	 * as the next cursor. Shared by `decode` and `decodeAtScale` so both
	 * stay in sync with this parsing logic; only how a run gets written
	 * (`fillRun` vs. `fillRunAtScale`) differs between them.
	 * @param totalPixels Full-resolution pixel count (`width * height`),
	 * needed to size the trailing run correctly regardless of any
	 * downsampling `fill` itself does.
	 * @returns The final cursor, which callers compare against
	 * `totalPixels` to confirm the buffer decoded to the expected size.
	 */
	private _walkRuns(
		buffer: Uint8Array,
		totalPixels: number,
		allBlank: boolean,
		fill: (cursor: number, color: number, length: number) => number,
	): number {
		let cursor = 0;
		let waiting: [number, number][] = [];
		let holder: [number, number] | null = null;
		let color: number;
		let length: number;
		for (let index = 1; index < buffer.length; index += 2) {
			color = buffer.at(index - 1) as number;
			length = buffer.at(index) as number;
			let pushed = false;

			if (holder !== null) {
				const [prevColor, holderLength] = holder as [number, number];
				let prevLength = holderLength;
				holder = null;
				if (color === prevColor) {
					length = 1 + length + (((prevLength & 0x7f) + 1) << 7);
					waiting.push([color, length]);
					pushed = true;
				} else {
					prevLength = ((prevLength & 0x7f) + 1) << 7;
					waiting.push([prevColor, prevLength]);
				}
			}

			if (!pushed) {
				if (length === this.specialLengthMarker) {
					if (allBlank) length = this.specialLengthForBlank;
					else length = this.specialLength;
					waiting.push([color, length]);
				} else if ((length & 0x80) !== 0) {
					holder = [color, length];
				} else {
					length += 1;
					waiting.push([color, length]);
				}
			}
			for (const [runColor, runLength] of waiting.values()) {
				cursor = fill(cursor, runColor, runLength);
			}
			waiting = [];
		}

		if (holder !== null) {
			[color, length] = holder as [number, number];
			length = this.adjustTailLength(length, cursor * 4, totalPixels * 4);
			if (length > 0) {
				cursor = fill(cursor, color, length);
			}
		}

		return cursor;
	}

	/** Fills `length` pixels starting at `cursor` with the color for
	 * `encodedColor`, and returns the cursor advanced past the run. */
	fillRun(
		pixels: Uint32Array,
		cursor: number,
		encodedColor: number,
		length: number,
		translation: Record<number, number>,
	): number {
		const packed = translation[encodedColor] ?? this.unknownColorPacked;
		// Guard against malformed input requesting more pixels than the
		// output buffer has room for; the length mismatch is caught by the
		// caller once the whole buffer has been walked.
		const end = Math.min(cursor + length, pixels.length);
		pixels.fill(packed, cursor, end);
		return cursor + length;
	}

	/** Like `fillRun`, but writes into a `factor`-downsampled output buffer
	 * instead of a full `fullWidth` x (`totalPixels`/`fullWidth`) one, only
	 * computing/writing the sample pixels (nearest-neighbor, the top-left
	 * corner of each `factor` x `factor` block) that fall within this run --
	 * skipping whole sample rows/columns between them arithmetically rather
	 * than iterating every full-resolution pixel the run covers, so the cost
	 * of a run scales with the *output* pixels it contains, not the
	 * full-resolution ones. */
	fillRunAtScale(
		outPixels: Uint32Array,
		outWidth: number,
		fullWidth: number,
		totalPixels: number,
		factor: number,
		cursor: number,
		length: number,
		encodedColor: number,
		translation: Record<number, number>,
	): number {
		const packed = translation[encodedColor] ?? this.unknownColorPacked;
		const start = cursor;
		// Mirrors fillRun's clamp against the full-resolution pixel count
		// (there, `pixels.length`), even though nothing here is actually
		// sized to totalPixels -- it's just the bound for what full-res rows
		// this run could possibly touch.
		const end = Math.min(cursor + length, totalPixels);

		if (start < end) {
			const rowStart = Math.floor(start / fullWidth);
			const rowEndInclusive = Math.floor((end - 1) / fullWidth);
			const firstSampleRow = Math.ceil(rowStart / factor) * factor;
			for (let row = firstSampleRow; row <= rowEndInclusive; row += factor) {
				const rowLinearStart = row * fullWidth;
				const rowLinearEnd = rowLinearStart + fullWidth;
				const segStart = Math.max(start, rowLinearStart);
				const segEnd = Math.min(end, rowLinearEnd);
				if (segStart >= segEnd) continue;

				const colStart = segStart - rowLinearStart;
				const colEndInclusive = segEnd - 1 - rowLinearStart;
				const firstSampleCol = Math.ceil(colStart / factor) * factor;
				const outRowBase = (row / factor) * outWidth;
				for (let col = firstSampleCol; col <= colEndInclusive; col += factor) {
					outPixels[outRowBase + col / factor] = packed;
				}
			}
		}

		return cursor + length;
	}

	/** RGBA used for encoded colors outside the known palette: fully
	 * transparent, matching the previous per-pixel fallback. */
	private readonly unknownColorPacked = packRGBA(255, 255, 255, 0);

	/** Precomputes a packed RGBA uint32 per encoded palette byte, so the hot
	 * decode loop never touches the `color` library. */
	buildPackedTranslation(pal: IColorPalette): Record<number, number> {
		const translation: Record<number, number> = {};
		for (const [key, encodedColor] of Object.entries(this.encodedPalette)) {
			const resolved = pal[key] ?? defaultPalette[key];
			translation[encodedColor] =
				resolved.alpha() === 0
					? packRGBA(0, 0, 0, 0)
					: packRGBA(...(resolved.rgb().array() as [number, number, number]), ~~(255 * resolved.alpha()));
		}
		return translation;
	}

	adjustTailLength(
		tailLength: number,
		uncompressedLength: number,
		expectedLength: number,
	): number {
		const gap = expectedLength - uncompressedLength;
		let length: number;
		for (let i = 7; i >= 0; i--) {
			length = ((tailLength & 0x7f) + 1) << i;
			if (length <= gap) {
				return length;
			}
		}
		return 0;
	}
}

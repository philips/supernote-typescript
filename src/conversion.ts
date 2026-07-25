import { ILayer, ISupernote } from './format';
import { Image, ImageColorModel, decodePng } from "image-js";
import Color, { ColorInstance } from 'color';

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
function compositeImages(sourceImage: Image, destinationImage: Image) {
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

/**
 * Convert a Supernote file to one or more image-js image objects.
 * @param note Parsed Supernote.
 * @param pageNumbers Optional page numbers to export (defaults to all). Indexing starts at 1.
 */
export function toImage(note: ISupernote, pageNumbers?: number[]) {
	const pages = pageNumbers
		? pageNumbers.map((n) => note.pages[n - 1])
		: note.pages;
	const decoder = new RattaRLEDecoder();
	return Promise.all(
		pages.map(async (page) => {
			const overlays = page.LAYERSEQ.map((name) => page[name] as ILayer).filter(
				(layer) => layer.bitmapBuffer !== null && layer.bitmapBuffer.length,
			);

			const promises = overlays.map(async (layer): Promise<Image> => {
				if (
					layer.LAYERNAME == 'BGLAYER' &&
					page.PAGESTYLE.startsWith('user_')
				) {
					return decodePng(layer.bitmapBuffer as Uint8Array);
				}
				const buffer = decoder.decode(
					layer.bitmapBuffer as Uint8Array,
					note.pageWidth,
					note.pageHeight,
				);
				return new Image(note.pageWidth, note.pageHeight, { colorModel: ImageColorModel.RGBA, data: buffer });
			});

			let images = await Promise.all(promises);
			images = images.reverse();
			const output = images[0].clone();
			for (let i = 1; i < overlays.length; i++) {
				compositeImages(images[i], output);
			}

			return output;
		}),
	);
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
				cursor = this.fillRun(pixels, cursor, runColor, runLength, translation);
			}
			waiting = [];
		}

		if (holder !== null) {
			[color, length] = holder as [number, number];
			length = this.adjustTailLength(length, cursor * 4, expectedLength);
			if (length > 0) {
				cursor = this.fillRun(pixels, cursor, color, length, translation);
			}
		}

		if (cursor !== totalPixels)
			throw new Error(
				`Uint8Array length ${cursor * 4} doesn't match expected length ${expectedLength}.`,
			);
		return result;
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

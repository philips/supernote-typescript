/**
 * Prototype `.note` writer.
 *
 * Emits the minimal file layout current Supernote firmware writes for a fresh
 * note (`noteSN_FILE_VER_20260016`, `APPLY_EQUIPMENT:N5`, 1920x2560 page
 * coordinates -- what both the Manta and, on current firmware, the Nomad
 * create), mirroring a pristine device-created note block for block:
 *
 *   signature | header | BG bitmap | per page: MAIN bitmap, MAINLAYER,
 *   BGLAYER, page | footer | "tail" | footer address
 *
 * Every block is a 4-byte little-endian length followed by its bytes; every
 * address is the absolute file offset of a block's length prefix.
 *
 * Scope: one visible layer (MAINLAYER) of raster ink over the blank white
 * template, plus optional text boxes. A device text box (firmware Chauvet
 * 2608, `SN_FILE_VER_20260016`) is three things, all of which are written:
 *
 * - a `TOTALPATH` record: a 5-point closed rectangle with `stroke_kind`
 *   `"0000"` whose trailing string holds the box's Unicode text, rect, font
 *   and style as base64 CSV -- the device's editable source of truth;
 * - its rendered pixels in MAINLAYER -- what non-device renderers show;
 * - its rect in the page's `DISABLE` list with `PAGETEXTBOX:1`.
 *
 * A box with pixels but no record is shown by the device, but is dropped the
 * moment the device redraws the page's text boxes (e.g. when the user adds
 * one of their own). No strokes, recognition, titles, links, keywords, or
 * other templates.
 */

/** Encoded Ratta RLE color bytes this writer emits. */
export const RattaColor = {
	black: 0x61,
	/** Transparent: lets the layer below show through. */
	background: 0x62,
	/** Dark gray as written by current (X2-era) firmware; decodes to 157. */
	darkGray: 0x9d,
	/** Light gray as written by current (X2-era) firmware; decodes to 201. */
	gray: 0xc9,
	white: 0x65,
} as const;

const SIGNATURE = 'noteSN_FILE_VER_20260016';
const RUN_MAX_SPECIAL = 0x4000;
const RUN_MAX_SHORT = 0x80;

export const WRITER_PAGE_WIDTH = 1920;
export const WRITER_PAGE_HEIGHT = 2560;

/** The page template the writer uses: the device's blank white page. */
const PAGE_STYLE = 'style_white_a5x2';

/** Verbatim from a device-created page: Main + Background layers present,
 * Layers 1-3 deleted. */
const LAYER_INFO =
	'[{"layerId"#3,"name"#"Layer 3","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#true,"isAllowUp"#false,"isAllowDown"#false},' +
	'{"layerId"#2,"name"#"Layer 2","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#true,"isAllowUp"#false,"isAllowDown"#false},' +
	'{"layerId"#1,"name"#"Layer 1","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#true,"isAllowUp"#false,"isAllowDown"#false},' +
	'{"layerId"#0,"name"#"Main Layer","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#true,"isVisible"#true,"isDeleted"#false,"isAllowUp"#false,"isAllowDown"#false},' +
	'{"layerId"#-1,"name"#"Background Layer","isBackgroundLayer"#true,"isAllowAdd"#true,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#false,"isAllowUp"#false,"isAllowDown"#false}]';

/** A page-pixel rectangle. */
export interface IRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A text box: its page rect plus, optionally, the text the device should
 * treat as its editable content (without it the box is raster-only). */
export interface WritableTextBox extends IRect {
	text?: string;
	/** Font size in page pixels, as the device's text-box font size. Default 48. */
	fontSize?: number;
	/** Line advance in page pixels. Default 63, the device's for size 48. */
	lineHeight?: number;
}

export interface WritablePage {
	/**
	 * MAINLAYER pixels: one encoded Ratta color byte (see `RattaColor`) per
	 * pixel, row-major, `WRITER_PAGE_WIDTH * WRITER_PAGE_HEIGHT` long.
	 * Omitted means a blank (fully transparent) layer.
	 */
	mainLayer?: Uint8Array;
	/** Text boxes, written as `DISABLE` rectangles plus (when they carry
	 * `text`) editable `TOTALPATH` text-box records. Their pixels belong in
	 * `mainLayer`. */
	textBoxes?: WritableTextBox[];
	/** Explicit page ID (tests); generated when omitted. */
	pageId?: string;
}

export interface WriteNoteOptions {
	pages: WritablePage[];
	/** Explicit file ID (tests); generated when omitted. */
	fileId?: string;
	/** Clock for generated IDs. */
	now?: Date;
	/** Random source in [0, 1) for generated IDs. */
	random?: () => number;
}

/**
 * Encodes one encoded color byte per pixel as Ratta RLE, using the same run
 * forms the device writes: `(color, 0xff)` for 0x4000-pixel runs, a two-pair
 * `(color, 0x80|hi) (color, lo)` for 129..16383 pixels, and `(color, n-1)`
 * for 1..128 pixels.
 */
export function encodeRattaRle(pixels: Uint8Array): Uint8Array {
	const out: number[] = [];
	let i = 0;
	while (i < pixels.length) {
		const color = pixels[i];
		let end = i + 1;
		while (end < pixels.length && pixels[end] === color) end++;
		let n = end - i;
		i = end;
		while (n >= RUN_MAX_SPECIAL) {
			out.push(color, 0xff);
			n -= RUN_MAX_SPECIAL;
		}
		if (n === 0) continue;
		if (n <= RUN_MAX_SHORT) {
			out.push(color, n - 1);
		} else {
			// n = 1 + lo + (hi + 1) * 128, hi in 0..126 so 0x80|hi never
			// collides with the 0xff special-length marker.
			const hi = Math.floor((n - 1) / RUN_MAX_SHORT) - 1;
			const lo = (n - 1) % RUN_MAX_SHORT;
			out.push(color, 0x80 | hi, color, lo);
		}
	}
	return Uint8Array.from(out);
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates a device-style ID: prefix, `yyyyMMddHHmmssSSS`, three more
 * digits, then 12 random alphanumerics (e.g.
 * `P20260922115611225954fC6CMr1DUYjH`).
 */
export function generateNoteId(prefix: 'F' | 'P', now = new Date(), random: () => number = Math.random): string {
	const pad = (value: number, width: number) => String(value).padStart(width, '0');
	const stamp =
		pad(now.getFullYear(), 4) +
		pad(now.getMonth() + 1, 2) +
		pad(now.getDate(), 2) +
		pad(now.getHours(), 2) +
		pad(now.getMinutes(), 2) +
		pad(now.getSeconds(), 2) +
		pad(now.getMilliseconds(), 3) +
		pad(Math.floor(random() * 1000), 3);
	let suffix = '';
	for (let i = 0; i < 12; i++) suffix += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
	return prefix + stamp + suffix;
}

/** The digitizer range the device stamps on every record (`maxY`, `maxX`);
 * identical on Manta and Nomad for 1920x2560 files. */
const DIGITIZER_MAX_Y = 21632;
const DIGITIZER_MAX_X = 16224;
const DEVICE_TEXT_FONT = '/system/fonts/DroidSansFallbackFull.ttf';

const base64 = (value: string): string => {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/** Little-endian byte sink for binary records. */
class ByteSink {
	private readonly bytes: number[] = [];

	u8(value: number): this {
		this.bytes.push(value & 0xff);
		return this;
	}

	u32(value: number): this {
		const view = new DataView(new ArrayBuffer(4));
		view.setUint32(0, value >>> 0, true);
		return this.raw(new Uint8Array(view.buffer));
	}

	i32(value: number): this {
		return this.u32(value | 0);
	}

	f32(value: number): this {
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, value, true);
		return this.raw(new Uint8Array(view.buffer));
	}

	f64(value: number): this {
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value, true);
		return this.raw(new Uint8Array(view.buffer));
	}

	/** A NUL-padded fixed-width C string. */
	cstr(value: string, width: number): this {
		const encoded = new TextEncoder().encode(value);
		if (encoded.length >= width) throw new RangeError(`${value} does not fit in ${width} bytes`);
		this.raw(encoded);
		for (let i = encoded.length; i < width; i++) this.u8(0);
		return this;
	}

	/** A u32 length followed by the bytes. */
	sized(value: string): this {
		const encoded = new TextEncoder().encode(value);
		return this.u32(encoded.length).raw(encoded);
	}

	raw(bytes: Uint8Array): this {
		for (const byte of bytes) this.bytes.push(byte);
		return this;
	}

	get length(): number {
		return this.bytes.length;
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.bytes);
	}
}

/**
 * Encodes one text box as the `TOTALPATH` record the device writes for it.
 * Field layout per `plans/vector-format-spec.md`; the values of the fields
 * that spec leaves unexplained are copied from device-created text boxes.
 */
export function encodeTextBoxRecord(
	box: WritableTextBox & { text: string },
	options: { pageNumber: number; trailNumber: number; id: string },
): Uint8Array {
	const { x, y, width, height } = box;
	const right = x + width - 1;
	const bottom = y + height - 1;
	const scale = DIGITIZER_MAX_Y / WRITER_PAGE_HEIGHT;
	const rawX = (px: number) => Math.round((WRITER_PAGE_WIDTH - px) * scale);
	const rawY = (py: number) => Math.round(py * scale);
	const fontSize = box.fontSize ?? 48;
	const lineHeight = box.lineHeight ?? 63;
	const rect = formatRect(box);
	const fields = [
		'0',
		'0',
		'0',
		options.id,
		rect,
		rect,
		'none',
		'none',
		'none',
		'0',
		fontSize.toFixed(6),
		DEVICE_TEXT_FONT,
		box.text,
		// Style: bold/italic/alignment/spacing flags as a wrapping box writes them.
		'0,0,0,0.000000,0.000000,1.000000,0,1,0,0,0,0,0,3,0,255,255,0,',
		String(Math.round(lineHeight)),
		'1',
		'1',
		'0',
		'none',
	];
	// Pixel corners (the rendered contour: inclusive right/bottom pixels) and
	// the same rectangle's continuous edges in digitizer units for the points.
	const corners: [number, number][] = [
		[x, bottom],
		[right, bottom],
		[right, y],
		[x, y],
		[x, bottom],
	];
	const rawCorners: [number, number][] = [
		[x, y + height],
		[x + width, y + height],
		[x + width, y],
		[x, y],
		[x, y + height],
	];

	const sink = new ByteSink();
	// StrokeConfig (208 bytes).
	sink.u32(0).u32(0).u32(100).u32(0).u32(32).u32(32).u32(0).u32(options.pageNumber);
	sink.u32(0).u32(0).i32(0).u32(0).cstr('0000', 52);
	// The device's "bottom-right" for a text box sits 227px past the rect.
	sink.i32(x).i32(y).i32(0).i32(0).i32(x + width + 227).i32(y + height + 227);
	sink.i32(-1).u32(DIGITIZER_MAX_Y).u32(DIGITIZER_MAX_X).cstr('name is not set', 52);
	sink.u32(1).u32(0).u32(0).u32(0).u32(0);
	// disableAreaList, then the rect as a closed 5-point path, (y, x) order.
	sink.u32(0).u32(corners.length);
	for (const [px, py] of rawCorners) sink.u32(rawY(py)).u32(rawX(px));
	sink.u32(corners.length);
	for (let i = 0; i < corners.length; i++) sink.u8(0).u8(0);
	sink.u32(corners.length);
	for (let i = 0; i < corners.length; i++) sink.u32(0);
	sink.u32(corners.length);
	for (let i = 0; i < corners.length; i++) sink.u8(1);
	sink.u32(0).u32(0); // epaPoints, epaGrays
	// section_1: trailStatus, copy, trailNumInPage, shift angles, shift rects.
	sink.i32(0).i32(30).i32(options.trailNumber).i32(0).i32(0);
	sink.i32(0).i32(0).i32(1).i32(1).i32(0).i32(0).i32(1).i32(1);
	sink.u32(0); // controlNums
	sink.u32(0).u32(0).u8(0).u8(1); // section_2: group fields, renderFlag
	sink.u32(1).u32(corners.length);
	for (const [px, py] of corners) sink.f32(px).f32(py);
	sink.u32(1);
	for (let i = 0; i < 16; i++) sink.u8(0xff);
	sink.i32(-1).f64(1).u8(0).u8(0).u8(0).u8(0).u8(0); // section_3
	sink.u32(0); // unk_22
	sink.u32(1404).u32(1872).u32(5_000_000).u8(0); // section_4
	sink.sized(fields.map(base64).join(',') + ',');
	sink.sized('none').sized('');
	sink.u32(3).u32(0); // unk_25, markPenDFillDir
	sink.u32(0).u8(0);
	return sink.finish();
}

function encodeTotalPath(records: Uint8Array[]): Uint8Array {
	const sink = new ByteSink().u32(records.length);
	for (const record of records) sink.u32(record.length).raw(record);
	return sink.finish();
}

function formatRect(rect: IRect): string {
	return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(',');
}

function assertRect(rect: IRect): void {
	const { x, y, width, height } = rect;
	if (
		![x, y, width, height].every(Number.isFinite) ||
		x < 0 ||
		y < 0 ||
		width <= 0 ||
		height <= 0 ||
		x + width > WRITER_PAGE_WIDTH ||
		y + height > WRITER_PAGE_HEIGHT
	) {
		throw new RangeError(`text box ${formatRect(rect)} is outside the page`);
	}
}

/** Accumulates length-prefixed blocks and hands back their addresses. */
class BlockWriter {
	private readonly chunks: Uint8Array[] = [];
	private offset = 0;
	private readonly encoder = new TextEncoder();

	raw(bytes: Uint8Array): void {
		this.chunks.push(bytes);
		this.offset += bytes.length;
	}

	block(content: Uint8Array | string): number {
		const bytes = typeof content === 'string' ? this.encoder.encode(content) : content;
		const address = this.offset;
		const length = new Uint8Array(4);
		new DataView(length.buffer).setUint32(0, bytes.length, true);
		this.raw(length);
		this.raw(bytes);
		return address;
	}

	finish(): Uint8Array {
		const out = new Uint8Array(this.offset);
		let at = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		return out;
	}
}

function kv(entries: [string, string | number][]): string {
	return entries.map(([key, value]) => `<${key}:${value}>`).join('');
}

/** Serializes pages into a complete `.note` file. */
export function writeNote(options: WriteNoteOptions): Uint8Array {
	const { pages } = options;
	if (pages.length === 0) throw new RangeError('a note needs at least one page');
	const now = options.now ?? new Date();
	const random = options.random ?? Math.random;
	const pixelCount = WRITER_PAGE_WIDTH * WRITER_PAGE_HEIGHT;
	const blank = new Uint8Array(pixelCount).fill(RattaColor.background);
	const encodedBlank = encodeRattaRle(blank);

	const writer = new BlockWriter();
	writer.raw(new TextEncoder().encode(SIGNATURE));
	const headerAddress = writer.block(
		kv([
			['FILE_TYPE', 'NOTE'],
			['APPLY_EQUIPMENT', 'N5'],
			['FINALOPERATION_PAGE', 1],
			['FINALOPERATION_LAYER', 1],
			['DEVICE_DPI', 0],
			['SOFT_DPI', 0],
			['FILE_PARSE_TYPE', 0],
			['RATTA_ETMD', 0],
			['FILE_ID', options.fileId ?? generateNoteId('F', now, random)],
			['FILE_RECOGN_TYPE', 0],
			['FILE_RECOGN_LANGUAGE', 'none'],
			['HORIZONTAL_CHECK', 0],
			['IS_OLD_APPLY_EQUIPMENT', 1],
			['ANTIALIASING_CONVERT', 2],
		]),
	);
	// The white template renders nothing, so its background bitmap is blank;
	// the device shares one per style via the footer's STYLE_ entry.
	const backgroundBitmap = writer.block(encodedBlank);

	const pageAddresses = pages.map((page, pageIndex) => {
		if (page.mainLayer && page.mainLayer.length !== pixelCount) {
			throw new RangeError(`mainLayer must have ${pixelCount} pixels, received ${page.mainLayer.length}`);
		}
		const textBoxes = page.textBoxes ?? [];
		textBoxes.forEach(assertRect);
		const mainBitmap = writer.block(page.mainLayer ? encodeRattaRle(page.mainLayer) : encodedBlank);
		const layer = (name: string, bitmap: number) =>
			writer.block(
				kv([
					['LAYERTYPE', 'NOTE'],
					['LAYERPROTOCOL', 'RATTA_RLE'],
					['LAYERNAME', name],
					['LAYERPATH', 0],
					['LAYERBITMAP', bitmap],
					['LAYERVECTORGRAPH', 0],
					['LAYERRECOGN', 0],
				]),
			);
		const mainLayer = layer('MAINLAYER', mainBitmap);
		const backgroundLayer = layer('BGLAYER', backgroundBitmap);
		const records = textBoxes
			.filter((box): box is WritableTextBox & { text: string } => typeof box.text === 'string')
			.map((box, index) =>
				encodeTextBoxRecord(box, {
					pageNumber: pageIndex + 1,
					trailNumber: index + 1,
					id: generateNoteId('P', now, random).slice(1, 21),
				}),
			);
		const totalPath = records.length > 0 ? writer.block(encodeTotalPath(records)) : 0;
		return writer.block(
			kv([
				['PAGESTYLE', PAGE_STYLE],
				['PAGESTYLEMD5', 0],
				['LAYERSEQ', 'MAINLAYER,BGLAYER'],
				['PAGEID', page.pageId ?? generateNoteId('P', now, random)],
				['MAINLAYER', mainLayer],
				['LAYER1', 0],
				['LAYER2', 0],
				['LAYER3', 0],
				['BGLAYER', backgroundLayer],
				['TOTALPATH', totalPath],
				['THUMBNAILTYPE', 0],
				['RECOGNSTATUS', 0],
				['RECOGNTEXT', 0],
				['RECOGNFILE', 0],
				['LAYERINFO', LAYER_INFO],
				['RECOGNTYPE', 0],
				['RECOGNFILESTATUS', 0],
				['RECOGNLANGUAGE', 'none'],
				['ORIENTATION', 1000],
				['PAGETEXTBOX', textBoxes.length > 0 ? 1 : 0],
				['DISABLE', textBoxes.length > 0 ? textBoxes.map((rect) => `${formatRect(rect)}|`).join('') : 'none'],
			]),
		);
	});

	const footerAddress = writer.block(
		kv([
			...pageAddresses.map((address, index): [string, number] => [`PAGE${index + 1}`, address]),
			['DIRTY', 0],
			['FILE_FEATURE', headerAddress],
			[`STYLE_${PAGE_STYLE}`, backgroundBitmap],
		]),
	);
	writer.raw(new TextEncoder().encode('tail'));
	const trailer = new Uint8Array(4);
	new DataView(trailer.buffer).setUint32(0, footerAddress, true);
	writer.raw(trailer);
	return writer.finish();
}

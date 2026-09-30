/**
 * Typesets plain text into `.note` text boxes for the prototype writer.
 *
 * Text is laid out with a caller-supplied TrueType/OpenType font (via
 * fontkit), rasterized with a small anti-aliased nonzero-winding scanline
 * filler, quantized to the device's black / dark-gray / gray ink bytes, and
 * placed in MAINLAYER. Each page gets one text box carrying the same text,
 * which `writeNote` turns into the device's editable text-box record plus a
 * `DISABLE` rectangle.
 *
 * The device shows our pixels until it next redraws the page's text boxes;
 * from then on it lays the record's text out itself (in
 * DroidSansFallbackFull, 48px, 63px line advance by default). Using a
 * metrically similar font here -- Droid Sans / Noto Sans -- keeps the two
 * renderings close.
 */
import fontkit from '@pdf-lib/fontkit';
import {
	RattaColor,
	WRITER_PAGE_HEIGHT,
	WRITER_PAGE_WIDTH,
	WritablePage,
	WritableTextBox,
	writeNote,
} from './writer.js';

type Font = ReturnType<typeof fontkit.create>;
/** fontkit exposes `commands` at runtime but omits it from its typings. */
type PathCommand = { command: string; args: number[] };

export interface TextBoxOptions {
	/** TrueType/OpenType font bytes used to typeset the text. */
	fontBytes: Uint8Array;
	/** Font size in page pixels (em height). Default 48, the device's default
	 * text-box size. */
	fontSize?: number;
	/** Line advance as a multiple of the font size. Default 63/48, the
	 * device's own advance for its text boxes. */
	lineHeight?: number;
	/** Page margin in page pixels. Default 150. */
	margin?: number;
	/** Quantize edge coverage to gray ink for smoother glyphs. Default true. */
	antialias?: boolean;
}

export interface CreateTextNoteOptions extends TextBoxOptions {
	text: string;
	/** Clock / randomness / IDs forwarded to `writeNote` (tests). */
	now?: Date;
	random?: () => number;
	fileId?: string;
}

interface LaidOutLine {
	/** Glyphs with their pen x offset in font units. */
	glyphs: { glyph: ReturnType<Font['getGlyph']>; x: number }[];
	width: number;
	/** The source text the line holds. */
	text: string;
	/** Whether a hard line break (end of paragraph) follows this line. */
	hard: boolean;
}

const SUBSAMPLES = 4;
const CURVE_SEGMENTS = 8;

/** Rebuilds the text a page's lines hold: soft-wrapped lines rejoin with a
 * space so the device can re-wrap them; hard breaks stay newlines. */
function pageText(lines: LaidOutLine[]): string {
	return lines.map((line, i) => line.text + (i === lines.length - 1 ? '' : line.hard ? '\n' : ' ')).join('');
}

/** Splits text into lines no wider than `maxWidth` font units. Paragraphs
 * break on `\n`; words wrap on spaces; over-long words break by glyph. */
export function layoutLines(font: Font, text: string, maxWidth: number): LaidOutLine[] {
	const lines: LaidOutLine[] = [];
	const spaceAdvance = font.layout(' ').advanceWidth;
	for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
		let current: LaidOutLine = { glyphs: [], width: 0, text: '', hard: false };
		const push = (hard = false) => {
			lines.push({ ...current, hard });
			current = { glyphs: [], width: 0, text: '', hard: false };
		};
		for (const word of paragraph.split(/ +/).filter((w) => w.length > 0)) {
			const run = font.layout(word);
			if (current.text.length > 0 && current.width + spaceAdvance + run.advanceWidth > maxWidth) push();
			if (current.text.length > 0) {
				current.width += spaceAdvance;
				current.text += ' ';
			}
			run.glyphs.forEach((glyph, index) => {
				const { xAdvance, xOffset } = run.positions[index];
				// Only a word longer than a whole line can overflow here.
				if (current.width + xAdvance > maxWidth && current.width > 0) push();
				current.glyphs.push({ glyph, x: current.width + xOffset });
				current.width += xAdvance;
				current.text += String.fromCodePoint(...glyph.codePoints);
			});
		}
		push(true);
	}
	return lines;
}

type Edge = [x0: number, y0: number, x1: number, y1: number];

/** Flattens a glyph outline (font units, y up) into page-space edges. */
function glyphEdges(
	commands: PathCommand[],
	originX: number,
	baselineY: number,
	scale: number,
	edges: Edge[],
): void {
	const tx = (x: number) => originX + x * scale;
	const ty = (y: number) => baselineY - y * scale;
	let startX = 0;
	let startY = 0;
	let penX = 0;
	let penY = 0;
	const lineTo = (x: number, y: number) => {
		if (y !== penY) edges.push([penX, penY, x, y]);
		penX = x;
		penY = y;
	};
	for (const { command, args } of commands) {
		switch (command) {
			case 'moveTo':
				if (penX !== startX || penY !== startY) lineTo(startX, startY);
				penX = startX = tx(args[0]);
				penY = startY = ty(args[1]);
				break;
			case 'lineTo':
				lineTo(tx(args[0]), ty(args[1]));
				break;
			case 'quadraticCurveTo': {
				const [cx, cy, x, y] = [tx(args[0]), ty(args[1]), tx(args[2]), ty(args[3])];
				const [x0, y0] = [penX, penY];
				for (let i = 1; i <= CURVE_SEGMENTS; i++) {
					const t = i / CURVE_SEGMENTS;
					const u = 1 - t;
					lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
				}
				break;
			}
			case 'bezierCurveTo': {
				const [c1x, c1y, c2x, c2y, x, y] = [
					tx(args[0]), ty(args[1]), tx(args[2]), ty(args[3]), tx(args[4]), ty(args[5]),
				];
				const [x0, y0] = [penX, penY];
				for (let i = 1; i <= CURVE_SEGMENTS; i++) {
					const t = i / CURVE_SEGMENTS;
					const u = 1 - t;
					lineTo(
						u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
						u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
					);
				}
				break;
			}
			case 'closePath':
				lineTo(startX, startY);
				penX = startX;
				penY = startY;
				break;
		}
	}
	if (penX !== startX || penY !== startY) lineTo(startX, startY);
}

/** Accumulates nonzero-winding coverage (0..1) of `edges` into `coverage`,
 * a `width`-wide row-major buffer, sampling `SUBSAMPLES` scanlines per pixel
 * row with exact horizontal span fractions. */
function rasterizeEdges(edges: Edge[], coverage: Float32Array, width: number, height: number): void {
	if (edges.length === 0) return;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [, y0, , y1] of edges) {
		minY = Math.min(minY, y0, y1);
		maxY = Math.max(maxY, y0, y1);
	}
	const firstRow = Math.max(0, Math.floor(minY));
	const lastRow = Math.min(height - 1, Math.ceil(maxY));
	const crossings: { x: number; dir: number }[] = [];
	const weight = 1 / SUBSAMPLES;
	for (let row = firstRow; row <= lastRow; row++) {
		for (let s = 0; s < SUBSAMPLES; s++) {
			const sy = row + (s + 0.5) / SUBSAMPLES;
			crossings.length = 0;
			for (const [x0, y0, x1, y1] of edges) {
				if ((y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy)) {
					crossings.push({ x: x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), dir: y1 > y0 ? 1 : -1 });
				}
			}
			if (crossings.length < 2) continue;
			crossings.sort((a, b) => a.x - b.x);
			let winding = 0;
			for (let i = 0; i < crossings.length - 1; i++) {
				winding += crossings[i].dir;
				if (winding === 0) continue;
				const left = Math.max(0, crossings[i].x);
				const right = Math.min(width, crossings[i + 1].x);
				if (right <= left) continue;
				const base = row * width;
				const leftPixel = Math.floor(left);
				const rightPixel = Math.floor(right);
				if (leftPixel === rightPixel) {
					coverage[base + leftPixel] += (right - left) * weight;
					continue;
				}
				coverage[base + leftPixel] += (leftPixel + 1 - left) * weight;
				for (let x = leftPixel + 1; x < rightPixel; x++) coverage[base + x] += weight;
				if (rightPixel < width) coverage[base + rightPixel] += (right - rightPixel) * weight;
			}
		}
	}
}

function quantize(value: number, antialias: boolean): number {
	if (value >= 0.5) return RattaColor.black;
	if (!antialias) return RattaColor.background;
	if (value >= 0.3) return RattaColor.darkGray;
	if (value >= 0.12) return RattaColor.gray;
	return RattaColor.background;
}

/**
 * Typesets `text` onto as many pages as it needs, one text box per page,
 * sized to the text it holds.
 */
export function layoutTextPages(text: string, options: TextBoxOptions): WritablePage[] {
	const font = fontkit.create(options.fontBytes);
	const fontSize = options.fontSize ?? 48;
	const lineHeight = Math.round(fontSize * (options.lineHeight ?? 63 / 48));
	const margin = options.margin ?? 150;
	const antialias = options.antialias ?? true;
	const scale = fontSize / font.unitsPerEm;
	const boxWidth = WRITER_PAGE_WIDTH - 2 * margin;
	const boxHeight = WRITER_PAGE_HEIGHT - 2 * margin;
	if (boxWidth <= fontSize || boxHeight < lineHeight) throw new RangeError('margin leaves no room for text');

	const lines = layoutLines(font, text, boxWidth / scale);
	// Trailing blank lines would only grow the box.
	while (lines.length > 1 && lines[lines.length - 1].glyphs.length === 0) lines.pop();
	const linesPerPage = Math.floor(boxHeight / lineHeight);
	// Center the ascent/descent box of each line within its line height.
	const ascent = font.ascent * scale;
	const descent = -font.descent * scale;
	const baselineOffset = (lineHeight - (ascent + descent)) / 2 + ascent;

	const pages: WritablePage[] = [];
	for (let start = 0; start < lines.length; start += linesPerPage) {
		const pageLines = lines.slice(start, start + linesPerPage);
		// The device sizes a box to its lines plus one pixel.
		const rect: WritableTextBox = {
			x: margin,
			y: margin,
			width: boxWidth,
			height: pageLines.length * lineHeight + 1,
			text: pageText(pageLines),
			fontSize,
			lineHeight,
		};
		// Rasterize into a box-sized coverage buffer, then place it on the page.
		const coverage = new Float32Array(rect.width * rect.height);
		pageLines.forEach((line, index) => {
			const edges: Edge[] = [];
			const baseline = index * lineHeight + baselineOffset;
			for (const { glyph, x } of line.glyphs) {
				glyphEdges((glyph.path as unknown as { commands: PathCommand[] }).commands, x * scale, baseline, scale, edges);
			}
			rasterizeEdges(edges, coverage, rect.width, rect.height);
		});
		const mainLayer = new Uint8Array(WRITER_PAGE_WIDTH * WRITER_PAGE_HEIGHT).fill(RattaColor.background);
		for (let row = 0; row < rect.height; row++) {
			const src = row * rect.width;
			const dst = (rect.y + row) * WRITER_PAGE_WIDTH + rect.x;
			for (let col = 0; col < rect.width; col++) {
				mainLayer[dst + col] = quantize(coverage[src + col], antialias);
			}
		}
		pages.push({ mainLayer, textBoxes: [rect] });
	}
	return pages;
}

/** Creates a complete `.note` whose pages hold `text` as text boxes. */
export function createTextNote(options: CreateTextNoteOptions): Uint8Array {
	const pages = layoutTextPages(options.text, options);
	return writeNote({ pages, now: options.now, random: options.random, fileId: options.fileId });
}

/** A text box read back from a page's `TOTALPATH`. */
export interface ITextBox {
	x: number;
	y: number;
	width: number;
	height: number;
	text: string;
	fontSize: number;
}

const decodeBase64Utf8 = (value: string): string => {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
};

/**
 * Reads the editable text boxes (`stroke_kind` `"0000"` records carrying a
 * base64 CSV, see `plans/note-writer.md`) out of a page's `totalPathBuffer`.
 * Records of any other kind, and malformed ones, are skipped.
 */
export function extractTextBoxes(totalPathBuffer: Uint8Array | null): ITextBox[] {
	if (!totalPathBuffer || totalPathBuffer.length < 4) return [];
	const view = new DataView(totalPathBuffer.buffer, totalPathBuffer.byteOffset, totalPathBuffer.byteLength);
	const boxes: ITextBox[] = [];
	const count = view.getUint32(0, true);
	let offset = 4;
	for (let i = 0; i < count && offset + 4 <= view.byteLength; i++) {
		const length = view.getUint32(offset, true);
		const start = offset + 4;
		offset = start + length;
		if (offset > view.byteLength) break;
		try {
			const box = readTextBoxRecord(new DataView(totalPathBuffer.buffer, totalPathBuffer.byteOffset + start, length));
			if (box) boxes.push(box);
		} catch {
			// Not a well-formed text-box record; skip it.
		}
	}
	return boxes;
}

function readTextBoxRecord(record: DataView): ITextBox | undefined {
	const kind = new TextDecoder('latin1')
		.decode(new Uint8Array(record.buffer, record.byteOffset + 48, 52))
		.replace(/\0.*$/s, '');
	if (kind !== '0000') return undefined;
	let at = 208;
	const u32 = () => {
		const value = record.getUint32(at, true);
		at += 4;
		return value;
	};
	const skipArray = (size: number) => {
		const count = u32();
		at += count * size;
	};
	skipArray(24); // disableAreaList
	skipArray(8); // points
	skipArray(2); // pressures
	skipArray(4); // tilts
	skipArray(1); // flagDraw
	skipArray(8); // epaPoints
	skipArray(4); // epaGrays
	at += 52; // section_1
	skipArray(4); // controlNums
	at += 10; // section_2
	const contours = u32();
	for (let i = 0; i < contours; i++) skipArray(8);
	skipArray(16); // unk_17
	at += 17; // section_3
	skipArray(4); // unk_22
	at += 13; // section_4
	const csvLength = u32();
	if (at + csvLength > record.byteLength) return undefined;
	const csv = new TextDecoder('latin1').decode(new Uint8Array(record.buffer, record.byteOffset + at, csvLength));
	const fields = csv.split(',').map((field) => (field ? decodeBase64Utf8(field) : ''));
	const rect = fields[4]?.split(',').map(Number);
	if (!rect || rect.length !== 4 || rect.some((value) => !Number.isFinite(value)) || fields[12] === undefined) {
		return undefined;
	}
	const [x, y, width, height] = rect;
	return { x, y, width, height, text: fields[12], fontSize: Number(fields[10]) || 0 };
}

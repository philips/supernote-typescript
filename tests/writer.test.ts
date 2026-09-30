import * as fs from 'fs-extra';
import { describe, expect, test } from 'vitest';
import { RattaRLEDecoder, toImage } from '../src/conversion';
import { SupernoteX } from '../src/parsing';
import {
	RattaColor,
	WRITER_PAGE_HEIGHT,
	WRITER_PAGE_WIDTH,
	encodeRattaRle,
	encodeTextBoxRecord,
	generateNoteId,
	writeNote,
} from '../src/writer';
import { createTextNote, extractTextBoxes, layoutTextPages } from '../src/textbox';

const input = (name: string) => new Uint8Array(fs.readFileSync(`tests/input/${name}`));
const PIXELS = WRITER_PAGE_WIDTH * WRITER_PAGE_HEIGHT;

/** A deterministic, non-cryptographic random source for stable IDs. */
function seeded(seed = 1): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x80000000;
	};
}

/** Any system font with Latin glyphs; the tests only need real outlines. */
function testFont(): Uint8Array {
	for (const path of [
		'/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf',
		'/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
		'/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
	]) {
		if (fs.existsSync(path)) return new Uint8Array(fs.readFileSync(path));
	}
	throw new Error('no test font found; install Liberation Sans or DejaVu Sans');
}

/** Walks a TOTALPATH buffer into its raw records. */
function records(totalPath: Uint8Array): Uint8Array[] {
	const view = new DataView(totalPath.buffer, totalPath.byteOffset, totalPath.byteLength);
	const out: Uint8Array[] = [];
	let offset = 4;
	for (let i = 0; i < view.getUint32(0, true); i++) {
		const length = view.getUint32(offset, true);
		out.push(totalPath.subarray(offset + 4, offset + 4 + length));
		offset += 4 + length;
	}
	expect(offset).toBe(totalPath.length);
	return out;
}

/** Decodes the base64 CSV a text-box record carries. */
function textBoxFields(record: Uint8Array): string[] {
	const text = new TextDecoder('latin1').decode(record);
	const start = text.indexOf('MA==,MA==,MA==,');
	const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
	const length = view.getUint32(start - 4, true);
	return text
		.slice(start, start + length)
		.split(',')
		.slice(0, -1)
		.map((field) => new TextDecoder().decode(Uint8Array.from(atob(field), (c) => c.charCodeAt(0))));
}

/** Byte offset of the text-box CSV string's u32 length prefix. */
const csvOffset = (record: Uint8Array) => new TextDecoder('latin1').decode(record).indexOf('MA==,MA==,MA==,') - 4;

describe('encodeRattaRle', () => {
	test('encodes a blank 1920x2560 layer exactly as the device does', () => {
		const encoded = encodeRattaRle(new Uint8Array(PIXELS).fill(RattaColor.background));
		expect(encoded.length).toBe(600);
		for (let i = 0; i < encoded.length; i += 2) expect([encoded[i], encoded[i + 1]]).toEqual([0x62, 0xff]);
	});

	test('round-trips every run-length form through the decoder', () => {
		const lengths = [1, 2, 127, 128, 129, 130, 255, 256, 16383, 16384, 16385, 16511, 16512, 16513, 40000];
		const colors = [RattaColor.black, RattaColor.background, RattaColor.darkGray, RattaColor.gray, RattaColor.white];
		const width = 1000;
		const total = lengths.reduce((sum, n) => sum + n, 0);
		const height = Math.ceil(total / width);
		const pixels = new Uint8Array(width * height).fill(RattaColor.background);
		let at = 0;
		lengths.forEach((n, i) => {
			pixels.fill(colors[i % colors.length], at, at + n);
			at += n;
		});
		// Reference: every pixel as its own one-pixel run, the simplest form.
		const naive = new Uint8Array(pixels.length * 2);
		pixels.forEach((color, i) => naive.set([color, 0], i * 2));
		const decoder = new RattaRLEDecoder();
		const encoded = encodeRattaRle(pixels);
		expect(encoded.length).toBeLessThan(200);
		const actual = decoder.decode(encoded, width, height);
		const expected = decoder.decode(naive, width, height);
		expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
	});
});

describe('writeNote', () => {
	test('a blank page is byte-identical to a fresh device-created note', () => {
		const device = input('blank-n5-20260016-nomad-fresh.note');
		const written = writeNote({
			pages: [{ pageId: 'P20260922115611225954fC6CMr1DUYjH' }],
			fileId: 'F202609221156112171456sS8PMxFTemv',
		});
		expect(Buffer.from(written).equals(Buffer.from(device))).toBe(true);
	});

	test('writes parseable multi-page notes with text-box metadata', () => {
		const mainLayer = new Uint8Array(PIXELS).fill(RattaColor.background);
		mainLayer.fill(RattaColor.black, 300 * WRITER_PAGE_WIDTH, 301 * WRITER_PAGE_WIDTH);
		const note = new SupernoteX(
			writeNote({
				pages: [{ mainLayer, textBoxes: [{ x: 10, y: 20, width: 30, height: 40 }] }, {}],
				random: seeded(),
			}),
		);
		expect([note.pageWidth, note.pageHeight]).toEqual([1920, 2560]);
		expect(note.pages).toHaveLength(2);
		expect(note.pages[0].PAGETEXTBOX).toBe('1');
		expect(note.pages[0].DISABLE).toBe('10,20,30,40|');
		// A box with no text is raster-only: no TOTALPATH record.
		expect(note.pages[0].TOTALPATH).toBe('0');
		expect(note.pages[1].PAGETEXTBOX).toBe('0');
		expect(note.pages[1].DISABLE).toBe('none');
		expect(note.pages[0].PAGEID).not.toBe(note.pages[1].PAGEID);
	});

	test('rejects text boxes outside the page and wrongly sized layers', () => {
		expect(() => writeNote({ pages: [{ textBoxes: [{ x: 1900, y: 0, width: 100, height: 10 }] }] })).toThrow(RangeError);
		expect(() => writeNote({ pages: [{ mainLayer: new Uint8Array(10) }] })).toThrow(RangeError);
		expect(() => writeNote({ pages: [] })).toThrow(RangeError);
	});

	test('generates device-shaped IDs', () => {
		expect(generateNoteId('P', new Date(2026, 8, 22, 11, 56, 11, 225), seeded())).toMatch(
			/^P20260922115611225\d{3}[A-Za-z0-9]{12}$/,
		);
	});
});

describe('encodeTextBoxRecord', () => {
	// Device-created on a Nomad (Chauvet 2608): one wrapping text box.
	const deviceNote = new SupernoteX(input('textbox-n5-20260016-device-record.note'));
	const [device] = records(deviceNote.pages[0].totalPathBuffer as Uint8Array);
	const deviceFields = textBoxFields(device);
	const box = { x: 960, y: 1272, width: 940, height: 253, text: deviceFields[12] };
	const ours = encodeTextBoxRecord(box, { pageNumber: 1, trailNumber: 1, id: deviceFields[3] });

	test('the device fixture is what the encoder models', () => {
		expect(deviceNote.pages[0].DISABLE).toBe('960,1272,940,253|');
		expect(deviceFields[4]).toBe('960,1272,940,253');
		expect(deviceFields[12]).toContain('A device-created text box');
	});

	test('matches the device record field for field', () => {
		expect(textBoxFields(ours)).toEqual(deviceFields);
		expect(ours.length).toBe(device.length);
		// Everything outside the digitizer-unit points is byte-identical: the
		// device converts the rect to those units with its own sub-pixel
		// rounding, which lands within a pixel of ours.
		// StrokeConfig (208) + disableAreaList count + points count.
		const pointsStart = 216;
		const pointsEnd = pointsStart + 5 * 8;
		expect(Buffer.from(ours.subarray(0, pointsStart))).toEqual(Buffer.from(device.subarray(0, pointsStart)));
		expect(Buffer.from(ours.subarray(pointsEnd))).toEqual(Buffer.from(device.subarray(pointsEnd)));
		const points = (record: Uint8Array) => {
			const view = new DataView(record.buffer, record.byteOffset + pointsStart);
			return Array.from({ length: 10 }, (_, i) => view.getUint32(i * 4, true));
		};
		const scale = 21632 / 2560;
		points(ours).forEach((value, i) => expect(Math.abs(value - points(device)[i])).toBeLessThan(scale));
	});

	test('keeps the CSV length prefix consistent with its content', () => {
		const view = new DataView(ours.buffer, ours.byteOffset);
		const at = csvOffset(ours);
		const csv = new TextDecoder().decode(ours.subarray(at + 4, at + 4 + view.getUint32(at, true)));
		expect(csv.endsWith(',')).toBe(true);
		expect(csv.split(',')).toHaveLength(20);
	});
});

describe('createTextNote', () => {
	const text = 'Hello from Pi\n\nThis paragraph is long enough that it has to wrap across more than one line of the text box at the default size. Café — ✓';
	const fontBytes = testFont();

	test('writes an editable text box whose record carries the text', async () => {
		const note = new SupernoteX(createTextNote({ text, fontBytes, random: seeded() }));
		expect(note.pages).toHaveLength(1);
		const page = note.pages[0];
		expect(page.PAGETEXTBOX).toBe('1');
		const [x, y, width, height] = (page.DISABLE as string).replace('|', '').split(',').map(Number);
		expect([x, y, width]).toEqual([150, 150, 1620]);
		expect((height - 1) % 63).toBe(0);
		const [record] = records(page.totalPathBuffer as Uint8Array);
		const fields = textBoxFields(record);
		expect(fields[12].replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
		expect(fields[12].split('\n')).toHaveLength(3);
		expect(fields[4]).toBe(`${x},${y},${width},${height}`);

		// Ink exists, and only inside the text box.
		const [image] = await toImage(note);
		let inside = 0;
		let outside = 0;
		for (let row = 0; row < image.height; row += 2) {
			for (let col = 0; col < image.width; col += 2) {
				if (image.getValue(col, row, 3) === 0) continue;
				if (col >= x && col < x + width && row >= y && row < y + height) inside++;
				else outside++;
			}
		}
		expect(inside).toBeGreaterThan(1000);
		expect(outside).toBe(0);
	});

	test('paginates long text, one text box per page', () => {
		const long = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n');
		const pages = layoutTextPages(long, { fontBytes });
		expect(pages.length).toBe(Math.ceil(120 / Math.floor((2560 - 300) / 63)));
		const joined = pages.map((page) => page.textBoxes?.[0].text).join('\n');
		expect(joined).toBe(long);
	});
});

describe('extractTextBoxes', () => {
	test('reads a device-created text box', () => {
		const note = new SupernoteX(input('textbox-n5-20260016-device-record.note'));
		const [box] = extractTextBoxes(note.pages[0].totalPathBuffer);
		expect(box).toMatchObject({ x: 960, y: 1272, width: 940, height: 253, fontSize: 48 });
		expect(box.text).toMatch(/^A device-created text box .*\nCaf/s);
	});

	test('round-trips text written by createTextNote', () => {
		const text = 'First line\nSecond line — ünïcødé';
		const note = new SupernoteX(createTextNote({ text, fontBytes: testFont(), random: seeded() }));
		expect(extractTextBoxes(note.pages[0].totalPathBuffer).map((box) => box.text)).toEqual([text]);
	});

	test('ignores ink and missing paths', () => {
		expect(extractTextBoxes(null)).toEqual([]);
		const ink = new SupernoteX(input('stroke-n5-20260016-isolation-tools-colors-widths.note'));
		expect(extractTextBoxes(ink.pages[0].totalPathBuffer)).toEqual([]);
	});
});

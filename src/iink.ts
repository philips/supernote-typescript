import type { IPage } from './format.js';

/** Text recovered from one MyScript iink BDOM `textField`.
 *
 * `text` joins the selected character candidates in document order. A
 * candidate with no selected label is represented as a newline; that is the
 * encoding used for line breaks in the currently supported BDOM v2 files. */
export interface IinkTextField {
	/** Text recognized by iink for this field. */
	text: string;
	/** Offset of the field's BDOM element, useful when comparing revisions. */
	bdomOffset: number;
	/** Number of BDOM `charCandidate` elements in the field. */
	candidateCount: number;
}

const BDOM_MAGIC = 'BDOM';
const ELEMENT_TOKEN = 0x03;
const STRING_TOKEN = 0x01;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_DICTIONARY_STRING_LENGTH = 4096;
const MAX_CANDIDATE_LENGTH = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true });

interface BdomHeader {
	dictionary: string[];
	contentOffset: number;
}

function readUint16LE(data: Uint8Array, offset: number): number {
	if (offset + 2 > data.length) throw new Error('Unexpected end of iink package');
	return data[offset] | (data[offset + 1] << 8);
}

function readUint32LE(data: Uint8Array, offset: number): number {
	if (offset + 4 > data.length) throw new Error('Unexpected end of iink package');
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0;
}

function decodeAscii(data: Uint8Array): string | undefined {
	if (data.some((byte) => byte < 0x20 || byte > 0x7e)) return undefined;
	return utf8.decode(data);
}

function readBdomHeader(data: Uint8Array): BdomHeader {
	if (utf8.decode(data.subarray(0, 4)) !== BDOM_MAGIC)
		throw new Error('iink page model is not a BDOM file');
	if (data[5] !== 2)
		throw new Error(`Unsupported iink BDOM version ${data[5]}`);

	const dictionary: string[] = [];
	let offset = 6;
	while (offset + 4 <= data.length) {
		const length = readUint32LE(data, offset);
		// BDOM v2 terminates its schema dictionary with uint32 0xff.
		if (length === 0xff) {
			offset += 4;
			break;
		}
		if (
			length > MAX_DICTIONARY_STRING_LENGTH ||
			offset + 4 + length > data.length
		)
			throw new Error('Invalid iink BDOM schema dictionary');

		const value = decodeAscii(data.subarray(offset + 4, offset + 4 + length));
		if (value === undefined) throw new Error('Invalid iink BDOM schema entry');
		dictionary.push(value);
		offset += 4 + length;
	}

	if (dictionary.length === 0) throw new Error('iink BDOM schema dictionary missing');
	return { dictionary, contentOffset: offset };
}

function findElementOffsets(
	data: Uint8Array,
	from: number,
	dictionaryIndex: number,
): number[] {
	const offsets: number[] = [];
	for (let offset = from; offset + 5 <= data.length; offset++) {
		if (
			data[offset] === ELEMENT_TOKEN &&
			readUint32LE(data, offset + 1) === dictionaryIndex
		)
			offsets.push(offset);
	}
	return offsets;
}

function stringAt(
	data: Uint8Array,
	offset: number,
	end: number,
): string | undefined {
	if (data[offset] !== STRING_TOKEN || offset + 5 > end) return undefined;
	const length = readUint32LE(data, offset + 1);
	if (length === 0 || length > MAX_CANDIDATE_LENGTH || offset + 5 + length > end)
		return undefined;

	try {
		const value = utf8.decode(data.subarray(offset + 5, offset + 5 + length));
		return [...value].every((character) => !/\p{C}/u.test(character))
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function candidateLabel(
	data: Uint8Array,
	start: number,
	end: number,
): string | undefined {
	for (let offset = start + 5; offset < end; offset++) {
		// The selected character follows the candidate's attribute terminator.
		// This excludes range strings in the following text structure.
		if (data[offset - 1] !== 0xff) continue;
		const value = stringAt(data, offset, end);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Extract recognized text fields from a MyScript iink BDOM v2 page model.
 *
 * This intentionally decodes only the stable, observed text-candidate subset
 * of the proprietary BDOM format. It does not yet expose field geometry or
 * styles, and must not be used to rewrite a BDOM file. */
export function extractIinkTextFromBdom(data: Uint8Array): IinkTextField[] {
	const header = readBdomHeader(data);
	const textFieldIndex = header.dictionary.indexOf('textField');
	const charCandidateIndex = header.dictionary.indexOf('charCandidate');
	if (textFieldIndex < 0 || charCandidateIndex < 0) return [];

	const fields = findElementOffsets(data, header.contentOffset, textFieldIndex);
	const candidates = findElementOffsets(
		data,
		header.contentOffset,
		charCandidateIndex,
	);

	return fields.map((bdomOffset, fieldIndex) => {
		const end = fields[fieldIndex + 1] ?? data.length;
		const inField = candidates.filter(
			(candidateOffset) => candidateOffset > bdomOffset && candidateOffset < end,
		);
		const characters = inField.map((candidateOffset, candidateIndex) =>
			candidateLabel(
				data,
				candidateOffset,
				inField[candidateIndex + 1] ?? end,
			),
		);
		return {
			text: characters.map((character) => character ?? '\n').join(''),
			bdomOffset,
			candidateCount: characters.length,
		};
	});
}

function findEndOfCentralDirectory(data: Uint8Array): number {
	// EOCD can be followed by a 65,535-byte ZIP comment.
	const start = Math.max(0, data.length - 0xffff - 22);
	for (let offset = data.length - 22; offset >= start; offset--) {
		if (readUint32LE(data, offset) === ZIP_END_OF_CENTRAL_DIRECTORY)
			return offset;
	}
	throw new Error('iink recognition file is not a ZIP archive');
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined')
		throw new Error('Deflate decompression is not available in this runtime');
	// Copy into an ArrayBuffer-backed view: TypeScript correctly refuses a
	// possibly SharedArrayBuffer-backed Uint8Array as a BlobPart.
	const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(
		new DecompressionStream('deflate-raw'),
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(
	archive: Uint8Array,
	entryName: string,
): Promise<Uint8Array | undefined> {
	const eocd = findEndOfCentralDirectory(archive);
	const entryCount = readUint16LE(archive, eocd + 10);
	let offset = readUint32LE(archive, eocd + 16);

	for (let entry = 0; entry < entryCount; entry++) {
		if (readUint32LE(archive, offset) !== ZIP_CENTRAL_DIRECTORY_HEADER)
			throw new Error('Invalid iink ZIP central directory');
		const compressionMethod = readUint16LE(archive, offset + 10);
		const compressedSize = readUint32LE(archive, offset + 20);
		const nameLength = readUint16LE(archive, offset + 28);
		const extraLength = readUint16LE(archive, offset + 30);
		const commentLength = readUint16LE(archive, offset + 32);
		const localHeaderOffset = readUint32LE(archive, offset + 42);
		const name = utf8.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
		offset += 46 + nameLength + extraLength + commentLength;

		if (name !== entryName) continue;
		if (readUint32LE(archive, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER)
			throw new Error('Invalid iink ZIP local file header');
		const localNameLength = readUint16LE(archive, localHeaderOffset + 26);
		const localExtraLength = readUint16LE(archive, localHeaderOffset + 28);
		const compressedOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
		const compressed = archive.subarray(
			compressedOffset,
			compressedOffset + compressedSize,
		);
		if (compressed.length !== compressedSize)
			throw new Error('Truncated iink ZIP entry');
		if (compressionMethod === 0) return compressed.slice();
		if (compressionMethod === 8) return inflateRaw(compressed);
		throw new Error(`Unsupported iink ZIP compression method ${compressionMethod}`);
	}
	return undefined;
}

/** Extract iink BDOM text from one parsed Supernote page.
 *
 * The operation is asynchronous because `RECOGNFILE` is a ZIP archive and
 * its `page.bdom` entry is normally raw-deflate compressed. Pages without an
 * iink recognition package return an empty array. */
export async function extractIinkText(page: Pick<IPage, 'recognitionFileBuffer'>): Promise<IinkTextField[]> {
	if (!page.recognitionFileBuffer) return [];

	const eocd = findEndOfCentralDirectory(page.recognitionFileBuffer);
	const entryCount = readUint16LE(page.recognitionFileBuffer, eocd + 10);
	let offset = readUint32LE(page.recognitionFileBuffer, eocd + 16);
	let pageBdomName: string | undefined;
	for (let entry = 0; entry < entryCount; entry++) {
		if (readUint32LE(page.recognitionFileBuffer, offset) !== ZIP_CENTRAL_DIRECTORY_HEADER)
			throw new Error('Invalid iink ZIP central directory');
		const nameLength = readUint16LE(page.recognitionFileBuffer, offset + 28);
		const extraLength = readUint16LE(page.recognitionFileBuffer, offset + 30);
		const commentLength = readUint16LE(page.recognitionFileBuffer, offset + 32);
		const name = utf8.decode(
			page.recognitionFileBuffer.subarray(offset + 46, offset + 46 + nameLength),
		);
		if (/^pages\/[^/]+\/page\.bdom$/.test(name)) {
			pageBdomName = name;
			break;
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	if (!pageBdomName) return [];

	const bdom = await readZipEntry(page.recognitionFileBuffer, pageBdomName);
	if (!bdom) return [];
	return extractIinkTextFromBdom(bdom);
}

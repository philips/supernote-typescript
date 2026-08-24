#!/usr/bin/env node

/**
 * Inspect the small, understood subset of a MyScript iink BDOM v2 file.
 *
 * This is deliberately a research tool, not a general BDOM decoder. It
 * extracts the string dictionary and the Unicode candidates attached to
 * `charCandidate` objects. The latter are the recognized text underlying a
 * text field. Use it on a decompressed `pages/<id>/page.bdom` file:
 *
 *   node .scripts-dist/scripts/inspect-bdom.js page.bdom
 */
import { readFile } from 'node:fs/promises';

const BDOM_MAGIC = 'BDOM';
const ELEMENT_TOKEN = 0x03;
const STRING_TOKEN = 0x01;
const MAX_DICTIONARY_STRING_LENGTH = 4096;
const MAX_CANDIDATE_LENGTH = 64;
const decoder = new TextDecoder('utf-8', { fatal: true });

interface BdomHeader {
	version: number;
	dictionary: string[];
	contentOffset: number;
}

interface TextField {
	/** Byte offset of its `textField` element token. */
	offset: number;
	/** Unicode candidates in document order. Undefined has no selected label. */
	characters: (string | undefined)[];
}

function readUint32LE(data: Uint8Array, offset: number): number {
	if (offset + 4 > data.length) throw new Error('Unexpected end of BDOM');
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0;
}

function decodeAscii(data: Uint8Array): string | undefined {
	if (data.some((byte) => byte < 0x20 || byte > 0x7e)) return undefined;
	return decoder.decode(data);
}

function readHeader(data: Uint8Array): BdomHeader {
	if (decoder.decode(data.subarray(0, 4)) !== BDOM_MAGIC)
		throw new Error('Not a MyScript BDOM file');

	const version = data[5];
	const dictionary: string[] = [];
	let offset = 6;

	// BDOM v2 begins with a length-prefixed, printable schema dictionary. The
	// following event stream cannot be interpreted as such an entry, which
	// gives us a reliable boundary without pretending to decode all BDOM tags.
	while (offset + 4 <= data.length) {
		const length = readUint32LE(data, offset);
		// 0xff is the v2 dictionary terminator, not a 255-byte schema string.
		if (length === 0xff) {
			offset += 4;
			break;
		}
		if (
			length > MAX_DICTIONARY_STRING_LENGTH ||
			offset + 4 + length > data.length
		)
			break;

		const value = decodeAscii(data.subarray(offset + 4, offset + 4 + length));
		if (value === undefined) break;
		dictionary.push(value);
		offset += 4 + length;
	}

	if (dictionary.length === 0) throw new Error('BDOM schema dictionary missing');
	return { version, dictionary, contentOffset: offset };
}

function findElementOffsets(
	data: Uint8Array,
	from: number,
	dictionaryIndex: number,
): number[] {
	const result: number[] = [];
	for (let offset = from; offset + 5 <= data.length; offset++) {
		if (
			data[offset] === ELEMENT_TOKEN &&
			readUint32LE(data, offset + 1) === dictionaryIndex
		)
			result.push(offset);
	}
	return result;
}

function stringAt(data: Uint8Array, offset: number, end: number): string | undefined {
	if (data[offset] !== STRING_TOKEN || offset + 5 > end) return undefined;
	const length = readUint32LE(data, offset + 1);
	if (length === 0 || length > MAX_CANDIDATE_LENGTH || offset + 5 + length > end)
		return undefined;

	try {
		const value = decoder.decode(data.subarray(offset + 5, offset + 5 + length));
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
	const labels: string[] = [];
	for (let offset = start + 5; offset < end; offset++) {
		// The selected character value follows the candidate's attribute
		// terminator. This excludes range strings in subsequent text structure.
		if (data[offset - 1] !== 0xff) continue;
		const value = stringAt(data, offset, end);
		if (value !== undefined) labels.push(value);
	}

	// In inspected v2 records this is the selected label. Later `0x01`
	// sequences in the same byte range belong to following structural data,
	// not to this candidate.
	return labels[0];
}

function extractTextFields(data: Uint8Array, header: BdomHeader): TextField[] {
	const textFieldIndex = header.dictionary.indexOf('textField');
	const charCandidateIndex = header.dictionary.indexOf('charCandidate');
	if (textFieldIndex < 0 || charCandidateIndex < 0) return [];

	const fields = findElementOffsets(data, header.contentOffset, textFieldIndex);
	const candidates = findElementOffsets(
		data,
		header.contentOffset,
		charCandidateIndex,
	);

	return fields.map((offset, fieldIndex) => {
		const end = fields[fieldIndex + 1] ?? data.length;
		const inField = candidates.filter(
			(candidateOffset) => candidateOffset > offset && candidateOffset < end,
		);
		return {
			offset,
			characters: inField.map((candidateOffset, candidateIndex) =>
				candidateLabel(
					data,
					candidateOffset,
					inField[candidateIndex + 1] ?? end,
				),
			),
		};
	});
}

function displayText(characters: (string | undefined)[]): string {
	// The observed unlabeled candidates occur at line breaks. Keep that
	// inference explicit: a full BDOM event decoder is still required to
	// distinguish every possible unlabelled candidate type.
	return characters.map((character) => character ?? '\n').join('');
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) throw new Error('Usage: inspect-bdom <page.bdom>');

	const data = await readFile(path);
	const header = readHeader(data);
	const textFields = extractTextFields(data, header);

	console.log(`BDOM v${header.version}; ${header.dictionary.length} schema strings`);
	console.log(`Content starts at byte 0x${header.contentOffset.toString(16)}`);
	for (const [index, field] of textFields.entries()) {
		console.log(
			`textField ${index + 1} at 0x${field.offset.toString(16)} ` +
				`(${field.characters.length} candidates): ${JSON.stringify(displayText(field.characters))}`,
		);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});

import {
	ICover,
	IFooter,
	IHeader,
	IKeyword,
	ILayer,
	ILayerInfo,
	ILayerNames,
	RecognitionStatuses,
	IRecognitionElement,
	IPage,
	ISupernote,
	ITitle,
} from './format.js';

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset(offset: number, ext: number, length: number) {
	if (offset % 1 !== 0 || offset < 0)
		throw new RangeError('offset is not uint');
	if (offset + ext > length)
		throw new RangeError('Trying to access beyond buffer length');
}

function readUintLE(
	data: Uint8Array,
	offset: number,
	byteLength: number,
): number {
	offset = offset >>> 0;
	byteLength = byteLength >>> 0;
	checkOffset(offset, byteLength, data.length);

	let val = data[offset];
	let mul = 1;
	let i = 0;
	while (++i < byteLength && (mul *= 0x100)) {
		val += data[offset + i] * mul;
	}

	return val;
}

/** Get content at location. */
export function getContentAtAddress(
	buffer: Uint8Array,
	address: number,
	byteLength: number,
): Uint8Array | null {
	if (address === 0) return null;
	const blockLength = readUintLE(buffer, address, byteLength);
	const content = buffer.subarray(
		address + byteLength,
		address + byteLength + blockLength,
	);
	return content;
}

/** Parse key-value pairs. */
export function parseKeyValue(
	buffer: Uint8Array,
	address: number,
	byteLength: number,
): Record<string, string | string[]> {
	const content = getContentAtAddress(buffer, address, byteLength);
	if (content === null) return {};
	const str = uint8ArrayToString(content);
	return extractKeyValue(str);
}

/** Extract key-value pairs from content. */
export function extractKeyValue(
	content: string,
): Record<string, string | string[]> {
	const pattern = /<([^:<>]+):([^:<>]+)>/gm;
	const pairs = [...content.matchAll(pattern)];
	const data = pairs.reduce(
		(acc: Record<string, string | string[]>, [, key, value]) => {
			if (key in acc) {
				const newValue =
					typeof acc[key] === 'string'
						? [acc[key] as string, value]
						: [...acc[key], value];
				acc[key] = newValue;
			} else {
				acc[key] = value;
			}
			return acc;
		},
		{},
	);
	return data;
}

/** Extract nested key-values from a record. */
export function extractNestedKeyValue(
	record: Record<string, string | string[]>,
	delimiter = '_',
	prefixes: string[] = [],
): Record<string, Record<string, string>> {
	const data: Record<string, Record<string, string>> = {};
	Object.entries(record).forEach(([key, value]) => {
		let main: string | undefined;
		let sub: string | undefined;
		if (typeof value !== 'string') return;

		// With regular delimiter.
		const idx = key.indexOf(delimiter);
		if (idx > -1) {
			main = key.substring(0, idx);
			sub = key.substring(idx + 1);
		} else {
			// Check numbered keys instead.
			for (const prefix of prefixes) {
				if (!key.startsWith(prefix)) continue;
				main = prefix;
				sub = key.substring(main.length);
				break;
			}
		}
		// Set nested keys if both main and sub found.
		if (!(main && sub)) return;
		if (main in data) data[main][sub] = value;
		else data[main] = { [sub]: value };
	});
	return data;
}

/** Extract layer info from the content string. */
export function extractLayerInfo(content: string): ILayerInfo[] {
	const layerPattern = /{(?<content>[^{}]+)}/gm;
	const dictPattern = /"(?<key>[^"[{}\]]+)"#"?(?<value>[^"[{}\],]+)/gm;
	// Fetch the string per layer from the array (between {}'s).
	const layerContents = Array.from(content.matchAll(layerPattern));
	const layerInfos = layerContents.map((match) => {
		if (match.groups === undefined) throw new Error('Undefined layer content.');
		// Fetch every key value pair for each layer.
		const layerDictContents = Array.from(
			match.groups.content.matchAll(dictPattern),
		);
		const data = layerDictContents.reduce(
			(acc: Record<string, string>, match) => {
				if (match.groups === undefined)
					throw new Error('Undefined key/value pair.');
				const { key, value } = match.groups;
				acc[key] = value;
				return acc;
			},
			{},
		);

		// Morph this into a layer info object.
		const layerInfo: ILayerInfo = {
			layerId: parseInt(data.layerId ?? '0'),
			name: data.name ?? 'Main layer',
			isBackgroundLayer: data.isBackgroundLayer === 'true',
			isAllowAdd: data.isAllowAdd === 'true',
			isCurrentLayer: data.isCurrentLayer === 'true',
			isVisible: data.isVisible === 'true',
			isDeleted: data.isDeleted === 'true',
			isAllowUp: data.isAllowUp === 'true',
			isAllowDown: data.isAllowDown === 'true',
		};
		return layerInfo;
	});
	return layerInfos;
}

function uint8ArrayToString(
	uint8Array: Uint8Array,
	encoding: string = 'utf8',
	start: number = 0,
	end?: number,
): string {
	// Determine the end index
	end = end || uint8Array.length;

	// Slice the Uint8Array to get the desired portion
	const slicedArray = uint8Array.slice(start, end);

	// Create a new text decoder with the specified encoding
	const decoder = new TextDecoder(encoding);

	// Decode the sliced Uint8Array into a string
	return decoder.decode(slicedArray);
}

// Note: known vertical orientations are 1000, 1180
const HORIZONTAL_ORIENTATIONS = ['1090', '1270'];

type IRecognitionWord = IRecognitionElement['words'][number];

interface IRecognizedLine {
	text: string;
	/** Left edge of the line's bounding box. */
	x: number;
	/** Top edge of the line's bounding box. */
	top: number;
	/** Bottom edge of the line's bounding box. */
	bottom: number;
	height: number;
}

/** How much two fragments' tops may differ, relative to their own height,
 * and still be considered the same visual line. */
const SAME_LINE_HEIGHT_RATIO = 0.5;
/** How large a gap between lines must be, relative to the local line
 * height, to be treated as a paragraph break rather than a line wrap. */
const PARAGRAPH_GAP_HEIGHT_RATIO = 1.0;
/** Number of preceding lines averaged to estimate the "local" line height,
 * so a page mixing large headings and small body text doesn't skew a
 * single page-wide average. */
const LINE_HEIGHT_WINDOW = 3;

/** Recognition labels arrive as UTF-8 bytes read through a Latin-1 decoder,
 * so they need to be re-decoded to recover the original text. */
function decodeRecognitionLabel(label: string): string {
	return decodeURIComponent(escape(label));
}

/** Split one recognition element into its visual lines. Multi-line
 * elements embed "\n" marker words between lines; each line gets its own
 * bounding box computed from its own words, rather than borrowing the
 * bounding box of the element's first word. */
function splitElementIntoLines(element: IRecognitionElement): IRecognizedLine[] {
	const text = decodeRecognitionLabel(element.label);
	const lineTexts = text.split('\n');

	const wordLines: IRecognitionWord[][] = [[]];
	for (const word of element.words) {
		if (word.label === '\n' && !word['bounding-box']) {
			wordLines.push([]);
		} else {
			wordLines[wordLines.length - 1].push(word);
		}
	}

	// Defensive fallback: if the "\n" markers didn't line up with the
	// label's own line breaks, treat the whole element as a single line
	// rather than silently dropping text.
	if (wordLines.length !== lineTexts.length) {
		return boxLine(text.replace(/\n/g, ' ').trim(), element.words);
	}

	return lineTexts.flatMap((lineText, i) => boxLine(lineText.trim(), wordLines[i]));
}

/** Build a single IRecognizedLine (if any word has a bounding box) for the
 * given text and words. */
function boxLine(text: string, words: IRecognitionWord[]): IRecognizedLine[] {
	if (text.length === 0) return [];

	const boxes = words
		.map((w) => w['bounding-box'])
		.filter((b): b is NonNullable<IRecognitionWord['bounding-box']> => !!b);

	if (boxes.length === 0) return [];

	const top = Math.min(...boxes.map((b) => b.y));
	const bottom = Math.max(...boxes.map((b) => b.y + b.height));
	const x = Math.min(...boxes.map((b) => b.x));

	return [{ text, x, top, bottom, height: bottom - top }];
}

/** Merge line fragments that sit on the same visual line (this happens
 * when the recognizer splits one handwritten line across several
 * elements) via a single forward sweep, chaining each fragment to the
 * previous one rather than comparing every pair. A pairwise "close in y"
 * comparator is not guaranteed transitive and can produce inconsistent
 * sort orders; this sweep sidesteps that. */
function clusterIntoVisualLines(lines: IRecognizedLine[]): IRecognizedLine[] {
	if (lines.length === 0) return [];

	const sorted = [...lines].sort((a, b) => a.top - b.top);

	const clusters: IRecognizedLine[][] = [[sorted[0]]];
	for (let i = 1; i < sorted.length; i++) {
		const line = sorted[i];
		const cluster = clusters[clusters.length - 1];
		const last = cluster[cluster.length - 1];
		const sameLineThreshold = Math.min(last.height, line.height) * SAME_LINE_HEIGHT_RATIO;

		if (line.top - last.top < sameLineThreshold) {
			cluster.push(line);
		} else {
			clusters.push([line]);
		}
	}

	return clusters.map((cluster) => {
		cluster.sort((a, b) => a.x - b.x);
		return {
			text: cluster.map((l) => l.text).join(' '),
			x: Math.min(...cluster.map((l) => l.x)),
			top: Math.min(...cluster.map((l) => l.top)),
			bottom: Math.max(...cluster.map((l) => l.bottom)),
			height: Math.max(...cluster.map((l) => l.bottom)) - Math.min(...cluster.map((l) => l.top)),
		};
	});
}

/** Join visual lines into paragraphs. A gap is measured from the bottom of
 * the previous line to the top of the next, so a wrapped line inside a
 * tall multi-line block doesn't get mistaken for a paragraph break just
 * because the block itself spans several lines. The threshold is a local,
 * rolling estimate of line height rather than a single page-wide average,
 * so headings and body text don't skew each other's thresholds. */
function joinLinesIntoParagraphs(lines: IRecognizedLine[]): string {
	if (lines.length === 0) return '';

	const sorted = [...lines].sort((a, b) => a.top - b.top);

	let result = sorted[0].text;
	const recentHeights = [sorted[0].height];

	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1];
		const current = sorted[i];
		const gap = current.top - previous.bottom;

		const localLineHeight = recentHeights.reduce((sum, h) => sum + h, 0) / recentHeights.length;
		const isNewParagraph = gap > localLineHeight * PARAGRAPH_GAP_HEIGHT_RATIO;

		result += isNewParagraph ? '\n\n' : ' ';
		result += current.text;

		recentHeights.push(current.height);
		if (recentHeights.length > LINE_HEIGHT_WINDOW) recentHeights.shift();
	}

	return result;
}

/** Extract plain recognized text, one recognition element per line. */
export function extractText(elements: IRecognitionElement[]): string {
	return elements
		.filter((e) => e.type === 'Text')
		.map((e) => decodeRecognitionLabel(e.label))
		.join('\n');
}

/** Extract recognized text grouped into paragraphs. Wrapped lines within a
 * paragraph are reflowed onto one line; a vertical gap of roughly a line
 * height or more is treated as a paragraph break. */
export function extractParagraphs(elements: IRecognitionElement[]): string {
	const lines = elements
		.filter((e) => e.type === 'Text')
		.flatMap(splitElementIntoLines);

	const visualLines = clusterIntoVisualLines(lines);

	return joinLinesIntoParagraphs(visualLines);
}

/** Supernote X series note. */
export class SupernoteX implements ISupernote {
	declare pageWidth: number;
	declare pageHeight: number;
	declare addressSize: number;
	declare lengthFieldSize: number;
	declare signature: string;
	declare version: number;
	declare defaultLayers: string[];
	declare header: IHeader;
	declare footer: IFooter;
	declare keywords: Record<string, IKeyword[]>;
	declare titles: Record<string, ITitle[]>;
	declare pages: IPage[];
	declare cover?: ICover;

	constructor(buffer: Uint8Array) {
		this.pageWidth = 1404;
		this.pageHeight = 1872;
		this.addressSize = 4;
		this.lengthFieldSize = 4;
		this.defaultLayers = ['MAINLAYER', 'LAYER1', 'LAYER2', 'LAYER3', 'BGLAYER'];
		this._parseBuffer(buffer);
	}

	/** Parse note contents from buffer. */
	_parseBuffer(buffer: Uint8Array): Partial<SupernoteX> {
		this._parseSignature(buffer);
		this._parseFooter(buffer);
		this._parseHeader(buffer);
		// Manta is the first Supernote device to have a different
		// pageWidth and pageHeight
		if (this.header.APPLY_EQUIPMENT == 'N5') {
			this.pageWidth = 1920
			this.pageHeight = 2560;
		}
		const pages = this._parsePages(buffer);
		if (pages.every((page) => HORIZONTAL_ORIENTATIONS.includes(page.ORIENTATION))) {
			// Orientation is defined at the page level, but seems to only define one unique value per file.
			// If it is ever the case that both portrait and landscape pages are defined within one note file,
			// it will be necessary to treat the width/height per-page instead.
			[this.pageWidth, this.pageHeight] = [this.pageHeight, this.pageWidth];
		}
		this._parseCover(buffer);
		this._parseKeywords(buffer);
		this._parseTitles(buffer);
		return this;
	}

	/** Parse Supernote file signature from buffer. */
	_parseSignature(buffer: Uint8Array): string {
		const pattern = /^noteSN_FILE_VER_(\d{8})/;
		const content = uint8ArrayToString(buffer, 'utf8', 0, 24);
		const match = content.match(pattern);
		if (!match)
			throw new Error("Cannot parse this file. Signature doesn't match.");
		this.signature = content;
		this.version = parseFloat(match[1]);
		return this.signature;
	}

	/** Parse the footer of a Supernote file's buffer contents. */
	_parseFooter(buffer: Uint8Array): IFooter {
		const chunk = buffer.subarray(buffer.length - this.addressSize);
		const address = readUintLE(chunk, 0, this.addressSize);
		const data = parseKeyValue(buffer, address, this.lengthFieldSize);
		const nested = extractNestedKeyValue(data, '_', ['PAGE']);
		this.footer = {
			FILE: { FEATURE: '24' },
			COVER: { '0': '0' },
			KEYWORD: {},
			TITLE: {},
			STYLE: {},
			PAGE: {},
			...nested,
		};
		return this.footer;
	}

	/** Parse the header of a Supernote file's buffer contents.
	 * Relies on the address as given in the file's footer. */
	_parseHeader(buffer: Uint8Array): IHeader {
		const address = this.footer.FILE?.FEATURE
			? parseInt(this.footer.FILE.FEATURE)
			: 24;
		const data = parseKeyValue(buffer, address, this.lengthFieldSize);
		this.header = {
			MODULE_LABEL: '0',
			FILE_TYPE: '0',
			APPLY_EQUIPMENT: '0',
			FINAL_OPERATION_PAGE: '0',
			FINAL_OPERATION_LAYER: '0',
			ORIGINAL_STYLE: '0',
			ORIGINAL_STYLEMD5: '0',
			DEVICE_DPI: '0',
			SOFT_DPI: '0',
			FILE_PARSE_TYPE: '0',
			RATTA_ETMD: '0',
			APP_VERSION: '0',
			FILE_RECOGN_TYPE: '0',
			...data,
		};
		return this.header;
	}

	/** Parse pages of a Supernote file's buffer contents.
	 * Relies on the address as given in the file's footer. */
	_parsePages(buffer: Uint8Array) {
		const collator = new Intl.Collator([], { numeric: true });
		const pages: IPage[] = Array.from(Object.keys(this.footer.PAGE))
			.sort((a, b) => collator.compare(a, b))
			.map((idx) => {
				const address = parseInt(this.footer.PAGE[idx]);
				const data = parseKeyValue(buffer, address, this.lengthFieldSize);
				const recognitionElements = this._parseRecognition(buffer, data['RECOGNTEXT'] as string) || [];
				return {
					PAGESTYLE: '0',
					PAGESTYLEMD5: '0',
					LAYERSWITCH: '0',
					TOTALPATH: '0',
					THUMBNAILTYPE: '0',
					RECOGNSTATUS: RecognitionStatuses.NONE,
					RECOGNTEXT: '0',
					RECOGNFILE: '0',
					RECOGNFILESTATUS: RecognitionStatuses.NONE,
					ORIENTATION: '0',
					...data,
					MAINLAYER: this._parseLayer(
						buffer,
						parseInt((data.MAINLAYER as string) ?? '0'),
					),
					LAYER1: this._parseLayer(
						buffer,
						parseInt((data.LAYER1 as string) ?? '0'),
					),
					LAYER2: this._parseLayer(
						buffer,
						parseInt((data.LAYER2 as string) ?? '0'),
					),
					LAYER3: this._parseLayer(
						buffer,
						parseInt((data.LAYER3 as string) ?? '0'),
					),
					BGLAYER: this._parseLayer(
						buffer,
						parseInt((data.BGLAYER as string) ?? '0'),
					),
					LAYERINFO: extractLayerInfo(data['LAYERINFO'] as string),
					LAYERSEQ: (data['LAYERSEQ'] as string).split(',') as ILayerNames[],
					recognitionElements: recognitionElements,
					paragraphs: this._extractParagraphs(recognitionElements),
					text: this._extractText(recognitionElements),
					totalPathBuffer: getContentAtAddress(
						buffer,
						parseInt((data.TOTALPATH as string) ?? '0'),
						this.lengthFieldSize,
					),
				};
			});
		this.pages = pages;
		return pages;
	}

	/** Parse text of a Supernote file's buffer contents.
	 * Relies on the address as given in the file's footer. */
	_parseRecognition(buffer: Uint8Array, text: string) {
		if (text === '0' || text === undefined) {
			return;
		}

		const address = parseInt(text);
		const data = getContentAtAddress(buffer, address, this.lengthFieldSize);

		if (data === null) {
			return;
		}

		const recognJson = new TextDecoder('utf8').decode(data);
		const recogn = JSON.parse(atob(recognJson));

		const elements: IRecognitionElement[] = recogn.elements || [];

		return elements
	}

	_extractText(elements: IRecognitionElement[]) {
		return extractText(elements);
	}

	_extractParagraphs(elements: IRecognitionElement[]) {
		return extractParagraphs(elements);
	}

	/** Parse layer at a specific address in a Supernote file's buffer contents. */
	_parseLayer(buffer: Uint8Array, address: number): ILayer {
		const data = parseKeyValue(buffer, address, this.lengthFieldSize);
		const bitmapBuffer = getContentAtAddress(
			buffer,
			parseInt((data.LAYERBITMAP as string) ?? '0'),
			this.lengthFieldSize,
		);
		return {
			LAYERTYPE: 'NOTE',
			LAYERPROTOCOL: 'RATTA_RLE',
			LAYERNAME: 'MAINLAYER',
			LAYERPATH: '0',
			LAYERBITMAP: '0',
			LAYERVECTORGRAPH: '0',
			LAYERRECOGN: '0',
			...data,
			bitmapBuffer,
		};
	}

	/** Parse cover from Supernote file's buffer contents. */
	_parseCover(buffer: Uint8Array): ICover | undefined {
		const address = parseInt(this.footer.COVER['0'] ?? this.footer.COVER['1']);
		if (address && address > 0) {
			const bitmapBuffer = getContentAtAddress(
				buffer,
				address,
				this.lengthFieldSize,
			);
			this.cover = { bitmapBuffer };
		}
		return this.cover;
	}

	/** Parse keywords from Supernote file's buffer contents. */
	_parseKeywords(buffer: Uint8Array): Record<string, IKeyword[]> {
		this.keywords = {};
		Object.entries(this.footer.KEYWORD).forEach(([key, value]) => {
			if (!(key in this.keywords)) this.keywords[key] = [];
			if (typeof value === 'string')
				this.keywords[key].push(this._parseKeyword(buffer, parseInt(value)));
			else
				value.forEach((address) =>
					this.keywords[key].push(
						this._parseKeyword(buffer, parseInt(address)),
					),
				);
		});
		return this.keywords;
	}

	/** Parse a single keyword entry at a certain buffer address. */
	_parseKeyword(buffer: Uint8Array, address: number): IKeyword {
		const data = parseKeyValue(buffer, address, this.lengthFieldSize);
		const bitmapBuffer = getContentAtAddress(
			buffer,
			parseInt((data.KEYWORDSITE as string) ?? '0'),
			this.lengthFieldSize,
		);
		const keyword: IKeyword = {
			KEYWORDSEQNO: '0',
			KEYWORDPAGE: '1',
			KEYWORDRECT: ['0', '0', '0', '0'],
			KEYWORDRECTORI: ['0', '0', '0', '0'],
			KEYWORDSITE: '0',
			KEYWORDLEN: '0',
			KEYWORD: '',
			bitmapBuffer,
		};
		return keyword;
	}

	/** Parse titles from Supernote file's buffer contents. */
	_parseTitles(buffer: Uint8Array): Record<string, ITitle[]> {
		this.titles = {};
		Object.entries(this.footer.TITLE).forEach(([key, value]) => {
			if (!(key in this.titles)) this.titles[key] = [];
			if (typeof value === 'string')
				this.titles[key].push(this._parseTitle(buffer, parseInt(value)));
			else
				value.forEach((address) =>
					this.titles[key].push(this._parseTitle(buffer, parseInt(address))),
				);
		});
		return this.titles;
	}

	/** Parse a single title entry at a certain buffer address. */
	_parseTitle(buffer: Uint8Array, address: number): ITitle {
		const data = parseKeyValue(buffer, address, this.lengthFieldSize);
		const bitmapBuffer = getContentAtAddress(
			buffer,
			parseInt((data.TITLEBITMAP as string) ?? '0'),
			this.lengthFieldSize,
		);
		const title: ITitle = {
			TITLESEQNO: '0',
			TITLELEVEL: '1',
			TITLERECT: ['0', '0', '0', '0'],
			TITLERECTORI: ['0', '0', '0', '0'],
			TITLEBITMAP: '0',
			TITLEPROTOCOL: 'RATTA_RLE',
			TITLESTYLE: '1000254',
			...data,
			bitmapBuffer,
		};
		return title;
	}
}

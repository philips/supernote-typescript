import initSqlJs, { Database, SqlJsConfig, SqlValue } from 'sql.js';
import { Image, ImageColorModel, decodePng } from 'image-js';
import { compositeImages } from './conversion.js';

/**
 * Support for `.spd` files created by the Supernote Atelier app.
 *
 * Unlike `.note` files (see `SupernoteX`), a `.spd` file is a plain SQLite
 * database. Its schema and the meaning of several `config` entries are not
 * publicly documented; the layout used here was reverse-engineered from
 * https://github.com/Ziv-Ink/Atelier-parser, a community tool that writes
 * `.spd` files, and cross-checked against a real device-generated `.spd`
 * file (which is how the dynamic `surface_*` naming and `surface.width`/
 * `surface.height` config entries below were found; that tool only ever
 * writes `surface_1`/`surface_2` and doesn't set those two keys at all). The
 * `ls` layer list is still a best-effort decode: its format is unconfirmed.
 */

/** A single Atelier canvas tile, as stored in a `surface_*` table. */
export interface IAtelierTile {
	/** Tile id. Encodes the tile's grid position (see `toImage`). */
	tid: number;
	/** PNG-encoded tile image content. */
	bitmapBuffer: Uint8Array;
}

/** Viewport position/zoom the editor had open, decoded from `vp.x`/`vp.y`/`vp.scale`. */
export interface IAtelierViewport {
	x: number;
	y: number;
	scale: number;
}

/** Canvas pixel size, decoded from `surface.width`/`surface.height`. Tiles are
 * only stored for grid cells that have been drawn on, so this can be larger
 * than the bounding box of any one surface's own tiles (see `toImage`). */
export interface IAtelierCanvasSize {
	width: number;
	height: number;
}

/** A layer entry decoded from the `ls` config value.
 * Best-effort: `ls`'s format isn't documented, see the module doc comment.
 * `id` matches the numeric suffix of the corresponding `surface_{id}` table,
 * e.g. `{ id: 9999, name: 'Reference Layer' }` pairs with `surface_9999`. */
export interface IAtelierLayer {
	id: number;
	name: string;
}

/** Name of a tile table found in a `.spd` file, e.g. `surface_1`. Real files
 * aren't limited to `surface_1`/`surface_2`: layers can use arbitrary
 * `surface_{layerId}` names (a "Reference Layer" observed in a real file used
 * `surface_9999`), so this is whatever `surface_*` tables the file has. */
export type IAtelierSurfaceName = string;

const SURFACE_TABLE_PATTERN = /^surface_\d+$/;

/** Tiles address their grid column in the upper bits and row in the lower
 * bits of `tid`, i.e. `tid = col * TILE_ID_STRIDE + row + offset`, where
 * `offset` depends on the tile's absolute position on Atelier's (much
 * larger) virtual canvas. Reverse-engineered from the fixed `tids` table in
 * https://github.com/Ziv-Ink/Atelier-parser/blob/main/atelierparser.py and
 * confirmed against a real device-generated `.spd` file (row/col spans
 * derived this way matched that file's `surface.width`/`surface.height`).
 * Deriving row/col this way (rather than assuming a canvas size) means it
 * keeps working regardless of where on the virtual canvas a document's
 * tiles happen to sit. */
const TILE_ID_STRIDE = 4096;

/** Hard ceiling on a composited image's total pixel count. `toImage()` sizes
 * its output against the tile-grid bounding box across *every* tile in the
 * file (see its doc comment) with no other check - a single tile whose `tid`
 * is far from the rest (a corrupted file, or a stray mark placed far off on
 * Atelier's much larger virtual canvas, see `TILE_ID_STRIDE`'s doc comment)
 * blows that bounding box out arbitrarily far, and `toImage()` would
 * otherwise allocate accordingly. On a memory-constrained host (verified:
 * this is what caused supernote-obsidian-plugin#147, a hard iOS crash on
 * open, not a catchable one - WKWebView's per-process memory ceiling is far
 * stricter than desktop's) that's an out-of-memory crash rather than a slow
 * tab. Real device-generated files observed so far top out around
 * 1920x2560 (~4.9 megapixels; see atelier.test.ts) - this leaves generous
 * headroom above that while still keeping the worst case bounded. */
const MAX_COMPOSITE_PIXELS = 32_000_000;

/** Parsed Supernote Atelier `.spd` file. */
export class SupernoteAtelier {
	declare fmtVer?: number;
	declare thumbnailBuffer: Uint8Array | null;
	declare viewport?: IAtelierViewport;
	/** Canvas pixel size, decoded from `surface.width`/`surface.height`. */
	declare canvasSize?: IAtelierCanvasSize;
	declare layers?: IAtelierLayer[];
	/** Every `config` entry as raw bytes, keyed by name, for values not
	 * otherwise exposed (e.g. `frames`) or when the best-effort decodes above
	 * come back empty. */
	declare config: Record<string, Uint8Array>;
	/** Tiles per surface, keyed by surface name (e.g. `surface_1`). */
	declare surfaces: Record<IAtelierSurfaceName, IAtelierTile[]>;
	/** Tile grid bounds shared across every surface in the file, so that
	 * images from different surfaces line up when composited (see `toImage`).
	 * `null` if the file has no tiles at all. */
	private declare _gridBounds: IGridBounds | null;

	private constructor() {}

	/**
	 * Parse a `.spd` file's contents.
	 * @param buffer Raw file contents.
	 * @param sqlJsConfig Passed through to `sql.js`'s `initSqlJs`, e.g. to
	 * supply `locateFile` when bundling for the browser.
	 */
	static async open(buffer: Uint8Array, sqlJsConfig?: SqlJsConfig): Promise<SupernoteAtelier> {
		const SQL = await initSqlJs(sqlJsConfig);
		const db = new SQL.Database(buffer);
		try {
			const note = new SupernoteAtelier();
			note.config = note._parseConfig(db);
			note.fmtVer = note._parseFmtVer(note.config);
			note.thumbnailBuffer = note._parseThumbnail(note.config);
			note.viewport = note._parseViewport(note.config);
			note.canvasSize = note._parseCanvasSize(note.config);
			note.layers = note._parseLayers(note.config);
			note.surfaces = note._parseSurfaces(db);
			note._gridBounds = computeGridBounds(Object.values(note.surfaces).flat());
			return note;
		} finally {
			db.close();
		}
	}

	/** Read every row of the `config` table into a name -> bytes map. */
	private _parseConfig(db: Database): Record<string, Uint8Array> {
		const config: Record<string, Uint8Array> = {};
		const results = db.exec('SELECT name, value FROM config');
		for (const row of results[0]?.values ?? []) {
			const [name, value] = row as [string, SqlValue];
			config[name] = toBytes(value);
		}
		return config;
	}

	private _parseFmtVer(config: Record<string, Uint8Array>): number | undefined {
		if (!('fmt_ver' in config)) return undefined;
		const parsed = parseInt(decodeUtf8(config.fmt_ver), 10);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	private _parseThumbnail(config: Record<string, Uint8Array>): Uint8Array | null {
		const thumbnail = config.thumbnail;
		return thumbnail && thumbnail.length > 0 ? thumbnail : null;
	}

	private _parseViewport(config: Record<string, Uint8Array>): IAtelierViewport | undefined {
		if (!('vp.x' in config) || !('vp.y' in config) || !('vp.scale' in config)) return undefined;
		const x = parseFloat(decodeUtf8(config['vp.x']));
		const y = parseFloat(decodeUtf8(config['vp.y']));
		const scale = parseFloat(decodeUtf8(config['vp.scale']));
		if ([x, y, scale].some(Number.isNaN)) return undefined;
		return { x, y, scale };
	}

	private _parseLayers(config: Record<string, Uint8Array>): IAtelierLayer[] | undefined {
		if (!('ls' in config)) return undefined;
		return decodeAtelierLayers(config.ls);
	}

	private _parseCanvasSize(config: Record<string, Uint8Array>): IAtelierCanvasSize | undefined {
		if (!('surface.width' in config) || !('surface.height' in config)) return undefined;
		const width = parseFloat(decodeUtf8(config['surface.width']));
		const height = parseFloat(decodeUtf8(config['surface.height']));
		if ([width, height].some(Number.isNaN)) return undefined;
		return { width, height };
	}

	/** Read every row of every `surface_{n}` tile table found in the file.
	 * Real files aren't limited to `surface_1`/`surface_2` (e.g. an imported
	 * background "Reference Layer" was observed in a real file as
	 * `surface_9999`, its `ls` layer id), so the tables to read are
	 * discovered from `sqlite_master` rather than assumed. */
	private _parseSurfaces(db: Database): Record<IAtelierSurfaceName, IAtelierTile[]> {
		const tableNames = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? [])
			.map((row) => row[0] as string)
			.filter((name) => SURFACE_TABLE_PATTERN.test(name));

		const surfaces: Record<IAtelierSurfaceName, IAtelierTile[]> = {};
		for (const name of tableNames) {
			const results = db.exec(`SELECT tid, tile FROM ${name}`);
			surfaces[name] = (results[0]?.values ?? []).map((row) => {
				const [tid, tile] = row as [number, SqlValue];
				return { tid, bitmapBuffer: toBytes(tile) };
			});
		}
		return surfaces;
	}

	/**
	 * Stitch a surface's tiles into a single composite image, positioned by
	 * their tile ids (see `TILE_ID_STRIDE`). The output is sized and
	 * positioned against the tile grid bounds of *every* surface in the
	 * file (not just this one), so images from different surfaces of the
	 * same file line up and can be composited directly (e.g. drawing layers
	 * over an imported background that covers a larger area). Grid cells
	 * with no tile (nothing drawn there) are left transparent. Returns
	 * `null` if the surface doesn't exist or has no tiles anywhere in the file.
	 */
	async toImage(surfaceName: IAtelierSurfaceName = 'surface_1'): Promise<Image | null> {
		const tiles = this.surfaces[surfaceName];
		if (!tiles || tiles.length === 0 || this._gridBounds === null) return null;

		const { minRow, minCol, maxRow, maxCol } = this._gridBounds;

		const decoded = await Promise.all(
			tiles.map(async (tile) => ({
				row: tile.tid % TILE_ID_STRIDE,
				col: Math.floor(tile.tid / TILE_ID_STRIDE),
				image: normalizeTransparentPixels(
					decodePng(tile.bitmapBuffer).convertBitDepth(8).convertColor(ImageColorModel.RGBA),
				),
			})),
		);

		const tileWidth = decoded[0].image.width;
		const tileHeight = decoded[0].image.height;
		const width = (maxCol - minCol + 1) * tileWidth;
		const height = (maxRow - minRow + 1) * tileHeight;
		if (width * height > MAX_COMPOSITE_PIXELS) {
			throw new Error(
				`Refusing to composite "${surfaceName}": computed size ${width}x${height} ` +
				`(${(width * height).toLocaleString()} px) exceeds the ${MAX_COMPOSITE_PIXELS.toLocaleString()}px ` +
				'safety limit. This usually means one tile is positioned far from the rest ' +
				'(a corrupted or out-of-range tile id) rather than a genuinely huge canvas.',
			);
		}
		const output = new Image(width, height, {
			colorModel: ImageColorModel.RGBA,
		});
		// image-js defaults a new image's alpha channel to fully opaque (and
		// RGB to 0, i.e. opaque black), not transparent. Grid cells with no
		// tile need to read as "nothing here" -- both for this method's own
		// callers and for compositeImages() in toCompositeImage(), which
		// would otherwise treat this opaque black filler as real content and
		// paint over whatever it's layered onto.
		output.getRawImage().data.fill(0);

		for (const { image, row, col } of decoded) {
			pasteImage(output, image, (col - minCol) * tileWidth, (row - minRow) * tileHeight);
		}

		return output;
	}

	/**
	 * Stitch and flatten a set of surfaces into one final image, in the same
	 * aligned coordinate space `toImage` uses. Surfaces are layered
	 * bottom-to-top using `layers` (from the `ls` config value) reversed:
	 * that list has been observed with the frontmost/topmost layer first
	 * (matching how most layer panels list layers), and painting back to
	 * front puts it visually on top. This ordering is a best-effort guess
	 * alongside the rest of `layers`, see the module doc comment; if `ls`
	 * didn't decode, surfaces are composited in an arbitrary order instead.
	 * @param visibleSurfaces Surface names to include (e.g. from a
	 * layer-visibility toggle), in any order -- composite order is still
	 * decided by `layers`/`ls`, not by the order given here. Defaults to
	 * every surface in the file. Names not present in the file are ignored.
	 * Returns `null` if nothing ends up included (no tiles at all, or an
	 * empty/all-excluded `visibleSurfaces`).
	 */
	async toCompositeImage(visibleSurfaces?: Iterable<IAtelierSurfaceName>): Promise<Image | null> {
		let order = this._compositeOrder();
		if (visibleSurfaces !== undefined) {
			const visible = new Set(visibleSurfaces);
			order = order.filter((surfaceName) => visible.has(surfaceName));
		}

		const images: Image[] = [];
		for (const surfaceName of order) {
			const image = await this.toImage(surfaceName);
			if (image !== null) images.push(image);
		}
		if (images.length === 0) return null;

		const output = images[0].clone();
		for (let i = 1; i < images.length; i++) {
			compositeImages(images[i], output);
		}
		return output;
	}

	/** Bottom-to-top surface names to composite in `toCompositeImage`. */
	private _compositeOrder(): IAtelierSurfaceName[] {
		if (this.layers && this.layers.length > 0) {
			return [...this.layers].reverse().map((layer) => `surface_${layer.id}`);
		}
		return Object.keys(this.surfaces);
	}
}

interface IGridBounds {
	minRow: number;
	minCol: number;
	maxRow: number;
	maxCol: number;
}

/** Bounding box, in tile grid coordinates, of every tile across every
 * surface passed in. `null` if `tiles` is empty. */
function computeGridBounds(tiles: IAtelierTile[]): IGridBounds | null {
	if (tiles.length === 0) return null;
	const rows = tiles.map((t) => t.tid % TILE_ID_STRIDE);
	const cols = tiles.map((t) => Math.floor(t.tid / TILE_ID_STRIDE));
	return {
		minRow: Math.min(...rows),
		minCol: Math.min(...cols),
		maxRow: Math.max(...rows),
		maxCol: Math.max(...cols),
	};
}

/** Zeroes the RGB of every fully-transparent pixel in an 8-bit RGBA image, in
 * place. `pasteImage` and `compositeImages` (from `conversion.ts`, reused by
 * `toCompositeImage`) both treat a pixel as "nothing here" by checking
 * whether its packed RGBA value is exactly zero -- which a transparent pixel
 * only satisfies if its RGB happens to be zero too. PNG encoders are free to
 * leave arbitrary RGB behind a zero alpha (a fully-transparent white pixel,
 * e.g. `(255, 255, 255, 0)`, is packed as non-zero), so tiles need this
 * normalization before compositing, rather than assuming every encoder
 * zeroes RGB under a transparent alpha. */
function normalizeTransparentPixels(image: Image): Image {
	const data = image.getRawImage().data;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] === 0) {
			data[i] = 0;
			data[i + 1] = 0;
			data[i + 2] = 0;
		}
	}
	return image;
}

/** Copies `source`'s pixels into `destination` at pixel offset `(x, y)`. Both
 * must be 8-bit RGBA images. */
function pasteImage(destination: Image, source: Image, x: number, y: number) {
	const dst = destination.getRawImage();
	const src = source.getRawImage();
	if (dst.bitDepth !== 8 || src.bitDepth !== 8 || dst.channels !== 4 || src.channels !== 4) {
		throw new Error('pasteImage only supports 8-bit RGBA images.');
	}
	const rowBytes = src.width * src.channels;
	for (let row = 0; row < src.height; row++) {
		const srcStart = row * rowBytes;
		const dstStart = ((y + row) * dst.width + x) * dst.channels;
		dst.data.set(src.data.subarray(srcStart, srcStart + rowBytes), dstStart);
	}
}

function toBytes(value: SqlValue): Uint8Array {
	if (value === null) return new Uint8Array();
	if (value instanceof Uint8Array) return value;
	if (typeof value === 'string') return new TextEncoder().encode(value);
	return new TextEncoder().encode(String(value));
}

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder('utf8').decode(bytes);
}

interface IProtoField {
	fieldNumber: number;
	wireType: number;
	value: number | Uint8Array;
}

/** Reads a protobuf varint starting at `offset`, returning its value and the
 * offset just past it. */
function readVarint(data: Uint8Array, offset: number): [value: number, next: number] {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (true) {
		if (pos >= data.length) throw new Error('Truncated varint.');
		const byte = data[pos++];
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}
	return [result >>> 0, pos];
}

/** Minimal protobuf wire-format walker: enough to read `ls`'s top-level
 * varint and length-delimited fields. Only wire types 0 (varint) and 2
 * (length-delimited) are supported, which is all `ls` has been observed to
 * use; anything else stops decoding early rather than misinterpreting bytes. */
function readProtoFields(data: Uint8Array): IProtoField[] {
	const fields: IProtoField[] = [];
	let pos = 0;
	while (pos < data.length) {
		const [tag, afterTag] = readVarint(data, pos);
		const fieldNumber = tag >>> 3;
		const wireType = tag & 0x7;
		if (wireType === 0) {
			const [value, next] = readVarint(data, afterTag);
			fields.push({ fieldNumber, wireType, value });
			pos = next;
		} else if (wireType === 2) {
			const [len, next] = readVarint(data, afterTag);
			if (next + len > data.length) throw new Error('Truncated length-delimited field.');
			fields.push({ fieldNumber, wireType, value: data.subarray(next, next + len) });
			pos = next + len;
		} else {
			break;
		}
	}
	return fields;
}

/** Best-effort decode of the `ls` config value into a layer list: field 1 is
 * a repeated submessage per layer, with the layer id in its field 1 (varint)
 * and its name in field 2 (string). Returns `undefined` rather than throwing
 * if the bytes don't match this shape, since `ls`'s format is unconfirmed. */
function decodeAtelierLayers(data: Uint8Array): IAtelierLayer[] | undefined {
	try {
		const layers: IAtelierLayer[] = [];
		for (const field of readProtoFields(data)) {
			if (field.fieldNumber !== 1 || field.wireType !== 2) continue;
			const sub = readProtoFields(field.value as Uint8Array);
			const idField = sub.find((f) => f.fieldNumber === 1 && f.wireType === 0);
			const nameField = sub.find((f) => f.fieldNumber === 2 && f.wireType === 2);
			if (!nameField) continue;
			layers.push({
				id: typeof idField?.value === 'number' ? idField.value : 0,
				name: decodeUtf8(nameField.value as Uint8Array),
			});
		}
		return layers.length > 0 ? layers : undefined;
	} catch {
		return undefined;
	}
}

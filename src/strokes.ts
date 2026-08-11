/** A single point on a decoded pen stroke, already converted to page pixel
 * coordinates (same space as `ISupernote.pageWidth`/`pageHeight`). */
export interface IStrokePoint {
	x: number;
	y: number;
}

/** Pen tool a stroke was drawn with, decoded from `TOTALPATH`'s own per-stroke
 * `pen` field. Not every device tool has a confirmed id yet -- an
 * unrecognized numeric id is kept as `'unknown'` rather than guessed at (see
 * `parseStrokes`'s doc comment for how these were found). */
export type StrokePen = 'needlePoint' | 'inkPen' | 'marker' | 'unknown';

/** One continuous pen stroke (a single pen-down-to-pen-up motion), decoded
 * from a page's `TOTALPATH` data -- including its real color, tool, and
 * thickness, not just geometry (see `parseStrokes`'s doc comment). */
export interface IStroke {
	points: IStrokePoint[];
	/** CSS `rgb(...)` color this stroke was actually drawn in on-device --
	 * exact, not sampled from a raster. */
	color: string;
	pen: StrokePen;
	/** Raw on-device thickness setting, in the same arbitrary device units
	 * `TOTALPATH` itself uses (confirmed to order consistently with the
	 * on-device width slider, but not confirmed to be linear in physical
	 * units) -- scale like any other opaque magnitude, don't assume a
	 * physical unit conversion. */
	thickness: number;
}

/** Raw pen tool ids observed in `TOTALPATH`'s `pen` field -- reverse
 * engineered against `stroke-isolation.note` (which isolates one tool per
 * stroke) and cross-referenced against
 * https://github.com/Walnut356/snlib/blob/main/src/pen.rs, an independent
 * Rust implementation with a matching (if only partially enumerated) `Pen`
 * enum. `10`/`11` match that enum's `NeedlePoint`/`Marker` exactly; `16` is
 * this repo's own finding (unconfirmed against snlib, which doesn't list a
 * value for `InkPen`), consistently seen wherever a stroke's tool is known
 * to be the ink pen. Any other id maps to `'unknown'` rather than a guess. */
const PEN_IDS: Record<number, StrokePen> = {
	10: 'needlePoint',
	16: 'inkPen',
	11: 'marker',
};

/** Reserved `color` value meaning "this isn't ink at all, it's an eraser
 * stroke" -- confirmed against https://github.com/Walnut356/snlib's `Color`
 * enum (`Eraser = 255`) and directly against real fixtures: the exact
 * strokes that used to decode as smooth-but-nonexistent phantom ink in
 * `horizontal_1270.note` (see issue #56) carry this color. `parseStrokes`
 * filters these out entirely -- they're real, correctly-decoded pen
 * motions, just not strokes that were ever meant to render as visible ink
 * (Supernote's eraser tool is itself a physical pen motion the digitizer
 * records like any other). */
const ERASER_COLOR = 255;

/** Byte layout of the fixed-size header (`StrokeConfig` in
 * https://github.com/Walnut356/snlib) every stroke record starts with.
 * Offsets confirmed against real fixtures: `DOC_KIND_OFFSET` is exactly
 * where the byte string `superNoteNote` (this module's previous scanning
 * landmark) is found on every real stroke checked. Only the fields this
 * module actually reads are named; the rest of the 208-byte header
 * (recognition-mode flags, font height, bounding box, screen width, and
 * more, all still unconfirmed) is skipped over as a fixed span. */
const STROKE_CONFIG = {
	PEN_OFFSET: 0,
	COLOR_OFFSET: 4,
	THICKNESS_OFFSET: 8,
	/** In the same device units `parseStrokes`' `scale` divides through --
	 * this is the field the previous version of this module already relied
	 * on for the same purpose, under the name `nativeHeightBound`, before
	 * this byte layout was known (found back then via a
	 * `superNoteNote`-relative offset instead of `StrokeConfig`'s own). */
	SCREEN_HEIGHT_OFFSET: 128,
	DOC_KIND_OFFSET: 136,
	SIZE: 208,
} as const;

interface RawStroke {
	pen: number;
	color: number;
	thickness: number;
	screenHeight: number;
	points: [number, number][]; // raw (y, x) pairs, undivided device units
}

/** Reads one stroke record starting at `pos` (immediately after its own
 * `strokeLen` prefix -- see `parseStrokes`), or `null` if there isn't
 * enough buffer left to hold at least a full `StrokeConfig` header plus an
 * empty `disable_area_list`/`points` pair. Never throws on a truncated or
 * corrupt tail -- returns `null` so the caller can stop cleanly rather than
 * crash on a real file this hasn't been validated against. */
function tryParseStroke(view: DataView, byteLength: number, pos: number): RawStroke | null {
	if (pos + STROKE_CONFIG.SIZE + 8 > byteLength) return null;

	const pen = view.getUint32(pos + STROKE_CONFIG.PEN_OFFSET, true);
	const color = view.getUint32(pos + STROKE_CONFIG.COLOR_OFFSET, true);
	const thickness = view.getUint32(pos + STROKE_CONFIG.THICKNESS_OFFSET, true);
	const screenHeight = view.getUint32(pos + STROKE_CONFIG.SCREEN_HEIGHT_OFFSET, true);
	if (screenHeight === 0) return null;

	let p = pos + STROKE_CONFIG.SIZE;

	// disable_area_list: length-prefixed array of 3-ScreenCoord entries (24
	// bytes each), almost always empty in practice -- still real length data
	// to skip past, not a fixed gap.
	if (p + 4 > byteLength) return null;
	const disableAreaCount = view.getUint32(p, true);
	p += 4 + disableAreaCount * 24;

	if (p + 4 > byteLength) return null;
	const pointCount = view.getUint32(p, true);
	p += 4;
	if (p + pointCount * 8 > byteLength) return null;

	const points: [number, number][] = new Array(pointCount);
	for (let i = 0; i < pointCount; i++) {
		const offset = p + i * 8;
		// ScreenCoord stores (y, x) in that order, not (x, y) -- see
		// parseStrokes' doc comment for the coordinate transform this feeds.
		points[i] = [view.getUint32(offset, true), view.getUint32(offset + 4, true)];
	}

	return { pen, color, thickness, screenHeight, points };
}

/**
 * Decodes a page's `TOTALPATH` buffer into pen strokes in page pixel space,
 * including each stroke's real color, tool, and thickness -- not sampled or
 * estimated, read directly from the same per-stroke metadata Supernote's own
 * software writes.
 *
 * `TOTALPATH` is undocumented (not covered by any known open-source
 * Supernote parser) and this decode was arrived at by reverse-engineering
 * real `.note` files rather than from a spec -- see
 * https://github.com/philips/supernote-typescript/issues/55 for the
 * original geometry investigation. An earlier version of this module found
 * stroke boundaries by brute-force byte-by-byte scanning for a
 * self-checksumming record shape, because that investigation never found
 * where (or whether) `TOTALPATH` stored anything beyond point coordinates --
 * confirmed exhaustively at the time by comparing strokes drawn with
 * different tools/colors/widths and finding identical bytes near each
 * record. That conclusion turned out to be an artifact of only ever looking
 * a few dozen bytes around a stroke's coordinate data: an independent Rust
 * implementation, https://github.com/Walnut356/snlib, documents a complete,
 * deterministic outer structure this module now follows instead:
 *
 * ```
 * u32 strokeCount
 * for each of strokeCount strokes:
 *   u32 strokeLen              // byte length of everything below, this stroke only
 *   StrokeConfig (208 bytes)   // pen, color, thickness, and ~20 other fields, most still unconfirmed
 *   disable_area_list          // u32 count + count*24 bytes, almost always empty
 *   points                     // u32 count + count*8 bytes -- (y, x) uint32 pairs
 *   ...more length-prefixed sections this module doesn't need and skips
 *      via strokeLen, not by parsing them (pressures, tilts, a nested
 *      per-point contour list, several sections of still-unconfirmed
 *      fixed-size fields, and more -- see snlib's `Stroke` struct for the
 *      full list, none of it needed for color/tool/thickness/geometry)
 * ```
 *
 * `strokeLen` alone is enough to always advance to the next real stroke
 * correctly, regardless of whether every field in between is understood --
 * unlike the old byte-scanning approach, this can't drift into a stroke's
 * own inner arrays (e.g. its nested contour-point list) and misread real,
 * structured-but-unrelated bytes as an independent phantom stroke (the root
 * cause of `rtr.note`'s circular phantom stroke from the pre-fix
 * investigation in issue #56 -- there is no such stroke in the real
 * structure at all).
 *
 * `TOTALPATH`'s own address (`getContentAtAddress`, in `parsing.ts`) already
 * strips one length prefix, so `totalPathBuffer[0..4]` is `strokeCount`
 * directly, not `strokeCount`'s own length prefix again.
 *
 * The coordinate transform (confirmed pixel-exact against rendered ink on
 * multiple device families):
 * ```
 * scale = screenHeight / pageHeight   // screenHeight: this stroke's own StrokeConfig field
 * pixelX = -rawX / scale + pageWidth
 * pixelY =  rawY / scale
 * ```
 *
 * Strokes whose `color` is `255` are excluded entirely, not returned as
 * `IStroke`s -- see `ERASER_COLOR`'s doc comment: they're real pen motions
 * (Supernote's eraser is a physical gesture like any other tool), just never
 * meant to render as ink. This is what `horizontal_1270.note`'s phantom
 * scribbles actually were: real eraser strokes, exactly identifiable by this
 * one field, not a decode bug and not something raster cross-checking ever
 * needed to guess at.
 *
 * Returns `[]` if `totalPathBuffer` is `null`, too short to hold a single
 * stroke, or its layout isn't recognized (e.g. a genuinely blank page, or a
 * page whose `TOTALPATH` uses a structure this hasn't been validated
 * against yet).
 */
export function parseStrokes(totalPathBuffer: Uint8Array | null, pageWidth: number, pageHeight: number): IStroke[] {
	if (!totalPathBuffer || totalPathBuffer.length < STROKE_CONFIG.SIZE || pageHeight <= 0 || pageWidth <= 0) return [];

	const view = new DataView(totalPathBuffer.buffer, totalPathBuffer.byteOffset, totalPathBuffer.byteLength);
	const byteLength = totalPathBuffer.length;

	const strokeCount = view.getUint32(0, true);
	if (strokeCount === 0 || strokeCount > 1_000_000) return [];

	const strokes: IStroke[] = [];
	let pos = 4;
	for (let i = 0; i < strokeCount; i++) {
		if (pos + 4 > byteLength) break;
		const strokeLen = view.getUint32(pos, true);
		const strokeStart = pos + 4;
		const strokeEnd = strokeStart + strokeLen;
		if (strokeLen === 0 || strokeEnd > byteLength) break;

		const raw = tryParseStroke(view, byteLength, strokeStart);
		if (raw && raw.color !== ERASER_COLOR) {
			const scale = raw.screenHeight / pageHeight;
			strokes.push({
				points: raw.points.map(([y, x]) => ({ x: -x / scale + pageWidth, y: y / scale })),
				color: `rgb(${raw.color},${raw.color},${raw.color})`,
				pen: PEN_IDS[raw.pen] ?? 'unknown',
				thickness: raw.thickness,
			});
		}

		pos = strokeEnd;
	}

	return strokes;
}

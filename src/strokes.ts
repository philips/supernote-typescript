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
	 * exact, not sampled from a raster. For an eraser stroke (`isEraser`),
	 * this is always `rgb(255,255,255)` (white): `ERASER_COLOR`'s numeric
	 * value happens to already be a valid (if reserved) grey level, so no
	 * special-casing is needed to turn it into "paint over with white". */
	color: string;
	pen: StrokePen;
	/** Raw on-device thickness setting, in the same arbitrary device units
	 * `TOTALPATH` itself uses (confirmed to order consistently with the
	 * on-device width slider, but not confirmed to be linear in physical
	 * units) -- scale like any other opaque magnitude, don't assume a
	 * physical unit conversion. */
	thickness: number;
	/** True for a real eraser-tool motion (`TOTALPATH`'s reserved
	 * `color === 255`), only ever present when `parseStrokes` was called
	 * with `includeErasers: true` -- see that option's doc comment. Lets a
	 * caller that draws strokes in order (`vectorInk` does) tell an
	 * intentional "paint over with background" stroke apart from real ink
	 * sharing the same white color (e.g. a white pen on a dark page), even
	 * though both render identically. */
	isEraser?: boolean;
	/** True when an eraser has been applied to this stroke at some point --
	 * decoded from the first field of the record's `Section1`
	 * (https://github.com/Walnut356/snlib calls it `unk_8`), which reads `0`
	 * on a stroke no eraser ever touched and a small negative value
	 * otherwise.
	 *
	 * It marks *contact*, not disappearance: a stroke can be touched and
	 * still be largely visible, because the eraser only clipped part of it.
	 * Across every fixture, all 2,181 strokes reading `0` are fully present
	 * in the page's own render, so this is a sound one-way answer -- a
	 * stroke without it is definitely still there, and only strokes carrying
	 * it need the render consulted to see how much survived (see
	 * `strokeInkPresence` in `src/svg.ts`).
	 *
	 * The observed values are `-4`, `-16` and `-99`; they correlate with how
	 * much survived (every `-16` is completely gone, every `-4` is fully
	 * intact, `-99` is mixed) but the encoding isn't confirmed, so nothing
	 * keys on the specific value. */
	eraserTouched?: boolean;
	/** The device's own rendered outline of this stroke (`point_contour` in
	 * https://github.com/Walnut356/snlib) -- closed polygons in the same
	 * page-pixel space as `points`, only present when `parseStrokes` was
	 * called with `includeContours: true`.
	 *
	 * Unlike `points` (the pen's sampled *centerline*, which has to be
	 * stroked at a uniform `thickness` to be drawn), this is the filled
	 * region the device actually renders, so it carries the real
	 * pressure-varying width along the stroke -- the same thing Supernote's
	 * newer PDF exports draw as filled Bezier outlines rather than
	 * fixed-width polylines. Usually one polygon; a stroke that crosses
	 * itself can produce several, which is why this is an array of rings
	 * (fill them with the nonzero winding rule, as SVG/PDF do by default).
	 *
	 * Verified against real fixtures on two device families: each ring's
	 * bounding box matches its stroke's own transformed point extents
	 * inflated by half the rendered width, and the enclosed area comes out
	 * within a few percent of `pathLength * thickness / 100`.
	 *
	 * **This is not a record of what survived erasing.** A fully erased
	 * stroke keeps its full-area outline here, byte for byte like a visible
	 * one -- see `ERASER_COLOR`'s doc comment and
	 * plans/vector-format-spec.md's erase-records section. */
	contour?: IStrokePoint[][];
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
 * `horizontal_1270.note` (see issue #56) carry this color. By default,
 * `parseStrokes` filters these out entirely -- they're real,
 * correctly-decoded pen motions, just not strokes that were ever meant to
 * render as visible ink themselves (Supernote's eraser tool is itself a
 * physical pen motion the digitizer records like any other).
 *
 * That default is right for "give me this page's real ink", but wrong for
 * reproducing what the page actually *looks like*: dropping these strokes
 * silently un-does every *partial* erase (dragging the eraser tool over
 * part of some real ink, as opposed to a whole-stroke select-and-delete,
 * which leaves no TOTALPATH trace at all and needs no special handling
 * here) -- the ink an eraser stroke was meant to cover stays in TOTALPATH
 * exactly as originally drawn, at its real pre-erase color, since the erase
 * is recorded as its own later, separate stroke rather than as an edit to
 * the ink it covers. `parseStrokes`' `includeErasers` option keeps these
 * strokes instead (as ordinary white `isEraser: true` ink, since
 * `ERASER_COLOR` already *is* a valid white grey level), so a caller that
 * draws every stroke in `TOTALPATH`'s own order paints over the erased ink
 * with white the same way the real device does, rather than leaving it
 * fully visible. Confirmed directly against `horizontal_1270.note` and
 * `nomad-3.26.40-link-tag-3p.note` (whose "ERASER on MARKER"/"ERASER on PEN
 * LINES" fixture rows exist specifically to exercise this): each eraser
 * stroke's own record sits immediately after, and closely traces the
 * shape/bounds of, the ink it was dragged over. */
const ERASER_COLOR = 255;

/** Reserved `stroke_kind` value (see `STROKE_CONFIG.STROKE_KIND_OFFSET`)
 * meaning "this is a link-tag indicator box, not ink" -- confirmed directly
 * against `nomad-3.26.40-link-tag-3p.note` (named for exactly this
 * feature): every 5-point `stroke_kind: "0000"` record's bounding box
 * matches one of the note's own footer `LINK_*` entries' `LINKRECT`
 * pixel-exact, the same way a `TITLE_*` entry's `TITLERECT` matches a
 * Heading's 2-point rect record (see `plans/vector-format-spec.md`'s
 * `TITLE_`/`KEYWORD_` section). Never shown in the page's own rendered ink
 * -- it's a UI affordance marking a link's source region, not something the
 * user drew -- so `parseStrokes` excludes it unconditionally, the same as
 * an eraser stroke's own motion path, just without an `includeErasers`-style
 * opt-in: unlike an eraser, there's no legitimate reason to want this
 * rendered as ink. Distinct from `"0001"`, the 2-point rect `stroke_kind`
 * (a Heading/badge background fill, see `TitleStyle` in `src/svg.ts`) --
 * that one *is* handled specially precisely because its `TITLE_*`-derived
 * fill is real, intended content. */
const LINK_TAG_STROKE_KIND = '0000';

/** `pen` id of a lasso/selection *path* record -- the loop a user draws to
 * select content (then delete it, move it, or turn it into a
 * Keyword/Tag) -- not ink, and never rendered by the device. Confirmed
 * against every fixture that has one (all reading `color: 0`,
 * `thickness: 200`, and frequently recorded as two byte-identical
 * consecutive records): `erase.note` (a lasso-select-then-delete; the loop
 * is absent from both the device raster and `erase.pdf`, Supernote's own
 * export), `nomad-3.26.40-link-tag-3p.note` page 3 (keyword/tag-creation
 * selections around fully-visible words -- rendering these drew phantom
 * black circles around the text), and `unknown-color.note` (a path with ~0%
 * presence in the page's own rendered ink). Excluded unconditionally, like
 * `LINK_TAG_STROKE_KIND`: whatever the selection *did* (delete vs. move vs.
 * keyword -- not recoverable from this record, see
 * plans/vector-format-spec.md's erase-records section), the loop itself is
 * never visible content. */
const LASSO_PEN_ID = 4;

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
	/** 52-byte C string -- see `LINK_TAG_STROKE_KIND`'s doc comment for the
	 * one value this module actually checks for (`"0000"`); real ink always
	 * reads `"others"` (or, once, `"fiveStarsSignal"` for the Stars
	 * feature's star mark -- still real, user-drawn ink), and a 2-point rect
	 * record always reads `"0001"`. */
	STROKE_KIND_OFFSET: 48,
	STROKE_KIND_SIZE: 52,
	/** In the same device units `parseStrokes`' `scale` divides through --
	 * this is the field the previous version of this module already relied
	 * on for the same purpose, under the name `nativeHeightBound`, before
	 * this byte layout was known (found back then via a
	 * `superNoteNote`-relative offset instead of `StrokeConfig`'s own). */
	SCREEN_HEIGHT_OFFSET: 128,
	DOC_KIND_OFFSET: 136,
	SIZE: 208,
} as const;

/** Sizes of the two fixed-layout sections that sit between `epa_grays` and
 * `point_contour` in a stroke record -- `Section1` and `Section2` in
 * https://github.com/Walnut356/snlib, whose declared field lists come out
 * to different totals than these. Solved directly instead: the only
 * `(Section1, Section2)` pair that makes *every* record on a page parse
 * byte-exactly, jointly across pages from two device families (N5/Manta
 * `erase-no-white-pen.note`, and the older `horizontal_1270.note`). The
 * resulting contour geometry then independently validates -- see
 * `IStroke.contour`. Only the span sizes matter here; nothing in either
 * section is read. */
const SECTION_1_SIZE = 52;
const SECTION_2_SIZE = 10;

interface RawStroke {
	pen: number;
	color: number;
	thickness: number;
	strokeKind: string;
	screenHeight: number;
	points: [number, number][]; // raw (y, x) pairs, undivided device units
	/** See `IStroke.eraserTouched`. */
	eraseMark: number;
	/** Already in page-pixel space -- unlike `points`, these need no
	 * transform (see `readContour`). Only populated when asked for. */
	contour?: IStrokePoint[][];
}

/** Decodes a fixed-size, NUL-padded C string field (`stroke_kind`/`doc_kind`
 * -- see `STROKE_CONFIG`) -- trims at the first NUL rather than including
 * the trailing padding bytes as part of the string. */
function readFixedCString(view: DataView, pos: number, size: number): string {
	const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, size);
	const nul = bytes.indexOf(0);
	return new TextDecoder('utf8').decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

/** Reads the `point_contour` rings that follow a stroke's `epa_grays`
 * array, starting at `pos` (the first byte after it) -- see
 * `IStroke.contour` for what they are and `SECTION_1_SIZE` for how the two
 * fixed sections in between were sized. Returns `undefined` rather than
 * throwing if anything doesn't line up (a truncated record, or a firmware
 * whose section sizes differ), so an unrecognized layout costs the caller
 * only the contour, never the stroke.
 *
 * Unlike `points`, contour coordinates are stored as float32 pairs already
 * in final page-pixel space -- no `screenHeight` scaling and no x mirroring
 * (confirmed by matching them against transformed stroke extents on both a
 * portrait and a landscape fixture). */
function readContour(view: DataView, byteLength: number, pos: number, strokeEnd: number): IStrokePoint[][] | undefined {
	let p = pos + SECTION_1_SIZE;
	if (p + 4 > strokeEnd) return undefined;
	const controlNumCount = view.getUint32(p, true);
	p += 4 + controlNumCount * 4 + SECTION_2_SIZE;
	if (p + 4 > strokeEnd) return undefined;

	const ringCount = view.getUint32(p, true);
	p += 4;
	if (ringCount > MAX_CONTOUR_RINGS) return undefined;

	const rings: IStrokePoint[][] = [];
	for (let i = 0; i < ringCount; i++) {
		if (p + 4 > strokeEnd) return undefined;
		const pointCount = view.getUint32(p, true);
		p += 4;
		if (p + pointCount * 8 > strokeEnd || p + pointCount * 8 > byteLength) return undefined;
		const ring: IStrokePoint[] = new Array(pointCount);
		for (let j = 0; j < pointCount; j++) {
			const offset = p + j * 8;
			ring[j] = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true) };
		}
		rings.push(ring);
		p += pointCount * 8;
	}
	return rings;
}

/** Sanity cap on `point_contour`'s ring count, so a misaligned read on an
 * unvalidated firmware bails out instead of trying to allocate a bogus
 * array. Real strokes use one ring, occasionally a handful where the stroke
 * crosses itself. */
const MAX_CONTOUR_RINGS = 1000;

/** Reads one stroke record starting at `pos` (immediately after its own
 * `strokeLen` prefix -- see `parseStrokes`), or `null` if there isn't
 * enough buffer left to hold at least a full `StrokeConfig` header plus an
 * empty `disable_area_list`/`points` pair. Never throws on a truncated or
 * corrupt tail -- returns `null` so the caller can stop cleanly rather than
 * crash on a real file this hasn't been validated against. */
function tryParseStroke(
	view: DataView,
	byteLength: number,
	pos: number,
	strokeEnd: number,
	includeContours: boolean,
): RawStroke | null {
	if (pos + STROKE_CONFIG.SIZE + 8 > byteLength) return null;

	const pen = view.getUint32(pos + STROKE_CONFIG.PEN_OFFSET, true);
	const color = view.getUint32(pos + STROKE_CONFIG.COLOR_OFFSET, true);
	const thickness = view.getUint32(pos + STROKE_CONFIG.THICKNESS_OFFSET, true);
	const strokeKind = readFixedCString(view, pos + STROKE_CONFIG.STROKE_KIND_OFFSET, STROKE_CONFIG.STROKE_KIND_SIZE);
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
	p += pointCount * 8;

	// pressures (u16), tilts (4 bytes each), flag_draw (1 byte each),
	// epa_points (8), epa_grays (4) -- all length-prefixed, all skipped
	// wholesale; Section1 (and so the erase mark) begins immediately after.
	for (const elementSize of [2, 4, 1, 8, 4]) {
		if (p + 4 > strokeEnd) return { pen, color, thickness, strokeKind, screenHeight, points, eraseMark: 0 };
		p += 4 + view.getUint32(p, true) * elementSize;
	}

	const eraseMark = p + 4 <= strokeEnd ? view.getInt32(p, true) : 0;
	const contour = includeContours ? readContour(view, byteLength, p, strokeEnd) : undefined;

	return { pen, color, thickness, strokeKind, screenHeight, points, eraseMark, contour };
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
 * Strokes whose `color` is `255` are excluded by default, not returned as
 * `IStroke`s -- see `ERASER_COLOR`'s doc comment: they're real pen motions
 * (Supernote's eraser is a physical gesture like any other tool), just never
 * meant to render as ink *themselves*. This is what `horizontal_1270.note`'s
 * phantom scribbles actually were: real eraser strokes, exactly identifiable
 * by this one field, not a decode bug and not something raster
 * cross-checking ever needed to guess at. Pass `includeErasers: true` (see
 * `ERASER_COLOR`'s doc comment) to keep them instead, as ordinary white
 * `isEraser: true` strokes, needed to reproduce a *partial* erase's visual
 * effect when drawing strokes in `TOTALPATH`'s own order.
 *
 * Strokes whose `stroke_kind` is `"0000"` are excluded unconditionally (no
 * `includeErasers`-style opt-in) -- see `LINK_TAG_STROKE_KIND`'s doc
 * comment: a link-tag indicator box, not ink, confirmed against
 * `nomad-3.26.40-link-tag-3p.note`'s own footer `LINK_*` metadata.
 *
 * Strokes whose `pen` is `4` are excluded unconditionally too -- see
 * `LASSO_PEN_ID`'s doc comment: the loop drawn to lasso-select content
 * (for deletion, moving, or Keyword/Tag creation), never rendered by the
 * device.
 *
 * Returns `[]` if `totalPathBuffer` is `null`, too short to hold a single
 * stroke, or its layout isn't recognized (e.g. a genuinely blank page, or a
 * page whose `TOTALPATH` uses a structure this hasn't been validated
 * against yet).
 */
export interface ParseStrokesOptions {
	/** See `parseStrokes`' own doc comment and `ERASER_COLOR`'s. Default
	 * false, matching every existing caller's assumption that `parseStrokes`
	 * returns only real, visible ink. */
	includeErasers?: boolean;
	/** Also decode each stroke's rendered outline into `IStroke.contour` --
	 * see that field's doc comment. Default false: it's several times more
	 * geometry than `points`, and only a caller that actually fills the
	 * outline (rather than stroking the centerline) needs it. */
	includeContours?: boolean;
}

export function parseStrokes(
	totalPathBuffer: Uint8Array | null,
	pageWidth: number,
	pageHeight: number,
	options: ParseStrokesOptions = {},
): IStroke[] {
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

		const raw = tryParseStroke(view, byteLength, strokeStart, strokeEnd, options.includeContours === true);
		const isEraser = raw?.color === ERASER_COLOR;
		const isLinkTag = raw?.strokeKind === LINK_TAG_STROKE_KIND;
		const isLassoPath = raw?.pen === LASSO_PEN_ID;
		if (raw && !isLinkTag && !isLassoPath && (!isEraser || options.includeErasers)) {
			const scale = raw.screenHeight / pageHeight;
			strokes.push({
				points: raw.points.map(([y, x]) => ({ x: -x / scale + pageWidth, y: y / scale })),
				color: `rgb(${raw.color},${raw.color},${raw.color})`,
				pen: PEN_IDS[raw.pen] ?? 'unknown',
				thickness: raw.thickness,
				...(isEraser ? { isEraser: true } : {}),
				...(raw.eraseMark !== 0 ? { eraserTouched: true } : {}),
				...(raw.contour ? { contour: raw.contour } : {}),
			});
		}

		pos = strokeEnd;
	}

	return strokes;
}

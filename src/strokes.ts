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
export type StrokePen = 'needlePoint' | 'inkPen' | 'marker' | 'calligraphy' | 'unknown';

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
	/** The record's own `m_trailStatus` (`section_1`'s first `i32`, Ratta's
	 * own name for what https://github.com/Walnut356/snlib calls `unk_8`),
	 * present only when it is non-zero.
	 *
	 * **A non-zero value means the device no longer draws this record** --
	 * this is the per-stroke visibility answer, read straight out of the
	 * file rather than inferred from the page's raster. Confirmed against
	 * Supernote's own vector PDF exports, which draw exactly the records
	 * reading `0` and omit every marked one: `turkish-a6x-20230015-handwriting-erase.note` (152 of 189 ink
	 * records live, 152 paths exported), `erase-n6-20230015-horizontal-1270.note` (61 of 82
	 * live, 61 exported) and `link-n6-3.26.40-partial-erase-3p.note` page 3 (113
	 * of 143, 113 exported).
	 *
	 * The value says *how* the record stopped being drawn. Codes seen
	 * across the fixture corpus, each tied to a mechanism the fixture
	 * itself documents (see plans/vector-format-spec.md for the evidence
	 * per code):
	 *
	 * | Code | Meaning |
	 * |---|---|
	 * | `-2` | page cleared with no eraser or lasso record present (one instance; consistent with the binary's "CLEAN SCREEN" trail, unconfirmed) |
	 * | `-3` | moved away by a lasso drag -- the ink now lives in a separate record at the new position |
	 * | `-4` | **partially erased**: the surviving pieces follow as their own point-less, contour-only records (see `contour`) |
	 * | `-16` | deleted via lasso-select-and-delete |
	 * | `-99` | erased with the eraser tool, or otherwise removed whole |
	 *
	 * `-4` is the one code whose ink is still partly on the page, and the
	 * surviving part is not this record: the device rewrites each surviving
	 * fragment as a separate record with no `points` and its own `contour`,
	 * stored immediately after this one. Drawing this record *and* those
	 * would paint the erased part back in, so a renderer should skip every
	 * record carrying a status and draw the fragments instead. That is what
	 * the device itself does: its export of `link-n6-3.26.40-partial-erase-3p`
	 * page 2 draws each erased line as exactly its own fragments, matching
	 * their extents to the pixel, and never the line. */
	trailStatus?: number;
	/** True when this record is a filled rectangle -- a Heading or badge
	 * background -- rather than a pen path, so its two points are opposite
	 * corners of a box instead of the ends of a line. Read from the record's
	 * own `stroke_kind` (`"0001"`).
	 *
	 * Having exactly two points is *not* the test, which is what this field
	 * exists to correct: the ruler/straight-line tool also stores two points
	 * (`stroke_kind: "straightLine"`), and so does the occasional ordinary
	 * two-sample ink stroke (`"others"`). Across every fixture `stroke_kind`
	 * separates all three cleanly -- 10 rectangles, 8 straight lines and 2
	 * short ink strokes, with no overlap -- where counting points alone
	 * turned each of `line-n5-20260016-ruler-tool.note`'s lines into either a filled box
	 * or nothing at all. */
	isFilledRect?: boolean;
	/** True for the Stars feature's star mark, read from the record's own
	 * `stroke_kind` (`"fiveStarsSignal"`) -- see `STAR_MARK_STROKE_KIND`,
	 * which is also why such a stroke's `pen` is `'unknown'`. Ordinary ink
	 * as far as rendering goes; the flag exists so a caller can tell that
	 * this one's tool is genuinely unrecoverable rather than merely
	 * unrecognized. */
	isStarMark?: boolean;
	/** The device's own rendered outline of this stroke (`point_contour` in
	 * https://github.com/Walnut356/snlib) -- closed polygons, only present
	 * when `parseStrokes` was called with `includeContours: true`.
	 *
	 * Stored by the device as absolute pixels in the note's own *native*
	 * page space, so unlike `points` these are not re-derived from the
	 * `pageWidth`/`pageHeight` handed to `parseStrokes`: the two share a
	 * coordinate space only when those are the note's real dimensions.
	 * Scale them yourself if you decode against scaled dimensions (`toSvg`
	 * does, in `withUpscaledContour`).
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
	 * **A stroke's own outline is not a record of what survived erasing.**
	 * An erased stroke keeps its full-area outline here, byte for byte like
	 * a visible one -- what says it is gone is `trailStatus`, not this. The
	 * one place a contour *does* carry surviving geometry is the point-less
	 * records the device writes after a partially erased (`trailStatus`
	 * `-4`) stroke: each holds one surviving fragment as a contour and
	 * nothing else. See `ERASER_COLOR`'s doc comment and
	 * plans/vector-format-spec.md's erase-records section. */
	contour?: IStrokePoint[][];
}

/** Raw pen tool ids observed in `TOTALPATH`'s `pen` field -- reverse
 * engineered against `stroke-n5-20260016-isolation-tools-colors-widths.note` (which isolates one tool per
 * stroke) and cross-referenced against
 * https://github.com/Walnut356/snlib/blob/main/src/pen.rs, an independent
 * Rust implementation with a matching (if only partially enumerated) `Pen`
 * enum. `10`/`11` match that enum's `NeedlePoint`/`Marker` exactly; `16` is
 * this repo's own finding (unconfirmed against snlib, which doesn't list a
 * value for `InkPen`), consistently seen wherever a stroke's tool is known
 * to be the ink pen. Any other id maps to `'unknown'` rather than a guess.
 *
 * `15` is the calligraphy pen: `caligraphy-n5-20260016-widths-erase.note` (named for the tool)
 * carries 59 ink strokes and every one of them reads 15 -- its only other
 * records are eraser and lasso gestures -- as does `stroke-n5-20260016-isolation-tools-colors-widths.note`
 * page 2's calligraphy stroke. One id, not several.
 *
 * `5` is the marker again, under the id older firmware used for it -- see
 * `STAR_MARK_STROKE_KIND` for the one other thing that lands in this slot.
 * Ratta's own engine (`flutter_note_lib.dll`, see
 * plans/vector-format-spec.md Part 1.4) treats `5` and `11` as the same
 * tool in both places it distinguishes tools at all: the routine that
 * rewrites a stroke's color into its marker variant (`0 -> 1`, `48 -> 49`,
 * `80 -> 81`) runs for `penType == 5 || penType == 11` and nothing else,
 * and `getRecognDataPointerEventWithFile`, which feeds handwriting
 * recognition, skips `penType` `4`, `5` and `11` -- the lasso and both
 * marker ids. The fixtures agree: `test-a5x-20220011-old-pen-ids.note` is the only
 * `SN_FILE_VER_20220011` (A5X) file here, its ink pen is `1` rather than
 * `16`, and its three `pen=5` strokes carry color `81` -- the marker form
 * of `80` -- at thickness 1500, rendering in the page's own raster as wide
 * grey highlighter bands over the black handwriting. No fixture contains
 * both `5` and `11`, which is what an id superseded across a firmware
 * generation looks like -- the same pattern as `1` -> `16` for the ink pen. */
const PEN_IDS: Record<number, StrokePen> = {
	10: 'needlePoint',
	16: 'inkPen',
	11: 'marker',
	5: 'marker',
	15: 'calligraphy',
};

/** Grey `color` values that older firmware stored as *ids* rather than as
 * the grey level they render at, mapped to the levels current firmware
 * stores directly. Only `.note` files old enough to predate the change use
 * them -- here, only `test-a5x-20220011-old-pen-ids.note` (`SN_FILE_VER_20220011`, A5X).
 *
 * Without this a stroke's color is simply wrong: `48` is dark grey, not the
 * near-black `rgb(48,48,48)` reads as. Supernote's own vector export of
 * that fixture (`test-a5x-20220011-old-pen-ids.pdf`) settles which grey each id means, the same
 * ground truth the canonical 157/201 palette comes from. Its page 1 draws
 * exactly three ink colors, and each one's paths land on one of our
 * decoded color groups with nothing left over:
 *
 * | our `color` | device draws | extents agree to | our points inside it |
 * |---|---|---|---|
 * | `0` (34 strokes) | `0` | 0-2 px | 100% |
 * | `48` (21 strokes) | **157** | 0-2 px | 100% |
 * | `81` (3 strokes) | **201** | 14-16 px, i.e. the band's own half width | 100% |
 *
 * The `+1` marker forms (`49`, `81`) map to the `+1` forms of the same
 * greys, keeping that rule (see `PEN_IDS`) true in both encodings -- the
 * device's export draws a marker at the base grey either way, exactly as it
 * does for a modern marker storing 158/202. Only `48` and `81` occur in any
 * fixture; `49` and `80` are their unobserved counterparts, included
 * because leaving half of a pair out would decode one marker correctly and
 * its pen wrongly.
 *
 * Applied unconditionally rather than gated on the file version, which
 * `parseStrokes` never sees -- it is handed a `TOTALPATH` buffer, not the
 * header. Safe because these four values are not grey levels any firmware
 * stores: the real palette is 0/157/158/201/202/254, plus 255 for the
 * eraser. A color device could in principle put a literal 48 here, which is
 * the one thing that would need the version gate. */
const LEGACY_GREY_IDS: Record<number, number> = {
	48: 157,
	49: 158,
	80: 201,
	81: 202,
};

/** Reserved `color` value meaning "this isn't ink at all, it's an eraser
 * stroke" -- confirmed against https://github.com/Walnut356/snlib's `Color`
 * enum (`Eraser = 255`) and directly against real fixtures: the exact
 * strokes that used to decode as smooth-but-nonexistent phantom ink in
 * `erase-n6-20230015-horizontal-1270.note` (see issue #56) carry this color. By default,
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
 * fully visible. Confirmed directly against `erase-n6-20230015-horizontal-1270.note` and
 * `link-n6-3.26.40-partial-erase-3p.note` (whose "ERASER on MARKER"/"ERASER on PEN
 * LINES" fixture rows exist specifically to exercise this): each eraser
 * stroke's own record sits immediately after, and closely traces the
 * shape/bounds of, the ink it was dragged over. */
const ERASER_COLOR = 255;

/** Reserved `stroke_kind` value (see `STROKE_CONFIG.STROKE_KIND_OFFSET`)
 * meaning "this is a link-tag indicator box, not ink" -- confirmed directly
 * against `link-n6-3.26.40-partial-erase-3p.note` (named for exactly this
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

/** `stroke_kind` of a filled-rectangle record -- a Heading or badge
 * background, whose two points are opposite corners rather than a pen path
 * (see `IStroke.isFilledRect`). */
const FILLED_RECT_STROKE_KIND = '0001';

/** `stroke_kind` of the Stars feature's star mark (see
 * https://support.supernote.com/1759244-using-titles-keywords-and-stars).
 * Real, user-created content that renders like any other ink -- unlike
 * `LINK_TAG_STROKE_KIND`, it is not filtered out.
 *
 * It gets its own flag because the device overwrites the record's `pen`
 * field for it, so that field can't be trusted here: Ratta's own engine
 * (see `PEN_IDS`) walks every trail on save and, for each one whose
 * `predictName` -- this field -- equals `fiveStarsSignal`, stores `5` into
 * `penType` and `100` into `m_thickness`. Both stores are visible in
 * `flutter_note_lib.dll` at `0x180092f3c` and `0x1800bcc29`, and the one
 * star record in the fixtures
 * (`blank-a6x-3.15.27-shapes-rtr.note` page 1) reads exactly
 * `pen=5, thickness=100`. Whatever tool the user had selected is gone, so
 * `parseStrokes` reports `'unknown'` for a star rather than the `'marker'`
 * `5` would otherwise decode to -- the id is real, it just isn't this
 * record's tool. */
const STAR_MARK_STROKE_KIND = 'fiveStarsSignal';

/** `pen` id of a lasso/selection path. This used to be how such records were
 * identified; `RECORD_CLASS.LASSO` is now, because it states the record's
 * kind rather than inferring it from a pen id that firmware reuses across
 * tools (`pen === 1` is both the older ink pen and the Nomad-era eraser).
 *
 * It is still tested, for one specific record: `sticker-n5-20260016-plugin-artwork.note` page 1's last
 * record is not a stroke at all. Its `StrokeConfig` reads
 * `screenHeight: 120` on a 2560-tall page, `thickness: 0`, zero points, and
 * a `color` of 2012028940 -- the bytes are sticker data being read through
 * the wrong struct (see #68). It happens to land `4` in the `pen` slot, so
 * the old test dropped it by accident, while the record-class test keeps it
 * (its class slot reads a perfectly ordinary `5000`) and would emit
 * `rgb(2012028940,...)`, an invalid CSS color. Keeping both conditions costs
 * nothing and holds output identical until sticker records are understood
 * properly. */
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
	/** 52-byte C string -- Ratta's own name for it is `predictName` (see
	 * plans/vector-format-spec.md Part 1.4). Real ink always reads
	 * `"others"`; the special values this module checks for are
	 * `LINK_TAG_STROKE_KIND` (`"0000"`), `FILLED_RECT_STROKE_KIND`
	 * (`"0001"`, a 2-point rect record) and `STAR_MARK_STROKE_KIND`
	 * (`"fiveStarsSignal"`, still real user-drawn ink). */
	STROKE_KIND_OFFSET: 48,
	STROKE_KIND_SIZE: 52,
	/** In the same device units `parseStrokes`' `scale` divides through --
	 * this is the field the previous version of this module already relied
	 * on for the same purpose, under the name `nativeHeightBound`, before
	 * this byte layout was known (found back then via a
	 * `superNoteNote`-relative offset instead of `StrokeConfig`'s own).
	 *
	 * Cross-validated against Ratta's published EMR docs
	 * (https://docs.supernote.com/en/plugin-base/coordinate-system, issue
	 * #111): this is the page's EMR max range, and reads exactly the values
	 * the doc's page-size -> EMR table lists for every current Nomad/Manta
	 * fixture (~8.45 units/px). Older A5X firmware reads a larger, different
	 * range not in that table, so the per-stroke field stays authoritative.
	 * See plans/vector-format-spec.md "Cross-check against Supernote's
	 * published EMR docs". */
	SCREEN_HEIGHT_OFFSET: 128,
	DOC_KIND_OFFSET: 136,
	/** See `RECORD_CLASS`. Documented as a constant `5000` by
	 * https://github.com/Walnut356/snlib (as `unk_5`) -- it isn't. */
	RECORD_CLASS_OFFSET: 40,
	SIZE: 208,
} as const;

/** What kind of thing a stroke record *is*, read as an `i32` from
 * `STROKE_CONFIG.RECORD_CLASS_OFFSET`. snlib documents this field as a
 * constant `5000` (`unk_5`); it isn't. Every record in every `.note`
 * fixture (2,601 of them, across every device family and firmware here)
 * falls into exactly one of four groups:
 *
 * | Value | Records | What |
 * |---|---|---|
 * | `5000` | 2514 | real ink -- every pen, every color, including white |
 * | `0` | 22 | geometry derived from two points: a Heading background (`"0001"`), a link-tag box (`"0000"`), or a ruler line (`"straightLine"`) |
 * | `-1`, `-2`, `-4` | 46 | an eraser gesture (three tool modes/eras) |
 * | `-5` | 19 | a lasso selection path |
 *
 * The eraser/lasso split is exact: `-5` holds every `pen === 4` record and
 * nothing else, which is why it can replace that test. It is also the
 * durable form of it -- firmware reuses pen ids across tools (`pen === 1`
 * is both the older ink pen and the Nomad-era eraser), whereas this field
 * states the record's kind directly.
 *
 * **What this field does not do** is say whether an erase gesture actually
 * erased anything. That was the hope -- Supernote's own engine classifies
 * trails as `TRAIL_ERASE_AREA` / `ERASE_LINE_COLOR_VALUE` / `CLEAN SCREEN`
 * / `this is region selection trail` / `trail ERASER select:` as it
 * replays them, so some discriminator exists -- but it is not this one.
 * `erase-n5-20260016-all-mechanisms.note`, which exercises every erase mechanism, carries genuine
 * erasers at `-4`, while `link-n6-3.26.40-partial-erase-3p.note` page 3's `-4`
 * records sit on top of fully visible keyword text and erased nothing. Same
 * class, opposite outcome. So this identifies the *tool*, never the
 * *result*, and a geometric erase replay still cannot be driven from it. */
const RECORD_CLASS = {
	INK: 5000,
	/** A lasso/selection *path* -- the loop a user draws to select content
	 * (then delete it, move it, or turn it into a Keyword/Tag). Not ink, and
	 * never rendered by the device, so it is excluded unconditionally like
	 * `LINK_TAG_STROKE_KIND`: whatever the selection *did* is not recoverable
	 * from the record (see plans/vector-format-spec.md's erase-records
	 * section), but the loop itself is never visible content either way.
	 *
	 * Holds exactly the records that previously matched `pen === 4` -- all
	 * reading `color: 0`, `thickness: 200`, and frequently recorded as two
	 * byte-identical consecutive records. That those are never rendered was
	 * established against every fixture that has one: `erase-n5-20260016-all-mechanisms.note` (a
	 * lasso-select-then-delete; the loop is absent from both the device
	 * raster and `erase-n5-20260016-all-mechanisms.pdf`, Supernote's own export),
	 * `link-n6-3.26.40-partial-erase-3p.note` page 3 (keyword/tag-creation
	 * selections around fully-visible words -- rendering these drew phantom
	 * black circles around the text), and `color-n6-20230015-unknown-palette.note` (a path with
	 * ~0% presence in the page's own rendered ink).
	 *
	 * Holds every real lasso path, and `pen === 4` holds the same set plus
	 * exactly one record that isn't a lasso -- see `LASSO_PEN_ID`. */
	LASSO: -5,
} as const;

/** Sizes of the two fixed-layout sections that sit between `epa_grays` and
 * `point_contour` in a stroke record -- `Section1` and `Section2` in
 * https://github.com/Walnut356/snlib, whose declared field lists come out
 * to different totals than these. Solved directly instead: the only
 * `(Section1, Section2)` pair that makes *every* record on a page parse
 * byte-exactly, jointly across pages from two device families (N5/Manta
 * `erase-n5-20260016-no-white-pen.note`, and the older `erase-n6-20230015-horizontal-1270.note`). The
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
	/** See `RECORD_CLASS`. */
	recordClass: number;
	/** See `IStroke.trailStatus`. */
	trailStatus: number;
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
	const recordClass = view.getInt32(pos + STROKE_CONFIG.RECORD_CLASS_OFFSET, true);

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
		if (p + 4 > strokeEnd)
			return { pen, color, thickness, strokeKind, screenHeight, recordClass, points, trailStatus: 0 };
		p += 4 + view.getUint32(p, true) * elementSize;
	}

	// section_1 starts here: m_trailStatus, then m_copy -- the latter holds
	// the tool/operation ids catalogued in plans/vector-format-spec.md, which
	// nothing needs to decode, since m_trailStatus states per stroke what
	// each of those operations did to it.
	const trailStatus = p + 4 <= strokeEnd ? view.getInt32(p, true) : 0;
	const contour = includeContours ? readContour(view, byteLength, p, strokeEnd) : undefined;

	return { pen, color, thickness, strokeKind, screenHeight, recordClass, points, trailStatus, contour };
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
 * cause of `rtr-n5-20230015-recognition.note`'s circular phantom stroke from the pre-fix
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
 * `screenHeight` is the page's EMR (digitizer hardware) max range, not a
 * pixel count -- independently confirmed against Ratta's published EMR
 * docs (https://docs.supernote.com/en/plugin-base/coordinate-system,
 * issue #111); see plans/vector-format-spec.md's "Cross-check against
 * Supernote's published EMR docs".
 *
 * Strokes whose `color` is `255` are excluded by default, not returned as
 * `IStroke`s -- see `ERASER_COLOR`'s doc comment: they're real pen motions
 * (Supernote's eraser is a physical gesture like any other tool), just never
 * meant to render as ink *themselves*. This is what `erase-n6-20230015-horizontal-1270.note`'s
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
 * `link-n6-3.26.40-partial-erase-3p.note`'s own footer `LINK_*` metadata.
 *
 * Select gestures are excluded unconditionally too -- the loop drawn to
 * lasso-select content (for deletion, moving, or Keyword/Tag creation),
 * never rendered by the device. These are identified by the record-class
 * field rather than by pen id; see `RECORD_CLASS`, which is also what tells
 * a select apart from an erase when the two are otherwise identical.
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
	/** `at` is how many strokes had already been emitted when the loop was
	 * recorded, so everything before that index preceded it on the page. */
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
		// `RECORD_CLASS.LASSO` is the durable test -- it states the record's
		// kind, rather than inferring it from a pen id firmware reuses across
		// tools. The `pen` check is kept alongside it, and deliberately: see
		// `LASSO_PEN_ID`, which is no longer really "the lasso test" so much
		// as a guard against one record in `sticker-n5-20260016-plugin-artwork.note` whose StrokeConfig
		// isn't a StrokeConfig at all.
		const isLassoPath = raw?.recordClass === RECORD_CLASS.LASSO || raw?.pen === LASSO_PEN_ID;
		const isStarMark = raw?.strokeKind === STAR_MARK_STROKE_KIND;
		if (raw && !isLinkTag && !isLassoPath && (!isEraser || options.includeErasers)) {
			const scale = raw.screenHeight / pageHeight;
			// An older file stores some greys as ids -- see LEGACY_GREY_IDS.
			// Read after the isEraser test above, which keys on the reserved
			// 255 this never touches.
			const grey = LEGACY_GREY_IDS[raw.color] ?? raw.color;
			strokes.push({
				points: raw.points.map(([y, x]) => ({ x: -x / scale + pageWidth, y: y / scale })),
				color: `rgb(${grey},${grey},${grey})`,
				// A star mark's `pen` was overwritten by the device and names
				// no tool -- see `STAR_MARK_STROKE_KIND`.
				pen: isStarMark ? 'unknown' : (PEN_IDS[raw.pen] ?? 'unknown'),
				thickness: raw.thickness,
				...(isEraser ? { isEraser: true } : {}),
				...(raw.trailStatus !== 0 ? { trailStatus: raw.trailStatus } : {}),
				...(raw.strokeKind === FILLED_RECT_STROKE_KIND ? { isFilledRect: true } : {}),
				...(isStarMark ? { isStarMark: true } : {}),
				...(raw.contour ? { contour: raw.contour } : {}),
			});
		}

		pos = strokeEnd;
	}


	return strokes;
}

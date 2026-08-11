# Supernote `.note` vector ink format: what we know and don't

Reference doc, not an implementation plan. Covers the two undocumented binary
formats relevant to `vectorInk` (`src/svg.ts`, `src/strokes.ts`): `TOTALPATH`
(per-page pen stroke data, **fully decoded**) and `RECOGNFILE` (per-page
MyScript recognition-engine data, **mostly unknown** — the one thing we still
need from it, per-element color, remains unresolved). See issues
[#55](https://github.com/philips/supernote-typescript/issues/55),
[#56](https://github.com/philips/supernote-typescript/issues/56), and
[#60](https://github.com/philips/supernote-typescript/issues/60) for the
investigation history behind this.

## Part 1 — `TOTALPATH`: solved

### Outer structure

`page.TOTALPATH` is an address; `getContentAtAddress` (`src/parsing.ts`)
resolves it and strips one `u32` length prefix, so the buffer
`parseStrokes` receives (`totalPathBuffer`) starts directly with:

```
u32 strokeCount
for each of strokeCount strokes:
  u32 strokeLen              // byte length of everything below, this stroke only
  <strokeLen bytes>          // one stroke record, see below
```

This is fully deterministic — no scanning, no false positives. `strokeLen`
alone is enough to skip to the next stroke correctly even without
understanding every field inside it. Confirmed exact on every fixture tried:
the last stroke's declared end always lands exactly on the buffer's end.

Source: an independent Rust implementation,
[Walnut356/snlib](https://github.com/Walnut356/snlib/blob/main/src/note.rs),
documents this structure (its `Stroke::parse`). This repo's own original
investigation (issue #55) never found it — it only ever brute-force
byte-scanned for a self-checksumming record shape, because it never looked
more than a few dozen bytes around a stroke's own coordinate data.

### Stroke record layout

Each stroke record (the `strokeLen` bytes above) is:

```
StrokeConfig (208 bytes, fixed)   // pen, color, thickness, + ~20 more fields
disable_area_list                  // u32 count + count * 24 bytes (3 x ScreenCoord), almost always empty
points                             // u32 count + count * 8 bytes -- (y, x) uint32 pairs, in that order
pressures                          // u32 count + count * 2 bytes (u16), same length as points
tilts                              // u32 count + count * 4 bytes (i16 y, i16 x)
flag_draw                          // u32 count + count * 1 byte
epa_points                         // u32 count + count * 8 bytes (same shape as points)
epa_grays                          // u32 count + count * 4 bytes (i32)
section_1 (52 bytes, fixed)        // includes stroke_uid (monotonic per-note id)
control_nums                       // u32 count + count * 4 bytes (i32)
section_2 (10 bytes, fixed)
point_contour                      // u32 outer count, then that many (u32 count + count * 8 bytes f32 x,y) arrays
unk_17                             // u32 count + count * 16 bytes
section_3 (17 bytes, fixed)        // includes rotation_degrees
unk_22                             // u32 count + count * 4 bytes (i32)
section_4 (13 bytes, fixed)        // pixel_width/pixel_height == page dimensions
sized_str_1, sized_str_2, sized_str_3   // each u32 length + that many raw bytes
unk_25 (4 bytes, fixed)
mark_pen_d_fill_dir                // u32 count + count * 8 bytes (f32 x,y)
```

`src/strokes.ts` only decodes through `points` — everything after that is
skipped by jumping straight to `strokeStart + strokeLen`, not by parsing it.

### `StrokeConfig` (the 208-byte header)

Byte offsets, confirmed against real fixtures (`stroke-isolation.note`'s
tool/color/width-isolated pages, `headings-and-marker.note`,
`nomad-3.15.27-blank-shapes-and-RTR.note`):

| Offset | Field | Status |
|---|---|---|
| 0 | `pen` (u32) | **decoded** — see Pen table below |
| 4 | `color` (u32) | **decoded** — see Color table below |
| 8 | `thickness` (u32) | **decoded** — opaque device unit, see below |
| 12 | `rec_mod` | unconfirmed |
| 16 | `unk_1` | unconfirmed |
| 20 | `font_height` | unconfirmed (snlib: "default is 32") |
| 24 | `unk_2` | unconfirmed (snlib: "only ever seen `u32::MAX`") |
| 28 | `page_num` (u32) | unconfirmed but plausible — 1-indexed page number per snlib; not used by this repo |
| 32 | `unk_3` | unconfirmed |
| 36 | `unk_4` | unconfirmed |
| 40 | `unk_5` | unconfirmed (snlib: "only ever seen `5000`") |
| 44 | `stroke_layer` (u32) | unconfirmed (snlib: 0-indexed, ignoring background layer) |
| 48 | `stroke_kind` (52-byte C string) | partially confirmed — see below |
| 100 | `bounding_tl` (i32 y, i32 x) | unconfirmed |
| 108 | `bounding_mid` (i32 y, i32 x) | unconfirmed |
| 116 | `bounding_br` (i32 y, i32 x) | unconfirmed |
| 124 | `unk_6` | unconfirmed |
| 128 | `screen_height` (u32) | **decoded** — used directly for the coordinate `scale` (see below) |
| 132 | `screen_width` (u32) | present but unused by this repo |
| 136 | `doc_kind` (52-byte C string) | confirmed — see below |
| 188 | `emr_point_axis` (u32) | unconfirmed (snlib: "should always be 1") |
| 192 | `unk_7` (4 x u32) | unconfirmed |

`doc_kind` is `"superNoteNote"` for real ink strokes — this is the literal
string this repo used as its byte-scanning landmark before the real
structure was known. For 2-point rect records (see below) it instead reads
`"name is not set"`. `stroke_kind` reads `"0001"` for every rect record
checked (four different headings, all identical) — snlib describes this
field as normally holding `"others"` (freehand) or `"straightLine"` for real
ink strokes; this repo hasn't independently confirmed that string for a real
ink stroke, only the `"0001"` value for rects.

### Coordinate transform

Confirmed pixel-exact against rendered ink on multiple device families:

```
scale  = screenHeight / pageHeight      // screenHeight: this stroke's own StrokeConfig field
pixelX = -rawX / scale + pageWidth
pixelY =  rawY / scale
```

where `rawX`/`rawY` are read from each point's `(y, x)`-ordered pair as
`rawY = point[0]`, `rawX = point[1]` (i.e. the field literally called `y` in
`ScreenCoord` maps to this repo's `rawY`, and `x` to `rawX` — the naming just
reflects which axis needs negating).

### `pen` field — confirmed values

| Value | Meaning | Source |
|---|---|---|
| 10 | Needle-point pen | matches snlib's `Pen::NeedlePoint` exactly |
| 11 | Marker | matches snlib's `Pen::Marker` exactly |
| 16 | Ink pen | this repo's own finding; snlib's `Pen` enum doesn't list a value for ink pen (its enum is `#[non_exhaustive]`) |
| 0 | (seen on 2-point rect records only) | not a real tool; rects use this consistently, see below |
| anything else | unknown, not guessed at | `parseStrokes` maps to `'unknown'` |

Calligraphy pen's real id was never isolated to a confirmed single value —
`stroke-isolation.note` page 2's calligraphy stroke read as `'unknown'`
under this mapping.

### `color` field — confirmed values

Cross-referenced exactly against
[snlib's `Color` enum](https://github.com/Walnut356/snlib/blob/main/src/pen.rs):

| Value | Meaning | Measured |
|---|---|---|
| 0 | Black | exact match, every fixture |
| 1 | MarkerBlack (black drawn with the marker tool specifically) | exact match |
| 158 | DarkGrey | measured 157–158 depending on fixture (both confirmed real, see note below) |
| 202 | LightGrey | measured 201–202 |
| 254 | White | exact match |
| 255 | Eraser (reserved — not real ink) | see below |

The 157 vs. 158 (and 201 vs. 202) variance is real, not measurement noise —
`stroke-isolation.note` page 3 (needle pen, one stroke per color) measured
157/201; `headings-and-marker.note` page 3 (marker highlights) measured
158/202, matching the enum exactly. Two adjacent, deliberately close shades
selected by whoever authored each fixture, not a decode error — confirmed by
checking both fixtures independently land on internally consistent, exact,
repeatable values.

`color === 255` (`Eraser`) is filtered out of `parseStrokes`' return value
entirely, not surfaced as an `IStroke`. This is the real explanation for
issue #56's original "phantom stroke" report: TOTALPATH records the eraser
tool's own physical motion just like any other pen tool, distinguishable
only by this one reserved value — not a decode bug, and not something that
ever needed raster cross-checking to detect.

### `thickness` field — confirmed to exist, not confirmed as a physical unit

Real, per-stroke, and ordered consistently with the on-device width slider
(confirmed monotonic across `stroke-isolation.note` page 4's four
needle-pen strokes at declared widths 1.0/0.6/0.3/0.1). **Not** in the same
unit space as point coordinates — dividing by the same `scale` used for
coordinates produces implausibly wide lines. This repo uses an empirically
calibrated constant, `THICKNESS_TO_PIXEL_SCALE = 150` (`src/svg.ts`), tuned
so ordinary pens land at 3–6px and a marker lands at ~25px, matching this
project's own earlier raster-measured widths for the same strokes. No
confirmed physical unit (e.g. "10 micrometers", the documented unit for
point coordinates) has been established for `thickness`.

### 2-point records — a distinct sub-type, not a style choice

A stroke record whose `points` array has exactly 2 entries is a filled
rectangle's opposite corners (badges, highlight boxes, and the "Heading"
feature's background — see
[Supernote's own docs](https://support.supernote.com/1759244-using-titles-keywords-and-stars)).
Confirmed real (not noise) by checking what fraction of the rectangle's own
bounding box is already real ink in the page's raster: genuine ones measure
~97–99% filled (solid) or ~25% (a deliberate cross-hatch pattern); unrelated
noise measures ~0%.

**Critically: a rect record's own `pen`/`color`/`thickness` fields are not
meaningful.** Confirmed by comparing four headings with four different
visible background colors (black/dark grey/light grey/hatch) on the same
page — every one of them reads the identical, uninformative
`pen: 0, color: 0, thickness: 1500`, regardless of the real, visibly
different background color. `src/svg.ts` still raster-samples a rect's fill
color/pattern from the page's own rendered ink for this reason (`sampleRect`
in `deriveStrokeStyle`) — this is the one place `vectorInk` still depends on
raster data at all, besides the label-text contrast override below.

### Exhaustively confirmed: rect color is not anywhere in the stroke record

Every single field in the entire ~700-byte stroke record structure above —
not just `pen`/`color`/`thickness` — was decoded and compared across all
four differently-colored headings on `headings-and-marker.note` page 2.
Nothing varies with color:

- `stroke_kind`/`doc_kind`: identical (`"0001"` / `"name is not set"`) across all four.
- `epa_points`/`epa_grays`: empty for every rect, despite the promising name.
- `section_1`–`4`, `control_nums`, `unk_17`, `unk_22`: sequential IDs, page
  constants, or empty — nothing color-related.
- `sized_str_1` decodes (it's base64-encoded, comma-joined tokens) to the
  same structural pattern for all four:
  `0, 0, <a number that doesn't correlate with area or color>, none, <x,y,w,h>, <x,y,w,h>, none, none, none, 0, 0.000000, none, none, none, 0, 1, 1, 0, none`.
- No separate outline/border stroke exists either — a page's real stroke
  list accounts for exactly (N real ink strokes) + (1 two-point record per
  visible rect), nothing left over. The rendered rect itself has no visible
  border in the raster (flat, sharp-edged fill).

This isn't "we didn't look hard enough" — it's a confirmed, exhaustive
negative result. Rect fill color is not recoverable from `TOTALPATH` at all,
for any field, at any offset.

### The heading-text auto-contrast case

Supernote auto-recolors a Heading's label text for contrast against its own
background (confirmed against the raster: black-pen text drawn over a black
or dark-grey heading background displays as white in the final render, not
its real black ink color). This is a display-time effect, not something
`TOTALPATH` records — the text's own `IStroke.color` is genuinely black
(the real pen color used), which is correct everywhere except this one
feature's on-screen result. `src/svg.ts`'s `applyHeadingContrastOverrides`
handles this as a narrow, targeted exception: a path stroke whose points
mostly fall inside a rect's bounds gets its *displayed* color resampled from
the raster, on top of (not instead of) the real per-stroke decode used
everywhere else.

## Part 2 — `RECOGNFILE`: mostly unknown

`page.RECOGNFILE` is an address, resolved the same way as `TOTALPATH`
(`getContentAtAddress`). It's `"0"`/absent on pages with no recognition data
(e.g. `horizontal_1270.note`); present on pages that had RTR or post-hoc
recognition run (e.g. `rtr.note`, `headings-and-marker.note`). Where
present, it's a real ZIP archive — MyScript's "iink" handwriting-recognition
engine's own working files for that page:

```
meta.json                    # boilerplate: format-version, OS, iink Application_Version, etc. -- no style data
rel.json                     # tiny: { pages: {...}, objects: { "rectangle/1": {...} } } -- see below
index.bdom                   # tiny (~233 bytes observed), a document-level skeleton -- see below
pages/<id>/meta.json         # per-page boilerplate (creationDate, iink renderer settings)
pages/<id>/page.bdom         # MyScript's structured document model for the page -- see below
pages/<id>/ink.bink          # never explored (see Open questions)
pages/<id>/style.css         # real, human-readable CSS -- see below
```

### `style.css` — real color data exists, but not for Headings

Plain, real CSS. Two things found in it that looked directly relevant to
Headings and turned out not to be:

- **`.headingBox`** (appears twice) — a fixed, generic style
  (`color:#CED1D4ff; -myscript-pen-fill-color:#F5F6F77f; -myscript-pen-fill-style:solid;`).
  Same values regardless of fixture/heading count — this is very likely a
  *table* header-row style (from the math/table diagram feature), not our
  note-taking "Heading" feature at all.
- **`.black-color-decoration`, `.drak-grey-color-decoration`** (sic — real
  typo in Supernote's own file), **`.light-grey-color-decoration`,
  `.white-color-decoration`**, plus ~15 more named colors (blue, red, green,
  yellow, purple, indigo, turquoise, lime, amber, taupe, ...). Every single
  one shares the *identical* background color
  (`-myscript-text-decoration-background-color:#FFED2666`, a translucent
  yellow) — only the `-myscript-text-decoration-color` (text color) field
  varies. That shape — one constant highlight color, varying text color —
  matches Supernote's separate **Keywords** feature (from the same
  [support article](https://support.supernote.com/1759244-using-titles-keywords-and-stars)
  as Headings), not Headings. The actual values don't match our real
  measured heading colors either: this CSS's "dark grey" is `#808080`
  (128,128,128) and "light grey" is `#D9D9D9` (217,217,217), while the real
  heading backgrounds measure ~157–158 and ~201–202 (see the `TOTALPATH`
  Color table above) — a different, similar-but-distinct palette.

No class name from `style.css` is ever referenced by literal string
anywhere in `page.bdom` (checked exhaustively) — whatever selects a class
per element is a numeric/indexed reference, not a string lookup.

### `page.bdom` — partially understood structure, unsolved reference encoding

No public spec exists (MyScript documents `ContentPackage`/JIIX, not this
internal schema — confirmed via web search). What's confirmed:

**Outer structure**: `"BDOM"` magic (4 bytes) + 2 header bytes, then a flat,
sequential, length-prefixed string table:

```
"BDOM"
u16                    // 2 header bytes, meaning unknown
repeat:
  u32 len              // 0 is a VALID entry (a null/empty slot), not end-of-table
  len bytes UTF8        // one table entry, if len > 0
until the first entry that isn't a valid printable string
<data section starts here>
```

The zero-length-entry behavior is a real gotcha: treating `len === 0` as
"table ended" (rather than "skip this 4-byte null entry and continue")
silently under-counts every later index, and produced a confirmed-wrong
finding early in this investigation (a phantom field that looked like
`"p2Decoration"` in a naive byte dump, actually two unrelated adjacent
entries — `"p2"` and a later, different `"...Decoration"`-suffixed entry —
made to look concatenated by the mis-parse). A corrected walker is
validated end-to-end: 207 entries for one real fixture, ending exactly at
`"shapeRecognized"`, matching the boundary found independently by eye.

```ts
function walkStringTable(bdomBuf: Uint8Array) {
  const view = new DataView(bdomBuf.buffer, bdomBuf.byteOffset, bdomBuf.byteLength);
  const entries: { index: number; offset: number; str: string | null }[] = [];
  let off = 6, index = 0;
  while (off + 4 <= bdomBuf.length) {
    const len = view.getUint32(off, true);
    if (len === 0) { entries.push({ index, offset: off, str: null }); off += 4; index++; continue; }
    if (len > 300 || off + 4 + len > bdomBuf.length) break;
    const strBytes = bdomBuf.subarray(off + 4, off + 4 + len);
    if (![...strBytes].every((b) => b >= 0x20 && b < 0x7f)) break;
    entries.push({ index, offset: off, str: Buffer.from(strBytes).toString('utf8') });
    off += 4 + len;
    index++;
  }
  return { entries, dataStart: off };
}
```

**Data section**: mostly a character-level text-recognition lattice, not
element styling. Values here are literal inline length-prefixed strings
(same encoding as the table), not table-index references. Decoded a real
sequence into the heading word it labels:

```
"[0:0,1:166$]" conf=0.792 char="B"
"[2:0,2:51$]"  conf=0.239 char="l"
"[3:0,4:35$]"  conf=0.533 char="a"
"[5:0,5:58$]"  conf=0.494 char="c"
"[6:0,7:64$]"  conf=0.506 char="k"
```
→ spells **"Black"**. Bracketed values look like
`[fromNode:fromOffset,toNode:toOffset$]` edges in a recognition candidate
lattice. Observed tag bytes immediately preceding a literal string: `0x01`
(debug/log-looking strings, GUIDs, language codes) and `0x02` (lattice
spans, confidence scores, character candidates, other literal content
values). `0xff` and `0x00` appear structurally too, not yet characterized.

**Unsolved**: how a table-index *reference* (as opposed to a literal string
*value*) is encoded. Tried treating a bare matching byte value in the data
section as "this is index N" — collides constantly with ordinary ASCII text
content for common small indices (false positives), and doesn't appear at
all as a raw byte for others (e.g. index 161 for `lastDecoration`, tested
directly, zero hits). This is the actual blocker to resolving per-element
style/decoration from `page.bdom` — not a matter of not having looked, but
of not yet having the right grammar for this one construct.

**Confirmed dead ends** (don't re-chase without new evidence):
- `"p2Decoration"` — doesn't exist as a real field; see the zero-length-entry gotcha above.
- `x-Color` — appears once per page, identical position, always resolves to
  `RGBA(255,255,255,255)` regardless of page content — generic
  editing-cursor/focus-state boilerplate, not per-element color.
- `"rectangle/1"` (also the one entry in `rel.json`'s `objects`) — appears
  exactly once per `RECOGNFILE`/`page.bdom`, regardless of how many rects
  are actually on the page (confirmed against a page with 4 differently
  colored headings, still only one `rectangle/1`). Most likely a
  generic root/page-level object, not one-per-styled-element.

### `index.bdom` — explored, holds nothing useful

Tiny (233 bytes for the fixture checked). Its entire string table:
`page, document, id, objects, http://www.myscript.com/ns/myscript/document,
title, pages`. No heading list, no per-heading style, no sidebar/navigation
index of any kind. If Supernote's Titles/Keywords/Stars sidebar (the
feature Headings feeds into) is built from exported data at all, it isn't
from a precomputed index file here — it would have to be reconstructed by
scanning page content at render time.

### `ink.bink` — never explored

Present in every `RECOGNFILE` zip alongside `page.bdom`, never opened or
examined this investigation. Unknown format, unknown content. Worth
checking before investing further in `page.bdom`'s reference-encoding
puzzle — it might be a more direct source (raw ink replay data for the
recognition engine) than `page.bdom`'s indirect, partially-encoded
structure.

## Open questions, in rough priority order

1. **`page.bdom`'s reference-encoding grammar** — the actual blocker to
   recovering real Heading/decoration color. Needs a proper tag-byte
   tokenizer for the data section, built the same way `TOTALPATH` was
   cracked (byte-by-byte, differential, controlled fixtures) — not more
   targeted byte-value guessing. See issue #60 for a scoped plan.
2. **`ink.bink`** — completely unopened. Check this before sinking more
   time into `page.bdom` specifically.
3. **Whether Heading colors are exported at all.** It's possible the
   client app hard-codes its 4-color heading palette and only exports an
   index (0–3) that has no meaning outside the app itself — in which case
   no amount of file inspection recovers the real RGB value, only which of
   4 known slots was used (which the raster sampling this repo already does
   effectively achieves anyway).
4. **Unconfirmed `StrokeConfig` fields** — `rec_mod`, `unk_1`–`unk_7`,
   `stroke_layer`, `bounding_tl/mid/br`, `emr_point_axis`. None block
   current functionality; `stroke_layer` in particular might matter for
   correctly handling multi-layer notes (`MAINLAYER` vs `LAYER1`–`3`) if
   that ever becomes a requirement — `vectorInk` currently treats all ink
   layers uniformly.
5. **Confirm `stroke_kind`'s normal values for real ink strokes**
   (`"others"`/`"straightLine"` per snlib) directly against a fixture —
   this repo has only confirmed `"0001"` for rect records so far.

## References

- [github.com/Walnut356/snlib](https://github.com/Walnut356/snlib) — independent Rust `.note` parser; source of the `TOTALPATH` structure this repo now uses (`src/note.rs`, `src/pen.rs`).
- [github.com/jya-dev/supernote-tool](https://github.com/jya-dev/supernote-tool) — Python `.note`/`.mark` parser; its `SvgConverter` doesn't read `TOTALPATH` at all (rasterizes, then traces each of a fixed 4-color palette with `potrace`) but corroborates the same canonical palette.
- Issue [#55](https://github.com/philips/supernote-typescript/issues/55) — original `TOTALPATH` geometry investigation.
- Issue [#56](https://github.com/philips/supernote-typescript/issues/56) — coverage/phantom-stroke follow-up, now resolved by this format's discovery.
- Issue [#60](https://github.com/philips/supernote-typescript/issues/60) — scoped plan for the remaining `page.bdom` work.
- `tests/input/README.md` — what each relevant fixture isolates (`stroke-isolation.note`, `headings-and-marker.note` + `.pdf`).

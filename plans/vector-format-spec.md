# Supernote `.note` vector ink format: what we know and don't

Reference doc, not an implementation plan. Covers the undocumented binary
formats relevant to `vectorInk` (`src/svg.ts`, `src/strokes.ts`): `TOTALPATH`
(per-page pen stroke data, **fully decoded**), the `.note` footer's
`TITLE_`/`KEYWORD_` metadata blocks (**decoded** — this, not `RECOGNFILE`,
turned out to be where per-heading color lives), and `RECOGNFILE` (per-page
MyScript recognition-engine data — `ink.bink` now decoded, `page.bdom`
partially). See issues
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
section_1 (52 bytes, fixed)        // fully decoded, see Part 1.4: m_trailStatus,
                                   //   m_copy, m_trailNumInPage (the stroke uid),
                                   //   m_before/afterShiftAngle, m_before/afterShiftRect
control_nums                       // u32 count + count * 4 bytes (i32)
section_2 (10 bytes, fixed)        // m_groupNum, m_groupNest, m_groupEnd, m_renderFlag
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

Byte offsets, confirmed against real fixtures (`stroke-n5-20260016-isolation-tools-colors-widths.note`'s
tool/color/width-isolated pages, `heading-n5-20260016-backgrounds-marker.note`,
`blank-a6x-3.15.27-shapes-rtr.note`):

| Offset | Field | Status |
|---|---|---|
| 0 | `pen` (u32) | **decoded** — see Pen table below |
| 4 | `color` (u32) | **decoded** — see Color table below |
| 8 | `thickness` (u32) | **decoded** — `thickness / 100` = stroke width in page pixels, see below |
| 12 | `rec_mod` | reads `10` on every stroke in every fixture checked; meaning unknown |
| 16 | `unk_1` | reads `0` everywhere |
| 20 | `font_height` | **confirmed** — reads `32` everywhere (snlib: "default is 32") |
| 24 | `unk_2` | **confirmed** always `u32::MAX`, every stroke, every fixture (matches snlib) |
| 28 | `page_num` (u32) | **confirmed** — 1-indexed page number, matches the containing page exactly in every fixture |
| 32 | `unk_3` | reads `0` everywhere |
| 36 | `unk_4` | reads `0` everywhere |
| 40 | `record_class` (i32) | **decoded** — not the constant `5000` snlib documents. It states what the record *is*: `5000` ink, `0` two-point-derived geometry, `-1`/`-2`/`-4` eraser gesture, `-5` lasso path. See below. |
| 44 | `stroke_layer` (u32) | **confirmed** — `test-a5x-20220011-old-pen-ids.note` has real `LAYER1` content; its strokes read `1` here, `MAINLAYER` strokes read `0` (0-indexed ignoring background, exactly as snlib says) |
| 48 | `stroke_kind` (52-byte C string) | **confirmed** — see below; Ratta's own name is `predictName` (Part 1.4) |
| 100 | `bounding_tl` (i32 x, i32 y) | **decoded** — see below; Ratta's name `upLeftPoint` |
| 108 | `bounding_mid` (i32 x, i32 y) | **decoded** — exactly `(tl + br) / 2`; Ratta's name `keyPoint` |
| 116 | `bounding_br` (i32 x, i32 y) | **decoded** — see below; Ratta's name `downRightPoint` |
| 124 | `unk_6` | reads `26` everywhere |
| 128 | `screen_height` (u32) | **decoded** — used directly for the coordinate `scale` (see below); Ratta's name `maxY` (the canvas-coordinate maximum, not a pixel count) |
| 132 | `screen_width` (u32) | present but unused by this repo; Ratta's name `maxX` |
| 136 | `doc_kind` (52-byte C string) | confirmed — see below |
| 188 | `emr_point_axis` (u32) | reads `1` everywhere (snlib: "should always be 1"); the binary logs it as `m_emrPointAxis` and errors on `!= 1` |
| 192 | `unk_7` (4 x u32) | **named** — `m_mupdfChapter`, `m_mupdfPosition`, `m_mupdfOffsetX`, `m_mupdfOffsetY` (Part 1.4). Zero in `.note` files; these anchor a stroke to a location in a PDF, i.e. they are for `.mark` annotation files. |

`bounding_tl`/`bounding_br` are the stroke's bounding box **in page-pixel
coordinates** — the same space the coordinate transform below produces —
as (x, y) pairs, x mirrored just like point x. Verified numerically across
all fixtures: transform every point, take the extents, inflate by half the
rendered stroke width (`thickness / 100 / 2`, see below) — the declared box
matches within a couple of pixels on 500+ strokes across three device
families (max error grows with pen width; a 3800-thickness marker's box is
inflated by ~19–21px per side ≈ half its 38px rendered width, which is
itself part of the evidence for the thickness decode). `bounding_mid` is
exactly the box's center. Note the field order is (x, y), not the (y, x)
order snlib's `ScreenCoord` naming suggests.

`doc_kind` is `"superNoteNote"` for real ink strokes — this is the literal
string this repo used as its byte-scanning landmark before the real
structure was known. For 2-point rect records (see below) it instead reads
`"name is not set"` on Manta firmware and `""` (empty) on Nomad 3.15.27 —
firmware-dependent, don't key on it.

`stroke_kind` is now confirmed directly against fixtures:

| Value | Meaning |
|---|---|
| `"others"` | every freehand ink stroke, all pens, all fixtures (600+ strokes) — matches snlib |
| `"0001"` | every 2-point rect record |
| `"0000"` | a 5-point closed-rectangle record for the "link tag" feature's own indicator box (`pen=0`, like `"0001"`) — never real ink, confirmed against `link-n6-3.26.40-partial-erase-3p.note`: every one of its `"0000"` records' bounding box matches one of the note's own footer `LINK_*` entries' `LINKRECT` pixel-exact, and none of them appear in the page's own rendered ink. `src/strokes.ts`'s `parseStrokes` excludes these unconditionally now (they used to render as a phantom stroked-outline box in `vectorInk` output, since nothing distinguished them from ordinary ink before this field was decoded). |
| `"straightLine"` | the ruler/straight-line tool — also **exactly two points**, being the line's endpoints (`line-n5-20260016-ruler-tool.note`; those records read `pen=10, thickness=400`, i.e. an ordinary needle pen, and `doc_kind: "name is not set"` like a rect) |
| `"fiveStarsSignal"` | the Stars feature's star mark (`blank-a6x-3.15.27-shapes-rtr.note`, drawn with the circled-star gesture; that stroke also reads `pen=5, thickness=100`). Those two values are **written by the engine, not by the tool**: on save it walks every trail and stores `penType = 5`, `m_thickness = 100` into any record whose `predictName` is this string (Part 1.4). The record's real tool is therefore unrecoverable, which is why `parseStrokes` reports `pen: 'unknown'` plus `isStarMark: true` for it rather than the `'marker'` that `pen=5` otherwise means. |

**`stroke_kind` is the only sound way to tell a filled rectangle from a
two-point *line*.** Three unrelated things store exactly two points, and
counting points cannot separate them:

| `stroke_kind` | two points mean | count in fixtures |
|---|---|---|
| `"0001"` | opposite corners of a filled box | 10 |
| `"straightLine"` | the two ends of a line | 8 |
| `"others"` | an ordinary ink stroke that happens to be a dot/tap | 2 |

They never overlap. Before `line-n5-20260016-ruler-tool.note` existed, `src/svg.ts`
treated any two-point record as a rectangle and used a raster fill-fraction
test to reject the ones that "weren't real" — which turned each of that
fixture's ruler lines into either a degenerate invisible box or nothing at
all (page 1's six lines rendered as three invisible rects and zero lines).
`IStroke.isFilledRect` now carries the record's own answer.

The same correction retires an old misreading: `test-a5x-20220011-old-pen-ids.note`'s two-point
`"others"` record was assumed to be non-ink noise sitting "over blank
raster". The page's own render has ink at exactly that pixel and no other
stroke passes within 12px of it, so it is a real pen tap — it was only ever
invisible because the rect path drew it as a 0.13px box.

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
| 1 | Ink pen (older firmware) | snlib's `Pen::InkPen = 1`; every ordinary stroke in the Nomad 3.15.27 fixtures and `test-a5x-20220011-old-pen-ids.note` reads 1 |
| 3 | Eraser — `TRAIL_ERASE_AREA` | the engine's trail dispatcher branches on `penType == 3` and forces `penColor = 255`, `preNum = -2` (Part 1.4); all 12 records in the fixtures read `color=255, record_class=-2`, no exceptions |
| 4 | Region selection (lasso) | dispatcher branch → `preNum = -5`; see the record-class section |
| 5 | **Marker (older firmware)** — also stamped onto the `fiveStarsSignal` star mark | see below |
| 9 | Eraser — `ERASER select` | dispatcher branch → `preNum = -4`; all 12 records read `color=255, record_class=-4` |
| 10 | Needle-point pen | matches snlib's `Pen::NeedlePoint` exactly |
| 11 | Marker | matches snlib's `Pen::Marker` exactly |
| 15 | Calligraphy pen — **one id, not several** | `stroke-n5-20260016-isolation-tools-colors-widths.note` page 2's calligraphy stroke (declared width 0.7 → `thickness=900`) reads 15, and so does every one of `caligraphy-n5-20260016-widths-erase.note`'s 59 strokes — the fixture named for the tool and drawn entirely with it |
| 16 | Ink pen (newer firmware) | this repo's own finding on Manta fixtures; same tool as 1, different id by device/firmware generation |
| 0 | (seen on 2-point rect records only) | not a real tool; rects use this consistently, see below |
| −3 | reserved, never rendered | the engine's render filters skip it alongside 3 and 4; not seen in any fixture |
| anything else | unknown, not guessed at | `parseStrokes` maps to `'unknown'` |

#### `pen=5` — the marker's older id

Resolved from Ratta's own engine plus the fixtures; it was the last
unidentified id in real ink. Two separate things land in this slot.

**It is the marker.** `flutter_note_lib.dll` distinguishes tools in exactly
two places, and both group `5` with `11`:

- the routine at `0x180049940` rewrites a stroke's color into its marker
  variant (`0 → 1`, `0x30 → 0x31`, `0x50 → 0x51`) for
  `penType == 5 || penType == 11`, and for nothing else;
- `getRecognDataPointerEventWithFile`, which builds the handwriting-
  recognition input, skips `penType` `4`, `5` and `11` — the lasso and both
  marker ids. Highlighter passes are not handwriting.

The fixtures agree, and say *which* marker id belongs to which era.
`test-a5x-20220011-old-pen-ids.note` is the only `SN_FILE_VER_20220011` (A5X) file here; its ink pen
is `1`, not `16`; and its three `pen=5` strokes carry `color=81` — the
marker form of `80` — at `thickness=1500`, which the page's own raster
renders as wide grey highlighter bands over the black handwriting. No
fixture contains both `5` and `11`. That is an id superseded across a
firmware generation, the same pattern as `1 → 16` for the ink pen:

| era | ink pen | marker |
|---|---|---|
| A5X, `SN_FILE_VER_20220011` | 1 | **5** |
| current | 16 | 11 |

**And the star mark borrows it.** On save the engine stores `penType = 5`
over whatever tool drew a `fiveStarsSignal` record (Part 1.4). Such a record
is not marker ink, and its real tool is gone — see the `stroke_kind` table.

One caveat on scope, since this route was expected to yield the enum by
name: it does not. `logTrails` prints `penType` as a bare integer, and the
binary contains no pen-name strings at all (the `fountain_pen` /
`calligraphic_brush` strings in the payload belong to MyScript, not Ratta).
Ids `10`, `15` and `16` never appear as constants anywhere in the DLL — the
engine only ever special-cases `0`, `1`, `3`, `4`, `5`, `9`, `11` and `−3`.
So this is still a behavioural identification, just made against Ratta's
implementation rather than against fixtures alone.

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
`stroke-n5-20260016-isolation-tools-colors-widths.note` page 3 (needle pen, one stroke per color) measured
157/201; `heading-n5-20260016-backgrounds-marker.note` page 3 (marker highlights) measured
158/202, matching the enum exactly. Two adjacent, deliberately close shades,
not a decode error.

**The `+1` is the marker, and it is a rule, not a quirk of some fixtures.**
The engine has a routine for it (`0x180049940`, Part 1.4): when a stroke's
`penType` is a marker id — `5` or `11`, and no other value — its color is
rewritten `0 → 1`, `0x30 → 0x31`, `0x50 → 0x51`. A second remap at
`0x180049990` carries the older ids the same way, `0x63 → 0x9d` and
`0x64 → 0xc9` for a pen against `0x67 → 0x9e` and `0x68 → 0xca` for a
marker — i.e. the 157/158 and 201/202 pairs, from the source ids up.

The fixtures match it exactly, with no exceptions in either direction:
across all 2,948 records, a marker (`pen` 5 or 11) never once writes
0/48/80/157/201, and a needle/calligraphy/ink pen (10/15/16) never once
writes 1/49/81/158/202. `tests/strokes.test.ts` sweeps every fixture for
this. So the base value is the color and `+1` says a marker drew it; snlib
naming only `1` as `MarkerBlack` while calling 158/202 plain
`DarkGrey`/`LightGrey` is an incomplete reading of the same pattern.

**157/201 is the canonical design palette.** Supernote's own PDF export
(`heading-n5-20260016-backgrounds-marker.pdf`) draws its vector fills at exactly
`0.6156863 rg` = 157/255 and `0.7882353 rg` = 201/255, and the
`TITLESTYLE` metadata (see the Titles section below) encodes the same
157/201 as literal decimal digits — the base, non-marker forms.

**48 and 80 are not colors "beyond greyscale" — they are the older
firmware's grey *ids*.** On that encoding the field names a palette entry;
on the current one it is the rendered grey itself (0/157/201/254 render as
exactly that). `test-a5x-20220011-old-pen-ids.note` (`SN_FILE_VER_20220011`, A5X) is the only
fixture old enough to use it, and Supernote's own vector export of that
page — `test-a5x-20220011-old-pen-ids.pdf` — says which grey each id means:

| stored `color` | strokes | device draws | extents agree to | our points inside it |
|---|---|---|---|---|
| `0` | 34 | `0` | 0–2 px | 100% |
| `48` | 21 | **157** (dark grey) | 0–2 px | 100% |
| `81` | 3 | **201** (light grey) | 14–16 px, the band's own half width | 100% |

Each of the page's three ink colors maps onto one device color group with
nothing left over, and the residual offsets are exactly each stroke's
rendered half width (`thickness / 100`) — the standoff between a
centerline and the outline drawn around it. The pairing also holds up
against the marker rule: `81` is `80 + 1`, it appears only on `pen=5`
records, and `48` appears only on pen records.

`parseStrokes` maps these to the modern palette (`LEGACY_GREY_IDS`), taking
the `+1` forms to the `+1` forms — `48 → 157`, `49 → 158`, `80 → 201`,
`81 → 202` — which keeps "`+1` means a marker" true in both encodings. The
device's export draws a marker at the base grey either way, exactly as it
does for a modern marker storing 158/202. This is also what the engine does
for other legacy ids: `0x180049990` maps `0x63 → 0x9d` and `0x64 → 0xc9`
with their marker forms `0x67 → 0x9e` and `0x68 → 0xca`. Nothing in the
binary maps `0x30`/`0x50`, so the export is the evidence for these two.

The raster is a third encoding again and is not what we decode to: the A5X
screen drew these as greys 128 and 169, where the export and the design
palette both say 157 and 201.

**Reading the ids literally cost that fixture most of its vector ink**,
which is worth recording since the symptom looks like a pen problem and
isn't. `toSvg`'s ink-presence check (`strokeInkPresence`) looks under each
stroke for raster ink matching its declared grey; hunting for 81 where the
raster holds 169 finds nothing, and the stroke is dropped as invisible. 16
of page 1's 58 strokes went that way, the whole highlighter pass included.
Mapping to the real greys brings the declared value within the check's
tolerance of the raster (`|157 − 128|` and `|202 − 169|` against a
tolerance of 48) and all 58 now draw.

`color === 255` (`Eraser`) is filtered out of `parseStrokes`' return value by
default, not surfaced as an `IStroke`. This is the real explanation for issue
#56's original "phantom stroke" report: TOTALPATH records the eraser tool's
own physical motion just like any other pen tool, distinguishable only by
this one reserved value — not a decode bug, and not something that ever
needed raster cross-checking to detect.

**A *partial* (drag) erase's own visual effect is now reproduced, not just
its phantom-stroke symptom silently fixed.** Excluding eraser strokes
correctly stops them rendering as their own phantom ink, but on its own
left a different, subtler bug: the real ink an eraser stroke was dragged
over stays in TOTALPATH completely unmarked (the erase is its own later,
separate record, not an edit to the covered ink), so simply dropping the
eraser stroke left that now-erased ink fully, incorrectly visible —
confirmed directly on `erase-n6-20230015-horizontal-1270.note` (corrected text left as a
faint ghost underneath the correction) and `link-n6-3.26.40-partial-erase-3p.note`
(a "eraser on marker"/"eraser on pen lines" test page, whose erased gaps
didn't render at all). `parseStrokes`' `includeErasers` option keeps these
strokes instead, as ordinary opaque white ink (`ERASER_COLOR`'s value of
255 already *is* a valid white grey level, so no extra color logic is
needed) — `src/svg.ts`'s `vectorInk` path draws every stroke it decodes in
`TOTALPATH`'s own order, so a white eraser stroke drawn at its own real
position paints back over the ink it was meant to erase, the same way the
device itself does. Not pixel-perfect (a stroke-shaped white overlay only
approximates a true per-pixel erase, and can leave thin slivers of the
original ink visible at its edges), but a large, direct improvement over
leaving the erased ink fully legible.

### Erase and selection records — the 2026-08 erase-fixture investigation

`erase-n5-20260016-all-mechanisms.note`/`erase-n5-20260016-all-mechanisms.pdf` (one page exercising every erase mechanism, with
Supernote's own vector export as ground truth) plus
`erase-n6-20230015-horizontal-1270.pdf` and `link-n6-3.26.40-partial-erase-3p.note` pages 2/3
mapped out the non-ink record types and, more importantly, established
what can and cannot be recovered from the stroke log:

| Record signature | Meaning | Rendered? |
|---|---|---|
| `color=255, pen=3, thickness≈300–400` | eraser (drag and/or region mode; N5/A5X-era id) | never |
| `color=255, pen=9, thickness=1400` | eraser, another mode/size — also seen on gestures that erased nothing (below) | never |
| `color=255, pen=1, thickness 400–2200` | eraser on Nomad-era firmware (id reuses the old ink-pen id; `color=255` is the reliable discriminator, not `pen`) | never |
| `pen=4, color=0, thickness=200` | lasso/selection *path* — the loop drawn to select content for delete, move, or Keyword/Tag creation; frequently stored as two byte-identical consecutive records | never |
| `color=254` (any pen) | real white ink (paint-over cover-ups) | yes, as white |

Findings, each confirmed against device ground truth:

1. **Which strokes are erased is not recoverable by replaying the eraser
   records.** (It doesn't have to be: the stroke itself records it, in
   `m_trailStatus` — finding 3. This finding still stands as a warning
   against the geometric approach, and against reading meaning into an
   eraser record's own shape.) Three independent proofs:
   - `erase-n5-20260016-all-mechanisms.note`'s row-3 line extends well past every recorded eraser
     path's geometry (the covering `pen=9` record's own points stop ~350px
     short of the line's right end), yet the whole line is erased.
   - `erase-n6-20230015-horizontal-1270.note`'s eraser #9 is a *closed loop* whose interior
     strokes (up to ~120px from the path itself) are all erased — a
     region-select erase — while geometrically similar records elsewhere
     are plain drags with only the swept band erased.
   - `link-n6-3.26.40-partial-erase-3p.note` page 3 has `pen=9 color=255` records
     and `pen=4` loops sitting exactly on top of fully-visible keyword
     text: the identical record types there were *selections* (Keyword
     creation, lasso-move), not erases. A geometric replay model tuned to
     perfection on the first two fixtures (union of swept-band + polygon
     containment; 31/31 erased + 61/61 kept, zero errors) mis-erases
     visible text on this page. Same bytes, opposite meaning — the
     difference lives outside the replayed records.
2. **`point_contour` is decoded — and is *not* the visibility record.**
   The leading hypothesis was that per-stroke visibility lives in
   `point_contour` (snlib's name), the device's own rendered-outline
   polygons, since that is also what the newer PDF exports draw (filled
   Bézier outlines). It is now decoded (see the section below) and the
   hypothesis is disproved: **a fully erased stroke stores a full-area
   outline, indistinguishable from a visible stroke's.** Measured on
   `erase-n5-20260016-no-white-pen.note`, whose page is blank on-device and empty in
   Supernote's own export, yet whose five strokes all carry outlines
   enclosing their full nominal area. `flag_draw` (the per-point byte
   array) was decoded and ruled out the same way earlier — all-`1` even on
   fully-erased strokes.

   (A stroke's *own* outline is never clipped by an erase. What records the
   erase is `m_trailStatus` on the stroke — finding 3 — and, where the
   firmware splits a stroke rather than removing it whole, the surviving
   geometry is a *separate* point-less record whose only content is its
   contour. So `point_contour` does carry the survivors; just never in the
   erased stroke's own record.)

3. **`m_trailStatus` — the per-stroke visibility field.** `section_1`'s
   first `i32` (snlib's `unk_8`), immediately after `epa_grays`, reads `0`
   on a stroke the device still draws and a small negative code otherwise.
   Exposed as `IStroke.trailStatus`.

   This was first read here as an "erase mark" meaning eraser *contact*
   rather than disappearance, and only trusted one way (a `0` is certainly
   still there). It is stronger than that: **the codes are a removal
   taxonomy, and the device's own PDF exports draw exactly the records
   reading `0`** — 152 of 189 on `turkish-a6x-20230015-handwriting-erase.note`, 61 of 82 on
   `erase-n6-20230015-horizontal-1270.note`, both counts exact. See Part 1.4 for the code
   table and the evidence per code, including `-4`, which stores each
   surviving fragment of a partially erased stroke as its own contour-only
   record.
4. **What ships**: `pen=4` selection paths are excluded from
   `parseStrokes` unconditionally (they rendered as phantom black loops;
   never visible on-device in any fixture, whatever the selection did),
   alongside the existing `color=255` filtering + `includeErasers` white
   overlay.
5. **Erase-exact output: the record says whether, on its own.**
   `src/svg.ts`'s `vectorInk` drops every stroke carrying a
   `m_trailStatus`, with no reference to the raster at all. That is the
   device's own decision rather than a measurement of one, and it settles
   the case a measurement cannot: an erased stroke sitting under its own
   replacement still finds ink under most of its points, which is what left
   a second `0` visible in `erase-n6-20230015-horizontal-1270.note`'s "1270" before the mark
   was read at all.

   Until the codes were decoded, this ran as a two-threshold rule — measure
   how much of a marked stroke survives in the render and drop it below
   `0.5` — which reproduced that page's 82 decisions but had to guess at
   partial survival everywhere else. The status field removes the guess.

   A near-zero threshold is still applied to *unmarked* strokes, because
   they can be invisible without ever being erased: `erase-n5-20260016-all-mechanisms.note`'s rows
   were covered over with **white ink**, and Supernote's own export of that
   page draws only the white. Those have to be dropped rather than
   drawn-then-covered, because `buildStrokePathElements` sorts strokes into
   tiers instead of keeping `TOTALPATH` order, so a white marker cover-up
   can end up painted *under* the pen stroke it was meant to hide.

   Two subtleties that both caused real regressions while implementing it:
   the check runs *after* `applyHeadingContrastOverrides` and matches the
   displayed color, because a Heading's label is black ink the device
   paints white (matching its real black finds nothing and deletes every
   heading label); and it is limited to `'path'` styles, because a
   `'rect'` record's own color field is meaningless (§ 2-point records),
   so colour-matching drops Heading backgrounds outright.

   A page whose ink layers are empty is the same statement at page scale —
   everything on it was erased — so nothing renders at all, including the
   white eraser overlays, which is exactly `erase-n5-20260016-no-white-pen.note`.

   **What's still approximate.** On firmware that splits a partially
   erased stroke (the `m_copy = 602` eraser, `-4` in Part 1.4), nothing is:
   the surviving fragments are their own records and get drawn as such.
   Elsewhere a partial erase has not been observed to leave a partly-drawn
   stroke — `turkish-a6x-20230015-handwriting-erase.note` looked like the clearest counterexample, its
   marked strokes' measured survival running smoothly from `0.00` to `0.95`
   with no gap, but its device PDF draws none of them: that gradient is
   replacement ink written over the erased words, not survival.

### `record_class` (offset 40) — what a record *is*, and what it still won't tell you

snlib documents offset 40 as `unk_5`, "only ever seen `5000`", and this
document repeated that. It is wrong: `5000` is the value for real ink, and
ink is ~97% of records. Every record in every `.note` fixture (2,601 across all
device families and firmware here) falls into one of four groups:

| Value | Records | What |
|---|---|---|
| `5000` | 2514 | real ink — every pen, every colour, including white |
| `0` | 22 | geometry derived from two points: a Heading background (`"0001"`), a link-tag box (`"0000"`), or a ruler line (`"straightLine"`) |
| `-1`, `-2`, `-4` | 46 | an eraser gesture (three tool modes/eras) |
| `-5` | 19 | a lasso selection path |

Two things make this worth having. `-5` holds every real lasso path, so
`src/strokes.ts` identifies them on this field rather than on the pen id —
durable against firmware reusing ids across tools, which it demonstrably
does (`pen === 1` is both the older ink pen and the Nomad-era eraser). And
`0` is a single uniform marker for the two-point-derived records that have
caused real bugs when mistaken for ordinary strokes — the `"straightLine"`
ruler-line case in particular.

The `pen === 4` test is still applied alongside it, for exactly one record:
`sticker-n5-20260016-plugin-artwork.note` page 1's last record is not a stroke at all. Its
`StrokeConfig` reads `screenHeight: 120` on a 2560-tall page,
`thickness: 0`, zero points, and a `color` of 2012028940 — sticker bytes
being read through the wrong struct (issue #68). It lands `4` in the `pen`
slot and an ordinary `5000` in the class slot, so the pen test drops it by
accident where the class test would keep it and emit an invalid CSS colour.
Worth knowing generally: **`record_class` says what a record is only if the
record really is a stroke record**, and `.note` files contain at least one
thing that isn't.

**What it does not do is tell you whether an erase actually erased
anything**, which is what it was investigated for. `erase-n5-20260016-all-mechanisms.note`, which
exercises every erase mechanism, carries genuine erasers at `-4`; and
`link-n6-3.26.40-partial-erase-3p.note` page 3's `-4` records sit on top of fully
visible keyword text having erased nothing. Same class, opposite outcome.
The field identifies the *tool*, never the *result*.

So the device's own taxonomy (`TRAIL_ERASE_AREA` / `ERASE_LINE_COLOR_VALUE`
/ `CLEAN SCREEN` / region selection / `ERASER select`, Part 1.4) still
implies a discriminator exists, and it is still not found — see the open
questions. Ruled out so far: `disableAreaList`, `point_contour`,
`flag_draw`, and now `record_class`. A plausible remaining reading is that
there is nothing to find in the record at all, and the distinction is
positional — the app decides by replaying trails in order, so a gesture's
meaning may depend on what the *preceding* records did (a lasso immediately
before an eraser is a select-then-delete; the same eraser alone is a drag).
Nothing has tested that yet.

### Lasso operation codes — what a selection actually *did*

A lasso is recorded as two or more records sharing the same loop geometry.
They are not byte-identical, which is what this document previously assumed:
the first reads `m_copy = 604`, and a companion record carries a small
number instead. **That number is the operation performed on the
selection.** (`m_copy` is `section_1`'s second `i32`; Part 1.4 tables its
full range, including the tool ids it carries on eraser records. The name
is Ratta's, and "copy" is a misnomer, or at least far narrower than what
the field holds.)

Measured by taking each loop's polygon, finding the ink strokes drawn
before it whose points fall inside, and checking those strokes against the
page's own render. Loops whose contents also fall inside another loop
carrying a destructive op are excluded, so each figure is attributable to
one loop:

| Op | Loops | Ink strokes inside | Gone from render | Carry a `m_trailStatus` |
|---|---|---|---|---|
| `14` | 4 | 37 | **36 (97%)** | 37 |
| `2` | 1 | 10 | **9 (90%)** | 10 |
| `604` (no companion) | 2 | 27 | **0 (0%)** | 11 |

Clean separation. `14` is delete — every fixture carrying it is a
documented select-then-delete (`erase-n5-20260016-all-mechanisms.note`, `erase-n5-20260016-no-white-pen.note`,
`color-n6-20230015-unknown-palette.note`, `caligraphy-n5-20260016-widths-erase.note` p4), and every stroke it encloses
carries `m_trailStatus = -16`, the code for exactly that operation. `2` and
`4` appear only on `erase-n5-20260016-mixed-colors.note`, a colour-change fixture, so they
are non-deleting edits that rewrite their selection in place — their
sources read `-3`, the moved-away code, and the ink itself lives on in a
later record. `604` alone means the selection was made and nothing
destructive followed; on `link-n6-3.26.40-partial-erase-3p.note` page 3 those are
Keyword/Tag creations.

**This settles the failure this document carried for a while.** The
geometric replay broke on link-tag page 3 because it treated those loops as
deletions; every one of them is `604`, and none of their 27 enclosed
strokes is gone.

The last column of that table needs care, and reading it wrongly is what a
first pass at this did. Eleven of those 27 strokes carry a status *and* look
present when their centrelines are sampled against the render — but they
are not survivors of a selection. That page erases and rewrites in the same
place, so what the samples find is the replacement's ink; attributing each
pixel to the record whose outline covers it drops all of them to zero, and
the page's own PDF export draws 113 paths for its 113 status-free records
and none of the marked ones (Part 1.4). A status means gone, on that page
as everywhere else.

**Nothing keys on the op code.** It is corroboration rather than a decoder
input: `m_trailStatus` already records, per stroke, what each of these
operations did to it — `-16` for a `14` loop's contents, `-3` for a `2`/`4`
loop's — which is exact where containment needs a threshold, and stated by
the file rather than recomputed from geometry. Acting on the op code was
tried and removed for that reason; see the commit history of #79. What the
op code adds is the ability to say what a *loop* was for, which no
per-stroke field answers.

**The ordering hypothesis is disproved.** An earlier open question guessed
the erase-vs-select distinction was positional — that a lasso immediately
before an eraser marks a select-then-delete. It isn't: `erase-n5-20260016-all-mechanisms.note`'s `-4`
erasers are preceded by ordinary ink and did erase, `erase-n5-20260016-mixed-colors.note`'s
are preceded by a lasso, and link-tag page 3's are preceded by ink.
Adjacency predicts nothing. The operation is written down in the lasso
record itself.

One correction that falls out of the same dump: this document once
described link-tag page 3's `pen=9 color=255` records as "selections, not
erases". That is wrong — the ink records around them carry
`m_trailStatus = -99`, so those erasers did touch ink, and the page's PDF
export confirms the ink is gone.

### `point_contour` — decoded: the device's own rendered outline

Each stroke stores the filled region the device actually renders, as
closed polygon rings — the same thing Supernote's newer PDF exports draw
as filled Bézier outlines instead of fixed-width polylines. Exposed as
`IStroke.contour` behind `parseStrokes`' `includeContours` option.

Layout, picking up immediately after the fixed 208-byte `StrokeConfig`:

```
disable_area_list  u32 count + count*24
points             u32 count + count*8      // the sampled centerline
pressures          u32 count + count*2
tilts              u32 count + count*4
flag_draw          u32 count + count*1
epa_points         u32 count + count*8
epa_grays          u32 count + count*4
<52 bytes>                                  // snlib's Section1; its first u32 is the erase mark (above)
control_nums       u32 count + count*4
<10 bytes>                                  // snlib's Section2
point_contour      u32 ringCount
                     per ring: u32 pointCount + pointCount*8
                     // each point: float32 x, float32 y
```

The two fixed spans are the load-bearing part: snlib's declared field
lists for `Section1`/`Section2` add up to different totals, so they were
solved directly instead — 52 and 10 are the only pair that makes *every*
record on a page parse byte-exactly, jointly across two device families
(N5/Manta `erase-n5-20260016-no-white-pen.note` and the older `erase-n6-20230015-horizontal-1270.note`).

Two independent checks confirm the result is real geometry rather than a
coincidental alignment, across 2,387 decoded strokes in 19 fixtures
(99.2% of all strokes; the rest are 2-point rect records and similar):

- **Position.** Each ring's bounding box is its own stroke's transformed
  point extents inflated by about half the rendered width — centered, on
  both portrait and landscape pages.
- **Area.** The enclosed area tracks `pathLength × thickness / 100`,
  the same width unit the `thickness` field is documented in.

Contour coordinates are **float32 pairs already in final page-pixel
space** — no `screenHeight` scaling and no x mirroring, unlike `points`.

The area check also quantifies what the contour adds over stroking the
centerline at a uniform width: round-tipped tools (needle pen, marker)
fill ~1.0× their nominal width, but the ink pen measures ~0.65× and the
chisel-tipped calligraphy pen only ~0.2–0.3×, because their rendered
width narrows with pressure and tilt.

**`vectorInk` now draws these rings directly**, as one filled `<path>`
per stroke under the nonzero winding rule (`buildContourElement` in
`src/svg.ts`), and only falls back to stroking the centerline at a
uniform width for a record carrying no usable contour. Two things follow
that a centerline structurally cannot express:

- **Pressure-varying width along a single stroke**, the thing that makes
  the calligraphy and ink pens sit so far from nominal above.
- **Regions filled by a stroke doubling back over itself.** This is how
  the sticker plugin's artwork is built (issue
  [#68](https://github.com/philips/supernote-typescript/issues/68)):
  drawn as a uniform-width line, such a stroke renders as the hollow
  scribble that traces the fill rather than the filled shape. A sticker
  needs no new format support beyond this — placing one writes plain
  stroke records into the page's ordinary `TOTALPATH`, adding no new tag,
  address or section anywhere in the file.

A record can also carry a contour and **no `points` at all** — the
sticker's own solid silhouette is stored that way, and 38 such records
appear in each of the nomad fixtures too. Those have no centerline to
stroke and so used to render as nothing whatsoever; the outline is the
only geometry they have.

Measured against each page's own render across 15 fixtures, filling the
outline moves the total disagreeing-pixel count from 570,759 to 462,961
(-19%), the largest single gains being
`blank-a6x-3.15.27-shapes-rtr.note` (127,911 → 37,771),
`caligraphy-n5-20260016-widths-erase.note` (19,978 → 8,930) and `sticker-n5-20260016-plugin-artwork.note` (6,892 → 1,874).
Several fixtures move slightly the other way (`layout-n6-20230015-vertical-1180.note` 5,079
→ 6,050, `erase-n6-20230015-horizontal-1270.note` 5,591 → 6,615) because a filled outline
renders a touch bolder than the device's own low-resolution RLE raster —
which is the expected direction, since that raster is already known to
under-represent width against the device's own PDF export (see the
`thickness` section).

### `thickness` field — solved: hundredths of a page pixel

`thickness / 100` is the rendered stroke width in page pixels. Two
independent confirmations:

1. **Supernote's own PDF export.** `heading-n5-20260016-backgrounds-marker.pdf`'s content
   streams use the page's pixel space directly (`MediaBox 0 0 1920 2560`,
   identity CTM apart from a y-flip), and draw every `thickness=400`
   needle-pen stroke with exactly `4 w`. Every slider position maps to a
   clean integer pixel width: 0.1→200→2px, 0.3→400→4px, 0.5→600→6px,
   0.6→700→7px, 0.7→900→9px, 1.0→1200→12px, marker→3800→38px.
2. **The stroke's own bounding box** (`bounding_tl`/`br`, above) is the
   transformed point extents inflated by `thickness / 100 / 2` per side —
   consistent on both Manta (400→~2px inflation) and Nomad
   (200→~1px, 3800→~19–21px) fixtures.

The width slider → thickness mapping is nonlinear on purpose (device
design choice), but the unit itself is exact.

This means `THICKNESS_TO_PIXEL_SCALE = 150` (`src/svg.ts`) under-draws
every stroke by 1.5× relative to Supernote's own vector export: the marker
should render 38px wide, not ~25px. The ~25px raster measurement that
calibrated the constant likely measured the marker's soft-edged raster
rendering too conservatively. The constant should be 100.

**But `thickness` is the tool's *configured* width, not always its rendered
one.** Measuring each stroke's own `point_contour` outline (below) against
its nominal width, across every fixture, splits the pens in two:

| Pen | Nominal vs. rendered |
|---|---|
| `pen=10` needle point | 0.94–1.04× — nominal is correct |
| `pen=11` marker @3800 | 1.06× — nominal is correct |
| **`pen=1` ink pen (older)** | **1.5–2.0×** — renders far wider than nominal |
| `pen=11` marker @1500 | 2.02× |
| `pen=16` ink pen (newer) | 0.77× |
| **`pen=15` calligraphy** | **~0.35–0.45×** — chisel nib lays down far *less* ink than its width implies |

`pen=1` is what every A5X and Nomad fixture writes with, so drawing at
nominal width made `vectorInk` output visibly thinner than the same page's
raster. Confirmed end-to-end against `ink-a5x-2.14.28-old-pen-width.pdf` (Supernote's own
export of one of those pages, and a rare 1:1 case — 146 filled outlines for
exactly 146 decoded strokes): drawing at nominal laid down **40%** of the
ink the device does; measuring each stroke's own outline instead brings
that to **84%**.

So `src/svg.ts`'s `strokeRenderWidth` derives width from the contour when
it's available (falling back to nominal otherwise), which needs no per-pen
or per-firmware table. It recovers the width from the enclosed area by
treating the stroke as a rectangle with a round cap at each end
(`area = length·w + π(w/2)²`, solved for `w`) — without the cap term, a
short stroke's area is mostly cap and implies an implausibly wide line.
The ring areas must be summed **signed**, so that a closed letter's inner
hole subtracts: counting it as more ink made every `e`/`o`/`a` measure up
to 3× too wide.

Both directions of the error are now covered by a dedicated fixture, and
the correction is large either way:

| Fixture (device PDF as truth) | ink drawn at nominal | measured from contour |
|---|---|---|
| `ink-a5x-2.14.28-old-pen-width` (ink pen, `pen=1`) | 0.40× | 0.84× |
| `caligraphy-n5-20260016-widths-erase` p1–p3 (`pen=15`) | 1.82–1.97× | 0.67–0.81× |
| `caligraphy-n5-20260016-widths-erase` p4 (mostly erased) | — | 0.84× |

**Calibrated exactly against widths the device states as numbers.**
Supernote's exporter uses *two* styles, sometimes within one file: filled
outlines (`f`) for some strokes, and stroked polylines carrying an explicit
`w` for others. The second kind is far better ground truth, because the
width is a number the device wrote down rather than a shape to measure —
and `stroke-n5-20260016-isolation-tools-colors-widths.pdf`'s page 4 is exactly that, one needle-pen stroke
per width setting:

| setting | `thickness` | device `w` | `strokeRenderWidth` |
|---|---|---|---|
| 1.0 | 1200 | 12 | 12.01 |
| 0.6 | 700 | 7 | 7.02 |
| 0.3 | 400 | 4 | 4.05 |
| 0.1 | 200 | 2 | 1.99 |

All four within 1%, derived from each stroke's contour without consulting
the pen id or the thickness setting. That is what makes the measurement
trustworthy in absolute terms rather than merely self-consistent.

The same file separates the tools cleanly, each page isolating one variable
(note page 3 is `pen=16`, the newer ink pen, *not* the needle pen):

| Pen | contour ÷ nominal |
|---|---|
| `pen=10` needle | 1.00 — nominal is exact |
| `pen=11` marker | ~1.01 |
| `pen=16` ink pen (newer) | ~0.82 |
| `pen=1` ink pen (older) | ~1.95 |
| `pen=15` calligraphy | ~0.17 |

**Residual, and why nothing is done about it.** Against the *filled-outline*
exports our ink lands ~15–35% under. But those outlines are the exporter's
own drawing of the shape, and page 4 shows that where the device states a
width numerically we match it to 1% — so the gap is in that comparison, not
in the width. `point_contour`'s own enclosed area sits at the same
0.67–0.88× of those outlines, so filling the contour would not close it
either; whatever the exporter does to widen them (feathering, a dilation
step, a stroke alongside the fill) is not in the stroke record. No
correction factor is applied, and page 4 is why: adding one would break the
case that is currently exact.

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
different background color (`thickness` reads 2000 on the Nomad fixture —
also constant per-fixture, also uninformative). `src/svg.ts` still
raster-samples a rect's fill color/pattern from the page's own rendered ink
for this reason (`sampleRect` in `deriveStrokeStyle`) — but the real fill
style is available losslessly from the rect's `TITLE_` metadata block
instead (Part 1.5), verified pixel-exact: transforming a rect record's two
corners into page pixels reproduces its `TITLERECT` x,y,w,h within 1px.

### Exhaustively confirmed: rect color is not anywhere in the stroke record

Every single field in the entire ~700-byte stroke record structure above —
not just `pen`/`color`/`thickness` — was decoded and compared across all
four differently-colored headings on `heading-n5-20260016-backgrounds-marker.note` page 2.
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
for any field, at any offset. **It is recoverable from the `.note` file's
own `TITLE_` metadata blocks instead — see the Titles/Keywords section
below** — so the negative result no longer matters in practice.

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

The raster resampling is now avoidable: the displayed text color is the
last three digits of the heading's `TITLESTYLE` value (below).

### Draw order — record order, except where the marker tool goes underneath

`TOTALPATH` records are in the order the device replays them, and that is
also the order it paints them in: later ink covers earlier ink. Two
exceptions are the whole of what a renderer has to know beyond "draw them in
order".

**A Heading's rect record sits after the ink it backs.** The 2-point
background record for a Heading is written *after* the label strokes drawn
inside it, so painting it in place hides them. Rects are drawn first.

**The marker tool goes under ink that is darker than it.** A highlighter
pass is recorded after the writing it crosses — in every fixture here, every
marker record sits later in the buffer than every non-marker stroke it
overlaps — yet the device still draws that writing on top. It is not the
tool that decides this, it's the darkness:

| Fixture | Marker | Crosses | Device draws |
|---|---|---|---|
| `blank-a6x-3.15.27-shapes-rtr.note` p1 | grey 202/158 | black pen text | text on top of the band |
| `link-n6-3.26.40-partial-erase-3p.note` p1 | grey 202/158 | black pen lines | lines on top of the bands |
| `sticker-n5-20260016-plugin-artwork.note` p2 | black 1 | the sticker plugin's artwork | the marker line on top, hiding the sticker's white detail |
| `link-n6-3.26.40-partial-erase-3p.note` p1 | white 254 | black pen lines | the white, wiping the lines out |
| `heading-n5-20260016-backgrounds-marker.note` p3 | white 254 | the black word "White" | the white, leaving only flecks of black |
| `erase-n5-20260016-all-mechanisms.note` p1, `erase-n5-20260016-white-pen-cover.note` p2 | white 254 | a black marker band | the white, cutting the band |

Read together: **the darker of the two wins, and white always wins.** White
is not a shade in this scheme — it is the palette's cover-up color, the same
role it plays in an eraser record (`ERASER_COLOR`, above).

Both directions were checked against the device's own PDF export *and* the
page's own raster, which agree. The exports are composited, not a stroke
list: a page's ink comes out merged into one path per color, with each
color's geometry already clipped to what is actually visible — which is how
the sticker page shows it, its white detail arriving as fragments where the
marker line crossed it.

`src/svg.ts` reproduces this by ordering rather than by blending
(`isHighlighterPass`): a marker lighter than ink it overlaps is drawn
beneath the page's other ink, and any other marker is drawn in its own
record order. Ordering can express every case in the corpus; it would fall
short only for a single marker stroke that crosses both darker and lighter
ink at once, which no fixture here does.

## Part 1.4 — Field names from Ratta's own binary

The Supernote Partner app for Windows ships Ratta's notebook engine as
`flutter_note_lib.dll`, built with logging left in. It uses Google glog, so
every log call site embeds a `__FILE__` string, and one function —
`logTrails` — prints an entire `TrailContainer` field by field. That gives
the real name of every field in the stroke record, without a debugger or a
disassembler: extract the installer, `strings` the payload, read the list.

This route is due to [Walnut356's write-up](https://walnut356.github.io/posts/inspecting-the-supernote-note-format/)
(the same author as snlib), which found the DLL by profiling the app while
flipping pages. The post itself is now behind this document on the format
proper — it stops at "there's a stroke UID and some config values" for
everything after the point data, and its own open items (thickness, layers,
highlighter) are solved here. Its lasting value is the RE map.

Reproducing it (Linux, no Windows and no Ghidra needed):

```
curl -O https://download-firmware.supernote.com/windows-update/2.5.24/supernote_partner-com-2.5.24-windows-setup.exe
7z x -oext supernote_partner-com-2.5.24-windows-setup.exe   # Inno Setup; 'ext/[0]' is the payload
# 'ext/[0]' is a plain LZMA1 stream: magic 'zlb\x1a', 5-byte props at +4, data at +9.
# python3 -c "import lzma,..." with FORMAT_RAW decompresses it whole (~510MB).
strings -n 6 payload.bin | grep -n logTrails
```

The field names come out of `strings` alone. Reading the engine's *logic*
(the `penType` findings below, and the color routine in the `color`
section) needs one more step, still without Ghidra: the DLL is embedded in
the payload as an ordinary PE image, so carve it out and disassemble it.

```
# scan payload.bin for 'MZ' + a valid e_lfanew -> 'PE\0\0'; the image holding
# the flutter_note_lib.cpp log strings starts at payload offset 46537700 in
# this build. Its length is max(PointerToRawData + SizeOfRawData) over the
# section headers (2,121,216 bytes), and its ImageBase is 0x180000000.
objdump -d -M intel --no-show-raw-insn flutter_note_lib.dll > disasm.txt
```

To go from a string to the code that uses it, convert its payload offset to
a VA with the section table (`VA = ImageBase + section.VirtualAddress +
(offset − section.PointerToRawData)`) and grep the disassembly for that
address — `objdump` annotates every RIP-relative `lea` with its target. All
the addresses quoted below are VAs in that image.

### The full stroke-record field list

`logTrails` emits these in order (the fixed-size scalars appear reversed in
`.rdata`, the arrays in forward order):

```
flagSpecial preNum fontHeight fontWidth pageNum layer penColor penType
recMod m_thickness trailNum flagPenUp walcomEmrType predictName
upLeftPointX/Y keyPointX/Y downRightPointX/Y maxX maxY m_emrPointAxis
m_mupdfChapter m_mupdfPosition m_mupdfOffsetX m_mupdfOffsetY
disableAreaList m_points pressures angles flagDraw epaPoints epaGrays
m_trailStatus m_copy m_trailNumInPage m_beforeShiftAngle m_afterShiftAngle
m_beforeShiftRect m_afterShiftRect m_controlNums m_groupNum m_groupNest
m_groupEnd m_renderFlag markPenDFillDir
```

A second list, the parser's own error strings, confirms the on-disk order
this repo already parses: `disableAreaList`, `m_points`, `pressures`,
`angles`, `flagDraw`, `epaPoints`, `epaGrays`, `m_controlNums`,
`renderFlag empty`, `PointContour`, `m_MarkPenDFillDir`. Note `tilts` is
Ratta's `angles`, and `renderFlag` sits between `control_nums` and
`point_contour` — exactly where this document had an unnamed `section_2`.

### The in-memory trail struct

`logTrails` also pins where each field *lives*, which is what makes the
engine's own code readable: it loads them one by one at fixed offsets from a
trail object of stride `0x340` (832 bytes). This is the in-memory layout,
not the on-disk one — useful for reading the disassembly, not for parsing.

| Offset | Field | | Offset | Field |
|---|---|---|---|---|
| +0x1a0 | `predictName` (`std::string`) | | +0x220 | `pageNum` |
| +0x1f8 | `walcomEmrType` | | +0x224 | `trailNum` |
| +0x204 | `penType` | | +0x228 | `flagSpecial` |
| +0x208 | `penColor` | | +0x22c | `preNum` |
| +0x20c | `m_thickness` | | +0x230 | `layer` |
| +0x210 | `recMod` | | +0x298 | `m_trailStatus` |
| +0x214 | `fontWidth` | | +0x29c | `m_copy` |
| +0x218 | `fontHeight` | | | |

Two things this repo had already concluded fall straight out of it.

**`record_class` is Ratta's `preNum`.** The trail dispatcher classifies a
trail by `penType` and writes the result into `+0x22c`: `penType == 3`
(`TRAIL_ERASE_AREA`) stores `-2` and also forces `penColor = 255`,
`penType == 9` (`ERASER select`) stores `-4`, and `penType == 4` (region
selection) stores `-5`. Those are exactly this document's record classes,
paired with exactly those pen ids across all 2,948 fixture records with no
exceptions. The on-disk field at `StrokeConfig` offset 40 is therefore
`preNum`, and its values are the engine's own tool classification rather
than anything derived.

**`m_trailStatus` really is the visibility field, tested by sign.** Two
independent render filters (`0x1800629eb`, `0x180028730`) begin with
`cmp DWORD PTR [trail+0x298], 0` / `jl` — skip the record if it is
negative. Note that the binary's test is `< 0`, slightly narrower than the
"non-zero" rule this document arrived at from PDF path counts; every code
observed in the wild is negative, so the two agree on all real data. The
same filters then skip `penType` ∈ {`3`, `4`, `-3`} — the erasers'
and lasso's own motion paths, which is the engine's own statement that
those records are not ink.

### `section_1` (52 bytes) — now fully decoded

The names account for the block exactly, and every field checks out
against fixtures (1,134 fully-walked strokes):

| Offset | Field | Observed |
|---|---|---|
| +0 | `m_trailStatus` (i32) | **decoded — the per-stroke visibility field**, see below. `0` (2703), `-99` (122), `-16` (36), `-4` (20), `-3` (9), `-2` (1) across 2,948 records, every `.note` plus `digest-n5-20230015-test.mark` |
| +4 | `m_copy` (i32) | small stable ids identifying the operation that produced the record, see below |
| +8 | `m_trailNumInPage` (i32) | the per-page stroke uid, sequential from 1 |
| +12 | `m_beforeShiftAngle` (i32) | `0` everywhere seen |
| +16 | `m_afterShiftAngle` (i32) | `0` everywhere seen |
| +20 | `m_beforeShiftRect` (4 x i32) | identity `[0,0,1,1]` on unmoved strokes |
| +36 | `m_afterShiftRect` (4 x i32) | identity `[0,0,1,1]` on unmoved strokes |

4+4+4+4+4+16+16 = 52. The shift fields are the lasso move/rotate transform,
which is why they read as identity on ink that was never moved.

### `m_trailStatus` — solved: this *is* the per-stroke visibility field

**A non-zero `m_trailStatus` means the device no longer draws the record.**
Supernote's own vector PDF exports confirm it by count, on two fixtures
from different firmware eras and in the two different export styles:

| Fixture | Ink records | `m_trailStatus == 0` | Paths in the device's PDF |
|---|---|---|---|
| `turkish-a6x-20230015-handwriting-erase.note` p1 | 189 | **152** | **152** |
| `erase-n6-20230015-horizontal-1270.note` p1 | 82 | **61** | **61** |
| `link-n6-3.26.40-partial-erase-3p.note` p3 | 143 | **113** | **113** |

This overturns the conclusion recorded further up this document — that no
per-stroke visibility field exists and the raster is the only thing that
knows. The trail-taxonomy reading that supported it (the app replays trails
into a bitmap rather than reading a visibility flag) is still true of *how
the app renders*; it just doesn't follow that the flag isn't there. It is,
and the exporter's output matches it exactly.

The value says how the record stopped being drawn. Each code is pinned to a
mechanism by a fixture whose README records what was actually done on the
device:

| Code | Meaning | Evidence |
|---|---|---|
| `-99` | erased with the eraser tool, or otherwise removed whole | the bulk of every erase fixture; 21/21 on `erase-n6-20230015-horizontal-1270.note` and 37/37 on `turkish-a6x-20230015-handwriting-erase.note` match what the device PDFs omit |
| `-16` | deleted via lasso-select-and-delete | exactly one stroke each on `erase-n5-20260016-all-mechanisms.note` (row 6, the README's lasso-delete row), `erase-n5-20260016-no-white-pen.note` and `caligraphy-n5-20260016-widths-erase.note` p4 — the three fixtures documented as using all three erase mechanisms — plus all 33 strokes of `color-n6-20230015-unknown-palette.note` p1, which carries one lasso pair and no eraser records |
| `-4` | **partially erased** — the surviving pieces follow as separate contour-only records | `blank-a6x-3.15.27-two-pages.note` / `link-n6-3.26.40-partial-erase-3p.note` p2, whose export draws the pieces and never the stroke — see below |
| `-3` | moved away by a lasso drag; the ink now lives in a later record at the new position | `erase-n5-20260016-mixed-colors.note` p2 uids 1–9, each with an identical-point-count twin at a shifted bbox (uids 15–23) carrying `m_copy = 97` |
| `-2` | unconfirmed — consistent with the binary's `CLEAN SCREEN` trail category | seen once: `line-n5-20260016-ruler-tool.note` p3's only stroke, on a page that renders blank with no eraser and no lasso record present |

Measured against the pages' own renders, `-16` scores 0.000 ink presence on
all 35 records and `-3` averages 0.019 — gone, as claimed. `-99` averages
0.213 rather than 0, and every one of the 24 records that still finds ink
under half its points is a case where a *different, live* record sits on
top of it: the erased word was rewritten in the same place. That is the
same false positive that once left a doubled `0` in `erase-n6-20230015-horizontal-1270.note`'s
"1270", and it is why the raster can't be the primary record even though it
usually agrees.

**Attributing the ink is what settles those cases**, and
`link-n6-3.26.40-partial-erase-3p.note` page 3 is where it matters most: a naive
measurement makes its marked strokes look alive — 15 of the 30 find ink
under half their points, several under every point — because that page
erases and rewrites in the same place. Its export (added later, and now the
third exact count in the table above) says outright that all 30 are gone.
The measurement agrees once the ink is attributed rather than merely
found.
Paint each *live* record's own `point_contour` into a mask, subtract it
from the page's ink, and re-measure: **every marked stroke drops to 0.00,
while all 113 live strokes stay present** — the same 113 the export draws.
No ink on that page needs a marked stroke to explain it. A centreline
sample cannot tell a stroke's own ink from its replacement's; the outlines
can, because each stroke declares the exact region it covers. Worth keeping
in mind wherever a page has no export to check against.

**`-4`: partial erase is recorded, as replacement geometry.** On the two
Nomad pages, each `-4` stroke is followed *in file order* by point-less
records — no `m_points`, same pen/colour/thickness, one `point_contour`
each — that hold the fragments the eraser left behind. Reading page 2 of
either file in `m_trailNumInPage` order shows the mechanism directly: seven
pen lines are drawn (uids 111–117, all marked `-4`), then an eraser sweep
(uid 118) is followed by one fragment record per line, then the next sweep
(133) replaces those with a new generation, and so on. The uids the file
skips are the superseded generations, deleted as each later sweep re-cut
the piece. The five surviving fragments of line 1 tile the original with
four gaps in exactly the four places the eraser crossed it.

**Supernote's own export draws exactly those fragments.** On
`link-n6-3.26.40-partial-erase-3p.pdf` page 2, each of the seven erased pen lines
comes out as its own fragment records and nothing else — 5, 4, 4, 5, 5, 5
and 5 subpaths, matching each fragment record's own extent to within a
pixel — and no subpath anywhere spans the line they came from. That is
per-*piece* ground truth, a level finer than the per-stroke counts above,
and it is what makes `-4` a decode rather than an inference.

Rasterised against the page's own render, the fragments hold 87–100% ink,
and the parent's area *minus* the fragments holds 0–4% (`link-tag`) or
8–21% (`blank-2p`, whose render is coarser). So the parent must not be
drawn and the fragments must be: drawing both paints the erased part back
in. `src/svg.ts` skips every record carrying a status, which does both at
once, since the fragments themselves read `0`.

### `m_copy` — an operation id, not a copy counter

The value is stable across fixtures *and* device families, and tracks the
kind of record rather than any notion of generation:

| Value | Seen on |
|---|---|
| `601` | drag eraser (`pen=3, color=255`) |
| `602` | Nomad-era eraser (`pen=1, color=255`) — the one that splits strokes and produces `-4` |
| `603` | area/lasso eraser (`pen=9, color=255`) |
| `604` | lasso selection path (`pen=4`), the first of the pair |
| `14` / `4` / `2` | the *second* record of a lasso pair: `14` on all four pages where the selection was deleted, `4`/`2` where it was moved or copied |
| `400` | Heading / badge filled rect (`pen=0`, `stroke_kind` `"0001"`) |
| `500` | link-tag box (`pen=0`, `stroke_kind` `"0000"`) |
| `97` / `99` | ordinary ink; common enough to cover whole pages (every stroke of `sticker-n5-20260016-plugin-artwork.note`) so **not** a "this stroke was pasted" marker |

The "produced by copy/paste" reading this document previously recorded is
therefore wrong for `601`–`604`, which are tool ids. It also gives issue
[#70](https://github.com/philips/supernote-typescript/issues/70) its
discriminator from a different direction: with per-stroke visibility
available directly, a geometric replay of the eraser records — the thing
that mis-erased visible text on `link-n6-3.26.40-partial-erase-3p.note` page 3 —
isn't needed at all.

`section_2`'s 10 bytes are likewise `m_groupNum`, `m_groupNest`,
`m_groupEnd`, `m_renderFlag` — grouping state plus the render flag.

### The device's own trail taxonomy

The redraw path (`sndataoperationfile.cpp`) classifies every trail as it
replays it, with one log line per category:

```
this trail is TRAIL_ERASE_AREA trail        this is region selection trail
this trail is ERASE_LINE_COLOR_VALUE trail  trail ERASER select:
this trail is CLEAN SCREEN trail            this is five star
                                            this is normal trail
```

Two things follow. First, it corroborates the record types in the erase
section above, and adds two this repo has no fixture for: a whole-page
"clean screen" erase, and area erase as a category distinct from the
color-255 line eraser (`ERASE_LINE_COLOR_VALUE` is literally the
`color == 255` discriminator, under Ratta's own name).

Second, and more useful: **the app derives visibility by replaying the
trail list into a bitmap** (`redrawTrails`, `fetchRleMatRedraw`,
`trails redraw success`), not by reading a per-stroke visibility field.
This was read here, at the time, as confirmation that no per-stroke
visibility field exists to be found. That inference was wrong, and
`m_trailStatus` is the counterexample (Part 1.4): how the app *renders* a
page says nothing about what its file records. What the paragraph gets
right is narrower — replaying the trails is how the device produces the
bitmap, so the bitmap can never disagree with the trail list.

It also bears on the question that was open here: a geometric replay
mis-erases visible text on `link-n6-3.26.40-partial-erase-3p.note` page 3, because
identical-looking records were selections rather than erases, so a
discriminator had to exist somewhere in the record. It does, in two places
— `m_trailStatus` on the affected ink (which simply is the answer, without
replaying anything) and `m_copy` on the eraser or lasso record itself,
which identifies the tool. `disableAreaList` was the obvious candidate and
is **ruled out**: it is non-empty on only 6 of 1,134 strokes, holds
full-page rectangles (`[-1,0,100,1405]`, `[0,0,99,1872]`), and appears on
ordinary ink and eraser records alike.

### Other names worth having

The same payload carries the internal source tree, which maps each feature
to the file that implements it — useful for aiming any future pass:

```
SnProcess/SnFileProcess/sndatafile.cpp                    stroke record parse
SnProcess/SnDataProcess/sndataoperationfile.cpp           redraw + trail classification
SnProcess/SnDataProcess/sndataoperationtrail.cpp          trail edit operations
SnProcess/snlassosubfunction.cpp                          lasso select
SnProcess/SnFileProcess/SnFileData/sntitlefeaturemodule.cpp   TITLE_ blocks (Part 1.5)
SnProcess/SnFileProcess/SnFileData/snkeywordfeaturemodule.cpp KEYWORD_ blocks
SnProcess/SnFileProcess/SnFileData/snlinkfeaturemodule.cpp    LINK* blocks
SnProcess/SnFileProcess/SnFileData/snstylemodule.cpp          style
ratta_draw_and_recg/include/draw_line/adjusttrailcontainer.cpp  stroke geometry adjust
```

Rendering is OpenCV-based (`CV_8UC4` mats, `overlayImage_fore`), which is
why layer compositing behaves the way this repo's raster path assumes.

### One correction to the blog

The post states the pressure array has 4-byte elements. It does not — it is
`u16`, as snlib's own code has it. Walking every record to its declared
`strokeLen` settles it: with 2-byte pressures every stroke on every
fully-parsing fixture lands exactly on its end boundary, and with 4-byte
pressures essentially none do.

That whole-record walk is also how the tail variance in open question 8
below was characterized: records end exactly at `mark_pen_d_fill_dir` on
most fixtures, carry 4 trailing bytes more on `SN_FILE_VER_20260016` files,
stop after `sized_str_3` on older Nomad/A5X files, and stop before the
sized strings entirely on `SN_FILE_VER_20220011`. Four tail variants, no
version field that predicts which — which is exactly why `parseStrokes`
jumping by `strokeLen` rather than parsing the tail is the right design.

## Part 1.5 — `TITLE_` / `KEYWORD_` footer metadata: where heading style actually lives

The answer to "where is a Heading's background color?" was never in
`TOTALPATH` or `RECOGNFILE` — it's in the `.note` footer's keyed metadata,
alongside `PAGE1`/`FILE_ID`/etc., which this investigation had not swept.

Each Heading gets a footer key `TITLE_PPPPYYYYXXXX` (4-digit page number,
4-digit y, 4-digit x — matching the rect's position) whose value is an
address; `getContentAtAddress`-style resolution (u32 length prefix) yields
a plain metadata block:

```
<TITLESEQNO:0><TITLELEVEL:1><TITLERECT:500,329,356,148>
<TITLERECTORI:500,329,356,148><TITLEBITMAP:430>
<TITLEPROTOCOL:RATTA_RLE><TITLESTYLE:1000254>
```

- `TITLERECT` is `x,y,w,h` in page pixels — it matches the corresponding
  2-point rect record in `TOTALPATH`, which is how to associate the two.
- `TITLEBITMAP` is the address of a standalone `RATTA_RLE` bitmap of the
  title region (used for the on-device titles sidebar).
- `TITLESTYLE` encodes the style as decimal digits `1BBBFFF`:
  `BBB` = background grey level, `FFF` = displayed label-text grey level.
  Confirmed against all four heading variants, on two different devices
  (`heading-n5-20260016-backgrounds-marker.note` Manta, `blank-a6x-3.15.27-shapes-rtr.note`
  Nomad — identical four codes on both):

| `TITLESTYLE` | Background | Label text |
|---|---|---|
| `1000254` | solid black (000) | white (254) |
| `1157254` | solid dark grey (157) | white (254) |
| `1201000` | solid light grey (201) | black (000) |
| `1000000` | cross-hatch pattern | black (000) |

  The `BBB` digits match the canonical 157/201 palette exactly (and the
  PDF export's fill colors). The hatch variant is distinguishable as the
  one code whose background and text digits are both 000 — a solid-black
  heading always carries white text, so `1000000` cannot mean "solid black".

The Keywords feature works the same way: `KEYWORD_PPPPYYYY` keys resolve to
blocks like
`<KEYWORDPAGE:1><KEYWORDSEQNO:0><KEYWORDRECT:259,1591,404,86>`
`<KEYWORDRECTORI:...><KEYWORDSITE:440><KEYWORDLEN:7><KEYWORD:KEYWORD>` —
including the recognized keyword text itself, stored directly in the
`.note` (no `RECOGNFILE` parsing needed).

Practical consequence for `vectorInk`: both remaining raster dependencies
in `src/svg.ts` (`sampleRect` fill sampling and
`applyHeadingContrastOverrides`) can be replaced by a `TITLERECT` →
`TITLESTYLE` lookup.

## Part 2 — `RECOGNFILE`: `ink.bink` decoded, `page.bdom` partially

`page.RECOGNFILE` is an address, resolved the same way as `TOTALPATH`
(`getContentAtAddress`). It's `"0"`/absent on pages with no recognition data
(e.g. `erase-n6-20230015-horizontal-1270.note`); present on pages that had RTR or post-hoc
recognition run (e.g. `rtr-n5-20230015-recognition.note`, `heading-n5-20260016-backgrounds-marker.note`). Where
present, it's a real ZIP archive — MyScript's "iink" handwriting-recognition
engine's own working files for that page:

```
meta.json                    # boilerplate: format-version, OS, iink Application_Version, etc. -- no style data
rel.json                     # tiny: { pages: {...}, objects: { "rectangle/1": {...} } } -- see below
index.bdom                   # tiny (~233 bytes observed), a document-level skeleton -- see below
pages/<id>/meta.json         # per-page boilerplate (creationDate, iink renderer settings)
pages/<id>/page.bdom         # MyScript's structured document model for the page -- see below
pages/<id>/ink.bink          # raw captured ink + the recognition tree -- decoded, see below
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
anywhere in `page.bdom` (checked exhaustively). The string lookups happen
in `ink.bink` instead — its element table names classes literally
(`black-color`, `pen-035`, ...) and `page.bdom` references those elements
by numeric node id (see both sections below).

### `page.bdom` — partially understood structure, reference encoding characterized

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

**Reference encoding — now characterized**: the earlier hunt for
string-table-index references was chasing the wrong construct. `page.bdom`'s
data section references **`ink.bink` node ids** (the `id`/`DWTagId` space
above) as plain little-endian u32s, prefixed by a tag byte `0x04`. Verified
by searching for every distinctive node id from the same page's `ink.bink`
table (88, 141, 192, 245, 250, 251...) — each appears exactly once in
`page.bdom` as a u32, inside a recurring construct:

```
ff 03 <u32> ff 00 00 00 00 <u32> 04 <u32 node-id> ...
```

with tag `0x02` prefixing length-prefixed literal strings (as already
known) and `0x04` prefixing a u32 node-id reference. (Small ids like 16
also match length-prefix bytes in the string table — the previously
documented false-positive trap — but the high, distinctive ids each hit
exactly once, in the data section, in this same construct.) The remaining
unknowns are the `03`-tagged u32s' meaning and the overall record framing,
but with per-element style now known to live in `ink.bink`'s table (by
class-name string) and heading color in `TITLE_` metadata, nothing needed
by `vectorInk` is blocked on finishing this grammar.

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

### `ink.bink` — decoded

`"BINK"` magic, then a header, then per-stroke captured ink, then a typed
element table (the recognition tree). Parses byte-exact end-to-end on every
fixture tried (`heading-n5-20260016-backgrounds-marker`, `stroke-n5-20260016-isolation-tools-colors-widths`, `rtr-n5-20230015-recognition`,
`blank-a6x-3.15.27-shapes-rtr`), all little-endian:

```
"BINK"                                  # magic
u8 x2                                   # version-ish (00 05 observed)
u32 x2                                  # 0, 1 observed
u32 channelCount                        # 4 observed: X, Y, F, T
per channel:
  u32 nameLen + name                    # "X", "Y", "F", "T"
  u8 x4                                 # type descriptor (20 04 01 00 = f32? / 20 02 01 00 for T)
  u32 hasUnit; if 1: u32 len + unit     # "mm", "mm", (none), "ms"
u32 layoutLen + layout block            # per-channel offset/stride records
u32 x2                                  # 1000, 1000 (resolution?)
u32                                     # 3 observed
u8                                      # 0 observed
u32 strokeCount
per stroke:
  u32 unk                               # 0 observed
  u64 timestamp                         # microseconds since epoch (matches fixture creation time)
  u32 duration                          # ms-ish; identical across strokes in some fixtures
  u32 npts
  npts x (f32 x, f32 y)                 # in mm (per channel decl)
  npts x f32 force                      # all zeros in every fixture checked
  npts x u32 t                          # sample index 0..npts-1
element table:
  u32                                   # 0
  u32 entryCount
  u8                                    # 0
  per entry:
    u32 nameLen + name                  # class or node type, see below
    u32 hasAttrs (0/1)
    if 1:
      u32                               # 3 observed
      u32 A                             # start stroke index of this node's range
      u8 05, u8 ff, u16 B               # B varies; meaning unresolved
      u32 C                             # end stroke index of this node's range
      u32 payloadLen + payload          # 0 for most; inline CSS for ".STYLE"; Supernote JSON for "DIAGRAM"
    else: u32                           # 0
    u32 kind                            # 0x0c = style class, 0x64/0x67/0x69 = tree node kinds, 0x0b, 0x00 seen
    u32 id                              # node id -- the SAME id space page.bdom references (see below)
    u32                                 # 0
trailer                                 # one 44-byte terminator-ish record (ids 0xfd/0xfe)
```

What the element table holds:

- **Style-class entries** (kind `0x0c`): names like `defaultPenBrushStyle`,
  `black-color`, `pen-035`, `raw-content`, `.STYLE` (the latter with a raw
  CSS declaration as inline payload, e.g. `"line-height: 1.5"`). These are
  **literal string references into `style.css`** — `.black-color { color:
  #000000FF; }`, `.pen-035 { -myscript-pen-width:0.625; }` are real rules
  there. So MyScript's per-element styling is resolved by class-name
  string, not by the numeric string-table index this investigation
  previously assumed.
- **Recognition-tree nodes**: `INPUT`, `TEXT_STROKES`, `TEXT_LINE`,
  `TEXT_BLOCK`, `WORD`, `CHAR`, `TEXT`, `DIAGRAM`, `LAYOUT_STROKES`, with
  `A`/`C` spanning the stroke indices the node covers (verified: `CHAR`
  nodes cover 1–2 strokes each, their parent `WORD` covers the union, the
  page-level `TEXT` covers all).
- **`DIAGRAM` nodes carry Supernote's own JSON** (not MyScript's): keys
  `DWShape`, `DWContentFieldName`, `DWTagId`, `DWLabel` (the recognized
  text), `DWAlignment`, etc. The `DWTagId` equals the entry's own `id`
  field.

Two negative results: stroke `force` is always zero (pressure is only in
`TOTALPATH`), and nothing in `ink.bink` varies with heading background
color — the only color class present on the four-heading page is
`black-color`, once, globally. Consistent with heading color living in the
`TITLE_` metadata (Part 1.5), not in the recognition data.

## Resolved questions (2026-08 investigation)

All five previously open questions were resolved in one investigation
pass; the findings are folded into the sections above. In brief:

1. ~~`page.bdom`'s reference-encoding grammar~~ — characterized: tag-`0x04`
   u32 references into `ink.bink`'s node-id space. No longer blocks
   anything (heading color turned out to live elsewhere entirely).
2. ~~`ink.bink`~~ — fully decoded (raw ink channels + recognition tree +
   style-class table with literal `style.css` class-name references).
3. ~~Whether Heading colors are exported at all~~ — **yes**, as
   `TITLESTYLE` in the `.note` footer's `TITLE_` blocks (Part 1.5), with
   the real 157/201 palette values as literal decimal digits. Neither
   hypothesis (RECOGNFILE encoding vs. app-side palette index) was right.
4. ~~Unconfirmed `StrokeConfig` fields~~ — `page_num`, `stroke_layer`,
   `font_height`, `unk_2`, `unk_5` confirmed; `bounding_tl/mid/br` decoded
   (page-pixel bbox inflated by half stroke width); `thickness`'s unit
   solved (`/100` = page pixels, via Supernote's own PDF export);
   `rec_mod`/`unk_1`/`unk_3`/`unk_4`/`unk_6`/`unk_7`/`emr_point_axis`
   observed constant (10/0/0/0/26/0s/1) across every fixture.
5. ~~`stroke_kind` for real ink~~ — `"others"` confirmed on 600+ strokes;
   plus a new value, `"fiveStarsSignal"` (Stars feature).

## Remaining open questions

1. ~~Act on the thickness fix~~ — done: `THICKNESS_TO_PIXEL_SCALE` is now
   100, not 150. Confirmed exact (not just closer) against
   `heading-n5-20260016-backgrounds-marker.pdf`: every one of page 1's 32 needle-pen subpaths
   draws with a literal `4 w`, and `400 / 100 = 4` matches precisely.
2. ~~Replace the two remaining raster dependencies in `src/svg.ts`~~ —
   done: `deriveStrokeStyle`/`applyHeadingContrastOverrides` now look up a
   `'rect'` stroke's `TITLE_*` footer entry first (`findMatchingTitleStyle`,
   matched by position against `buildTitleIndex`), and fall back to
   `sampleRect`/raster sampling only when a 2-point rect has no match (a
   badge/highlight box, not a Heading — those still have no known metadata
   source). Confirmed exact against `heading-n5-20260016-backgrounds-marker.pdf`'s own fill
   colors (`0/157/201`, not the raster's quantized `0/128/169`) and the
   label-text contrast colors. This also surfaced and fixed a real bug along
   the way: `_parseFooter` (`src/parsing.ts`) dropped journaled/append-only
   `TITLE_*` keys entirely (unlike `KEYWORD_`/`LINKO_`, which already had a
   workaround) — a re-saved/edited Heading could have silently lost its
   `TITLE_*` metadata before this was fixed.
3. **`pen=5`'s meaning** — **resolved** (issue #75): it is the marker,
   under the id used before `11`, and the star mark separately has `5`
   stamped onto it by the engine on save. See the `pen` field section for
   the evidence and for what this route did *not* yield (there is no named
   pen enum in the binary). The rest of the id table is closed out in the
   same place: `3`/`9` are the two eraser modes, `4` the lasso, and `15`
   the calligraphy pen with a single id.

   It turned up one more thing, since **resolved** by adding `test-a5x-20220011-old-pen-ids.pdf`:
   the older format's `color` ids (48/80) are ids rather than greys, and
   the device's own export names them dark grey and light grey. See the
   `color` section. Reading them literally had been costing that page 16 of
   its 58 strokes.
4. ~~`"straightLine"`~~ — observed, via `line-n5-20260016-ruler-tool.note`. It turned out
   to matter rather than being a loose end: those records store two points,
   which `vectorInk` was reading as a filled rectangle, so every ruler line
   rendered as an invisible box or not at all. See the `stroke_kind` table.
5. **`ink.bink` element-table `B` field** and the `03`-tagged u32s in
   `page.bdom` — the last uncharacterized values in otherwise-decoded
   structures. Nothing depends on them.
6. **`TITLESTYLE` beyond the 4-slot palette** — newer devices with more
   heading styles (or color devices) may use other codes; the `1BBBFFF`
   digit reading is confirmed only for these four values on two greyscale
   devices. (`test-a5x-20220011-old-pen-ids.note`'s stroke colors 48/81 turned out to be older grey
   *ids*, not a color-device palette — see the `color` section — so
   extending the Color table still needs a real color-device fixture.)
7. ~~Decode `point_contour`~~ — done, see its section above: it is the
   device's real rendered outline (with true pressure-varying width), but
   it is **not** a record of what survived erasing, which was the reason
   it was prioritized (that is now handled from the raster instead — see
   the erase-records section). It is now used for stroke width instead
   (`strokeRenderWidth`, see the thickness section), which is what the
   decode turned out to be worth. Its one follow-on — **fill the contour**
   rather than stroking the centerline at the single width derived from it
   — is now done too (see the `point_contour` section). As predicted, that
   bought *shape* fidelity rather than area: a uniform width can't express
   the variation along a stroke, can't represent a chisel-tipped
   calligraphy pen at all, and can't fill a region at all, which is what
   the sticker plugin (issue #68) turned out to need. It did **not** close
   the residual area gap documented in the thickness section — the
   contour's own area is the same ~0.67–0.88× of the device's. Contour
   coordinates being absolute page pixels is handled in `toSvg` by
   `withUpscaledContour`, since `upscale` doesn't reach them the way it
   reaches points.
8. **The remaining stroke-record tail** — `unk_17`, `unk_22`, and the
   `Section3`/`Section4` spans after `point_contour` are still
   uncharacterized. `section_1` and `section_2` are no longer among them
   (Part 1.4 decodes both). The tail's size varies by more than the 4 bytes
   previously noted: walking every record to its declared `strokeLen` finds
   **four** variants across the fixtures — ending exactly at
   `mark_pen_d_fill_dir`; 4 bytes longer (`SN_FILE_VER_20260016`); ending
   after `sized_str_3` (older Nomad/A5X); and ending before the sized
   strings (`SN_FILE_VER_20220011`) — with no version field that predicts
   which. Confirmation that `parseStrokes` should keep jumping by
   `strokeLen` rather than parsing the tail. Nothing needs them.
9. **The erase-vs-select discriminator** — **resolved**, and it did not
   need a geometric replay at all: `m_trailStatus` on the affected ink says
   directly whether the device still draws it, and `m_copy` on the eraser
   or lasso record names the tool (Part 1.4). Two hypotheses were tested
   and disproved on the way, both worth not re-trying: that the
   distinction lives in another `StrokeConfig` scalar — `disableAreaList`,
   `point_contour`, `flag_draw` and `record_class` are each ruled out, the
   last of them naming the *tool* and never the outcome — and that it lives
   in record *ordering*, where adjacency turns out to predict nothing
   (`erase-n5-20260016-all-mechanisms.note`'s erasers follow ordinary ink and did erase,
   `erase-n5-20260016-mixed-colors.note`'s follow a lasso, and link-tag page 3's follow ink).
   What remains open is only the mapping from `m_copy`'s ids to the app's
   own trail categories (`TRAIL_ERASE_AREA`, `ERASE_LINE_COLOR_VALUE`,
   `CLEAN SCREEN`, `ERASER select`), which nothing needs.
10. **`m_trailStatus`'s codes** — **resolved** (Part 1.4): `-2`/`-3`/`-4`/
    `-16`/`-99`, a removal taxonomy, with `-4` pointing at the
    contour-only records that carry a partial erase's survivors. Two codes
    are thinly evidenced: `-2` (one instance) and `-3` (one page).

## References

- [github.com/Walnut356/snlib](https://github.com/Walnut356/snlib) — independent Rust `.note` parser; source of the `TOTALPATH` structure this repo now uses (`src/note.rs`, `src/pen.rs`).
- [walnut356.github.io — Investigating the SuperNote Notebook Format](https://walnut356.github.io/posts/inspecting-the-supernote-note-format/) — the same author's write-up. Behind this document on the format itself, but the source of the Partner-app reverse-engineering route in Part 1.4.
- [Supernote Partner app for desktop](https://support.supernote.com/Tools-Features/supernote-partner-app-for-desktop) — Windows build ships `flutter_note_lib.dll` with glog logging intact; see Part 1.4 for how to extract it on Linux. macOS is App Store only, no Linux build.
- [github.com/jya-dev/supernote-tool](https://github.com/jya-dev/supernote-tool) — Python `.note`/`.mark` parser; its `SvgConverter` doesn't read `TOTALPATH` at all (rasterizes, then traces each of a fixed 4-color palette with `potrace`) but corroborates the same canonical palette.
- Issue [#55](https://github.com/philips/supernote-typescript/issues/55) — original `TOTALPATH` geometry investigation.
- Issue [#56](https://github.com/philips/supernote-typescript/issues/56) — coverage/phantom-stroke follow-up, now resolved by this format's discovery.
- Issue [#60](https://github.com/philips/supernote-typescript/issues/60) — scoped plan for the remaining `page.bdom` work.
- `tests/input/README.md` — what each relevant fixture isolates (`stroke-n5-20260016-isolation-tools-colors-widths.note`, `heading-n5-20260016-backgrounds-marker.note` + `.pdf`).

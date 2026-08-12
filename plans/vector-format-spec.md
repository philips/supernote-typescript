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

Byte offsets, confirmed against real fixtures (`stroke-isolation.note`'s
tool/color/width-isolated pages, `headings-and-marker.note`,
`nomad-3.15.27-blank-shapes-and-RTR.note`):

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
| 44 | `stroke_layer` (u32) | **confirmed** — `test.note` has real `LAYER1` content; its strokes read `1` here, `MAINLAYER` strokes read `0` (0-indexed ignoring background, exactly as snlib says) |
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
| `"0000"` | a 5-point closed-rectangle record for the "link tag" feature's own indicator box (`pen=0`, like `"0001"`) — never real ink, confirmed against `nomad-3.26.40-link-tag-3p.note`: every one of its `"0000"` records' bounding box matches one of the note's own footer `LINK_*` entries' `LINKRECT` pixel-exact, and none of them appear in the page's own rendered ink. `src/strokes.ts`'s `parseStrokes` excludes these unconditionally now (they used to render as a phantom stroked-outline box in `vectorInk` output, since nothing distinguished them from ordinary ink before this field was decoded). |
| `"straightLine"` | the ruler/straight-line tool — also **exactly two points**, being the line's endpoints (`straight-line.note`; those records read `pen=10, thickness=400`, i.e. an ordinary needle pen, and `doc_kind: "name is not set"` like a rect) |
| `"fiveStarsSignal"` | the Stars feature's star mark (`nomad-3.15.27-blank-shapes-and-RTR.note`, drawn with the circled-star gesture; that stroke also reads `pen=5, thickness=100`) |

**`stroke_kind` is the only sound way to tell a filled rectangle from a
two-point *line*.** Three unrelated things store exactly two points, and
counting points cannot separate them:

| `stroke_kind` | two points mean | count in fixtures |
|---|---|---|
| `"0001"` | opposite corners of a filled box | 10 |
| `"straightLine"` | the two ends of a line | 8 |
| `"others"` | an ordinary ink stroke that happens to be a dot/tap | 2 |

They never overlap. Before `straight-line.note` existed, `src/svg.ts`
treated any two-point record as a rectangle and used a raster fill-fraction
test to reject the ones that "weren't real" — which turned each of that
fixture's ruler lines into either a degenerate invisible box or nothing at
all (page 1's six lines rendered as three invisible rects and zero lines).
`IStroke.isFilledRect` now carries the record's own answer.

The same correction retires an old misreading: `test.note`'s two-point
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
| 1 | Ink pen (older firmware) | snlib's `Pen::InkPen = 1`; every ordinary stroke in the Nomad 3.15.27 fixtures and `test.note` reads 1 |
| 5 | unknown | the `fiveStarsSignal` star mark uses it, but `test.note` also has `pen=5, stroke_kind="others"` strokes — not star-specific, meaning unresolved |
| 10 | Needle-point pen | matches snlib's `Pen::NeedlePoint` exactly |
| 11 | Marker | matches snlib's `Pen::Marker` exactly |
| 15 | Calligraphy pen | `stroke-isolation.note` page 2's calligraphy stroke (declared width 0.7 → `thickness=900`) reads 15 — previously misreported here as never isolated; re-decoding with the real structure resolved it |
| 16 | Ink pen (newer firmware) | this repo's own finding on Manta fixtures; same tool as 1, different id by device/firmware generation |
| 0 | (seen on 2-point rect records only) | not a real tool; rects use this consistently, see below |
| anything else | unknown, not guessed at | `parseStrokes` maps to `'unknown'` |

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
158/202, matching the enum exactly. Two adjacent, deliberately close shades,
not a decode error.

**157/201 is the canonical design palette.** Supernote's own PDF export
(`headings-and-marker.pdf`) draws its vector fills at exactly
`0.6156863 rg` = 157/255 and `0.7882353 rg` = 201/255, and the
`TITLESTYLE` metadata (see the Titles section below) encodes the same
157/201 as literal decimal digits. snlib's 158/202 values are the raster-
quantized variants seen in some marker strokes, not the design colors.

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
confirmed directly on `horizontal_1270.note` (corrected text left as a
faint ghost underneath the correction) and `nomad-3.26.40-link-tag-3p.note`
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

`erase.note`/`erase.pdf` (one page exercising every erase mechanism, with
Supernote's own vector export as ground truth) plus
`horizontal_1270.pdf` and `nomad-3.26.40-link-tag-3p.note` pages 2/3
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

1. **The device omits fully-erased strokes from its own exports, but the
   erased ink stays in `TOTALPATH` unmarked** (previously known) — and,
   new: **which strokes are erased is not recoverable by replaying the
   eraser records.** Three independent proofs:
   - `erase.note`'s row-3 line extends well past every recorded eraser
     path's geometry (the covering `pen=9` record's own points stop ~350px
     short of the line's right end), yet the whole line is erased.
   - `horizontal_1270.note`'s eraser #9 is a *closed loop* whose interior
     strokes (up to ~120px from the path itself) are all erased — a
     region-select erase — while geometrically similar records elsewhere
     are plain drags with only the swept band erased.
   - `nomad-3.26.40-link-tag-3p.note` page 3 has `pen=9 color=255` records
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
   `erase-no-white-pen.note`, whose page is blank on-device and empty in
   Supernote's own export, yet whose five strokes all carry outlines
   enclosing their full nominal area. `flag_draw` (the per-point byte
   array) was decoded and ruled out the same way earlier — all-`1` even on
   fully-erased strokes.

   (What `TOTALPATH` *does* record is that an eraser was applied at all —
   see the erase mark below. What it does not record is the resulting
   geometry: the surviving shape exists only in the rendered `RATTA_RLE`
   layers, which is why the device's own exporter, which recomputes from
   them, can omit erased strokes while the stroke log cannot.)

3. **The erase mark — a per-stroke record that an eraser was applied.**
   `Section1`'s first `u32` (snlib's `unk_8`), immediately after
   `epa_grays`, reads `0` on a stroke no eraser ever touched and a small
   negative value otherwise. Exposed as `IStroke.eraserTouched`.

   It marks *contact*, not disappearance — a touched stroke may still be
   largely visible, because the eraser only clipped part of it — but it is
   a sound one-way answer, and that is what makes it useful: across every
   fixture, **all 2,181 strokes reading `0` are fully present in the page's
   own render**. So a stroke without the mark is definitely still there,
   and only marked strokes need the render consulted at all.

   Observed values are `-4`, `-16` and `-99`. They correlate with how much
   survived (every `-16` is completely gone, every `-4` fully intact, `-99`
   mixed) but the encoding isn't confirmed and nothing keys on the value.

   On `horizontal_1270.note` — the one page with per-stroke ground truth —
   exactly the 21 strokes its PDF omits carry the mark, and none of the 61
   it draws do.
4. **What ships**: `pen=4` selection paths are excluded from
   `parseStrokes` unconditionally (they rendered as phantom black loops;
   never visible on-device in any fixture, whatever the selection did),
   alongside the existing `color=255` filtering + `includeErasers` white
   overlay.
5. **Erase-exact output: the mark says *whether*, the raster says *how
   much*.** `src/svg.ts`'s `vectorInk` combines the two. For a stroke
   carrying the erase mark it measures how much survives in the page's own
   render (`strokeInkPresence` — sample along the stroke, look for ink of
   its *displayed* colour nearby) and drops it below `0.5`. On
   `horizontal_1270.note` that reproduces all 82 of the page's decisions
   exactly: erased strokes score `0.00–0.30` there, survivors `0.86–1.00`.

   The mark is what allows a confident threshold. Without it the check had
   to run against every stroke, forcing it down near zero — safe against
   deleting live ink, but too low to catch an erased stroke sitting under
   whatever was written in its place. That is precisely what left a second
   `0` visible in that page's "1270": the digit was written, erased, and
   rewritten on the same spot, so ~30% of the erased one's points still
   found black ink underneath the replacement.

   A near-zero threshold is still applied to *unmarked* strokes, because
   they can be invisible without ever being erased: `erase.note`'s rows
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
   white eraser overlays, which is exactly `erase-no-white-pen.note`.

   **What's still approximate.** A *partially* erased stroke is all-or-
   nothing here: it renders whole or not at all, where the device shows the
   surviving fragments. `turkish.note` is the clearest case — its marked
   strokes' survival runs smoothly from `0.00` to `0.95` with no gap, so no
   threshold can be right for all of them. Clipping each stroke to the
   rendered ink mask, rather than deciding per stroke, is what would remove
   the last threshold entirely.

### `record_class` (offset 40) — what a record *is*, and what it still won't tell you

snlib documents offset 40 as `unk_5`, "only ever seen `5000`", and this
document repeated that. It is wrong: `5000` is the value for real ink, and
ink is ~97% of records. Every record in every fixture (2,601 across all
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
`sticker.note` page 1's last record is not a stroke at all. Its
`StrokeConfig` reads `screenHeight: 120` on a 2560-tall page,
`thickness: 0`, zero points, and a `color` of 2012028940 — sticker bytes
being read through the wrong struct (issue #68). It lands `4` in the `pen`
slot and an ordinary `5000` in the class slot, so the pen test drops it by
accident where the class test would keep it and emit an invalid CSS colour.
Worth knowing generally: **`record_class` says what a record is only if the
record really is a stroke record**, and `.note` files contain at least one
thing that isn't.

**What it does not do is tell you whether an erase actually erased
anything**, which is what it was investigated for. `erase.note`, which
exercises every erase mechanism, carries genuine erasers at `-4`; and
`nomad-3.26.40-link-tag-3p.note` page 3's `-4` records sit on top of fully
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
selection.** (`m_copy` is `section_1`'s second `i32` — see Part 1.4. The
name is Ratta's; "copy" appears to be a misnomer, or at least much narrower
than what the field carries.)

Measured by taking each loop's polygon, finding the ink strokes drawn
before it whose points fall inside, and checking those strokes against the
page's own render. Loops whose contents also fall inside another loop
carrying a destructive op are excluded, so each figure is attributable to
one loop:

| Op | Loops | Ink strokes inside | Gone from render | Erase-marked |
|---|---|---|---|---|
| `14` | 4 | 37 | **36 (97%)** | 37 |
| `2` | 1 | 10 | **9 (90%)** | 10 |
| `604` (no companion) | 2 | 27 | **0 (0%)** | 11 |

Clean separation. `14` is delete — every fixture carrying it is a
documented select-then-delete (`erase.note`, `erase-no-white-pen.note`,
`unknown-color.note`, `caligraphy.note` p4). `2` and `4` appear only on
`erase-colors.note`, a colour-change fixture, so they are non-deleting
edits that still rewrite the strokes. `604` alone means the selection was
made and nothing destructive followed — on `nomad-3.26.40-link-tag-3p.note`
page 3 those are Keyword/Tag creations.

**This is the answer to the failure this document has been carrying.** The
geometric replay broke on link-tag page 3 because it treated those loops as
deletions; every one of them is `604`, and none of their 27 enclosed
strokes is gone. A replay that reads the op code has the information to
skip them. Note the third column too: 11 of those 27 strokes *are*
erase-marked while still fully present — the mark is contact, not
disappearance (as its own section says), so a replay keyed on the mark
alone would still get this page wrong.

**Acted on.** `parseStrokes` reads the op code and drops the strokes a
`14` loop enclosed, so a deleted stroke never reaches the renderer — the
one place a stroke's absence is known outright rather than inferred from
the rendered page. `vectorInk` needs no change; its render-presence check
simply has less left to catch.

Two deliberate limits. Only `14` is acted on: `2`/`4` look destructive in
the table above, but that measurement excluded ink which a *different*
destructive loop also enclosed, and without that exclusion those loops turn
out to contain 14 strokes that are still plainly visible. A recolour
rewrites its selection in place, so its contents survive, and treating
those loops as deletions destroys real ink. And containment is required to
be ≥90% rather than a bare majority, because the error directions aren't
symmetric — a stroke wrongly dropped is ink destroyed, whereas a stroke
wrongly kept still meets the render-presence check. Sweeping the threshold
across every fixture, 0.5 and 0.9 differ by one stroke either way, so the
safe end costs nothing.

**The ordering hypothesis is disproved.** The previous open question
guessed the distinction was positional — that a lasso immediately before an
eraser marks a select-then-delete. It isn't: `erase.note`'s `-4` erasers
are preceded by ordinary ink and did erase, `erase-colors.note`'s are
preceded by a lasso, and link-tag page 3's are preceded by ink. Adjacency
predicts nothing. The operation is written down in the lasso record itself.

One correction that falls out of the same dump: this document describes
link-tag page 3's `pen=9 color=255` records as "selections, not erases".
That looks wrong — the ink records immediately around them carry
`m_trailStatus = -99`, so those erasers did touch ink. They are erasers
that clipped part of a stroke, i.e. the partial-erase case, not a
mislabelled selection.

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
(N5/Manta `erase-no-white-pen.note` and the older `horizontal_1270.note`).

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
`nomad-3.15.27-blank-shapes-and-RTR.note` (127,911 → 37,771),
`caligraphy.note` (19,978 → 8,930) and `sticker.note` (6,892 → 1,874).
Several fixtures move slightly the other way (`vertical_1180.note` 5,079
→ 6,050, `horizontal_1270.note` 5,591 → 6,615) because a filled outline
renders a touch bolder than the device's own low-resolution RLE raster —
which is the expected direction, since that raster is already known to
under-represent width against the device's own PDF export (see the
`thickness` section).

### `thickness` field — solved: hundredths of a page pixel

`thickness / 100` is the rendered stroke width in page pixels. Two
independent confirmations:

1. **Supernote's own PDF export.** `headings-and-marker.pdf`'s content
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
raster. Confirmed end-to-end against `a5x-2.14.28.pdf` (Supernote's own
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
| `a5x-2.14.28` (ink pen, `pen=1`) | 0.40× | 0.84× |
| `caligraphy` p1–p3 (`pen=15`) | 1.82–1.97× | 0.67–0.81× |
| `caligraphy` p4 (mostly erased) | — | 0.84× |

**Calibrated exactly against widths the device states as numbers.**
Supernote's exporter uses *two* styles, sometimes within one file: filled
outlines (`f`) for some strokes, and stroked polylines carrying an explicit
`w` for others. The second kind is far better ground truth, because the
width is a number the device wrote down rather than a shape to measure —
and `stroke-isolation.pdf`'s page 4 is exactly that, one needle-pen stroke
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

### `section_1` (52 bytes) — now fully decoded

The names account for the block exactly, and every field checks out
against fixtures (1,134 fully-walked strokes):

| Offset | Field | Observed |
|---|---|---|
| +0 | `m_trailStatus` (i32) | `0` (1068), `-99` (56), `-4` (10) — **this is the field this repo exposes as `IStroke.eraserTouched`** |
| +4 | `m_copy` (i32) | `0` on 1086; non-zero (`97`, `601`–`604`) on strokes produced by copy/paste |
| +8 | `m_trailNumInPage` (i32) | the per-page stroke uid, sequential from 1 |
| +12 | `m_beforeShiftAngle` (i32) | `0` everywhere seen |
| +16 | `m_afterShiftAngle` (i32) | `0` everywhere seen |
| +20 | `m_beforeShiftRect` (4 x i32) | identity `[0,0,1,1]` on unmoved strokes |
| +36 | `m_afterShiftRect` (4 x i32) | identity `[0,0,1,1]` on unmoved strokes |

4+4+4+4+4+16+16 = 52. The shift fields are the lasso move/rotate transform,
which is why they read as identity on ink that was never moved.

That `eraserTouched` is really `m_trailStatus` reframes it: it is a status
enum, not a boolean, and `-4`/`-16`/`-99` are its codes. The correlation
this document already records (every `-16` gone, every `-4` intact, `-99`
mixed) is consistent with that, but the codes are still not decoded, and
nothing keys on the value.

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
That is independent confirmation that no such field exists to be found —
the raster-consulting approach in the erase section is the same answer the
device itself computes, not a workaround for a missing one.

It also sharpens the one thing that is still approximate here. This
document records that a geometric replay mis-erases visible text on
`nomad-3.26.40-link-tag-3p.note` page 3, because identical-looking records
were selections rather than erases. The taxonomy above says the app
distinguishes those cases, so a discriminator does exist in the record.
Finding it is the concrete next step, and it is now a narrow search rather
than an open-ended one. `disableAreaList` was the obvious candidate and is
**ruled out**: it is non-empty on only 6 of 1,134 strokes, holds full-page
rectangles (`[-1,0,100,1405]`, `[0,0,99,1872]`), and appears on ordinary
ink and eraser records alike. The remaining candidates are the named-but-
unassigned scalars — `flagSpecial`, `preNum`, `flagPenUp`, `trailNum`,
`walcomEmrType`, `recMod` — whose individual offsets among the constant
`unk_1`/`unk_3`/`unk_4`/`unk_5` slots are not yet pinned down, since the
log order is not the struct order.

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
  (`headings-and-marker.note` Manta, `nomad-3.15.27-blank-shapes-and-RTR.note`
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
fixture tried (`headings-and-marker`, `stroke-isolation`, `rtr`,
`nomad-3.15.27-blank-shapes-and-RTR`), all little-endian:

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
   `headings-and-marker.pdf`: every one of page 1's 32 needle-pen subpaths
   draws with a literal `4 w`, and `400 / 100 = 4` matches precisely.
2. ~~Replace the two remaining raster dependencies in `src/svg.ts`~~ —
   done: `deriveStrokeStyle`/`applyHeadingContrastOverrides` now look up a
   `'rect'` stroke's `TITLE_*` footer entry first (`findMatchingTitleStyle`,
   matched by position against `buildTitleIndex`), and fall back to
   `sampleRect`/raster sampling only when a 2-point rect has no match (a
   badge/highlight box, not a Heading — those still have no known metadata
   source). Confirmed exact against `headings-and-marker.pdf`'s own fill
   colors (`0/157/201`, not the raster's quantized `0/128/169`) and the
   label-text contrast colors. This also surfaced and fixed a real bug along
   the way: `_parseFooter` (`src/parsing.ts`) dropped journaled/append-only
   `TITLE_*` keys entirely (unlike `KEYWORD_`/`LINKO_`, which already had a
   workaround) — a re-saved/edited Heading could have silently lost its
   `TITLE_*` metadata before this was fixed.
3. **`pen=5`'s meaning** — used by the star mark and by some ordinary
   strokes in `test.note`; not yet isolated to a tool.
4. ~~`"straightLine"`~~ — observed, via `straight-line.note`. It turned out
   to matter rather than being a loose end: those records store two points,
   which `vectorInk` was reading as a filled rectangle, so every ruler line
   rendered as an invisible box or not at all. See the `stroke_kind` table.
5. **`ink.bink` element-table `B` field** and the `03`-tagged u32s in
   `page.bdom` — the last uncharacterized values in otherwise-decoded
   structures. Nothing depends on them.
6. **`TITLESTYLE` beyond the 4-slot palette** — newer devices with more
   heading styles (or color devices) may use other codes; the `1BBBFFF`
   digit reading is confirmed only for these four values on two greyscale
   devices. (`test.note` shows non-greyscale stroke colors 48/81 exist in
   the wild, so a color-device fixture would also extend the Color table.)
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
9. **The erase-vs-select discriminator** — the app distinguishes
   `TRAIL_ERASE_AREA`, `ERASE_LINE_COLOR_VALUE`, `CLEAN SCREEN`, region
   selection and `ERASER select` (Part 1.4), so something must carry the
   distinction. Resolving it is what would let the erase replay work on
   `nomad-3.26.40-link-tag-3p.note` page 3 and remove the last raster
   dependency in the erase path.

   **Largely answered for lasso selections** — see the lasso operation-code
   section above. `m_copy` on a lasso's companion record encodes what the
   selection did: `604` nothing destructive, `14` delete, `2`/`4` a
   non-deleting edit. Separation is clean (0/27 enclosed strokes gone under
   `604`, 36/37 under `14`), and it resolves the link-tag page 3 failure
   that motivated this question. The ordering hypothesis previously
   recorded here was tested and **disproved**; adjacency predicts nothing.

   ~~(a) wire the op code through `parseStrokes`~~ — done: a delete
   selection's contents are dropped at decode time, with no raster access.

   What remains: the same question for *eraser* records (`-1`/`-2`/`-4`),
   which carry no equivalent code — though the premise may be weaker than
   it looks, since this document's claim that link-tag page 3's `pen=9`
   records were "selections, not erases" appears to be wrong (the ink
   around them is erase-marked; they are partial erases). Ruled out for
   erasers: `disableAreaList`, `point_contour`, `flag_draw`,
   `record_class`, and record ordering.
10. **`m_trailStatus`'s codes** — `-4`/`-16`/`-99` are a status enum, not a
    boolean (Part 1.4). Decoding them may subsume question 9.

## References

- [github.com/Walnut356/snlib](https://github.com/Walnut356/snlib) — independent Rust `.note` parser; source of the `TOTALPATH` structure this repo now uses (`src/note.rs`, `src/pen.rs`).
- [walnut356.github.io — Investigating the SuperNote Notebook Format](https://walnut356.github.io/posts/inspecting-the-supernote-note-format/) — the same author's write-up. Behind this document on the format itself, but the source of the Partner-app reverse-engineering route in Part 1.4.
- [Supernote Partner app for desktop](https://support.supernote.com/Tools-Features/supernote-partner-app-for-desktop) — Windows build ships `flutter_note_lib.dll` with glog logging intact; see Part 1.4 for how to extract it on Linux. macOS is App Store only, no Linux build.
- [github.com/jya-dev/supernote-tool](https://github.com/jya-dev/supernote-tool) — Python `.note`/`.mark` parser; its `SvgConverter` doesn't read `TOTALPATH` at all (rasterizes, then traces each of a fixed 4-color palette with `potrace`) but corroborates the same canonical palette.
- Issue [#55](https://github.com/philips/supernote-typescript/issues/55) — original `TOTALPATH` geometry investigation.
- Issue [#56](https://github.com/philips/supernote-typescript/issues/56) — coverage/phantom-stroke follow-up, now resolved by this format's discovery.
- Issue [#60](https://github.com/philips/supernote-typescript/issues/60) — scoped plan for the remaining `page.bdom` work.
- `tests/input/README.md` — what each relevant fixture isolates (`stroke-isolation.note`, `headings-and-marker.note` + `.pdf`).

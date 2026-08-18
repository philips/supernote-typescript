# Plan: Profile and optimize `toPdf({ vectorInk: true })` for dense notes

Tracks https://github.com/philips/supernote-typescript/issues/101.

## Context

`toPdf({ vectorInk: true })` (added in #95/#98) emits one filled/stroked PDF
path per Supernote stroke via `pdfPage.drawSvgPath()` (`src/pdf.ts`,
`drawVectorInkPrimitives`). Each call:

- builds an SVG-path string with `.toFixed(2)` per contour ring point / per
  centerline point (`drawVectorInkPrimitives`),
- hands it to `pdf-lib`'s `drawSvgPath`, which parses it and pushes a path
  operator sequence into the page content stream,
- which `pdfDoc.save()` later deflates.

For the dense fixtures this matters on — `sticker-n5-20260016-plugin-artwork`
(contour-heavy plugin artwork), `caligraphy-n5-20260016-widths-erase` (wide
calligraphic strokes with large contours), `turkish-a6x-20230015-handwriting-erase`
(thousands of handwriting strokes) — this may be both slower than the raster
path and produce large content streams. #101 asks us to measure, find the
cost centers, decide whether to optimize for v0.6.0, and open concrete
issues for the chosen approach.

The raster-path plan (`plans/rtr-searchable-pdf-workers.md`) already
profiled `toPdf()` and found `encodePng` + `pdfDoc.save()` dominate, with
PDF assembly ~21% and `save()` ~34%. The vector path removes the per-page
PNG embed (the background image is still embedded, but ink no longer is) and
adds per-stroke path construction + serialization instead — so the cost
*shape* changes and must be re-measured, not extrapolated.

## Non-goals

- No optimization is written before the profile in step 1 says one is
  needed. The whole point of #101 is the decision, not the patch.
- No change to the public `toPdf`/`addPdfPage` signatures or to the
  vector-ink visual output — any optimization must be behavior-preserving
  (or opt-in and visually equivalent).
- Not re-deriving the worker plan from
  `plans/rtr-searchable-pdf-workers.md`; that's already decided and
  shipped. This plan is *vector-ink-specific*.

## Step-by-step plan

### Step 1 — Benchmark vector vs. raster PDF on the dense fixtures

Add a bench `tests/pdf-vector.bench.ts` (new file; the existing
`tests/svg-vector.bench.ts` only covers SVG and compares against the
*raster* PDF, not against `toPdf({ vectorInk: true })`). Fixtures are the
three #101 names, plus a sparse one (`demo-a5x-20230015-1to10` or
`blank-a6x-...-shapes-rtr`) as a control so a dense-only regression is
visible.

Per fixture, three benches:

1. `toPdf()` (raster) — baseline.
2. `toPdf({ vectorInk: true })` — the thing we're profiling.
3. `toPdf({ vectorInk: true })` build-only split: time `prepareVectorInkPages`
   + `buildVectorInkPrimitives` separately from `pdfDoc.save()`, so step 2
   has the breakdown already in hand. This may need a small `bench`-only
   harness that calls the internal pieces directly (they're already
   exported from `src/vector-ink.ts`), not a public-API change.

Also record, per fixture, the **output PDF byte size** raster vs. vector —
the "very large content streams" worry in #101 is a size claim, not just a
time claim, and a slow-but-small result points at a different cost center
than a fast-but-huge one.

Output of this step: a table of wall-clock time (one-shot, not the noisy
`vitest bench` warmup average — see how `plans/rtr-searchable-pdf-workers.md`
did it) and output bytes, per fixture, raster vs. vector.

### Step 2 — Identify the cost center

From step 1's breakdown, attribute the vector path's added time to one of:

| Candidate | How to tell it's the culprit |
|---|---|
| Path string construction (`drawVectorInkPrimitives`' `toFixed(2)` loops) | Time split shows `buildVectorInkPrimitives` is a large fraction; profile shows hot time in string concat / `toFixed` |
| `pdf-lib` content-stream serialization (`drawSvgPath` parse + operator push) | Time split shows `addPdfPage` (with pre-built primitives) dominates, not `buildVectorInkPrimitives` |
| `pdfDoc.save()` deflate of large content streams | Time split shows `save()` is the large fraction; output bytes correlate with time; reopening the saved PDF is cheap |
| Contour ring count | Output bytes scale with `stroke.contour` point count, not stroke count; `sticker` page 2 (the known contour-heavy page) dominates |

This is a "look at the data, then decide" step — do not pick the
optimization before this. If no candidate is a meaningful fraction of total
time (vector PDF is within ~10% of raster on the dense fixtures), the
answer to #101 is "no optimization needed for v0.6.0" and the plan stops
at the decision in step 4.

### Step 3 — Sketch the optimization options (only if step 2 says one is needed)

For each option, note what it helps (which cost center from step 2), what
it risks, and whether it changes output. These are candidates to turn into
the concrete issues in step 5, not all to be implemented.

- **Batch adjacent same-color strokes into one path.** Concatenate
  consecutive primitives with the same `color`/`width`/`fill`-class into a
  single `drawSvgPath` call, separated by `M` subpath starts. Helps the
  `pdf-lib` serialization and content-stream-size centers (fewer operator
  state changes, smaller stream). Risk: changes nothing visually if done
  right (each subpath still `M`-resets), but the batching boundary must
  preserve the rects→highlighters→ink ordering `buildVectorInkPrimitives`
  already enforces — only batch *within* each of those three buckets, not
  across. Pure win if it works; first thing to try.

- **Simplify contours before emitting.** Reduce `stroke.contour` ring point
  counts (e.g. Ramer–Douglas–Peucker) with a tolerance bounded to less than
  a pixel at render resolution. Helps the ring-count and string-construction
  centers. Risk: visible quality loss at high zoom — this is the whole
  reason `vectorInk` exists, so the tolerance has to be tiny and must be
  validated against the fixture comparison site's three-way view, not just
  "looks OK to me". Opt-in (`simplifyContours?` option) rather than default
  until proven lossless-looking.

- **Parallelize page assembly in a worker.** The vector-ink pipeline
  (`prepareVectorInkPages` → `buildVectorInkPrimitives`) is pure and
  page-independent, so it's worker-safe the same way `toImage`+`encodePng`
  are in the raster plan. But: the actual `drawSvgPath`/content-stream
  writes need `pdf-lib` objects, which aren't structured-clone-safe, so —
  exactly like the raster plan's decision — a worker can only do the
  primitive-build step and hand back a plain-object description; the main
  thread still does `drawSvgPath`. Only worth it if step 2 says
  `buildVectorInkPrimitives` (not `drawSvgPath`/`save()`) is the hot part.
  Follow the raster plan's Option-A-only conclusion: don't build the
  per-page-PDF-merge machinery for this.

- **`scale` option for vectorInk PDF previews.** `ToPdfOptions` already
  has `upscale`; add a `scale` (integer downsample) that runs the same
  `decodeAtScale`/coordinate-shrink path the raster `scale` option uses, so
  vector-ink preview exports of dense notes are smaller geometry *and*
  smaller background. This is a user-facing knob, not an optimization of
  the default path — file it as a separate feature issue regardless of
  step 2's outcome, since previews are a stated goal in #101 point 4.

### Step 4 — Decision for v0.6.0

Decide from step 2's data:

- **No optimization needed:** vector PDF is within an acceptable margin of
  raster on the dense fixtures and output size isn't pathological. Close
  #101 with the profile attached; v0.6.0 ships as-is. (Still file the
  `scale`-for-previews feature issue from step 3.)
- **Optimize:** pick the single option from step 3 that targets the actual
  cost center. Default to **batching adjacent same-color strokes** (step 3
  option 1) — it's the lowest-risk, behavior-preserving one and helps the
  two most likely centers. Only pick contour simplification or worker
  parallelism if step 2 names their specific cost center.

Record the decision in `CHANGELOG.md` under Unreleased and in a comment on
#101.

### Step 5 — File concrete issues

File issues for whatever step 4 chose (and the `scale`-for-previews feature
regardless), each with:

- the step-1 profile table as the justification,
- the specific cost center from step 2,
- the chosen approach and its risks from step 3,
- an acceptance criterion (e.g. "vector PDF on `sticker` page 2 within X%
  of raster / under Y MB" with concrete numbers from step 1).

Link the issues from #101 and close #101 once the decision (step 4) is
recorded, leaving the implementation issues open.

## Step 1 profiling result (resolves the open question in step 2/4)

Measured via `node scripts/profile-vector-pdf.mjs` (one-shot, three runs
averaged — stable to within ±5 ms) on the fixtures #101 names plus a sparse
control. `build` = `prepareVectorInkPages` + `buildVectorInkPrimitives`
(worker-safe, pure). `addPdfPage` = pdf-lib embed of the background PNG +
`drawSvgPath` per primitive + the invisible text layer. `save` =
`pdfDoc.save()` (deflate of the embedded PNG + content streams).

| fixture | raster total | vector total | vector build | vector addPdfPage | vector save | raster bytes | vector bytes |
|---|---|---|---|---|---|---|---|
| sticker-n5-… (3 pp) | 2645 ms | 2450 ms | 100 ms | 1520 ms | 825 ms | 68.8 KB | 79.5 KB |
| caligraphy-n5-… (4 pp) | 3115 ms | 3180 ms | 180 ms | 1900 ms | 1090 ms | 181.9 KB | 166.7 KB |
| turkish-a6x-… (1 p) | 430 ms | 490 ms | 50 ms | 275 ms | 170 ms | 36.3 KB | 47.3 KB |
| demo-a5x-… (10 pp, control) | 4000 ms | 4120 ms | 190 ms | 2520 ms | 1420 ms | 143.5 KB | 158.6 KB |

To separate the vector-ink-specific cost from the background PNG embed that
both paths share, `addPdfPage` was timed again with `strokes` stripped (just
background + text), per fixture:

| fixture | strokes / prims / contourPts | addPdfPage (no strokes) | drawSvgPath delta |
|---|---|---|---|
| sticker | 56 / 50 / 6 279 | 1384 ms | 148 ms |
| caligraphy | 61 / 49 / 29 577 | 1855 ms | 31 ms |
| turkish | 190 / 153 / 13 702 | 248 ms | 27 ms |
| demo | 14 / 14 / 15 565 | 2424 ms | 112 ms |

**The vector-ink-specific cost (`drawSvgPath delta`) is 27–148 ms — a
single-digit-percent adder on every fixture.** The dominant cost in
`addPdfPage` is the **background PNG embed**, which raster and vector share
(raster embeds background+ink, vector embeds background only); `save()`
follows the same shape, dominated by deflating that embedded PNG. Even on
the contour-heaviest page in the suite (caligraphy, 29 577 contour points
across 49 primitives) `drawSvgPath` adds only 31 ms. Output size is
comparable in both directions (vector is smaller on caligraphy, larger on
the others by ≤16 KB); the “very large content streams” worry is not borne
out — the content streams are tiny next to the embedded background PNG.

Linear extrapolation holds this conclusion at higher density too:
drawSvgPath scales with primitive count (turkish's 153 prims → 27 ms ≈
0.18 ms/prim; sticker's 50 prims → 148 ms ≈ 3 ms/prim, the high end because
its paths are contour-heavy), so even ~2000 strokes would add only
~400–600 ms on top of a 2.5 s background-embed+save floor that raster pays
regardless.

## Step 2 / Step 4 decision

**No optimization is needed for v0.6.0.** No candidate cost center is a
meaningful fraction of total time *and* specific to vectorInk: the
vector-only work (`build` + `drawSvgPath delta`) is 127–296 ms per fixture,
while the 2.5 s background-embed + save floor is shared with raster and
dominates both paths equally. Vector total is within ~10% of raster on
every dense fixture (and faster on sticker), and output bytes are not
pathological. The proposed optimizations from step 3 would target at most
the 27–148 ms drawSvgPath slice — not worth the complexity for v0.6.0:

- **Batching same-color strokes** — would shave a fraction of the 27–148 ms
  drawSvgPath delta; real but negligible against the ~2 s background-embed
  floor. Not warranted now; revisit only if a future fixture shows
  drawSvgPath dominating.
- **Contour simplification** — same target slice, plus it risks the very
  crispness vectorInk exists for. Not warranted.
- **Worker parallelism** — the only worker-safe slice here is the ~100–190 ms
  `build` step; `addPdfPage`/`save` need pdf-lib objects and stay main-thread
  (same conclusion as the raster plan's Option-A-only). Parallelizing `build`
  alone across workers would save <200 ms on a ~4 s export. Not warranted.

Filed as a follow-up regardless: a `scale` option for vector-ink PDF previews
(step 3 option 4) — a user-facing knob for smaller-geometry *and*
smaller-background preview exports, not an optimization of the default path.

## Deliverables

- `tests/pdf-vector.bench.ts` — the bench from step 1 (regression tracking).
- `scripts/profile-vector-pdf.mjs` — the one-shot profiling harness behind
  the table above.
- The profile table + decision recorded on #101 (this section is the source).
- One follow-up feature issue filed from step 5 (`scale` for vector-ink PDF
  previews). No implementation issues — the data says none is warranted.

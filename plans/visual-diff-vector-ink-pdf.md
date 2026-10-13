# Plan: Automated visual diff for vectorInk PDF output

> Issue: https://github.com/philips/supernote-typescript/issues/99
> Follow-up to #95 / #98 (merged). #98 added `toPdf({ vectorInk: true })`
> and a three-way fixture comparison site; the only guard on the PDF path
> today is operator-presence assertions (`tests/pdf.test.ts:190` checks `m`
> shows up; `:201` checks SVG and PDF share the pipeline). Those pass even
> if the PDF renders the wrong picture, as long as it emits *some* path
> operators. This plan closes that gap.

## Context for the implementing agent

This is `supernote-typescript`. Relevant, already-established facts:

- **`toPdf({ vectorInk: true })`** (`src/pdf.ts`) sizes each page in **points** at `pointsPerPixel = 72 / dpi` (default `dpi: 300`, see `ToPdfOptions.dpi`, `src/pdf.ts:63-67`). So a 1404×1872 page (A5X) gets a MediaBox of `1404·72/300 × 1872·72/300 = 337×449` pt.
- **Supernote's own device PDF exports** size pages in a *different* unit: their MediaBox is literally `[0 0 pageWidth pageHeight]` in page pixels (confirmed in the spike below; also documented in `plans/vector-format-spec.md` under the `thickness` section — `MediaBox 0 0 1920 2560`). So 1 device-PDF point = 1 page pixel; rendering it at **72 DPI** yields exactly `pageWidth × pageHeight` px.
- The fixture comparison site (`scripts/build-fixture-site.ts`) already pairs every fixture that ships a device `.pdf` with the library's vector-ink SVG and the library's vector-ink PDF, and computes an **ink-area ratio** (`svgInkArea` vs `device.inkArea`). That ratio is area-based, not spatial — it is blind to *where* the ink lands and to colour/order regressions (hatched fills drawn over ink, white cover-ups in the wrong tier, missing contours on a partial erase all read as the same number). `FIXTURE_NOTES` in `build-fixture-site.ts` and the per-fixture notes in it are the catalogue of which regression class each fixture isolates.
- **`pdf-vector.ts`** (`scripts/`) already turns the device PDF's Form-XObject ink into SVG paths and computes `inkArea` the same way; it is the source of the device-side ground truth on the site. It is build-tooling only, compiled via `tsconfig.scripts.json`, not shipped.
- CI runs on `ubuntu-latest` (`.github/workflows/test.yml`). `node 20`. `pdftoppm` (poppler-utils) is preinstalled on the GitHub-hosted Ubuntu runner; it is also already present on the dev machine this plan was validated on (`/usr/bin/pdftoppm`).

### Spike already done (don't redo — this de-risks the whole plan)

Ran, on the current tree:

```
pdftoppm -png -r 72   tests/input/ink-a5x-2.14.28-old-pen-width.pdf /tmp/dev  # → 1404×1872? no: 1920×2560 (that's the heading fixture)
node -e '…toPdf(sn,{vectorInk:true})…'  && pdftoppm -png -r 300 /tmp/our.pdf /tmp/our300   # → 1404×1872, matching pageWidth/pageHeight
```

Confirmed:
1. Device PDF MediaBox == `[0 0 pageWidth pageHeight]`; at 72 DPI `pdftoppm` yields `pageWidth × pageHeight` px.
2. Library vectorInk PDF at its default `dpi:300`, rendered by `pdftoppm -r 300`, also yields `pageWidth × pageHeight` px.
3. So both rasters land on the **same canonical pixel grid** with no manual resampling. (Any DPI setting on `toPdf` can be matched by rendering that PDF at `toPdf`'s own `dpi` — i.e. `pdftoppm -r <dpi>` — and the device PDF at 72. The implementation below just renders each at its native DPI and resizes both to a fixed canonical thumbnail, which removes the dependency on the `dpi` knob entirely.)
4. A coarse 64×64 grayscale thumbnail MAE between the two full-page rasters is a small, stable number (5.52/255 on the one fixture measured), i.e. well inside the band where a real regression (a whole stroke vanishing, a width doubling, a hatched fill landing on top of ink) would push it far outside. This is the metric the tests below pin.

## Goal

A vitest suite that, for every fixture carrying a device `.pdf` export, rasterizes (a) the device PDF and (b) the library's `toPdf({ vectorInk: true })` output to matching-size PNGs, computes a spatial structural-similarity metric, and **fails CI when the metric drifts beyond a per-fixture tolerance** recorded as a committed baseline. This catches the four regression classes the issue names — hatched fills over ink, stroke-width differences, missing/extra contours on partial erases, white ink cover-ups — that the existing operator-level tests structurally cannot, because all four change *where ink is* without necessarily changing *that operators exist*.

A secondary, smaller check compares the library vectorInk PDF raster against the library vectorInk SVG raster (the issue's item 2) so the two pipelines are confirmed to agree, not just to each exist.

## Step-by-step plan

### 1. Pick rasterizers — one system tool, one WASM; no browsers

- **PDF → PNG: `pdftoppm`** (poppler-utils) via `node:child_process` `spawnSync`. It is deterministic, fast, and present on the GitHub runner and the dev box. Avoid `playwright`/`pdfjs-dist` for PDF rasterization — `pdfjs-dist` warns `use the legacy build in Node` and throws on `DOMMatrix` in this Node; a headless browser is a heavy, flaky dependency for one screenshot. `pdftoppm` is the lower-risk choice and the spike already used it.
- **SVG → PNG: `@resvg/resvg-js`** (WASM, no native build, no system dep). The library's vectorInk SVG is plain `<image>` + `<path>` (no `<text>` in `includeText:false` mode, which is what the comparison uses), well inside resvg's supported subset. Add it as a **devDependency**. (resvg is preferred over `sharp`/libvips because libvips's SVG path goes through librsvg or its own, which varies by build; resvg is one self-contained WASM module with one renderer.)

Neither is a runtime dependency of the shipped package — both are test/build-only, like `pdf-parse` already is.

### 2. CI: install poppler-utils explicitly in the test workflow

`pdftoppm` happens to be on the GitHub Ubuntu runner today, but relying on that is silent breakage waiting to happen (a runner image update could drop it). Add an explicit step to `.github/workflows/test.yml` before `npm test`:

```yaml
      - run: sudo apt-get update && sudo apt-get install -y poppler-utils
```

It is the only system dependency the suite adds. (A pure-JS fallback exists in principle — `pdfjs-dist` legacy build + `canvas` npm — but that pulls in native `canvas` bindings, which is a worse CI story than one apt package.)

### 3. New module `scripts/visual-diff.ts` (compiled by `tsconfig.scripts.json`)

It is build tooling, like `pdf-vector.ts`, so it lives under `scripts/` and imports `src/` directly. Exports used by both a CLI regeneration path and the vitest suite:

```ts
/** One fixture page's three rasters, all resized to the same canonical size. */
interface PageRasters {
  fixture: string;
  pageNumber: number;
  device: Image;      // device PDF page, full page (background + ink)
  libraryPdf: Image;   // toPdf({vectorInk:true}) page, full page
  librarySvg: Image;   // toSvg({vectorInk:true, includeText:false}) page, ink-only over white
}

/** Render the three sources for one fixture to matched-size grayscale thumbnails. */
async function rasterizeFixturePage(fixture: string, pageNumber: number, opts?: { dpi?: number }): Promise<PageRasters>

/** Coarse structural-similarity metric in [0,1]: 1 = identical thumbnail.
 *  Computed on 64×64 grayscale so sub-pixel anti-aliasing between poppler
 *  and resvg cancels, but a whole stroke moving/removing does not. */
function thumbnailSimilarity(a: Image, b: Image): number

/** Full-resolution ink-coverage ratio: (#non-background pixels in library)/(# in device).
 *  A coarse sanity number kept for the same reason build-fixture-site keeps
 *  its ink-area ratio — catches a whole feature going missing even when the
 *  thumbnail metric happens to stay flat. */
function inkCoverageRatio(library: Image, device: Image): number
```

Implementation notes:

- **Canonical size.** Render each source at its *native* page-pixel size (`pdftoppm -r 72` for the device PDF, `pdftoppm -r <dpi>` for the library PDF where `<dpi>` is the `toPdf` `dpi` option used, resvg at `pageWidth × pageHeight` for the SVG). Then resize all three to the same canonical thumbnail (`64×64` grayscale for the similarity metric; full `pageWidth×pageHeight` grayscale for the coverage ratio) via `image-js` `Image.resize` / grey conversion. This is what removes the DPI/units mismatch the spike surfaced — no source is privileged.
- **`pdftoppm` invocation:** write the one-page PDF to a temp file (the suite already produces one-page PDFs in `build-fixture-site.ts:buildFixture` via `toPdf(note,{vectorInk:true,pageNumbers:[n]})`; reuse that exact call), then `spawnSync('pdftoppm', ['-png','-r',String(dpi),'-f','1','-l','1', pdfPath, outPrefix])` and read `outPrefix-1.png`. Surface a clear error if `pdftoppm` is missing (message naming the apt package) so the failure is diagnosable rather than an opaque ENOENT.
- **Background handling for the SVG pane.** `toSvg({vectorInk:true, includeText:false})` embeds the rasterized page background as a base64 `<image>` plus the vector ink paths on top — it is a *full-page* render, matching the device and library-PDF panes, so no compositing is needed; resvg renders the SVG as-is. (This differs from `build-fixture-site`'s `inkOnly()` stripping, which is for that site's like-for-like ink comparison; here we want full pages so PDF-vs-PDF and SVG-vs-PDF are both full-page comparisons.)
- **`thumbnailSimilarity`** uses a 64×64 grayscale thumbnail, mean abs error, normalised to `1 - mae/255`. SSIM was considered and rejected as the primary metric: it is more sensitive to *texture* (anti-aliasing, dither of the background raster) than to the ink-placement regressions we want to catch, and the spike showed the plain MAE is already stable enough. SSIM can be added as a *secondary* recorded metric if a future regression slips past MAE.

### 4. Baselines under `tests/visual-diff-baselines.json`

One entry per fixture-page-comparison, generated once and committed:

```jsonc
{
  "ink-a5x-2.14.28-old-pen-width": {
    "1": {
      "pdfVsDeviceSimilarity": 0.978,   // thumbnailSimilarity(libraryPdf, device)
      "pdfVsDeviceCoverage":   0.84,   // inkCoverageRatio(libraryPdf, device) — ~the 0.84 the spec already records for this fixture
      "pdfVsSvgSimilarity":    0.999   // thumbnailSimilarity(libraryPdf, librarySvg)
    }
  },
  …
}
```

The metric values are not hand-tuned targets — they are **measurements of the current (known-good) render**, recorded so CI catches *drift*, not absolute correctness. This is the same posture `build-fixture-site`'s ink-area ratios take (they are reported, not asserted), except here drift fails CI.

- **Tolerance.** Each asserted metric has a band (default ±0.02 similarity, ±0.10 coverage — wide enough to absorb poppler/resvg point-release anti-aliasing drift, tight enough that a single stroke going missing, a width doubling, or a hatched fill landing on ink trips it; the spike's 5.52/255 MAE ⇒ 0.978 similarity means a regression that moves ~15% of the page reads as similarity ≲ 0.85, well outside the band).
- **Regeneration.** `npm run visual-diff:baseline` (a new `package.json` script) re-runs `rasterizeFixturePage` for every fixture page, recomputes the metrics, and rewrites `tests/visual-diff-baselines.json`. This is what you run after an *intentional* rendering change; the resulting diff in the baseline file is the review artifact for that change, the same way a `--update` snapshot works.

### 5. New suite `tests/pdf-visual-diff.test.ts`

```ts
describe('vectorInk PDF visual diff', () => {
  for (const fixture of FIXTURES_WITH_DEVICE_PDF) {
    describe(fixture, () => {
      for (const page of fixturePages(fixture)) {
        test(`page ${page} matches baseline within tolerance`, async () => {
          const r = await rasterizeFixturePage(fixture, page);
          const base = baselines[fixture][String(page)];

          const pdfVsDev = thumbnailSimilarity(r.libraryPdf, r.device);
          expect(pdfVsDev).toBeGreaterThanOrEqual(base.pdfVsDeviceSimilarity - 0.02);

          const cov = inkCoverageRatio(r.libraryPdf, r.device);
          expect(cov).toBeGreaterThanOrEqual(base.pdfVsDeviceCoverage - 0.10);
          expect(cov).toBeLessThanOrEqual(base.pdfVsDeviceCoverage + 0.10);

          const pdfVsSvg = thumbnailSimilarity(r.libraryPdf, r.librarySvg);
          expect(pdfVsSvg).toBeGreaterThanOrEqual(base.pdfVsSvgSimilarity - 0.02);
        });
      }
    });
  }
});
```

Where `FIXTURES_WITH_DEVICE_PDF` is derived the same way `build-fixture-site.ts:buildFixture` derives its set — iterate `tests/input/*.note`, keep those with a same-stem `.pdf`. Do **not** hardcode the fixture list; reuse that derivation so adding a fixture with a device export adds a visual-diff case for free.

This suite is the one that actually fails CI on a rendering regression — the `m`-operator test in `tests/pdf.test.ts:190` stays as-is (it is the cheap structural guard; this is the spatial one). Expect it to add ~1–2 s × #fixture-pages to the suite (poppler on a single page is sub-100 ms; the spike rendered in well under that).

### 6. Wiring

- `package.json`: add devDeps `@resvg/resvg-js`; add scripts `visual-diff:baseline` (regenerate the JSON) and, if you want a one-shot render-and-dump for eyeballing, `visual-diff:render` (writes the rasters to `tests/output/visual-diff/<fixture>-p<n>-{device,libpdf,libsvg}.png` — mirrors how the image tests already write to `tests/output/`).
- `.github/workflows/test.yml`: add the `apt-get install -y poppler-utils` step from step 2.
- `AGENTS.md`: add a row to the Build/Test/Lint table for `npm run visual-diff:baseline`, and a short note in the *Fixture comparison site* section that the visual-diff baselines live in `tests/visual-diff-baselines.json` and must be regenerated (and the diff justified) when a rendering change is intentional — the same discipline the site already implies.
- `CHANGELOG.md`: note the new CI visual-diff suite under the next version. (No `CHANGELOG.md` existed in the repo; this change is test/CI-internal with no public-API change, so it was skipped. If a changelog is later introduced, record this there.)

## Non-goals

- **No pixel-exact equality assertions.** The two PDFs are produced by different renderers (Ratta's exporter vs this library) and will never be pixel-identical — the spec documents a deliberate ~15–35% width gap on filled-outline exports that no constant corrects without breaking the one exact case (`stroke-n5-…-widths` page 4). Pixel-exact baselines would encode that gap as a "passing" snapshot that still passes when ink regresses onto *different* pixels with the same count. The thumbnail-similarity + coverage-ratio pair is deliberately *not* exact so it catches movement, not just totals.
- **No per-pixel diff image committed to the repo.** A `visual-diff:render` run can emit one to `tests/output/` for eyeballing, but it is gitignored like the rest of `tests/output/`. The committed artifact is the metrics JSON, which is small and reviewable.
- **No replacement of `build-fixture-site`'s ink-area ratio.** That ratio stays — it is a fast, renderer-independent sanity number on a published site humans look at. This suite adds *spatial* CI gating that the site cannot (the site is a GitHub Pages artifact, not a test).
- **No new public API.** `rasterizeFixturePage` etc. live in `scripts/` and are test-only; nothing is exported from `lib/`.

## Open questions the implementing agent should resolve early, not assume

- **Canonical thumbnail size.** 64×64 is the spike's number and is almost certainly fine, but confirm on the densest page in the corpus (`turkish-a6x-20230015-handwriting-erase` page 1, dense handwriting) that a real single-stroke regression still moves the metric outside the ±0.02 band at 64×64. If a stroke is ~2% of page area, a finer grid (e.g. 96×96) may be needed; do not assume 64 is right without measuring on that fixture.
- **resvg + the SVG's `xlink:href` `<image>`.** resvg supports data-URI images, but confirm the base64 PNG background actually renders (not just the paths) on at least one fixture before building the whole suite on it. If resvg mishandles it, the fallback is to rasterize the background separately via `toImage` (already exported) and composite the SVG's *paths only* on top with resvg — more code, so confirm first.
- **Whether to skip the SVG-vs-PDF comparison on fixtures where the two are known to differ by design** (the spec notes the SVG centerline fallback differs from the PDF outline path on `sticker-n5-…-plugin-artwork`). If `pdfVsSvgSimilarity` is inherently low on a fixture, record its real baseline rather than a wishful one, and let the tolerance do its job — same discipline as the PDF-vs-device metric.
- **poppler version drift across runner images.** If a future runner upgrade shifts every baseline by just over the tolerance at once, the fix is to regenerate baselines on the new runner and widen the tolerance slightly — *not* to tighten it, since cross-version poppler anti-aliasing is not the signal. Note this in the baseline file's header comment so the next person knows.

## Implementation outcome (what shipped)

Implemented in `scripts/visual-diff.ts`, `scripts/generate-visual-diff-baselines.ts`, `tests/pdf-visual-diff.test.ts`, `tests/visual-diff-baselines.json` (16 fixtures, 37 pages). Resolved open questions and the deviations from the design above:

- **The 64×64 thumbnail metric was dropped.** Spiking it on `turkish-…-handwriting-erase` p1 showed the full-page thumbnail is dominated by the shared page template (the two PDFs' backgrounds agree almost everywhere), so removing one handwriting line moved similarity by only ~0.006 — *inside* the planned ±0.02 band. It is not sensitive enough to a localized regression. The thumbnail-similarity/coverage-ratio pair from step 3 was replaced by three metrics measured at native `pageWidth × pageHeight` resolution: `inkAreaRatio` (dark-ink pixel ratio of library SVG over device), `iouSvgVsDevice` (IoU of the two ink masks — the spatial one), and `pdfDiffFrac`/`pdfMae` (full-page pixel disagreement between the library PDF and device PDF, thresholded at 40 grey levels so the shared template cancels while ink edges register).
- **`pdfDiffFrac` is the only metric that rasterises the actual library PDF** (via `pdftoppm`), so it is the one that sees pdf-lib's filled-contour / stroked-centreline / hatched-rect drawing and the only one that sees *colour* — which is what catches a white-ink cover-up the dark-ink masks are blind to. `iouSvgVsDevice` adds the spatial sensitivity the page-level diff lacks; `inkAreaRatio` is the cheap deterministic backbone. A simulated regression (2× ink on `ink-a5x` p1; IoU 0.95 on `turkish` p1 vs the real 0.84) trips the suite with a message naming the drifted metric.
- **The template-subtraction ink-mask idea (drafted during the spike) was dropped.** `toImage`'s template raster is RGBA with transparency, so it does not cancel cleanly against the RGB PDF render (`pdftoppm` composites the embedded PNG over white), making the derived ink mask unreliable. The full-page `pdfDiffFrac` does not need template isolation — the two PDFs' shared template cancels at the >40-grey-level band by itself.
- **resvg renders the full-page vectorInk SVG (base64-PNG `<image>` + paths) correctly** — confirmed before building the suite (open question resolved: no fallback needed). The ink-only comparison strips the `<image>` first, the same `inkOnly()` transform `build-fixture-site.ts` uses.
- **`targetWidth` downsampling was added then defaulted off.** The suite's cost is in rendering (`toPdf`/`toSvg` each call `toImage`), not the pixel math, so downsampling made the suite *slower*, not faster. The option remains for cheap local iteration. Page tests are `test.concurrent` instead, overlapping the per-page rendering across the vitest worker.
- **Tolerances** (`scripts/visual-diff.ts` `DEFAULT_TOLERANCE`): `inkAreaRatio ±0.08`, `iouSvgVsDevice ±0.03`, `pdfDiffFrac ±max(15% of baseline, 0.003)`; pages where the device draws no ink assert `ourInkPixels` stays below a 500-px floor (no phantom ink on blank pages) instead of a meaningless ratio.
- **CI**: `.github/workflows/test.yml` pins `poppler-utils` explicitly before `npm test`. `package.json` adds `@resvg/resvg-js` (devDep) and a `visual-diff:baseline` script. `AGENTS.md` documents the suite and the regenerate discipline. Full suite: 228 tests (189 + 39 new), ~152 s wall — the new file adds ~30 s wall thanks to the 2-worker pool overlapping it with the other files.

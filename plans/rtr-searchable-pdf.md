# Plan: Add a `toPdf()` API that renders searchable PDFs with an invisible RTR text layer

## Context for the implementing agent

This is `supernote-typescript`, a parser/renderer for Ratta Supernote `.note` files. Relevant facts already established:

- **Exports** (`src/index.ts`): `SupernoteX` (parser), `toImage` (rasterizes pages to `image-js` `Image` objects, see `src/conversion.ts`), `fetchMirrorFrame`.
- **No PDF code exists anywhere in the repo.** `package.json` dependencies are just `color`, `fs-extra`, `image-js` — no PDF library.
- **RTR** = "Real Time Recognition" (Supernote's on-device handwriting recognition). Confirmed by test fixture `tests/input/rtr-n5-20230015-recognition.note` and its expected text `'Real time recognition paragraph test'`.
- **Data model** (`src/format.ts:132`): `IRecognitionElement { label, type, words: [{ label, "bounding-box"?: { x, y, width, height } }] }`. Populated per-page at `page.recognitionElements` (`src/format.ts:181`) by `SupernoteX._parseRecognition` (`src/parsing.ts:357`).
- Existing helpers `_extractText` (`src/parsing.ts:377`) and `_extractParagraphs` (`src/parsing.ts:385`) already show the pattern for walking `type === 'Text'` elements and reading `e.words[0]['bounding-box']`, but they discard position info once flattened to a string — the new code needs to keep per-word boxes.
- Page pixel size is `note.pageWidth` / `note.pageHeight` (`src/format.ts:3-6`), the same dimensions `toImage()` rasterizes to (`src/conversion.ts:94-97`).
- Useful test fixtures already in the repo: `tests/input/rtr-n5-20230015-recognition.note` (has paragraph/text expectations in `tests/main.test.ts:149-174`) and `tests/input/blank-a6x-3.15.27-shapes-rtr.note`.

## Goal

Add a public API, e.g. `toPdf(note: SupernoteX, options?): Promise<Uint8Array>`, that produces a multi-page PDF per Supernote note where:
1. Each PDF page shows the rasterized page image (from `toImage`) as the visible content.
2. Each recognized word is drawn as **invisible** text (PDF text-rendering mode 3) positioned directly over the handwriting that produced it, so PDF viewers/search/copy-paste find the right word in the right place — the standard "OCR text layer" technique used by scanned-PDF tools.

## Step-by-step plan

1. **Spike: verify the coordinate space before writing real code.** This is the biggest risk in the task. Write a throwaway script that loads `tests/input/rtr-n5-20230015-recognition.note`, calls `toImage`, and dumps `page.recognitionElements[*].words[*]['bounding-box']` alongside `note.pageWidth`/`pageHeight` and the actual rendered image dimensions. Confirm bounding boxes are already in page-pixel space (same origin/scale as the raster image) with no separate DPI/scale factor. If they're not 1:1, work out the correct scale/offset here before proceeding — don't guess in the main implementation.

2. **Add dependencies.** Add `pdf-lib` for PDF construction, and `@pdf-lib/fontkit` for embedding a Unicode-capable TTF (the standard 14 PDF fonts don't cover most recognized text, and Supernote recognition may include non-Latin scripts). Pick and vendor/bundle a permissively-licensed Unicode font (e.g. Noto Sans) or accept a font path via options.

3. **New module `src/pdf.ts`** exporting `toPdf(note: SupernoteX, options?: { fontBytes?: Uint8Array }): Promise<Uint8Array>`:
   - For each page: call `toImage`-equivalent per-page rendering (check whether `toImage` needs to run once for the whole note or supports per-page — read `src/conversion.ts` signature), embed the resulting PNG/bitmap into a new `PDFPage` sized to `pageWidth`/`pageHeight` (convert pixels → PDF points using a fixed assumed DPI, e.g. 96 or whatever matches Supernote's real DPI — confirm this too, since it affects physical print size, not searchability).
   - For each `page.recognitionElements` entry with `type === 'Text'`, for each `word` with a `bounding-box`: compute PDF coordinates. PDF origin is bottom-left, so `pdfY = pageHeightPts - (box.y + box.height) * scale`. Set font size from `box.height * scale`.
   - Draw invisible text. `pdf-lib`'s high-level `drawText` doesn't expose text-rendering mode, so use `page.pushOperators` with raw operators (`BT`, `Tr 3` to set invisible mode, `Tf`, `Td`, `Tj`, `ET`) — or check if a newer `pdf-lib` version added a `renderMode` option to `drawText` and prefer that if available.
   - Decode word labels the same way `_extractText` does (`decodeURIComponent(escape(e.label))`) before drawing.
   - Handle pages with `RECOGNSTATUS === RecognitionStatuses.NONE` (or missing `recognitionElements`) by emitting the image with no text layer — not an error case.

4. **Export from `src/index.ts`**: `export { toPdf } from './pdf';`

5. **Tests** (`tests/main.test.ts` or a new `tests/pdf.test.ts`):
   - Generate a PDF from `tests/input/rtr-n5-20230015-recognition.note`, write it to `tests/output/` like the existing image tests do.
   - Use a PDF text-extraction library (e.g. `pdf-parse` or `pdfjs-dist`, dev dependency only) to assert the extracted text matches (or is a superset of) the known-good text from the existing `rtr-n5-20230015-recognition.note` test (`tests/main.test.ts:152-174`).
   - Optionally assert extracted text *item positions* (if the chosen extraction library exposes them) fall within the page bounds and in roughly the expected reading order, as a sanity check on the coordinate mapping from step 1.
   - Also run against `blank-a6x-3.15.27-shapes-rtr.note` and a note with no recognition data, to confirm the no-text-layer path doesn't throw.

6. **Docs**: add a short usage example to `README.md` alongside the existing `toImage` example (check `README.md` for the existing example format and match its style).

## Non-goals

- No reflowed/native PDF text (this is an image-plus-invisible-text overlay, not a real text document).
- No attempt to lay out shapes/drawings/other layer types as vector PDF content — only the rasterized page image plus the text layer.

## Open questions the implementing agent should resolve early, not assume

- Exact page-pixel → PDF-point DPI conversion (affects only physical page size, not searchability, but should be correct).
- Whether `toImage` can be called per-page or only for the whole note (affects the render loop structure).
- Confirm license terms before bundling any font file.

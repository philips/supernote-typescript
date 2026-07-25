# Plan: Worker-parallel page rendering for `toPdf()`

## Context

`toPdf()` (`src/pdf.ts:43`) currently does everything on one thread, in a loop over `pages`: call `toImage(note, pageNumbers)` (`src/conversion.ts:71`) once up front for all pages, then per page, embed the PNG and push invisible-text operators. The CPU-heavy part is inside `toImage` — `RattaRLEDecoder.decode()` and `compositeImages()` — which is pure, page-independent, synchronous pixel work. The PDF-assembly part (`embedPng`, `drawImage`, `pushOperators` for text) is comparatively cheap. `toImage` already accepts a `pageNumbers` array (`src/conversion.ts:73-75`), so per-page rendering is already a well-defined unit of work — the missing piece is a way to hand that unit to a worker and feed the result back into PDF assembly, since `toPdf` currently couples render and assemble into one inseparable loop.

## Goal

Let an application render pages in parallel across Web Workers (browser) or `worker_threads` (Node), without duplicating this library's PDF-assembly logic in application code, by splitting `toPdf` into a render step (worker-safe, already mostly exists) and an assemble step (main-thread only, since `pdf-lib` document objects aren't transferable).

## Step-by-step plan

1. **Spike: profile the split before committing to it.** Measure wall-clock time spent in `toImage` vs. the rest of `toPdf`'s per-page loop (PNG embed + text operators) on a multi-page fixture. This determines whether parallelizing render-only (Option A below) captures most of the win, or whether PDF assembly is expensive enough to also need offloading (Option B). Don't guess — the earlier coordinate-scale spike (see `plans/rtr-searchable-pdf.md`) showed assumptions here are easy to get wrong.

2. **Refactor `toPdf` into three pieces**, keeping its existing public signature and behavior unchanged (backward compatible):
   - `createPdfContext(options?: ToPdfOptions): Promise<{ pdfDoc: PDFDocument, font: PDFFont }>` — the current setup code (`src/pdf.ts:49-57`): creates the `PDFDocument`, embeds the font (default Helvetica or custom `fontBytes`). Runs once, main thread only.
   - `addPdfPage(ctx: { pdfDoc, font }, page: IPage, image: Image | Uint8Array, options?: { dpi?: number }): Promise<void>` — the current per-page body (`src/pdf.ts:59-109`): sizes the page from the image, embeds it (accept either an `Image` or already-encoded PNG bytes, so a worker can hand back raw PNG bytes without the main thread needing an `Image` reconstruction step), and draws the invisible text layer from `page.recognitionElements`. Main thread only, since `pdfDoc`/`font` are `pdf-lib` objects.
   - `toPdf(note, options)` stays as the convenience wrapper: `createPdfContext` → loop calling `toImage` + `addPdfPage` → `pdfDoc.save()`. Single-threaded, unchanged from the caller's perspective.

3. **Confirm (don't assume) that per-page render input is structured-clone-safe.** `toImage(note, [n])` only touches `note.pageWidth`, `note.pageHeight`, and `page.LAYERSEQ`-referenced layers' `bitmapBuffer` (`src/conversion.ts:80-95`). A worker doesn't need the whole `SupernoteX` instance (which also carries methods that won't clone, and every other page's buffers, wasteful for large notebooks) — it needs a minimal plain-object slice per page. Add a small extraction helper, e.g. `extractPageRenderData(note: ISupernote, pageNumber: number): IPageRenderData` returning just `{ pageWidth, pageHeight, layers }`, so applications don't need to reach into internals to build a transferable payload. Write a real `node:worker_threads` round-trip test that posts this slice to a worker, renders it, and posts PNG bytes back — this is the actual risk area (something not surviving structured clone), not something to assume works.

4. **Document the application-side pattern** (README + example), since the worker orchestration itself is the app's responsibility, not this library's:
   ```ts
   const note = new SupernoteX(buffer);
   const ctx = await createPdfContext();
   const pngBuffers = await Promise.all(
     note.pages.map((_, i) => renderInWorker(extractPageRenderData(note, i + 1)))
   ); // each worker: toImage(sliceAsNote, [1]) + encodePng, both already exported
   for (let i = 0; i < note.pages.length; i++) {
     await addPdfPage(ctx, note.pages[i], pngBuffers[i]);
   }
   const pdfBytes = await ctx.pdfDoc.save();
   ```
   Note `toImage` and `encodePng` (from `image-js`, already a dependency) are sufficient for the worker side today — no new export needed there, only documentation that they're safe to call off-main-thread.

5. **Tests**: unit-test that `addPdfPage` given a pre-rendered `Image` vs. given pre-encoded PNG bytes produces equivalent output; unit-test that `toPdf` built from the three pieces still produces byte-identical (or search-equivalent, via the existing `pdf-parse` check) output to the current implementation, so the refactor is provably behavior-preserving; add the `worker_threads` round-trip test from step 3.

## Non-goals

- No bundled Worker/browser glue code or a full example app — orchestration is application-specific.
- Not parallelizing the invisible-text-drawing loop itself (cheap relative to RLE decode; not worth the complexity per the spike in step 1, pending its result).
- Not pursuing per-page PDF merge (Option B: build single-page PDFs in workers, merge via `PDFDocument.copyPages`) unless step 1's profiling shows assembly is a meaningful fraction of total time — it adds real complexity (duplicated embedded fonts inflate file size unless deduped).

## Open question for whoever implements this

Step 1's profiling result decides whether this plan is even the right shape — if PDF assembly turns out to be non-trivial too, Option B needs its own design pass before implementation starts.

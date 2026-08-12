# Supernote file-format support

This library uses [image-js](https://github.com/image-js/image-js) and can be used inside of browser environments and/or node.

Ratta Supernote has often commented that the file-format is yet unstable and shouldn't be much relied upon (yet). Please keep this in mind.

For some quick snippets, take a look at the [smoke tests](./tests/main.test.ts).

### Generating searchable PDFs

`toPdf` renders each page's raster image into a PDF page and overlays the recognized handwriting (RTR) text invisibly at the location it was written, so the PDF is searchable and words can be selected/copied from the image. See [tests/pdf.test.ts](./tests/pdf.test.ts) for a full example.

```ts
import { SupernoteX, toPdf } from 'supernote-typescript';

const note = new SupernoteX(buffer);
const pdfBytes = await toPdf(note);
```

The default font (Helvetica) only supports Latin text. Pass `fontBytes` with a Unicode TTF/OTF to support other scripts:

```ts
const pdfBytes = await toPdf(note, { fontBytes: await fs.readFile('NotoSans-Regular.ttf') });
```

#### Rendering pages in parallel across Workers

`toPdf` is a convenience wrapper around three lower-level pieces, exported so applications can render pages in parallel (across Web Workers or Node `worker_threads`) instead of one at a time on the main thread:

- `extractPageRenderData(note, pageNumber)` — pulls out the minimal, structured-clone-safe slice of one page needed to render it, safe to `postMessage` to a Worker.
- `toImage` and `encodePng` (from `image-js`) — both safe to call inside a Worker; render the page and encode it to PNG bytes there.
- `createPdfContext(options?)` / `addPdfPage(ctx, page, image, options?)` — must run on the main thread (they hold `pdf-lib` objects, which aren't structured-clone-safe); `addPdfPage` accepts either an `Image` or already-encoded PNG bytes, so it can take a Worker's output directly.

```ts
import { SupernoteX, extractPageRenderData, createPdfContext, addPdfPage } from 'supernote-typescript';

const note = new SupernoteX(buffer);

// In each Worker: toImage(pageRenderData, [1]) then encodePng(image), then
// postMessage the PNG bytes back. See tests/fixtures/render-worker.mjs and
// tests/pdf-worker-roundtrip.test.ts for a full worker_threads example.
const pngBuffers = await Promise.all(
  note.pages.map((_, i) => renderInWorker(extractPageRenderData(note, i + 1))),
);

// Back on the main thread: assemble the PDF from the rendered pages.
const ctx = await createPdfContext();
for (let i = 0; i < note.pages.length; i++) {
  await addPdfPage(ctx, note.pages[i], pngBuffers[i]);
}
const pdfBytes = await ctx.pdfDoc.save();
```

Note that only page rendering (`toImage`/`encodePng`) is parallelizable this way — PDF assembly, including the final `pdfDoc.save()`, is a single main-thread operation regardless of how many Workers rendered pages.

### Generating searchable SVGs

`toSvg` renders each page to a standalone SVG document: the rasterized page image embedded as a base64 PNG, with the recognized handwriting (RTR) text overlaid invisibly at the position it was written, same as `toPdf`. SVG has no native multi-page container, so `toSvg` returns one SVG string per page.

```ts
import { SupernoteX, toSvg } from 'supernote-typescript';

const note = new SupernoteX(buffer);
const svgs = await toSvg(note); // one SVG document string per page
await fs.writeFile('page-1.svg', svgs[0]);
```

Pass `{ dpi }` to size the SVG's `width`/`height` attributes in physical inches (the `viewBox`, and so the coordinate space the image and text sit in, always stays in raw pixels); pass `{ includeText: false }` to skip the text overlay and just embed the image.

Like `toPdf`, `toSvg` is a convenience wrapper around lower-level pieces — `extractPdfPageData`, `toImage`/`encodePng`, and `addSvgPage` — for rendering pages in parallel across Workers. Unlike `addPdfPage`, `addSvgPage` doesn't touch any non-structured-clone-safe objects, so the whole per-page pipeline (`toImage` + `encodePng` + `addSvgPage`) can run inside a Worker, with only the resulting strings posted back to the main thread.

### Cheap thumbnails: rendering at a reduced resolution

`toImage` always rasterizes at the note's native `pageWidth`×`pageHeight` — fine for a main view or export, but wasteful for something like a small thumbnail sidebar, where decoding and holding a full-resolution page in memory per thumbnail adds up fast on memory-constrained devices (this is what motivated [#40](https://github.com/philips/supernote-typescript/issues/40)). Pass `{ scale }` to render directly at a reduced resolution instead:

```ts
const thumbnails = await toImage(note, undefined, { scale: 10 });
```

`scale` is an integer downsample factor; output pages are `ceil(pageWidth / scale)` × `ceil(pageHeight / scale)`. This isn't full-resolution decoding followed by a resize — each layer is decoded directly at the reduced resolution (`RattaRLEDecoder.decodeAtScale`, nearest-neighbor sampled), so the full-resolution buffer is never allocated at all. On a 1404×1872 page, `scale: 10` produces a ~104 KB output buffer instead of the ~10 MB a full decode would need.

Omitting `scale` (or passing `{ scale: 1 }`) renders at full resolution exactly as before.

### Sharper exports: rendering at a higher resolution

Supernote's own export offers a "200%" option that produces a larger raster (e.g. 3840×5120 instead of 1920×2560) for use on high-density displays or print, at the cost of visibly softer pixel-grid edges on ink strokes since there's no extra stroke detail to reveal — it's a resize, not a redraw. Pass `{ upscale }` to `toImage`/`toSvg` for the same effect:

```ts
const images = await toImage(note, undefined, { upscale: 2 }); // 2x pixel density
const svgs = await toSvg(note, { upscale: 2 });
```

`upscale` is a bicubic resize applied after decoding/compositing (any finite number >= 1, not just an integer); it combines with `scale` (applied on top of whatever resolution `scale` decoded at). Unlike a plain resize, edge pixels are premultiplied by alpha before resizing and divided back out after, so anti-aliased edges stay anchored to their own ink color instead of picking up a dark fringe from the fully-transparent background. In `toSvg`, the `viewBox` and recognized-text overlay scale up right along with the raster, and `dpi` (if set) is scaled by the same factor so the physical page size stays put — `upscale` raises pixel density, it doesn't enlarge the page. It's real per-pixel CPU work, worth reserving for an explicit export rather than routine rendering.

### Reading Atelier `.spd` files

`.spd` files, produced by the Supernote Atelier app, are a different format from `.note` files: a SQLite database of image tiles rather than the custom binary layout `SupernoteX` parses. `SupernoteAtelier.open` reads it (via [sql.js](https://github.com/sql-js/sql.js)) and exposes the tiles per surface (layer — surface names vary per file, e.g. `surface_1` or a `surface_9999` "Reference Layer"), plus best-effort decoded metadata (viewport, canvas size, layer names). Its `.spd` schema and `ls` layer encoding aren't officially documented; the reverse-engineered details are noted in [src/atelier.ts](./src/atelier.ts).

- `toImage(surfaceName)` stitches one surface's tiles into a single image, sized and positioned against every surface's tiles in the file so that different layers' images line up and can be composited on top of each other.
- `toCompositeImage(visibleSurfaces?)` flattens surfaces into one final image directly, layered bottom-to-top by `layers` order (best-effort, see `toImage`'s note about `ls`) — the simplest way to get one finished picture out of a `.spd` file without handling individual layers yourself. Defaults to every surface in the file; pass a subset of surface names (e.g. from a layer visibility toggle) to flatten only those.

```ts
import { SupernoteAtelier } from 'supernote-typescript';

const note = await SupernoteAtelier.open(buffer);

// One surface (layer) at a time:
const image = await note.toImage('surface_1');

// Every surface flattened into one final image:
const flattened = await note.toCompositeImage();

// Or just a chosen subset, e.g. hiding a "Reference Layer" background:
const withoutBackground = await note.toCompositeImage(['surface_1', 'surface_2']);
```

#### Bundling for the browser or mobile

`SupernoteAtelier.open`'s second argument is passed straight through to `sql.js`'s `initSqlJs`, so a bundler that can embed the `.wasm` file as bytes (e.g. esbuild's `binary` loader) can hand it over as `wasmBinary`, instead of `sql.js` fetching/reading a sibling `sql-wasm.wasm` file at runtime via `locateFile` — the one thing that would otherwise differ between Node/Electron and a mobile browser runtime:

```ts
// esbuild.config.mjs
loader: { '.wasm': 'binary' }, // resolves a `.wasm` import to a decoded Uint8Array

// your code
import sqlWasmBinary from 'sql.js/dist/sql-wasm.wasm';

const wasmBinary = sqlWasmBinary.buffer.slice(
  sqlWasmBinary.byteOffset,
  sqlWasmBinary.byteOffset + sqlWasmBinary.byteLength,
);
const note = await SupernoteAtelier.open(buffer, { wasmBinary });
```

Used this way in the [Supernote Obsidian Plugin](https://github.com/philips/supernote-obsidian-plugin/pull/137), which runs unmodified on both desktop and mobile.

## Developer Notes

### Test Individual Suite

```
npx jest -t 'manta'
```

### Fixture comparison site

`toSvg({ vectorInk: true })` redraws a page's ink as real vector paths, and
the fixtures under `tests/input/` that ship with Supernote's own PDF export
give an independent answer for what that ink should look like. The site puts
the two side by side, page by page:

```
npm run build:site   # writes site/
```

Both sides are vector ink only — the device keeps its background in a
separate image, so ours has its background raster stripped to match. Each
page is labelled with the ink it lays down as a fraction of the device's,
which is blunt on its own but catches a whole stroke going missing or a tool
drawn at the wrong width.

CI builds it on every pull request and attaches it as a downloadable
artifact; merges to `main` publish it to GitHub Pages
(`.github/workflows/pages.yml`).

New fixtures belong on it. Committing a device PDF export as `<name>.pdf`
beside `<name>.note` is all it takes for the pair to get a page — the build
finds them by name — and `FIXTURE_NOTES` in `scripts/build-fixture-site.ts`
is where that page says what the fixture isolates. See
[`tests/input/README.md`](tests/input/README.md), which catalogues the same
fixtures in more depth.

The per-page ink ratio is a blunt measure by design, and blunt in one
direction worth knowing: it sums each path's area instead of unioning them,
so a page we draw as many overlapping strokes reads high against an export
that merged its ink into a single path. `sticker` page 2 is the standing
example. Read the ratio next to the picture, not instead of it.

The scripts behind it are TypeScript like the rest of the repo, built by
`tsconfig.scripts.json` — so `npm run build:site` type-checks them, and a
type error there fails the build rather than surfacing at runtime.

### Publish

```
npm version patch
npm run build
npm publish
```


## Users

- [Supernote Obsidian Plugin](https://github.com/philips/supernote-obsidian-plugin)
- [Supernote Joplin Plugin](https://github.com/individual-it/supernote-joplin)

## Thank You

- Thank you to [Tiemen Schuijbroek](https://gitlab.com/Tiemen/supernote) for developing the initial supernote Typescript library I forked.
- Heavily inspired by the [Python implementation by jya-dev](https://github.com/jya-dev/supernote-tool). This one currently only supports the X series notebooks.

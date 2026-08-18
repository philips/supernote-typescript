# AGENTS.md — supernote-typescript

> Guidelines for AI assistants and human contributors working on this codebase.

## Project Overview

A TypeScript library for reading Ratta Supernote `.note` and Atelier `.spd` files, rendering pages to images / PDF / SVG, and extracting recognized handwriting (RTR) text. Runs in Node and browsers (uses `image-js`, `pdf-lib`, `sql.js`).

**Important:** The Supernote file format is officially unstable. Expect breakage across firmware versions.

## Build, Test, and Lint

| Task | Command |
|------|---------|
| Build (`lib/`) | `npm run build` (runs `tsc`) |
| Run all tests | `npm test` (vitest run; also builds first via `pretest`) |
| Watch tests | `npm run test-watch` |
| Filter tests by name | `npx vitest run -t "manta"` (replaces the old `jest -t` pattern) |
| Watch filtered tests | `npm run test-mirror` (alias: `vitest --watch -t mirror`) |
| Benchmarks | `npm run bench` |
| Lint | `npm run lint` |
| Format | `npm run prettier-format` |
| Clean artifacts | `npm run clean` |
| Build fixture comparison site | `npm run build:site` (outputs `site/`, type-checked via `tsconfig.scripts.json`) |

**Test framework:** vitest (not jest anymore — README still mentions `npx jest` historically but use vitest).

## Source Layout

```
src/
  index.ts       — public API exports
  parsing.ts     — .note file parser, SupernoteX class
  format.ts      — low-level binary format helpers
  strokes.ts     — stroke decoding, Ratta RLE, layer compositing
  conversion.ts  — toImage, toPdf, toSvg, extractPageRenderData, etc.
  pdf.ts         — PDF creation helpers (pdf-lib)
  svg.ts         — SVG creation helpers
  atelier.ts     — SupernoteAtelier, .spd SQLite tile reader
  mirror.ts      — test helpers / page mirroring
```

`scripts/` holds standalone build scripts (e.g. `build-fixture-site.ts`, `pdf-vector.ts`) compiled by `tsconfig.scripts.json`.

## Key Architectural Concepts

### Rendering pipeline

1. **Parse** `.note` → `SupernoteX` (holds pages, layers, strokes, RTR text).
2. **Extract** per-page render data with `extractPageRenderData(note, pageNumber)` — this is structured-clone-safe and can be sent to a Worker.
3. **Decode** strokes + background → `Image` via `toImage` / `toImage(pageRenderData, [pageNumber])`.
4. **Encode** `encodePng(image)`.
5. **Assemble** into PDF (`createPdfContext` + `addPdfPage`) or SVG (`addSvgPage`).

Only step 3–4 can run in parallel in Workers. PDF assembly (step 5 for PDF) must stay on the main thread because `pdf-lib` objects aren't structured-clone-safe. SVG assembly *can* run in a Worker.

### Render options

| Option | Meaning |
|--------|---------|
| `scale: n` | Integer downsample factor. Decodes *directly* at reduced resolution (`RattaRLEDecoder.decodeAtScale`). Never allocates full-res buffer. Good for thumbnails. |
| `upscale: n` | Bicubic resize *after* decode (any `>= 1`). Premultiplies alpha before resize so edges don't fringe. Good for export quality. Can combine with `scale`. |
| `vectorInk: true` | Redraws ink as vector paths in SVG instead of rasterizing. Used by the fixture comparison site. |

### `.note` vs `.spd`

- `.note`: custom binary format → `SupernoteX`.
- `.spd`: SQLite tile database → `SupernoteAtelier.open(buffer[, sqlJsOptions])`. Surfaces = layers. `toCompositeImage()` flattens all (or a chosen subset of) surfaces.

## Testing Conventions

### Fixtures

Binary `.note` files and corresponding device-exported `.pdf` files live in `tests/input/`.

- Adding a new fixture: drop `<name>.note` + `<name>.pdf` into `tests/input/`.
- Document the fixture in `tests/input/README.md` (catalogue of what each fixture isolates).
- Add it to `FIXTURE_NOTES` in `scripts/build-fixture-site.ts` so the comparison site gets a page.

### Fixture comparison site

`npm run build:site` renders `toSvg({ vectorInk: true })` side-by-side with the device PDF export, page by page. The per-page "ink ratio" is a coarse area-based metric (not unioned), so overlapping strokes from our side read artificially high against merged-device paths — look at the image, not just the number. `sticker` page 2 is the canonical example of this skew.

CI builds the site on PRs as a downloadable artifact; merges to `main` publish to GitHub Pages via `.github/workflows/pages.yml`.

### Smoke tests

`tests/main.test.ts` has quick snippets for basic parsing/rendering. `tests/pdf.test.ts` covers searchable PDF generation. `tests/pdf-worker-roundtrip.test.ts` demonstrates the Worker pipeline.

## Adding New Features

- Write tests in `tests/*.test.ts` using vitest. Use existing fixtures or add new ones.
- Run `npm test` before committing. The pretest hook will rebuild `lib/`.
- If you modify `scripts/`, `npm run build:site` must pass (it type-checks scripts via `tsconfig.scripts.json`).
- Update `CHANGELOG.md` for user-facing changes.

## Code Style

- TypeScript strict mode enabled.
- Prettier config in `.prettierrc`.
- ESM only (`"type": "module"`).
- Prefer exact matches and small diffs when editing existing files.

## Publishing

```bash
npm version patch   # or minor / major
npm run build
npm publish
```

## Dependencies Worth Knowing

| Package | Role |
|---------|------|
| `image-js` | Image decode/encode/compositing (`Image`, `encodePng`) |
| `pdf-lib` + `@pdf-lib/fontkit` | PDF creation and font embedding |
| `sql.js` | In-browser SQLite for `.spd` files |
| `color` | Color parsing/conversion |

## Users & Related Projects

- [Supernote Obsidian Plugin](https://github.com/philips/supernote-obsidian-plugin)
- [Supernote Joplin Plugin](https://github.com/individual-it/supernote-joplin)

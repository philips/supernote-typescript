# Plan: Parse Supernote Digest `.snbak` backups and export highlights to a Readwise CSV

## Context for the implementing agent

This is `supernote-typescript`, a parser/renderer for Ratta Supernote files. Relevant facts already established by inspecting the fixture `tests/input/Supernote_20260829_101821.snbak` (2,124 bytes):

- **A `.snbak` backup is a plain ZIP archive.** Under `backup/DIGEST/` it contains:
  - `knowledge.json` — **the highlights.** This is the authoritative data source; see schema below.
  - `metadata.json` — `{ backupVersion: 1, databaseVersion: 1, knowledgeBasesCount: 0, knowledgeCount: 3, handwriteFilesCount: 0 }`.
  - `knowledge_bases.json` — array of knowledge-base folders (empty `[]` in this fixture).
  - `digest.db` — SQLite. In this fixture it holds **no highlight rows at all**: only `android_metadata` (locale) and `version_info` (id, version=100, create_time). Verified there is no deleted/remnant data in unallocated pages either. Do not build the parser around it; treat `knowledge.json` as the source of truth.
  - `digest.db-journal` (empty), `handwrite/` (empty dir — presumably handwritten digest notes would land here).
  - No ZIP comments or extra fields carrying metadata.
- **Where Title/Author can NOT come from (important design constraint).** The only per-highlight fields in `knowledge.json` are `content`, `commentStr`, timestamps, `sourcePath`, `sourcePage`, `sourceType`, `state`, `dataMD5`, and a `metadata` JSON blob (`source_size`, `document_location_data`, `unique_identifier`). **No title or author field exists anywhere in the backup** — not in `knowledge.json`, not in `knowledge_bases.json` (folder names, and empty here), not in `digest.db`. The fixture's `sourcePath` values happen to look like `"Title - Author.ext"` (`Document/Winnie-the-Pooh - A. A. Milne.epub`), but that is filename coincidence, not a guaranteed format. **Per project decision: the library must NOT derive Title/Author from the filename — it is too risky.** The library exposes `sourcePath` (and a neutral `sourceFileName` basename for join/matching purposes only); anything title/author-shaped comes from one of:
  1. **The source documents themselves** — the files the user actually read on the device. EPUBs carry real metadata in their OPF package (`dc:title`, `dc:creator`); PDFs carry it in the Info dict (`Title`, `Author`). The backup gives us what we need to match: `sourcePath` basename and `source_size`. This is the primary enrichment path (step 4).
  2. **Explicit user input** (CLI flags / API options), or an *opt-in* filename heuristic kept out of the default path entirely (step 5).
- **`knowledge.json` item schema** (3 items in fixture):
  ```json
  {
    "id": 2,
    "content": "Here is Edward Bear, coming downstairs now, bump,bump, bump, ...",
    "commentStr": "",
    "creationTime": 1788013772980,
    "lastModifiedTime": 1788013772980,
    "dataMD5": "8734e6dad8adaba9cacef2c7266b23df",
    "sourcePath": "Document/Winnie-the-Pooh - A. A. Milne.epub",
    "sourcePage": "16",
    "sourceType": 1,
    "state": 2,
    "serviceId": 0,
    "knowledgeBaseUniqueAttribute": "",
    "pendingSync": false, "syncLock": false, "syncState": 0,
    "metadata": "{\"document_location_data\":\"[{\\\"chapter\\\":10,\\\"endPosition\\\":201,\\\"page\\\":0,\\\"startPosition\\\":91}]\",\"source_size\":185672427,\"unique_identifier\":\"a1bc40d24d521afb05754417af4f4396\"}"
  }
  ```
  Note the double-JSON encoding: `metadata` is a JSON **string** whose `document_location_data` value is *itself* a JSON string containing an array of `{chapter, endPosition, page, startPosition}` objects. Fixture has one location entry per highlight.
- **`sourcePath` shapes seen in the fixture** (all `sourceType: 1` = document): `Document/Winnie-the-Pooh - A. A. Milne.epub`, `Document/Books/Fiction-Classics/Fables - Aesop.epub`, `Document/The_Boy_and_the_Tape.pdf`. No format guarantee — treat as an opaque path.
- **Readwise CSV import spec** (from https://readwise.io/import_faq): header row required, column order irrelevant. Columns: `Highlight` (mandatory), `Title`, `Author`, `URL`, `Note`, `Location` (must be an integer; defaults to file order if absent), `Date` (format `YEAR-MONTH-DAY HOUR:MINUTE:SECOND`, interpreted as **UTC**, time optional). Title/Author being empty is acceptable to Readwise; highlights then group under the import/book name Readwise assigns, which is why the enrichment path in step 4 matters for a good result.
- **Repo conventions**: ESM-only, TS strict, vitest, `src/` modules exported via `src/index.ts`, `SupernoteAtelier.open(buffer, sqlJsConfig?)` is the existing "open a container file" precedent (`src/atelier.ts`). No ZIP library is currently a dependency; `sql.js` and `pdf-lib` are existing runtime deps. Prettier uses tabs (match existing files).

## Goal

1. **Library** (`src/digest.ts`): parse a `.snbak` Digest backup into a typed `SupernoteDigest` object exposing highlights with their raw source-document references — no title/author inference.
2. **Readwise mapping** (`src/readwise.ts`): convert highlights to Readwise CSV rows and serialize to RFC-4180-correct CSV text. Title/Author default to empty.
3. **Document metadata enrichment** (`src/document-meta.ts`): optionally read real Title/Author from the user's local copies of the source documents (EPUB/PDF), matched to highlights by filename/size.
4. **CLI** (`src/cli.ts`, published via `bin`): `supernote-digest <file.snbak> -o out.csv`, with opt-in enrichment and opt-in filename heuristics.
5. **Tests** covering the fixture end-to-end, CSV escaping, date formatting, and the enrichment matching.

## Step-by-step plan

1. **Add the ZIP dependency.** Add [`fflate`](https://www.npmjs.com/package/fflate) as a runtime dependency — tiny, isomorphic (Node + browser, matching this repo's dual-target claim), and its `unzipSync` handles the archive in one call. It will also be reused for EPUB parsing in step 3. (`jszip` would also work but is much heavier; avoid Node-only libs since `src/atelier.ts` already targets browsers too.)

2. **New module `src/digest.ts`** — parsing, modeled on `SupernoteAtelier`:
   ```ts
   export interface IDigestLocation {
       chapter: number;
       page: number;
       startPosition: number;
       endPosition: number;
   }

   export interface IDigestHighlight {
       id: number;
       /** Highlight text, trimmed. */
       content: string;
       /** User note attached to the highlight (may be empty). */
       note: string;
       creationTime: number;      // epoch ms
       lastModifiedTime: number;  // epoch ms
       /** On-device path of the source document, e.g. "Document/Foo - Bar.epub". Opaque — do NOT parse meaning out of it. */
       sourcePath: string;
       /** Last segment of sourcePath, e.g. "Foo - Bar.epub". A neutral join key
        * for matching local files (see src/document-meta.ts) — NOT a title. */
       sourceFileName: string;
       /** Size of the source document in bytes, when the backup recorded it. */
       sourceSize?: number;
       /** Opaque content hash the device stores for the source document. */
       uniqueIdentifier?: string;
       /** sourcePage parsed to a number; undefined when absent/non-numeric. */
       sourcePage?: number;
       /** Parsed from metadata.document_location_data; [] when absent. */
       locations: IDigestLocation[];
       /** The full parsed metadata object (minus the fields hoisted above). */
       metadata: Record<string, unknown>;
       dataMD5: string;
       sourceType: number;
       state: number;
   }

   export interface IDigestMetadata {
       backupVersion: number;
       databaseVersion: number;
       knowledgeBasesCount: number;
       knowledgeCount: number;
       handwriteFilesCount: number;
   }

   export class SupernoteDigest {
       declare backup: IDigestMetadata;
       declare knowledgeBases: unknown[];
       declare highlights: IDigestHighlight[];

       private constructor() {}
       /** Parse a .snbak backup's contents (the raw ZIP bytes). */
       static open(buffer: Uint8Array): SupernoteDigest;
   }
   ```
   Implementation notes:
   - `unzipSync(buffer)`, then read `backup/DIGEST/knowledge.json`, `metadata.json`, `knowledge_bases.json` by key. Fail with a clear error if `knowledge.json` is missing (i.e. not a Digest backup).
   - `sourceFileName` is a pure `sourcePath.split('/').pop()` — a path fact, not an interpretation. No ` - ` splitting, no underscore→space rewriting anywhere in the library.
   - Parse `metadata` and the nested `document_location_data` defensively (`try/catch` → `{}` / `[]`); never let a malformed entry throw for the whole file.
   - Keep it synchronous — `unzipSync` is fast for these small archives and there's no async work at all.

3. **New module `src/readwise.ts`** — mapping + CSV:
   ```ts
   export interface IReadwiseRow {
       highlight: string;
       title?: string;
       author?: string;
       url?: string;
       note?: string;
       location?: number;
       date?: string; // "YYYY-MM-DD HH:MM:SS", UTC
   }

   export interface IReadwiseExportOptions {
       /** Override/augment Title and Author per highlight (e.g. from
        * document-meta enrichment). Return undefined to omit the column. */
       title?: (h: IDigestHighlight) => string | undefined;
       author?: (h: IDigestHighlight) => string | undefined;
       /** Which integer to use for Location. Default 'page'. */
       location?: 'page' | 'position';
   }

   export function highlightToReadwiseRow(h: IDigestHighlight, options?: IReadwiseExportOptions): IReadwiseRow;
   export function digestToReadwiseRows(d: SupernoteDigest, options?: IReadwiseExportOptions): IReadwiseRow[];
   export function toReadwiseCsv(rows: IReadwiseRow[]): string;
   export function formatReadwiseDate(epochMs: number): string; // exposed for tests
   ```
   Mapping decisions:
   - `Highlight` ← `content` (trim; skip-and-warn on empty — Readwise requires it).
   - `Title` / `Author` ← **omitted by default.** Populated only via the `title`/`author` option callbacks (fed by enrichment or user data). The library never invents them from `sourcePath`.
   - `URL` ← omitted; digest data carries no source URL.
   - `Note` ← `commentStr` (omit when empty). Readwise supports inline tags here; pass through untouched.
   - `Location` ← `sourcePage` (integer, per Readwise's requirement). `'position'` mode uses the first `startPosition` from `document_location_data` (a character offset) when available. The fixture already exercises the comma-quoting need — `"bump,bump, bump"` contains commas.
   - `Date` ← `creationTime` formatted in **UTC** (`toISOString().replace('T', ' ').slice(0, 19)`-style), since Readwise interprets the column as UTC.
   - CSV serialization: emit columns `Highlight,Title,Author,URL,Note,Location,Date`; RFC 4180 quoting (quote fields containing `,` `"` `\n`/`\r`, doubling embedded quotes). End with trailing newline.

4. **New module `src/document-meta.ts`** — the *right* source of Title/Author: the documents themselves. The user read these on their Supernote, so they have (or can re-obtain) the files; the backup's `sourcePath`/`sourceSize` give us the match keys.
   ```ts
   export interface IDocumentMetadata {
       title?: string;
       author?: string;
       /** filename + byte size they were read from, for diagnostics */
       fileName: string;
       fileSize: number;
   }

   /** Read title/author from an EPUB (META-INF/container.xml → OPF dc:title/dc:creator). */
   export function readEpubMetadata(buffer: Uint8Array): IDocumentMetadata; // uses fflate
   /** Read title/author from a PDF Info dict via pdf-lib's getTitle()/getAuthor(). */
   export function readPdfMetadata(buffer: Uint8Array): Promise<IDocumentMetadata>; // pdf-lib is already a dependency
   /** Walk a local directory, index files by lowercase basename (and size),
    * and resolve each highlight's sourceFileName to real metadata where a
    * match exists. Size mismatch on basename match → skip with a warning,
    * never guess. */
   export async function enrichWithDocumentMetadata(
       highlights: IDigestHighlight[],
       dir: string,
   ): Promise<Map<number, IDocumentMetadata>>;
   ```
   - EPUB parsing is ~40 lines with `unzipSync` + DOMParser-free regex/`xml-js`-free OPF extraction (read `container.xml` for the rootfile path, then `dc:title`/`dc:creator` from the OPF XML with a small regex — metadata XML here is simple and machine-generated; guard with try/catch).
   - PDF side: `PDFDocument.load(bytes, { ignoreEncryption: true })`, `getTitle()`/`getAuthor()`. Missing Info dict → undefined fields, not an error.
   - Return a Map keyed by highlight `id` rather than mutating highlights — keeps the core parse pure and the enrichment explicitly opt-in.
   - **Matching rule (deliberately conservative):** lowercase-basename equality plus byte-size equality against `sourceSize` when the backup recorded it. If sizes mismatch or `sourceSize` is absent, still accept a unique basename match but emit a warning. Never match on fuzzy name similarity.

5. **New CLI `src/cli.ts`**:
   - Shebang `#!/usr/bin/env node`, hand-rolled arg parsing (no new deps).
   ```
   supernote-digest <file.snbak> [-o out.csv] [--from-documents <dir>]
                     [--title-from-filename] [--location page|position] [--stdout]
   ```
   - Default: no `Title`/`Author` columns content (empty), exactly like the library.
   - `--from-documents <dir>`: run the step-4 enrichment and fill Title/Author from real document metadata where matched. Recommended path; call it out in `--help`.
   - `--title-from-filename`: **opt-in only** heuristic that parses the trailing ` - Author` out of `sourceFileName` (last occurrence; underscores → spaces). Documented in `--help` as unreliable and off by default. Implemented in the CLI, not the library, so the library's output stays honest.
   - Read the file with `fs/promises`, build rows via the library, write CSV to the `-o` path or stdout.
   - Exit non-zero with a usage message on missing/invalid args; friendly error when the input isn't a ZIP/Digest backup.
   - `package.json`: add `"bin": { "supernote-digest": "./lib/cli.js" }`.

6. **Export from `src/index.ts`**: `SupernoteDigest` + the `IDigest*` types from `digest.js`; `IReadwiseRow`, `IReadwiseExportOptions`, `toReadwiseCsv`, `digestToReadwiseRows` from `readwise.js`; `readEpubMetadata`, `readPdfMetadata`, `enrichWithDocumentMetadata`, `IDocumentMetadata` from `document-meta.js`. The CLI stays out of the public API surface (consumed via `bin`).

7. **Tests** (`tests/digest.test.ts`, `tests/readwise.test.ts`, `tests/document-meta.test.ts`):
   - **Parse**: open the fixture; assert 3 highlights; assert per-item content matches `knowledge.json` exactly (including the trailing space in `" The ice is breaking."` — decide trim behavior and pin it in the test); assert `sourceFileName` passthrough (`Winnie-the-Pooh - A. A. Milne.epub` etc. **verbatim**, no splitting); assert `sourceSize`/`uniqueIdentifier` hoisting; assert `sourcePage` 26/16/9; assert parsed location arrays (chapter 0/10/4).
   - **No-inference regression guard**: assert `digestToReadwiseRows` output has no `title`/`author` fields for the fixture — this is the test that keeps the risky heuristic out of the library.
   - **CSV**: golden-string test for the full fixture export — header row, 3 data rows, comma-containing highlight properly quoted, Title/Author columns present but empty. Escaping unit cases: embedded `"`, newline, comma. Exact date assertions: `formatReadwiseDate(1788013772980)` → `'2026-08-29 14:29:32'` and `formatReadwiseDate(1762791523693)` → `'2025-11-10 16:18:43'`.
   - **Enrichment**: build a tiny synthetic EPUB (zip with `mimetype`, `META-INF/container.xml`, OPF with `dc:title`/`dc:creator`) in-test and a tiny PDF via pdf-lib with `setTitle`/`setAuthor` (pattern already used in `tests/pdf.test.ts`); assert `readEpubMetadata`/`readPdfMetadata` extract both fields; assert `enrichWithDocumentMetadata` matches by basename+size, warns and skips on size mismatch, and leaves unmatched highlights unresolved. Put a copy of the fixture-adjacent synthetic doc under a temp dir; do not commit binary fixtures for this (or commit a tiny synthetic one under `tests/input/` if the team prefers — see Open Questions).
   - **CLI end-to-end**: spawn `node lib/cli.js tests/input/Supernote_20260829_101821.snbak -o tests/output/readwise.csv` via `child_process`, read it back, assert it equals `toReadwiseCsv(digestToReadwiseRows(digest))`; also `--stdout` mode, missing-arg exit code, and a `--title-from-filename` run showing the opt-in heuristic only affects that mode. (`tests/output/` already exists for artifacts; `npm run clean` only globs image/pdf/svg extensions — add `tests/output/*.csv` to `clean`.)
   - Error path: feeding a non-ZIP file (e.g. a `.note` fixture) produces a clean error, not a stack trace.

8. **Docs & housekeeping**:
   - Document the fixture in `tests/input/README.md`. Note: it intentionally does **not** follow the `{purpose}-{device}-{version}-{description}.note` convention (that's for `.note` files; this is a device backup of the Digest app) — say so in the entry. The fixture comparison site renders `.note` pages only, so this fixture does **not** get a `FIXTURE_NOTES` entry in `scripts/build-fixture-site.ts`; add a one-line note in the README explaining why it's exempt.
   - README: short usage snippet (library + CLI) near the existing `toImage` example, explicitly noting that Title/Author come from `--from-documents` enrichment (or opt-in heuristics), never from the filename by default, and why.
   - `CHANGELOG.md`: user-facing feature entry.
   - `npm test` (which pre-builds) and `npm run lint` must pass.

## Non-goals

- **No title/author derivation from `sourcePath` in the library.** The `sourceFileName` is exposed as a join key only. This is a hard requirement (filenames are frequently unstructured; `" - "` and `_`-for-space conventions are device coincidences, not format guarantees).
- **No `digest.db` parsing.** In the inspected fixture it contains no highlight data (verified down to unallocated pages); if a future backup moves data there, extend `SupernoteDigest` then (the repo already ships `sql.js` for exactly this kind of follow-up).
- No Readwise **API** upload (this is CSV-only; Readwise's importer is at https://readwise.io/import). The CSV column set is deliberately exactly what Readwise documents — no extra columns.
- No handwritten-digest (`handwrite/`) extraction.
- No rename of the existing fixture to match the `.note` naming convention (renaming would break provenance of a real device backup).

## Open questions the implementing agent should resolve early, not assume

- **Trim semantics for `content`.** Item 1 in the fixture starts with a leading space (`" The ice is breaking."`). Plan assumes trim on export (nicer for Readwise) while the parsed object keeps the raw string. Verify the device never *needs* the leading/trailing whitespace.
- **`unique_identifier` semantics.** It looks like an MD5 of the source document, which would make it the most robust match key for `--from-documents` — but that can't be confirmed without the actual documents from this backup. Basename+size matching is the safe default; if the user can supply a real document whose MD5 equals its `unique_identifier`, upgrade matching to prefer the hash.
- **`Location` semantics.** `sourcePage` is the on-screen page the user was reading (26/16/9); `startPosition` looks like a character offset within the chapter. Default of page is chosen because it's an integer, always present, and human-meaningful; confirm Readwise renders it acceptably before locking it in.
- **`--title-from-filename` edge cases.** The last-`" - "` rule handles `Foo - Bar - Baz`, but an unauthored title that itself contains `" - "` (e.g. `Portfolio - 2026.pdf`) would be misread as author `2026`. If that bites, add a heuristic (right side must contain a letter) behind the same CLI helper rather than complicating the default.
- **Multiple location entries.** The fixture has exactly one entry per highlight; if a highlight can span ranges, decide whether to emit one CSV row per range or join with `...`. Current plan: first entry only, documented.
- **Synthetic vs real enrichment fixtures.** In-test synthetic EPUB/PDF keep the repo small, but a real device-read EPUB would prove the OPF extraction against messy publisher metadata. Decide based on how gnarly the regex extraction feels against a real-world EPUB (e.g. one from Project Gutenberg / Standard Ebooks).

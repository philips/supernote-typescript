# Ola Ink SVG scene format, version 1

This is the practical file-format spec for the SVGs produced by:

```ts
const pages = await toSvg(note, {
  vectorInk: true,
  embedScene: true,
  documentId: myDocumentId,
});
```

The short version: each file is still a normal, standalone SVG page. It shows
the finished page in a browser, but also carries enough metadata and hidden
centerlines for Ola Ink to replay the handwriting on a native Android Canvas.
There is no sidecar scene file.

This describes **version 1** as emitted by `src/svg.ts` and
`src/svg-scene.ts`. The grammar is intentionally small because the native
consumer is not a general SVG renderer.

## One file per page

SVG has no useful multi-page container here, so an export returns one `.svg`
file per page. Pages are grouped by attributes on the root element, not by
filename:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:oi="https://olaink.com/ns/vector-scene/1"
     oi:scene-version="1"
     oi:document-id="notebook-from-my-library"
     oi:page-index="0"
     oi:page-count="3"
     width="1920"
     height="2560"
     viewBox="0 0 1920 2560">
  ...
</svg>
```

The `oi:` root attributes mean:

| Attribute | Meaning |
|---|---|
| `oi:scene-version` | Profile version. Exactly `1` for this spec. |
| `oi:document-id` | Caller-owned grouping key shared by every page from one logical document. |
| `oi:page-index` | Original page position in the note, zero-based. |
| `oi:page-count` | Total pages in the original note, not merely the number selected for this export. |

`page-index` still refers to the original note when pages are exported out of
order or as a subset.

### Important: `document-id` is caller-owned

Do not derive document identity from Supernote's `header.FILE_ID`. Copied notes
can reuse that ID. The fixture corpus even has two differently named documents
that are byte-identical, so hashing file contents cannot separate every logical
copy either.

For that reason, `toSvg(..., { embedScene: true })` requires the caller to pass
`documentId`. Use a database/library ID, canonical path, or filename—whatever
is actually unique in the caller's collection. The exporter throws rather than
silently emit a grouping key that may merge unrelated documents.

Filenames such as `thing-page-2-embed-scene.svg` are convenient for humans but
have no meaning in the format.

## Overall document layout

The producer currently writes content in roughly this order:

1. optional SVG `<defs>` for ordinary static artwork such as hatch patterns;
2. the `oi-scene` metadata, when the page has vector scene records;
3. the base page/background PNG;
4. visible final vector ink and static vector objects;
5. an optional raster-only ink overlay;
6. optional invisible OCR `<text>` elements;
7. hidden centerline paths used for replay.

Consumers should not depend on that literal XML order except where normal SVG
painting semantics matter. Use IDs and the metadata references.

A normal page looks roughly like this:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:oi="https://olaink.com/ns/vector-scene/1"
     oi:scene-version="1"
     oi:document-id="note-123"
     oi:page-index="0"
     oi:page-count="1"
     viewBox="0 0 1920 2560">

  <metadata id="oi-scene"
            type="application/vnd.olaink.vector-scene+json">
    {"version":1,"strokes":[{"id":"s12","writeOrder":12,"zOrder":4,"centerline":"s12-line","contour":"s12-fill"}]}
  </metadata>

  <image data-page-background="true"
         x="0" y="0" width="1920" height="2560"
         xlink:href="data:image/png;base64,..."/>

  <path d="M10.00,20.00 L11.00,21.00 L12.00,20.00 Z"
        fill="rgb(0,0,0)"
        id="s12-fill"
        oi:role="final-contour"/>

  <text x="100" y="200" fill="transparent">searchable OCR</text>

  <path id="s12-line"
        fill="none"
        stroke="rgb(0,0,0)"
        stroke-width="4"
        stroke-linecap="round"
        stroke-linejoin="round"
        visibility="hidden"
        oi:role="centerline"
        d="M10.00,20.00 L11.00,21.00 L12.00,20.00"/>
</svg>
```

Attribute order and whitespace are not significant.

## The metadata block

Scene JSON lives in exactly one SVG metadata element:

```xml
<metadata id="oi-scene"
          type="application/vnd.olaink.vector-scene+json">
  { ...JSON... }
</metadata>
```

The JSON text is normal XML character data, not CDATA. An XML parser resolves
entities before the JSON parser sees it.

The version 1 shape is:

```ts
interface OiVectorSceneV1 {
  version: 1;
  strokes: Array<{
    id: string;
    writeOrder: number;
    zOrder: number;
    centerline?: string;
    contour: string;
    t0Ms?: number;
    durationMs?: number;
  }>;
}
```

A raster-fallback or fully blank page may have the versioned root/page
attributes but no `oi-scene` metadata at all. That means “display the static
page; there is nothing to replay,” not a malformed scene.

### `id`

A stable ID for this record within the page. The current producer uses
`s${writeOrder}`, but consumers should treat it as opaque. IDs only need to be
unique inside one SVG page.

### `writeOrder`

The zero-based index of the original record in Supernote's raw `TOTALPATH`
array. It is the closest thing the source has to pen-down order.

Gaps are normal. Lasso paths, link UI records, fully removed ink, and other
non-rendered records may occupy raw positions but do not become scene strokes.
Sort numerically; do not assume `writeOrder === strokes array index`.

### `zOrder`

The final paint position after the exporter has applied its compositing rules:
heading backgrounds first, light highlighters beneath darker writing, cover-up
strokes above what they cover, and so on.

`zOrder` values are unique for emitted final primitives. They are usually
contiguous for path records, but may start above zero or contain gaps when a
normal static primitive such as a heading rectangle occupies a paint position.
Use numeric ordering rather than treating the JSON array index as z-order.

The two orders answer different questions:

- `writeOrder`: when should this stroke be replayed?
- `zOrder`: where does it belong in the final composite?

### `centerline`

Optional XML ID of the real sampled pen path, without a leading `#`.

When present, it references a path with `oi:role="centerline"`. This path is
hidden in normal SVG rendering but is the geometry to reveal progressively
while writing.

When absent, the source had final geometry but no recoverable write path. This
happens for point-less contour fragments produced by partial erasing. The
native fallback is to fade in the referenced final contour. Do not reject the
record and do not try to invent a centerline.

The exporter never writes `centerline: ""`, never references an empty path,
and never emits `d=""`.

### `contour`

Required XML ID of the visible final path, again without `#`.

“Contour” is the historical field name. It normally points to a filled device
outline, but it can also point to the existing stroked-polyline fallback when
the source had a centerline and no usable outline. Always honor the referenced
path's actual SVG paint attributes; do not assume every `contour` should be
filled.

### `t0Ms` and `durationMs`

Optional, finite, non-negative timing values in milliseconds:

- `t0Ms` is relative to the beginning of this page's replay;
- `durationMs` is the stroke's write duration.

Use them when present. If either is absent, use the consumer's normal path
length/speed heuristic for the missing value.

The current `TOTALPATH` decoder cannot reliably map MyScript `ink.bink` timing
records back to every rendered stroke, so ordinary exports usually omit these
fields. The schema is ready to carry real timing when that mapping becomes
available; the exporter does not make timing up.

## Referenced path roles

Version 1 defines three roles.

### `oi:role="final-contour"`

The ordinary finished appearance of a stroke. It is visible in a browser.
Common forms are:

```xml
<path id="s2-fill"
      oi:role="final-contour"
      fill="rgb(0,0,0)"
      d="M... L... Z"/>
```

or the no-outline fallback:

```xml
<path id="s2-fill"
      oi:role="final-contour"
      fill="none"
      stroke="rgb(0,0,0)"
      stroke-width="4"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M... L..."/>
```

That second case is why a consumer must not blindly close and fill every final
path.

### `oi:role="erase-cover"`

A real eraser-tool motion represented as a white cover stroke or contour:

```xml
<path id="s18-fill"
      oi:role="erase-cover"
      fill="none"
      stroke="rgb(255,255,255)"
      stroke-width="18"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M... L..."/>
```

Keep the white SVG paint: that is what makes plain browser rendering correct.
Native renderers should also treat this role as a cover/composite operation.
In particular, do not reinterpret an open, `fill="none"` erase path as a
closed black fill—the result is a giant blob.

A normal white pen is still ordinary ink and may remain `final-contour`.
`erase-cover` specifically means the source record was an eraser-tool record.

### `oi:role="centerline"`

The hidden write geometry:

```xml
<path id="s2-line"
      oi:role="centerline"
      visibility="hidden"
      fill="none"
      stroke="rgb(0,0,0)"
      stroke-width="4"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M... L..."/>
```

Browsers obey `visibility="hidden"`. The native player resolves the path by ID
and uses it as animation input despite that presentation attribute.

## Frozen version 1 path grammar

Profile-referenced paths use a deliberately boring subset of SVG path data:

```text
path      = subpath, { " ", subpath };
subpath   = move, { " ", line }, [ " Z" ];
move      = "M", coordinate;
line      = "L", coordinate;
coordinate = number, ",", number;
number    = [ "-" ], digits, ".", digit, digit;
```

In practical terms:

- commands are uppercase absolute `M`, `L`, and `Z` only;
- coordinates are finite decimals with exactly two fractional digits;
- coordinates use a comma between x and y;
- commands/subpaths are separated by one space in producer output;
- a contour may contain several closed `M ... Z` rings;
- a centerline is open and uses `M ... L ...`;
- there are no transforms on referenced paths;
- there are no relative commands, arcs, Beziers, shorthand commands,
  exponents, implicit repeated coordinates, or path-level transforms.

This subset is frozen for version 1. Adding `transform`, curves, arcs, relative
commands, or another path syntax requires a profile version bump.

The surrounding static SVG may contain unrelated standard SVG features—for
example a hatch `<pattern patternTransform="rotate(45)">`. That does not expand
the grammar of paths referenced by `oi-scene`.

## Paint attributes and colors

Ink colors are emitted as CSS `rgb(r,g,b)` strings, generally Supernote's grey
palette. Profile paths use only the attributes needed by their actual shape:

- filled final path: `fill`;
- stroked final path: `fill="none"`, `stroke`, `stroke-width`, round cap/join;
- centerline: the same stroked attributes plus `visibility="hidden"`;
- all profile paths: `id`, `d`, and `oi:role`.

`stroke-width` is in the same user-space units as the `viewBox`. A consumer
should parse it as a finite non-negative number.

Do not substitute black merely because `fill="none"`. The `stroke` attribute
is the paint source for an open stroked path.

## Static page content

The animation profile is an addition to a regular finished SVG, not a
replacement for it.

### Background image

The base page is an embedded PNG data URI:

```xml
<image data-page-background="true"
       x="0" y="0"
       width="1920" height="2560"
       xlink:href="data:image/png;base64,..."/>
```

It contains templates, PDF backgrounds, or the full raster fallback when a
page could not be vectorized.

### Raster ink overlay

Text boxes, Digests, and a few typeset labels have no `TOTALPATH` equivalent.
When needed they appear in a second transparent PNG after vector ink:

```xml
<image data-raster-ink-overlay="true" .../>
```

Its document position is intentional: it paints over vector highlighters just
as the source page does.

### OCR text

Searchable handwriting recognition remains ordinary invisible SVG text:

```xml
<text x="..." y="..."
      font-size="..."
      textLength="..."
      lengthAdjust="spacingAndGlyphs"
      fill="transparent">word</text>
```

It should not affect native ink playback. A static SVG viewer may use it for
search, selection, and copying.

### Static non-scene vector objects

Heading rectangles, hatch backgrounds, and similar objects can remain normal
`<rect>`, `<pattern>`, or unreferenced SVG geometry. They are not assigned fake
centerlines. A consumer that only animates metadata strokes should preserve
such static geometry in the final display where supported.

## Suggested native playback

A straightforward player can do this:

1. Parse XML securely and read the root `viewBox` and `oi:` attributes.
2. Reject any `oi:scene-version` other than `1`.
3. Group pages by the caller-provided `document-id`; order by `page-index`.
4. Draw/decode the background PNG and any supported static content.
5. If `oi-scene` is absent, stop: this is a static/raster fallback page.
6. Parse JSON and require `version === 1` as well.
7. Resolve every `contour` and optional `centerline` ID exactly once.
8. Schedule strokes by real timing when present, otherwise by `writeOrder`
   and the length heuristic.
9. Reveal a centerline progressively, then replace it with its final contour.
   Fade the final contour when `centerline` is absent.
10. Composite completed/current geometry by numeric `zOrder`.
11. Treat `erase-cover` as a cover while preserving its white paint.

On the Nomad, Android's global `animator_duration_scale` is zero, so
`ValueAnimator` completes immediately. Use a monotonic clock with
`Handler.postDelayed` or `View.postDelayed`, and cancel callbacks when the view
is detached.

## Parser validation and safety

The native parser should be strict about profile data even if it is more
forgiving about unrelated static SVG:

- disable DTD and external entity processing;
- require the exact namespace, root version, metadata ID, and MIME type;
- require JSON `version` to match the root version;
- reject unknown JSON keys and unknown `oi:role` values in v1;
- reject duplicate IDs, missing references, and role/reference mismatches;
- reject non-integer or negative order/page values;
- require `0 <= page-index < page-count`;
- reject non-finite/negative timing and stroke widths;
- parse referenced `d` using only the frozen grammar above;
- reject empty path data rather than handing it to Android `Path` code;
- allow only embedded base64 PNG image URLs for this producer profile;
- enforce practical limits on XML/JSON bytes, image bytes, stroke count,
  points per path, total points, and page dimensions.

Do not execute CSS, SMIL, scripts, event handlers, external URLs, or runtime
animation from the SVG. Version 1 does not use any of them.

## Compatibility rules

A producer may add ordinary static SVG content without changing the profile
version, provided profile references and final rendering keep their meaning.

A version bump is required for changes such as:

- new animation JSON keys that affect behavior;
- new profile roles;
- a different order/timing interpretation;
- relative/curved/arc path commands;
- transforms on referenced geometry;
- external resources or a different image encoding;
- changing the missing-centerline or erase-cover semantics.

Consumers should refuse unknown versions instead of guessing.

## Regression corpus

Tests generate one `*-embed-scene.svg` artifact per fixture page under
`tests/output/`. The current corpus is 68 pages across 27 caller-owned document
IDs. Keep at least these families in native replay coverage:

- eraser and white-pen cover-ups;
- light highlighters and dark marker-over-ink cases;
- calligraphy at several widths;
- landscape pages;
- contour-only partial-erase fragments;
- raster-only/background-only fallback pages;
- copied notes that reuse the same internal `FILE_ID`.

Those files have already been useful as device regressions, so new fixtures
should automatically produce another scene artifact rather than relying on a
small hand-picked sample.

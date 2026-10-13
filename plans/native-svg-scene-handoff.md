# Native SVG-scene handoff for `supernote-typescript`

This is the implementation handoff for the non-WebView Ola Ink plugin
research. The standalone, consumer-facing version 1 format is specified in
[`plans/ola-ink-svg-scene-v1.md`](ola-ink-svg-scene-v1.md).

## Device result and hard constraint

The Nomad PluginHost cannot construct `WebView`. A native Canvas `ViewManager`
*can* display an animated vector-path probe. The device has Android's global
`animator_duration_scale=0`, so `ValueAnimator` completes immediately; native
playback must use an explicit `View.postDelayed`/`Handler` frame scheduler.

### One-file embedded SVG profile

A separate scene file is not required. Keep the final static page as ordinary
SVG and embed a small, versioned Supernote animation profile in that same SVG.
Browsers that do not know the profile still render the final contours; the
native renderer reads only the documented metadata and referenced elements.
For example:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:oi="https://olaink.com/ns/vector-scene/1"
     viewBox="0 0 1920 2560" oi:scene-version="1"
     oi:document-id="F…" oi:page-index="0" oi:page-count="3">
  <metadata id="oi-scene" type="application/vnd.olaink.vector-scene+json">
    {"version":1,"strokes":[{"id":"s12","writeOrder":12,"zOrder":4,
      "centerline":"s12-line","contour":"s12-fill"}]}
  </metadata>
  <!-- Normal static SVG: the browser displays this final contour. -->
  <path id="s12-fill" fill="#111" d="M…Z" oi:role="final-contour"/>
  <!-- Hidden static/debug geometry; native uses it only while writing. -->
  <path id="s12-line" fill="none" stroke="#111" d="M…L…"
        visibility="hidden" oi:role="centerline"/>
</svg>
```

Use standard SVG only for the final visual geometry. Put write order, z-order,
roles, and optional timing hints in `<metadata>`/the `oi:` namespace; do not
encode runtime behavior with CSS, SMIL, or scripts. The native parser must
allow only this constrained profile (root/viewBox, metadata JSON, known path
attributes, and the approved path grammar), reject unknown animation data, and
render with Canvas. This is still a schema, but it is one self-contained,
forward-versioned SVG artifact rather than another file to pair or migrate.

The profile cannot recover information that the source SVG never contained.
For example, adding metadata after the fact to a contour-only SVG cannot
produce its missing real centreline or `TOTALPATH` write order; the
supernote-typescript exporter must embed those while it still has the decoded
stroke records.

## Version 1 exporter contract

The profile is opt-in through:

```ts
await toSvg(note, {
  vectorInk: true,
  embedScene: true,
  documentId: fileNameWithoutExtension,
});
```

`embedScene` requires `vectorInk` because the raster SVG path has no decoded
stroke records to hand off. Every requested page carries the versioned root
page identity. A page that cannot be vectorized keeps the normal raster
fallback and simply carries no `oi-scene` metadata.

The root markers are exactly:

- namespace `https://olaink.com/ns/vector-scene/1` bound to `oi`;
- `oi:scene-version="1"`;
- `oi:document-id`, zero-based `oi:page-index`, and `oi:page-count`;
- metadata ID `oi-scene`;
- metadata MIME type `application/vnd.olaink.vector-scene+json`.

The decoded JSON has this TypeScript shape:

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

Both orders are zero-based. `writeOrder` is the record's index in the raw
`TOTALPATH` array, so gaps are expected where non-ink records were filtered.
`zOrder` is the dense final vector primitive paint index after fully erased
records have been dropped and the existing Heading-background/highlighter
compositing rules have been applied.

`document-id` is a required caller-owned grouping key. The exporter cannot
safely derive one: copied notes in the fixture corpus reuse `header.FILE_ID`,
and two differently named notes can even be byte-identical. Callers should use
their own library/database ID or canonical filename. `toSvg` rejects
`embedScene: true` without `documentId`, rather than emitting a key that may
silently merge documents. `page-index` is the page's original zero-based
position in the note even when `pageNumbers` exports pages out of order.

`centerline` and `contour` are XML IDs, without a leading `#`. The centerline,
when present, is the real sampled `TOTALPATH` polyline and is hidden from
ordinary SVG rendering with `visibility="hidden"`. The contour reference names
the visible final path. Normally that path is the device's filled outline;
when a usable outline was not stored, it is the existing round-capped
stroked-polyline fallback. Native playback progressively draws `centerline`,
then replaces it with `contour` while retaining `zOrder`.

A missing `centerline` is intentional: the record has real final geometry but
its source contained no write path (notably point-less partial-erase
fragments). Native renderers must fade in the referenced `contour`. The
exporter never emits an empty centerline reference or an empty `d`; it does not
invent geometry. Heading rectangles remain normal static SVG geometry.
Raster-only text boxes, Digests, templates, and page backgrounds likewise
remain ordinary SVG image elements rather than animation records.

Actual eraser-tool records keep their white SVG stroke/fill so browsers render
them as before, but their final element carries `oi:role="erase-cover"` rather
than `final-contour`. A native renderer must composite that geometry as a cover,
never reinterpret it as a black filled contour.

`t0Ms` and `durationMs` are optional non-negative real timing values in
milliseconds. `t0Ms` is relative to the start of the page replay. They are
emitted only when the decoded stroke exposes source timing; no value is
synthesized. The current `TOTALPATH` decoder cannot yet map MyScript
`ink.bink` timing records back to every rendered stroke, so normal fixture
exports omit them and consumers use their length heuristic.

### Constrained path and attribute profile

Profile-referenced paths emitted by this exporter use only:

- absolute `M x,y` and `L x,y` commands;
- `Z` for closed contour rings;
- finite decimal coordinates with two fractional digits;
- `id`, `d`, `fill`, `stroke`, `stroke-width`, `stroke-linecap`,
  `stroke-linejoin`, `visibility`, and `oi:role` attributes;
- roles `final-contour`, `erase-cover`, and `centerline`.

This grammar is frozen for version 1. Profile-referenced elements never use
transforms, relative commands, curves, or arcs. Adding any of those requires a
profile version bump. The exporter does not emit CSS, SMIL, scripts, event
handlers, runtime URLs, or animation instructions. When source timing is
absent, the native consumer chooses its duration/speed and uses an explicit
Handler or `View.postDelayed` scheduler.

A native consumer must reject unsupported scene versions, unknown JSON keys or
roles, duplicate/missing references, non-finite numbers, unsupported path
commands, and inputs exceeding its configured element/point/byte limits. XML
DTD and external-entity processing must be disabled.

## Device regression fixtures

Keep generating `*-embed-scene.svg` artifacts for every fixture page. In
particular, erase/white-pen cover-ups, grey and black highlighters, calligraphy
widths, landscape pages, and background-only raster fallbacks are permanent
native replay regressions. The Nomad probe has replayed all 68 current pages,
so a newly added fixture automatically becomes an on-device compatibility
case.

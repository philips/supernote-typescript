# Text-box / Digest format research spike

## Question

Can text-box and Digest contents be extracted with enough layout information to
render them as text, rather than preserving the on-device raster pixels?

## Result

**There is a promising structured source, but it is not presently decodable by
this library.** On affected current-format notes, `RECOGNFILE` points to a
length-prefixed ZIP package produced by MyScript iink. It contains the document
model and style sheet; it is not part of the Ratta-RLE layer bitmap.

For `textbox-n5-20260016-digest.note`:

| Page | `PAGETEXTBOX` | `RECOGNFILE` | ZIP page directory | `page.bdom` bytes |
| --- | ---: | ---: | --- | ---: |
| 2 | 1 | 1967536 | `pages/qexziywj/` | 30,209 |
| 4 | 1 | 1130419 | `pages/yvlnearm/` | 9,474 |
| 5 | 1 | 477418 | `pages/hpmalcyl/` | 14,723 |

Each ZIP has:

```
meta.json
rel.json
index.bdom
pages/<id>/meta.json
pages/<id>/page.bdom
pages/<id>/ink.bink
pages/<id>/style.css
```

`meta.json` identifies the producer as MyScript `iink` 3.0.3 with document
version 1.11. `page.bdom` starts with `BDOM` version 2 and has a schema/string
dictionary including `textBlock`, `textField`, `textResult`, `word`, `line`,
`xmax`, `ymax`, `x-id`, `style`, and table/shape fields. `style.css` includes
text-family, size, weight, and line-height rules. This is strong evidence that
the source model can express both text and layout.

The contents are a proprietary MyScript binary DOM/BINK pair. The text is not
plain UTF-8 or UTF-16 in `page.bdom`, and no public TypeScript decoder is in
this project's dependencies or was found in the MyScript web client source.
The current open-source iink TypeScript client sends ink to a service; it does
not read BDOM packages locally.

## What the existing `.note` fields provide

* `DISABLE` identifies the raster-only regions, but has only rectangles.
* `TOTALPATH` has vector pen strokes outside those regions.
* `RECOGNTEXT` is a separate base64 JSON recognition result. It sometimes
  recognizes words inside a disabled rectangle, with per-word boxes, but is
  OCR/handwriting recognition—not the text-box model. It is incomplete and
  inaccurate for this fixture, and contains no font, paragraph, or text-box
  style data.
* `RECOGNFILE` is the iink package described above. It is present on pages 2–5
  and 7 when recognition is enabled, so `PAGETEXTBOX=1` must be used together
  with the package/model to identify actual text-box objects.

For N5, `RECOGNTEXT` word coordinates are in a physical coordinate system that
maps approximately to device pixels at 6.4 pixels per unit. This can make an
OCR fallback place words roughly correctly, but cannot reproduce text layout
or be used as the primary source.

## Feasible paths

### 1. Obtain/use a MyScript decoder — recommended investigation

Ask Ratta/MyScript whether their licensed iink SDK can load this `Raw Content`
package and export it to JIIX, SVG, HTML, or text-with-boxes. A proof of
concept should load `RECOGNFILE` from this fixture and verify that page 4's
body text and its rectangle can be exported without using the Ratta bitmap.

This is likely the lowest-risk route, but the SDK may be native, licensed, and
not suitable for this library's browser/Node distribution. It must be assessed
for redistribution, offline operation, output fidelity, and version
compatibility before adopting it.

### 2. Reverse engineer the BDOM/BINK pair

This is viable only as a separately scoped format project. Build a controlled
corpus on one device: save successive copies after adding one known text box,
one character, a line break, font/style changes, resize/move, and a Digest.
Diff the ZIP entries between revisions. The `page.bdom` deltas can establish
its token/value encoding and object graph; `style.css` supplies much of the
style vocabulary.

Success criteria for an initial decoder:

1. enumerate BDOM objects and identify text blocks;
2. extract Unicode text and object bounds;
3. map style references to the shipped CSS;
4. render one text box in SVG/PDF with a system-font fallback.

BINK stroke decoding is not needed for a typeset text block if BDOM supplies
its recognized text and layout, but may be needed to preserve unrecognized
content or match MyScript's reflow exactly.

### 3. OCR fallback only

Use the already parsed `RECOGNTEXT` word boxes to emit positioned SVG/PDF text
inside `DISABLE` rectangles when confidence/coverage is sufficient. Keep the
raster overlay as the default/fallback. This is dependency-free but cannot be
considered extraction of the original text-box contents and will visibly
mis-transcribe the fixture.

## Recommendation

Keep the raster overlay as the production behavior. Start with path 1: obtain
a supported way to read/export the MyScript Raw Content package. If that is not
available under a usable license, collect the controlled corpus before writing
a BDOM parser. Do not begin by treating `RECOGNTEXT` as authoritative text-box
content.

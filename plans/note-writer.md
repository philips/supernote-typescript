# `.note` writer prototype

Status: **prototype**. It writes notes with editable text boxes that
current firmware opens, re-renders, and saves. It cannot write strokes,
other templates, or older file versions yet.

Motivation: an agent (Pi, via Ola Ink) must answer a handwritten note with a
`.note` the user reviews on the device. The plan is in
`olaink/plans/pi-conversation-mode.md`.

## API

```ts
import { createTextNote, writeNote, layoutTextPages, encodeRattaRle } from 'supernote-typescript';

// One call: typeset text into text boxes (paginated), return the file bytes.
const bytes = createTextNote({ text, fontBytes /* TTF/OTF */ });

// Lower level: pages of MAINLAYER pixels (one Ratta color byte per pixel)
// plus text boxes.
writeNote({ pages: [{ mainLayer, textBoxes: [{ x, y, width, height, text }] }] });

// Reading: the editable text boxes on a parsed page.
extractTextBoxes(note.pages[0].totalPathBuffer); // [{ x, y, width, height, text, fontSize }]
```

`src/writer.ts` holds the file serializer, the Ratta RLE encoder, and the
text-box record. `src/textbox.ts` holds text layout and rasterization. The
tests are in `tests/writer.test.ts`.

## File layout written

The output is `noteSN_FILE_VER_20260016`, `APPLY_EQUIPMENT:N5`, with a
1920x2560 page. That is what current firmware creates on both the Manta and
the Nomad. A Nomad on Chauvet 2608 writes N5/1920x2560 files; older Nomad
files are A6X/1404x1872. The blocks go in the order a fresh device note uses:

```
signature | header | BG bitmap | per page: MAIN bitmap, MAINLAYER, BGLAYER,
[TOTALPATH], page | footer | "tail" | u32 footer address
```

A blank page is **byte-identical** to a fresh device-created note
(`tests/input/blank-n5-20260016-nomad-fresh.note`).

The RLE encoder emits the device's own run forms, which are listed below.
Its blank 1920x2560 layer is the device's `300 x (62 ff)`.

| Run length | Encoding |
| --- | --- |
| 16384 pixels | `(c, ff)` |
| 129–16383 pixels | `(c, 80\|hi) (c, lo)` |
| 1–128 pixels | `(c, n-1)` |

## Text boxes: what the device actually stores (Chauvet 2608)

These findings came from device experiments over ADB and are pinned by
`tests/input/textbox-n5-20260016-device-record.note`.

A device text box is:

1. **A `TOTALPATH` record.** It has the usual stroke-record layout from
   `vector-format-spec.md`, with these values:
   - `pen=0`, `color=0`, `thickness=100`, `stroke_kind "0000"`, and
     `doc_kind "name is not set"`.
   - `bounding_tl = (x, y)`, `bounding_mid = (0, 0)`, and a
     `bounding_br` that is oddly **`(x+w+227, y+h+227)`**.
   - Five points forming a closed rectangle in digitizer units.
     `maxY/maxX = 21632/16224`. The corner order is bottom-left,
     bottom-right, top-right, top-left, bottom-left.
   - A matching one-ring `point_contour` in page pixels (inclusive
     right/bottom).
   - `m_copy = 30`.
   - The trailing `sized_str_1` is a **comma-separated list of base64
     fields**, with a trailing comma. The fields are:

     | # | Value |
     | --- | --- |
     | 0–2 | `0` |
     | 3 | creation id (20 digits, `yyyyMMddHHmmssSSS` + 3) |
     | 4, 5 | `x,y,w,h` |
     | 6–8 | `none` |
     | 9 | `0` |
     | 10 | font size `48.000000` |
     | 11 | font path `/system/fonts/DroidSansFallbackFull.ttf` |
     | 12 | **the text**: UTF-8, hard breaks kept as `\n` |
     | 13 | style list (`…,1,3,…` for an auto-width single-line box, `…,0,3,…` once it wraps) |
     | 14 | line advance `63` |
     | 15–17 | `1`, `1`, `0` |
     | 18 | `none` |

     `sized_str_2` is `none`, and 5 zero bytes follow `markPenDFillDir`.
     The box height is `lines × 63 + 1`.
2. **Its pixels in MAINLAYER.** The device's own renders are anti-aliased
   with arbitrary gray bytes. The writer quantizes to `0x61` / `0x9d` /
   `0xc9`.
3. **Its rect in the page's `DISABLE`** list (`x,y,w,h|…`), with
   `PAGETEXTBOX:1`.

On-device behavior observed:

- The device **displays MAINLAYER pixels on open**. It does not render
  from the record, so a record with no pixels shows up blank.
- When the device redraws text boxes, for example when the user adds or
  edits one, it **clears every `DISABLE` region and re-renders from the
  records**. A raster-only box, one with pixels and `DISABLE` but no
  record, therefore disappears. A box written by the writer survives, is
  re-laid out by the device in its own font, and is saved back with our
  record intact.
- Our record matches a device-created one byte for byte except the five
  digitizer-unit points, which differ by less than one page pixel. The
  device uses its own sub-pixel rounding, and apparently trusts the CSV
  rect.

This corrects the earlier conclusion of `textbox-bdom-spike.md` for this
firmware. The older `textbox-n5-20260016-digest.note` genuinely has no
text-box records, and on current firmware they exist.

## Known gaps / next steps

- **Text layout vs the device.** The device wraps slightly earlier than our
  layout: it has some inner padding, and it pushed a trailing `√` onto the
  next line. The device's re-render wins once the user edits, so this only
  affects the first display. We could measure the device's padding and
  mirror it.
- **Unknown style/flag fields.** CSV fields 0–2, 9, 13, and 15–17,
  `section_4`'s `1404/1872/5000000`, and the `+227` are copied, not
  understood. Controlled fixtures (bold, italic, alignment, sizes) would
  decode field 13.
- **Font.** The caller supplies the font. Emoji and missing glyphs render
  as `.notdef` boxes.
- Only `style_white_a5x2` is supported, and there are no strokes, layers,
  titles, links, or recognition data.
- Not yet tested on a Manta, or on older firmware (A5X/A6X, 1404x1872,
  `SN_FILE_VER_20230015`).

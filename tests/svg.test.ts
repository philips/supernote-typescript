import * as fs from "fs-extra"
import zlib from "node:zlib"
import { encodePng } from "image-js"
import { toSvg, addSvgPage } from "../src/svg"
import { parseStrokes } from "../src/strokes"
import { recognitionCoordinateScale } from "../src/pdf"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import { describe, test, expect } from 'vitest'

function readFileToUint8Array(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    fs.readFile(`tests/input/${filePath}`, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(new Uint8Array(data.buffer));
      }
    });
  });
}

/**
 * Extracts the decompressed content stream of every Form XObject (PDF spec
 * 7.8.2) in a PDF -- specifically, headings-and-marker.pdf's per-page
 * `/Annots` "Stamp" appearance streams, which is where Supernote's own PDF
 * exporter draws real vector ink (actual `m`/`l`/`c` path operators with
 * real stroke/fill colors and widths), not just a rasterized image. Used
 * only in this test file, as independent ground truth to validate our own
 * TOTALPATH decode against -- not a runtime dependency of the library, and
 * deliberately minimal (a handful of regexes, no PDF object graph, no
 * external PDF-reading dependency) since it only ever needs to read this
 * one fixture's fixed structure. Returns one Buffer per Form XObject found,
 * in file order, which for this fixture is the same as page order (see
 * `tests/input/README.md`).
 */
function extractPdfFormXObjectStreams(pdfBytes: Buffer): Buffer[] {
  const text = pdfBytes.toString("latin1") // 1 byte <-> 1 char, so slicing back to a Buffer below recovers the exact original bytes
  const objectRe = /\d+ 0 obj\r?\n?([\s\S]*?)endobj/g
  const streams: Buffer[] = []
  let match: RegExpExecArray | null
  while ((match = objectRe.exec(text))) {
    const body = match[1]
    if (!body.includes("/Subtype/Form")) continue
    const streamMatch = /stream\r?\n([\s\S]*?)endstream/.exec(body)
    if (!streamMatch) continue
    const raw = Buffer.from(streamMatch[1], "latin1")
    streams.push(body.includes("FlateDecode") ? zlib.inflateSync(raw) : raw)
  }
  return streams
}

/** Distinct `r g b (rg|RG)` colors set in a PDF content stream (see
 * `extractPdfFormXObjectStreams`), as 0-255 integers rounded from the PDF's
 * 0-1 fractional components. */
function extractPdfColors(stream: Buffer): [number, number, number][] {
  const text = stream.toString("latin1")
  const colors = new Map<string, [number, number, number]>()
  for (const m of text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)) {
    const rgb: [number, number, number] = [Math.round(Number(m[1]) * 255), Math.round(Number(m[2]) * 255), Math.round(Number(m[3]) * 255)]
    colors.set(rgb.join(","), rgb)
  }
  return [...colors.values()]
}

describe("svg", () => {
  test("generates a searchable SVG with an RTR text overlay", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const svgs = await toSvg(sn)
    expect(svgs.length).toBe(sn.pages.length)
    await fs.writeFile("tests/output/rtr.note.0.svg", svgs[0])

    for (const word of ["Real", "time", "recognition", "paragraph", "reflow", "together"]) {
      expect(svgs.join("")).toContain(word)
    }
  })

  test("each page is a well-formed standalone SVG document", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const svgs = await toSvg(sn)

    for (const svg of svgs) {
      expect(svg.startsWith("<svg ")).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      expect(svg).toContain("<image ")
      expect(svg).toContain("data:image/png;base64,")
    }
  })

  test("handles a note with recognition data from a nomad device", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
    const svgs = await toSvg(sn)
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) {
      expect(svg.length).toBeGreaterThan(0)
    }
  })

  test("handles a note with no recognition data without throwing", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"))
    const svgs = await toSvg(sn)
    expect(svgs.length).toBe(sn.pages.length)
    await fs.writeFile("tests/output/test.note.0.svg", svgs[0])
  })

  test("handles a user-uploaded background template and unencodable recognition glyphs", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("moonchild-user-bg-and-bad-glyph.note"))
    const svgs = await toSvg(sn)
    expect(svgs.length).toBe(sn.pages.length)
    await fs.writeFile("tests/output/moonchild-user-bg-and-bad-glyph.note.0.svg", svgs[0])

    for (const word of ["Saturn", "Mercury", "Moon", "MAGUS"]) {
      expect(svgs.join("")).toContain(word)
    }
  })

  test("toSvg() produces text equivalent to manual toImage + addSvgPage composition", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))

    const viaToSvg = await toSvg(sn)

    const images = await toImage(sn)
    const viaManualComposition = sn.pages.map((page, i) =>
      addSvgPage(page, images[i], sn.pageWidth, sn.pageHeight),
    )

    expect(viaToSvg).toEqual(viaManualComposition)
  })

  test("addSvgPage accepts either an Image or pre-encoded PNG bytes with equivalent output", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const [image] = await toImage(sn, [1])

    const svgFromImage = addSvgPage(sn.pages[0], image, sn.pageWidth, sn.pageHeight)
    const svgFromBytes = addSvgPage(sn.pages[0], encodePng(image), sn.pageWidth, sn.pageHeight)

    expect(svgFromImage).toBe(svgFromBytes)
  })

  test("includeText: false omits the recognition text overlay", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const svgs = await toSvg(sn, { includeText: false })

    expect(svgs.join("")).not.toContain("<text ")
  })

  // One fixture per device family whose native `pageWidth` differs (Manta's
  // reference 1920 vs. every other family's 1404 default - see
  // recognitionCoordinateScale()'s own comment in pdf.ts), each with a known
  // word's raw bounding-box pulled directly from the note's own
  // recognitionElements, so the expected SVG position is derived from that
  // note's real data rather than a value copied out of the implementation.
  const deviceFixtures: {
    device: string;
    file: string;
    pageWidth: number;
    word: string;
    box: { x: number; y: number; width: number; height: number };
  }[] = [
    {
      device: "Manta",
      file: "rtr.note",
      pageWidth: 1920,
      word: "Real",
      box: { x: 15.8155, y: 9.816, width: 21.012503, height: 13.0695 },
    },
    {
      device: "A5X",
      file: "a5x-2.14.28.note",
      pageWidth: 1404,
      word: "Subject",
      box: { x: 12.776001, y: 13.224001, width: 25.072002, height: 9.84 },
    },
    {
      device: "Nomad",
      file: "nomad-3.15.27-blank-shapes-and-RTR.note",
      pageWidth: 1404,
      word: "Square",
      box: { x: 5.084, y: 12.4355, width: 21.857502, height: 11.802001 },
    },
  ]

  test.each(deviceFixtures)(
    "$device (pageWidth $pageWidth): positions recognized text via recognitionCoordinateScale(pageWidth), not a fixed 11.9",
    { timeout: 30000 },
    async ({ file, pageWidth, word, box }) => {
      const sn = new SupernoteX(await readFileToUint8Array(file))
      expect(sn.pageWidth).toBe(pageWidth)

      const [svg] = await toSvg(sn, { pageNumbers: [1] })
      await fs.writeFile(`tests/output/${file}.0.svg`, svg)

      const match = svg.match(new RegExp(`<text x="[^"]*" y="([^"]*)"[^>]*>${word}</text>`))
      expect(match).not.toBeNull()
      const actualY = Number(match![1])

      // addSvgPage positions the baseline at (box.y + box.height) * scale.
      const scale = recognitionCoordinateScale(pageWidth)
      const expectedY = (box.y + box.height) * scale
      const wrongY = (box.y + box.height) * 11.9 // what the old fixed-11.9 bug (philips/supernote-obsidian-plugin#206) would have produced

      expect(actualY).toBeCloseTo(expectedY, 1)
      if (pageWidth !== 1920) {
        expect(Math.abs(actualY - wrongY)).toBeGreaterThan(20)
      }
    },
  )

  test("Manta device with no recognition data (manta.note) renders the image without a text overlay", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("manta.note"))
    expect(sn.pageWidth).toBe(1920)

    const [svg] = await toSvg(sn)
    await fs.writeFile("tests/output/manta.note.0.svg", svg)

    expect(svg).toContain(`viewBox="0 0 ${sn.pageWidth} ${sn.pageHeight}"`)
    expect(svg).toContain("<image ")
    expect(svg).not.toContain("<text ")
  })

  test("multi-page Nomad note keeps each page's recognized words on their own page's SVG", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"))
    expect(sn.pageWidth).toBe(1404)
    expect(sn.pages.length).toBe(3)

    const svgs = await toSvg(sn)
    expect(svgs.length).toBe(3)
    await Promise.all(
      svgs.map((svg, i) => fs.writeFile(`tests/output/nomad-3.26.40-link-tag-3p.note.${i}.svg`, svg)),
    )

    // One word unique to each page (per the note's own recognitionElements),
    // so a word bleeding onto the wrong page's SVG would be caught.
    expect(svgs[0]).toContain(">INK</text>")
    expect(svgs[1]).toContain(">ERASER</text>")
    expect(svgs[2]).toContain(">TITLE</text>")

    expect(svgs[0]).not.toContain(">ERASER</text>")
    expect(svgs[0]).not.toContain(">TITLE</text>")
    expect(svgs[1]).not.toContain(">INK</text>")
    expect(svgs[1]).not.toContain(">TITLE</text>")
    expect(svgs[2]).not.toContain(">INK</text>")
    expect(svgs[2]).not.toContain(">ERASER</text>")
  })

  test("upscale grows the embedded raster and the viewBox/text overlay together", { timeout: 60000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const upscale = 2

    const [nativeSvg] = await toSvg(sn, { pageNumbers: [1] })
    const [upscaledSvg] = await toSvg(sn, { pageNumbers: [1], upscale })
    await fs.writeFile("tests/output/rtr.note.0.upscaled.svg", upscaledSvg)

    const expectedWidth = Math.round(sn.pageWidth * upscale)
    const expectedHeight = Math.round(sn.pageHeight * upscale)
    expect(upscaledSvg).toContain(`viewBox="0 0 ${expectedWidth} ${expectedHeight}"`)
    expect(upscaledSvg).toContain(`width="${expectedWidth}"`)
    expect(upscaledSvg).toContain(`height="${expectedHeight}"`)

    // The recognized-text overlay's coordinates scale with the viewBox, so
    // a word's baseline y should move by ~upscale, not stay put.
    const nativeMatch = nativeSvg.match(/<text x="[^"]*" y="([^"]*)"[^>]*>Real<\/text>/)
    const upscaledMatch = upscaledSvg.match(/<text x="[^"]*" y="([^"]*)"[^>]*>Real<\/text>/)
    expect(nativeMatch).not.toBeNull()
    expect(upscaledMatch).not.toBeNull()
    const nativeY = Number(nativeMatch![1])
    const upscaledY = Number(upscaledMatch![1])
    expect(upscaledY).toBeCloseTo(nativeY * upscale, 0)
  })

  test("upscale scales dpi along with it, keeping the physical width/height constant", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"))
    const dpi = 300
    const upscale = 2

    const [nativeSvg] = await toSvg(sn, { pageNumbers: [1], dpi })
    const [upscaledSvg] = await toSvg(sn, { pageNumbers: [1], dpi, upscale })

    const widthMatch = (svg: string) => svg.match(/width="([\d.]+)in"/)
    expect(widthMatch(upscaledSvg)![1]).toBe(widthMatch(nativeSvg)![1])
  })

  test("dpi sizes the SVG in physical units without changing the pixel viewBox", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"))

    const [pixelSvg] = await toSvg(sn, { pageNumbers: [1] })
    const [dpiSvg] = await toSvg(sn, { pageNumbers: [1], dpi: 300 })

    expect(pixelSvg).toContain(`width="${sn.pageWidth}"`)
    expect(dpiSvg).toContain(`width="${sn.pageWidth / 300}in"`)
    expect(pixelSvg).toContain(`viewBox="0 0 ${sn.pageWidth} ${sn.pageHeight}"`)
    expect(dpiSvg).toContain(`viewBox="0 0 ${sn.pageWidth} ${sn.pageHeight}"`)
  })

  describe("vectorInk", () => {
    test("draws decoded pen strokes as <path> elements instead of relying on the raster for ink", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))

      const [rasterSvg] = await toSvg(sn, { pageNumbers: [1] })
      const [vectorSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      await fs.writeFile("tests/output/a5x-2.14.28.note.0.vector.svg", vectorSvg)

      expect(rasterSvg).not.toContain("<path ")
      expect(vectorSvg).toContain("<path ")
      // both still carry a background raster (template lines, etc.) - only
      // the ink layers are excluded from it, not the whole image
      expect(vectorSvg).toContain("<image ")

      const pathCount = vectorSvg.match(/<path /g)?.length ?? 0
      expect(pathCount).toBeGreaterThan(50)
    })

    test("every decoded path's points fall inside the page's own viewBox", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
      const [vectorSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const pathData = [...vectorSvg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])
      expect(pathData.length).toBeGreaterThan(0)
      for (const d of pathData) {
        for (const [, x, y] of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
          expect(Number(x)).toBeGreaterThanOrEqual(0)
          expect(Number(x)).toBeLessThanOrEqual(sn.pageWidth)
          expect(Number(y)).toBeGreaterThanOrEqual(0)
          expect(Number(y)).toBeLessThanOrEqual(sn.pageHeight)
        }
      }
    })

    test("falls back to normal rasterized ink for a page whose strokes don't decode, instead of rendering blank", { timeout: 30000 }, async () => {
      // moonchild's page 0 has real, substantial rendered ink (~263KB) but a
      // null totalPathBuffer -- this device/firmware combination just
      // doesn't populate TOTALPATH at all (see issue #56) -- so parseStrokes
      // always returns [] for it, guaranteeing this test actually exercises
      // the fallback path rather than becoming vacuous as decoder coverage
      // improves.
      const sn = new SupernoteX(await readFileToUint8Array("moonchild-user-bg-and-bad-glyph.note"))
      const [rasterSvg] = await toSvg(sn, { pageNumbers: [1] })
      const [vectorSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      // same base64 image payload as the plain raster render implies the
      // ink layers weren't stripped for this page.
      expect(vectorSvg).not.toContain("<path ")
      expect(vectorSvg).toBe(rasterSvg)
    })

    test("horizontal_1270.note now crosses the coverage threshold and vectorizes (issue #56)", { timeout: 30000 }, async () => {
      // Landed at 0.725 coverage (see issue #56's table) before parseStrokes
      // switched to a byte-by-byte scan: some of this page's real records
      // sat in the gap after a landmark occurrence that wasn't followed by
      // a record at the usual 76-byte offset, and the old landmark-jump
      // recovery skipped straight past them. Recovering those records pushes
      // this page to full (1.0) coverage, clearing
      // MIN_INK_COVERAGE_TO_REPLACE_RASTER.
      const sn = new SupernoteX(await readFileToUint8Array("horizontal_1270.note"))
      const [rasterSvg] = await toSvg(sn, { pageNumbers: [1] })
      const [vectorSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      expect(vectorSvg).toContain("<path ")
      expect(vectorSvg).not.toBe(rasterSvg)
    })

    test("eraser strokes never render as phantom ink (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // What first looked like "parseStrokes occasionally decodes a record
      // to a smooth but wrong position" (a visible phantom scribble
      // overlaid on real handwriting, confirmed on horizontal_1270.note)
      // turned out, once TOTALPATH's real structure was understood (see
      // parseStrokes' doc comment), to be a real, correctly-decoded eraser
      // stroke: TOTALPATH records the eraser tool's own motion just like any
      // other pen, distinguishable by a reserved `color` value (255) rather
      // than a decode error. parseStrokes now excludes these outright, by
      // construction, rather than raster-rejecting a stroke that merely
      // looks suspicious -- so no returned stroke's color can ever be that
      // reserved value, on any fixture.
      for (const file of ["horizontal_1270.note", "rtr.note"]) {
        const sn = new SupernoteX(await readFileToUint8Array(file))
        const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
        expect(strokes.length).toBeGreaterThan(0)
        expect(strokes.some((s) => s.color === "rgb(255,255,255)")).toBe(false)
      }
    })

    test("a stroke fully removed with the stroke eraser leaves no phantom path (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // stroke-isolation.note's page 1 (1-indexed) originally had two
      // horizontal strokes; the lower one was fully deleted with the stroke
      // eraser (select-and-delete-whole-stroke). Confirmed during issue
      // #56's follow-up investigation: that deletion leaves *no* trace at
      // all in TOTALPATH (unlike a partial/drag erase, which -- per the
      // issue's original "eraser marks render as ink" report -- is a
      // separate, still-open problem), so only the surviving stroke should
      // decode here.
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const pathCount = svg.match(/<path /g)?.length ?? 0
      expect(pathCount).toBe(1)
    })

    test("a 2-point stroke over real ink renders as a filled rect, not a phantom diagonal line (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // nomad-3.15.27-blank-shapes-and-RTR.note has four small colored
      // "badges" near the bottom of the page (highlighted digits 1-4), each
      // with a colored background (three solid, one cross-hatch). TOTALPATH
      // decodes each background as a stroke with exactly *2* points -- not
      // a real 2-sample pen line (real strokes, even short ones, sample far
      // more points than that), but that record shape's actual meaning: the
      // two opposite corners of a filled rectangle. Confirmed by measuring
      // how much of each 2-point stroke's own bounding rectangle is already
      // real ink in the page's raster: ~97% for the three solid badges,
      // ~25% for the cross-hatch one, nothing like a thin diagonal line
      // would leave behind.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="([^"]+)"\/>/g)]
      expect(rects.length).toBeGreaterThanOrEqual(3)

      // every rect should be a real, visible area (not a degenerate sliver)
      // and a plausible fill -- either a solid color, or a reference to a
      // hatch <pattern> (see the "cross-hatch" test below) -- not the raw
      // black/white default.
      for (const [, , , width, height, fill] of rects) {
        expect(Number(width)).toBeGreaterThan(10)
        expect(Number(height)).toBeGreaterThan(10)
        expect(fill).toMatch(/^(rgb\(\d+,\d+,\d+\)|url\(#hatch-[\w-]+\))$/)
      }
    })

    test("a cross-hatch rect background renders as an actual hatch pattern, not a solid block (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // headings-and-marker.note's page 2 (1-indexed) has four "Heading"
      // boxes with backgrounds black, dark grey, light grey, and
      // cross-hatch, in that order -- ground truth confirmed by measuring
      // each 2-point rect's own fill fraction against the raster: ~99% for
      // the three solid ones, ~26% for the hatch one. Collapsing the hatch
      // one to a solid fill (its previous behavior) hid anything drawn on
      // top of it, since its own label happens to share the hatch's color.
      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="([^"]+)"\/>/g)].map(
        (m) => m[1],
      )
      expect(rects.length).toBe(4)
      expect(rects[0]).toBe("rgb(0,0,0)")
      expect(rects[1]).toBe("rgb(128,128,128)")
      expect(rects[2]).toBe("rgb(169,169,169)")
      expect(rects[3]).toMatch(/^url\(#hatch-[\w-]+\)$/)

      // the referenced pattern must actually be defined, and be visibly
      // non-solid (a white base with colored diagonal stripes), not just a
      // dangling reference.
      const patternId = rects[3].match(/url\(#([\w-]+)\)/)![1]
      expect(svg).toContain(`<defs>`)
      expect(svg).toContain(`<pattern id="${patternId}"`)
      expect(svg).toContain(`fill="white"`)
    })

    test("a 2-point stroke over no real ink is skipped, not drawn as a phantom line (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // test.note has a 2-point-stroke decode that, unlike the rect badges
      // above, sits over completely blank raster (0% fill fraction) -- some
      // other, non-ink data that happens to satisfy the same record
      // checksum, not a real rectangle or a real stroke. It must not render
      // as either a filled rect or a stroked line.
      const sn = new SupernoteX(await readFileToUint8Array("test.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      const noiseStroke = strokes.find((s) => s.points.length === 2)
      expect(noiseStroke).toBeDefined()

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const [p0, p1] = noiseStroke!.points
      const needle = `${p0.x.toFixed(2)},${p0.y.toFixed(2)}`
      const needle2 = `${p1.x.toFixed(2)},${p1.y.toFixed(2)}`
      expect(svg).not.toContain(needle)
      expect(svg).not.toContain(needle2)
    })

    test("rects (highlight backgrounds) always draw before paths, regardless of TOTALPATH order", { timeout: 30000 }, async () => {
      // On the same badges fixture, each badge's background rect record
      // sits *after* its digit's ink stroke in TOTALPATH's own buffer
      // order -- drawing strictly in that order (SVG paints later elements
      // on top) would paint the background over the digit and hide it.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const lastRectIndex = svg.lastIndexOf("<rect ")
      const firstPathIndex = svg.indexOf("<path ")
      expect(lastRectIndex).toBeGreaterThan(-1)
      expect(firstPathIndex).toBeGreaterThan(-1)
      expect(lastRectIndex).toBeLessThan(firstPathIndex)
    })

    test("a stroke drawn over a different-colored background measures its own width, not the background's (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // Each digit badge's foreground digit stroke sits on top of its own
      // solid-colored background rect (see the two tests above). Walking
      // outward to measure width used to stop only at *any* non-ink pixel,
      // so a thin digit surrounded by its own badge's opaque background
      // color never found an edge until MAX_HALF_WIDTH -- measuring as wide
      // as the badge itself instead of the actual thin digit stroke.
      // Requiring the walk to match the stroke's own sampled color fixes
      // this: none of these digit strokes should measure anywhere near
      // MAX_HALF_WIDTH's ceiling.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)]
      const paths = [...svg.matchAll(/<path d="M(-?[\d.]+),(-?[\d.]+)[^"]*" fill="none" stroke="[^"]+" stroke-width="([^"]+)"/g)]
      expect(rects.length).toBeGreaterThan(0)

      // any path whose first point falls inside a badge rect is a digit
      // stroke drawn over that badge -- none should be anywhere near as
      // wide as the badge itself.
      const digitWidths = paths
        .filter(([, xStr, yStr]) => {
          const x = Number(xStr), y = Number(yStr)
          return rects.some(([, rx, ry, rw, rh]) => {
            const left = Number(rx), top = Number(ry)
            return x >= left && x <= left + Number(rw) && y >= top && y <= top + Number(rh)
          })
        })
        .map(([, , , width]) => Number(width))
      expect(digitWidths.length).toBeGreaterThan(0)
      for (const width of digitWidths) {
        expect(width).toBeLessThan(15)
      }
    })

    test("marker strokes always draw before pen strokes, regardless of TOTALPATH order (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // This fixture's "TEXT HIGHLIGHT" gray highlight band is a real
      // marker-tool stroke, with the narrower black "TEXT"/"HIGHLIGHT" pen
      // strokes layered on top of it in the real note -- but not
      // necessarily earlier in TOTALPATH's own buffer order. Drawing
      // strictly in buffer order can paint the marker highlight over the
      // narrower ink and hide it. Tier is decided by the stroke's own real
      // `pen` field (see deriveStrokeStyle), not by comparing rendered
      // widths -- a marker stroke isn't guaranteed to render wider than
      // every non-marker one on a given fixture, so draw order is verified
      // here by matching each real stroke's own coordinates against the
      // rendered SVG, not by re-inferring tier from stroke-width.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      const markerStrokes = strokes.filter((s) => s.pen === "marker")
      const penStrokes = strokes.filter((s) => s.pen !== "marker")
      expect(markerStrokes.length).toBeGreaterThan(0)
      expect(penStrokes.length).toBeGreaterThan(0)

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const needle = (s: (typeof strokes)[number]) => `M${s.points[0].x.toFixed(2)},${s.points[0].y.toFixed(2)}`
      const lastMarkerIndex = Math.max(...markerStrokes.map((s) => svg.indexOf(needle(s))).filter((i) => i !== -1))
      const firstPenIndex = Math.min(...penStrokes.map((s) => svg.indexOf(needle(s))).filter((i) => i !== -1))
      expect(lastMarkerIndex).toBeGreaterThan(-1)
      expect(firstPenIndex).toBeGreaterThan(-1)
      expect(lastMarkerIndex).toBeLessThan(firstPenIndex)
    })

    test("scales stroke coordinates together with upscale", { timeout: 60000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
      const upscale = 2

      const [nativeSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const [upscaledSvg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true, upscale })

      const firstPoint = (svg: string) => {
        const match = svg.match(/<path d="M(-?[\d.]+),(-?[\d.]+)/)
        expect(match).not.toBeNull()
        return { x: Number(match![1]), y: Number(match![2]) }
      }
      const native = firstPoint(nativeSvg)
      const upscaled = firstPoint(upscaledSvg)
      expect(upscaled.x).toBeCloseTo(native.x * upscale, 0)
      expect(upscaled.y).toBeCloseTo(native.y * upscale, 0)

      expect(upscaledSvg).toContain(`viewBox="0 0 ${sn.pageWidth * upscale} ${sn.pageHeight * upscale}"`)
    })

    // TOTALPATH doesn't store pen color, tool, or width itself (confirmed by
    // exhaustive byte comparison across these exact strokes during issue
    // #56's follow-up investigation -- see stroke-isolation.note's own
    // description in tests/input/README.md) -- so vectorInk derives a
    // stroke's color/width by sampling the page's own already-rendered ink
    // along each decoded point instead.
    test("reads each stroke's real color from its own TOTALPATH metadata", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      // page 3 (1-indexed): four needle-point-pen strokes, default width,
      // one per color: black, dark gray, light gray, white. These are exact
      // values read from each stroke's own real `color` field (see
      // IStroke), not raster-sampled -- confirmed against
      // https://github.com/Walnut356/snlib's Color enum (Black=0,
      // DarkGrey=158, LightGrey=202, White=254) and against
      // headings-and-marker.pdf's real vector fill colors (issue #56
      // follow-up), both of which land within a few units of what's
      // measured here.
      const [svg] = await toSvg(sn, { pageNumbers: [3], vectorInk: true })

      const colors = [...svg.matchAll(/<path d="[^"]*" fill="none" stroke="([^"]+)"/g)].map((m) => m[1])
      expect(colors).toEqual(["rgb(0,0,0)", "rgb(157,157,157)", "rgb(201,201,201)", "rgb(254,254,254)"])
    })

    test("white ink reads as a real, distinct color, not mistaken for unwritten background", { timeout: 30000 }, async () => {
      // page 5 (1-indexed): a black marker stroke, then a white marker
      // stroke, same tool/width -- isolates color from a wide tool too, not
      // just the needle pen. The black marker stroke's real color is
      // MarkerBlack (1), distinct from a non-marker black stroke's Black
      // (0) -- both round to the same visible black, but they're genuinely
      // different recorded values (see
      // https://github.com/Walnut356/snlib's Color enum), which is exactly
      // right: a marker stroke really is drawn with a different internal
      // color id than a pen stroke, even at "the same" black.
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [5], vectorInk: true })

      const paths = [...svg.matchAll(/<path d="[^"]*" fill="none" stroke="([^"]+)" stroke-width="([^"]+)"/g)]
      expect(paths.length).toBe(2)
      expect(paths[0][1]).toBe("rgb(1,1,1)")
      expect(paths[1][1]).toBe("rgb(254,254,254)")
      // same tool/width setting on both strokes -- widths should match
      // exactly, both read from the same real thickness field.
      expect(Number(paths[1][2])).toBeCloseTo(Number(paths[0][2]), -1)
    })

    test("samples wider stroke widths for a larger pen-width setting", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      // page 4 (1-indexed): four needle-point-pen strokes, black, one per
      // width setting, in decreasing order: 1.0, 0.6, 0.3, 0.1.
      const [svg] = await toSvg(sn, { pageNumbers: [4], vectorInk: true })

      const widths = [...svg.matchAll(/<path d="[^"]*" fill="none" stroke="[^"]+" stroke-width="([^"]+)"/g)].map((m) =>
        Number(m[1]),
      )
      expect(widths.length).toBe(4)
      expect(widths[0]).toBeGreaterThan(widths[1])
      expect(widths[1]).toBeGreaterThan(widths[2])
      expect(widths[2]).toBeGreaterThan(widths[3])
    })

    test("a wide tool (marker) samples a visibly wider stroke than the needle pen", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      // page 2 (1-indexed): needle pen 0.3, ink pen 0.5, marker, calligraphy
      // pen 0.7 -- draw order puts the marker (wide/"marker" tier) first,
      // ahead of the three narrower ("pen" tier) strokes in their original
      // order (see "wide (marker/highlighter) strokes always draw before
      // narrow (pen) strokes" above), so the marker is whichever stroke has
      // the greatest width, not a fixed array position.
      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })

      const widths = [...svg.matchAll(/<path d="[^"]*" fill="none" stroke="[^"]+" stroke-width="([^"]+)"/g)].map((m) =>
        Number(m[1]),
      )
      expect(widths.length).toBe(4)
      const markerWidth = Math.max(...widths)
      const narrowestPenWidth = Math.min(...widths)
      expect(markerWidth).toBeGreaterThan(narrowestPenWidth * 3)
    })

    test("page 1's decoded stroke count matches Supernote's own PDF export (headings-and-marker.pdf ground truth, issue #56 follow-up)", { timeout: 30000 }, async () => {
      // headings-and-marker.pdf is Supernote's own PDF export of the same
      // note (see tests/input/README.md) -- its page 1 draws ink as 32
      // separately stroked vector subpaths (one per pen-lift), independent
      // ground truth for how many strokes this page *actually* contains,
      // not just how many parseStrokes happens to produce.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/headings-and-marker.pdf"))
      const page1Stream = pdfStreams[0].toString("latin1")
      const subpathCount = (page1Stream.match(/(?:^|\s)S(?:\s|$)/g) ?? []).length
      expect(subpathCount).toBe(32)

      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      expect(strokes.length).toBe(subpathCount)
    })

    const NEAR_DUPLICATE_TOLERANCE = 5
    function groupNearDuplicates(values: number[]): number[] {
      const sorted = [...values].sort((a, b) => a - b)
      const groups: number[] = []
      for (const v of sorted) {
        if (groups.length === 0 || v - groups[groups.length - 1] > NEAR_DUPLICATE_TOLERANCE) groups.push(v)
      }
      return groups
    }

    test("page 3's marker highlight colors read near-exact from real TOTALPATH metadata, matching Supernote's own PDF export (headings-and-marker.pdf ground truth, issue #56 follow-up)", { timeout: 30000 }, async () => {
      // headings-and-marker.pdf's page 3 fills exactly 4 distinct colors
      // (see tests/input/README.md): black, dark grey, grey, white. An
      // earlier raster-sampling version of this decode measured visibly
      // *different* grey values from these -- (128,128,128) and
      // (169,169,169) against the PDF's true (157,157,157) and
      // (201,201,201) -- most likely because the on-device ink bitmap
      // quantizes to a small set of e-ink grey levels. Reading each marker
      // stroke's own real `color` field instead (see IStroke, and
      // https://github.com/Walnut356/snlib's Color enum) lands within a
      // handful of units of the true design color instead of tens of units
      // off, confirmed here directly against the PDF. (Page 2's headings
      // are a 2-point 'rect' record instead of real marker strokes, whose
      // own color field isn't meaningful -- see StrokeStyle -- so it's
      // still raster-sampled and still has this quantization gap; not
      // covered by this test, see the next one.)
      //
      // One real, expected difference from a flat 4-color count: a marker
      // stroke's black reads as a distinct value (MarkerBlack) from the
      // underlying label text's own non-marker black (Black) -- both
      // visually black, genuinely different recorded colors (see "white ink
      // reads as a real, distinct color" above) -- so near-identical greys
      // are grouped before counting/comparing, the same way the PDF's own
      // colors are already one flat value per visually distinct color.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/headings-and-marker.pdf"))
      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))

      const groundTruthGreys = groupNearDuplicates(extractPdfColors(pdfStreams[2]).map(([r]) => r)) // every ground-truth color here is neutral grey (r === g === b)

      const [svg] = await toSvg(sn, { pageNumbers: [3], vectorInk: true })
      const sampledGreys = groupNearDuplicates([...svg.matchAll(/stroke="rgb\((\d+),\d+,\d+\)"/g)].map((m) => Number(m[1])))

      expect(sampledGreys.length).toBe(groundTruthGreys.length)
      for (let i = 0; i < sampledGreys.length; i++) {
        expect(Math.abs(sampledGreys[i] - groundTruthGreys[i])).toBeLessThanOrEqual(NEAR_DUPLICATE_TOLERANCE)
      }
    })

    test("page 2's heading background colors still only preserve relative order, not exact value (rect color isn't real per-stroke metadata -- issue #60)", { timeout: 30000 }, async () => {
      // Unlike page 3's marker strokes, page 2's headings are the 2-point
      // 'rect' record TOTALPATH also uses for badges -- and a rect's own
      // color/pen fields aren't meaningful (confirmed against a real
      // fixture: every heading here reads the same uninformative color
      // regardless of its actual, visibly different background -- see
      // StrokeStyle's doc comment). So rect color still comes from
      // sampleRect, the page's own rendered ink, with the same
      // e-ink-quantization gap from the PDF's true design color that
      // path/stroke colors no longer have (see the previous test) --
      // recovering the real value would mean decoding RECOGNFILE's
      // page.bdom, tracked separately as issue #60.
      //
      // The PDF's own 4th color (white) has no counterpart to compare here:
      // it's the cross-hatch heading's *background*, and this decode
      // renders a hatch rect's fill as a `<pattern>` url reference (see
      // buildHatchPatternDef), not a literal `fill="rgb(...)"` this test's
      // extraction regex can see -- so only the 3 solid-fill headings
      // (black/dark grey/light grey) are compared, against the PDF's own 3
      // lowest colors.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/headings-and-marker.pdf"))
      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))

      const groundTruthGreys = groupNearDuplicates(extractPdfColors(pdfStreams[1]).map(([r]) => r)).slice(0, 3)

      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })
      const sampledGreys = groupNearDuplicates([...svg.matchAll(/<rect[^>]*fill="rgb\((\d+),\d+,\d+\)"/g)].map((m) => Number(m[1])))

      expect(sampledGreys.length).toBe(groundTruthGreys.length) // still 3 distinct rect colors found
      expect(sampledGreys[0]).toBe(groundTruthGreys[0]) // black, exact -- pure black isn't subject to grey quantization
      expect(sampledGreys[1]).toBeLessThan(sampledGreys[2]) // dark grey still measures darker than light grey, i.e. still relative-order-preserving
    })

    // Every .note fixture in tests/input, discovered dynamically so a newly
    // added fixture is automatically covered without remembering to list it
    // here. Most of these were never written with vectorInk in mind (some
    // predate parseStrokes entirely) - the point isn't that all of them
    // vectorize, it's that vectorInk must never crash or silently corrupt
    // output on a real file it wasn't specifically tuned against, and must
    // never produce a stroke point outside the page.
    const allNoteFixtures = fs
      .readdirSync("tests/input")
      .filter((name) => name.endsWith(".note"))
      .sort()

    test.each(allNoteFixtures)(
      "%s: vectorInk produces well-formed output on every page without dropping ink",
      { timeout: 60000 },
      async (file) => {
        const sn = new SupernoteX(await readFileToUint8Array(file))

        const rasterSvgs = await toSvg(sn)
        const vectorSvgs = await toSvg(sn, { vectorInk: true })

        expect(vectorSvgs.length).toBe(sn.pages.length)

        await Promise.all(
          vectorSvgs.map((svg, i) =>
            // Only pages that actually vectorized are worth keeping around
            // for visual inspection -- pages that fell back to the plain
            // raster are already identical to a plain toSvg() render.
            svg.includes("<path ") ? fs.writeFile(`tests/output/${file}.${i}.vector.svg`, svg) : Promise.resolve(),
          ),
        )

        vectorSvgs.forEach((svg, i) => {
          expect(svg.startsWith("<svg ")).toBe(true)
          expect(svg.endsWith("</svg>")).toBe(true)
          expect(svg).toContain("<image ")

          const hasPaths = svg.includes("<path ")
          // A page vectorInk didn't (fully) decode must fall back to
          // exactly the plain raster render for that page, not some
          // in-between state missing ink.
          if (!hasPaths) {
            expect(svg).toBe(rasterSvgs[i])
          }

          for (const [, d] of svg.matchAll(/<path d="([^"]+)"/g)) {
            for (const [, x, y] of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
              expect(Number.isFinite(Number(x))).toBe(true)
              expect(Number.isFinite(Number(y))).toBe(true)
              expect(Number(x)).toBeGreaterThanOrEqual(0)
              expect(Number(x)).toBeLessThanOrEqual(sn.pageWidth)
              expect(Number(y)).toBeGreaterThanOrEqual(0)
              expect(Number(y)).toBeLessThanOrEqual(sn.pageHeight)
            }
          }
        })
      },
    )
  })
})

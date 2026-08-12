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

/** Total ink area a PDF content stream fills, in page pixels squared.
 * Flattens each `c` curve into line segments and sums the subpaths of every
 * `f` group with *signed* shoelace areas, so a filled letter's inner hole
 * subtracts instead of adding (see signedRingArea in src/svg.ts). Lets a
 * page's rendered ink be compared as one number against what vectorInk
 * draws, for the newer "filled outline" export style that has no `w` widths
 * to read off directly. */
function pdfFilledArea(stream: Buffer): number {
  type P = { x: number; y: number }
  const signedArea = (ring: P[]) => {
    let sum = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
    return sum / 2
  }
  let total = 0
  let rings: P[][] = []
  let cur: P[] = []
  let pen: P = { x: 0, y: 0 }
  const nums: number[] = []
  for (const token of stream.toString("latin1").split(/\s+/)) {
    const value = Number(token)
    if (token !== "" && Number.isFinite(value)) { nums.push(value); continue }
    if (token === "m" || token === "l") {
      if (token === "m" && cur.length > 2) rings.push(cur)
      pen = { x: nums[nums.length - 2], y: nums[nums.length - 1] }
      if (token === "m") cur = [pen]
      else cur.push(pen)
    } else if (token === "c") {
      const [x1, y1, x2, y2, x3, y3] = nums.slice(-6)
      const from = pen
      for (let step = 1; step <= 12; step++) {
        const u = step / 12, v = 1 - u
        cur.push({
          x: v * v * v * from.x + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
          y: v * v * v * from.y + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3,
        })
      }
      pen = { x: x3, y: y3 }
    } else if (token === "f" || token === "f*") {
      if (cur.length > 2) rings.push(cur)
      if (rings.length) total += Math.abs(rings.reduce((sum, ring) => sum + signedArea(ring), 0))
      rings = []
      cur = []
    }
    nums.length = 0
  }
  return total
}

interface SvgInkPath {
  /** Colour the stroke is drawn in, as the SVG's own `rgb(r,g,b)`. */
  color: string
  /** Line width in page pixels -- see `svgInkPaths`. */
  width: number
  /** Area of ink the path lays down, in square page pixels. */
  area: number
  /** The path's own drawn geometry: the outline's rings for a filled path,
   * the centreline for a stroked one. */
  rings: { x: number; y: number }[][]
  /** The whole `d` attribute, for tests that want to match on it directly. */
  d: string
}

function ringLength(ring: { x: number; y: number }[], closed: boolean): number {
  let total = 0
  for (let i = 1; i < ring.length; i++) total += Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y)
  if (closed && ring.length > 1) total += Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y)
  return total
}

function ringArea(ring: { x: number; y: number }[]): number {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  return sum / 2
}

/**
 * Every ink path a `vectorInk` SVG drew, in document order.
 *
 * A stroke normally renders as the device's own rendered outline, filled
 * (`<path d="..." fill="rgb(...)"/>`); only a record with no usable contour
 * falls back to stroking its sampled centreline (`fill="none"
 * stroke="..." stroke-width="..."`). This reports both the same way, so a
 * test can assert on colour and width without caring which shape it got.
 *
 * `width` for a filled outline is *measured back out of the drawn polygon*
 * rather than read from an attribute: treating the shape as a stadium (a
 * length-`L` band of width `w` with a round cap at each end) gives
 * `area = L*w + PI*(w/2)^2` and `perimeter = 2L + PI*w`, which solve to
 * `w = (P - sqrt(P^2 - 4*PI*A)) / PI`. That deliberately measures the
 * emitted geometry alone, independent of the `strokeRenderWidth` these
 * tests exist to check. A shape too round for that to have a real solution
 * (a filled blob rather than a band -- the sticker plugin draws those) is
 * reported at its area-equivalent disc width instead.
 */
function svgInkPaths(svg: string): SvgInkPath[] {
  const parseRings = (d: string) =>
    d
      .split("M")
      .filter((segment) => segment.trim())
      .map((segment) => [...segment.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) })))
      .filter((ring) => ring.length > 0)

  const paths: SvgInkPath[] = []
  for (const [, d, attrs] of svg.matchAll(/<path d="([^"]+)"([^>]*)\/>/g)) {
    const rings = parseRings(d)
    const strokeColor = /stroke="([^"]+)"/.exec(attrs)?.[1]
    if (strokeColor) {
      const width = Number(/stroke-width="([\d.]+)"/.exec(attrs)?.[1] ?? 0)
      paths.push({ color: strokeColor, width, area: ringLength(rings[0] ?? [], false) * width, rings, d })
      continue
    }
    const fill = /fill="([^"]+)"/.exec(attrs)?.[1]
    if (!fill || fill === "none" || fill.startsWith("url(")) continue
    const area = Math.abs(rings.reduce((sum, ring) => sum + ringArea(ring), 0))
    const perimeter = rings.reduce((sum, ring) => sum + ringLength(ring, true), 0)
    const discriminant = perimeter * perimeter - 4 * Math.PI * area
    const width = discriminant >= 0 ? (perimeter - Math.sqrt(discriminant)) / Math.PI : 2 * Math.sqrt(area / Math.PI)
    paths.push({ color: fill, width, area, rings, d })
  }
  return paths
}

/** Colours of every ink path a vectorInk SVG drew, in document order -- see
 * `svgInkPaths`. */
function svgInkColors(svg: string): string[] {
  return svgInkPaths(svg).map((path) => path.color)
}

/** Widths of every ink path a vectorInk SVG drew -- see `svgInkPaths`. */
function svgInkWidths(svg: string): number[] {
  return svgInkPaths(svg).map((path) => path.width)
}

/** Ink area a vectorInk SVG actually draws. Eraser overlays (pure white)
 * are excluded -- they're a paint-over, not ink. */
function svgInkArea(svg: string): number {
  return svgInkPaths(svg)
    .filter((path) => path.color !== "rgb(255,255,255)")
    .reduce((total, path) => total + path.area, 0)
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
      // boxes near the bottom of the page (highlighted digits 1-4), each
      // with a colored background (three solid, one cross-hatch). These
      // read as "badges" at a glance, but are actually Headings: each one
      // has its own real TITLE_* footer entry (TITLERECT matches this
      // fixture's own 2-point rect strokes pixel-for-pixel, TITLESTYLE
      // decodes its real background/text colors -- see the vector-format
      // spec's "TITLE_ / KEYWORD_ footer metadata" section). TOTALPATH
      // decodes each background as a stroke with exactly *2* points -- not
      // a real 2-sample pen line (real strokes, even short ones, sample far
      // more points than that), but that record shape's actual meaning: the
      // two opposite corners of a filled rectangle. Confirmed by measuring
      // how much of each 2-point stroke's own bounding rectangle is already
      // real ink in the page's raster: ~97% for the three solid ones, ~25%
      // for the cross-hatch one, nothing like a thin diagonal line would
      // leave behind.
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
      // cross-hatch, in that order. Fill/color now comes from each
      // Heading's own TITLE_* footer metadata (TITLESTYLE), not raster
      // sampling -- so the colors are the exact 0/157/201 design palette,
      // not the e-ink raster's quantized 0/128/169 (see the vector-format
      // spec's "TITLE_ / KEYWORD_ footer metadata" section). Collapsing the
      // hatch one to a solid fill (its previous behavior) hid anything
      // drawn on top of it, since its own label happens to share the
      // hatch's color.
      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="([^"]+)"\/>/g)].map(
        (m) => m[1],
      )
      expect(rects.length).toBe(4)
      expect(rects[0]).toBe("rgb(0,0,0)")
      expect(rects[1]).toBe("rgb(157,157,157)")
      expect(rects[2]).toBe("rgb(201,201,201)")
      expect(rects[3]).toMatch(/^url\(#hatch-[\w-]+\)$/)

      // the referenced pattern must actually be defined, and be visibly
      // non-solid (a white base with colored diagonal stripes), not just a
      // dangling reference.
      const patternId = rects[3].match(/url\(#([\w-]+)\)/)![1]
      expect(svg).toContain(`<defs>`)
      expect(svg).toContain(`<pattern id="${patternId}"`)
      expect(svg).toContain(`fill="white"`)
    })

    test("a heading's label text is recolored for contrast, exact from its own TITLE_* footer metadata (issue #60)", { timeout: 30000 }, async () => {
      // Same four headings-and-marker.note page 2 headings as above (black,
      // dark grey, light grey, cross-hatch backgrounds). Supernote
      // auto-recolors each heading's label text for contrast against its
      // own background -- applyHeadingContrastOverrides now reads that
      // displayed color as the exact last-3-digits of the heading's own
      // TITLESTYLE (see findMatchingTitleStyle) instead of resampling the
      // raster: white text on the two dark backgrounds, black text on the
      // two light/hatch ones -- matching
      // https://support.supernote.com/1759244-using-titles-keywords-and-stars's
      // own described behavior.
      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="[^"]+"\/>/g)]
      const paths = svgInkPaths(svg).map((path): [unknown, string, string, string] => [
        undefined,
        String(path.rings[0][0].x),
        String(path.rings[0][0].y),
        path.color,
      ])
      expect(rects.length).toBe(4)

      const expectedTextColors = ["rgb(254,254,254)", "rgb(254,254,254)", "rgb(0,0,0)", "rgb(0,0,0)"]
      rects.forEach(([, xStr, yStr, wStr, hStr], i) => {
        const left = Number(xStr), top = Number(yStr)
        const right = left + Number(wStr), bottom = top + Number(hStr)
        const textColors = new Set(
          paths
            .filter(([, xStr2, yStr2]) => {
              const x = Number(xStr2), y = Number(yStr2)
              return x >= left && x <= right && y >= top && y <= bottom
            })
            .map(([, , , color]) => color),
        )
        expect([...textColors]).toEqual([expectedTextColors[i]])
      })
    })

    test("having two points doesn't make a record a rectangle -- only its stroke_kind does", { timeout: 30000 }, async () => {
      // Three different things store exactly two points, and TOTALPATH says
      // which is which in each record's own stroke_kind (IStroke.isFilledRect):
      //   "0001"         a Heading/badge background -- opposite corners
      //   "straightLine" the ruler tool -- the ends of a line
      //   "others"       an ordinary ink stroke that happens to be a dot
      // Counting points instead drew straight-line.note's lines as filled
      // boxes or dropped them outright.
      //
      // test.note's page 1 holds the third kind: a single pen tap, 0.13px
      // end to end. It was long assumed to be non-ink noise "over blank
      // raster", but the page's own render has ink at exactly that pixel
      // and no other stroke comes within 12px of it, so it is a real (if
      // tiny) mark and belongs in the output -- as a path, not a rect.
      const sn = new SupernoteX(await readFileToUint8Array("test.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      const twoPointStrokes = strokes.filter((s) => s.points.length === 2)
      expect(twoPointStrokes.length).toBeGreaterThanOrEqual(2)
      // one is a real rect, the other is the pen tap -- same point count,
      // opposite meanings
      expect(twoPointStrokes.filter((s) => s.isFilledRect).length).toBe(1)
      expect(twoPointStrokes.filter((s) => !s.isFilledRect).length).toBe(1)

      const tap = twoPointStrokes.find((s) => !s.isFilledRect)!
      expect(Math.hypot(tap.points[1].x - tap.points[0].x, tap.points[1].y - tap.points[0].y)).toBeLessThan(1)

      // The tap is drawn as its own rendered outline (see svgInkPaths), so
      // what's checked is that some path is drawn around where it sits --
      // not that the centreline's coordinates appear verbatim.
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const drawnAtTheTap = svgInkPaths(svg).filter((path) =>
        path.rings.flat().some((point) => Math.hypot(point.x - tap.points[0].x, point.y - tap.points[0].y) <= Math.max(2, path.width)),
      )
      expect(drawnAtTheTap.length).toBe(1)
    })

    test("white-pen erasing renders by painting the white ink over the dark, in that order (erase-pen.note)", { timeout: 60000 }, async () => {
      // Erasing with a white pen isn't erasing at all -- both strokes are
      // real ink and the white simply covers the dark, so the page renders
      // correctly by drawing them in order rather than by working out what
      // survived. Supernote's own export does exactly this: pages 1-3 of
      // erase-pen.pdf set fill colour black then white, in that sequence.
      // (Page 4 is the control, one dark stroke and no white; its PDF form
      // sets no colour at all because black is PDF's default.)
      //
      // So the thing worth pinning down is the ordering, which is not free:
      // buildStrokePathElements sorts strokes into tiers rather than
      // keeping TOTALPATH order, and a cover-up drawn in a different tier
      // from the ink it covers ends up painted underneath it.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/erase-pen.pdf"))
      const deviceOrder = (stream: Buffer) =>
        [...stream.toString("latin1").matchAll(/([\d.]+) [\d.]+ [\d.]+ rg/g)].map((m) => Math.round(Number(m[1]) * 255))
      expect(deviceOrder(pdfStreams[0])).toEqual([0, 255])

      const sn = new SupernoteX(await readFileToUint8Array("erase-pen.note"))
      const svgs = await toSvg(sn, { vectorInk: true })

      for (const pageIndex of [0, 1, 2]) {
        const drawn = svgInkColors(svgs[pageIndex])
        expect(drawn.length).toBe(2)
        // the dark stroke first (plain black, or the marker's own near-black)
        expect(drawn[0]).toMatch(/^rgb\([01],[01],[01]\)$/)
        // then the white cover-up over the top of it
        expect(drawn[1]).toBe("rgb(254,254,254)")
      }

      // the control page keeps its single stroke and gains no white
      const control = svgInkColors(svgs[3])
      expect(control).toEqual(["rgb(0,0,0)"])
    })

    test("a plugin sticker's filled artwork renders solid, not as the scribble that traces it (sticker.note, issue #68)", { timeout: 30000 }, async () => {
      // Supernote's beta plugin support includes a built-in "sticker"
      // plugin. Placing a sticker adds no new container to the format at
      // all -- no new tag, address or section anywhere in the file -- it
      // just writes the artwork's strokes into the page's ordinary
      // TOTALPATH. What it does add is a stroke shape a centreline can't
      // express: the artwork is filled by strokes doubling back over
      // themselves, so drawing them as uniform-width lines produced the
      // hollow scribble that traces the fill instead of the filled shape.
      const sn = new SupernoteX(await readFileToUint8Array("sticker.note"))
      const strokes = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true })
      expect(strokes.length).toBe(51)

      // The silhouette record is the case that pins this down: it carries a
      // rendered outline and *no sampled points whatsoever*, so there is no
      // centreline to stroke and it used to render as nothing at all.
      const silhouette = strokes.filter((stroke) => stroke.points.length === 0)
      expect(silhouette.length).toBe(1)
      expect(silhouette[0].contour!.length).toBeGreaterThan(1)

      const [, svg] = await toSvg(sn, { vectorInk: true })
      const drawn = svgInkPaths(svg)

      // every drawable stroke reaches the output, the point-less one included
      expect(drawn.length).toBeGreaterThanOrEqual(45)
      const silhouetteArea = Math.abs(
        silhouette[0].contour!.reduce((sum, ring) => {
          let signed = 0
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) signed += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
          return sum + signed / 2
        }, 0),
      )
      expect(silhouetteArea).toBeGreaterThan(1000)
      expect(drawn.some((path) => Math.abs(path.area - silhouetteArea) / silhouetteArea < 0.01)).toBe(true)

      // and the artwork comes out solid: the sticker sits in a ~125x160px
      // box, and the ink drawn inside it covers most of that box rather
      // than the few percent a traced outline would.
      const box = { minX: 895, maxX: 1025, minY: 1195, maxY: 1370 }
      const inside = drawn.filter((path) =>
        path.rings.flat().every((p) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY),
      )
      const blackArea = inside.filter((path) => path.color === "rgb(0,0,0)").reduce((sum, path) => sum + path.area, 0)
      expect(blackArea / ((box.maxX - box.minX) * (box.maxY - box.minY))).toBeGreaterThan(0.5)

      // the white detail strokes (colour 254) are real ink carved back over
      // that fill, not erasers and not background
      expect(inside.some((path) => path.color === "rgb(254,254,254)")).toBe(true)
    })

    test("the ruler tool's straight lines render as lines, not as filled boxes (straight-line.note)", { timeout: 30000 }, async () => {
      // straight-line.note is the only fixture using the ruler/straight-line
      // tool, and the only one producing stroke_kind "straightLine". Each of
      // those records stores just the two endpoints, which the old
      // "two points means a rectangle" rule turned into either a degenerate
      // filled box or nothing at all -- page 1's six lines rendered as three
      // invisible rects and no lines whatsoever.
      const sn = new SupernoteX(await readFileToUint8Array("straight-line.note"))
      const page1 = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      expect(page1.length).toBe(6)
      expect(page1.every((s) => s.points.length === 2)).toBe(true)
      expect(page1.some((s) => s.isFilledRect)).toBe(false)

      const svgs = await toSvg(sn, { vectorInk: true })
      const drawn = svgInkPaths(svgs[0])
      expect(drawn.length).toBe(6)
      expect(svgs[0]).not.toContain("<rect ")
      // Each line is drawn spanning its own two endpoints. A line renders as
      // the device's own rendered outline of it (see svgInkPaths), so what
      // has to match the endpoints is the drawn shape's extent, allowing for
      // the outline standing off the centreline by half the line's width --
      // and that shape has to stay a line rather than filling the box its
      // endpoints span, which is what this fixture regression-tests.
      for (const stroke of page1) {
        const [a, b] = stroke.points
        const match = drawn.find((path) => {
          const points = path.rings.flat()
          const near = (value: number, target: number) => Math.abs(value - target) <= path.width
          return (
            near(Math.min(...points.map((p) => p.x)), Math.min(a.x, b.x)) &&
            near(Math.max(...points.map((p) => p.x)), Math.max(a.x, b.x)) &&
            near(Math.min(...points.map((p) => p.y)), Math.min(a.y, b.y)) &&
            near(Math.max(...points.map((p) => p.y)), Math.max(a.y, b.y))
          )
        })
        expect(match).toBeDefined()
        // a line, not a filled box: its area is a thin band across the span,
        // far short of the whole rectangle its endpoints bound
        const span = Math.abs(b.x - a.x) * Math.abs(b.y - a.y)
        if (span > 0) expect(match!.area).toBeLessThan(span / 2)
      }
    })

    test("a partial (drag) erase paints over the erased ink with white, instead of leaving it fully visible (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // horizontal_1270.note's page 1 is the original issue #56 fixture:
      // real content ("writing" corrected to "note") was partially erased,
      // which -- unlike a whole-stroke select-and-delete -- leaves the
      // erased ink's own strokes in TOTALPATH completely unmarked, plus a
      // separate real eraser-tool stroke (TOTALPATH color 255) tracing
      // where it was dragged. Drawing that eraser stroke as ordinary white
      // ink, at its own real position in TOTALPATH's order (parseStrokes'
      // includeErasers option), paints back over the covered ink -- so the
      // erased word must no longer decode as a normal-width black stroke at
      // its original, now-covered position.
      const sn = new SupernoteX(await readFileToUint8Array("horizontal_1270.note"))
      const inkOnly = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      const withErasers = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true })
      const erasers = withErasers.filter((s) => s.isEraser)
      expect(erasers.length).toBeGreaterThan(0)
      // sanity: parseStrokes' own default (ink-only) output for this page
      // is unaffected by vectorInk's internal includeErasers use.
      expect(inkOnly.some((s) => s.isEraser)).toBe(false)

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      // every decoded eraser stroke must be drawn, as plain white ink, at
      // its own real (unmodified) coordinates -- not skipped the way a
      // whole-stroke-delete or a 2-point noise record would be.
      for (const eraser of erasers) {
        const needle = `M${eraser.points[0].x.toFixed(2)},${eraser.points[0].y.toFixed(2)}`
        expect(svg).toContain(needle)
      }
      expect(svg).toContain('stroke="rgb(255,255,255)"')
    })

    test("a partially erased stroke draws as its surviving fragments, not whole (nomad-3.26.40-link-tag-3p.note)", { timeout: 30000 }, async () => {
      // Page 2 has seven pen lines crossed by four eraser sweeps. The
      // device recorded that by marking each line `trailStatus: -4` and
      // writing the pieces it left behind as separate point-less records
      // carrying only a contour (see strokes.test.ts). So what should be
      // drawn over each line is several short fragments and *not* the
      // line itself -- drawing the line too would paint the erased gaps
      // back in, which is what happened while the mark was only known to
      // mean "an eraser touched this".
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"))
      const strokes = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true })
      const line = strokes.find((stroke) => stroke.trailStatus === -4 && stroke.points.length > 100 && stroke.thickness === 200)
      expect(line).toBeDefined()

      const box = {
        minX: Math.min(...line!.points.map((p) => p.x)),
        maxX: Math.max(...line!.points.map((p) => p.x)),
        minY: Math.min(...line!.points.map((p) => p.y)),
        maxY: Math.max(...line!.points.map((p) => p.y)),
      }
      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })
      const over = svgInkPaths(svg).filter((path) => {
        const points = path.rings.flat()
        const center = {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        }
        return center.x >= box.minX && center.x <= box.maxX && center.y >= box.minY && center.y <= box.maxY
      })
      // its five surviving fragments, and no sixth path spanning the line
      expect(over.length).toBe(5)
      const spanY = (path: (typeof over)[number]) => {
        const ys = path.rings.flat().map((p) => p.y)
        return Math.max(...ys) - Math.min(...ys)
      }
      for (const path of over) expect(spanY(path)).toBeLessThan((box.maxY - box.minY) / 2)
    })

    test("a link-tag indicator box never renders as ink, matching the raster (nomad-3.26.40-link-tag-3p.note)", { timeout: 30000 }, async () => {
      // Page 2 (1-indexed) has three "link tag" boxes -- confirmed via the
      // note's own LINK_* footer metadata (see strokes.test.ts) to be a
      // non-ink UI affordance TOTALPATH still records geometry for. Unlike
      // the Heading/badge 2-point rects, these must not render at all: no
      // filled rect (they're not TITLE_*-backed) and no stroked outline
      // (unlike an ordinary hand-drawn box, which would fall through to a
      // plain 'path'). Matched by bounding box, not a specific point, since
      // a 5-point box's own first vertex isn't necessarily its top-left
      // corner.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"))
      const linkRects = Object.values(sn.links)
        .flat()
        .map((link) => link.LINKRECT.split(",").map(Number))
      expect(linkRects.length).toBeGreaterThan(0)

      const [svg] = await toSvg(sn, { pageNumbers: [2], vectorInk: true })
      const elementBounds: { minX: number; minY: number; maxX: number; maxY: number }[] = []
      for (const [, xStr, yStr, wStr, hStr] of svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)) {
        const x = Number(xStr), y = Number(yStr)
        elementBounds.push({ minX: x, minY: y, maxX: x + Number(wStr), maxY: y + Number(hStr) })
      }
      for (const [, d] of svg.matchAll(/<path d="([^"]+)"/g)) {
        const coords = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)])
        const xs = coords.map(([x]) => x), ys = coords.map(([, y]) => y)
        elementBounds.push({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) })
      }

      for (const [x, y, width, height] of linkRects) {
        const matchesLinkRect = elementBounds.some(
          (b) =>
            Math.abs(b.minX - x) <= 2 &&
            Math.abs(b.minY - y) <= 2 &&
            Math.abs(b.maxX - x - width) <= 2 &&
            Math.abs(b.maxY - y - height) <= 2,
        )
        expect(matchesLinkRect).toBe(false)
      }
    })

    test("a lasso selection path never renders as a phantom loop (erase.note, pen=4)", { timeout: 30000 }, async () => {
      // erase.note's final row was lasso-selected and deleted; the
      // selection loop survives in TOTALPATH as two identical pen=4
      // records that used to render as a big phantom black loop (and, on
      // nomad-3.26.40-link-tag-3p.note page 3, as phantom circles around
      // keyword text whose selection deleted nothing). Neither the device
      // raster nor erase.pdf (Supernote's own vector export of this page)
      // draws it. See LASSO_PEN_ID in src/strokes.ts.
      const sn = new SupernoteX(await readFileToUint8Array("erase.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      // the loop's own first point (read straight from the raw pen=4
      // record) must not start any rendered path
      expect(svg).not.toContain("M462.25,2051.01")

      // Of this page's 18 decodable strokes, every one of the 10 dark ink
      // strokes was erased, and erase.pdf accordingly draws only the 4
      // white-ink cover-up strokes. So nothing dark may render: what's left
      // is those 4 white strokes plus the 4 white eraser overlays, all of
      // which are white-on-white and so visually blank, matching the PDF.
      const paths = svgInkPaths(svg)
      expect(paths.length).toBe(8)
      const whiteCount = paths.filter(({ color }) => color === "rgb(255,255,255)" || color === "rgb(254,254,254)").length
      expect(whiteCount).toBe(8)
    })

    test("an all-erased page renders completely blank, like the device's own export (erase-no-white-pen.note)", { timeout: 30000 }, async () => {
      // erase-no-white-pen.note is one page of 4 lines in 4 different pens,
      // every one erased -- by the drag eraser, the lasso eraser, and
      // select-and-delete -- with no white-ink cover-ups involved. The
      // device renders it blank and erase-no-white-pen.pdf (Supernote's own
      // vector export) draws nothing at all.
      //
      // Nothing in TOTALPATH marks those strokes as erased (see
      // strokeInkPresence), so vectorInk used to draw all five in full plus
      // white eraser scribbles over them. The page's ink layers are empty,
      // which is the raster saying everything on it is gone.
      const sn = new SupernoteX(await readFileToUint8Array("erase-no-white-pen.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true })
      expect(strokes.length).toBe(8) // 5 ink + 3 erasers still decode...

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      expect(svg).not.toContain("<path ") // ...but none of them render
      expect(svg).not.toContain("<rect ")
    })

    test("erased strokes are dropped, and surviving ones kept, matching the device's own PDF export (horizontal_1270)", { timeout: 30000 }, async () => {
      // horizontal_1270.pdf draws exactly 61 of this page's 82 decodable
      // ink strokes -- the other 21 were erased (the "writing"/"note"
      // correction). This page is the tightest ground truth available: it
      // names per stroke what survived, and all 82 decisions come out right.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/horizontal_1270.pdf"))
      const drawnByDevice = (pdfStreams[0].toString("latin1").match(/(?:^|\s)S(?:\s|$)/g) ?? []).length
      expect(drawnByDevice).toBe(61)

      const sn = new SupernoteX(await readFileToUint8Array("horizontal_1270.note"))
      const decoded = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true })
      expect(decoded.filter((s) => !s.isEraser).length).toBe(82) // every stroke still decodes...
      // ...and exactly the 21 the device erased carry a trail status
      expect(decoded.filter((s) => s.trailStatus !== undefined && !s.isEraser).length).toBe(82 - drawnByDevice)

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const inkPaths = svgInkPaths(svg).filter(({ color }) => color !== "rgb(255,255,255)")
      expect(inkPaths.length).toBe(drawnByDevice)

      // The specific stroke this pins down: the "0" of "1270" was written,
      // erased, and rewritten in place. Because the replacement sits on top
      // of it, the erased one still finds ~30% of its own points over black
      // ink, so a presence check alone kept it and the page rendered "12700"
      // with a doubled zero. It is `trailStatus` that settles it.
      //
      // Asserted by counting what lands on top of it rather than by
      // matching literal `d` text, since a path is drawn as its rendered
      // outline (see svgInkPaths) and so never contains the centreline's
      // own coordinates verbatim: the zero's own spot holds exactly the one
      // surviving stroke, not the erased one as well. The pair is found by
      // the thing that defines it -- an erased stroke and a surviving one
      // starting within a couple of pixels of each other.
      const survivors = decoded.filter((stroke) => !stroke.isEraser && stroke.trailStatus === undefined)
      const erasedZero = decoded.find(
        (stroke) =>
          !stroke.isEraser &&
          stroke.trailStatus !== undefined &&
          stroke.points[0] !== undefined &&
          survivors.some((other) => other.points[0] && Math.hypot(other.points[0].x - stroke.points[0].x, other.points[0].y - stroke.points[0].y) < 3),
      )
      expect(erasedZero).toBeDefined()
      const bounds = {
        minX: Math.min(...erasedZero!.points.map((p) => p.x)),
        maxX: Math.max(...erasedZero!.points.map((p) => p.x)),
        minY: Math.min(...erasedZero!.points.map((p) => p.y)),
        maxY: Math.max(...erasedZero!.points.map((p) => p.y)),
      }
      const overTheZero = inkPaths.filter((path) => {
        const points = path.rings.flat()
        const center = {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        }
        return center.x >= bounds.minX && center.x <= bounds.maxX && center.y >= bounds.minY && center.y <= bounds.maxY
      })
      expect(overTheZero.length).toBe(1)
    })

    test("rects (highlight backgrounds) always draw before paths, regardless of TOTALPATH order", { timeout: 30000 }, async () => {
      // On the same fixture (each highlighted digit is actually a Heading,
      // per findMatchingTitleStyle above), each digit's Heading background
      // rect record sits *after* its digit's ink stroke in TOTALPATH's own
      // buffer order -- drawing strictly in that order (SVG paints later
      // elements on top) would paint the background over the digit and hide
      // it.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const lastRectIndex = svg.lastIndexOf("<rect ")
      const firstPathIndex = svg.indexOf("<path ")
      expect(lastRectIndex).toBeGreaterThan(-1)
      expect(firstPathIndex).toBeGreaterThan(-1)
      expect(lastRectIndex).toBeLessThan(firstPathIndex)
    })

    test("a stroke drawn over a different-colored background measures its own width, not the background's (issue #56 follow-up)", { timeout: 30000 }, async () => {
      // Each digit's foreground stroke sits on top of its own solid-colored
      // Heading background rect (see the two tests above). Walking outward
      // to measure width used to stop only at *any* non-ink pixel, so a
      // thin digit surrounded by its own Heading's opaque background color
      // never found an edge until MAX_HALF_WIDTH -- measuring as wide as
      // the background itself instead of the actual thin digit stroke.
      // Requiring the walk to match the stroke's own sampled color fixes
      // this: none of these digit strokes should measure anywhere near
      // MAX_HALF_WIDTH's ceiling.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })

      const rects = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)]
      const paths = svgInkPaths(svg)
      expect(rects.length).toBeGreaterThan(0)

      // any path whose first point falls inside a Heading rect is a digit
      // stroke drawn over that Heading's background -- none should be
      // anywhere near as wide as the background itself.
      const digitWidths = paths
        .filter((path) => {
          const { x, y } = path.rings[0][0]
          return rects.some(([, rx, ry, rw, rh]) => {
            const left = Number(rx), top = Number(ry)
            return x >= left && x <= left + Number(rw) && y >= top && y <= top + Number(rh)
          })
        })
        .map((path) => path.width)
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

      // Each stroke is drawn as its own rendered outline (see svgInkPaths),
      // whose points are the outline's rather than the centreline's, so a
      // stroke is located in the output by extent instead of by coordinate
      // equality: an outline hugs its own stroke, standing off it by half
      // the line's width, so the drawn path whose bounding box is closest
      // to the stroke's own is that stroke's. Draw order is then that
      // path's position in document order.
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const boundsOf = (points: { x: number; y: number }[]) => ({
        minX: Math.min(...points.map((p) => p.x)),
        maxX: Math.max(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)),
        maxY: Math.max(...points.map((p) => p.y)),
      })
      const drawn = svgInkPaths(svg).map((path, index) => ({ index, ...boundsOf(path.rings.flat()) }))
      const drawIndexOf = (stroke: (typeof strokes)[number]) => {
        const want = boundsOf(stroke.points)
        let best = -1
        let bestDistance = Infinity
        for (const path of drawn) {
          const distance =
            Math.abs(path.minX - want.minX) + Math.abs(path.maxX - want.maxX) + Math.abs(path.minY - want.minY) + Math.abs(path.maxY - want.maxY)
          if (distance < bestDistance) {
            bestDistance = distance
            best = path.index
          }
        }
        return best
      }
      const lastMarkerIndex = Math.max(...markerStrokes.map(drawIndexOf).filter((i) => i !== -1))
      const firstPenIndex = Math.min(...penStrokes.map(drawIndexOf).filter((i) => i !== -1))
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

      const colors = svgInkColors(svg)
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

      const paths = svgInkPaths(svg)
      expect(paths.length).toBe(2)
      expect(paths[0].color).toBe("rgb(1,1,1)")
      expect(paths[1].color).toBe("rgb(254,254,254)")
      // same tool/width setting on both strokes -- widths should match
      // exactly, both read from the same real thickness field.
      expect(paths[1].width).toBeCloseTo(paths[0].width, -1)
    })

    test("samples wider stroke widths for a larger pen-width setting", { timeout: 30000 }, async () => {
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      // page 4 (1-indexed): four needle-point-pen strokes, black, one per
      // width setting, in decreasing order: 1.0, 0.6, 0.3, 0.1.
      const [svg] = await toSvg(sn, { pageNumbers: [4], vectorInk: true })

      const widths = svgInkWidths(svg)
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

      const widths = svgInkWidths(svg)
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

    test("stroke width matches Supernote's own PDF export (headings-and-marker.pdf's literal `4 w`)", { timeout: 30000 }, async () => {
      // Same page 1 as the previous test: every one of its 32 subpaths is a
      // needle-point-pen stroke at the same width setting, and the PDF's own
      // content stream draws every one of them with a literal `4 w` (4
      // page-pixel line width -- headings-and-marker.pdf's MediaBox is the
      // page's own pixel space, see plans/vector-format-spec.md's "thickness
      // field" section).
      //
      // Widths are measured per stroke from its own rendered outline
      // (strokeRenderWidth) rather than taken from the nominal thickness
      // setting, so they cluster around 4 rather than all sitting exactly
      // on it -- real strokes narrow with pressure, and this export style
      // draws every stroke at one `w` precisely because it *can't* express
      // that. So the median is what's comparable to the PDF's figure; the
      // spread below it is real ink, not error.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/headings-and-marker.pdf"))
      const page1Stream = pdfStreams[0].toString("latin1")
      const pdfWidths = [...new Set([...page1Stream.matchAll(/([\d.]+) w\b/g)].map((m) => Number(m[1])))]
      expect(pdfWidths).toEqual([4])

      const sn = new SupernoteX(await readFileToUint8Array("headings-and-marker.note"))
      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const widths = svgInkWidths(svg).sort((a, b) => a - b)
      expect(widths.length).toBe(32)

      const median = widths[Math.floor(widths.length / 2)]
      expect(median).toBeGreaterThan(pdfWidths[0] * 0.85)
      expect(median).toBeLessThan(pdfWidths[0] * 1.15)
      // and no individual stroke is wildly off -- in particular none is
      // double, which is what summing a letter's inner hole as if it were
      // more ink used to do to every `e`/`o`/`a` (see signedRingArea).
      expect(widths[0]).toBeGreaterThan(pdfWidths[0] * 0.5)
      expect(widths[widths.length - 1]).toBeLessThan(pdfWidths[0] * 1.5)
    })

    test("measured stroke widths match the widths the device states outright, across its whole width range (stroke-isolation.pdf p4)", { timeout: 30000 }, async () => {
      // The strongest width ground truth available. stroke-isolation.note's
      // page 4 is one needle-pen stroke per width setting (1.0, 0.6, 0.3,
      // 0.1), and Supernote's own export writes that page as stroked
      // polylines carrying explicit `w` operators -- so the device states
      // each width as a number rather than drawing an outline to measure.
      //
      // strokeRenderWidth derives its widths from each stroke's own contour
      // without consulting the pen or the thickness setting, and lands on
      // all four to within 1%. That is what says the measurement is right
      // in absolute terms, not merely self-consistent -- and it is why no
      // correction factor is applied to it: the ~16% by which our widths
      // sit under the device's *filled outline* exports (see the residual
      // note in plans/vector-format-spec.md) is a property of those
      // outlines, not of the width.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/stroke-isolation.pdf"))
      const deviceWidths = [...pdfStreams[3].toString("latin1").matchAll(/([\d.]+) w\b/g)].map((m) => Number(m[1]))
      expect(deviceWidths).toEqual([12, 7, 4, 2])

      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"))
      const [, , , page4] = await toSvg(sn, { vectorInk: true })
      const ourWidths = svgInkWidths(page4)
      expect(ourWidths.length).toBe(deviceWidths.length)
      ourWidths.forEach((width, i) => {
        expect(Math.abs(width - deviceWidths[i]) / deviceWidths[i]).toBeLessThan(0.03)
      })
    })

    test("an older ink pen is drawn at its real rendered width, not its much thinner nominal one (a5x-2.14.28.pdf)", { timeout: 30000 }, async () => {
      // a5x-2.14.28.note's page is 146 strokes of the older ink pen
      // (pen=1, thickness=200 -> 2px nominal), and a5x-2.14.28.pdf is
      // Supernote's own vector export of it: 146 filled outlines, one per
      // stroke. Measuring those outlines shows the device actually renders
      // this pen ~4.4px wide, more than twice nominal -- which is why
      // vectorInk output used to look visibly thinner than the same page's
      // raster. strokeRenderWidth measures each stroke's own outline
      // instead, closing most of that gap.
      const pdfBytes = await fs.readFile("tests/input/a5x-2.14.28.pdf")
      const fillCount = (extractPdfFormXObjectStreams(pdfBytes)[0].toString("latin1").match(/(?:^|\s)f(?:\s|$)/g) ?? []).length
      expect(fillCount).toBe(146)

      const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      expect(strokes.length).toBe(fillCount)
      expect(new Set(strokes.map((s) => s.thickness))).toEqual(new Set([200])) // 2px nominal

      const [svg] = await toSvg(sn, { pageNumbers: [1], vectorInk: true })
      const widths = svgInkWidths(svg).sort((a, b) => a - b)
      expect(widths.length).toBe(fillCount)
      const median = widths[Math.floor(widths.length / 2)]
      expect(median).toBeGreaterThan(3) // nominal would put every one of these at 2.0
      expect(median).toBeLessThan(5.5)
    })

    test("erasing among mixed-colour ink doesn't confuse one colour's survival for another's (erase-colors.pdf)", { timeout: 60000 }, async () => {
      // erase-colors.note interleaves grey (158) marker bands with black
      // (0) pen writing and then erases some of each. Deciding what
      // survived matches each stroke's colour against the rendered ink
      // (strokeInkPresence), so this is the page that would catch that
      // matching being too loose -- a grey stroke "surviving" because a
      // black neighbour's ink is nearby, or vice versa.
      //
      // Page 1 has no erasers at all and acts as the control: whatever
      // fraction of the device's ink we draw there is our width accuracy
      // alone. Page 2 is the same content erased, so if the erase
      // decisions were skewing, its ratio would drift away from page 1's.
      // They come out the same.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/erase-colors.pdf"))
      const sn = new SupernoteX(await readFileToUint8Array("erase-colors.note"))
      const svgs = await toSvg(sn, { vectorInk: true })

      const control = svgInkArea(svgs[0]) / pdfFilledArea(pdfStreams[0])
      const erased = svgInkArea(svgs[1]) / pdfFilledArea(pdfStreams[1])
      expect(control).toBeGreaterThan(0.85)
      expect(control).toBeLessThan(1.1)
      expect(Math.abs(erased - control)).toBeLessThan(0.1)

      // page 1 is untouched, so every one of its strokes must survive
      const page1 = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      expect(page1.every((s) => s.trailStatus === undefined)).toBe(true)
      expect(svgInkPaths(svgs[0]).length).toBe(page1.length)

      // and both colours are still drawn on the erased page -- neither got
      // wholly mistaken for the other and dropped
      const drawnColours = new Set(svgInkColors(svgs[1]))
      expect(drawnColours).toContain("rgb(0,0,0)")
      expect([...drawnColours].some((c) => /rgb\(15[0-9],/.test(c))).toBe(true)
    })

    test("a calligraphy pen is drawn far narrower than its nominal width, matching the device's own ink (caligraphy.pdf)", { timeout: 60000 }, async () => {
      // caligraphy.note is three pages of nothing but the calligraphy pen
      // (pen=15) at three width settings, with caligraphy.pdf as Supernote's
      // own vector export. The chisel nib lays down far less ink than its
      // configured width implies, in the opposite direction to the older ink
      // pen: drawing these at nominal width covers ~1.9x the ink the device
      // does, where measuring each stroke's own outline lands at ~0.7-0.85x.
      // Neither is exact, but only one is the right side of the truth, and
      // the error is a third the size.
      const pdfStreams = extractPdfFormXObjectStreams(await fs.readFile("tests/input/caligraphy.pdf"))
      const sn = new SupernoteX(await readFileToUint8Array("caligraphy.note"))
      const svgs = await toSvg(sn, { vectorInk: true })

      for (const pageIndex of [0, 1, 2]) {
        const strokes = parseStrokes(sn.pages[pageIndex].totalPathBuffer, sn.pageWidth, sn.pageHeight)
        const nominalWidth = strokes[0].thickness / 100
        expect(new Set(strokes.map((s) => s.thickness)).size).toBe(1) // one setting per page

        const widths = svgInkWidths(svgs[pageIndex]).sort((a, b) => a - b)
        const median = widths[Math.floor(widths.length / 2)]
        expect(median).toBeGreaterThan(nominalWidth * 0.25)
        expect(median).toBeLessThan(nominalWidth * 0.6)

        // and the total ink drawn tracks the device's own, which drawing at
        // nominal width could not (it would be ~1.9x)
        const deviceArea = pdfFilledArea(pdfStreams[pageIndex])
        const drawnArea = svgInkArea(svgs[pageIndex])
        expect(drawnArea / deviceArea).toBeGreaterThan(0.55)
        expect(drawnArea / deviceArea).toBeLessThan(1.1)

        const nominalArea = strokes.reduce((sum, s) => {
          let length = 0
          for (let i = 1; i < s.points.length; i++)
            length += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y)
          return sum + length * nominalWidth
        }, 0)
        expect(nominalArea / deviceArea).toBeGreaterThan(1.5) // the bug this replaced
      }
    })

    test("caligraphy.note page 4 keeps only the word that survived erasing", { timeout: 30000 }, async () => {
      // Page 4 of that fixture is a whole page of calligraphy erased down to
      // the single word "Erase" -- 19 ink strokes decode, but the device's
      // render and its PDF export both show only the handful that are left.
      const sn = new SupernoteX(await readFileToUint8Array("caligraphy.note"))
      const decoded = parseStrokes(sn.pages[3].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      expect(decoded.length).toBe(19)

      const svgs = await toSvg(sn, { vectorInk: true })
      const inkPaths = svgInkPaths(svgs[3]).filter(({ color }) => color !== "rgb(255,255,255)")
      expect(inkPaths.length).toBe(7)

      const deviceArea = pdfFilledArea(extractPdfFormXObjectStreams(await fs.readFile("tests/input/caligraphy.pdf"))[3])
      const drawnArea = svgInkArea(svgs[3])
      expect(drawnArea / deviceArea).toBeGreaterThan(0.55)
      expect(drawnArea / deviceArea).toBeLessThan(1.1)
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
      const sampledGreys = groupNearDuplicates(
        svgInkColors(svg).map((color) => Number(/rgb\((\d+)/.exec(color)![1])),
      )

      expect(sampledGreys.length).toBe(groundTruthGreys.length)
      for (let i = 0; i < sampledGreys.length; i++) {
        expect(Math.abs(sampledGreys[i] - groundTruthGreys[i])).toBeLessThanOrEqual(NEAR_DUPLICATE_TOLERANCE)
      }
    })

    test("page 2's heading background colors read exact from TITLE_* footer metadata, matching Supernote's own PDF export (headings-and-marker.pdf ground truth, issue #60)", { timeout: 30000 }, async () => {
      // Unlike page 3's marker strokes, page 2's headings are the 2-point
      // 'rect' record TOTALPATH also uses for badges -- and a rect's own
      // color/pen fields aren't meaningful (confirmed against a real
      // fixture: every heading here reads the same uninformative color
      // regardless of its actual, visibly different background -- see
      // StrokeStyle's doc comment). The real color instead lives in the
      // note's own `.note` footer, keyed by TITLE_PPPPYYYYXXXX -- resolving
      // TITLESTYLE (see findMatchingTitleStyle/buildTitleIndex) recovers the
      // exact design palette (0/157/201), with none of the e-ink raster's
      // quantization gap that sampleRect (the pre-issue-#60 fallback, kept
      // for a 2-point rect with no TITLE_* match -- a badge/highlight box
      // that isn't a Heading, though no current fixture in tests/input
      // actually has one without TITLE_* metadata) has.
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

      expect(sampledGreys).toEqual(groundTruthGreys) // exact match, not just relative order
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
          vectorSvgs.flatMap((svg, i) => {
            // Keep every page vectorInk actually handled -- which is the
            // ones whose strokes decoded, the same test toSvg itself uses.
            // Deliberately not "has <path>": a page whose strokes were all
            // erased renders blank *on purpose* (erase-no-white-pen.note),
            // and that is exactly the output worth being able to look at.
            // Pages with nothing to decode fall back to the plain raster
            // and would just duplicate a toSvg() render.
            const vectorized =
              parseStrokes(sn.pages[i].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true }).length > 0
            if (!vectorized) return []
            // Save the device's own rendering of the same page beside it, so
            // every vector output has the thing it's supposed to look like
            // sitting next to it. main.test.ts also writes page rasters, but
            // only for a hand-listed set of fixtures that no new one joins;
            // this covers all of them. It's free: the plain toSvg() render
            // already embeds that raster as a PNG data URI, so it only has
            // to be unwrapped rather than rendered again.
            const embeddedPng = /xlink:href="data:image\/png;base64,([^"]+)"/.exec(rasterSvgs[i])
            return [
              fs.writeFile(`tests/output/${file}.${i}.vector.svg`, svg),
              ...(embeddedPng ? [fs.writeFile(`tests/output/${file}.${i}.device.png`, Buffer.from(embeddedPng[1], "base64"))] : []),
            ]
          }),
        )

        vectorSvgs.forEach((svg, i) => {
          expect(svg.startsWith("<svg ")).toBe(true)
          expect(svg.endsWith("</svg>")).toBe(true)
          expect(svg).toContain("<image ")

          const hasPaths = svg.includes("<path ")
          // A page vectorInk didn't (fully) decode must fall back to
          // exactly the plain raster render for that page, not some
          // in-between state missing ink. This holds for an all-erased
          // page too: its ink layers are empty, so stripping them changes
          // nothing and the blank vector render *is* the raster render.
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

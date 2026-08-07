import * as fs from "fs-extra"
import { encodePng } from "image-js"
import { toSvg, addSvgPage } from "../src/svg"
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
})

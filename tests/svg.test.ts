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
  })

  test("handles a user-uploaded background template and unencodable recognition glyphs", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("moonchild-user-bg-and-bad-glyph.note"))
    const svgs = await toSvg(sn)
    expect(svgs.length).toBe(sn.pages.length)

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

  test("positions recognized text proportionally to pageWidth on a non-Manta device (pageWidth 1404, e.g. A5X)", { timeout: 30000 }, async () => {
    // rtr.note (used elsewhere in this file) is a Manta-family capture
    // (pageWidth 1920, where the 11.9 reference scale applies directly);
    // this fixture is the far more common non-Manta case that exposed
    // https://github.com/philips/supernote-obsidian-plugin/pull/206 -
    // applying the fixed 11.9 scale here would overscale every box,
    // landing "Subject" well below its actual line.
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
    expect(sn.pageWidth).toBe(1404)

    const [svg] = await toSvg(sn, { pageNumbers: [1] })

    const match = svg.match(/<text x="[^"]*" y="([^"]*)"[^>]*>Subject<\/text>/)
    expect(match).not.toBeNull()
    const actualY = Number(match![1])

    // From the raw recognition data: "Subject" has bounding-box
    // { x: 12.776001, y: 13.224001, width: 25.072002, height: 9.84 },
    // and addSvgPage positions the baseline at (box.y + box.height) * scale.
    const scale = recognitionCoordinateScale(sn.pageWidth)
    const expectedY = (13.224001 + 9.84) * scale
    const wrongY = (13.224001 + 9.84) * 11.9 // what the old fixed-11.9 bug would have produced

    expect(actualY).toBeCloseTo(expectedY, 1)
    expect(Math.abs(actualY - wrongY)).toBeGreaterThan(20)
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

import * as fs from "fs-extra"
import { encodePng } from "image-js"
import { toPdf, createPdfContext, addPdfPage, addTextOnlyPdfPage, recognitionCoordinateScale } from "../src/pdf"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import { PDFParse } from "pdf-parse"
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

describe("pdf", () => {
  test("generates a searchable PDF with an RTR text layer", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const pdfBytes = await toPdf(sn)
    await fs.writeFile("tests/output/rtr.note.pdf", pdfBytes)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()

    for (const word of ["Real", "time", "recognition", "paragraph", "reflow", "together"]) {
      expect(result.text).toContain(word)
    }
  })

  test("handles a note with recognition data from a nomad device", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()
    expect(result.text).not.toBeUndefined()
  })

  test("handles a note with no recognition data without throwing", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"))
    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)
  })

  test("handles a user-uploaded background template and unencodable recognition glyphs", { timeout: 30000 }, async () => {
    // Regression fixture trimmed from a real note that hit two bugs together:
    // (1) a user-uploaded PNG background template that decodes to 8-bit RGB
    //     with no alpha channel, which compositeImages() previously rejected
    //     (it requires 8-bit RGBA); and
    // (2) recognized handwriting containing characters (e.g. "→") the default
    //     Helvetica font can't encode, which previously aborted the whole PDF.
    const sn = new SupernoteX(await readFileToUint8Array("moonchild-user-bg-and-bad-glyph.note"))
    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()

    for (const word of ["Saturn", "Mercury", "Moon", "MAGUS"]) {
      expect(result.text).toContain(word)
    }
  })

  test("toPdf() produces text equivalent to manual createPdfContext + addPdfPage composition", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))

    const viaToPdf = await toPdf(sn)

    const ctx = await createPdfContext()
    const images = await toImage(sn)
    for (let i = 0; i < sn.pages.length; i++) {
      await addPdfPage(ctx, sn.pages[i], images[i])
    }
    const viaManualComposition = await ctx.pdfDoc.save()

    const parserA = new PDFParse({ data: viaToPdf })
    const textA = await parserA.getText()
    await parserA.destroy()

    const parserB = new PDFParse({ data: viaManualComposition })
    const textB = await parserB.getText()
    await parserB.destroy()

    expect(textA.text).toBe(textB.text)
  })

  test("addPdfPage accepts either an Image or pre-encoded PNG bytes with equivalent output", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const [image] = await toImage(sn, [1])

    const ctxWithImage = await createPdfContext()
    await addPdfPage(ctxWithImage, sn.pages[0], image)
    const pdfFromImage = await ctxWithImage.pdfDoc.save()

    const ctxWithBytes = await createPdfContext()
    await addPdfPage(ctxWithBytes, sn.pages[0], encodePng(image))
    const pdfFromBytes = await ctxWithBytes.pdfDoc.save()

    const parserA = new PDFParse({ data: pdfFromImage })
    const textA = await parserA.getText()
    await parserA.destroy()

    const parserB = new PDFParse({ data: pdfFromBytes })
    const textB = await parserB.getText()
    await parserB.destroy()

    expect(textA.text).toBe(textB.text)
  })

  test("addTextOnlyPdfPage produces the same searchable text as addPdfPage, without embedding an image", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr.note"))
    const images = await toImage(sn)

    const ctxWithImage = await createPdfContext()
    for (let i = 0; i < sn.pages.length; i++) {
      await addPdfPage(ctxWithImage, sn.pages[i], images[i])
    }
    const pdfWithImage = await ctxWithImage.pdfDoc.save()

    const ctxTextOnly = await createPdfContext()
    for (let i = 0; i < sn.pages.length; i++) {
      await addTextOnlyPdfPage(ctxTextOnly, sn.pages[i], sn.pageWidth, sn.pageHeight)
    }
    const pdfTextOnly = await ctxTextOnly.pdfDoc.save()

    // No image data to encode/compress/embed, so this should be dramatically
    // smaller than the equivalent PDF with real page images — not just a
    // marginal difference — since that's the entire point of this function.
    expect(pdfTextOnly.byteLength).toBeLessThan(pdfWithImage.byteLength / 10)

    const parserA = new PDFParse({ data: pdfWithImage })
    const textA = await parserA.getText()
    await parserA.destroy()

    const parserB = new PDFParse({ data: pdfTextOnly })
    const textB = await parserB.getText()
    await parserB.destroy()

    expect(textB.text).toBe(textA.text)
    for (const word of ["Real", "time", "recognition", "paragraph", "reflow", "together"]) {
      expect(textB.text).toContain(word)
    }
  })

  test("recognitionCoordinateScale scales proportionally to pageWidth, not a fixed 11.9, for non-Manta devices", () => {
    // 11.9 only holds at the 1920px-wide reference page (Manta-family
    // devices); every narrower page (e.g. A5X's default 1404) needs it
    // scaled down proportionally, or recognized-word positions drift
    // further from the actual ink the further down the page a word sits.
    // See https://github.com/philips/supernote-obsidian-plugin/pull/206.
    expect(recognitionCoordinateScale(1920)).toBeCloseTo(11.9)
    expect(recognitionCoordinateScale(1404)).toBeCloseTo((1404 * 11.9) / 1920)
  })

  test("handles a note from a non-Manta device (pageWidth 1404, e.g. A5X) without throwing", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
    expect(sn.pageWidth).toBe(1404)

    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()
    expect(result.text).toContain("Subject")
  })
})

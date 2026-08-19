import * as fs from "fs-extra"
import { encodePng } from "image-js"
import { toPdf, createPdfContext, addPdfPage, addTextOnlyPdfPage, recognitionCoordinateScale } from "../src/pdf"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import { toSvg } from "../src/svg"
import { PDFParse } from "pdf-parse"
import { PDFDocument, PDFRawStream } from "pdf-lib"
import { inflateSync } from "node:zlib"
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

function getPageContentString(pdf: PDFDocument, pageIndex: number): string {
  const page = pdf.getPage(pageIndex)
  const contents = page.node.Contents()
  if (!contents) return ''
  const streamRef = contents.get(0)
  const stream = pdf.context.lookup(streamRef) as PDFRawStream
  return inflateSync(Buffer.from(stream.contents)).toString('latin1')
}

describe("pdf", () => {
  test("generates a searchable PDF with an RTR text layer", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))
    const pdfBytes = await toPdf(sn)
    await fs.writeFile("tests/output/rtr-n5-20230015-recognition.note.pdf", pdfBytes)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()

    for (const word of ["Real", "time", "recognition", "paragraph", "reflow", "together"]) {
      expect(result.text).toContain(word)
    }
  })

  test("handles a note with recognition data from a nomad device", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("blank-a6x-3.15.27-shapes-rtr.note"))
    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()
    expect(result.text).not.toBeUndefined()
  })

  test("handles a note with no recognition data without throwing", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test-a5x-20220011-old-pen-ids.note"))
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
    const sn = new SupernoteX(await readFileToUint8Array("render-n6-20230015-moonchild-user-bg.note"))
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
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))

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
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))
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
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))
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

  test("recognitionCoordinateScale is device-family-aware: A5X uses the 1920 reference canvas, every other family uses its own native pageWidth", () => {
    // The recognition canvas is a FIXED per-device constant (it does NOT
    // scale with an upscaled render): 1920 for Manta (N5) AND A5X, and the
    // device's own native pageWidth for N6/A6X (1404). So the scale is
    // renderWidth * 11.9 / canvasWidth.
    //
    // - A5X (native 1404) is the only known device whose canvas (1920)
    //   differs from its pageWidth: scale = render * 11.9 / 1920, so at
    //   native resolution 1404*11.9/1920 ≈ 8.70 (philips/supernote-obsidian-plugin#204
    //   - a fixed 11.9 landed highlights a full page below the ink).
    // - N6/A6X (native 1404) render recognition natively at 1404, so the
    //   correct scale at native resolution is the raw 11.9, NOT shrunk by
    //   1404/1920 (philips/supernote-obsidian-plugin#219 - the old shrink pulled
    //   their boxes to ~8.70 when they line up at 11.9).
    // - N5/Manta (native 1920): 11.9 at native resolution.
    //
    // nativePageWidth (3rd arg) only matters when renderWidth differs from
    // the native pageWidth (i.e. upscale > 1): then it's needed to recover
    // the canvas for non-A5X devices, since renderWidth alone can't.
    expect(recognitionCoordinateScale(1920, 'N5', 1920)).toBeCloseTo(11.9)
    expect(recognitionCoordinateScale(1404, 'A5X', 1404)).toBeCloseTo((1404 * 11.9) / 1920)
    // N6 and A6X: canvas == native pageWidth, so the raw 11.9 at native res:
    expect(recognitionCoordinateScale(1404, 'N6', 1404)).toBeCloseTo(11.9)
    expect(recognitionCoordinateScale(1404, 'A6X', 1404)).toBeCloseTo(11.9)
    // Upscale grows the scale (canvas is fixed, renderWidth doubles):
    expect(recognitionCoordinateScale(1920 * 2, 'N5', 1920)).toBeCloseTo(11.9 * 2)
    expect(recognitionCoordinateScale(1404 * 2, 'N6', 1404)).toBeCloseTo(11.9 * 2)
    expect(recognitionCoordinateScale(1404 * 2, 'A5X', 1404)).toBeCloseTo((1404 * 2 * 11.9) / 1920)
    // nativePageWidth defaults to renderWidth (i.e. no upscale) when omitted:
    expect(recognitionCoordinateScale(1404, 'N6')).toBeCloseTo(11.9)
    // Omitting equipment keeps the legacy 1920-reference-canvas behavior so
    // direct addPdfPage()/addSvgPage() callers that don't pass it get
    // unchanged pre-#219 output (correct only for A5X/Manta):
    expect(recognitionCoordinateScale(1404)).toBeCloseTo((1404 * 11.9) / 1920)
    expect(recognitionCoordinateScale(1920)).toBeCloseTo(11.9)
  })

  test("toPdf({ vectorInk: true }) renders the searchable text layer unchanged", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))
    const pdfBytes = await toPdf(sn, { vectorInk: true })
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()

    for (const word of ["Real", "time", "recognition", "paragraph", "reflow", "together"]) {
      expect(result.text).toContain(word)
    }
  })

  test("toPdf({ vectorInk: true }) draws ink as vector paths instead of embedding it in the page image", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("ink-a5x-2.14.28-old-pen-width.note"))
    const pdfBytes = await toPdf(sn, { vectorInk: true })
    const pdf = await PDFDocument.load(pdfBytes)
    const content = getPageContentString(pdf, 0)

    // A vector-ink page emits PDF path construction operators (`m` for
    // moveto). A plain raster page only embeds the image with `Do`.
    expect(content).toMatch(/\b\d+(\.\d+)? \d+(\.\d+)? m\b/)
  })

  test("vectorInk PDF and SVG use the same vector-ink pipeline", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test-a5x-20220011-old-pen-ids.note"))
    const [svg] = await toSvg(sn, { vectorInk: true, includeText: false })
    const pdfBytes = await toPdf(sn, { vectorInk: true })
    const pdf = await PDFDocument.load(pdfBytes)
    const content = getPageContentString(pdf, 0)

    // Both outputs should contain vector primitives. Counting exact
    // primitives is backend-specific, so we just assert both succeeded and
    // both contain visible path data.
    expect(svg).toContain('<path')
    expect(svg).toContain('</svg>')
    expect(content).toMatch(/\b\d+(\.\d+)? \d+(\.\d+)? m\b/)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)
  })

  test("handles a note from a non-Manta device (pageWidth 1404, e.g. A5X) without throwing", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("ink-a5x-2.14.28-old-pen-width.note"))
    expect(sn.pageWidth).toBe(1404)

    const pdfBytes = await toPdf(sn)
    expect(pdfBytes.byteLength).toBeGreaterThan(0)

    const parser = new PDFParse({ data: pdfBytes })
    const result = await parser.getText()
    await parser.destroy()
    expect(result.text).toContain("Subject")
  })

  test("toPdf({ vectorInk: true, upscale: 2 }) renders without throwing", { timeout: 60000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("ink-a5x-2.14.28-old-pen-width.note"))
    const pdfBytes = await toPdf(sn, { vectorInk: true, upscale: 2 })
    expect(pdfBytes.byteLength).toBeGreaterThan(0)
  })
})

import * as fs from "fs-extra"
import { toPdf } from "../src/pdf"
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
})

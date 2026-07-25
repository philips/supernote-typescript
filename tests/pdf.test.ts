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
})

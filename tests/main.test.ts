import * as fs from "fs-extra"
import { toSharp } from "../src/conversion"
import { SupernoteX } from "../src/parsing"

async function getNoteBuffer(): Promise<Buffer> {
  return await fs.readFile("tests/input/test.note")
}

describe("smoke", () => {
  it("opens the test note", async () => {
    let buf = await getNoteBuffer()
    expect(buf.byteLength).toEqual(263119)
  })

  it("should decode an int", () => {
    let buf = Buffer.from([0x12, 0x34, 0x56, 0x78])
    let num = buf.readUIntLE(0, 4)
    expect(num).toEqual(2018915346)
  })

  it("should parse a Supernote X file", async () => {
    let sn = new SupernoteX(await getNoteBuffer())
    expect(sn).not.toBeUndefined()
  })

  it("convert a note to png pages", async () => {
    let sn = new SupernoteX(await getNoteBuffer())
    let images = await toSharp(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.toFile(`tests/output/${index}.png`)
    }
  }, 30000)
})

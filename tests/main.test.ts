import * as fs from "fs-extra"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"

async function getNoteBuffer(name: string): Promise<Buffer> {
  return await fs.readFile(`tests/input/${name}`)
}

describe("smoke", () => {
  it("opens the test note", async () => {
    let buf = await getNoteBuffer("test.note")
    expect(buf.byteLength).toEqual(263119)
  })

  it("should decode an int", () => {
    let buf = Buffer.from([0x12, 0x34, 0x56, 0x78])
    let num = buf.readUIntLE(0, 4)
    expect(num).toEqual(2018915346)
  })

  it("should parse a Supernote X file", async () => {
    let sn = new SupernoteX(await getNoteBuffer("test.note"))
    expect(sn).not.toBeUndefined()
  })

  it("convert a simple note to png pages", async () => {
    let sn = new SupernoteX(await getNoteBuffer("test.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/${index}.png`)
    }
  }, 30000)

  it("convert a note from a nomad Chauvet 3.15.27 to png pages", async () => {
    let sn = new SupernoteX(await getNoteBuffer("nomad-3.15.27-blank-2p.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/${index}.png`)
    }
  }, 30000)

  it("convert a note from a nomad Chauvet 3.15.27 with handwriting recognition to png pages", async () => {
    let sn = new SupernoteX(await getNoteBuffer("nomad-3.15.27-blank-shapes-and-RTR.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/${index}.png`)
    }
  }, 30000)
})

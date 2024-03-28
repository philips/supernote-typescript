import * as fs from "fs-extra"
import { fetchMirrorFrame } from "../src/mirror"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import http from 'http';

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

describe("smoke", () => {
  it("opens the test note", async () => {
    let buf = await readFileToUint8Array("test.note")
    expect(buf.byteLength).toEqual(263119)
  })

  it("should decode an int", () => {
    let buf = Buffer.from([0x12, 0x34, 0x56, 0x78])
    let num = buf.readUIntLE(0, 4)
    expect(num).toEqual(2018915346)
  })

  it("should parse a Supernote X file", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("test.note"))
    expect(sn).not.toBeUndefined()
  })
})

describe("image", () => {
  it("convert a simple note to png pages", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("test.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/test.note-${index}.png`)
    }
  }, 30000)
})

describe("nomad", () => {
  it("convert a note from a nomad Chauvet 3.15.27 to png pages", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-2p.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/nomad-3.15.27-blank-2p.note-${index}.png`)
    }
  }, 30000)

  it("convert a note from a nomad Chauvet 3.15.27 with handwriting recognition to png pages", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/nomad-3.15.27-blank-shapes-and-RTR.note-${index}.png`)
    }
  }, 30000)
})

describe("A5X", () => {
  it("convert a note from a A5X with Chauvet 2.14.28 to png pages", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"))
    let images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await image.save(`tests/output/a5x-2.14.28.note-${index}.png`)
    }
  }, 30000)
})

const TEST_PORT = 8080;

function base64ToUint8Array(base64String: string): Uint8Array {
  const binaryString = atob(base64String);
  const length = binaryString.length;
  const uint8Array = new Uint8Array(length);
  for (let i = 0; i < length; ++i) {
      uint8Array[i] = binaryString.charCodeAt(i);
  }
  return uint8Array;
}

// Minimal PNG image encoded in base64
const encodedImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4AWNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==";
const buffer = base64ToUint8Array(encodedImage);
const testServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--BOUNDARY');
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${encodedImage.length}\r\n`);
    res.write(`\r\n`);
    res.write(buffer);
    res.write(`--BOUNDARY\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${encodedImage.length}\r\n`);
    res.write(`\r\n`);
    res.write(buffer);
    res.write(`--BOUNDARY--`);
    res.end();
});

beforeAll(() => {
    testServer.listen(TEST_PORT);
});

afterAll(() => {
    testServer.close();
});

describe("mirror", () => {
  it("download a frame off the mirroring service", async () => {
    let ipport = `localhost:${TEST_PORT}`;
    if (process.env.MIRROR_IPPORT) {
      ipport = process.env.MIRROR_IPPORT;
    }
    const image = await fetchMirrorFrame(ipport);
    expect(image).toBeDefined();
    await image.save(`tests/output/mirror.jpg`)
  }, 30000)
})
import * as fs from "fs-extra"
import * as imagejs from "image-js"
import { Image, ImageColorModel } from "image-js"
import { describe, test, expect } from 'vitest'
import { toImage, RattaRLEDecoder, flattenToWhite } from "../src/conversion"
import { SupernoteX } from "../src/parsing"

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

describe("RattaRLEDecoder.decodeAtScale", () => {
  test("nearest-neighbor samples a hand-crafted 4x4 buffer down to 2x2", () => {
    const decoder = new RattaRLEDecoder();
    // width=4, height=4. Rows alternate which columns are black/white (row0,
    // row2) vs. a filler color (row1, row3, not sampled at factor 2) so the
    // expected 2x2 output is a deterministic checkerboard:
    //   row0: black black | white white   (cols 0-1 black, 2-3 white)
    //   row1: gray  gray  | gray  gray    (uniform filler, unsampled)
    //   row2: white white | black black   (cols 0-1 white, 2-3 black)
    //   row3: darkGray x4                 (uniform filler, unsampled)
    // Byte pairs are (color, lengthByte), where lengthByte = runLength - 1
    // for a simple (non-extended) run.
    const black = 0x61, white = 0x65, gray = 0x64, darkGray = 0x63;
    const buffer = new Uint8Array([
      black, 1, white, 1, // row0: 2 black, 2 white
      gray, 3,            // row1: 4 gray
      white, 1, black, 1, // row2: 2 white, 2 black
      darkGray, 3,         // row3: 4 darkGray
    ]);

    const { data, width, height } = decoder.decodeAtScale(buffer, 4, 4, 2);
    expect(width).toBe(2);
    expect(height).toBe(2);

    const image = new imagejs.Image(width, height, { colorModel: imagejs.ImageColorModel.RGBA, data });
    expect(image.getPixel(0, 0)).toEqual([0, 0, 0, 255]); // sampled from row0 col0: black
    expect(image.getPixel(1, 0)).toEqual([255, 255, 255, 255]); // row0 col2: white
    expect(image.getPixel(0, 1)).toEqual([255, 255, 255, 255]); // row2 col0: white
    expect(image.getPixel(1, 1)).toEqual([0, 0, 0, 255]); // row2 col2: black
  })

  test("factor 1 matches decode() exactly, byte-for-byte, on a real layer's buffer", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const layer = sn.pages[0].MAINLAYER;
    expect(layer.bitmapBuffer).not.toBeNull();

    const decoder = new RattaRLEDecoder();
    const full = decoder.decode(layer.bitmapBuffer!, sn.pageWidth, sn.pageHeight);
    const atScale = decoder.decodeAtScale(layer.bitmapBuffer!, sn.pageWidth, sn.pageHeight, 1);

    expect(atScale.width).toBe(sn.pageWidth);
    expect(atScale.height).toBe(sn.pageHeight);
    // These buffers are several MB (a full page at 8 bits/channel RGBA) --
    // vitest's toEqual() does a generic, per-element deep-equal on typed
    // arrays that's wildly expensive (and can OOM) at this size. Buffer.compare
    // is a fast native byte comparison instead.
    const same = Buffer.compare(Buffer.from(full.buffer, full.byteOffset, full.length), Buffer.from(atScale.data.buffer, atScale.data.byteOffset, atScale.data.length)) === 0;
    expect(same).toBe(true);
  })

  test("factor N matches a naive nearest-neighbor downsample of decode()'s full output, on a real layer's buffer", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const layer = sn.pages[0].MAINLAYER;
    expect(layer.bitmapBuffer).not.toBeNull();

    const factor = 5; // deliberately doesn't evenly divide pageWidth/pageHeight
    const decoder = new RattaRLEDecoder();
    const full = decoder.decode(layer.bitmapBuffer!, sn.pageWidth, sn.pageHeight);
    const fullPixels = new Uint32Array(full.buffer, full.byteOffset, full.length / 4);

    const atScale = decoder.decodeAtScale(layer.bitmapBuffer!, sn.pageWidth, sn.pageHeight, factor);
    const outPixels = new Uint32Array(atScale.data.buffer, atScale.data.byteOffset, atScale.data.length / 4);

    expect(atScale.width).toBe(Math.ceil(sn.pageWidth / factor));
    expect(atScale.height).toBe(Math.ceil(sn.pageHeight / factor));

    // Collect mismatches instead of asserting per-pixel (tens of thousands
    // of individual expect() calls in a hot loop adds up) -- a single
    // assertion at the end with a useful failure message if anything's off.
    const mismatches: string[] = [];
    for (let oy = 0; oy < atScale.height && mismatches.length < 5; oy++) {
      for (let ox = 0; ox < atScale.width && mismatches.length < 5; ox++) {
        const sx = ox * factor, sy = oy * factor;
        const expected = fullPixels[sy * sn.pageWidth + sx];
        const actual = outPixels[oy * atScale.width + ox];
        if (actual !== expected) {
          mismatches.push(`(${ox}, ${oy}): expected ${expected.toString(16)}, got ${actual.toString(16)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  })

  test("rejects a non-positive-integer factor", () => {
    const decoder = new RattaRLEDecoder();
    const buffer = new Uint8Array([0x61, 0]);
    expect(() => decoder.decodeAtScale(buffer, 1, 1, 0)).toThrow(RangeError);
    expect(() => decoder.decodeAtScale(buffer, 1, 1, 1.5)).toThrow(RangeError);
    expect(() => decoder.decodeAtScale(buffer, 1, 1, -1)).toThrow(RangeError);
  })
})

describe("flattenToWhite", () => {
  test("blends toward white by alpha, not just dropping the alpha channel", () => {
    // Pixel 0: fully-transparent background, packed as black+alpha 0 (see
    // RattaRLEDecoder.buildPackedTranslation) - must come out white, not
    // black, or a PDF/PNG export with no alpha channel to fall back on would
    // show ink-black everywhere nothing was actually drawn.
    // Pixel 1: fully-opaque red ink - unchanged.
    // Pixel 2: 50%-alpha black (an anti-aliased edge) - should land roughly
    // halfway to white, not stay black.
    const data = new Uint8Array([
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 0, 0, 128,
    ]);
    const image = new Image(3, 1, { colorModel: ImageColorModel.RGBA, data });

    const flattened = flattenToWhite(image);

    expect(flattened.colorModel).toBe('RGB');
    expect(flattened.alpha).toBe(false);
    expect(Array.from(flattened.getPixel(0, 0))).toEqual([255, 255, 255]);
    expect(Array.from(flattened.getPixel(1, 0))).toEqual([255, 0, 0]);
    const [r, g, b] = flattened.getPixel(2, 0);
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThan(100);
      expect(channel).toBeLessThan(155);
    }
  })

  test("returns the same image unchanged when it has no alpha channel", () => {
    const data = new Uint8Array([10, 20, 30]);
    const image = new Image(1, 1, { colorModel: ImageColorModel.RGB, data });
    expect(flattenToWhite(image)).toBe(image);
  })
})

describe("toImage scale option", () => {
  test("renders a downscaled page directly, without decoding at full resolution first", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"));
    const scale = 10;
    const images = await toImage(sn, [1], { scale });
    expect(images.length).toBe(1);
    expect(images[0].width).toBe(Math.ceil(sn.pageWidth / scale));
    expect(images[0].height).toBe(Math.ceil(sn.pageHeight / scale));
    await imagejs.writeSync(`tests/output/scaled-thumbnail.png`, images[0]);
  })

  test("scale: 1 (default) still matches the previous full-resolution output size", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const [withoutOptions] = await toImage(sn, [1]);
    const [withScale1] = await toImage(sn, [1], { scale: 1 });
    expect(withoutOptions.width).toBe(sn.pageWidth);
    expect(withoutOptions.height).toBe(sn.pageHeight);
    expect(withScale1.width).toBe(sn.pageWidth);
    expect(withScale1.height).toBe(sn.pageHeight);
  })

  test("rejects a non-positive-integer scale", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    // toImage validates scale synchronously (before ever returning a
    // promise), so this throws immediately rather than rejecting.
    expect(() => toImage(sn, [1], { scale: 0 })).toThrow(RangeError);
  })
})

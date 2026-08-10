import * as fs from "fs-extra"
import { describe, test, expect } from 'vitest'
import { parseStrokes } from "../src/strokes"
import { SupernoteX } from "../src/parsing"
import { RattaRLEDecoder } from "../src/conversion"

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

/** Bounding box of a page's rendered ink (MAINLAYER), used as ground truth
 * to check decoded stroke points land inside real ink rather than drifting
 * off to an unrelated part of the page. */
function inkBoundingBox(bitmapBuffer: Uint8Array, width: number, height: number) {
  const decoder = new RattaRLEDecoder();
  const pixels = decoder.decode(bitmapBuffer, width, height);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (pixels[idx + 3] > 0 && pixels[idx] < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

describe("parseStrokes", () => {
  test("returns [] for a null buffer", () => {
    expect(parseStrokes(null, 1404, 1872)).toEqual([]);
  });

  test("returns [] for a buffer too short to hold a preamble", () => {
    expect(parseStrokes(new Uint8Array(10), 1404, 1872)).toEqual([]);
  });

  test("decodes a simple horizontal stroke to a wide, flat point cloud", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("20260809_162804.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    expect(strokes.length).toBeGreaterThan(0);

    const points = strokes.flatMap((s) => s.points);
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    // a horizontal stroke should span much more width than height
    expect(width).toBeGreaterThan(height * 3);

    // every decoded point should land inside (a small margin around) the
    // page's own rendered ink, not drift off onto unrelated content
    const bbox = inkBoundingBox(page.MAINLAYER.bitmapBuffer as Uint8Array, sn.pageWidth, sn.pageHeight);
    const margin = 15;
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(bbox.minX - margin);
      expect(p.x).toBeLessThanOrEqual(bbox.maxX + margin);
      expect(p.y).toBeGreaterThanOrEqual(bbox.minY - margin);
      expect(p.y).toBeLessThanOrEqual(bbox.maxY + margin);
    }
  });

  test("decodes a simple vertical stroke to a tall, narrow point cloud", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("20260809_162804.note"));
    const page = sn.pages[1];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    expect(strokes.length).toBeGreaterThan(0);

    const points = strokes.flatMap((s) => s.points);
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(height).toBeGreaterThan(width * 3);
  });

  test("decodes both diagonal strokes with a roughly 1:1 aspect ratio", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("20260809_162804.note"));
    for (const pageIndex of [2, 3]) {
      const page = sn.pages[pageIndex];
      const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
      expect(strokes.length).toBeGreaterThan(0);

      const points = strokes.flatMap((s) => s.points);
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      const ratio = width / height;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
    }
  });

  test("decodes a full paragraph of dense real handwriting with every point inside rendered ink", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);

    // this page is dense, real prose -- well over a hundred separate
    // pen-down strokes across all the letters (146 uint32-coordinate ones
    // on this fixture; a small minority of real strokes use a float32
    // encoding parseStrokes doesn't decode, per its doc comment, so this
    // isn't necessarily literally every stroke on the page).
    expect(strokes.length).toBeGreaterThan(100);
    const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);
    expect(totalPoints).toBeGreaterThan(5000);

    const bbox = inkBoundingBox(page.MAINLAYER.bitmapBuffer as Uint8Array, sn.pageWidth, sn.pageHeight);
    const margin = 15;
    let outsideCount = 0;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        if (p.x < bbox.minX - margin || p.x > bbox.maxX + margin || p.y < bbox.minY - margin || p.y > bbox.maxY + margin) {
          outsideCount++;
        }
      }
    }
    expect(outsideCount).toBe(0);
  });

  test("decodes quickly even on a dense page (no per-stroke search)", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"));
    const page = sn.pages[0];
    const start = Date.now();
    parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("skips a known float32-coordinate stroke rather than placing it wrong", async () => {
    // The stroke starting at byte offset 1484 of this page's TOTALPATH is a
    // real, confirmed float32-coordinate stroke (found during the format
    // investigation in issue #55) that this decoder can't yet map to the
    // right position -- landmark search should skip straight past it to the
    // next real (uint32) stroke rather than emitting a wrong guess.
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"));
    const page = sn.pages[0];
    const bbox = inkBoundingBox(page.MAINLAYER.bitmapBuffer as Uint8Array, sn.pageWidth, sn.pageHeight);
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const margin = 15;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        expect(p.x).toBeGreaterThanOrEqual(bbox.minX - margin);
        expect(p.x).toBeLessThanOrEqual(bbox.maxX + margin);
      }
    }
  });

  test("recovers a real record that a landmark-offset mismatch used to cause the scan to skip over (issue #56)", async () => {
    // Not every `superNoteNote` landmark occurrence is followed by a real
    // record at the usual 76-byte offset -- some are followed by a
    // differently-shaped metadata block instead. Before this decoder
    // switched to a byte-by-byte scan, hitting one of those caused it to
    // jump straight to the *next* landmark occurrence, silently skipping
    // everything in between -- including, on this fixture's page 0, a real
    // 243-point record sitting just 72 bytes past the landmark at byte
    // 37968 (the next landmark doesn't appear until byte 48128, a ~10KB
    // gap). This fixture used to decode 3860 points across 54 strokes;
    // fixed, it should decode meaningfully more.
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);
    expect(strokes.length).toBeGreaterThan(57);
    expect(totalPoints).toBeGreaterThan(4300);
  });

  test("decodes records with an odd point count (issue #56)", async () => {
    // tryParseAuxiliaryStreams originally assumed the pressure/width stream
    // following a record's coordinates was Math.round(n / 2) uint32 values;
    // it's actually n uint16 values. Both formulas give the same total byte
    // length -- and so the same checksum position -- when n is even, which
    // is how the wrong formula passed validation on every even-length
    // record it was tried against; only an odd n exposes the 2-byte
    // discrepancy. Roughly half of this fixture's strokes have an odd point
    // count, so this also guards against a regression that silently drops
    // them again (this decoder requires the auxiliary streams to validate
    // before accepting a record at all, to keep the byte-by-byte scan safe
    // from false positives -- see parseStrokes' and tryParseRecord's doc
    // comments).
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const oddCountStrokes = strokes.filter((s) => s.points.length % 2 === 1);
    expect(oddCountStrokes.length).toBeGreaterThan(30);
  });

  test("rejects a single-point false match rather than placing a phantom point at the page corner", async () => {
    // A handful of positions across several fixtures satisfy tryParseRecord's
    // count+coordinates+checksum check for n=1 by coincidence, without being
    // real records -- recognizable because every one of them decodes to the
    // exact same point, (pageWidth, 0), the page's top-right corner (the
    // same garbage-decode symptom documented on tryParseRecord for
    // misidentified float32 records). A 0-byte special case for the
    // auxiliary pressure/width stream on n=1 records was tried during the
    // issue #56 investigation specifically to accept these, and reverted
    // once they turned out to be false positives rather than genuine
    // single-point taps -- this guards against reintroducing that.
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const page = sn.pages[1];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const phantomCornerStrokes = strokes.filter(
      (s) => s.points.length === 1 && s.points[0].x === sn.pageWidth && s.points[0].y === 0,
    );
    expect(phantomCornerStrokes.length).toBe(0);
  });
});

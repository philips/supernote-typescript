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

  test("every decoded point stays inside this page's own rendered ink", async () => {
    // Historical note: earlier versions of this decoder found stroke
    // boundaries via a byte-by-byte scan for a self-checksumming record
    // shape, rather than TOTALPATH's real, deterministic outer structure
    // (a stroke count plus a length prefix per stroke -- see parseStrokes'
    // doc comment for how https://github.com/Walnut356/snlib's independent
    // implementation revealed this). That old scan could land inside a
    // stroke's own extended sub-fields and misread real-but-unrelated bytes
    // as an independent (and wrong) stroke, which this fixture specifically
    // exercised. The deterministic walk can't do that -- every stroke's own
    // byte range is exact -- so this now guards general decode correctness
    // rather than one specific old failure mode.
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

  test("decodes this fixture's real stroke/point count in full (issue #56)", async () => {
    // A fixed regression baseline from when this fixture used to decode
    // only 3860 points across 54 strokes (an older scanning decoder
    // sometimes skipped real records entirely -- see the previous test's
    // historical note). The deterministic TOTALPATH walk this decoder now
    // uses (parseStrokes' doc comment) has no such gap: it reads the
    // page's own declared stroke count and each stroke's own byte length
    // directly, so it can't skip a real record the way a scan could.
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);
    expect(strokes.length).toBeGreaterThan(57);
    expect(totalPoints).toBeGreaterThan(4300);
  });

  test("decodes records with an odd point count (issue #56)", async () => {
    // An earlier version of this decoder used a point-count-dependent
    // formula to locate a record's auxiliary data streams that happened to
    // agree with the real layout only for an even point count, silently
    // misreading odd-count records. The current decoder doesn't need to
    // locate those streams at all (each stroke's own outer byte length is
    // authoritative -- see parseStrokes' doc comment), so this now just
    // confirms real odd-point-count strokes (roughly half of this
    // fixture's) decode with the same reliability as even ones.
    const sn = new SupernoteX(await readFileToUint8Array("a5x-2.14.28.note"));
    const page = sn.pages[0];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const oddCountStrokes = strokes.filter((s) => s.points.length % 2 === 1);
    expect(oddCountStrokes.length).toBeGreaterThan(30);
  });

  test("never places a phantom single point at the page corner", async () => {
    // A regression guard from when an earlier, byte-scanning version of
    // this decoder could find a false-positive single-point "record" by
    // coincidence, always decoding to the exact same wrong point,
    // (pageWidth, 0) -- the page's top-right corner. The current decoder
    // can't produce a false stroke this way at all (every stroke comes from
    // TOTALPATH's own declared, exact byte ranges -- see parseStrokes' doc
    // comment), so this now just confirms that symptom stays gone.
    const sn = new SupernoteX(await readFileToUint8Array("test.note"));
    const page = sn.pages[1];
    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    const phantomCornerStrokes = strokes.filter(
      (s) => s.points.length === 1 && s.points[0].x === sn.pageWidth && s.points[0].y === 0,
    );
    expect(phantomCornerStrokes.length).toBe(0);
  });

  test("excludes eraser strokes by default, includes them as white isEraser strokes with includeErasers (issue #56 follow-up)", async () => {
    // horizontal_1270.note's page 1 is exactly the fixture that used to
    // decode eraser motions as smooth-but-nonexistent phantom ink (issue
    // #56) -- it has four real eraser-tool strokes (color 255) covering
    // earlier, now-visually-erased real ink ("writing" corrected to
    // "note"). The default (ink-only) behavior must stay unchanged (every
    // other test in this file, and the exact stroke-count regression test
    // in svg.test.ts, assumes it); includeErasers must add exactly those
    // strokes back, each real-ink-white and flagged.
    const sn = new SupernoteX(await readFileToUint8Array("horizontal_1270.note"));
    const page = sn.pages[0];

    const inkOnly = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
    expect(inkOnly.some((s) => s.isEraser)).toBe(false);

    const withErasers = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true });
    const erasers = withErasers.filter((s) => s.isEraser);
    expect(erasers.length).toBe(4);
    for (const eraser of erasers) {
      expect(eraser.color).toBe("rgb(255,255,255)");
    }
    // includeErasers only adds eraser strokes -- every ink-only stroke must
    // still be present, in the same relative order (erasers interleaved at
    // their own real TOTALPATH position, not appended after).
    expect(withErasers.length).toBe(inkOnly.length + erasers.length);
    expect(withErasers.filter((s) => !s.isEraser)).toEqual(inkOnly);
  });

  test("excludes link-tag indicator boxes unconditionally, ink or not (stroke_kind '0000')", async () => {
    // nomad-3.26.40-link-tag-3p.note's page 2 has three 5-point "link tag"
    // boxes (drawn around linked-note source regions) -- confirmed real via
    // the note's own footer LINK_* metadata: each box's TOTALPATH bounding
    // box matches one LINKRECT pixel-exact. Supernote's own rendered page
    // never shows these (they're a UI affordance, not ink the user drew),
    // so parseStrokes must drop them the same way -- with no opt-in, unlike
    // eraser strokes, since there's no legitimate reason to want them back.
    const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
    const page = sn.pages[1];
    const linkRects = Object.values(sn.links)
      .flat()
      .map((link) => link.LINKRECT.split(",").map(Number));
    expect(linkRects.length).toBeGreaterThan(0);

    const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeErasers: true });
    for (const [x, y, width, height] of linkRects) {
      const matchesLinkRect = strokes.some((stroke) => {
        if (stroke.points.length !== 5) return false;
        const xs = stroke.points.map((p) => p.x), ys = stroke.points.map((p) => p.y);
        const strokeX = Math.min(...xs), strokeY = Math.min(...ys);
        const strokeWidth = Math.max(...xs) - strokeX, strokeHeight = Math.max(...ys) - strokeY;
        return (
          Math.abs(strokeX - x) <= 2 &&
          Math.abs(strokeY - y) <= 2 &&
          Math.abs(strokeWidth - width) <= 2 &&
          Math.abs(strokeHeight - height) <= 2
        );
      });
      expect(matchesLinkRect).toBe(false);
    }
  });

  test("excludes lasso selection paths unconditionally (pen=4)", async () => {
    // erase.note ends with a lasso-select-then-delete: the selection loop
    // is recorded as two byte-identical pen=4 records (color 0,
    // thickness 200) that the device never renders -- absent from both the
    // device raster and erase.pdf (Supernote's own vector export). The same
    // record type also appears where a lasso selection did NOT delete
    // anything (nomad-3.26.40-link-tag-3p.note page 3's keyword-creation
    // selections around fully-visible words), so the loop itself must be
    // dropped regardless of what the selection did -- rendering it drew a
    // phantom black circle either way.
    //
    // erase.note page 1 holds exactly 20 TOTALPATH records: 10 dark ink
    // strokes, 4 white-ink (color 254) cover-up strokes, 4 eraser (color
    // 255) strokes, and the 2 lasso records.
    const sn = new SupernoteX(await readFileToUint8Array("erase.note"));
    const inkOnly = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
    expect(inkOnly.length).toBe(14); // 10 dark + 4 white, no lasso records
    const withErasers = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight, {
      includeErasers: true,
    });
    expect(withErasers.length).toBe(18); // + the 4 erasers, still no lasso

    // and on the page where lasso selections deleted nothing: same
    // exclusion, none of the 4 selection loops decode as ink.
    const sn2 = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
    const p3 = parseStrokes(sn2.pages[2].totalPathBuffer, sn2.pageWidth, sn2.pageHeight, { includeErasers: true });
    // a pen=4 loop's known first point (from the raw record) must not
    // appear as any decoded stroke's own first point
    for (const stroke of p3) {
      const first = `${stroke.points[0].x.toFixed(2)},${stroke.points[0].y.toFixed(2)}`;
      expect(first).not.toBe("280.14,841.03");
      expect(first).not.toBe("397.88,981.38");
      expect(first).not.toBe("351.50,1257.70");
      expect(first).not.toBe("380.84,1439.83");
    }
  });
});

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

  describe("point_contour (IStroke.contour)", () => {
    /** Shoelace area of a closed ring. */
    function ringArea(ring: { x: number; y: number }[]) {
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
      }
      return Math.abs(sum / 2);
    }
    function pathLength(points: { x: number; y: number }[]) {
      let total = 0;
      for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      return total;
    }
    function bounds(points: { x: number; y: number }[]) {
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }

    test("is omitted unless includeContours is set", async () => {
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"));
      const withoutContours = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      expect(withoutContours.length).toBeGreaterThan(0);
      expect(withoutContours.every((s) => s.contour === undefined)).toBe(true);

      const withContours = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, {
        includeContours: true,
      });
      expect(withContours.every((s) => s.contour !== undefined && s.contour.length > 0)).toBe(true);
      // the extra data is the only difference -- geometry is untouched
      expect(withContours.map((s) => s.points)).toEqual(withoutContours.map((s) => s.points));
    });

    test("decodes the device's real rendered outline, in the same page-pixel space as points", async () => {
      // stroke-isolation.note page 2 (1-indexed) is one stroke per pen tool
      // at a known width. The contour is the filled region the device
      // renders, so for each stroke it must (a) sit on that stroke's own
      // transformed extents, centered, and (b) enclose an area on the order
      // of pathLength * thickness/100 -- the same width unit the thickness
      // field is documented in. Both hold without any scaling or mirroring
      // applied to the contour, which is what proves it is already stored
      // in final page-pixel space (unlike `points`, which needs the
      // screenHeight transform).
      //
      // How close the area lands to nominal is tool-dependent, which is
      // itself the point of having the contour: the round-tipped tools
      // (needle pen, marker) really do fill ~1.0x their nominal width, but
      // the ink pen measures ~0.65x and the chisel-tipped calligraphy pen
      // only ~0.2-0.3x, because their rendered width narrows with
      // pressure/tilt along most of a real stroke. Stroking the centerline
      // at a uniform `thickness` (what vectorInk does today) can only ever
      // draw the nominal figure, so the area is asserted per-tool rather
      // than as one global ratio.
      const sn = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"));
      const strokes = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true });
      expect(strokes.length).toBe(4);

      for (const stroke of strokes) {
        const ring = stroke.contour!.flat();
        expect(ring.length).toBeGreaterThan(3);

        const contourBox = bounds(ring), strokeBox = bounds(stroke.points);
        const halfWidth = stroke.thickness / 200;
        // centered on the stroke...
        expect(Math.abs((contourBox.minX + contourBox.maxX) / 2 - (strokeBox.minX + strokeBox.maxX) / 2)).toBeLessThan(halfWidth + 5);
        expect(Math.abs((contourBox.minY + contourBox.maxY) / 2 - (strokeBox.minY + strokeBox.maxY) / 2)).toBeLessThan(halfWidth + 5);
        // ...and extending past it by roughly the rendered half width
        expect(contourBox.minX).toBeLessThanOrEqual(strokeBox.minX + 1);
        expect(contourBox.maxX).toBeGreaterThanOrEqual(strokeBox.maxX - 1);

        const enclosed = stroke.contour!.reduce((sum, r) => sum + ringArea(r), 0);
        const nominal = pathLength(stroke.points) * (stroke.thickness / 100);
        // never meaningfully *wider* than the tool's configured width...
        expect(enclosed).toBeLessThan(nominal * 1.3);
        // ...and, for the round-tipped tools, essentially exactly it
        if (stroke.pen === "needlePoint" || stroke.pen === "marker") {
          expect(enclosed).toBeGreaterThan(nominal * 0.85);
        } else {
          expect(enclosed).toBeGreaterThan(nominal * 0.1);
        }
      }
    });

    test("is present even on fully erased strokes -- it is not a visibility record", async () => {
      // erase-no-white-pen.note is one page of 4 lines (4 different pens),
      // every one of them erased -- by the stroke eraser, the lasso eraser,
      // and select-and-delete respectively, with no white-ink cover-ups
      // involved. Its rendered page is blank and Supernote's own export
      // (erase.pdf/erase-no-white-pen.pdf) draws nothing.
      //
      // Yet every one of those strokes still carries a full-area contour,
      // indistinguishable from a visible stroke's. That is the negative
      // result this fixture exists to pin down: the contour is the outline
      // the stroke was *drawn* with, not what survived erasing, so it
      // cannot drive erase-exact export. See plans/vector-format-spec.md's
      // erase-records section.
      const sn = new SupernoteX(await readFileToUint8Array("erase-no-white-pen.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true });
      const ink = strokes.filter((s) => !s.isEraser);
      expect(ink.length).toBe(5);

      for (const stroke of ink) {
        expect(stroke.contour!.flat().length).toBeGreaterThan(3);
      }
      // and the outlines still span their whole stroke, rather than being
      // clipped back to the (nonexistent) surviving ink
      for (const stroke of ink) {
        const contourBox = bounds(stroke.contour!.flat()), strokeBox = bounds(stroke.points);
        expect(contourBox.minX).toBeLessThanOrEqual(strokeBox.minX + 1);
        expect(contourBox.maxX).toBeGreaterThanOrEqual(strokeBox.maxX - 1);
        expect(stroke.contour!.reduce((sum, r) => sum + ringArea(r), 0)).toBeGreaterThan(0);
      }
    });

    test("decodes on every fixture and device family without throwing", async () => {
      // Regression guard for the section sizes readContour depends on: they
      // were solved against two device families, so a fixture that silently
      // stopped decoding would mean a third layout exists.
      const fixtures = fs.readdirSync("tests/input").filter((name) => name.endsWith(".note")).sort();
      let total = 0, withContour = 0;
      for (const fixture of fixtures) {
        const sn = new SupernoteX(await readFileToUint8Array(fixture));
        for (const page of sn.pages) {
          for (const stroke of parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight, {
            includeContours: true,
            includeErasers: true,
          })) {
            total++;
            if (stroke.contour && stroke.contour.length) withContour++;
          }
        }
      }
      expect(total).toBeGreaterThan(2000);
      expect(withContour / total).toBeGreaterThan(0.95);
    });
  });

  describe("record class (StrokeConfig offset 40)", () => {
    test("identifies lasso paths exactly, matching the pen id it replaced", async () => {
      // The lasso exclusion now keys on the record-class field rather than
      // on `pen === 4`, because firmware reuses pen ids across tools. This
      // pins the equivalence that made the swap safe: across every fixture,
      // the set of records the field calls a lasso is precisely the set of
      // pen=4 records -- no ink accidentally dropped, no loop kept.
      const RECORD_CLASS_OFFSET = 40, LASSO = -5, CONFIG_SIZE = 208;
      const fixtures = fs.readdirSync("tests/input").filter((name) => name.endsWith(".note")).sort();
      let lassoByClass = 0, lassoByPen = 0, ink = 0, disagreements = 0;

      for (const fixture of fixtures) {
        const sn = new SupernoteX(await readFileToUint8Array(fixture));
        for (const page of sn.pages) {
          const buf = page.totalPathBuffer;
          if (!buf || buf.length < 16) continue;
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const count = view.getUint32(0, true);
          if (!count || count > 1_000_000) continue;
          let pos = 4;
          for (let i = 0; i < count; i++) {
            if (pos + 4 > buf.length) break;
            const len = view.getUint32(pos, true);
            const start = pos + 4;
            if (!len || len < CONFIG_SIZE || start + len > buf.length) break;
            pos = start + len;
            const byClass = view.getInt32(start + RECORD_CLASS_OFFSET, true) === LASSO;
            const byPen = view.getUint32(start, true) === 4;
            if (byClass) lassoByClass++;
            if (byPen) lassoByPen++;
            if (byClass !== byPen) disagreements++;
            if (view.getInt32(start + RECORD_CLASS_OFFSET, true) === 5000) ink++;
          }
        }
      }

      expect(disagreements).toBe(0);
      expect(lassoByClass).toBe(lassoByPen);
      expect(lassoByClass).toBeGreaterThan(0);
      // The field is not the constant 5000 snlib documents it as, but it is
      // 5000 for the overwhelming majority -- real ink.
      expect(ink).toBeGreaterThan(2000);
    });
  });
});

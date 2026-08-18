import * as fs from "fs-extra"
import * as zlib from "zlib"
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

/** Every subpath the device's own PDF export paints on one page, as bounding
 * boxes in page-pixel space -- one per `m` in the page's Form XObject.
 *
 * The exports put ink in Form XObjects rather than the page stream, and each
 * one opens with `1 0 0 -1 0 <height> cm` -- so the path data itself is
 * already in the note's own y-down pixel space and needs no transform here;
 * the matrix is what turns it into PDF's y-up space, not away from it. Only
 * `m`/`l`/`c` endpoints are read: the extents are all that's needed to ask
 * which pieces of a stroke the device drew, and reading them from the raw
 * numbers keeps this independent of the site build's own PDF converter. */
function devicePageSubpaths(pdfBytes: Buffer, pageIndex: number) {
  const text = pdfBytes.toString("latin1")
  const forms = [...text.matchAll(/\d+ 0 obj\r?\n?([\s\S]*?)endobj/g)]
    .filter(([, body]) => body.includes("/Subtype/Form"))
    .map(([, body]) => {
      const stream = /stream\r?\n([\s\S]*?)endstream/.exec(body)!
      const raw = Buffer.from(stream[1], "latin1")
      return (body.includes("FlateDecode") ? zlib.inflateSync(raw) : raw).toString("latin1")
    })

  const boxes: { minX: number; maxX: number; minY: number; maxY: number }[] = []
  for (const subpath of forms[pageIndex].split(/(?:^|\s)m(?:\s|$)/).slice(1)) {
    const nums = [...subpath.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+(?:l|c|m)(?:\s|$)/g)].map((m) => [Number(m[1]), Number(m[2])])
    if (nums.length < 2) continue
    const xs = nums.map((n) => n[0]), ys = nums.map((n) => n[1])
    boxes.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) })
  }
  return boxes
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
    test("every record-class lasso is a pen=4 record, with one known exception the other way", async () => {
      // The lasso exclusion keys on the record-class field rather than on
      // `pen === 4`, because firmware reuses pen ids across tools. This pins
      // the containment that makes the swap safe -- every lasso the field
      // names is also a pen=4 record, so nothing new is dropped -- and pins
      // the single disagreement in the other direction: sticker.note page
      // 1's last record reads pen=4 without being a lasso, because its
      // StrokeConfig is sticker bytes read through the wrong struct. Both
      // conditions are therefore still tested in parseStrokes.
      const RECORD_CLASS_OFFSET = 40, LASSO = -5, CONFIG_SIZE = 208;
      const fixtures = fs.readdirSync("tests/input").filter((name) => name.endsWith(".note")).sort();
      let lassoByClass = 0, lassoByPen = 0, ink = 0;
      const penOnly: string[] = [], classOnly: string[] = [];

      for (const fixture of fixtures) {
        const sn = new SupernoteX(await readFileToUint8Array(fixture));
        for (const [pageIndex, page] of sn.pages.entries()) {
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
            const recordClass = view.getInt32(start + RECORD_CLASS_OFFSET, true);
            const byClass = recordClass === LASSO;
            const byPen = view.getUint32(start, true) === 4;
            if (byClass) lassoByClass++;
            if (byPen) lassoByPen++;
            if (byPen && !byClass) penOnly.push(`${fixture} p${pageIndex + 1} #${i}`);
            if (byClass && !byPen) classOnly.push(`${fixture} p${pageIndex + 1} #${i}`);
            if (recordClass === 5000) ink++;
          }
        }
      }

      // Containment: the field never claims a lasso that pen=4 doesn't.
      expect(classOnly).toEqual([]);
      expect(lassoByClass).toBeGreaterThan(0);
      expect(lassoByPen).toBe(lassoByClass + 1);
      expect(penOnly).toEqual(["sticker.note p1 #5"]);
      // The field is not the constant 5000 snlib documents it as, but it is
      // 5000 for the overwhelming majority -- real ink.
      expect(ink).toBeGreaterThan(2000);
    });

    test("what a lasso did is stated per stroke, not inferred from its loop", async () => {
      // The op code on a lasso's companion record says what the selection
      // did, and an earlier version of this module acted on it: find the ink
      // a delete-loop encloses, drop it. That is not needed -- the strokes
      // themselves carry it. Both halves matter:
      //
      // erase.note ends with a select-then-delete, and exactly the stroke
      // inside that loop reads -16, the code for that operation. The loop
      // is not consulted at all.
      const deleted = new SupernoteX(await readFileToUint8Array("erase.note"));
      const strokes = parseStrokes(deleted.pages[0].totalPathBuffer, deleted.pageWidth, deleted.pageHeight);
      expect(strokes.filter((stroke) => stroke.trailStatus === -16).length).toBe(1);

      // nomad-3.26.40-link-tag-3p page 3's loops are Keyword/Tag creations
      // carrying the plain-selection op (604), and their contents are
      // fully visible.
      // Treating those loops as deletions is the mistake that made a
      // geometric erase replay unsafe here; going by the record instead,
      // nothing they enclose is marked as deleted.
      const kept = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
      const p3 = parseStrokes(kept.pages[2].totalPathBuffer, kept.pageWidth, kept.pageHeight);
      expect(p3.length).toBe(143);
      expect(p3.filter((stroke) => stroke.trailStatus === -16).length).toBe(0);
    });

    test("no stroke is emitted with an out-of-range colour", async () => {
      // sticker.note page 1 #5 would decode to rgb(2012028940,...) if it
      // reached the output. Guards the whole fixture set, not just that one.
      const fixtures = fs.readdirSync("tests/input").filter((name) => name.endsWith(".note")).sort();
      for (const fixture of fixtures) {
        const sn = new SupernoteX(await readFileToUint8Array(fixture));
        for (const page of sn.pages) {
          for (const stroke of parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight, {
            includeErasers: true,
          })) {
            const channel = Number(stroke.color.match(/^rgb\((\d+),/)![1]);
            expect(channel).toBeLessThanOrEqual(255);
          }
        }
      }
    });
  });

  describe("trailStatus (m_trailStatus)", () => {
    /** Shoelace area of one closed contour ring, used to compare what a
     * partially erased stroke covered against what its fragments do. */
    function ringArea(ring: { x: number; y: number }[]) {
      let total = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        total += a.x * b.y - b.x * a.y;
      }
      return Math.abs(total) / 2;
    }

    test("marks exactly the strokes Supernote's own export leaves out (turkish.note)", async () => {
      // The claim this pins down is the strong one: a non-zero status means
      // the device does not draw the record. turkish.pdf is Supernote's own
      // vector export of this page in the filled-outline style, so each
      // drawn stroke is one `f` fill operator -- 152 of them, against 152
      // records reading 0 out of 189. Nothing here consults the raster.
      const sn = new SupernoteX(await readFileToUint8Array("turkish.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      expect(strokes.length).toBe(189);
      expect(strokes.filter((stroke) => stroke.trailStatus === undefined).length).toBe(152);

      const pdf = (await fs.readFile("tests/input/turkish.pdf")).toString("latin1");
      const form = /\d+ 0 obj\r?\n?([\s\S]*?)endobj/g;
      let streamText = "";
      for (let match = form.exec(pdf); match; match = form.exec(pdf)) {
        if (!match[1].includes("/Subtype/Form")) continue;
        const stream = /stream\r?\n([\s\S]*?)endstream/.exec(match[1]);
        if (stream) streamText = zlib.inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
      }
      expect((streamText.match(/(?:^|\s)f(?:\s|$)/g) ?? []).length).toBe(152);
    });

    test("the code says which mechanism removed the stroke (erase-no-white-pen.note)", async () => {
      // This fixture's README records exactly what was done to each of its
      // five lines: three erase mechanisms, one of them lasso-select-and-
      // delete. Exactly one stroke reads -16 (the lasso delete, its own
      // pen=4 selection pair still in the file) and the rest read -99.
      const sn = new SupernoteX(await readFileToUint8Array("erase-no-white-pen.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      expect(strokes.map((stroke) => stroke.trailStatus).sort((a, b) => a! - b!)).toEqual([-99, -99, -99, -99, -16]);

      // Same shape on the two other fixtures documented as exercising all
      // three mechanisms: one lasso delete each, everything else the eraser.
      for (const [fixture, page] of [["erase.note", 0], ["caligraphy.note", 3]] as const) {
        const other = new SupernoteX(await readFileToUint8Array(fixture));
        const codes = parseStrokes(other.pages[page].totalPathBuffer, other.pageWidth, other.pageHeight)
          .map((stroke) => stroke.trailStatus)
          .filter((status) => status !== undefined);
        expect(codes.filter((status) => status === -16).length).toBe(1);
        expect(codes.filter((status) => status === -99).length).toBe(codes.length - 1);
      }
    });

    test("a partially erased stroke (-4) is followed by contour-only records holding what survived", async () => {
      // The one code whose ink is still partly on the page. The device
      // rewrites each surviving fragment as its own record with no points
      // and a contour, stored right after the stroke it came from, so the
      // erased stroke must be skipped and the fragments drawn instead --
      // drawing both would paint the erased part back in.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
      const strokes = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, {
        includeContours: true,
      });
      const partial = strokes.filter((stroke) => stroke.trailStatus === -4);
      expect(partial.length).toBe(10);

      for (const stroke of partial) {
        const fragments = [];
        for (let i = strokes.indexOf(stroke) + 1; i < strokes.length && strokes[i].points.length === 0; i++) {
          fragments.push(strokes[i]);
        }
        expect(fragments.length).toBeGreaterThan(0);
        // Each fragment is a real outline with no centreline of its own,
        // and together they cover less than the stroke did before the
        // erase -- what the eraser took out is the difference.
        const area = (s: (typeof strokes)[number]) => (s.contour ?? []).reduce((sum, ring) => sum + ringArea(ring), 0);
        for (const fragment of fragments) {
          expect(fragment.contour!.length).toBeGreaterThan(0);
          expect(fragment.trailStatus).toBeUndefined();
        }
        expect(fragments.reduce((sum, fragment) => sum + area(fragment), 0)).toBeLessThan(area(stroke));
      }
    });

    test("the device draws only the surviving fragments of a partially erased stroke (nomad-3.26.40-link-tag-3p.pdf)", async () => {
      // The direct ground truth for -4, and the tightest in the corpus:
      // this page's export names, per stroke, which *pieces* of it survived.
      // Each of the seven erased pen lines must come out as its own
      // fragment records and nothing else -- a path spanning the whole line
      // would be the erased part painted back in.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
      const strokes = parseStrokes(sn.pages[1].totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true });

      const devicePaths = devicePageSubpaths(await fs.readFile("tests/input/nomad-3.26.40-link-tag-3p.pdf"), 1);
      const lines = strokes.filter((stroke) => stroke.trailStatus === -4 && stroke.points.length > 60 && stroke.thickness <= 1300);
      expect(lines.length).toBe(7);

      // Measured from each record's own outline rather than its centreline,
      // since that is what the device draws: a 13px-wide line's outline sits
      // half a width outside the points it was sampled from.
      const extent = (rings: { x: number; y: number }[][]) => {
        const points = rings.flat();
        return {
          minX: Math.min(...points.map((p) => p.x)),
          maxX: Math.max(...points.map((p) => p.x)),
          minY: Math.min(...points.map((p) => p.y)),
          maxY: Math.max(...points.map((p) => p.y)),
        };
      };
      for (const line of lines) {
        const box = extent(line.contour ?? []);
        const fragments = [];
        for (let i = strokes.indexOf(line) + 1; i < strokes.length && strokes[i].points.length === 0; i++) {
          fragments.push(strokes[i]);
        }
        // the export's own subpaths sitting in this line's column
        const drawn = devicePaths
          .filter((p) => p.minX >= box.minX - 6 && p.maxX <= box.maxX + 6 && p.maxY >= box.minY - 8 && p.minY <= box.maxY + 8)
          .sort((a, b) => a.minY - b.minY);
        expect(drawn.length).toBe(fragments.length);
        // never the whole line
        expect(drawn.some((p) => p.minY <= box.minY + 8 && p.maxY >= box.maxY - 8)).toBe(false);
        // and each drawn piece lines up with a fragment record's own extent
        const expected = fragments.map((fragment) => extent(fragment.contour ?? [])).sort((a, b) => a.minY - b.minY);
        for (const [i, piece] of drawn.entries()) {
          expect(Math.abs(piece.minY - expected[i].minY)).toBeLessThan(3);
          expect(Math.abs(piece.maxY - expected[i].maxY)).toBeLessThan(3);
        }
      }
    });

    test("the device omits every marked stroke on a page that erases and rewrites in place (nomad-3.26.40-link-tag-3p.pdf)", async () => {
      // Page 3's export is the stroked-polyline style, one `S` per stroke,
      // so it states its count exactly: 113 for the 113 records reading 0,
      // none of the 30 marked. This is the page where a raster measurement
      // gets it wrong -- the erased words were rewritten in the same place,
      // so 15 of the 30 marked strokes find ink under half their points.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
      const strokes = parseStrokes(sn.pages[2].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      const live = strokes.filter((stroke) => stroke.trailStatus === undefined);
      expect(strokes.length - live.length).toBe(30);

      const pdf = (await fs.readFile("tests/input/nomad-3.26.40-link-tag-3p.pdf")).toString("latin1");
      const streams = [...pdf.matchAll(/\d+ 0 obj\r?\n?([\s\S]*?)endobj/g)]
        .filter(([, body]) => body.includes("/Subtype/Form"))
        .map(([, body]) => {
          const stream = /stream\r?\n([\s\S]*?)endstream/.exec(body)!;
          return zlib.inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
        });
      expect((streams[2].match(/(?:^|\s)S(?:\s|$)/g) ?? []).length).toBe(live.length);
    });

    test("a marked stroke's remaining ink always belongs to a live record (nomad-3.26.40-link-tag-3p.note p3)", async () => {
      // Why that page's export is worth trusting over a measurement of the
      // render: measured naively the marked strokes look alive, because
      // they were erased and then *rewritten in the same place*, so what
      // the samples find is the replacement's ink rather than their own.
      //
      // Attributing the ink shows the same thing the export does, without
      // it: paint every live record's own rendered outline into a mask,
      // subtract it from the page's ink, and re-measure. Nothing of a
      // marked stroke survives that subtraction, while every live stroke is
      // present -- so no ink on this page needs a marked stroke to explain
      // it.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.26.40-link-tag-3p.note"));
      const page = sn.pages[2];
      const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight, { includeContours: true });
      const width = sn.pageWidth, height = sn.pageHeight;

      const decoder = new RattaRLEDecoder();
      const ink = new Uint8Array(width * height);
      for (const name of ["MAINLAYER", "LAYER1", "LAYER2", "LAYER3"] as const) {
        const buffer = page[name]?.bitmapBuffer as Uint8Array | undefined;
        if (!buffer?.length) continue;
        const pixels = decoder.decode(buffer, width, height);
        for (let i = 0, p = 0; p < ink.length; i += 4, p++) if (!ink[p] && pixels[i + 3] > 0) ink[p] = 1;
      }

      // The device's rasteriser spreads a little past the declared outline,
      // so a live record claims its own contour plus a small margin.
      const MARGIN = 3;
      const claimed = new Uint8Array(width * height);
      const claim = (rings: { x: number; y: number }[][]) => {
        const xs = rings.flat().map((p) => p.x), ys = rings.flat().map((p) => p.y);
        if (!xs.length) return;
        for (let y = Math.max(0, Math.floor(Math.min(...ys)) - MARGIN); y <= Math.min(height - 1, Math.ceil(Math.max(...ys)) + MARGIN); y++) {
          for (let x = Math.max(0, Math.floor(Math.min(...xs)) - MARGIN); x <= Math.min(width - 1, Math.ceil(Math.max(...xs)) + MARGIN); x++) {
            let inside = false;
            for (const ring of rings) {
              for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                if (ring[i].y > y !== ring[j].y > y && x < ((ring[j].x - ring[i].x) * (y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) {
                  inside = !inside;
                }
              }
            }
            if (!inside) continue;
            for (let dy = -MARGIN; dy <= MARGIN; dy++) {
              for (let dx = -MARGIN; dx <= MARGIN; dx++) {
                if (y + dy >= 0 && y + dy < height && x + dx >= 0 && x + dx < width) claimed[(y + dy) * width + x + dx] = 1;
              }
            }
          }
        }
      };
      const live = strokes.filter((stroke) => stroke.trailStatus === undefined);
      const marked = strokes.filter((stroke) => stroke.trailStatus !== undefined);
      expect(marked.length).toBeGreaterThan(25);
      for (const stroke of live) claim(stroke.contour ?? []);

      const presence = (stroke: (typeof strokes)[number], mask: Uint8Array) => {
        const samples = stroke.points.length ? stroke.points : (stroke.contour ?? []).flat();
        if (!samples.length) return 0;
        const radius = Math.max(1, Math.round(stroke.thickness / 200)) + 1;
        const step = Math.max(1, Math.floor(samples.length / 60));
        let sampled = 0, found = 0;
        for (let i = 0; i < samples.length; i += step) {
          sampled++;
          const cx = Math.round(samples[i].x), cy = Math.round(samples[i].y);
          let hit = false;
          for (let y = cy - radius; y <= cy + radius && !hit; y++) {
            if (y < 0 || y >= height) continue;
            for (let x = cx - radius; x <= cx + radius; x++) {
              if (x >= 0 && x < width && mask[y * width + x]) { hit = true; break; }
            }
          }
          if (hit) found++;
        }
        return found / sampled;
      };

      const unclaimed = new Uint8Array(width * height);
      for (let p = 0; p < ink.length; p++) unclaimed[p] = ink[p] && !claimed[p] ? 1 : 0;

      // Measured against all the page's ink, most marked strokes look alive
      // -- that is the trap this guards against.
      expect(marked.filter((stroke) => presence(stroke, ink) >= 0.5).length).toBeGreaterThan(10);
      // Measured against ink no live record accounts for, none of them are.
      for (const stroke of marked) expect(presence(stroke, unclaimed)).toBe(0);
      for (const stroke of live) expect(presence(stroke, ink)).toBeGreaterThan(0.5);
    });

    test("is left off entirely on a stroke the device still draws", async () => {
      // The field is absent rather than 0 on a live stroke, so `in` and a
      // plain truthiness check agree with each other, and the 21 marked
      // strokes of this page are exactly the ones its PDF export omits.
      const sn = new SupernoteX(await readFileToUint8Array("horizontal_1270.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      expect(strokes.filter((stroke) => stroke.trailStatus !== undefined).length).toBe(21);
      for (const stroke of strokes) {
        expect("trailStatus" in stroke).toBe(stroke.trailStatus !== undefined);
        if (stroke.trailStatus !== undefined) expect(stroke.trailStatus).toBeLessThan(0);
      }
    });
  });

  describe("pen ids", () => {
    /** The record's own `stroke_kind` (Ratta's `predictName`), read straight
     * out of a raw StrokeConfig -- these sweeps walk the buffer themselves
     * rather than going through parseStrokes, which doesn't surface it. */
    function strokeKindAt(view: DataView, pos: number): string {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, 52);
      const end = bytes.indexOf(0);
      return new TextDecoder().decode(bytes.subarray(0, end < 0 ? 52 : end));
    }

    test("pen=5 is the marker under the id older firmware used for it (test.note)", async () => {
      // test.note is the only SN_FILE_VER_20220011 (A5X) fixture here, and
      // the only file with pen=5 ordinary ink. Its three pen=5 strokes are
      // a highlighter pass over the first line of handwriting: far wider
      // than the pen ink they cover, and covering it. Both are asserted
      // because either alone is weak -- a wide stroke needn't be a marker,
      // and an overlapping one needn't be either.
      const sn = new SupernoteX(await readFileToUint8Array("test.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      const markers = strokes.filter((stroke) => stroke.pen === "marker");
      expect(markers.length).toBe(3);

      // Pen ink only: the page also carries a Heading background rect, whose
      // thickness field isn't a stroke width at all.
      const inkThickness = strokes.filter((s) => s.pen !== "marker" && !s.isFilledRect).map((s) => s.thickness);
      for (const marker of markers) {
        expect(marker.thickness).toBeGreaterThan(Math.max(...inkThickness) * 5);
        // ...and its color is the marker form of a base palette value: the
        // device's own engine rewrites 0/48/80 to 1/49/81 for exactly the
        // two marker ids (see PEN_IDS). Stored as 81 here, decoded to the
        // grey that id means -- see LEGACY_GREY_IDS.
        expect(marker.color).toBe("rgb(202,202,202)");
      }

      const box = (points: { x: number; y: number }[]) => ({
        minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
      });
      // The band's own half width, which its centerline points stop short
      // of on every side.
      const band = box(markers.flatMap((stroke) => stroke.points));
      const margin = Math.max(...markers.map((stroke) => stroke.thickness)) / 100;
      const inBand = (p: { x: number; y: number }) =>
        p.x >= band.minX - margin && p.x <= band.maxX + margin &&
        p.y >= band.minY - margin && p.y <= band.maxY + margin;

      // Whatever the band touches, it very nearly covers -- the shape of a
      // highlighter pass over a line of text, rather than one wide stroke
      // happening to cross some ink.
      const covered = strokes.filter(
        (stroke) => stroke.pen !== "marker" && !stroke.isFilledRect && stroke.points.some(inBand),
      );
      expect(covered.length).toBeGreaterThan(5);
      const points = covered.flatMap((stroke) => stroke.points);
      expect(points.filter(inBand).length / points.length).toBeGreaterThan(0.9);
    });

    test("the marker ids are the only ones that use the +1 palette variants", async () => {
      // The rule the device's own color routine implements (see PEN_IDS) --
      // a marker writes 1/49/81/158/202 where every other tool writes
      // 0/48/80/157/201. Sweeping every fixture is what makes this a test
      // of the id mapping rather than of one file: if pen=5 were not a
      // marker, its color 81 would be the sole exception on either side.
      const MARKER_ONLY = new Set([1, 49, 81, 158, 202]);
      const BASE_ONLY = new Set([0, 48, 80, 157, 201]);
      const CONFIG_SIZE = 208;
      const fixtures = fs.readdirSync("tests/input").filter((name) => name.endsWith(".note")).sort();
      const markerWithBaseColor: string[] = [], toolWithMarkerColor: string[] = [];
      let markerRecords = 0, toolRecords = 0;

      for (const fixture of fixtures) {
        const sn = new SupernoteX(await readFileToUint8Array(fixture));
        for (const [pageIndex, page] of sn.pages.entries()) {
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
            const pen = view.getUint32(start, true), color = view.getUint32(start + 4, true);
            const where = `${fixture} p${pageIndex + 1} #${i} pen=${pen} color=${color}`;
            // The star mark reuses pen=5 without being marker ink at all,
            // and is the one record excluded here -- see STAR_MARK_STROKE_KIND.
            if (strokeKindAt(view, start + 48) === "fiveStarsSignal") continue;
            if (pen === 5 || pen === 11) {
              markerRecords++;
              if (BASE_ONLY.has(color)) markerWithBaseColor.push(where);
            } else if (pen === 10 || pen === 15 || pen === 16) {
              toolRecords++;
              if (MARKER_ONLY.has(color)) toolWithMarkerColor.push(where);
            }
          }
        }
      }

      expect(markerWithBaseColor).toEqual([]);
      expect(toolWithMarkerColor).toEqual([]);
      expect(markerRecords).toBeGreaterThan(100);
      expect(toolRecords).toBeGreaterThan(1000);
    });

    test("pen=15 is the calligraphy pen, and it is the tool's only id", async () => {
      // caligraphy.note is named for the tool and drawn entirely with it.
      // Every ink record on every page reads 15, which is what rules out
      // the tool having several ids (e.g. one per nib angle).
      const sn = new SupernoteX(await readFileToUint8Array("caligraphy.note"));
      let calligraphy = 0;
      for (const page of sn.pages) {
        const strokes = parseStrokes(page.totalPathBuffer, sn.pageWidth, sn.pageHeight);
        for (const stroke of strokes) expect(stroke.pen).toBe("calligraphy");
        calligraphy += strokes.length;
      }
      expect(calligraphy).toBeGreaterThan(50);

      // ...and the isolated one-stroke-per-tool page agrees.
      const isolation = new SupernoteX(await readFileToUint8Array("stroke-isolation.note"));
      const tools = parseStrokes(isolation.pages[1].totalPathBuffer, isolation.pageWidth, isolation.pageHeight);
      expect(tools.map((stroke) => stroke.pen).sort()).toEqual(["calligraphy", "inkPen", "marker", "needlePoint"]);
    });

    test("the older format's grey ids decode to the greys the device itself draws", async () => {
      // test.note stores 48 and 81 where current firmware stores a grey
      // level directly, so reading them literally makes dark grey nearly
      // black. Supernote's own vector export of the same page says which
      // grey each id means -- the ground truth the 157/201 palette already
      // comes from -- and its page 1 uses exactly three ink colours.
      const pdf = await fs.promises.readFile("tests/input/test.pdf");
      const text = pdf.toString("latin1");
      const form = [...text.matchAll(/\d+ 0 obj\r?\n?([\s\S]*?)endobj/g)]
        .filter(([, body]) => body.includes("/Subtype/Form"))
        .map(([, body]) => {
          const stream = /stream\r?\n([\s\S]*?)endstream/.exec(body)!
          return zlib.inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1")
        })[0]

      // As devicePageSubpaths, but keeping each subpath's fill colour: the
      // question here is which colour the device drew a stroke in, not just
      // where.
      const tokens = form.split(/\s+/)
      const byGrey = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }[]>()
      let grey: number | null = null
      // The colour a subpath is drawn in is whatever was set when it
      // *started*, not when it ends -- a run's last subpath is followed by
      // the next run's `rg`, so reading the colour at flush time files it
      // under the wrong one.
      let openGrey: number | null = null
      let points: number[][] = []
      const flush = () => {
        if (openGrey === null || points.length < 2) return
        const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
        if (!byGrey.has(openGrey)) byGrey.set(openGrey, [])
        byGrey.get(openGrey)!.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) })
      }
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === "rg") grey = Math.round(Number(tokens[i - 3]) * 255)
        else if (tokens[i] === "m") { flush(); openGrey = grey; points = [[Number(tokens[i - 2]), Number(tokens[i - 1])]] }
        else if ((tokens[i] === "l" || tokens[i] === "c") && points.length) points.push([Number(tokens[i - 2]), Number(tokens[i - 1])])
      }
      flush()

      const sn = new SupernoteX(await readFileToUint8Array("test.note"))
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight)
      const greyOf = (stroke: (typeof strokes)[number]) => Number(/rgb\((\d+)/.exec(stroke.color)![1])

      // The ids are gone: nothing decodes as the raw 48/81 any more.
      expect(strokes.some((stroke) => greyOf(stroke) === 48 || greyOf(stroke) === 81)).toBe(false);
      expect([...new Set(strokes.map(greyOf))].sort((a, b) => a - b)).toEqual([0, 157, 202]);

      // Each of our colour groups sits wholly inside the device's matching
      // one. 202 is the marker form of 201 (see LEGACY_GREY_IDS), which the
      // device's export draws at the base grey exactly as it does a modern
      // marker's 202.
      for (const [ours, device] of [[0, 0], [157, 157], [202, 201]] as const) {
        const group = strokes.filter((stroke) => greyOf(stroke) === ours)
        expect(group.length).toBeGreaterThan(0)
        const boxes = byGrey.get(device)!
        expect(boxes.length).toBeGreaterThan(0)
        const points = group.flatMap((stroke) => stroke.points)
        const inside = points.filter((p) =>
          boxes.some((b) => p.x >= b.minX - 1 && p.x <= b.maxX + 1 && p.y >= b.minY - 1 && p.y <= b.maxY + 1),
        )
        expect(inside.length).toBe(points.length)

        // ...and covers it: the device's outline stands off our centreline
        // by the stroke's own half width and no further, which is what rules
        // out our group merely being a small part of a larger one.
        const half = Math.max(...group.map((stroke) => stroke.thickness)) / 100
        const union = {
          minX: Math.min(...boxes.map((b) => b.minX)), maxX: Math.max(...boxes.map((b) => b.maxX)),
          minY: Math.min(...boxes.map((b) => b.minY)), maxY: Math.max(...boxes.map((b) => b.maxY)),
        }
        const oursBox = {
          minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
          minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
        }
        expect(oursBox.minX - union.minX).toBeLessThanOrEqual(half + 2)
        expect(union.maxX - oursBox.maxX).toBeLessThanOrEqual(half + 2)
        expect(oursBox.minY - union.minY).toBeLessThanOrEqual(half + 2)
        expect(union.maxY - oursBox.maxY).toBeLessThanOrEqual(half + 2)
      }
    });

    test("a star mark reports no tool, because the device overwrote its pen field", async () => {
      // See STAR_MARK_STROKE_KIND: the engine stores pen=5/thickness=100
      // over whatever the user actually drew with, so 'marker' would be a
      // false reading of a real id. The flag says the tool is gone rather
      // than merely unrecognized -- the ink itself is kept and rendered.
      const sn = new SupernoteX(await readFileToUint8Array("nomad-3.15.27-blank-shapes-and-RTR.note"));
      const strokes = parseStrokes(sn.pages[0].totalPathBuffer, sn.pageWidth, sn.pageHeight);
      const stars = strokes.filter((stroke) => stroke.isStarMark);
      expect(stars.length).toBe(1);
      expect(stars[0].pen).toBe("unknown");
      expect(stars[0].thickness).toBe(100);
      expect(stars[0].points.length).toBeGreaterThan(0);
      // absent, not false, on everything else -- the same shape as the
      // other optional flags
      for (const stroke of strokes) expect("isStarMark" in stroke).toBe(stroke === stars[0]);
    });
  });
});

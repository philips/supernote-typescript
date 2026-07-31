import * as fs from "fs-extra"
import * as imagejs from "image-js"
import initSqlJs from "sql.js"
import { describe, test, expect } from 'vitest'
import { SupernoteAtelier } from "../src/atelier"

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

// Minimal `.spd` SQLite database, built directly (not via a real device
// export) so a test can place a tile wherever it wants - including
// positions no real file would ever have, to exercise toImage()'s size
// guard. Only what `_parseConfig`/`_parseSurfaces` actually read: a `config`
// table (left empty here - canvasSize/layers/etc. are all optional) and one
// `tid`/`tile` table per surface named in `tiles`.
async function buildSpdBuffer(tiles: { surface: string; tid: number }[]): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE config (name TEXT, value BLOB)");

  const tilePng = imagejs.encodePng(new imagejs.Image(4, 4, { colorModel: imagejs.ImageColorModel.RGBA }));
  const surfaceNames = new Set(tiles.map((t) => t.surface));
  for (const surface of surfaceNames) {
    db.run(`CREATE TABLE ${surface} (tid INTEGER, tile BLOB)`);
  }
  for (const { surface, tid } of tiles) {
    db.run(`INSERT INTO ${surface} (tid, tile) VALUES (?, ?)`, [tid, tilePng]);
  }

  const buffer = db.export();
  db.close();
  return buffer;
}

describe("atelier", () => {
  test("parses config and surfaces from a .spd file", async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("sample.spd"));
    expect(note.fmtVer).toEqual(2);
    expect(note.viewport).toEqual({ x: 249984, y: 249984, scale: 1 });
    expect(note.canvasSize).toEqual({ width: 1536, height: 2048 });
    expect(note.layers).toEqual([
      { id: 3, name: "Layer 3" },
      { id: 2, name: "Layer 2" },
      { id: 1, name: "Layer 1" },
      { id: 9999, name: "Reference Layer" },
    ]);
    expect(note.thumbnailBuffer).toBeNull();

    // Real .spd files aren't limited to surface_1/surface_2; layers can use
    // arbitrary surface_{layerId} names (e.g. surface_9999 for a "Reference
    // Layer"), and a layer can exist with no tiles at all (surface_3 here).
    expect(Object.keys(note.surfaces).sort()).toEqual(["surface_1", "surface_2", "surface_3", "surface_9999"]);
    expect(note.surfaces.surface_1.length).toEqual(7 * 5);
    expect(note.surfaces.surface_2.length).toEqual(8 * 6);
    expect(note.surfaces.surface_3.length).toEqual(0);
    expect(note.surfaces.surface_9999.length).toEqual(16 * 12);
    for (const tile of note.surfaces.surface_1) {
      expect(tile.bitmapBuffer.length).toBeGreaterThan(0);
    }
  })

  test("stitches a surface's tiles into a composite image aligned to the file's shared tile grid", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("sample.spd"));

    // surface_9999 covers every tile in the file, so it defines the shared
    // grid bounds; every surface's image should come out that same size.
    const background = await note.toImage("surface_9999");
    expect(background).not.toBeNull();
    expect(background!.width).toEqual(1536);
    expect(background!.height).toEqual(2048);
    await imagejs.writeSync(`tests/output/sample.spd-surface_9999.png`, background!);

    // surface_1/surface_2 only have sparse tiles (rows 2-8/cols 1-5 and rows
    // 6-13/cols 5-10 respectively), but since toImage sizes against every
    // surface's tiles, both come back the same full size as surface_9999 --
    // this is what makes them safe to composite directly on top of it.
    const layer1 = await note.toImage("surface_1");
    expect(layer1!.width).toEqual(background!.width);
    expect(layer1!.height).toEqual(background!.height);
    await imagejs.writeSync(`tests/output/sample.spd-surface_1.png`, layer1!);

    const layer2 = await note.toImage("surface_2");
    expect(layer2!.width).toEqual(background!.width);
    expect(layer2!.height).toEqual(background!.height);
    await imagejs.writeSync(`tests/output/sample.spd-surface_2.png`, layer2!);
  })

  test("returns null for a surface with no tiles", async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("sample.spd"));
    expect(await note.toImage("surface_3")).toBeNull();
  })

  test("returns null for a nonexistent surface", async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("sample.spd"));
    expect(await note.toImage("surface_42")).toBeNull();
  })

  test("composites every surface into one flattened image", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("sample.spd"));
    const composite = await note.toCompositeImage();
    const background = await note.toImage("surface_9999");
    expect(composite).not.toBeNull();
    expect(composite!.width).toEqual(1536);
    expect(composite!.height).toEqual(2048);
    await imagejs.writeSync(`tests/output/sample.spd-composite.png`, composite!);

    // Outside every foreground layer's own tiles, the composite must match
    // the background exactly -- catches compositing that blanks/overwrites
    // areas it shouldn't (e.g. treating a transparent-but-non-black tile
    // pixel, or an unpasted grid cell's non-transparent image-js default
    // fill, as real content).
    const untouchedPixel = { x: 0, y: 0 }; // outside surface_1/surface_2's tile ranges
    expect(composite!.getPixel(untouchedPixel.x, untouchedPixel.y)).toEqual(
      background!.getPixel(untouchedPixel.x, untouchedPixel.y),
    );

    // Inside surface_1's own tiles, the composite must differ from the bare
    // background somewhere -- catches the opposite failure, e.g. compositing
    // silently doing nothing.
    let anyPixelDiffers = false;
    for (let y = 2 * 128; y < 9 * 128 && !anyPixelDiffers; y++) {
      for (let x = 1 * 128; x < 6 * 128; x++) {
        if (!arraysEqual(composite!.getPixel(x, y), background!.getPixel(x, y))) {
          anyPixelDiffers = true;
          break;
        }
      }
    }
    expect(anyPixelDiffers).toBe(true);
  })
})

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("atelier real device file", () => {
  test("parses config and surfaces from a real device-generated .spd file", async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));
    expect(note.fmtVer).toEqual(2);
    expect(note.viewport).toEqual({ x: 249984, y: 249984, scale: 1 });
    expect(note.canvasSize).toEqual({ width: 1920, height: 2560 });
    expect(note.layers).toEqual([
      { id: 3, name: "Layer 3" },
      { id: 2, name: "Layer 2" },
      { id: 1, name: "Layer 1" },
      { id: 9999, name: "Reference Layer" },
    ]);
    // thumbnail/templateData are stored with SQLite storage class TEXT despite
    // holding binary (PNG) content, and get truncated at their first embedded
    // NUL byte by whatever wrote them -- a real-device data quirk, not a bug
    // in this parser. thumbnailBuffer is exposed as whatever bytes survive.
    expect(note.thumbnailBuffer).not.toBeNull();
    expect(note.thumbnailBuffer!.length).toBeGreaterThan(0);

    const decoder = new TextDecoder("utf8");
    expect(decoder.decode(note.config.appVersion)).toEqual("1.1.82");
    expect(decoder.decode(note.config.template_name)).toEqual("/sdcard/myStyle/Supernote+-+Audubon+#029.jpeg");
    expect(decoder.decode(note.config.ppi)).toEqual("72");

    // Real files aren't limited to surface_1/surface_2 (this one has a
    // surface_9999 "Reference Layer" background), and a layer can exist with
    // no tiles at all (surface_3 here).
    expect(Object.keys(note.surfaces).sort()).toEqual(["surface_1", "surface_2", "surface_3", "surface_9999"]);
    expect(note.surfaces.surface_1.length).toEqual(46);
    expect(note.surfaces.surface_2.length).toEqual(31);
    expect(note.surfaces.surface_3.length).toEqual(0);
    expect(note.surfaces.surface_9999.length).toEqual(320);
  })

  test("stitches every surface of a real device-generated .spd file to the same aligned size", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));

    // surface_1/surface_2 only have sparse tiles where the user actually
    // drew, but toImage sizes against the shared tile grid across every
    // surface in the file, so all three come back the same size and stay
    // aligned with the surface_9999 background for direct compositing.
    // (This ends up one tile wider than the nominal 1920px canvasSize --
    // the recorded tiles extend slightly past the configured canvas width.)
    const background = await note.toImage("surface_9999");
    const layer1 = await note.toImage("surface_1");
    const layer2 = await note.toImage("surface_2");
    expect(background).not.toBeNull();
    expect(background!.width).toEqual(2048);
    expect(background!.height).toEqual(2560);
    expect([layer1!.width, layer1!.height]).toEqual([background!.width, background!.height]);
    expect([layer2!.width, layer2!.height]).toEqual([background!.width, background!.height]);

    await imagejs.writeSync(`tests/output/real-device.spd-surface_9999.png`, background!);
    await imagejs.writeSync(`tests/output/real-device.spd-surface_1.png`, layer1!);
    await imagejs.writeSync(`tests/output/real-device.spd-surface_2.png`, layer2!);

    expect(await note.toImage("surface_3")).toBeNull();
  })

  test("composites every surface of a real device-generated .spd file into one flattened image", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));
    const composite = await note.toCompositeImage();
    expect(composite).not.toBeNull();
    expect(composite!.width).toEqual(2048);
    expect(composite!.height).toEqual(2560);
    await imagejs.writeSync(`tests/output/real-device.spd-composite.png`, composite!);
  })

  test("toCompositeImage can composite a subset of surfaces, e.g. hiding the reference layer", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));
    const full = await note.toCompositeImage();
    const withoutBackground = await note.toCompositeImage(["surface_1", "surface_2"]);
    expect(withoutBackground).not.toBeNull();
    // Still sized/aligned against every surface in the file, not just the
    // ones included -- same coordinate space as toImage()/the full composite.
    expect(withoutBackground!.width).toEqual(full!.width);
    expect(withoutBackground!.height).toEqual(full!.height);
    await imagejs.writeSync(`tests/output/real-device.spd-composite-no-background.png`, withoutBackground!);

    // (70, 0) is outside surface_1/surface_2's own tiles but inside
    // surface_9999's (the "Reference Layer" background) -- so excluding
    // surface_9999 should leave it transparent, unlike the full composite
    // where the background shows through (opaque white paper there).
    expect(withoutBackground!.getPixel(70, 0)).toEqual([0, 0, 0, 0]);
    expect(full!.getPixel(70, 0)).toEqual([255, 255, 255, 255]);
  })

  test("toCompositeImage returns null when the requested subset has no content", async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));
    expect(await note.toCompositeImage([])).toBeNull();
    // surface_3 exists (it's a real layer) but has no tiles of its own.
    expect(await note.toCompositeImage(["surface_3"])).toBeNull();
  })

  test("toCompositeImage ignores requested surface names the file doesn't have", { timeout: 30000 }, async () => {
    const note = await SupernoteAtelier.open(await readFileToUint8Array("real-device.spd"));
    const background = await note.toImage("surface_9999");
    const composite = await note.toCompositeImage(["surface_9999", "surface_no_such_layer"]);
    expect(composite).not.toBeNull();
    expect(composite!.getPixel(0, 0)).toEqual(background!.getPixel(0, 0));
  })

  // Regression test for supernote-obsidian-plugin#147: a tile positioned far
  // from the rest (tid encodes grid column in its upper bits, see
  // TILE_ID_STRIDE's doc comment in atelier.ts) used to make toImage() size
  // its output against that outlier with no check at all, allocating
  // gigabytes for what should be a tiny image - fine on desktop, a hard OOM
  // crash on a memory-constrained mobile WebView.
  test("toImage refuses to composite when a tile sits far outside the rest", async () => {
    // tid = col * 4096 + row (TILE_ID_STRIDE). One ordinary tile at the
    // origin, one 10 million columns away - a stand-in for a corrupted/
    // out-of-range tid, since no real device drawing spans that far. With
    // these 4x4 tiles that's a (10,000,001 * 4) x 4 output, comfortably over
    // the 32-megapixel safety limit.
    const buffer = await buildSpdBuffer([
      { surface: "surface_1", tid: 0 },
      { surface: "surface_1", tid: 10_000_000 * 4096 },
    ]);
    const note = await SupernoteAtelier.open(buffer);
    await expect(note.toImage("surface_1")).rejects.toThrow(/exceeds the .* safety limit/);
  })

  test("toImage composites normally when tiles stay within the safety limit", async () => {
    const buffer = await buildSpdBuffer([
      { surface: "surface_1", tid: 0 },
      { surface: "surface_1", tid: 1 * 4096 + 1 }, // one tile over, one down
    ]);
    const note = await SupernoteAtelier.open(buffer);
    const image = await note.toImage("surface_1");
    expect(image).not.toBeNull();
    expect(image!.width).toEqual(4 * 2);
    expect(image!.height).toEqual(4 * 2);
  })
})

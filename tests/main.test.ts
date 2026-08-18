import * as fs from "fs-extra"
import { toImage } from "../src/conversion"
import { SupernoteX, extractParagraphs } from "../src/parsing"
import { IRecognitionElement } from "../src/format"
import * as imagejs from "image-js"
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

describe("smoke", () => {
  test("opens the test note", async () => {
    const buf = await readFileToUint8Array("test-a5x-20220011-old-pen-ids.note")
    expect(buf.byteLength).toEqual(263119)
  })

  test("should decode an int", () => {
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78])
    const num = buf.readUIntLE(0, 4)
    expect(num).toEqual(2018915346)
  })

  test("should parse a Supernote X file", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test-a5x-20220011-old-pen-ids.note"))
    expect(sn).not.toBeUndefined()
  })
})

describe("image", () => {
  test("convert a simple note to png pages", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("test-a5x-20220011-old-pen-ids.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/test-a5x-20220011-old-pen-ids.note-${index}.png`, image)
    }
  })
})

describe("links", () => {
  test("appends #PageN anchor to same-file links via PAGEID; cross-file and no-page links have no anchor", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("link-n6-3.26.40-partial-erase-3p.note"))
    const allLinks = Object.values(sn.links).flat()
    // Link to page 1 of the same file should include the page anchor.
    const sameFileLink = allLinks.find(l => l.text.startsWith("nomad-3.26.40-link-tag-3p"))
    expect(sameFileLink).toBeDefined()
    expect(sameFileLink!.text).toBe("nomad-3.26.40-link-tag-3p#Page 1")
    // Cross-file link with a PAGEID (target page not in this document) has no anchor.
    const crossFileWithPage = allLinks.find(l => l.PAGEID !== '0' && l.PAGEID !== 'none' && l.text.startsWith("nomad-3.26.40-blank-2p") && !l.text.includes('#'))
    expect(crossFileWithPage).toBeDefined()
    // Cross-file link without a page (PAGEID 'none') has no anchor.
    const crossFileNoPage = allLinks.find(l => l.PAGEID === 'none')
    expect(crossFileNoPage).toBeDefined()
    expect(crossFileNoPage!.text).toBe("nomad-3.26.40-blank-2p")
  })

  test("the links Record key's first 4 characters are the 1-indexed source page, not OBJPAGE", async () => {
    let sn = new SupernoteX(await readFileToUint8Array("link-n6-3.26.40-partial-erase-3p.note"))
    // All 3 links in this fixture are physically drawn on the same page
    // (source page array-index 1, i.e. page 2), so every key shares that
    // page's 1-indexed prefix, "0002" -- see _parseLinks()'s doc comment.
    const keys = Object.keys(sn.links)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.slice(0, 4)).toBe("0002")
    }
    // OBJPAGE is NOT a reliable stand-in for the key prefix: these 3 links
    // share one source page yet have 3 different OBJPAGE values, which is
    // exactly what makes it unreliable (see ILink.OBJPAGE's doc comment and
    // https://github.com/philips/supernote-typescript/issues/32).
    const allLinks = Object.values(sn.links).flat()
    const objPages = new Set(allLinks.map(l => l.OBJPAGE))
    expect(objPages.size).toBeGreaterThan(1)
  })
})

describe("digest_image", () => {
  test("convert a mark file into a png image", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("digest-n5-20230015-test.mark"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/digest-n5-20230015-test.mark-${index}.png`, image)
    }
  })
})

describe("nomad", () => {
  test("convert a note from a nomad Chauvet 3.15.27 to png pages", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("blank-a6x-3.15.27-two-pages.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/blank-a6x-3.15.27-two-pages.note-${index}.png`, image)
    }
  })

  test("convert a note from a nomad Chauvet 3.15.27 with handwriting recognition to png pages", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("blank-a6x-3.15.27-shapes-rtr.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/blank-a6x-3.15.27-shapes-rtr.note-${index}.png`, image)
    }
  })
})

describe("A5X", () => {
  test("convert a note from a A5X with Chauvet 2.14.28 to png pages", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("ink-a5x-2.14.28-old-pen-width.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/ink-a5x-2.14.28-old-pen-width.note-${index}.png`, image)
    }
  })
})

describe("manta", () => {
  test("convert a note from a A5X2 Manta with Chauvet ??? to png pages", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("blank-n5-20230015-manta.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/blank-n5-20230015-manta.note-${index}.png`, image)
    }
  })
})

describe("horizontal orientation value detection", () => {
  // Ensure horizontal orientation values (1090 and 1270) are read as horizontal
  test("convert a horizontal note from a A5X2 Manta w/ orientation value 1090", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("layout-n5-20230015-horizontal-1090.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      expect(image.width).toBeGreaterThan(image.height); // expect a landscape image
      await imagejs.writeSync(`tests/output/layout-n5-20230015-horizontal-1090.note-${index}.png`, image);
    }
  })

	test('convert a horizontal note from a A6X2 Nomad w/ orientation value 1270', { timeout: 30000 }, async () => {
		const sn = new SupernoteX(await readFileToUint8Array('erase-n6-20230015-horizontal-1270.note'));
		const images = await toImage(sn);
		expect(images).not.toBeUndefined();
		for await (const [index, image] of images.entries()) {
			expect(image.width).toBeGreaterThan(image.height); // expect a landscape image
			await imagejs.writeSync(`tests/output/erase-n6-20230015-horizontal-1270.note-${index}.png`, image);
		}
	});

  // Ensure vertical orientation values (1000, 1180) are still read as vertical
	test('convert a vertical note w/ orientation value 1000', { timeout: 30000 }, async () => {
		const sn = new SupernoteX(await readFileToUint8Array('layout-n5-20230015-vertical-1000.note'));
		const images = await toImage(sn);
		expect(images).not.toBeUndefined();
		for await (const [index, image] of images.entries()) {
			expect(image.height).toBeGreaterThan(image.width); // expect a portrait image
			await imagejs.writeSync(`tests/output/layout-n5-20230015-vertical-1000.note-${index}.png`, image);
		}
	});

	test(
		'convert a vertical note from a A6X2 Nomad w/ orientation value 1180',
		{ timeout: 30000 },
		async () => {
			const sn = new SupernoteX(await readFileToUint8Array('layout-n6-20230015-vertical-1180.note'));
			const images = await toImage(sn);
			expect(images).not.toBeUndefined();
			for await (const [index, image] of images.entries()) {
				expect(image.height).toBeGreaterThan(image.width); // expect a portrait image
				await imagejs.writeSync(`tests/output/layout-n6-20230015-vertical-1180.note-${index}.png`, image);
			}
		},
	);
})

describe("color", () => {
  test("test a note that has an unknown color", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("color-n6-20230015-unknown-palette.note"))
    const images = await toImage(sn)
    expect(images).not.toBeUndefined()
    for await (const [index, image] of images.entries()) {
      await imagejs.writeSync(`tests/output/unknown-colors.note-${index}.png`, image)
    }
  })
})

describe("rtr", () => {
  test("test a note that has paragraphs", { timeout: 30000 }, async () => {
    const sn = new SupernoteX(await readFileToUint8Array("rtr-n5-20230015-recognition.note"))

    const ep = [
      'Real time recognition paragraph test',
      'With enough space a new paragraph should be created. If lines are close then the text should reflow.',
      'This should be a new paragraph.',
      'As well as this.',
      'But thin is the last paragraph and should reflow together.',
    ].join('\n\n')

    expect(sn.pages[0].paragraphs).toEqual(ep)

    const et = [
      'Real',
      'time', 'recognition',
      'paragraph test',
      'With enough space a new paragraph',
      'should be created. If lines are',
      'close then the text should reflow.',
      'This should be a new paragraph.',
      'As well as this.',
      'But thin is the last paragraph and',
      'should reflow together.',
    ].join('\n')

    expect(sn.pages[0].text).toEqual(et)
  })
})

describe("extractParagraphs", () => {
  // Helper to build a recognition word: a positioned word, or (with no box)
  // one of the recognizer's own "\n" line-break markers.
  function word(label: string, x?: number, y?: number, w?: number, h?: number): IRecognitionElement['words'][number] {
    if (x === undefined) return { label }
    return { label, 'bounding-box': { x, y: y as number, width: w as number, height: h as number } }
  }

  test("does not insert a paragraph break after a wrapped multi-line block with no blank line before the next block", () => {
    // Element A: one recognition block spanning two wrapped lines, like a
    // real handwritten paragraph the device recognized as a single block.
    const elementA: IRecognitionElement = {
      type: 'Text',
      label: 'alpha bravo charlie\ndelta echo foxtrot',
      words: [
        word('alpha', 0, 0, 20, 10), word(' '),
        word('bravo', 25, 0, 20, 10), word(' '),
        word('charlie', 50, 0, 25, 10),
        word('\n'),
        word('delta', 0, 9, 20, 10), word(' '),
        word('echo', 25, 9, 20, 10), word(' '),
        word('foxtrot', 50, 9, 25, 10),
      ],
    }

    // Element B: a separate block immediately below element A's last line
    // (gap of 2, well under one line height) - the device split it into a
    // new block, but visually it's the same paragraph continuing.
    const elementB: IRecognitionElement = {
      type: 'Text',
      label: 'golf hotel',
      words: [
        word('golf', 0, 21, 20, 10), word(' '),
        word('hotel', 25, 21, 20, 10),
      ],
    }

    // Element C: a genuinely new paragraph, separated by a real blank gap.
    const elementC: IRecognitionElement = {
      type: 'Text',
      label: 'india',
      words: [word('india', 0, 60, 20, 10)],
    }

    const result = extractParagraphs([elementA, elementB, elementC])

    expect(result).toEqual([
      'alpha bravo charlie delta echo foxtrot golf hotel',
      'india',
    ].join('\n\n'))
  })
})

/*
describe('profile', () => {
  v8Profiler.setGenerateType(1);
  const title = '1to10';
  v8Profiler.startProfiling(title, true);
  afterAll(() => {
    const profile = v8Profiler.stopProfiling(title);
    profile.export(function (error, result: any) {
      // if it doesn't have the extension .cpuprofile then
      // chrome's profiler tool won't like it.
      // examine the profile:
      //   Navigate to chrome://inspect
      //   Click Open dedicated DevTools for Node
      //   Select the profiler tab
      //   Load your file
      fs.writeFileSync(`tests/output/${title}.cpuprofile`, result);
      profile.delete();
    });
  });
  describe("test ordering", () => {
    test("ensure that pages 1 to 10 are oredered correctly", async () => {
      let sn = new SupernoteX(await readFileToUint8Array("demo-a5x-20230015-1to10.note"))
      let images = await toImage(sn)
      expect(images).not.toBeUndefined()
      for await (const [index, image] of images.entries()) {
        await image.write(`tests/output/1to10-${index + 1}.png`)
      }
    }, { timeout: 30000 })
  })
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
  test("download a frame off the mirroring service", async () => {
    let ipport = `localhost:${TEST_PORT}`;
    if (process.env.MIRROR_IPPORT) {
      ipport = process.env.MIRROR_IPPORT;
    }
    const image = await fetchMirrorFrame(ipport);
    expect(image).toBeDefined();
    await image.write(`tests/output/mirror.jpg`)
  }, { timeout: 30000 })
})
*/




describe("keywords", () => {
  test("parses all keyword stars with correct text and page via key prefix", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("link-n6-3.26.40-partial-erase-3p.note"))

    const allKeywords = Object.entries(sn.keywords).flatMap(([key, kws]) =>
      kws.map(kw => ({ key, kw }))
    )

    // Three keyword stars on page 3.
    expect(allKeywords).toHaveLength(3)

    const texts = allKeywords.map(({ kw }) => kw.KEYWORD)
    expect(texts).toContain("Supemote Keyword")
    expect(texts).toContain("Multiple keywords")
    expect(texts).toContain("New tag")

    // The KEYWORD footer key encodes the source page as its first 4 digits (1-indexed).
    // This is the reliable page indicator — KEYWORDPAGE can be '0' (invalid).
    for (const { key } of allKeywords) {
      expect(parseInt(key.slice(0, 4))).toBe(3)
    }

    // "New tag" has KEYWORDPAGE='0' (invalid) but the key prefix is correct.
    const newTagEntry = allKeywords.find(({ kw }) => kw.KEYWORD === "New tag")
    expect(newTagEntry).toBeDefined()
    expect(newTagEntry!.kw.KEYWORDPAGE).toBe('0')
    expect(parseInt(newTagEntry!.key.slice(0, 4))).toBe(3)
  })

  test("page 3 OCR text includes the # new tag line that maps to the keyword", async () => {
    const sn = new SupernoteX(await readFileToUint8Array("link-n6-3.26.40-partial-erase-3p.note"))
    const page3Text = sn.pages[2].text
    expect(page3Text).toContain("# new tag")
    expect(page3Text).toContain("# TITLE")
    expect(page3Text).toContain("Multiple keywords")
  })
})

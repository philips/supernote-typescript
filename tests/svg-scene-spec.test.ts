import * as fs from "fs-extra"
import { beforeAll, describe, expect, test } from "vitest"
import { addSvgPage, toSvg } from "../src/svg"
import { toImage } from "../src/conversion"
import { SupernoteX } from "../src/parsing"
import { parseStrokes } from "../src/strokes"
import {
  buildVectorInkBackgroundNote,
  prepareVectorInkPages,
} from "../src/vector-ink"
import {
  OI_VECTOR_SCENE_METADATA_ID,
  OI_VECTOR_SCENE_MIME_TYPE,
  OI_VECTOR_SCENE_NAMESPACE,
  OI_VECTOR_SCENE_VERSION,
  type OiVectorSceneV1,
} from "../src/svg-scene"

/** Conformance tests for plans/ola-ink-svg-scene-v1.md. These deliberately
 * inspect the serialized output of svg.ts rather than only testing the scene
 * builder's intermediate objects. */

const DOCUMENT_ID = "spec-link-n6-partial-erase"
const PATH_DATA_V1 = /^M-?\d+\.\d{2},-?\d+\.\d{2}(?: [ML]-?\d+\.\d{2},-?\d+\.\d{2}| Z)*$/
const PROFILE_PATH_ATTRIBUTES = new Set([
  "id",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "visibility",
  "oi:role",
])

function readFixture(file: string): Promise<Uint8Array> {
  return fs.readFile(`tests/input/${file}`).then((bytes) => new Uint8Array(bytes))
}

function parseAttributes(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  )
}

function rootAttributes(svg: string): Record<string, string> {
  const match = /^<svg ([^>]*)>/.exec(svg)
  expect(match).not.toBeNull()
  return parseAttributes(match![1])
}

function sceneMetadata(svg: string): OiVectorSceneV1 | undefined {
  const match = new RegExp(
    `<metadata id="${OI_VECTOR_SCENE_METADATA_ID}" type="application/vnd\\.olaink\\.vector-scene\\+json">([^<]+)</metadata>`,
  ).exec(svg)
  return match ? JSON.parse(match[1]) as OiVectorSceneV1 : undefined
}

function pathElementsById(svg: string): Map<string, { tag: string; attributes: Record<string, string> }> {
  const result = new Map<string, { tag: string; attributes: Record<string, string> }>()
  for (const match of svg.matchAll(/<path ([^>]*)\/>/g)) {
    const attributes = parseAttributes(match[1])
    if (attributes.id) {
      expect(result.has(attributes.id)).toBe(false)
      result.set(attributes.id, { tag: match[0], attributes })
    }
  }
  return result
}

function assertRgb(color: string): void {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color)
  expect(match).not.toBeNull()
  for (const channel of match!.slice(1)) {
    expect(Number(channel)).toBeGreaterThanOrEqual(0)
    expect(Number(channel)).toBeLessThanOrEqual(255)
  }
}

function stripSceneOnlyRootAttributes(svg: string): string {
  return svg.replace(
    / xmlns:oi="[^"]+" oi:scene-version="1" oi:document-id="[^"]+" oi:page-index="\d+" oi:page-count="\d+"/,
    "",
  )
}

function visiblePathTags(svg: string): string[] {
  return [...svg.matchAll(/<path d="[^"]+"[^>]*\/>/g)].map((match) =>
    match[0].replace(/ id="s\d+-fill" oi:role="(?:final-contour|erase-cover)"/, ""),
  )
}

let note: SupernoteX
let sceneSvg: string
let plainVectorSvg: string
let fallbackNote: SupernoteX
let fallbackSvg: string
let plainFallbackSvg: string
let overlaySvg: string

beforeAll(async () => {
  note = new SupernoteX(await readFixture("link-n6-3.26.40-partial-erase-3p.note"))
  ;[plainVectorSvg, sceneSvg] = await Promise.all([
    toSvg(note, { pageNumbers: [2], vectorInk: true }).then(([svg]) => svg),
    toSvg(note, {
      pageNumbers: [2],
      vectorInk: true,
      embedScene: true,
      documentId: DOCUMENT_ID,
    }).then(([svg]) => svg),
  ])

  fallbackNote = new SupernoteX(await readFixture("render-n6-20230015-moonchild-user-bg.note"))
  ;[plainFallbackSvg, fallbackSvg] = await Promise.all([
    toSvg(fallbackNote, { pageNumbers: [1], vectorInk: true }).then(([svg]) => svg),
    toSvg(fallbackNote, {
      pageNumbers: [1],
      vectorInk: true,
      embedScene: true,
      documentId: "spec-raster-fallback",
    }).then(([svg]) => svg),
  ])

  const overlayNote = new SupernoteX(await readFixture("textbox-n5-20260016-digest.note"))
  ;[overlaySvg] = await toSvg(overlayNote, {
    pageNumbers: [5],
    vectorInk: true,
    embedScene: true,
    documentId: "spec-raster-overlay",
  })
}, 120000)

describe("Ola Ink SVG scene v1 spec", () => {
  test("requires both vectorInk and a caller-owned documentId", async () => {
    await expect(toSvg(note, { pageNumbers: [2], embedScene: true, documentId: DOCUMENT_ID })).rejects.toThrow(
      "embedScene requires vectorInk: true",
    )
    await expect(toSvg(note, { pageNumbers: [2], vectorInk: true, embedScene: true })).rejects.toThrow(
      "embedScene requires a caller-owned documentId",
    )
  })

  test("writes the versioned per-page root contract", () => {
    const root = rootAttributes(sceneSvg)
    expect(root.xmlns).toBe("http://www.w3.org/2000/svg")
    expect(root["xmlns:xlink"]).toBe("http://www.w3.org/1999/xlink")
    expect(root["xmlns:oi"]).toBe(OI_VECTOR_SCENE_NAMESPACE)
    expect(root["oi:scene-version"]).toBe(String(OI_VECTOR_SCENE_VERSION))
    expect(root["oi:document-id"]).toBe(DOCUMENT_ID)
    expect(root["oi:page-index"]).toBe("1") // original page 2, zero-based
    expect(root["oi:page-count"]).toBe("3")
    expect(root.viewBox).toBe(`0 0 ${note.pageWidth} ${note.pageHeight}`)
    expect(Number(root["oi:page-index"])).toBeLessThan(Number(root["oi:page-count"]))
  })

  test("writes only the documented metadata shape and ordering values", () => {
    const scene = sceneMetadata(sceneSvg)
    expect(scene).toBeDefined()
    expect(Object.keys(scene!).sort()).toEqual(["strokes", "version"])
    expect(scene!.version).toBe(OI_VECTOR_SCENE_VERSION)
    expect(scene!.strokes.length).toBeGreaterThan(0)

    const ids = new Set<string>()
    const contours = new Set<string>()
    const centerlines = new Set<string>()
    const zOrders = new Set<number>()
    for (const stroke of scene!.strokes) {
      const keys = Object.keys(stroke)
      expect(keys).toEqual(expect.arrayContaining(["id", "writeOrder", "zOrder", "contour"]))
      expect(keys.every((key) => [
        "id", "writeOrder", "zOrder", "centerline", "contour", "t0Ms", "durationMs",
      ].includes(key))).toBe(true)

      expect(stroke.id).toBe(`s${stroke.writeOrder}`)
      expect(Number.isInteger(stroke.writeOrder)).toBe(true)
      expect(stroke.writeOrder).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(stroke.zOrder)).toBe(true)
      expect(stroke.zOrder).toBeGreaterThanOrEqual(0)
      expect(stroke.contour.startsWith("#")).toBe(false)
      expect(stroke.centerline?.startsWith("#") ?? false).toBe(false)
      expect(stroke.t0Ms === undefined || (Number.isFinite(stroke.t0Ms) && stroke.t0Ms >= 0)).toBe(true)
      expect(stroke.durationMs === undefined || (Number.isFinite(stroke.durationMs) && stroke.durationMs >= 0)).toBe(true)

      expect(ids.has(stroke.id)).toBe(false)
      expect(contours.has(stroke.contour)).toBe(false)
      expect(zOrders.has(stroke.zOrder)).toBe(false)
      ids.add(stroke.id)
      contours.add(stroke.contour)
      zOrders.add(stroke.zOrder)
      if (stroke.centerline) {
        expect(centerlines.has(stroke.centerline)).toBe(false)
        centerlines.add(stroke.centerline)
      }
    }

    // This fixture has filtered records, so write order is intentionally not
    // interchangeable with either the JSON index or final paint order.
    expect(scene!.strokes.some((stroke, index) => stroke.writeOrder !== index)).toBe(true)
    expect(scene!.strokes.some((stroke) => stroke.writeOrder !== stroke.zOrder)).toBe(true)
  })

  test("resolves every reference to one role-correct M/L/Z-only path", () => {
    const scene = sceneMetadata(sceneSvg)!
    const paths = pathElementsById(sceneSvg)
    const decoded = parseStrokes(note.pages[1].totalPathBuffer, note.pageWidth, note.pageHeight, {
      includeErasers: true,
      includeContours: true,
    })
    const decodedByOrder = new Map(decoded.map((stroke) => [stroke.writeOrder, stroke]))
    let eraseCoverCount = 0
    let missingCenterlineCount = 0

    for (const stroke of scene.strokes) {
      const source = decodedByOrder.get(stroke.writeOrder)
      expect(source).toBeDefined()

      const final = paths.get(stroke.contour)
      expect(final).toBeDefined()
      const expectedRole = source!.isEraser ? "erase-cover" : "final-contour"
      expect(final!.attributes["oi:role"]).toBe(expectedRole)
      if (expectedRole === "erase-cover") eraseCoverCount++

      for (const attribute of Object.keys(final!.attributes)) {
        expect(PROFILE_PATH_ATTRIBUTES.has(attribute)).toBe(true)
      }
      expect(final!.attributes.transform).toBeUndefined()
      expect(final!.attributes.d).not.toBe("")
      expect(final!.attributes.d).toMatch(PATH_DATA_V1)

      if (final!.attributes.fill === "none") {
        assertRgb(final!.attributes.stroke)
        expect(Number.isFinite(Number(final!.attributes["stroke-width"]))).toBe(true)
        expect(Number(final!.attributes["stroke-width"])).toBeGreaterThanOrEqual(0)
        expect(final!.attributes["stroke-linecap"]).toBe("round")
        expect(final!.attributes["stroke-linejoin"]).toBe("round")
      } else {
        assertRgb(final!.attributes.fill)
      }

      if (stroke.centerline) {
        const centerline = paths.get(stroke.centerline)
        expect(centerline).toBeDefined()
        expect(centerline!.attributes["oi:role"]).toBe("centerline")
        expect(centerline!.attributes.visibility).toBe("hidden")
        expect(centerline!.attributes.fill).toBe("none")
        assertRgb(centerline!.attributes.stroke)
        expect(centerline!.attributes.d).toMatch(PATH_DATA_V1)
        expect(centerline!.attributes.d).not.toContain(" Z")
        expect(centerline!.attributes.transform).toBeUndefined()
        for (const attribute of Object.keys(centerline!.attributes)) {
          expect(PROFILE_PATH_ATTRIBUTES.has(attribute)).toBe(true)
        }
      } else {
        missingCenterlineCount++
        expect(source!.points).toHaveLength(0)
      }
    }

    expect(eraseCoverCount).toBeGreaterThan(0)
    expect(missingCenterlineCount).toBeGreaterThan(0)
    expect(sceneSvg).not.toContain('d=""')
    expect([...paths.values()].every(({ attributes }) =>
      ["final-contour", "erase-cover", "centerline"].includes(attributes["oi:role"]),
    )).toBe(true)

    // Non-eraser source records marked as removed must not reappear merely
    // because they are still physically present in TOTALPATH.
    const emittedOrders = new Set(scene.strokes.map((stroke) => stroke.writeOrder))
    expect(decoded.filter((stroke) => !stroke.isEraser && stroke.trailStatus !== undefined).every(
      (stroke) => !emittedOrders.has(stroke.writeOrder),
    )).toBe(true)
  })

  test("keeps the ordinary static SVG rendering and searchable payload", () => {
    expect(visiblePathTags(sceneSvg)).toEqual(visiblePathTags(plainVectorSvg))
    expect(sceneSvg).toContain(`<metadata id="${OI_VECTOR_SCENE_METADATA_ID}" type="${OI_VECTOR_SCENE_MIME_TYPE}">`)

    const background = /<image data-page-background="true"[^>]*xlink:href="(data:image\/png;base64,[A-Za-z0-9+/=]+)"\/>/.exec(sceneSvg)
    expect(background).not.toBeNull()
    expect(sceneSvg).toContain('<text ')
    expect(sceneSvg).toContain('fill="transparent"')

    expect(sceneSvg.indexOf("<metadata ")).toBeLessThan(sceneSvg.indexOf('data-page-background="true"'))
    expect(sceneSvg.indexOf('data-page-background="true"')).toBeLessThan(sceneSvg.indexOf('oi:role="final-contour"'))
    expect(sceneSvg.indexOf("<text ")).toBeLessThan(sceneSvg.indexOf('oi:role="centerline"'))

    expect(sceneSvg).not.toMatch(/<(?:script|style|animate|animateMotion|set)\b/)
    expect(sceneSvg).not.toMatch(/\son\w+=/)
    for (const href of sceneSvg.matchAll(/xlink:href="([^"]+)"/g)) {
      expect(href[1]).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    }
  })

  test("keeps raster-only ink in a PNG overlay above vector paths", () => {
    expect(sceneMetadata(overlaySvg)).toBeDefined()
    const overlay = /<image data-raster-ink-overlay="true"[^>]*xlink:href="(data:image\/png;base64,[A-Za-z0-9+/=]+)"\/>/.exec(overlaySvg)
    expect(overlay).not.toBeNull()
    expect(overlaySvg.indexOf('oi:role="final-contour"')).toBeLessThan(
      overlaySvg.indexOf('data-raster-ink-overlay="true"'),
    )
    expect(overlaySvg.indexOf('data-raster-ink-overlay="true"')).toBeLessThan(
      overlaySvg.indexOf('oi:role="centerline"'),
    )
  })

  test("uses a versioned static page with no metadata for raster fallback", () => {
    const root = rootAttributes(fallbackSvg)
    expect(root["xmlns:oi"]).toBe(OI_VECTOR_SCENE_NAMESPACE)
    expect(root["oi:scene-version"]).toBe("1")
    expect(root["oi:document-id"]).toBe("spec-raster-fallback")
    expect(root["oi:page-index"]).toBe("0")
    expect(root["oi:page-count"]).toBe(String(fallbackNote.pages.length))
    expect(sceneMetadata(fallbackSvg)).toBeUndefined()
    expect(fallbackSvg).not.toContain("oi:role=")
    expect(fallbackSvg).toContain('data-page-background="true"')
    expect(stripSceneOnlyRootAttributes(fallbackSvg)).toBe(plainFallbackSvg)
  })

  test("serializes optional real timing and omits unavailable timing", async () => {
    const timedNote = new SupernoteX(await readFixture("ink-a5x-2.14.28-old-pen-width.note"))
    const [page] = prepareVectorInkPages(timedNote, [1], 1)
    const timedIndex = page.styles.findIndex(
      (style, index) => style.shape === "path" && page.strokes[index].points.length > 0,
    )
    expect(timedIndex).toBeGreaterThanOrEqual(0)

    const strokes = page.strokes.map((stroke, index) =>
      index === timedIndex ? { ...stroke, t0Ms: 125, durationMs: 480 } : stroke,
    )
    const backgroundNote = buildVectorInkBackgroundNote(timedNote, [page])
    const [background] = await toImage(backgroundNote, [1])
    const svg = addSvgPage(
      timedNote.pages[0],
      background,
      timedNote.pageWidth,
      timedNote.pageHeight,
      {
        strokes,
        strokeStyles: page.styles,
        embedScene: true,
        documentId: "spec-timed-page",
        pageIndex: 0,
        pageCount: 1,
      },
    )
    const scene = sceneMetadata(svg)!
    const timed = scene.strokes.find((stroke) => stroke.writeOrder === strokes[timedIndex].writeOrder)!
    expect(timed.t0Ms).toBe(125)
    expect(timed.durationMs).toBe(480)
    expect(scene.strokes.filter((stroke) => stroke !== timed).every(
      (stroke) => stroke.t0Ms === undefined && stroke.durationMs === undefined,
    )).toBe(true)
  }, 60000)
})

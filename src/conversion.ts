import { ILayer, ISupernote } from "~/format"
import sharp, { OverlayOptions, SharpOptions } from "sharp"
import Color from "color"

/**
 * Convert a Supernote file to one or more Sharp image objects.
 * @param note Parsed Supernote.
 * @param pageNumbers Optional page numbers to export (defaults to all). Indexing starts at 1.
 */
export async function toSharp(note: ISupernote, pageNumbers?: number[]) {
  const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages
  const decoder = new RattaRLEDecoder()
  return pages.map((page, pageIndex) => {
    const overlays = page.LAYERSEQ.map((name) => page[name] as ILayer)
      .filter((layer) => layer.bitmapBuffer !== null && layer.bitmapBuffer.length)
      .map((layer): OverlayOptions => {
        try {
          const buffer = decoder.decode(
            layer.bitmapBuffer as Buffer,
            note.pageWidth,
            note.pageHeight
          )
          return {
            input: buffer,
            raw: {
              width: note.pageWidth,
              height: note.pageHeight,
              channels: 4,
            },
          }
        } catch (error) {
          throw new Error(`Could not parse ${pageIndex}-${layer.LAYERNAME}`)
        }
      })
      .reverse()
    const image = sharp(getSharpBackgroundOptions(note)).composite(overlays)
    return image
  })
}

/**
 * Get Sharp background creation options for a note.
 * @param note Parsed Supernote.
 * @returns Options to create a background image with Sharp.
 */
export function getSharpBackgroundOptions(note: ISupernote): SharpOptions {
  return {
    create: {
      width: note.pageWidth,
      height: note.pageHeight,
      channels: 4,
      background: "white",
    },
  }
}

/** Color palette to use as substitutes for the Supernote's colors. */
export interface IColorPalette extends Record<string, Color> {
  background: Color
  black: Color
  darkGray: Color
  gray: Color
  white: Color
  markerBlack: Color
  markerDarkGray: Color
  markerGray: Color
}

/** Default color palette to use based on named colors in the color library. */
const defaultPalette: IColorPalette = {
  background: Color("transparent"),
  black: Color("black"),
  darkGray: Color("darkgray"),
  gray: Color("gray"),
  white: Color("white"),
  markerBlack: Color("black"),
  markerDarkGray: Color("darkgray"),
  markerGray: Color("gray"),
}

/** An encoded color palette as found in the Supernote's file buffer. */
export interface IEncodedPalette extends Record<string, number> {
  black: number
  background: number
  darkGray: number
  gray: number
  white: number
  markerBlack: number
  markerDarkGray: number
  markerGray: number
}

/** Decoder for the Ratta RLE protocol. */
export class RattaRLEDecoder {
  encodedPalette: IEncodedPalette = {
    black: 0x61,
    background: 0x62,
    darkGray: 0x63,
    gray: 0x64,
    white: 0x65,
    markerBlack: 0x66,
    markerDarkGray: 0x67,
    markerGray: 0x68,
  }
  specialLengthMarker = 0xff
  specialLength = 0x4000
  specialLengthForBlank = 0x400

  /**
   * @param buffer Input buffer following Ratta RLE protocol.
   * @param width Page width.
   * @param height Page height.
   * @param palette Optionally custom palette.
   * @param allBlank Blank toggle.
   * @returns Decoded buffer.
   * Adopted from https://github.com/jya-dev/supernote-tool.
   */
  decode(buffer: Buffer, width: number, height: number, palette?: IColorPalette, allBlank = false) {
    const pal = palette ?? defaultPalette
    const translation = Object.entries(this.encodedPalette).reduce(
      (acc: Record<number, Color>, [key, value]) => {
        acc[value] = pal[key] ?? defaultPalette[key]
        return acc
      },
      {}
    )

    const expectedLength = width * height * 4
    const chunks: Buffer[] = []
    let waiting: [number, number][] = []
    let holder: [number, number] | null = null
    let [color, length] = [0, 0]
    for (let index = 1; index < buffer.length; index += 2) {
      color = buffer.at(index - 1) as number
      length = buffer.at(index) as number
      let pushed = false

      if (holder !== null) {
        let [prevColor, prevLength] = holder as [number, number]
        holder = null
        if (color === prevColor) {
          length = 1 + length + (((prevLength & 0x7f) + 1) << 7)
          waiting.push([color, length])
          pushed = true
        } else {
          prevLength = ((prevLength & 0x7f) + 1) << 7
          waiting.push([prevColor, prevLength])
        }
      }

      if (!pushed) {
        if (length === this.specialLengthMarker) {
          if (allBlank) length = this.specialLengthForBlank
          else length = this.specialLength
          waiting.push([color, length])
          pushed = true
        } else if ((length & 0x80) !== 0) {
          holder = [color, length]
        } else {
          length += 1
          waiting.push([color, length])
          pushed = true
        }
      }
      for (const [color, length] of waiting.values()) {
        this.addColorBuffer(chunks, color, length, translation)
      }
      waiting = []
    }

    if (holder !== null) {
      ;[color, length] = holder as [number, number]
      length = this.adjustTailLength(length, this.getChunksLength(chunks), expectedLength)
      if (length > 0) {
        this.addColorBuffer(chunks, color, length, translation)
      }
    }

    let result = Buffer.concat(chunks)
    if (result.length !== expectedLength)
      throw new Error("Buffer length doesn't match expected length.")
    return result
  }

  addColorBuffer(
    chunks: Buffer[],
    encodedColor: number,
    length: number,
    translation: Record<number, Color>
  ): Buffer[] {
    let newColor = encodedColor === -1 ? Color("transparent") : translation[encodedColor]
    let chunk: Buffer
    if (newColor.alpha() === 0) {
      chunk = Buffer.from(new Uint8Array([0, 0, 0, 0]))
    } else {
      chunk = Buffer.from(new Uint8Array([...newColor.rgb().array(), ~~(255 * newColor.alpha())]))
    }
    for (let index = 0; index < length; index++) {
      chunks.push(chunk)
    }
    return chunks
  }

  adjustTailLength(tailLength: number, uncompressedLength: number, expectedLength: number): number {
    const gap = expectedLength - uncompressedLength
    let length: number
    for (let i = 7; i >= 0; i--) {
      length = ((tailLength & 0x7f) + 1) << i
      if (length <= gap) {
        return length
      }
    }
    return 0
  }

  getChunksLength(chunks: Buffer[]): number {
    return chunks.reduce((acc: number, chunk) => acc + chunk.length, 0)
  }
}

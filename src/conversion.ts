import { ILayer, ISupernote } from "./format"
import { Image, ColorModel } from 'image-js';
import Color from "color"

type Pixel = [number, number, number, number]; // Define type for pixel data (alpha, red, green, blue)

async function compositeImages(sourceImage: Image, destinationImage: Image) {
  if (sourceImage.width !== destinationImage.width || sourceImage.height !== destinationImage.height) {
    throw new Error('Images must have the same dimensions for compositing.');
  }

  for (let y = 0; y < destinationImage.height; y++) {
    for (let x = 0; x < destinationImage.width; x++) {
      const sourcePixel = sourceImage.getPixelXY(x, y) as Pixel; // Explicitly cast for type safety
      const destinationPixel = destinationImage.getPixelXY(x, y) as Pixel;

      const blendedPixel = blendPixelOverlay(sourcePixel, destinationPixel);
      destinationImage.setPixelXY(x, y, blendedPixel);
    }
  }
}

function blendPixelOverlay(sourcePixel: Pixel, destinationPixel: Pixel): Pixel {
  const [sourceA, sourceR, sourceG, sourceB] = sourcePixel;
  const [destinationA, destinationR, destinationG, destinationB] = destinationPixel;

  // HACK: if the pixel is fully transparent just pass the lower pixel through
  if (sourceR === 0 && sourceG === 0 && sourceB === 0 && sourceA == 0) {
    return [destinationA, destinationR, destinationG, destinationB] as Pixel;
  }

  return sourcePixel;
}

/**
 * Convert a Supernote file to one or more image-js image objects.
 * @param note Parsed Supernote.
 * @param pageNumbers Optional page numbers to export (defaults to all). Indexing starts at 1.
 */
export function toImage(note: ISupernote, pageNumbers?: number[]) {
  const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages
  const decoder = new RattaRLEDecoder()
  return Promise.all(pages.map(async (page, pageIndex) => {
    const overlays = page.LAYERSEQ.map((name) => page[name] as ILayer)
      .filter((layer) => layer.bitmapBuffer !== null && layer.bitmapBuffer.length);

    const promises = overlays.map(async (layer): Promise<Image> => {
          let buffer = null

          if (layer.LAYERNAME == "BGLAYER" && page.PAGESTYLE.startsWith('user_')) {
            return await Image.load(layer.bitmapBuffer as Buffer)
          }
          buffer = decoder.decode(
            layer.bitmapBuffer as Buffer,
            note.pageWidth,
            note.pageHeight,
          )
          return new Image(note.pageWidth, note.pageHeight, buffer, {components: 3, alpha: 1});
    })

    let images = await Promise.all(promises);
    images = images.reverse();
    let output = images[0].clone();
    for (let i = 1; i < overlays.length; i++) {
      compositeImages(images[i], output);
    }

    return output.grey({keepAlpha: true});
  }))
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

  darkGrayX2: Color,
  grayX2: Color,
  markerDarkGrayX2: Color,
  markerGrayX2: Color,
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

  darkGrayX2: Color("darkgray"),
  grayX2: Color("gray"),
  markerDarkGrayX2: Color("darkgray"),
  markerGrayX2: Color("gray"),
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

  darkGrayX2: number,
  grayX2: number,
  markerDarkGrayX2: number,
  markerGrayX2: number,
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

    darkGrayX2:0x9D,
    grayX2: 0xC9,
    markerDarkGrayX2: 0x9E,
    markerGrayX2: 0xCA,
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
      [color, length] = holder as [number, number]
      length = this.adjustTailLength(length, this.getChunksLength(chunks), expectedLength)
      if (length > 0) {
        this.addColorBuffer(chunks, color, length, translation)
      }
    }

    let result = Buffer.concat(chunks)
    if (result.length !== expectedLength)
      throw new Error(`Buffer length ${result.length} doesn't match expected length ${expectedLength}.`)
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
    if (newColor === undefined) {
      throw Error(`unknown color 0x${encodedColor.toString(16)}`)
    }
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

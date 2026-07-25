# Supernote file-format support

This library uses [image-js](https://github.com/image-js/image-js) and can be used inside of browser environments and/or node.

Ratta Supernote has often commented that the file-format is yet unstable and shouldn't be much relied upon (yet). Please keep this in mind.

For some quick snippets, take a look at the [smoke tests](./tests/main.test.ts).

### Generating searchable PDFs

`toPdf` renders each page's raster image into a PDF page and overlays the recognized handwriting (RTR) text invisibly at the location it was written, so the PDF is searchable and words can be selected/copied from the image. See [tests/pdf.test.ts](./tests/pdf.test.ts) for a full example.

```ts
import { SupernoteX, toPdf } from 'supernote-typescript';

const note = new SupernoteX(buffer);
const pdfBytes = await toPdf(note);
```

The default font (Helvetica) only supports Latin text. Pass `fontBytes` with a Unicode TTF/OTF to support other scripts:

```ts
const pdfBytes = await toPdf(note, { fontBytes: await fs.readFile('NotoSans-Regular.ttf') });
```

## Developer Notes

### Test Individual Suite

```
npx jest -t 'manta'
```

### Publish

```
npm version patch
npm run build
npm publish
```


## Users

- [Supernote Obsidian Plugin](https://github.com/philips/supernote-obsidian-plugin)
- [Supernote Joplin Plugin](https://github.com/individual-it/supernote-joplin)

## Thank You

- Thank you to [Tiemen Schuijbroek](https://gitlab.com/Tiemen/supernote) for developing the initial supernote Typescript library I forked.
- Heavily inspired by the [Python implementation by jya-dev](https://github.com/jya-dev/supernote-tool). This one currently only supports the X series notebooks.

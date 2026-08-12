import * as fs from 'fs-extra'
import { describe, test, expect } from 'vitest'
import { extractPageForms, pdfPageToSvg, pdfStreamToSvg } from '../scripts/pdf-vector'

/** A minimal Supernote-shaped export: a page tree whose pages carry their ink
 * in a /Subtype /Stamp annotation, the way the device's own PDFs do.
 *
 * `ink` names each page's content stream, or `null` for a page the device drew
 * no vector ink on. Objects are emitted so that *file* order disagrees with
 * page order -- the later page's form is written first -- which is what tells
 * a page-tree walk apart from a scan of the file. */
function buildPdf(ink: (string | null)[]): Buffer {
	const pageObj = (i: number) => 3 + i
	const annotObj = (i: number) => 3 + ink.length + i * 2
	const formObj = (i: number) => annotObj(i) + 1

	const objects: string[] = []
	const add = (num: number, body: string) => objects.push(`${num} 0 obj\n${body}\nendobj\n`)

	add(1, `<</Type/Catalog/Pages 2 0 R>>`)
	add(2, `<</Type/Pages/Count ${ink.length}/Kids[${ink.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}]>>`)
	ink.forEach((content, i) => {
		const annots = content === null ? '' : `/Annots[${annotObj(i)} 0 R]`
		add(pageObj(i), `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]${annots}>>`)
	})
	// deliberately back to front, so file order is not page order
	for (let i = ink.length - 1; i >= 0; i--) {
		const content = ink[i]
		if (content === null) continue
		add(annotObj(i), `<</Type/Annot/Subtype/Stamp/Rect[0 0 100 100]/P ${pageObj(i)} 0 R/AP<</N ${formObj(i)} 0 R>>>>`)
		add(
			formObj(i),
			`<</Type/XObject/Subtype/Form/BBox[0 0 100 100]/Length ${content.length}>>\nstream\n${content}\nendstream`,
		)
	}

	return Buffer.from(`%PDF-1.4\n${objects.join('')}%%EOF\n`, 'latin1')
}

const text = (streams: Buffer[]) => streams.map((s) => s.toString('latin1').trim())

describe('extractPageForms', () => {
	test('indexes forms by page, not by position in the file', () => {
		const forms = extractPageForms(buildPdf(['first', 'second', 'third']))
		expect(forms.map(text)).toEqual([['first'], ['second'], ['third']])
	})

	test('a page with no ink keeps its place instead of shifting the rest', () => {
		// The bug this guards: scanned in file order these two streams are
		// entries 0 and 1, so page 3's ink would be shown as page 2's and
		// page 3 would fall off the end.
		const forms = extractPageForms(buildPdf(['first', null, 'third']))
		expect(forms.map(text)).toEqual([['first'], [], ['third']])
	})

	test('reports every page of an export that draws nothing at all', () => {
		expect(extractPageForms(buildPdf([null, null]))).toEqual([[], []])
	})

	test('a stream it cannot decompress costs that page its ink, not its place', () => {
		// /FlateDecode over bytes that are not deflate data at all.
		const pdf = buildPdf(['first', 'broken', 'third']).toString('latin1').replace('/Length 6>>', '/Length 6/Filter/FlateDecode>>')
		const forms = extractPageForms(Buffer.from(pdf, 'latin1'))
		expect(forms.map(text)).toEqual([['first'], [], ['third']])
	})

	test('page count follows the page tree even where no page has ink', () => {
		expect(extractPageForms(buildPdf([null, null, null])).length).toBe(3)
	})
})

describe('extractPageForms on the shipped exports', () => {
	const pageCounts: Record<string, number[]> = {
		// the two fixtures whose export draws nothing on a trailing page --
		// page 3 of sticker is blank, page 3 of straight-line is erased away
		'sticker.pdf': [1, 1, 0],
		'straight-line.pdf': [1, 1, 0],
		// four pens, every stroke erased: a vector export that draws nothing
		'erase-no-white-pen.pdf': [0],
		'nomad-3.26.40-blank-2p.pdf': [0, 0],
		// and a couple that do draw on every page
		'caligraphy.pdf': [1, 1, 1, 1],
		'stroke-isolation.pdf': [1, 1, 1, 1, 1],
	}

	for (const [file, expected] of Object.entries(pageCounts)) {
		test(`${file} resolves one entry per page`, async () => {
			const forms = extractPageForms(await fs.readFile(`tests/input/${file}`))
			expect(forms.map((f) => f.length)).toEqual(expected)
		})
	}
})

describe('pdfPageToSvg', () => {
	const square = '1 0 0 -1 0 100 cm 0 0 0 rg 0 0 m 10 0 l 10 10 l 0 10 l h f'

	test('a page with no forms draws nothing, which is a real answer', () => {
		expect(pdfPageToSvg([], 100)).toEqual({ paths: [], inkArea: 0 })
	})

	test('sums a page over the forms it draws', () => {
		const one = pdfPageToSvg([Buffer.from(square, 'latin1')], 100)
		const two = pdfPageToSvg([Buffer.from(square, 'latin1'), Buffer.from(square, 'latin1')], 100)
		expect(one.inkArea).toBeCloseTo(100)
		expect(two.paths.length).toBe(2)
		expect(two.inkArea).toBeCloseTo(200)
	})

	test('gives each form its own graphics state, rather than concatenating', () => {
		// Supernote's forms open with a y-flip `cm` and never balance it, so
		// run end to end the second one would be drawn through the first's
		// transform -- landing somewhere other than where it belongs.
		const merged = pdfPageToSvg([Buffer.from(square, 'latin1'), Buffer.from(square, 'latin1')], 100)
		const joined = pdfStreamToSvg(Buffer.from(`${square}\n${square}`, 'latin1'), 100)
		expect(merged.paths[1].d).toBe(merged.paths[0].d)
		expect(joined.paths[1].d).not.toBe(joined.paths[0].d)
	})
})

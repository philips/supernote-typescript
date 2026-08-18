// One-shot profiling harness for plans/profile-vector-pdf.md step 1.
//
// vitest bench's warmup average is noisy for a one-shot go/no-go decision, so
// the actual numbers in the plan's profile table come from this script: it
// times each phase of toPdf({ vectorInk: true }) separately -- the pure
// primitive-build step, pdf-lib's content-stream serialization (addPdfPage
// with drawSvgPath), and pdfDoc.save() -- against toPdf() (raster) on the same
// fixtures, and reports the output PDF byte size for each. Run after
// `npm run build` so lib/ is fresh.
//
//   node scripts/profile-vector-pdf.mjs
//
// Not part of the shipped package; not type-checked by tsconfig.scripts.json
// (tsc only compiles .ts), so it doesn't affect `npm run build:site`.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { toImage } from '../lib/conversion.js';
import { createPdfContext, addPdfPage, toPdf } from '../lib/pdf.js';
import {
	prepareVectorInkPages,
	buildRenderNoteForVectorInk,
	buildVectorInkPrimitives,
} from '../lib/vector-ink.js';
import { SupernoteX } from '../lib/parsing.js';

function readUint8(file) {
	const data = readFileSync(`tests/input/${file}`);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function ms(fn) {
	const t0 = performance.now();
	const out = fn();
	// fn may be async; await happens outside for sync measurement of sync fns.
	return [performance.now() - t0, out];
}

async function msAsync(fn) {
	const t0 = performance.now();
	const out = await fn();
	return [performance.now() - t0, out];
}

const files = [
	'sticker-n5-20260016-plugin-artwork.note',
	'caligraphy-n5-20260016-widths-erase.note',
	'turkish-a6x-20230015-handwriting-erase.note',
	'demo-a5x-20230015-1to10.note',
];

function fmt(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
	return `${n} B`;
}

console.log('fixture | raster total | vector total | vector build | vector addPdfPage | vector save | raster bytes | vector bytes');
console.log('---|---|---|---|---|---|---|---');

for (const file of files) {
	const buf = readUint8(file);
	const sn = new SupernoteX(buf);

	// Raster baseline: total + bytes.
	const [rasterTotal, rasterBytes] = await msAsync(() => toPdf(sn));

	// Vector: split into phases so step 2 can attribute cost.
	const [tBuild, vectorInkPages] = await msAsync(() => prepareVectorInkPages(sn, undefined, 1));
	let buildPrimitives = 0;
	for (const vip of vectorInkPages) {
		if (vip.useVectorInk) {
			const [t] = ms(() => buildVectorInkPrimitives(vip.strokes, vip.styles));
			buildPrimitives += t;
		}
	}
	const buildTotal = tBuild + buildPrimitives;

	const renderNote = buildRenderNoteForVectorInk(sn, vectorInkPages);
	const images = await toImage(renderNote, undefined, { upscale: 1 });

	const ctx = await createPdfContext();
	const pages = sn.pages;
	const [tAssemble] = await msAsync(async () => {
		for (let i = 0; i < pages.length; i++) {
			const pageNumber = i + 1;
			const vip = vectorInkPages.find((p) => p.pageNumber === pageNumber);
			await addPdfPage(ctx, pages[i], images[i], {
				strokes: vip?.useVectorInk ? vip.strokes : undefined,
				strokeStyles: vip?.useVectorInk ? vip.styles : undefined,
			});
		}
	});

	const [tSave, vectorBytes] = await msAsync(() => ctx.pdfDoc.save());

	// Whole-vector sanity check vs. the split sum (catches a phase being missed).
	const vectorSplitTotal = buildTotal + tAssemble + tSave;

	console.log(
		[
			file,
			`${rasterTotal.toFixed(0)} ms`,
			`${vectorSplitTotal.toFixed(0)} ms`,
			`${buildTotal.toFixed(0)} ms`,
			`${tAssemble.toFixed(0)} ms`,
			`${tSave.toFixed(0)} ms`,
			fmt(rasterBytes.byteLength ?? rasterBytes.length),
			fmt(vectorBytes.byteLength ?? vectorBytes.length),
		].join(' | '),
	);

	// Per-fixture detail: isolate drawSvgPath cost from the background PNG
	// embed + text layer that addPdfPage also does, and report geometry
	// counts so the contour-ring-count candidate can be judged.
	let strokeCount = 0;
	let primCount = 0;
	let contourPoints = 0;
	let centerlinePoints = 0;
	for (const vip of vectorInkPages) {
		if (!vip.useVectorInk) continue;
		const prims = buildVectorInkPrimitives(vip.strokes, vip.styles);
		primCount += prims.length;
		for (const s of vip.strokes) {
			strokeCount++;
			centerlinePoints += s.points.length;
			for (const ring of s.contour ?? []) contourPoints += ring.length;
		}
	}

	// addPdfPage without strokes: background embed + recognition text only.
	const ctxBase = await createPdfContext();
	const [tAssembleBase] = await msAsync(async () => {
		for (let i = 0; i < pages.length; i++) {
			await addPdfPage(ctxBase, pages[i], images[i]);
		}
	});
	const drawSvgPathCost = tAssemble - tAssembleBase;

	console.log(
		`  detail: strokes=${strokeCount} primitives=${primCount} contourPts=${contourPoints} centerlinePts=${centerlinePoints} | addPdfPage(no strokes)=${tAssembleBase.toFixed(0)} ms | drawSvgPath delta=${drawSvgPathCost.toFixed(0)} ms`,
	);
}

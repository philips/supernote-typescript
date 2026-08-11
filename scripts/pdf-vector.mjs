/**
 * Converts the vector ink inside Supernote's own PDF export into SVG, so it
 * can be shown next to what this library renders (see `build-fixture-site.ts`).
 *
 * This is a build-time tool for the comparison site, not part of the shipped
 * package -- it only has to read the PDFs Supernote itself writes, so it
 * handles the operator subset those use rather than the full PDF spec:
 * `cm`/`q`/`Q` for the transform stack, `m`/`l`/`c`/`h` for paths,
 * `f`/`f*`/`S`/`s`/`n` to paint them, `rg`/`RG`/`g`/`G` for colour and `w`
 * for stroke width. Anything else is skipped.
 *
 * Two things about those exports are worth knowing, because both took a
 * while to pin down and the conversion depends on them:
 *
 * 1. **Ink lives in Form XObjects**, not the page content stream -- the page
 *    itself just holds a background image (the template) plus a reference.
 * 2. **The exporter uses two different styles, sometimes in one file**:
 *    filled outlines (`f`) that trace the rendered shape of a stroke, and
 *    stroked polylines (`S`) carrying an explicit `w`. The second states a
 *    width as a number instead of drawing it, which makes it much better
 *    ground truth -- see the thickness section of plans/vector-format-spec.md.
 */

import { inflateSync as inflate } from 'node:zlib';

/**
 * A painted path, already converted into SVG's coordinate space.
 * @typedef {object} DevicePath
 * @property {string} d SVG path data.
 * @property {string} [fill] Set when the path was filled.
 * @property {string} [stroke] Set when the path was stroked.
 * @property {number} [strokeWidth] Stroke width in page pixels, with `stroke`.
 * @property {boolean} [evenOdd] Fill used the even-odd rule (`f*`).
 */

/**
 * @typedef {object} DevicePage
 * @property {DevicePath[]} paths
 * @property {number} inkArea Total ink the page lays down, in square page
 *   pixels: the enclosed area of each filled path plus length x width of each
 *   stroked one. Compared against the same measure of our own output.
 */

/** @typedef {[number, number, number, number, number, number]} Matrix */

/** @type {Matrix} */
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** `a x b`, in PDF's row-vector convention.
 * @param {Matrix} a @param {Matrix} b @returns {Matrix} */
function multiply(a, b) {
	return [
		a[0] * b[0] + a[1] * b[2],
		a[0] * b[1] + a[1] * b[3],
		a[2] * b[0] + a[3] * b[2],
		a[2] * b[1] + a[3] * b[3],
		a[4] * b[0] + a[5] * b[2] + b[4],
		a[4] * b[1] + a[5] * b[3] + b[5],
	];
}

/** @param {Matrix} m @param {number} x @param {number} y @returns {[number, number]} */
function apply(m, x, y) {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** How much the transform scales lengths, for carrying stroke widths across
 * it. Supernote's own exports only ever use a y-flip, where this is 1.
 * @param {Matrix} m @returns {number} */
function scaleOf(m) {
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

const grey = (v) => `rgb(${Math.round(v * 255)},${Math.round(v * 255)},${Math.round(v * 255)})`;
const rgb = (r, g, b) =>
	`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

/** Area enclosed by a closed ring, signed by winding direction so that a
 * letter's inner hole subtracts from the shape it sits in rather than adding
 * to it. @param {[number, number][]} ring @returns {number} */
function signedArea(ring) {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
	}
	return sum / 2;
}

/** @param {[number, number][]} ring @returns {number} */
function polylineLength(ring) {
	let total = 0;
	for (let i = 1; i < ring.length; i++) {
		total += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
	}
	return total;
}

/** Points along a cubic bezier, flattened finely enough that measuring its
 * area or length doesn't lose anything visible at page scale. */
function flattenCubic(from, c1, c2, to) {
	/** @type {[number, number][]} */
	const out = [];
	const steps = 16;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([
			u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
			u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1],
		]);
	}
	return out;
}

/**
 * Pulls out every Form XObject's decompressed content stream, in file order,
 * which for these exports is page order.
 *
 * Deliberately a handful of regexes rather than a real PDF object graph: it
 * only ever reads fixtures this repo ships, and keeping it dependency-free
 * means the comparison site needs nothing beyond what's already installed.
 */
/** @param {Buffer} pdfBytes @returns {Buffer[]} */
export function extractFormStreams(pdfBytes) {
	// latin1 keeps one byte per character, so slicing back out recovers the
	// original bytes exactly -- binary stream data must survive this round trip.
	const text = pdfBytes.toString('latin1');
	const objectPattern = /\d+ 0 obj\r?\n?([\s\S]*?)endobj/g;
	/** @type {Buffer[]} */
	const streams = [];
	let match;
	while ((match = objectPattern.exec(text))) {
		const body = match[1];
		if (!body.includes('/Subtype/Form')) continue;
		const streamMatch = /stream\r?\n([\s\S]*?)endstream/.exec(body);
		if (!streamMatch) continue;
		const raw = Buffer.from(streamMatch[1], 'latin1');
		try {
			streams.push(body.includes('FlateDecode') ? inflate(raw) : raw);
		} catch {
			// A stream we can't decompress just means one page has no device
			// side to show; the rest of the site is still worth building.
		}
	}
	return streams;
}

/**
 * Interprets one Form XObject content stream into SVG paths.
 *
 * `pageHeight` is needed because PDF's y axis runs upward and SVG's runs
 * down: after the stream's own transform the result is flipped back, which
 * for Supernote's `1 0 0 -1 0 H cm` cancels out exactly and leaves the
 * coordinates as written -- the same page-pixel space this library decodes
 * strokes into.
 */
/** @param {Buffer} stream @param {number} pageHeight @returns {DevicePage} */
export function pdfStreamToSvg(stream, pageHeight) {
	const tokens = stream.toString('latin1').split(/\s+/).filter(Boolean);

	/** @type {Matrix} */
	let ctm = IDENTITY;
	/** @type {{ctm: Matrix, fill: string, stroke: string, width: number}[]} */
	const stack = [];
	let fill = 'rgb(0,0,0)'; // PDF's initial colour is black, for both operators
	let stroke = 'rgb(0,0,0)';
	let width = 1;

	/** @type {DevicePath[]} */
	const paths = [];
	let inkArea = 0;

	// the path being built, as flattened rings in SVG space
	/** @type {[number, number][][]} */
	let rings = [];
	/** @type {[number, number][]} */
	let current = [];
	/** @type {[number, number]} */
	let cursor = [0, 0]; // in pre-transform user space
	let d = '';

	/** @param {number} x @param {number} y @returns {[number, number]} */
	const toSvg = (x, y) => {
		const [px, py] = apply(ctm, x, y);
		return [px, pageHeight - py];
	};
	const closeRing = () => {
		if (current.length > 1) rings.push(current);
		current = [];
	};
	const numbers = (count) => tokens.slice(index - count, index).map(Number);

	const paint = (doFill, doStroke, evenOdd) => {
		closeRing();
		if (d && (doFill || doStroke)) {
			/** @type {DevicePath} */
			const path = { d: d.trim() };
			if (doFill) {
				path.fill = fill;
				if (evenOdd) path.evenOdd = true;
				inkArea += Math.abs(rings.reduce((sum, ring) => sum + signedArea(ring), 0));
			}
			if (doStroke) {
				path.stroke = stroke;
				path.strokeWidth = width * scaleOf(ctm);
				inkArea += rings.reduce((sum, ring) => sum + polylineLength(ring), 0) * width * scaleOf(ctm);
			}
			paths.push(path);
		}
		rings = [];
		current = [];
		d = '';
	};

	let index = 0;
	for (; index < tokens.length; index++) {
		const op = tokens[index];
		if (!/^[a-zA-Z*'"]+$/.test(op)) continue; // operands are collected by each operator

		switch (op) {
			case 'q':
				stack.push({ ctm, fill, stroke, width });
				break;
			case 'Q': {
				const saved = stack.pop();
				if (saved) ({ ctm, fill, stroke, width } = saved);
				break;
			}
			case 'cm': {
				const [a, b, c, dd, e, f] = numbers(6);
				ctm = multiply([a, b, c, dd, e, f], ctm);
				break;
			}
			case 'w':
				width = numbers(1)[0];
				break;
			case 'g':
				fill = grey(numbers(1)[0]);
				break;
			case 'G':
				stroke = grey(numbers(1)[0]);
				break;
			case 'rg': {
				const [r, g, b] = numbers(3);
				fill = rgb(r, g, b);
				break;
			}
			case 'RG': {
				const [r, g, b] = numbers(3);
				stroke = rgb(r, g, b);
				break;
			}
			case 'm': {
				closeRing();
				const [x, y] = numbers(2);
				cursor = [x, y];
				const p = toSvg(x, y);
				current = [p];
				d += `M${p[0].toFixed(2)},${p[1].toFixed(2)}`;
				break;
			}
			case 'l': {
				const [x, y] = numbers(2);
				cursor = [x, y];
				const p = toSvg(x, y);
				current.push(p);
				d += `L${p[0].toFixed(2)},${p[1].toFixed(2)}`;
				break;
			}
			case 'c': {
				const [x1, y1, x2, y2, x3, y3] = numbers(6);
				const c1 = toSvg(x1, y1), c2 = toSvg(x2, y2), to = toSvg(x3, y3);
				const from = toSvg(cursor[0], cursor[1]);
				current.push(...flattenCubic(from, c1, c2, to));
				cursor = [x3, y3];
				d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${to[0].toFixed(2)},${to[1].toFixed(2)}`;
				break;
			}
			case 'h':
				closeRing();
				d += 'Z';
				break;
			case 'f':
			case 'F':
				paint(true, false, false);
				break;
			case 'f*':
				paint(true, false, true);
				break;
			case 'S':
				paint(false, true, false);
				break;
			case 's':
				d += 'Z';
				paint(false, true, false);
				break;
			case 'B':
				paint(true, true, false);
				break;
			case 'n':
				paint(false, false, false);
				break;
			default:
				break;
		}
	}

	return { paths, inkArea };
}

/** Renders a decoded page as a standalone SVG document. */
/** @param {DevicePage} page @param {number} width @param {number} height @returns {string} */
export function devicePageToSvgDocument(page, width, height) {
	const body = page.paths
		.map((p) => {
			const attrs = [`d="${p.d}"`];
			attrs.push(p.fill ? `fill="${p.fill}"` : 'fill="none"');
			if (p.evenOdd) attrs.push('fill-rule="evenodd"');
			if (p.stroke) attrs.push(`stroke="${p.stroke}"`, `stroke-width="${(p.strokeWidth ?? 1).toFixed(2)}"`, 'stroke-linecap="round"', 'stroke-linejoin="round"');
			return `<path ${attrs.join(' ')}/>`;
		})
		.join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

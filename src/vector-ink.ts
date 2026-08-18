import { RattaRLEDecoder } from './conversion.js';
import { ISupernote, IPage, ILayerNames } from './format.js';
import { parseStrokes, IStroke, IStrokePoint } from './strokes.js';

/** How to render one decoded stroke -- see `deriveStrokeStyle`. For a
 * `'path'`, `color`/`width`/`tier` come directly from the stroke's own real
 * `TOTALPATH` metadata (`IStroke.color`/`thickness`/`pen`), not sampled from
 * a raster -- see https://github.com/philips/supernote-typescript/issues/56
 * and https://github.com/Walnut356/snlib for how that metadata was found.
 *
 * `'rect'` is a distinct record shape TOTALPATH itself encodes, not a style
 * choice: such a record's two points are a filled rectangle's opposite
 * corners rather than a pen path, and it says so in its own `stroke_kind`
 * (`IStroke.isFilledRect`). Having two points is *not* the test -- the
 * ruler tool and the odd two-sample ink stroke store two points too, and
 * treating those as rectangles drew a straight line as a filled box or
 * nothing at all.
 *
 * Unlike `'path'`, a rect's own `color`/`pen`
 * fields are *not* meaningful (confirmed against a real fixture with four
 * differently-colored heading backgrounds on one page: every one of their
 * 2-point records reads the same, uninformative `color` regardless of the
 * background's real, visibly different color). For a Heading's rect (the
 * common case), the real color lives losslessly in the `.note` footer's own
 * `TITLE_*` metadata instead -- see `findMatchingTitleStyle` -- so
 * `deriveStrokeStyle` looks that up first. Only a rect with no
 * matching `TITLE_*` entry (badges/highlight boxes, which aren't Headings)
 * falls back to sampling the page's own rendered ink for color/fill, the way
 * every stroke's style used to be sampled before real per-stroke metadata
 * was found: what fraction of the rectangle's own bounding box is already
 * real ink also separates a solid background (~97-99% filled) from a
 * diagonal cross-hatch one (~25%) -- both confirmed against Supernote's own
 * "Heading" feature, see
 * https://support.supernote.com/1759244-using-titles-keywords-and-stars.
 * `fill` records solid
 * vs. hatch so renderers can draw the latter as something visibly non-solid
 * instead of collapsing it to a solid block that would hide anything drawn
 * on top (confirmed on a real fixture: a hatched heading's own black label
 * text is the same color as the hatch, so a solid fill hides it entirely).
 *
 * `'path'`'s `tier` is `'marker'` exactly when the stroke's own real `pen`
 * field says `'marker'` -- it records the *tool*, not a fixed layer. Whether
 * a given marker stroke ends up beneath the page's other ink is decided per
 * stroke from what it actually crosses; see `isHighlighterPass`. */
export type StrokeStyle =
	| { shape: 'path'; color: string; width: number; tier: 'marker' | 'pen' }
	| { shape: 'rect'; color: string; fill: 'solid' | 'hatch' }
	| { shape: 'skip' };

/** Rings with fewer than 3 points enclose no area, so they'd render as
 * nothing at all -- dropped so a record left holding only degenerate rings
 * falls back to its centerline rather than emitting an invisible path. */
export const MIN_CONTOUR_RING_POINTS = 3;

/** Grey level of a `rgb(g,g,g)` ink color -- every color `parseStrokes`
 * produces is a grey, so the red channel alone orders them from black (0) to
 * white (254). */
export function greyLevel(color: string): number {
	return Number(/rgb\((\d+)/.exec(color)?.[1] ?? '0');
}

/** How far apart two grey levels must sit to count as different shades.
 * The device's own palette entries are far apart (0, 157, 201, 254) while
 * the same shade is recorded a level apart in places (0 vs 1, 157 vs 158,
 * 201 vs 202 -- see plans/vector-format-spec.md), so anything in between
 * separates "the same shade" from "a genuinely lighter one" without needing
 * the palette itself. */
const SAME_GREY_TOLERANCE = 16;

/** At or above this grey level, ink is the palette's white -- the color
 * used to paint *over* something rather than to shade it (see
 * `isHighlighterPass`). */
const WHITE_INK_MIN_GREY = 250;

interface StrokeBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/** A stroke's own extent, from its sampled centerline or -- for a record
 * that has none, like the sticker plugin's silhouette -- its rendered
 * outline. `null` when the record carries no geometry at all. */
export function strokeBounds(stroke: IStroke): StrokeBounds | null {
	const points = stroke.points.length ? stroke.points : (stroke.contour ?? []).flat();
	if (points.length === 0) return null;
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const point of points) {
		if (point.x < minX) minX = point.x;
		if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.y > maxY) maxY = point.y;
	}
	return { minX, maxX, minY, maxY };
}

export function boundsOverlap(a: StrokeBounds, b: StrokeBounds): boolean {
	return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Whether the marker-tool stroke at `index` is a *highlighter pass* -- a
 * wash the device paints beneath the ink already on the page -- rather than
 * a mark that covers what it crosses.
 *
 * The device settles this by darkness, not by tool: where a marker stroke
 * meets ink that is already darker than it, the darker ink stays on top.
 * Confirmed on the device's own renders of three fixtures, in both
 * directions:
 *
 * - `blank-a6x-3.15.27-shapes-rtr.note` page 1's "TEXT HIGHLIGHT"
 *   bands and `link-n6-3.26.40-partial-erase-3p.note` page 1's grey marker rows --
 *   grey marker records written *after* the black pen strokes they cross,
 *   which the device still draws with the black ink fully legible on top.
 * - `sticker-n5-20260016-plugin-artwork.note` page 2 -- a *black* marker line drawn across the sticker
 *   plugin's artwork, which the device draws over the top, hiding the
 *   sticker's own white detail strokes where the line crosses them (see
 *   https://github.com/philips/supernote-typescript/issues/82). Sorting
 *   every marker beneath every pen stroke is what got this backwards, and
 *   is why this is decided per stroke.
 *
 * White is the exception the darkness rule can't express: a white marker is
 * never a highlight, it's a cover-up, and the device draws it over whatever
 * it crosses -- `erase-n5-20260016-all-mechanisms.note` page 1 and `erase-n5-20260016-white-pen-cover.note` page 2 (white
 * marker over a black marker band) and `link-n6-3.26.40-partial-erase-3p.note`
 * page 1's white marker row (over black pen lines), all of which the device
 * renders as the white winning.
 *
 * Only ink recorded *before* this stroke is considered: anything recorded
 * after it already paints over it in record order, which is what the device
 * does too.
 */
export function isHighlighterPass(index: number, boundsList: (StrokeBounds | null)[], greys: number[], drawable: boolean[]): boolean {
	const bounds = boundsList[index];
	if (!bounds) return false;
	const grey = greys[index];
	if (grey >= WHITE_INK_MIN_GREY) return false;
	for (let i = 0; i < index; i++) {
		const other = boundsList[i];
		if (!other || !drawable[i]) continue;
		if (greys[i] + SAME_GREY_TOLERANCE >= grey) continue;
		if (boundsOverlap(bounds, other)) return true;
	}
	return false;
}

/** A backend-independent drawing primitive for one piece of vector ink. */
export type VectorInkPrimitive =
	| { kind: 'rect'; x: number; y: number; width: number; height: number; color: string; fill: 'solid' | 'hatch' }
	| { kind: 'filledPath'; rings: IStrokePoint[][]; color: string }
	| { kind: 'strokedPath'; points: IStrokePoint[]; color: string; width: number };

/** Builds the ordered list of vector-ink primitives for a page. Strokes are
 * drawn in `TOTALPATH` buffer order, with two exceptions:
 *
 * - **`'rect'`s first.** A Heading's `'rect'` background record sits *after*
 *   the digit stroke it's meant to sit behind, so drawing it in place covers
 *   that ink entirely.
 * - **A highlighter pass beneath the rest.** A marker stroke lighter than
 *   ink it crosses is a wash under that ink even though its record comes
 *   later -- see `isHighlighterPass`.
 *
 * Relative order within each group still follows `strokes`. */
export function buildVectorInkPrimitives(strokes: IStroke[], styles: StrokeStyle[] | undefined): VectorInkPrimitive[] {
	const rects: VectorInkPrimitive[] = [];
	const highlighters: VectorInkPrimitive[] = [];
	const ink: VectorInkPrimitive[] = [];

	const boundsList = strokes.map(strokeBounds);
	const greys = strokes.map((_, i) => {
		const style = styles?.[i];
		return style && style.shape !== 'skip' ? greyLevel(style.color) : 0;
	});
	const drawable = strokes.map((_, i) => styles?.[i]?.shape === 'path');

	for (let i = 0; i < strokes.length; i++) {
		const stroke = strokes[i];
		const style = styles?.[i];
		if (!style || style.shape === 'skip') continue;

		if (style.shape === 'rect') {
			if (stroke.points.length < 2) continue;
			const [p0, p1] = stroke.points;
			rects.push({
				kind: 'rect',
				x: Math.min(p0.x, p1.x),
				y: Math.min(p0.y, p1.y),
				width: Math.abs(p1.x - p0.x),
				height: Math.abs(p1.y - p0.y),
				color: style.color,
				fill: style.fill,
			});
			continue;
		}

		const rings = stroke.contour?.filter((ring) => ring.length >= MIN_CONTOUR_RING_POINTS) ?? [];
		let primitive: VectorInkPrimitive | null = null;
		if (rings.length > 0) {
			primitive = { kind: 'filledPath', rings, color: style.color };
		} else if (stroke.points.length > 0) {
			primitive = { kind: 'strokedPath', points: stroke.points, color: style.color, width: style.width };
		}
		if (!primitive) continue;

		const bucket =
			style.tier === 'marker' && isHighlighterPass(i, boundsList, greys, drawable) ? highlighters : ink;
		bucket.push(primitive);
	}

	return [...rects, ...highlighters, ...ink];
}

/** Returns `page` with its ink layers (MAINLAYER, LAYER1-3) cleared so
 * `toImage` rasterizes only the background layer (BGLAYER: template lines,
 * PDF style, etc.) -- used by vector-ink rendering to avoid drawing ink
 * twice once it's been decoded as vector primitives instead. */
export function withoutInkLayers(page: IPage): IPage {
	return {
		...page,
		MAINLAYER: { ...page.MAINLAYER, bitmapBuffer: null },
		LAYER1: { ...page.LAYER1, bitmapBuffer: null },
		LAYER2: { ...page.LAYER2, bitmapBuffer: null },
		LAYER3: { ...page.LAYER3, bitmapBuffer: null },
	};
}

export const INK_LAYER_NAMES: ILayerNames[] = ['MAINLAYER', 'LAYER1', 'LAYER2', 'LAYER3'];

/** A page's rendered ink, decoded once per page. Two uses: the fallback
 * source for a `'rect'` stroke's color/fill (see `deriveStrokeStyle`) when
 * it has no matching `TITLE_*` footer entry, and -- more fundamentally --
 * the only available record of which strokes were *erased*
 * (`strokeInkPresence`). */
export interface InkMask {
	/** 1 where that pixel (row-major, `y * pageWidth + x`) is real rendered
	 * ink, 0 otherwise. */
	isInk: Uint8Array;
	inkPixelCount: number;
	/** RGB of each `isInk` pixel, 3 bytes per pixel at the same index * 3;
	 * meaningless where `isInk` is 0. */
	colors: Uint8Array;
}

/** Decodes `page`'s ink layers (MAINLAYER/LAYER1-3) into one composited
 * `InkMask`, or `null` if the page has no ink layer data at all. */
export function buildInkMask(page: IPage, pageWidth: number, pageHeight: number): InkMask | null {
	const inkLayers = INK_LAYER_NAMES.map((name) => page[name]).filter(
		(layer) => layer?.bitmapBuffer && layer.bitmapBuffer.length,
	);
	if (inkLayers.length === 0) return null;

	const decoder = new RattaRLEDecoder();
	const isInk = new Uint8Array(pageWidth * pageHeight);
	const colors = new Uint8Array(pageWidth * pageHeight * 3);
	let inkPixelCount = 0;
	for (const layer of inkLayers) {
		const pixels = decoder.decode(layer.bitmapBuffer as Uint8Array, pageWidth, pageHeight);
		for (let i = 0, p = 0; p < isInk.length; i += 4, p++) {
			if (isInk[p]) continue;
			if (pixels[i + 3] > 0) {
				isInk[p] = 1;
				colors[p * 3] = pixels[i];
				colors[p * 3 + 1] = pixels[i + 1];
				colors[p * 3 + 2] = pixels[i + 2];
				inkPixelCount++;
			}
		}
	}
	return inkPixelCount > 0 ? { isInk, inkPixelCount, colors } : null;
}

/** Below this fraction of a 2-point stroke's own bounding rectangle already
 * being real ink, `deriveStrokeStyle` treats it as `'skip'` rather than
 * `'rect'`. */
const MIN_RECT_FILL_FRACTION = 0.15;
/** At or above this fill fraction, a 'rect' is treated as `'solid'` fill. */
const SOLID_RECT_MIN_FILL_FRACTION = 0.5;

/** How many points along a stroke `strokeInkPresence` samples. */
const INK_PRESENCE_SAMPLE_COUNT = 60;

/** Below this fraction of a stroke's sampled points finding matching ink in
 * the page's own render, the stroke is dropped entirely. */
const MAX_HIDDEN_INK_PRESENCE = 0.05;
/** How far from a sampled point `strokeInkPresence` looks for matching ink,
 * beyond the stroke's own rendered half width. */
const INK_PRESENCE_SEARCH_MARGIN_PX = 1;
/** How far a rendered ink pixel's grey level may sit from the stroke's own
 * declared color and still count as that stroke's ink. */
const INK_PRESENCE_GREY_TOLERANCE = 48;

/**
 * What fraction of `stroke` still has matching ink in `mask`, the page's own
 * rendered output -- i.e. how much of it the device actually still draws.
 *
 * `displayColor` is the color the stroke is *rendered* in rather than
 * `IStroke.color`, because those differ for Heading label contrast (see
 * `applyHeadingContrastOverrides`).
 */
export function strokeInkPresence(
	stroke: IStroke,
	displayColor: string,
	mask: InkMask,
	pageWidth: number,
	pageHeight: number,
): number {
	if (stroke.points.length === 0) return 1;
	const targetGrey = greyLevel(displayColor);
	const radius = Math.max(1, Math.round(stroke.thickness / (THICKNESS_TO_PIXEL_SCALE * 2))) + INK_PRESENCE_SEARCH_MARGIN_PX;
	const step = Math.max(1, Math.floor(stroke.points.length / INK_PRESENCE_SAMPLE_COUNT));

	let sampled = 0;
	let found = 0;
	for (let i = 0; i < stroke.points.length; i += step) {
		sampled++;
		const centerX = Math.round(stroke.points[i].x);
		const centerY = Math.round(stroke.points[i].y);
		let hit = false;
		for (let y = centerY - radius; y <= centerY + radius && !hit; y++) {
			if (y < 0 || y >= pageHeight) continue;
			for (let x = centerX - radius; x <= centerX + radius; x++) {
				if (x < 0 || x >= pageWidth) continue;
				const p = y * pageWidth + x;
				if (!mask.isInk[p]) continue;
				if (Math.abs(mask.colors[p * 3] - targetGrey) <= INK_PRESENCE_GREY_TOLERANCE) {
					hit = true;
					break;
				}
			}
		}
		if (hit) found++;
	}
	return sampled > 0 ? found / sampled : 1;
}

export function modeColor(colorCounts: Map<string, number>): string | undefined {
	let bestKey: string | undefined;
	let bestCount = 0;
	for (const [key, count] of colorCounts) {
		if (count > bestCount) {
			bestCount = count;
			bestKey = key;
		}
	}
	return bestKey;
}

export function rectBounds(p0: IStrokePoint, p1: IStrokePoint, pageWidth: number, pageHeight: number) {
	return {
		minX: Math.max(0, Math.floor(Math.min(p0.x, p1.x))),
		maxX: Math.min(pageWidth - 1, Math.ceil(Math.max(p0.x, p1.x))),
		minY: Math.max(0, Math.floor(Math.min(p0.y, p1.y))),
		maxY: Math.min(pageHeight - 1, Math.ceil(Math.max(p0.y, p1.y))),
	};
}

/** A Heading rect's real fill/text color, decoded from its `TITLE_*` footer
 * metadata instead of sampled from the raster. */
export interface TitleStyle {
	fill: 'solid' | 'hatch';
	backgroundColor: string;
	textColor: string;
}

/** Decodes an `ITitle.TITLESTYLE` value (7 decimal digits, `1BBBFFF`) into a
 * `TitleStyle` -- `BBB` is the background's grey level, `FFF` the displayed
 * label text's grey level. */
export function parseTitleStyle(titleStyle: string): TitleStyle {
	const backgroundDigits = titleStyle.slice(1, 4);
	const textDigits = titleStyle.slice(4, 7);
	const isHatch = backgroundDigits === '000' && textDigits === '000';
	const backgroundGrey = Number(backgroundDigits);
	const textGrey = Number(textDigits);
	return {
		fill: isHatch ? 'hatch' : 'solid',
		backgroundColor: `rgb(${backgroundGrey},${backgroundGrey},${backgroundGrey})`,
		textColor: `rgb(${textGrey},${textGrey},${textGrey})`,
	};
}

/** One page's `TITLE_*` footer entries (Headings), reduced to their page-pixel
 * rect and decoded `TitleStyle`. */
export interface TitleRectEntry {
	x: number;
	y: number;
	width: number;
	height: number;
	style: TitleStyle;
}

/** `note.titles` is keyed by the footer's `TITLE_PPPPYYYYXXXX` suffix --
 * 4-digit page number, then the title's own `y`/`x` -- across the whole
 * note, not scoped per page, so filtering by the page-number prefix is how
 * one page's own Headings are found. */
export function buildTitleIndex(note: ISupernote, pageNumber: number): TitleRectEntry[] {
	const pagePrefix = String(pageNumber).padStart(4, '0');
	const entries: TitleRectEntry[] = [];
	for (const [key, titles] of Object.entries(note.titles)) {
		if (!key.startsWith(pagePrefix)) continue;
		for (const title of titles) {
			const rectParts = Array.isArray(title.TITLERECT) ? title.TITLERECT : String(title.TITLERECT).split(',');
			const [x, y, width, height] = rectParts.map(Number);
			entries.push({ x, y, width, height, style: parseTitleStyle(title.TITLESTYLE) });
		}
	}
	return entries;
}

/** A rect stroke's transformed corners land within ~1px of its `TITLERECT`
 * counterpart, so a small tolerance absorbs float rounding. */
const TITLE_RECT_MATCH_TOLERANCE_PX = 2;

export function findMatchingTitleStyle(titleIndex: TitleRectEntry[], p0: IStrokePoint, p1: IStrokePoint): TitleStyle | undefined {
	const x = Math.min(p0.x, p1.x);
	const y = Math.min(p0.y, p1.y);
	const width = Math.abs(p1.x - p0.x);
	const height = Math.abs(p1.y - p0.y);
	const entry = titleIndex.find(
		(candidate) =>
			Math.abs(candidate.x - x) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.y - y) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.width - width) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
			Math.abs(candidate.height - height) <= TITLE_RECT_MATCH_TOLERANCE_PX,
	);
	return entry?.style;
}

export function sampleRect(
	mask: InkMask,
	pageWidth: number,
	pageHeight: number,
	p0: IStrokePoint,
	p1: IStrokePoint,
): { fillFraction: number; color: string | undefined } {
	const { minX, maxX, minY, maxY } = rectBounds(p0, p1, pageWidth, pageHeight);
	const colorCounts = new Map<string, number>();
	let total = 0;
	let filled = 0;
	for (let y = minY; y <= maxY; y++) {
		const rowStart = y * pageWidth;
		for (let x = minX; x <= maxX; x++) {
			total++;
			const p = rowStart + x;
			if (!mask.isInk[p]) continue;
			filled++;
			const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
			colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
		}
	}
	return { fillFraction: total > 0 ? filled / total : 0, color: modeColor(colorCounts) };
}

/** Converts `IStroke.thickness` to a stroke-width in page pixels. */
export const THICKNESS_TO_PIXEL_SCALE = 100;

export function signedRingArea(ring: IStrokePoint[]): number {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
	}
	return sum / 2;
}

export function polylineLength(points: IStrokePoint[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	return total;
}

/**
 * The width to actually draw `stroke` at, in page pixels. See
 * `src/svg.ts`'s earlier doc comment for the derivation; this is the same
 * value used by the SVG vector-ink renderer.
 */
export function strokeRenderWidth(stroke: IStroke): number {
	const nominalWidth = stroke.thickness / THICKNESS_TO_PIXEL_SCALE;
	if (!stroke.contour || stroke.contour.length === 0) return nominalWidth;

	const enclosedArea = Math.abs(stroke.contour.reduce((sum, ring) => sum + signedRingArea(ring), 0));
	if (enclosedArea <= 0) return nominalWidth;

	const length = polylineLength(stroke.points);
	const measuredWidth = (Math.sqrt(length * length + Math.PI * enclosedArea) - length) / (Math.PI / 2);
	return measuredWidth > 0 ? measuredWidth : nominalWidth;
}

/**
 * Derives a `StrokeStyle` for one decoded stroke. See `StrokeStyle`'s doc
 * comment for details.
 */
export function deriveStrokeStyle(
	stroke: IStroke,
	mask: InkMask | null,
	titleIndex: TitleRectEntry[],
	pageWidth: number,
	pageHeight: number,
): StrokeStyle {
	if (stroke.isFilledRect && stroke.points.length >= 2 && !stroke.isEraser) {
		const [p0, p1] = stroke.points;
		const titleStyle = findMatchingTitleStyle(titleIndex, p0, p1);
		if (titleStyle) return { shape: 'rect', color: titleStyle.backgroundColor, fill: titleStyle.fill };

		if (!mask) return { shape: 'skip' };
		const { fillFraction, color } = sampleRect(mask, pageWidth, pageHeight, p0, p1);
		if (fillFraction < MIN_RECT_FILL_FRACTION) return { shape: 'skip' };
		return {
			shape: 'rect',
			color: color ? `rgb(${color})` : 'black',
			fill: fillFraction >= SOLID_RECT_MIN_FILL_FRACTION ? 'solid' : 'hatch',
		};
	}

	return {
		shape: 'path',
		color: stroke.color,
		width: strokeRenderWidth(stroke),
		tier: stroke.pen === 'marker' ? 'marker' : 'pen',
	};
}

const MIN_INSIDE_RECT_FRACTION = 0.8;

export function isInsideRectBounds(point: IStrokePoint, bounds: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
	return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

/**
 * Supernote's Heading feature auto-recolors its label text for contrast
 * against the heading's own background. This applies that override to the
 * relevant `'path'` strokes.
 */
export function applyHeadingContrastOverrides(
	strokes: IStroke[],
	styles: StrokeStyle[],
	titleIndex: TitleRectEntry[],
	mask: InkMask | null,
	pageWidth: number,
	pageHeight: number,
): StrokeStyle[] {
	const rectInfoList = strokes
		.map((stroke, i) => {
			if (styles[i].shape !== 'rect') return null;
			const [p0, p1] = stroke.points;
			return {
				bounds: rectBounds(p0, p1, pageWidth, pageHeight),
				textColor: findMatchingTitleStyle(titleIndex, p0, p1)?.textColor,
			};
		})
		.filter((info) => info !== null);
	if (rectInfoList.length === 0) return styles;

	return styles.map((style, i) => {
		if (style.shape !== 'path') return style;
		const stroke = strokes[i];
		if (stroke.isEraser) return style;
		const matchedRect = rectInfoList.find((info) => {
			const insideCount = stroke.points.filter((point) => isInsideRectBounds(point, info.bounds)).length;
			return insideCount / stroke.points.length >= MIN_INSIDE_RECT_FRACTION;
		});
		if (!matchedRect) return style;
		if (matchedRect.textColor) return { ...style, color: matchedRect.textColor };

		if (!mask) return style;
		const colorCounts = new Map<string, number>();
		for (const point of stroke.points) {
			const xi = Math.round(point.x);
			const yi = Math.round(point.y);
			if (xi < 0 || xi >= pageWidth || yi < 0 || yi >= pageHeight) continue;
			const p = yi * pageWidth + xi;
			if (!mask.isInk[p]) continue;
			const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
			colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
		}
		const sampled = modeColor(colorCounts);
		return sampled ? { ...style, color: `rgb(${sampled})` } : style;
	});
}

/** Scales a decoded stroke's `contour` by `factor`. `parseStrokes` transforms
 * `points` using the page dimensions it's handed, so passing upscaled
 * dimensions upscales them for free -- but `contour` arrives in the note's
 * native page space and has to be scaled here. */
export function withUpscaledContour(stroke: IStroke, factor: number): IStroke {
	if (factor === 1 || !stroke.contour) return stroke;
	return {
		...stroke,
		contour: stroke.contour.map((ring) => ring.map((point) => ({ x: point.x * factor, y: point.y * factor }))),
	};
}

/** The vector-ink data prepared for one page. */
export interface VectorInkPage {
	pageNumber: number;
	/** Whether this page's raster ink should be replaced with the vector
	 * primitives derived from `strokes`/`styles`. */
	useVectorInk: boolean;
	/** Decoded strokes, already scaled to the rendering coordinate space
	 * (i.e. upscaled if requested). */
	strokes: IStroke[];
	/** A `StrokeStyle` for each stroke in `strokes`, in the same order. */
	styles: StrokeStyle[];
}

/**
 * Decodes the vector ink for each requested page and decides, per page,
 * whether the decoded strokes are trustworthy enough to replace the page's
 * rasterized ink layers. This is shared by the SVG and PDF renderers so both
 * make the same decision and draw the same strokes.
 */
export function prepareVectorInkPages(
	note: ISupernote,
	pageNumbers: number[] | undefined,
	upscale: number,
): VectorInkPage[] {
	const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;

	const strokesPerPage = pages.map((page) =>
		parseStrokes(page.totalPathBuffer, note.pageWidth * upscale, note.pageHeight * upscale, {
			includeErasers: true,
			includeContours: true,
		}).map((stroke) => withUpscaledContour(stroke, upscale)),
	);

	const result: VectorInkPage[] = [];
	pages.forEach((page, i) => {
		const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
		const nativeStrokes = parseStrokes(page.totalPathBuffer, note.pageWidth, note.pageHeight, {
			includeErasers: true,
			includeContours: true,
		});
		if (nativeStrokes.length === 0) {
			result.push({ pageNumber, useVectorInk: false, strokes: [], styles: [] });
			return;
		}

		const mask = buildInkMask(page, note.pageWidth, note.pageHeight);
		const titleIndex = buildTitleIndex(note, pageNumber);
		const styles = mask
			? nativeStrokes.map((stroke) => deriveStrokeStyle(stroke, mask, titleIndex, note.pageWidth, note.pageHeight))
			: nativeStrokes.map((): StrokeStyle => ({ shape: 'skip' }));
		const displayStyles = applyHeadingContrastOverrides(
			nativeStrokes,
			styles,
			titleIndex,
			mask,
			note.pageWidth,
			note.pageHeight,
		);
		const finalStyles = displayStyles.map((style, j): StrokeStyle => {
			const stroke = nativeStrokes[j];
			if (style.shape !== 'path' || stroke.isEraser) return style;
			if (stroke.trailStatus !== undefined) return { shape: 'skip' };
			if (!mask) return style;
			return strokeInkPresence(stroke, style.color, mask, note.pageWidth, note.pageHeight) < MAX_HIDDEN_INK_PRESENCE
				? { shape: 'skip' }
				: style;
		});
		if (mask && finalStyles.every((style) => style.shape === 'skip')) {
			result.push({ pageNumber, useVectorInk: false, strokes: strokesPerPage[i], styles: [] });
			return;
		}

		const scaledStyles = finalStyles.map((style): StrokeStyle =>
			style.shape === 'path' ? { ...style, width: style.width * upscale } : style,
		);
		result.push({ pageNumber, useVectorInk: true, strokes: strokesPerPage[i], styles: scaledStyles });
	});

	return result;
}

/** Builds a copy of `note` with ink layers removed for every page where
 * `prepareVectorInkPages` decided vector ink should replace the raster ink. */
export function buildRenderNoteForVectorInk(note: ISupernote, vectorInkPages: VectorInkPage[]): ISupernote {
	const useVectorInkByPage = new Map(vectorInkPages.map((p) => [p.pageNumber, p.useVectorInk]));
	return {
		...note,
		pages: note.pages.map((page, i) => (useVectorInkByPage.get(i + 1) ? withoutInkLayers(page) : page)),
	};
}

/** A single point on a decoded pen stroke, already converted to page pixel
 * coordinates (same space as `ISupernote.pageWidth`/`pageHeight`). */
export interface IStrokePoint {
	x: number;
	y: number;
}

/** One continuous pen stroke (a single pen-down-to-pen-up motion), decoded
 * from a page's `TOTALPATH` data. */
export interface IStroke {
	points: IStrokePoint[];
}

/** Marks the start of a fixed-layout preamble that precedes every stroke
 * record in `TOTALPATH` (not just the first). Landmark bytes sit 76 bytes
 * before the stroke's own point-count field, and 8/4 bytes after the two
 * fields that give the page's native digitizer coordinate bounds -- see
 * `parseStrokes`'s doc comment for how those were found. */
const PREAMBLE_LANDMARK = 'superNoteNote';
const LANDMARK_TO_RECORD_OFFSET = 76;
const NATIVE_HEIGHT_BOUND_OFFSET_FROM_LANDMARK = -8;
const NATIVE_WIDTH_BOUND_OFFSET_FROM_LANDMARK = -4;

/** Point count above which a candidate stroke record is assumed to be a
 * false match rather than a real (if unusually long) stroke. Real strokes
 * observed so far top out in the hundreds of points; this just guards
 * against treating an obviously-wrong match (e.g. tens of thousands of
 * points) as real. */
const MAX_PLAUSIBLE_POINT_COUNT = 100_000;

interface RawRecord {
	points: [number, number][];
	end: number;
	/** Whether `end` is an exact, fully-validated record boundary (all three
	 * auxiliary streams below matched their checksum) or just "right after
	 * the coordinate data, true length of whatever follows uncertain" (the
	 * per-point auxiliary streams didn't validate -- observed on at least
	 * one confirmed-real, odd point-count stroke, cause unconfirmed: maybe
	 * their own length formula isn't `Math.round(n / 2)` in every case, or
	 * they're absent/differently-shaped for some stroke/tool types). See the
	 * main loop in `parseStrokes` for why this distinction matters for where
	 * scanning resumes next. */
	endIsConfirmed: boolean;
}

/** Tries to parse one stroke record starting at `pos`: a point count,
 * followed by that many uint32 (x, y) coordinate pairs, that count repeated
 * once more as a checksum immediately after them. That alone is already
 * strong evidence of a real record (matching an arbitrary position's count
 * against a value exactly `n` uint32 pairs later isn't a coincidence a
 * false match stumbles into), so it's enough on its own to accept the
 * record; three more count-prefixed auxiliary streams normally follow
 * (roughly half-rate pressure/width, a per-point counter, and a per-point
 * flag byte -- see the format investigation linked from `parseStrokes`'s
 * doc comment, none of it interpreted yet), each also reconfirming the
 * count, and validating those too is what pins down an *exact* end for the
 * record when they're present in the expected shape (see `RawRecord.
 * endIsConfirmed`). Returns `null` if the bytes at `pos` don't even clear
 * the count+coordinates+checksum bar.
 *
 * A minority of real strokes store coordinates as float32 instead of
 * uint32 (cause unconfirmed, possibly a different pen/tool type) --
 * recognizable by this same shape but failing the uint32 bounds check.
 * Confirmed float32 decodes correctly, but by a *different*, still-unknown
 * scale than uint32 strokes on the same page (applying this module's
 * uint32 transform to them lands consistently near the page's top-right
 * corner instead of on real ink). Rather than emit confidently-wrong
 * points, this decoder doesn't parse float32 records at all:
 * `tryParseRecord` returns `null` for them, and the landmark search in
 * `parseStrokes`'s main loop skips past their bytes to the next real
 * (uint32) record instead. */
function tryParseRecord(view: DataView, byteLength: number, pos: number, maxCoordinate: number): RawRecord | null {
	if (pos + 8 > byteLength) return null;
	const n = view.getUint32(pos, true);
	if (n <= 0 || n > MAX_PLAUSIBLE_POINT_COUNT) return null;

	const coordsStart = pos + 4;
	const coordsEnd = coordsStart + n * 8;
	if (coordsEnd + 4 > byteLength) return null;
	if (view.getUint32(coordsEnd, true) !== n) return null;

	const points = readCoordinatePairs(view, coordsStart, n, maxCoordinate);
	if (!points) return null; // out of bounds under uint32 -- likely a float32 record; see doc comment above

	const confirmedEnd = tryParseAuxiliaryStreams(view, byteLength, coordsEnd, n);
	if (confirmedEnd !== null) return { points, end: confirmedEnd, endIsConfirmed: true };
	return { points, end: coordsEnd + 4, endIsConfirmed: false };
}

/** Validates and skips the three count-prefixed auxiliary streams that
 * follow a uint32-coordinate record's points (see `parseStrokes`'s doc
 * comment): a pressure/width-shaped stream at half the point rate, a
 * per-point counter, and a per-point flag byte, each reconfirming `n` as a
 * checksum. Returns the byte offset just past all three (padded to 4-byte
 * alignment), or `null` if any checksum doesn't match. */
function tryParseAuxiliaryStreams(view: DataView, byteLength: number, coordsEnd: number, n: number): number | null {
	let p = coordsEnd + 4;
	const halfN = Math.round(n / 2);
	const streamBEnd = p + halfN * 4;
	if (streamBEnd + 4 > byteLength || view.getUint32(streamBEnd, true) !== n) return null;

	p = streamBEnd + 4;
	const streamCEnd = p + n * 4;
	if (streamCEnd + 4 > byteLength || view.getUint32(streamCEnd, true) !== n) return null;

	p = streamCEnd + 4;
	const streamDEnd = p + n;
	if (streamDEnd > byteLength) return null;
	const padding = (4 - (streamDEnd % 4)) % 4;

	return streamDEnd + padding;
}

function readCoordinatePairs(
	view: DataView,
	start: number,
	n: number,
	maxCoordinate: number,
): [number, number][] | null {
	const points: [number, number][] = new Array(n);
	for (let i = 0; i < n; i++) {
		const offset = start + i * 8;
		const x = view.getUint32(offset, true);
		const y = view.getUint32(offset + 4, true);
		if (x > maxCoordinate || y > maxCoordinate) return null;
		points[i] = [x, y];
	}
	return points;
}

/**
 * Decodes a page's `TOTALPATH` buffer into pen strokes in page pixel space.
 *
 * `TOTALPATH` is undocumented (not covered by any known open-source
 * Supernote parser) and this decode was arrived at by reverse-engineering
 * real `.note` files rather than from a spec -- see
 * https://github.com/philips/supernote-typescript/issues/55 for the full
 * investigation, including the pixel-level validation this is based on.
 *
 * Every stroke record is preceded by a ~220-byte preamble (repeated
 * throughout the buffer, not just once per page) containing, among other
 * still-unidentified fields, the digitizer's native coordinate bounds for
 * this page. Those bounds divided by the page's pixel dimensions give the
 * coordinate scale, and turn out to be the *only* per-page variable in the
 * transform -- rotation and translation are fixed, device-independent
 * constants:
 *
 * ```
 * scale = nativeHeightBound / pageHeight
 * pixelX = -rawY / scale + pageWidth
 * pixelY =  rawX / scale
 * ```
 *
 * Confirmed exact (zero measurable error) against rendered ink on two
 * device families (A5X, N5/Manta) including a full dense page of real
 * handwriting, not just isolated strokes -- for uint32-coordinate strokes,
 * which are the large majority. A minority of strokes use a float32
 * coordinate encoding this function doesn't decode yet (see
 * `tryParseRecord`'s doc comment for why); those are silently omitted
 * rather than emitted at a wrong position.
 *
 * Returns `[]` if `totalPathBuffer` is `null`, too short to hold a
 * preamble, or its layout isn't recognized (e.g. a genuinely blank page) --
 * callers that care about the difference should treat an empty result as
 * "nothing decoded", not "confirmed blank", and fall back to the page's
 * rasterized ink rather than assuming there's none.
 */
export function parseStrokes(
	totalPathBuffer: Uint8Array | null,
	pageWidth: number,
	pageHeight: number,
): IStroke[] {
	if (!totalPathBuffer || totalPathBuffer.length < 160 || pageHeight <= 0) return [];

	const view = new DataView(totalPathBuffer.buffer, totalPathBuffer.byteOffset, totalPathBuffer.byteLength);
	const text = new TextDecoder('latin1').decode(totalPathBuffer);

	const firstLandmark = text.indexOf(PREAMBLE_LANDMARK);
	if (firstLandmark < 8) return [];

	const nativeHeightBound = view.getUint32(firstLandmark + NATIVE_HEIGHT_BOUND_OFFSET_FROM_LANDMARK, true);
	const nativeWidthBound = view.getUint32(firstLandmark + NATIVE_WIDTH_BOUND_OFFSET_FROM_LANDMARK, true);
	if (nativeHeightBound === 0) return [];

	const scale = nativeHeightBound / pageHeight;
	// 5% slack above the declared native bounds: a real coordinate should
	// never exceed them, but this only needs to be tight enough to reject
	// obviously-wrong matches (garbage values orders of magnitude too
	// large), not to validate physical accuracy.
	const maxCoordinate = Math.max(nativeWidthBound, nativeHeightBound) * 1.05;

	const strokes: IStroke[] = [];
	let pos = firstLandmark + LANDMARK_TO_RECORD_OFFSET;
	while (pos < totalPathBuffer.length - 16) {
		const record = tryParseRecord(view, totalPathBuffer.length, pos, maxCoordinate);
		if (record) {
			strokes.push({
				points: record.points.map(([rawX, rawY]) => ({
					x: -rawY / scale + pageWidth,
					y: rawX / scale,
				})),
			});
			if (record.endIsConfirmed) {
				// Consecutive records are sometimes packed back-to-back behind
				// a bare LANDMARK_TO_RECORD_OFFSET-byte connector with no
				// intervening landmark/preamble of their own -- try that fast
				// path first; if it doesn't land on a record next time through
				// the loop, the landmark search below recovers (a full
				// preamble really did intervene instead). Only safe when
				// `end` is confirmed exact: guessing forward from an
				// unconfirmed `end` risks landing inside that record's own
				// not-fully-understood trailing bytes and matching noise
				// there instead of a real record.
				pos = record.end + LANDMARK_TO_RECORD_OFFSET;
				continue;
			}
			pos = record.end;
		}
		const nextLandmark = text.indexOf(PREAMBLE_LANDMARK, pos);
		if (nextLandmark === -1) break;
		pos = nextLandmark + LANDMARK_TO_RECORD_OFFSET;
	}
	return strokes;
}

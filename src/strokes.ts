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

/** Marks the start of a fixed-layout preamble, used to find the *first*
 * stroke record and the page's native digitizer coordinate bounds: landmark
 * bytes sit 76 bytes before the first record's point-count field, and 8/4
 * bytes after the two bounds fields -- see `parseStrokes`'s doc comment for
 * how those were found. The same landmark text recurs throughout the rest
 * of the buffer too, but *not* at a fixed offset before every subsequent
 * record (see `parseStrokes`'s main loop), so it's only relied on here for
 * locating the first one. */
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
	/** Byte offset to resume scanning from after this record -- the exact
	 * boundary past all three auxiliary streams below, all of which
	 * `tryParseRecord` requires to validate (see there for why). */
	end: number;
}

/** Tries to parse one stroke record starting at `pos`: a point count,
 * followed by that many uint32 (x, y) coordinate pairs, that count repeated
 * once more as a checksum immediately after them, followed by three more
 * count-prefixed auxiliary streams (roughly half-rate pressure/width, a
 * per-point counter, and a per-point flag byte -- see the format
 * investigation linked from `parseStrokes`'s doc comment, none of it
 * interpreted yet), each also reconfirming the count. Requires *all four*
 * checksums (the coordinates' plus the three auxiliary streams') to match,
 * not just the coordinates' -- `parseStrokes` scans every byte offset
 * looking for a match rather than just known record boundaries (see its
 * main loop), and a single checksum is occasionally satisfied by
 * coincidence inside structured, non-random non-record bytes (an auxiliary
 * stream's own repetitive per-point values, for instance); four
 * independent checksums with two different length formulas lining up at
 * once is a coincidence none of the fixtures this decoder is tested
 * against has produced yet. Returns `null` otherwise.
 *
 * A minority of real strokes store coordinates as float32 instead of
 * uint32 (cause unconfirmed, possibly a different pen/tool type) --
 * recognizable by this same shape but failing the uint32 bounds check.
 * Confirmed float32 decodes correctly, but by a *different*, still-unknown
 * scale than uint32 strokes on the same page (applying this module's
 * uint32 transform to them lands consistently near the page's top-right
 * corner instead of on real ink). Rather than emit confidently-wrong
 * points, this decoder doesn't parse float32 records at all:
 * `tryParseRecord` returns `null` for them, and `parseStrokes`'s byte-by-byte
 * scan just steps past their bytes one at a time until it finds the next
 * real (uint32) record instead. */
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

	const end = tryParseAuxiliaryStreams(view, byteLength, coordsEnd, n);
	if (end === null) return null;
	return { points, end };
}

/** Validates and skips the three count-prefixed auxiliary streams that
 * follow a uint32-coordinate record's points (see `parseStrokes`'s doc
 * comment): a per-point pressure/width stream, a per-point counter, and a
 * per-point flag byte, each reconfirming `n` as a checksum. Returns the
 * byte offset just past all three (padded to 4-byte alignment), or `null`
 * if any checksum doesn't match.
 *
 * The pressure/width stream is `n` uint16 values (2 bytes each), not
 * `Math.round(n / 2)` uint32 values (4 bytes each) as originally guessed --
 * both give the same total byte length (and so the same checksum position)
 * when `n` is even, which is how the wrong guess passed validation on
 * every even-length record it was tried against; only an odd `n` exposes
 * the 2-byte discrepancy. See
 * https://github.com/philips/supernote-typescript/issues/56.
 *
 * (A 0-byte-stream special case for `n === 1` was tried and reverted: the
 * `n === 1` "records" it made `tryParseRecord` accept all turned out to be
 * false positives -- coincidental checksum matches, not real single-point
 * strokes, recognizable because every one of them decoded to the exact
 * same point, `(pageWidth, 0)`, the page's top-right corner, matching the
 * known garbage-decode symptom documented on `tryParseRecord` for
 * misidentified float32 records. No genuine `n === 1` record has been
 * confirmed in any fixture so far.) */
function tryParseAuxiliaryStreams(view: DataView, byteLength: number, coordsEnd: number, n: number): number | null {
	let p = coordsEnd + 4;
	const streamBEnd = p + n * 2;
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
	const scanEnd = totalPathBuffer.length - 16;
	let pos = firstLandmark + LANDMARK_TO_RECORD_OFFSET;
	while (pos < scanEnd) {
		const record = tryParseRecord(view, totalPathBuffer.length, pos, maxCoordinate);
		if (record) {
			strokes.push({
				points: record.points.map(([rawX, rawY]) => ({
					x: -rawY / scale + pageWidth,
					y: rawX / scale,
				})),
			});
			// Jump straight past this record's own bytes (its fully-validated
			// end -- tryParseRecord requires all four checksums to match,
			// see there) rather than re-scanning through them -- that
			// validation is already strong enough that byte-by-byte
			// scanning doesn't need a landmark to resynchronize on.
			pos = record.end;
			continue;
		}
		// No record here -- advance one byte and try again, rather than
		// jumping to the next `PREAMBLE_LANDMARK` occurrence. Landmark text
		// recurs throughout the buffer, but not before every record: some
		// occurrences are followed by a differently-shaped, not yet
		// understood metadata block instead of `LANDMARK_TO_RECORD_OFFSET`
		// bytes of connector before the next stroke, so jumping straight to
		// the next landmark match can overshoot real, checksum-valid
		// records sitting in between (confirmed on real fixtures -- see
		// https://github.com/philips/supernote-typescript/issues/56). A
		// byte-by-byte scan can't overshoot that way: the same
		// count+coordinates+checksum validation that makes any individual
		// match trustworthy also means false positives from scanning
		// through non-record bytes are vanishingly rare in practice.
		pos++;
	}
	return strokes;
}

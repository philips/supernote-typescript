import { IStroke } from './strokes.js';
import { OrderedVectorInkPrimitive, StrokeStyle } from './vector-ink.js';

/** Namespace and profile markers for the experimental Ola Ink SVG scene. */
export const OI_VECTOR_SCENE_NAMESPACE = 'https://olaink.com/ns/vector-scene/1';
export const OI_VECTOR_SCENE_VERSION = 1 as const;
export const OI_VECTOR_SCENE_METADATA_ID = 'oi-scene';
export const OI_VECTOR_SCENE_MIME_TYPE =
	'application/vnd.olaink.vector-scene+json';

/** One animated stroke in the v1 embedded scene profile. Orders are
 * zero-based: `writeOrder` is the raw TOTALPATH record index and `zOrder` is
 * the primitive's final paint position after vector-ink compositing rules. */
export interface OiVectorSceneStrokeV1 {
	id: string;
	writeOrder: number;
	zOrder: number;
	/** Real sampled write geometry. Absent when the source record has final
	 * geometry but no centerline; native renderers fade in `contour` then. */
	centerline?: string;
	contour: string;
	/** Optional real page-relative start time and duration in milliseconds. */
	t0Ms?: number;
	durationMs?: number;
}

/** JSON payload stored in `<metadata id="oi-scene">`. */
export interface OiVectorSceneV1 {
	version: typeof OI_VECTOR_SCENE_VERSION;
	strokes: OiVectorSceneStrokeV1[];
}

/** SVG element IDs and display data associated with one metadata record. */
export interface OiVectorSceneBindingV1 extends OiVectorSceneStrokeV1 {
	strokeIndex: number;
	color: string;
	width: number;
	role: 'final-contour' | 'erase-cover';
}

export interface BuiltOiVectorSceneV1 {
	scene: OiVectorSceneV1;
	bindings: OiVectorSceneBindingV1[];
}

/** Builds scene records for final path geometry. A real centerline reference
 * is included when the source has one; point-less partial-erase fragments
 * omit it so consumers can use the documented fade-in fallback. Rectangles
 * remain ordinary static SVG geometry and never receive a synthetic path. */
export function buildOiVectorSceneV1(
	entries: OrderedVectorInkPrimitive[],
	strokes: IStroke[],
	styles: StrokeStyle[] | undefined,
): BuiltOiVectorSceneV1 | undefined {
	const bindings: OiVectorSceneBindingV1[] = [];
	for (const entry of entries) {
		if (entry.primitive.kind === 'rect') continue;
		const stroke = strokes[entry.strokeIndex];
		const style = styles?.[entry.strokeIndex];
		if (!stroke || !style || style.shape !== 'path') continue;

		const id = `s${entry.writeOrder}`;
		const t0Ms =
			stroke.t0Ms !== undefined && Number.isFinite(stroke.t0Ms) && stroke.t0Ms >= 0
				? stroke.t0Ms
				: undefined;
		const durationMs =
			stroke.durationMs !== undefined && Number.isFinite(stroke.durationMs) && stroke.durationMs >= 0
				? stroke.durationMs
				: undefined;
		bindings.push({
			id,
			writeOrder: entry.writeOrder,
			zOrder: entry.zOrder,
			...(stroke.points.length > 0 ? { centerline: `${id}-line` } : {}),
			contour: `${id}-fill`,
			...(t0Ms !== undefined ? { t0Ms } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			strokeIndex: entry.strokeIndex,
			color: style.color,
			width: style.width,
			role: stroke.isEraser ? 'erase-cover' : 'final-contour',
		});
	}
	if (bindings.length === 0) return undefined;

	return {
		scene: {
			version: OI_VECTOR_SCENE_VERSION,
			strokes: bindings.map(
				({ id, writeOrder, zOrder, centerline, contour, t0Ms, durationMs }) => ({
					id,
					writeOrder,
					zOrder,
					...(centerline ? { centerline } : {}),
					contour,
					...(t0Ms !== undefined ? { t0Ms } : {}),
					...(durationMs !== undefined ? { durationMs } : {}),
				}),
			),
		},
		bindings,
	};
}

/** XML-escapes a JSON metadata payload. XML parsers restore these entities
 * before exposing the metadata text, yielding the original JSON string. */
export function serializeOiVectorSceneMetadata(scene: OiVectorSceneV1): string {
	return JSON.stringify(scene).replace(/[&<>]/g, (char) => {
		switch (char) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			default:
				return '&gt;';
		}
	});
}

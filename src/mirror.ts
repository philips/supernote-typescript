import { Image, decode } from 'image-js';

export async function fetchMirrorFrame(ipAddress: string): Promise<Image> {
	const url = `http://${ipAddress}/screencast.mjpeg`;

	const controller = new AbortController();

	const response = await fetch(url, {
		method: 'GET',
		signal: controller.signal,
	});

	if (!response.ok) {
		throw new Error('Failed to fetch the resource.');
	}

	const boundary = boundaryFromContentType(response.headers.get('content-type'));

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Failed to get reader for response body.');
	}

	let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	return new Promise((resolve, reject) => {
		let found = false;

		const read = async () => {
			const { done, value } = await reader.read();
			if (done) {
				if (!found) {
					reject(new Error('No JPEG image found in multipart stream.'));
				}
				return;
			}
			buffer = concatUint8Arrays(buffer, value);
			const image = extractJpegFrame(buffer, boundary);
			if (image) {
				found = true;
				resolve(image);
				controller.abort();
				return;
			}
			await read();
		};

		read().catch((error) => reject(error));
	});
}

// Parses a `Content-Type: multipart/x-mixed-replace; boundary=...` header
// into its boundary token. Shared by `extractMjpegFrame` below, which
// callers use when they can't stream the response body incrementally (e.g.
// Obsidian mobile's `requestUrl`, which only hands back a complete,
// already-buffered response) and instead fetch a bounded slice of the
// stream up front via a `Range` header.
export function boundaryFromContentType(contentType: string | null): string {
	if (!contentType || !contentType.includes('multipart')) {
		throw new Error('Invalid response. Expected multipart content type.');
	}
	const boundary = contentType.split('boundary=')[1];
	if (!boundary) {
		throw new Error('Boundary not found in response headers.');
	}
	return boundary;
}

// Looks for one complete `image/jpeg` multipart part in `buffer` and decodes
// it. Returns `null` if the buffer doesn't (yet, or ever) contain a full
// frame - e.g. it was truncated by a `Range` request before the frame's
// bytes finished arriving.
export function extractJpegFrame(
	buffer: Uint8Array<ArrayBufferLike>,
	boundary: string,
): Image | null {
	const headerEnd = '\r\n\r\n';

	const start = new TextDecoder().decode(buffer).indexOf('Content-Type:', 0);
	if (start === -1) {
		return null;
	}
	const end = findBoundary(buffer, boundary, start + 2);

	const part = buffer.slice(start, end);
	const headerEndIndex = new TextDecoder().decode(part).indexOf(headerEnd);
	if (headerEndIndex === -1) {
		return null;
	}

	const headerStr = new TextDecoder().decode(part.slice(0, headerEndIndex));
	const partHeaders = headerStr.split('\r\n');

	const contentTypeHeader = partHeaders.find((header) =>
		header.toLowerCase().startsWith('content-type:'),
	);
	const contentLengthHeader = partHeaders.find((header) =>
		header.toLowerCase().startsWith('content-length:'),
	);

	if (!contentTypeHeader || !contentTypeHeader.includes('image/jpeg') || !contentLengthHeader) {
		return null;
	}

	const contentLength = parseInt(contentLengthHeader.split(':')[1].trim());
	if (buffer.length < headerEndIndex + contentLength + 1) {
		return null;
	}
	const imageData = buffer.slice(
		headerEndIndex + headerEnd.length,
		headerEndIndex + contentLength + 1,
	);
	return decode(imageData);
}

// Entry point for callers that fetched a single, already-complete buffer
// (rather than streaming one) - see `extractJpegFrame` above.
export function extractMjpegFrame(
	buffer: Uint8Array<ArrayBufferLike>,
	contentType: string | null,
): Image | null {
	const boundary = boundaryFromContentType(contentType);
	return extractJpegFrame(buffer, boundary);
}

function findBoundary(
	data: Uint8Array<ArrayBufferLike>,
	boundary: string,
	startIndex: number = 0,
): number {
	const boundaryStr = `${boundary}`;
	return new TextDecoder().decode(data).indexOf(boundaryStr, startIndex);
}

function concatUint8Arrays(
	a: Uint8Array<ArrayBufferLike>,
	b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
	const result = new Uint8Array(a.length + b.length);
	result.set(a, 0);
	result.set(b, a.length);
	return result;
}

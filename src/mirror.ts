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

	const contentType = response.headers.get('content-type');
	if (!contentType || !contentType.includes('multipart')) {
		throw new Error('Invalid response. Expected multipart content type.');
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Failed to get reader for response body.');
	}

	const boundary = contentType.split('boundary=')[1];
	if (!boundary) {
		throw new Error('Boundary not found in response headers.');
	}

	let currentPartHeaders: string[] = [];
	let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	return new Promise((resolve, reject) => {
		let found = false;
		const headerEnd = '\r\n\r\n';

		const processChunk = async (chunk: Uint8Array<ArrayBufferLike>) => {
			buffer = concatUint8Arrays(buffer, chunk);

			const start = new TextDecoder().decode(buffer).indexOf('Content-Type:', 0);
			const end = findBoundary(buffer, boundary, start + 2);

			const part = buffer.slice(start, end);
			const headerEndIndex = new TextDecoder().decode(part).indexOf(headerEnd);

			if (currentPartHeaders.length === 0) {
				if (headerEndIndex !== -1) {
					const headerStr = new TextDecoder().decode(
						part.slice(0, headerEndIndex),
					);
					currentPartHeaders = headerStr.split('\r\n');
				}
			}

			const contentTypeHeader = currentPartHeaders.find((header) =>
				header.toLowerCase().startsWith('content-type:'),
			);
			const contentLengthHeader = currentPartHeaders.find((header) =>
				header.toLowerCase().startsWith('content-length:'),
			);

			if (contentTypeHeader && contentTypeHeader.includes('image/jpeg')) {
				if (contentLengthHeader) {
					found = true;
					const contentLength = parseInt(
						contentLengthHeader.split(':')[1].trim(),
					);
					if (buffer.length < headerEndIndex + contentLength + 1) {
						return;
					}
					const imageData = buffer.slice(
						headerEndIndex + headerEnd.length,
						headerEndIndex + contentLength + 1,
					);
					const image = decode(imageData);
					resolve(image);
					controller.abort();
				}
			}
		};

		const read = async () => {
			const { done, value } = await reader.read();
			if (done) {
				if (!found) {
					reject(new Error('No JPEG image found in multipart stream.'));
				}
				return;
			}
			await processChunk(value);
			await read();
		};

		read().catch((error) => reject(error));
	});
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

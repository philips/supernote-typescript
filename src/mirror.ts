import { Image } from 'image-js';

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

	let boundary = contentType.split('boundary=')[1];
	if (!boundary) {
		throw new Error('Boundary not found in response headers.');
	}

	let currentPartHeaders: string[] = [];
	let buffer = new Uint8Array();

	return new Promise((resolve, reject) => {
		let found = false;
		const headerEnd = '\r\n\r\n';

		const processChunk = async (chunk: Uint8Array) => {
			buffer = concatUint8Arrays(buffer, chunk);

			let start = new TextDecoder().decode(buffer).indexOf('Content-Type:', 0);
			let end = findBoundary(buffer, boundary, start + 2);

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
					const image = Image.load(imageData);
					resolve(image);
					controller.abort();
				}
			}
		};

		const read = async () => {
			const { done, value } = await reader.read();
			const txt = new TextDecoder().decode(value);
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
	data: Uint8Array,
	boundary: string,
	startIndex: number = 0,
): number {
	const boundaryStr = `${boundary}`;
	return new TextDecoder().decode(data).indexOf(boundaryStr);
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
	const result = new Uint8Array(a.length + b.length);
	result.set(a, 0);
	result.set(b, a.length);
	return result;
}

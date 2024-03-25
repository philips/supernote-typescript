import axios, { AxiosResponse } from 'axios';
import { Image } from 'image-js';

export async function fetchMirrorFrame(ipAddress: string): Promise<Image> {
const url = `http://${ipAddress}/screencast.mjpeg`;

    const response: AxiosResponse<any> = await axios.get(url, {
        responseType: 'stream',
    });

    let boundary = response.headers['content-type'];
    if (boundary) {
        boundary = boundary.split('boundary=')[1];
    } else {
        throw new Error('Boundary not found in response headers.');
    }

    let currentPartHeaders: string[] = [];
    let buffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
        let found = false;
        const headerEnd = '\r\n\r\n'

        response.data.on('data', async (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            let start = 0;
            while ((start = findBoundary(buffer, boundary, start)) !== -1) {
                const end = findBoundary(buffer, boundary, start + 2);

                if (end === -1) break;

                console.log(`start: ${start} end: ${end} currentPartHeaders: ${currentPartHeaders}`);

                const part = buffer.slice(start, end);
                start = end;
                const headerEndIndex = part.indexOf(headerEnd);

                if (currentPartHeaders.length === 0) {
                    if (headerEndIndex !== -1) {
                        const headerStr = part.slice(0, headerEndIndex).toString();
                        currentPartHeaders = headerStr.split('\r\n');
                    }
                    break;
                }

                const contentTypeHeader = currentPartHeaders.find(header =>
                    header.toLowerCase().startsWith('content-type:')
                );
                const contentLengthHeader = currentPartHeaders.find(header =>
                    header.toLowerCase().startsWith('content-length:')
                );

                if (contentTypeHeader && contentTypeHeader.includes('image/jpeg')) {
                    if (contentLengthHeader) {
                        found = true;
                        const contentLength = parseInt(contentLengthHeader.split(':')[1].trim());
                        const imageData = buffer.slice(headerEndIndex + headerEnd.length, headerEndIndex+contentLength+1);
                        const image = Image.load(imageData as Buffer);
                        resolve(image);
                    }
                }

            }
        });

        response.data.on('end', () => {
            if (!found) {
                reject(new Error('No PNG image found in multipart stream.'));
            }
        });

        response.data.on('error', (error: any) => {
            reject(error);
        });
    });
}

function findBoundary(data: Buffer, boundary: string, startIndex: number = 0): number {
    const boundaryStr = `${boundary}`;
    return data.indexOf(boundaryStr, startIndex);
}

import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { extractIinkText, SupernoteX } from '../src/index.js';

async function readFixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(`tests/input/${name}`));
}

describe('MyScript iink BDOM text', () => {
	test('extracts textField candidates from RECOGNFILE packages', async () => {
		const note = new SupernoteX(
			await readFixture('textbox-n5-20260016-digest.note'),
		);

		await expect(extractIinkText(note.pages[1])).resolves.toMatchObject([
			{ text: 'a.' },
			{ text: '=' },
			{ text: 'M' },
			{ text: 'aids' },
			{
				text:
					'smishing → Sms-Phishing\nWuling (Whale-Phishing) → c- Level Phishing\nWishing → Phone-Phishing\nCEO-Fraud',
			},
		]);
		await expect(extractIinkText(note.pages[3])).resolves.toMatchObject([
			{ text: "'odcast\nScale-Up 360°" },
		]);
		await expect(extractIinkText(note.pages[4])).resolves.toMatchObject([
			{ text: 'Test. [n P von Digest' },
			{ text: 'Digest mit Link zum Buch' },
		]);
	});

	test('returns no fields for a page without an iink package', async () => {
		const note = new SupernoteX(
			await readFixture('blank-a6x-3.15.27-two-pages.note'),
		);
		await expect(extractIinkText(note.pages[0])).resolves.toEqual([]);
	});
});

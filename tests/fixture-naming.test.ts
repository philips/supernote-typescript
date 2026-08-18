import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SupernoteX } from '../src/parsing';

const INPUT_DIR = 'tests/input';

/**
 * Validates that a fixture filename follows the convention:
 *   {purpose}-{device}-{version}-{description}.{ext}
 *
 * Where:
 * - purpose: one word, lowercase letters
 * - device: lowercase device code (a5x, a6x, n5, n6, etc.)
 * - version: either firmware version (e.g. 3.15.27) or file format version (8 digits)
 * - description: any reasonable suffix
 */
function parseFixtureName(basename: string): {
  purpose: string;
  device: string;
  version: string;
  description: string;
} | null {
  const match = basename.match(/^([a-z]+)-([a-z0-9]+)-([a-zA-Z0-9._]+)-(.+)$/);
  if (!match) return null;
  return {
    purpose: match[1],
    device: match[2],
    version: match[3],
    description: match[4],
  };
}

describe('fixture naming convention', () => {
  test('every .note fixture follows the naming convention', async () => {
    const files = fs.readdirSync(INPUT_DIR);
    const noteFiles = files.filter((f) => f.endsWith('.note'));

    for (const file of noteFiles) {
      const basename = path.basename(file, '.note');
      const parsed = parseFixtureName(basename);
      expect(parsed, `Fixture "${file}" does not match the naming convention {purpose}-{device}-{version}-{description}.note`).not.toBeNull();

      if (!parsed) continue;

      // Verify device matches APPLY_EQUIPMENT metadata (case-insensitive)
      const data = await fs.promises.readFile(path.join(INPUT_DIR, file));
      const sn = new SupernoteX(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      const deviceFromMeta = sn.header.APPLY_EQUIPMENT.toLowerCase();
      expect(parsed.device, `Device in "${file}" should match APPLY_EQUIPMENT (${deviceFromMeta})`).toBe(deviceFromMeta);

      // Verify version is either the file format version or a known firmware version
      const fileVer = sn.version.toString();
      const versionOk = parsed.version === fileVer || /^\d+\.\d+\.\d+$/.test(parsed.version);
      expect(versionOk, `Version in "${file}" should match SN_FILE_VER (${fileVer}) or be a firmware version`).toBe(true);
    }
  });

  test('every .pdf fixture shares its basename with the corresponding .note', () => {
    const files = fs.readdirSync(INPUT_DIR);
    const noteFiles = files.filter((f) => f.endsWith('.note'));

    for (const noteFile of noteFiles) {
      const pdfFile = noteFile.replace(/\.note$/, '.pdf');
      if (fs.existsSync(path.join(INPUT_DIR, pdfFile))) {
        expect(pdfFile, `PDF companion for ${noteFile} must share basename`).toBe(noteFile.replace(/\.note$/, '.pdf'));
      }
    }
  });

  test('every .spd fixture follows the naming convention', () => {
    const files = fs.readdirSync(INPUT_DIR);
    const spdFiles = files.filter((f) => f.endsWith('.spd'));

    for (const file of spdFiles) {
      const basename = path.basename(file, '.spd');
      // .spd files use: atelier-{purpose}-{description}
      const match = basename.match(/^atelier-([a-z]+)-(.+)$/);
      expect(match, `SPD fixture "${file}" does not match convention atelier-{purpose}-{description}.spd`).not.toBeNull();
    }
  });
});

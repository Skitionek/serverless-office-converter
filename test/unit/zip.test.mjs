import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildZip, crc32, readZip } from '../../web/office-converter/zip.js';
import { deflatedZip, utf8 } from './helpers.mjs';

describe('crc32', () => {
    it('matches the standard check value for "123456789"', () => {
        // Given the ASCII digits 1 to 9
        const bytes = utf8('123456789');

        // When the checksum is computed
        const checksum = crc32(bytes);

        // Then it is the published CRC-32 check value
        assert.equal(checksum, 0xcbf43926);
    });
});

describe('readZip', () => {
    it('lists and inflates the entries of a deflate-compressed zip', async () => {
        // Given a zip written the way Word writes one (deflate)
        const bytes = deflatedZip([
            { name: 'word/document.xml', text: '<w:t>Hello</w:t>'.repeat(50) },
            { name: 'docProps/app.xml', text: '<Application>Test</Application>' },
        ]);

        // When it is read
        const entries = await readZip(bytes);

        // Then every entry is listed and its content comes back unchanged
        assert.deepEqual(entries.map((entry) => entry.name),
            ['word/document.xml', 'docProps/app.xml']);
        const document = await entries[0].data();
        assert.equal(new TextDecoder().decode(document), '<w:t>Hello</w:t>'.repeat(50));
    });

    it('returns null for bytes that are not a zip', async () => {
        // Given plain text
        const bytes = utf8('just some text, no zip here');

        // When it is read as a zip
        const entries = await readZip(bytes);

        // Then there is no entry list
        assert.equal(entries, null);
    });
});

describe('buildZip', () => {
    it('stores entries uncompressed, in the given order, and reads back unchanged', async () => {
        // Given two entries, one of them binary
        const binary = Uint8Array.from([0, 1, 2, 255, 254, 253]);
        const entries = [
            { name: 'mimetype', data: utf8('application/vnd.oasis.opendocument.text') },
            { name: 'Fonts/font.ttf', data: binary },
        ];

        // When a zip is built and read back
        const zip = buildZip(entries);
        const readBack = await readZip(zip);

        // Then the names keep their order and the bytes are identical
        assert.deepEqual(readBack.map((entry) => entry.name), ['mimetype', 'Fonts/font.ttf']);
        assert.deepEqual(await readBack[1].data(), binary);
        assert.equal(readBack[0].method, 0, 'stored, so the mimetype can be sniffed');
    });

    it('puts the first entry right at the start of the file, as ODF requires for "mimetype"', () => {
        // Given an ODF-style package
        const zip = buildZip([{ name: 'mimetype', data: utf8('application/x-test') }]);

        // When the start of the file is looked at
        const header = new TextDecoder().decode(zip.subarray(30, 38));

        // Then the entry name follows directly after the 30-byte local header
        assert.equal(header, 'mimetype');
    });
});

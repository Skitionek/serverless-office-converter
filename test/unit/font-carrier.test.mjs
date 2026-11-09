import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFontCarrier } from '../../web/office-converter/font-carrier.js';
import { readZip } from '../../web/office-converter/zip.js';

async function entriesByName(carrier) {
    const entries = await readZip(carrier);
    return new Map(entries.map((entry) => [entry.name, entry]));
}

async function textOf(entry) {
    return new TextDecoder().decode(await entry.data());
}

describe('buildFontCarrier', () => {
    it('is an ODF text document whose first entry is the uncompressed mimetype', async () => {
        // Given the bytes of two font files
        const regular = Uint8Array.from([0, 1, 0, 0, 1, 2, 3]);
        const italic = Uint8Array.from([0, 1, 0, 0, 4, 5, 6]);

        // When they are wrapped for the family "Open Sans"
        const carrier = await buildFontCarrier('Open Sans', [regular, italic]);

        // Then LibreOffice can recognise it: mimetype first, stored, with the ODT type
        const entries = await readZip(carrier);
        assert.equal(entries[0].name, 'mimetype');
        assert.equal(entries[0].method, 0);
        assert.equal(await textOf(entries[0]), 'application/vnd.oasis.opendocument.text');
    });

    it('embeds every font file unchanged and declares them under the family name', async () => {
        // Given two font files
        const regular = Uint8Array.from([0, 1, 0, 0, 1, 2, 3]);
        const italic = Uint8Array.from([0, 1, 0, 0, 4, 5, 6]);

        // When they are wrapped for "Open Sans"
        const entries = await entriesByName(await buildFontCarrier('Open Sans', [regular, italic]));

        // Then the fonts are in the package byte for byte
        assert.deepEqual(await entries.get('Fonts/font1.ttf').data(), regular);
        assert.deepEqual(await entries.get('Fonts/font2.ttf').data(), italic);

        // And the content declares one font face, named as asked, with both files as sources
        const content = await textOf(entries.get('content.xml'));
        assert.equal(content.match(/<style:font-face /g).length, 1);
        assert.match(content, /style:name="Open Sans"/);
        assert.match(content, /svg:font-family="Open Sans"/);
        assert.match(content, /xlink:href="Fonts\/font1\.ttf"/);
        assert.match(content, /xlink:href="Fonts\/font2\.ttf"/);

        // And the manifest lists them, which ODF requires
        const manifest = await textOf(entries.get('META-INF/manifest.xml'));
        assert.match(manifest, /manifest:full-path="Fonts\/font1\.ttf"/);
        assert.match(manifest, /manifest:full-path="Fonts\/font2\.ttf"/);
    });

    it('escapes a family name that contains XML special characters', async () => {
        // Given a family name that would break the XML if pasted in as is
        const name = 'Tom & "Jerry" <Sans>';

        // When a carrier is built for it
        const entries = await entriesByName(await buildFontCarrier(name, [Uint8Array.from([0, 1, 0, 0])]));

        // Then the content is still well formed, with the name escaped
        const content = await textOf(entries.get('content.xml'));
        assert.match(content, /style:name="Tom &amp; &quot;Jerry&quot; &lt;Sans&gt;"/);
    });
});

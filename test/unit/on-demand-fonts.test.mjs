import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OnDemandFonts } from '../../web/office-converter/on-demand-fonts.js';
import { readZip } from '../../web/office-converter/zip.js';
import { deflatedZip, utf8 } from './helpers.mjs';

const CATALOG_URL = 'https://site.test/office-converter/font-catalog.json';

function catalogJson() {
    const file = (path) => ({ path, size: 10, sha256: 'a'.repeat(64) });
    return {
        format: 1,
        sources: { gf: 'https://cdn.test/gf/' },
        families: {
            'Open Sans': { source: 'gf', files: [file('opensans/Regular.ttf'), file('opensans/Italic.ttf')] },
            Lora: { source: 'gf', files: [file('lora/Lora.ttf')] },
            'Noto Sans Thai': { source: 'gf', files: [file('thai/Thai.ttf')] },
        },
        aliases: {},
        scripts: { Thai: 'Noto Sans Thai' },
    };
}

// Serves the catalog and records how often it was asked for.
function fakeCatalogServer(json) {
    const calls = { count: 0 };
    const fetchCatalog = async () => {
        calls.count++;
        if (!json) throw new Error('offline');
        return new Response(JSON.stringify(json));
    };
    return { fetchCatalog, calls };
}

// Returns the URL's last segment as the font's bytes, unless it is told to fail.
function fakeDownloader({ failFor = [] } = {}) {
    const loaded = [];
    return {
        loaded,
        async load({ url }) {
            loaded.push(url);
            if (failFor.some((part) => url.includes(part))) throw new Error('HTTP 404');
            return utf8('font:' + url.split('/').pop());
        },
    };
}

function docxUsing(...families) {
    const runs = families.map((family) => '<w:rFonts w:ascii="' + family + '"/>').join('');
    return deflatedZip([{ name: 'word/document.xml', text: '<w:p>' + runs + '<w:t>Hi</w:t></w:p>' }]);
}

function newFonts({ json = catalogJson(), downloader = fakeDownloader(), warnings = [] } = {}) {
    const server = fakeCatalogServer(json);
    const fonts = new OnDemandFonts({
        catalogUrl: CATALOG_URL,
        fetchCatalog: server.fetchCatalog,
        downloader,
        warn: (...message) => warnings.push(message.join(' ')),
    });
    return { fonts, server, downloader, warnings };
}

describe('OnDemandFonts.prepare', () => {
    it('downloads the fonts a document needs and wraps each family in a carrier', async () => {
        // Given a catalog with Open Sans and a document that uses it
        const { fonts, downloader } = newFonts();

        // When the fonts are prepared
        const prepared = await fonts.prepare(docxUsing('Open Sans'), new Set());

        // Then one carrier is ready, for Open Sans, holding the downloaded files
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].family, 'Open Sans');
        assert.equal(prepared[0].id, 'opensans');
        const entries = await readZip(prepared[0].carrier);
        const fontEntries = entries.filter((entry) => entry.name.startsWith('Fonts/'));
        assert.equal(fontEntries.length, 2);
        assert.equal(new TextDecoder().decode(await fontEntries[0].data()), 'font:Regular.ttf');
        assert.equal(downloader.loaded.length, 2);
    });

    it('downloads a font for a script the document uses even when it names no family', async () => {
        // Given a plain text file with Thai text
        const { fonts } = newFonts();

        // When the fonts are prepared
        const prepared = await fonts.prepare(utf8('สวัสดีครับ'), new Set());

        // Then the Thai font is prepared
        assert.deepEqual(prepared.map((font) => font.family), ['Noto Sans Thai']);
    });

    it('downloads nothing for a document that needs no font from the catalog', async () => {
        // Given a document that uses Arial and Latin text only
        const { fonts, downloader } = newFonts();

        // When the fonts are prepared
        const prepared = await fonts.prepare(docxUsing('Arial'), new Set());

        // Then nothing is prepared and the network is not used for fonts
        assert.deepEqual(prepared, []);
        assert.deepEqual(downloader.loaded, []);
    });

    it('skips fonts the engine already has', async () => {
        // Given a document that needs Open Sans and Lora, with Open Sans already registered
        const { fonts, downloader } = newFonts();

        // When the fonts are prepared
        const prepared = await fonts.prepare(docxUsing('Open Sans', 'Lora'), new Set(['opensans']));

        // Then only Lora is downloaded
        assert.deepEqual(prepared.map((font) => font.family), ['Lora']);
        assert.equal(downloader.loaded.length, 1);
    });

    it('leaves out a font that fails to download and still prepares the others', async () => {
        // Given a CDN that is missing Lora's file
        const downloader = fakeDownloader({ failFor: ['lora/'] });
        const { fonts, warnings } = newFonts({ downloader });

        // When a document needing Open Sans and Lora is prepared
        const prepared = await fonts.prepare(docxUsing('Open Sans', 'Lora'), new Set());

        // Then Open Sans is prepared, Lora is skipped, and the problem is logged, not thrown
        assert.deepEqual(prepared.map((font) => font.family), ['Open Sans']);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Lora/);
    });

    it('prepares nothing, and does not fail, when the catalog cannot be loaded', async () => {
        // Given a site whose catalog is unreachable
        const { fonts, warnings } = newFonts({ json: null });

        // When fonts are prepared for two documents
        const first = await fonts.prepare(docxUsing('Open Sans'), new Set());
        const second = await fonts.prepare(docxUsing('Open Sans'), new Set());

        // Then there are no fonts, and the problem is logged once
        assert.deepEqual(first, []);
        assert.deepEqual(second, []);
        assert.equal(warnings.length, 1);
    });

    it('loads the catalog once, however many documents follow', async () => {
        // Given a working catalog
        const { fonts, server } = newFonts();

        // When several documents are prepared
        await fonts.prepare(docxUsing('Open Sans'), new Set());
        await fonts.prepare(docxUsing('Lora'), new Set());
        await fonts.prepare(utf8('plain'), new Set());

        // Then the catalog was fetched a single time
        assert.equal(server.calls.count, 1);
    });
});

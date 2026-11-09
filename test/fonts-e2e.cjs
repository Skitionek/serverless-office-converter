#!/usr/bin/env node
/* End-to-end test of on-demand fonts: the real engine in headless Chromium, with the
 * font CDN replaced by a fake (Playwright routes), so it runs offline and is exact about
 * what is requested.
 *
 *   node test/fonts-e2e.cjs
 *
 * The fonts are the synthetic ones from test/make-font-fixtures.py, whose glyphs are
 * solid blocks: if a PDF names the font, LibreOffice really used it.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { after, before, describe, it } = require('node:test');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', 'web');
const FONT_DIR = path.resolve(__dirname, 'fixtures', 'fonts');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const PREFIX = '/serverless-office-converter/';
const CDN = 'https://fonts.test/';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fontBytes(file) {
    return fs.readFileSync(path.join(FONT_DIR, file));
}

// What the page's catalog says, and what the fake CDN serves for each file.
const DEMO_SANS = fontBytes('DemoOnDemandSans.ttf');
const DEMO_THAI = fontBytes('DemoThaiScript.ttf');
const CATALOG = {
    format: 1,
    sources: { test: CDN },
    families: {
        'Demo On Demand Sans': { source: 'test', files: [{ path: 'DemoOnDemandSans.ttf', size: DEMO_SANS.length, sha256: sha256(DEMO_SANS) }] },
        'Demo Thai Script': { source: 'test', files: [{ path: 'DemoThaiScript.ttf', size: DEMO_THAI.length, sha256: sha256(DEMO_THAI) }] },
        // Listed in the catalog, but the CDN does not have it.
        'Demo Missing Sans': { source: 'test', files: [{ path: 'DemoMissingSans.ttf', size: 1, sha256: 'a'.repeat(64) }] },
        // The CDN serves other bytes than the catalog promises.
        'Demo Tampered Sans': { source: 'test', files: [{ path: 'DemoTamperedSans.ttf', size: 1, sha256: 'b'.repeat(64) }] },
    },
    aliases: {},
    scripts: { Thai: 'Demo Thai Script' },
};
const CDN_FILES = {
    'DemoOnDemandSans.ttf': DEMO_SANS,
    'DemoThaiScript.ttf': DEMO_THAI,
    'DemoTamperedSans.ttf': DEMO_SANS, // not what its catalog hash says
};

function flatOdt(family, text) {
    return '<?xml version="1.0" encoding="UTF-8"?>'
        + '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        + 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
        + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        + 'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
        + 'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
        + 'office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">'
        + '<office:font-face-decls><style:font-face style:name="' + family + '" svg:font-family="' + family + '"/></office:font-face-decls>'
        + '<office:automatic-styles><style:style style:name="T1" style:family="text">'
        + '<style:text-properties style:font-name="' + family + '" fo:font-size="24pt"/></style:style></office:automatic-styles>'
        + '<office:body><office:text><text:p><text:span text:style-name="T1">' + text + '</text:span></text:p></office:text></office:body>'
        + '</office:document>';
}

function startStaticServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith(PREFIX)) return res.writeHead(404).end();
        let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return res.writeHead(404).end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The text of a PDF with its compressed streams inflated, so that the names of the fonts it
// embeds (which LibreOffice may keep inside object streams) can be searched.
function searchablePdfText(pdfLatin1) {
    const parts = [pdfLatin1];
    for (const match of pdfLatin1.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
        try {
            parts.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
        } catch (notFlate) {
            // Not every stream is compressed (or compressed with Flate).
        }
    }
    return parts.join('\n');
}

describe('on-demand fonts', () => {
    let server;
    let browser;
    let page;
    let cdnRequests; // file names requested from the fake CDN, in order
    let catalogRequests;

    // Converts a document to PDF in the page; resolves to the PDF as a latin1 string.
    async function convertToPdf(name, content) {
        const base64 = Buffer.from(content).toString('base64');
        const result = await page.evaluate(async ({ base64, name }) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const { blob } = await window.officeConverter.engine.convertFile(new File([bytes], name), 'pdf');
            const buffer = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000));
            return btoa(binary);
        }, { base64, name });
        const raw = Buffer.from(result, 'base64').toString('latin1');
        return { isPdf: raw.startsWith('%PDF-'), text: searchablePdfText(raw), raw };
    }

    // Converts documents to PDF with a brand-new OfficeEngine made with `options`; the page's own
    // engine is stopped first to make room (each engine reserves a gigabyte).  Resolves to the
    // searchable PDF texts.
    async function convertWithNewEngine(options, documents) {
        await page.evaluate(() => window.officeConverter.engine.stop('make room for a second engine'));
        const pdfs = await page.evaluate(async ({ options, documents }) => {
            const { OfficeEngine } = await import(new URL('office-converter/index.js', location.href));
            const engine = new OfficeEngine(options);
            const out = [];
            for (const { name, base64 } of documents) {
                const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
                const { blob } = await engine.convertFile(new File([bytes], name), 'pdf');
                const buffer = new Uint8Array(await blob.arrayBuffer());
                let binary = '';
                for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000));
                out.push(btoa(binary));
            }
            engine.stop('done');
            return out;
        }, { options, documents: documents.map(({ name, content }) => ({ name, base64: Buffer.from(content).toString('base64') })) });
        return pdfs.map((base64) => {
            const raw = Buffer.from(base64, 'base64').toString('latin1');
            return { isPdf: raw.startsWith('%PDF-'), text: searchablePdfText(raw) };
        });
    }

    before(async () => {
        server = await startStaticServer();
        browser = await chromium.launch();
        page = await browser.newPage();
        page.on('pageerror', (error) => console.log('[pageerror]', error.message));

        // The catalog is served from the fake CDN's origin too: requests to the page's own origin
        // go through its service worker, whose requests Playwright cannot intercept.
        await page.route(CDN + '**', (route) => {
            const file = new URL(route.request().url()).pathname.slice(1);
            if (file === 'catalog.json') {
                catalogRequests++;
                return route.fulfill({
                    status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG),
                    headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
                });
            }
            cdnRequests.push(file);
            const body = CDN_FILES[file];
            if (!body) return route.fulfill({ status: 404, body: 'not found' });
            // What a real CDN sends: CORS for the page, and CORP because the page is cross-origin isolated.
            return route.fulfill({
                status: 200, body, contentType: 'font/ttf',
                headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
            });
        });

        cdnRequests = [];
        catalogRequests = 0;
        await page.goto(`http://127.0.0.1:${server.address().port}${PREFIX}`);
        await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
        await page.evaluate((catalogUrl) => {
            window.officeConverter.engine.fonts.catalogUrl = catalogUrl;
            return window.officeConverter.engine.start();
        }, CDN + 'catalog.json');
    });

    after(async () => {
        await browser.close();
        server.close();
    });

    it('downloads a font the document needs, once, and LibreOffice uses it', async () => {
        // Given a document in a font that is not bundled with the engine
        cdnRequests.length = 0;
        const document = flatOdt('Demo On Demand Sans', 'Hello World 123');

        // When it is converted to PDF
        const pdf = await convertToPdf('demo.fodt', document);

        // Then the font was fetched from the CDN, once, and the PDF is set in it
        // (the PDF is kept in test/out/ for a look at the blocks)
        fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'out', 'on-demand-font.pdf'), Buffer.from(pdf.raw, 'latin1'));
        assert.deepEqual(cdnRequests, ['DemoOnDemandSans.ttf']);
        assert.match(pdf.text, /DemoOnDemandSans/);
    });

    it('does not download it again for the next document that uses it', async () => {
        // Given the font is registered with the engine
        cdnRequests.length = 0;

        // When another document in the same font is converted
        const pdf = await convertToPdf('again.fodt', flatOdt('Demo On Demand Sans', 'Second document'));

        // Then nothing is requested and the font is still used
        assert.deepEqual(cdnRequests, []);
        assert.match(pdf.text, /DemoOnDemandSans/);
    });

    it('registers it again after the engine restarts, from the browser cache, not the CDN', async () => {
        // Given the engine crashes and a new worker takes over (the fonts it had are gone)
        cdnRequests.length = 0;
        await page.evaluate(() => window.officeConverter.engine.stop('simulated crash'));

        // When the font is needed again
        const pdf = await convertToPdf('after-restart.fodt', flatOdt('Demo On Demand Sans', 'After restart'));

        // Then it is used again, without another download
        assert.match(pdf.text, /DemoOnDemandSans/);
        assert.deepEqual(cdnRequests, []);
    });

    it('fetches a script font when the text needs it, though no font is named', async () => {
        // Given a plain text file in Thai, which no bundled font can draw
        cdnRequests.length = 0;

        // When it is converted to PDF
        const pdf = await convertToPdf('thai.txt', 'สวัสดี');

        // Then the Thai font is fetched and used
        assert.deepEqual(cdnRequests, ['DemoThaiScript.ttf']);
        assert.match(pdf.text, /DemoThaiScript/);
    });

    it('fetches nothing for a document that only uses bundled fonts', async () => {
        // Given a document made with Arial, Times New Roman and Latin text
        cdnRequests.length = 0;
        const docx = fs.readFileSync(path.join(FIXTURES, 'sample.docx'));

        // When it is converted
        const pdf = await convertToPdf('sample.docx', docx);

        // Then the conversion works and the CDN is not contacted
        assert.ok(pdf.isPdf);
        assert.deepEqual(cdnRequests, []);
    });

    it('still converts when the CDN does not have the font, using a substitute', async () => {
        // Given a font the catalog lists but the CDN answers 404 for
        cdnRequests.length = 0;

        // When a document in it is converted
        const pdf = await convertToPdf('missing.fodt', flatOdt('Demo Missing Sans', 'Hello'));

        // Then the conversion succeeds with whatever LibreOffice substitutes
        assert.ok(pdf.isPdf);
        assert.deepEqual(cdnRequests, ['DemoMissingSans.ttf']);
        assert.doesNotMatch(pdf.text, /DemoMissingSans|DemoOnDemandSans/);
    });

    it('refuses a font whose bytes are not the ones in the catalog', async () => {
        // Given a CDN that serves a different file than the catalog's hash promises
        cdnRequests.length = 0;

        // When a document in that font is converted
        const pdf = await convertToPdf('tampered.fodt', flatOdt('Demo Tampered Sans', 'Hello'));

        // Then the file was fetched, rejected, and never reached LibreOffice
        assert.ok(pdf.isPdf);
        assert.deepEqual(cdnRequests, ['DemoTamperedSans.ttf']);
        assert.doesNotMatch(pdf.text, /DemoOnDemandSans/);
    });

    it('requests the catalog once, however many documents an engine converts', async () => {
        // Given a new engine whose catalog is at the fake CDN
        catalogRequests = 0;
        const options = { fonts: { catalogUrl: CDN + 'catalog.json' } };
        const documents = [
            { name: 'one.fodt', content: flatOdt('Demo On Demand Sans', 'First') },
            { name: 'two.fodt', content: flatOdt('Demo On Demand Sans', 'Second') },
        ];

        // When it converts two documents
        const pdfs = await convertWithNewEngine(options, documents);

        // Then the catalog was requested a single time, and both documents used the font
        assert.equal(catalogRequests, 1);
        for (const pdf of pdfs) assert.match(pdf.text, /DemoOnDemandSans/);
    });

    it('does not contact the CDN at all when on-demand fonts are turned off', async () => {
        // Given an engine created with fonts: false
        cdnRequests.length = 0;
        catalogRequests = 0;
        const documents = [{ name: 'off.fodt', content: flatOdt('Demo On Demand Sans', 'Hello') }];

        // When a document in a catalogued font is converted
        const [pdf] = await convertWithNewEngine({ fonts: false }, documents);

        // Then it converts with a substitute and neither the catalog nor the CDN was requested
        assert.ok(pdf.isPdf);
        assert.doesNotMatch(pdf.text, /DemoOnDemandSans/);
        assert.deepEqual(cdnRequests, []);
        assert.equal(catalogRequests, 0);
    });

    describe('registering a font with a worker that misbehaves', () => {
        // A real OfficeEngine whose worker is a stand-in that `reply` controls; LibreOffice is not
        // involved.  `reply(engine, worker, message)` is called for each message sent to the worker.
        async function withFakeWorker(options, scenario) {
            return page.evaluate(async ({ options, scenario }) => {
                const { OfficeEngine } = await import(new URL('office-converter/index.js', location.href));
                const engine = new OfficeEngine({ fonts: false, ...options });
                const sent = [];
                const worker = {
                    postMessage(message) {
                        sent.push(message.type);
                        if (scenario === 'rejects') {
                            engine.onMessage(worker, { type: 'fonts', id: message.id, ok: false, error: 'not a font' });
                        }
                        // scenario 'hangs': never answers
                    },
                    terminate() {},
                };
                engine.worker = worker;
                const font = { id: 'demo', family: 'Demo', carrier: new Uint8Array([1, 2, 3]) };
                if (scenario === 'gone') engine.worker = null;
                const outcome = {};
                try {
                    await engine.registerFont(font);
                    outcome.resolved = true;
                } catch (error) {
                    outcome.error = { engineFault: error.engineFault, fontFault: error.fontFault, message: error.message };
                }
                return { ...outcome, sent, registered: [...engine.registeredFonts], workerLeft: engine.worker !== null };
            }, { options, scenario });
        }

        it('skips a font that LibreOffice rejects, and remembers it so it is not sent again', async () => {
            // Given a worker that answers that the font package is not usable
            // When the font is registered
            const result = await withFakeWorker({}, 'rejects');

            // Then it is not an error, but the font counts as handled for this worker
            assert.equal(result.resolved, true);
            assert.deepEqual(result.registered, ['demo']);
            assert.deepEqual(result.sent, ['fonts']);
        });

        it('treats a worker that hangs while loading a font as an engine fault caused by the font', async () => {
            // Given a worker that never answers, and a short timeout
            // When the font is registered
            const result = await withFakeWorker({ timeoutMs: 50 }, 'hangs');

            // Then the worker is discarded and the error says the job should be retried without fonts
            assert.deepEqual(result.error, { engineFault: true, fontFault: true, message: 'Loading a font timed out.' });
            assert.equal(result.workerLeft, false);
            assert.deepEqual(result.registered, []);
        });

        it('reports a worker that is already gone as a fault, not as a TypeError', async () => {
            // Given an engine whose worker was discarded after the fonts were chosen
            // When a font is registered
            const result = await withFakeWorker({}, 'gone');

            // Then the error is the retryable kind
            assert.equal(result.error.engineFault, true);
            assert.equal(result.error.fontFault, true);
        });

        it('retries a job without fonts after fonts caused a fault, so the document still converts', async () => {
            // Given an engine whose first attempt fails because of a font, and whose retry succeeds
            const attempts = await page.evaluate(async () => {
                const { OfficeEngine, TARGET_BY_ID } = await import(new URL('office-converter/index.js', location.href));
                const engine = new OfficeEngine({ fonts: false });
                const skipped = [];
                engine.runJob = async (job) => {
                    skipped.push(Boolean(job.skipFonts));
                    if (skipped.length === 1) {
                        throw Object.assign(new Error('Loading a font timed out.'), { engineFault: true, fontFault: true });
                    }
                    return { data: new ArrayBuffer(1), family: 'writer', filter: 'x', ms: 1 };
                };

                // When a document is converted
                await engine.convert(new ArrayBuffer(1), 'a.txt', TARGET_BY_ID.get('pdf'));
                return skipped;
            });

            // Then the second attempt was made with fonts skipped
            assert.deepEqual(attempts, [false, true]);
        });
    });
});

#!/usr/bin/env node
/* End-to-end test: serve web/ like GitHub Pages does (a project sub-path, no
 * COOP/COEP headers) and convert the fixtures in headless Chromium.
 *
 *   npm install --no-save playwright   # or use a global install via NODE_PATH
 *   node test/e2e.cjs [--keep-open] [--out test/out]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '..', 'web'));
const FIXTURES = path.resolve(__dirname, 'fixtures');
const OUT = path.resolve(process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1] : path.join(__dirname, 'out'));
const PREFIX = '/serverless-office-converter/';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
};

// [fixture, target id, check]
const CASES = [
    ['sample.docx', 'pdf', 'pdf'],
    ['sample.docx', 'odt', 'zip'],
    ['sample.docx', 'doc', 'ole'],
    ['sample.docx', 'rtf', /^\{\\rtf/],
    ['sample.docx', 'txt', /Serverless Office Converter/],
    ['sample.docx', 'png', 'png'],
    ['sample.docx', 'md', /Serverless Office Converter/],
    ['sample.xlsx', 'pdf', 'pdf'],
    ['sample.xlsx', 'ods', 'zip'],
    ['sample.xlsx', 'xls', 'ole'],
    ['sample.xlsx', 'csv', /"?North"?,200,300,500/],
    ['sample.xlsx', 'html', /<html/i],
    ['sample.pptx', 'pdf', 'pdf'],
    ['sample.pptx', 'odp', 'zip'],
    ['sample.pptx', 'ppt', 'ole'],
    ['sample.pptx', 'png', 'png'],
    ['sample.csv', 'xlsx', 'zip'],
    ['sample.md', 'docx', 'zip'],
    ['sample.html', 'pdf', 'pdf'],
    ['sample.svg', 'pdf', 'pdf'],
    ['sample.docx', 'pdfa', 'pdf'],
];

const MAGIC = {
    pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
    zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
    ole: (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])),
    png: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
};

function serve() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith(PREFIX)) {
            res.writeHead(404).end();
            return;
        }
        let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'max-age=600',
        });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
    console.log('serving', ROOT, 'at', base);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', (m) => {
        const t = m.text();
        if (process.env.VERBOSE || m.type() === 'error') console.log(`[page:${m.type()}]`, t);
    });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    const t0 = Date.now();
    await page.goto(base);
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
    console.log('cross-origin isolated after', Date.now() - t0, 'ms');

    await page.evaluate(() => window.officeConverter.engine.start());
    const startup = Date.now() - t0;
    console.log('engine ready after', startup, 'ms');

    const cases = CASES.map(([fixture, target, check]) => ({
        fixture, target, check,
        b64: fs.readFileSync(path.join(FIXTURES, fixture)).toString('base64'),
    }));
    const results = await page.evaluate(async (cases) => {
        const conv = window.officeConverter;
        const files = cases.map((c) => {
            const bytes = Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0));
            return new File([bytes], c.fixture);
        });
        conv.addFiles(files);
        conv.items.forEach((item, i) => {
            const select = item.row.querySelector('.file-target');
            select.value = cases[i].target;
        });
        // Nothing may convert until the user presses Convert (runQueue is what the button calls).
        await new Promise((r) => setTimeout(r, 1500));
        if (conv.items.some((i) => i.status !== 'queued')) throw new Error('converted without being asked');
        await conv.runQueue();
        const out = [];
        for (const item of conv.items) {
            const status = item.row.querySelector('.file-status').textContent;
            let b64 = null;
            let name = null;
            if (item.url) {
                const buf = new Uint8Array(await (await fetch(item.url)).arrayBuffer());
                let s = '';
                for (let i = 0; i < buf.length; i += 0x8000) {
                    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
                }
                b64 = btoa(s);
                name = item.row.querySelector('.file-download').download;
            }
            out.push({ state: item.status, status, b64, name });
        }
        return out;
    }, cases);

    let failed = 0;
    results.forEach((r, i) => {
        const c = cases[i];
        let ok = r.state === 'done' && r.b64;
        let note = r.status;
        if (ok) {
            const buf = Buffer.from(r.b64, 'base64');
            const file = path.join(OUT, `${c.fixture.replace('.', '_')}-${c.target}-${r.name}`);
            fs.writeFileSync(file, buf);
            ok = c.check instanceof RegExp ? c.check.test(buf.toString('utf8')) : MAGIC[c.check](buf);
            if (!ok) note += ' (unexpected content)';
        }
        if (!ok) failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.fixture.padEnd(12)} -> ${c.target.padEnd(5)} ${note}`);
    });
    console.log(`${results.length - failed}/${results.length} conversions passed; engine startup ${startup} ms`);

    // Thumbnails are rendered in the background, behind the conversions above.
    const thumbs = await page.evaluate(async () => {
        const els = [...document.querySelectorAll('office-thumbnail')];
        const deadline = Date.now() + 240000;
        // Thumbnails render lazily: scroll each one into view in turn.
        for (const el of els) {
            el.scrollIntoView({ block: 'center' });
            while (Date.now() < deadline && !['ready', 'error'].includes(el.getAttribute('state'))) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        return els.map((e) => ({
            name: e.file && e.file.name, state: e.getAttribute('state'), title: e.title,
            width: e.shadowRoot.querySelector('img').naturalWidth,
        }));
    });
    const badThumbs = thumbs.filter((th) => th.state !== 'ready' || !th.width);
    thumbs.forEach((th) => console.log(`${th.state === 'ready' && th.width ? 'PASS' : 'FAIL'}  thumbnail ${th.name} ${th.state} ${th.width}px ${th.title}`));
    failed += badThumbs.length;

    if (!process.argv.includes('--keep-open')) {
        await browser.close();
        server.close();
    }
    process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
